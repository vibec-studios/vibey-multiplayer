package dev.henny.vibey;

import dev.henny.vibey.net.ModListPayload;

import java.nio.file.Path;
import java.util.List;

/** The few things that differ between Fabric and NeoForge. */
public interface Platform {
    String loader();

    Path configDir();

    List<ModInfo> mods();

    /** Sends our mod list to the server we are connected to, if it understands it. */
    boolean sendToServer(ModListPayload payload);

    record ModInfo(String id, String name, String version, boolean clientOnly, boolean library) {}
}
