package dev.henny.vibey.gametest;

import dev.henny.vibey.client.HostScreen;
import dev.henny.vibey.host.HostConfig;
import dev.henny.vibey.host.HostSession;
import net.fabricmc.fabric.api.client.gametest.v1.FabricClientGameTest;
import net.fabricmc.fabric.api.client.gametest.v1.context.ClientGameTestContext;
import net.fabricmc.fabric.api.client.gametest.v1.context.TestSingleplayerContext;
import net.minecraft.client.gui.screens.PauseScreen;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Runs the real game: creates a world, opens the host screen, goes online through a local relay
 * (-Dvibey.test.relay=127.0.0.1:PORT, relay started with ALLOW_OFFLINE=1) and pings the world through its public
 * address like the server list of a friend would. Screenshots land in build/run/clientGameTest/screenshots.
 */
public final class VibeyClientGameTest implements FabricClientGameTest {
    @Override
    public void runTest(ClientGameTestContext context) {
        String relay = System.getProperty("vibey.test.relay", "127.0.0.1:26400");
        context.getInput().resizeWindow(1280, 800);
        try (TestSingleplayerContext world = context.worldBuilder().create()) {
            world.getClientWorld().waitForChunksRender();
            context.runOnClient(mc -> {
                HostConfig.get().relay = relay;
                HostConfig.get().advancedOpen = false;
                HostConfig.get().lastAddress = "";
            });

            context.setScreen(() -> new PauseScreen(true));
            context.waitTicks(5);
            context.takeScreenshot("1_pause_menu");

            context.setScreen(() -> new HostScreen(null));
            context.waitTicks(10);
            context.takeScreenshot("2_host_offline");

            context.runOnClient(mc -> HostSession.start());
            context.waitFor(mc -> HostSession.status() == HostSession.Status.ONLINE, 400);
            context.waitTicks(10);
            context.takeScreenshot("3_host_online");

            String address = context.computeOnClient(mc -> HostSession.address());
            String status = ping(relay, address);
            if (!status.contains("\"version\"")) throw new AssertionError("No status through the tunnel: " + status);
            System.out.println("[vibey-test] status via " + address + ": " + status);

            context.runOnClient(mc -> HostConfig.get().advancedOpen = true);
            context.waitTicks(5);
            context.getInput().moveCursor(640, 400);
            context.getInput().scroll(-20);
            context.waitTicks(10);
            context.takeScreenshot("4_host_advanced");
            context.getInput().scroll(20);

            context.runOnClient(mc -> HostSession.stop());
            context.waitTicks(10);
            context.takeScreenshot("5_host_stopped");

            context.setScreen(() -> new PauseScreen(true));
            context.waitTicks(5);
            context.takeScreenshot("6_pause_after");
            context.setScreen(() -> null);
        }
    }

    /** Server list ping through the relay, exactly what a vanilla client sends. */
    private static String ping(String relay, String address) {
        String[] r = relay.split(":");
        String host = address.split(":")[0];
        try (Socket s = new Socket(r[0], Integer.parseInt(r[1]))) {
            s.setSoTimeout(10_000);
            ByteArrayOutputStream hs = new ByteArrayOutputStream();
            hs.write(0);
            varint(hs, 774);
            byte[] h = host.getBytes(StandardCharsets.UTF_8);
            varint(hs, h.length);
            hs.write(h);
            hs.write(0x63);
            hs.write(0xDD);
            varint(hs, 1);
            OutputStream out = s.getOutputStream();
            ByteArrayOutputStream pkt = new ByteArrayOutputStream();
            varint(pkt, hs.size());
            pkt.write(hs.toByteArray());
            pkt.write(1);
            pkt.write(0);
            out.write(pkt.toByteArray());
            out.flush();
            DataInputStream in = new DataInputStream(s.getInputStream());
            readVarint(in);
            readVarint(in);
            int len = readVarint(in);
            byte[] json = in.readNBytes(len);
            return new String(json, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new AssertionError("Ping failed: " + e, e);
        }
    }

    private static void varint(ByteArrayOutputStream o, int v) {
        do {
            int b = v & 0x7F;
            v >>>= 7;
            if (v != 0) b |= 0x80;
            o.write(b);
        } while (v != 0);
    }

    private static int readVarint(DataInputStream in) throws IOException {
        int v = 0;
        for (int i = 0; i < 5; i++) {
            int b = in.readUnsignedByte();
            v |= (b & 0x7F) << (7 * i);
            if ((b & 0x80) == 0) return v;
        }
        throw new IOException("varint");
    }
}
