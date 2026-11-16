package dev.henny.vibey.host;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.henny.vibey.BuildInfo;
import dev.henny.vibey.Vibey;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * Connection to the relay (see relay/server.ts for the protocol).
 *
 * <p>One control connection says "I am online" and receives knocks. For every player that knocks, a second
 * connection to the relay is opened and glued to the local LAN port of the integrated server. Nothing else on this
 * computer is ever reachable: data connections only go to 127.0.0.1:{@code lanPort}.
 */
public final class Tunnel {
    public enum State { CONNECTING, ONLINE, RETRYING, FAILED, CLOSED }

    public interface Listener {
        void onState(State state, String address, String error);
    }

    private static final byte[] MAGIC = {0x00, 'V', 'B', 'Y'};
    private static final int PROTOCOL = 1;

    private final String relayHost;
    private final int relayPort;
    private final int lanPort;
    private final String name;
    private final UUID uuid;
    private final String mcVersion;
    private final Function<String, String> joinServer;
    private final Listener listener;

    private volatile boolean closed;
    private volatile boolean wasOnline;
    private volatile Socket control;
    private volatile OutputStream controlOut;
    private final Set<Socket> streams = ConcurrentHashMap.newKeySet();
    private Thread thread;

    /**
     * @param joinServer called with the relay's challenge; performs the Mojang "join server" call and returns null on
     *                   success or an error text.
     */
    public Tunnel(String relay, int lanPort, String name, UUID uuid, String mcVersion,
                  Function<String, String> joinServer, Listener listener) {
        String host = relay;
        int port = 25565;
        int colon = relay.lastIndexOf(':');
        if (colon > 0 && relay.indexOf(']') < colon) {
            host = relay.substring(0, colon);
            try {
                port = Integer.parseInt(relay.substring(colon + 1));
            } catch (NumberFormatException ignored) {
            }
        }
        this.relayHost = host.replace("[", "").replace("]", "");
        this.relayPort = port;
        this.lanPort = lanPort;
        this.name = name;
        this.uuid = uuid;
        this.mcVersion = mcVersion;
        this.joinServer = joinServer;
        this.listener = listener;
    }

    public void start() {
        thread = new Thread(this::run, "Vibey-Tunnel");
        thread.setDaemon(true);
        thread.start();
    }

    public void close() {
        closed = true;
        quietClose(control);
        for (Socket s : streams) quietClose(s);
        streams.clear();
        if (thread != null) thread.interrupt();
    }

    public int activeStreams() {
        return streams.size() / 2;
    }

    public void rotate() {
        send("{\"t\":\"rotate\"}");
    }

    // -------------------------------------------------------------------------------------------- control loop

