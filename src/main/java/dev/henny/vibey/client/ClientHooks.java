package dev.henny.vibey.client;

import dev.henny.vibey.Platform;
import dev.henny.vibey.Vibey;
import dev.henny.vibey.net.ModListPayload;

import java.util.ArrayList;
import java.util.List;

/** Client side of "Force mods": as soon as we join a world, tell the host which mods we have. */
public final class ClientHooks {
    private ClientHooks() {}

    public static void onJoinedServer() {
        List<String> mods = new ArrayList<>();
        for (Platform.ModInfo m : Vibey.platform.mods()) mods.add(m.id() + "@" + m.version());
        Vibey.platform.sendToServer(new ModListPayload(mods));
    }
}
