package dev.henny.vibey.host;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Whitelist and ban list of the host. The relay enforces both on network level (blocked players never reach this
 * computer); {@link Guests#onJoin} checks them again for LAN joins. Lists are replaced, never changed in place, because
 * the server thread reads them while the screen edits them.
 */
public final class Access {
    public record Blocked(String name, String ip, String reason, long at) {}

    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_]{1,16}");
    private static final Pattern IP = Pattern.compile("[0-9a-fA-F.:]{3,45}");

    /** Last IP the relay saw per player name (lower case), so "ban" can also ban the address. */
    private static final Map<String, String> lastIp = new ConcurrentHashMap<>();
    private static final Deque<Blocked> recentlyBlocked = new ArrayDeque<>();

    private Access() {}

    public static boolean isName(String s) {
        return NAME.matcher(s).matches();
    }

    public static boolean isIp(String s) {
        return IP.matcher(s).matches() && (s.contains(".") || s.contains(":")) && !isName(s);
    }

    // -------------------------------------------------------------------------------------------- checks

    /** Null if the player may join, otherwise the translation key of the reason. */
    static String denyReason(String name) {
        HostConfig cfg = HostConfig.get();
        String lower = name.toLowerCase(Locale.ROOT);
        for (String b : cfg.bannedNames) if (b.equalsIgnoreCase(lower)) return "vibey.kick.banned";
        if (cfg.whitelistEnabled) {
            for (String w : cfg.whitelist) if (w.equalsIgnoreCase(lower)) return null;
            return "vibey.kick.whitelist";
        }
        return null;
    }

    // -------------------------------------------------------------------------------------------- edits

    public static void setWhitelistEnabled(boolean on) {
        HostConfig.get().whitelistEnabled = on;
        changed();
    }

    public static boolean whitelistAdd(String name) {
        name = name.trim();
        if (!isName(name)) return false;
        HostConfig cfg = HostConfig.get();
        for (String w : cfg.whitelist) if (w.equalsIgnoreCase(name)) return true;
        List<String> next = new ArrayList<>(cfg.whitelist);
        next.add(name);
        cfg.whitelist = next;
        changed();
        return true;
    }

    public static void whitelistRemove(String name) {
        HostConfig cfg = HostConfig.get();
        List<String> next = new ArrayList<>(cfg.whitelist);
        next.removeIf(w -> w.equalsIgnoreCase(name));
        cfg.whitelist = next;
        changed();
    }

    /** Bans a name or an IP (whatever {@code entry} looks like). Banning a name also bans its last known IP. */
    public static boolean ban(String entry) {
        entry = entry.trim();
        HostConfig cfg = HostConfig.get();
        if (isName(entry)) {
            String name = entry;
            if (cfg.bannedNames.stream().noneMatch(b -> b.equalsIgnoreCase(name))) {
                List<String> next = new ArrayList<>(cfg.bannedNames);
                next.add(name);
                cfg.bannedNames = next;
            }
            String ip = lastIp.get(name.toLowerCase(Locale.ROOT));
            if (ip != null && !cfg.bannedIps.containsKey(ip)) {
                Map<String, String> ips = new LinkedHashMap<>(cfg.bannedIps);
                ips.put(ip, name);
                cfg.bannedIps = ips;
            }
            changed();
            return true;
        }
        if (isIp(entry)) {
            Map<String, String> ips = new LinkedHashMap<>(cfg.bannedIps);
            ips.putIfAbsent(entry, "");
            cfg.bannedIps = ips;
            changed();
            return true;
        }
        return false;
    }

    public static void unbanName(String name) {
        HostConfig cfg = HostConfig.get();
        List<String> next = new ArrayList<>(cfg.bannedNames);
        next.removeIf(b -> b.equalsIgnoreCase(name));
        cfg.bannedNames = next;
        // The IP ban that came with this name goes too, otherwise "unban" would not let them in.
        Map<String, String> ips = new LinkedHashMap<>(cfg.bannedIps);
        ips.values().removeIf(n -> n.equalsIgnoreCase(name));
        cfg.bannedIps = ips;
        changed();
    }

    public static void unbanIp(String ip) {
        HostConfig cfg = HostConfig.get();
        Map<String, String> ips = new LinkedHashMap<>(cfg.bannedIps);
        ips.remove(ip);
        cfg.bannedIps = ips;
        changed();
    }

    private static void changed() {
        HostConfig.save();
        HostSession.pushAccess();
    }

    // -------------------------------------------------------------------------------------------- relay

    /** The {@code access} message for the relay. */
    static String relayMessage() {
        HostConfig cfg = HostConfig.get();
        JsonObject o = new JsonObject();
        o.addProperty("t", "access");
        if (cfg.whitelistEnabled) {
            JsonArray w = new JsonArray();
            cfg.whitelist.forEach(w::add);
            o.add("whitelist", w);
        } else {
            o.add("whitelist", JsonNull.INSTANCE);
        }
        JsonArray names = new JsonArray();
        cfg.bannedNames.forEach(names::add);
        o.add("banNames", names);
        JsonArray ips = new JsonArray();
        cfg.bannedIps.keySet().forEach(ips::add);
        o.add("banIps", ips);
        JsonObject messages = new JsonObject();
        messages.addProperty("banned", Guests.tr("vibey.kick.banned"));
        messages.addProperty("whitelist", Guests.tr("vibey.kick.whitelist"));
        o.add("messages", messages);
        return o.toString();
    }

    static void onRelayJoin(String name, String ip) {
        if (name != null && ip != null) lastIp.put(name.toLowerCase(Locale.ROOT), ip);
    }

    static void onRelayBlocked(String name, String ip, String reason) {
        synchronized (recentlyBlocked) {
            recentlyBlocked.removeIf(b -> b.name().equalsIgnoreCase(name));
            recentlyBlocked.addFirst(new Blocked(name, ip, reason, System.currentTimeMillis()));
            while (recentlyBlocked.size() > 6) recentlyBlocked.removeLast();
        }
    }

    public static List<Blocked> recentlyBlocked() {
        synchronized (recentlyBlocked) {
            return List.copyOf(recentlyBlocked);
        }
    }
}
