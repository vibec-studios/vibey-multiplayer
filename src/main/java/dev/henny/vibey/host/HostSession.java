package dev.henny.vibey.host;

import dev.henny.vibey.Compat;
import dev.henny.vibey.Platform;
import dev.henny.vibey.Vibey;
import net.minecraft.client.Minecraft;
import net.minecraft.client.User;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.HttpUtil;
import net.minecraft.world.level.GameType;

/**
 * The one hosting session of this client. Started and stopped from the host screen (client thread); the tunnel
 * reports back from its own thread, so everything the screen reads is volatile.
 */
public final class HostSession {
    public enum Status { OFF, CONNECTING, ONLINE, RECONNECTING, ERROR }

    private static volatile Status status = Status.OFF;
    private static volatile String address = "";
    private static volatile String error = "";
    private static volatile String notice = "";
    private static volatile long onlineSince;
    private static Tunnel tunnel;
    private static IntegratedServer hosted;
    private static IntegratedServer openedFor;
    private static int lanPort = -1;

    private HostSession() {}

    public static Status status() {
        return status;
    }

    /** The public address, or the last known one while offline. */
    public static String address() {
        String a = address;
        return a.isEmpty() ? HostConfig.get().lastAddress : a;
    }

    public static String error() {
        return error;
    }

    /** Non-fatal hint from the relay (e.g. "too many new addresses"). */
    public static String notice() {
        return notice;
    }

    public static long onlineSince() {
        return onlineSince;
    }

    public static int lanPort() {
        return lanPort;
    }

    public static boolean isHosting() {
        Status s = status;
        return s != Status.OFF && s != Status.ERROR && hosted != null
                && hosted == Minecraft.getInstance().getSingleplayerServer();
    }

    static boolean openedByUs(MinecraftServer server) {
        return server == openedFor;
    }

    public static boolean canHost() {
        return Minecraft.getInstance().getSingleplayerServer() != null;
    }

    // -------------------------------------------------------------------------------------------- start / stop

    /** Opens the world and goes online. Call on the client thread. */
    public static void start() {
        Minecraft mc = Minecraft.getInstance();
        IntegratedServer server = mc.getSingleplayerServer();
        if (server == null || isHosting()) return;
        HostConfig cfg = HostConfig.get();
        error = "";
        notice = "";

        if (!server.isPublished()) {
            int port = cfg.lanPort > 0 ? cfg.lanPort : HttpUtil.getAvailablePort();
            GameType mode = GameType.byName(cfg.gameMode, GameType.SURVIVAL);
            if (!Compat.publish(server, mode, cfg.cheats, port)) {
                fail(Guests.tr("vibey.error.port", port));
                return;
            }
            openedFor = server;
        } else {
            server.execute(() -> Compat.setCheats(server, cfg.cheats));
        }
        lanPort = server.getPort();
        hosted = server;
        boolean pvp = cfg.pvp;
        server.execute(() -> Compat.setPvp(server, pvp));

        User user = mc.getUser();
        String mcVersion = Vibey.platform.mods().stream().filter(m -> m.id().equals("minecraft"))
                .map(Platform.ModInfo::version).findFirst().orElse("");
        status = Status.CONNECTING;
        Tunnel t = new Tunnel(cfg.relay, lanPort, user.getName(), user.getProfileId(), mcVersion,
                Compat::joinServer, HostSession::onTunnel);
        tunnel = t;
        t.start();
        Vibey.LOG.info("Hosting world on LAN port {} through {}", lanPort, cfg.relay);
    }

    /** Goes offline and sends guests home. */
    public static void stop() {
        Tunnel t = tunnel;
        tunnel = null;
        if (t != null) t.close();
        IntegratedServer server = hosted;
        hosted = null;
        status = Status.OFF;
        address = "";
        onlineSince = 0;
        if (server != null) {
            server.execute(() -> {
                Guests.kickAllGuests(server, "vibey.kick.stopped");
                if (Compat.unpublish(server)) openedFor = null;
            });
        }
    }

    public static void rotate() {
        Tunnel t = tunnel;
        if (t != null && status == Status.ONLINE) t.rotate();
    }

    public static void onServerStopping(MinecraftServer server) {
        if (server == hosted) stop();
        if (server == openedFor) openedFor = null;
        Guests.onServerStopped();
    }

    // -------------------------------------------------------------------------------------------- live settings

    public static void applyCheats() {
        boolean cheats = HostConfig.get().cheats;
        if (hosted != null) Guests.run(server -> Compat.setCheats(server, cheats));
    }

    public static void applyPvp() {
        boolean pvp = HostConfig.get().pvp;
        if (hosted != null) Guests.run(server -> Compat.setPvp(server, pvp));
    }

    public static void applyGameMode() {
        if (hosted != null) Guests.applyGameMode(HostConfig.get().gameMode);
    }

    // -------------------------------------------------------------------------------------------- tunnel callbacks

    private static void onTunnel(Tunnel.State state, String addr, String err) {
        switch (state) {
            case CONNECTING -> {
                if (status != Status.ONLINE) status = address.isEmpty() ? Status.CONNECTING : Status.RECONNECTING;
            }
            case ONLINE -> {
                if (addr != null) {
                    boolean changed = !addr.equals(address);
                    address = addr;
                    if (!addr.equals(HostConfig.get().lastAddress)) {
                        HostConfig.get().lastAddress = addr;
                        Minecraft.getInstance().execute(HostConfig::save);
                    }
                    if (changed || onlineSince == 0) onlineSince = System.currentTimeMillis();
                    status = Status.ONLINE;
                    error = "";
                }
                if (err != null) notice = err;
            }
            case RETRYING -> {
                if (tunnel != null) {
                    status = Status.RECONNECTING;
                    error = err == null ? "" : err;
                }
            }
            case FAILED -> {
                String text = "replaced".equals(err) ? Guests.tr("vibey.error.replaced") : (err == null ? "" : err);
                fail(text);
            }
            case CLOSED -> {
            }
        }
    }

    private static void fail(String text) {
        Tunnel t = tunnel;
        tunnel = null;
        if (t != null) t.close();
        hosted = null;
        address = "";
        status = Status.ERROR;
        error = text;
    }
}
