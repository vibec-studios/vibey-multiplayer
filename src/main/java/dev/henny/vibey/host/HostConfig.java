package dev.henny.vibey.host;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import dev.henny.vibey.BuildInfo;
import dev.henny.vibey.Vibey;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Settings of the host, saved in config/vibey.json. Fields are public on purpose: Gson writes them 1:1. */
public final class HostConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static HostConfig current = new HostConfig();

    // Simple
    public String gameMode = "survival";
    public boolean cheats = false;
    public boolean forceMods = false;

    // Advanced
    public boolean pvp = true;
    public int maxPlayers = 8;
    public boolean exactModVersions = false;
    public String relay = BuildInfo.DEFAULT_RELAY;
    public int lanPort = 0;
    public boolean advancedOpen = false;

    /** Last address the relay gave us, so the screen can show it before going online. */
    public String lastAddress = "";

    public static HostConfig get() {
        return current;
    }

    private static Path file() {
        return Vibey.platform.configDir().resolve("vibey.json");
    }

    public static void load() {
        try {
            Path f = file();
            if (Files.exists(f)) {
                HostConfig c = GSON.fromJson(Files.readString(f, StandardCharsets.UTF_8), HostConfig.class);
                if (c != null) current = c;
            }
        } catch (Exception e) {
            Vibey.LOG.warn("Could not read vibey.json, using defaults: {}", e.toString());
        }
        current.sanitize();
    }

    public static void save() {
        try {
            current.sanitize();
            Path f = file();
            Files.createDirectories(f.getParent());
            Files.writeString(f, GSON.toJson(current), StandardCharsets.UTF_8);
        } catch (Exception e) {
            Vibey.LOG.warn("Could not save vibey.json: {}", e.toString());
        }
    }

    private void sanitize() {
        if (relay == null || relay.isBlank()) relay = BuildInfo.DEFAULT_RELAY;
        relay = relay.trim();
        if (maxPlayers < 2) maxPlayers = 2;
        if (maxPlayers > 8) maxPlayers = 8;
        if (lanPort < 0 || lanPort > 65535) lanPort = 0;
        if (gameMode == null) gameMode = "survival";
        if (lastAddress == null) lastAddress = "";
    }
}