    private void run() {
        long backoff = 1000;
        while (!closed) {
            listener.onState(State.CONNECTING, null, null);
            String fatal = null;
            wasOnline = false;
            try {
                fatal = session();
            } catch (IOException e) {
                if (closed) break;
                Vibey.LOG.info("Relay connection lost: {}", e.toString());
                listener.onState(State.RETRYING, null, e.getMessage());
            }
            if (closed) break;
            if (wasOnline) backoff = 1000; // the connection worked, so retry quickly
            if (fatal != null) {
                listener.onState(State.FAILED, null, fatal);
                closed = true;
                break;
            }
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                break;
            }
            backoff = Math.min(backoff * 2, 30_000);
        }
        listener.onState(State.CLOSED, null, null);
    }

    /** Runs one control session. Returns an error text when retrying makes no sense. */
    private String session() throws IOException {
        Socket s = new Socket();
        s.connect(new InetSocketAddress(relayHost, relayPort), 8000);
        s.setTcpNoDelay(true);
        s.setSoTimeout(45_000);
        control = s;
        controlOut = s.getOutputStream();
        try {
            JsonObject hello = new JsonObject();
            hello.addProperty("t", "hello");
            hello.addProperty("v", PROTOCOL);
            hello.addProperty("name", name);
            hello.addProperty("uuid", uuid.toString());
            hello.addProperty("mc", mcVersion);
            hello.addProperty("mod", BuildInfo.VERSION);
            synchronized (this) {
                controlOut.write(MAGIC);
            }
            send(hello.toString());

            Thread pinger = new Thread(() -> {
                while (!closed && control == s && !s.isClosed()) {
                    try {
                        Thread.sleep(20_000);
                    } catch (InterruptedException e) {
                        return;
                    }
                    send("{\"t\":\"ping\"}");
                }
            }, "Vibey-Ping");
            pinger.setDaemon(true);
            pinger.start();

            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while ((line = in.readLine()) != null) {
                if (line.isBlank()) continue;
                JsonObject msg = JsonParser.parseString(line).getAsJsonObject();
                String t = msg.get("t").getAsString();
                switch (t) {
                    case "challenge" -> {
                        String err = joinServer.apply(msg.get("serverId").getAsString());
                        if (err != null) Vibey.LOG.warn("Mojang session check failed: {}", err);
                        send("{\"t\":\"auth\"}");
                    }
                    case "ready" -> {
                        wasOnline = true;
                        listener.onState(State.ONLINE, msg.get("address").getAsString(), null);
                    }
                    case "open" -> openStream(msg.get("sid").getAsInt(), msg.get("key").getAsString());
                    case "replaced" -> {
                        return "replaced";
                    }
                    case "error" -> {
                        String code = msg.has("code") ? msg.get("code").getAsString() : "";
                        String text = msg.has("msg") ? msg.get("msg").getAsString() : code;
                        if (code.equals("rate_limited")) {
                            listener.onState(State.ONLINE, null, text);
                        } else {
                            return text;
                        }
                    }
                    default -> {
                    }
                }
            }
            throw new IOException("Relay closed the connection");
        } finally {
            quietClose(s);
            if (control == s) control = null;
        }
    }

    private void send(String json) {
        OutputStream out = controlOut;
        if (out == null) return;
        try {
            synchronized (this) {
                out.write((json + "\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } catch (IOException e) {
            quietClose(control);
        }
    }

    // -------------------------------------------------------------------------------------------- data streams

    private void openStream(int sid, String key) {
        Thread t = new Thread(() -> {
            Socket remote = new Socket();
            Socket local = new Socket();
            try {
                remote.connect(new InetSocketAddress(relayHost, relayPort), 8000);
                remote.setTcpNoDelay(true);
                local.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), lanPort), 3000);
                local.setTcpNoDelay(true);
                streams.add(remote);
                streams.add(local);
                OutputStream ro = remote.getOutputStream();
                ro.write(MAGIC);
                ro.write(("{\"t\":\"data\",\"sid\":" + sid + ",\"key\":\"" + key + "\"}\n").getBytes(StandardCharsets.UTF_8));
                ro.flush();
                Thread back = pipe(local, remote, "Vibey-Up-" + sid);
                back.start();
                copy(remote, local);
                back.join();
            } catch (IOException | InterruptedException e) {
                if (!closed) Vibey.LOG.debug("Stream {} ended: {}", sid, e.toString());
            } finally {
                streams.remove(remote);
                streams.remove(local);
                quietClose(remote);
                quietClose(local);
            }
        }, "Vibey-Down-" + sid);
        t.setDaemon(true);
        t.start();
    }

    private static Thread pipe(Socket from, Socket to, String name) {
        Thread t = new Thread(() -> copy(from, to), name);
        t.setDaemon(true);
        return t;
    }

    private static void copy(Socket from, Socket to) {
        byte[] buf = new byte[64 * 1024];
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            int n;
            while ((n = in.read(buf)) >= 0) {
                out.write(buf, 0, n);
                out.flush();
            }
        } catch (IOException ignored) {
        } finally {
            quietClose(from);
            quietClose(to);
        }
    }

    private static void quietClose(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {
        }
    }
}
