package dev.henny.vibey.host;

import dev.henny.vibey.Compat;
import dev.henny.vibey.Platform;
import dev.henny.vibey.Vibey;
import net.minecraft.client.Minecraft;
import net.minecraft.locale.Language;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Everything that happens to players on the hosted world. Runs on the server thread; the screen only reads
 * {@link #snapshot()} and asks for changes through {@link #run}.
 */
public final class Guests {
    /** What the host screen shows per player. */
    public record View(UUID id, String name, boolean host, boolean op, boolean hasMod) {}

    private static final long MOD_CHECK_MS = 8_000;
    private static final Set<String> NEVER_REQUIRED = Set.of(
            "minecraft", "java", "fabricloader", "fabric-api", "fabric", "neoforge", "forge", "mixinextras", Vibey.MOD_ID);

    private static final Map<UUID, Long> awaitingMods = new ConcurrentHashMap<>();
    private static final Map<UUID, Map<String, String>> reportedMods = new ConcurrentHashMap<>();
    private static volatile List<View> snapshot = List.of();
    private static int ticks;

    private Guests() {}

    public static List<View> snapshot() {
        return snapshot;
    }

    /** Runs {@code task} on the hosted server's thread. */
    public static void run(java.util.function.Consumer<MinecraftServer> task) {
        MinecraftServer server = Minecraft.getInstance().getSingleplayerServer();
        if (server != null) server.execute(() -> task.accept(server));
    }

    static boolean isHost(ServerPlayer p) {
        return p.getUUID().equals(Minecraft.getInstance().getUser().getProfileId());
    }

    static String tr(String key, Object... args) {
        String s = Language.getInstance().getOrDefault(key);
        try {
            return args.length == 0 ? s : String.format(s, args);
        } catch (Exception e) {
            return s;
        }
    }

    // -------------------------------------------------------------------------------------------- events

    public static void onJoin(MinecraftServer server, ServerPlayer player) {
        if (Minecraft.getInstance().getSingleplayerServer() != server) return;
        if (isHost(player)) return;
        if (!HostSession.isHosting()) {
            // We opened the LAN port; after "stop hosting" nobody new gets in that way (1.21-26.2 cannot close it).
            if (HostSession.openedByUs(server)) player.connection.disconnect(Component.literal(tr("vibey.kick.stopped")));
            return;
        }
        HostConfig cfg = HostConfig.get();
        if (server.getPlayerList().getPlayers().size() > cfg.maxPlayers) {
            player.connection.disconnect(Component.literal(tr("vibey.kick.full")));
            return;
        }
        // Every guest starts in the chosen game mode; OPs and cheaters can change it themselves afterwards.
        Compat.command(server, "gamemode " + cfg.gameMode + " " + player.getName().getString());
        if (cfg.forceMods) awaitingMods.put(player.getUUID(), System.currentTimeMillis() + MOD_CHECK_MS);
        refresh(server);
    }

    public static void onLeave(MinecraftServer server, ServerPlayer player) {
        awaitingMods.remove(player.getUUID());
        reportedMods.remove(player.getUUID());
        server.execute(() -> refresh(server));
    }

    public static void onModList(MinecraftServer server, ServerPlayer player, List<String> mods) {
        Map<String, String> theirs = new HashMap<>();
        for (String entry : mods) {
            int at = entry.indexOf('@');
            if (at > 0) theirs.put(entry.substring(0, at), entry.substring(at + 1));
            else theirs.put(entry, "");
        }
        reportedMods.put(player.getUUID(), theirs);
        if (awaitingMods.remove(player.getUUID()) != null) {
            List<Platform.ModInfo> missing = missingMods(theirs, HostConfig.get().exactModVersions);
            if (!missing.isEmpty()) {
                player.connection.disconnect(Component.literal(tr("vibey.kick.missing_mods") + "\n\n" + list(missing)));
                return;
            }
        }
        refresh(server);
    }

    public static void tick(MinecraftServer server) {
        if (Minecraft.getInstance().getSingleplayerServer() != server) return;
        if (++ticks % 10 != 0) return;
        if (!awaitingMods.isEmpty()) {
            long now = System.currentTimeMillis();
            for (ServerPlayer p : new ArrayList<>(server.getPlayerList().getPlayers())) {
                Long deadline = awaitingMods.get(p.getUUID());
                if (deadline != null && now > deadline) {
                    awaitingMods.remove(p.getUUID());
                    List<Platform.ModInfo> required = requiredMods();
                    String text = tr("vibey.kick.needs_vibey");
                    if (!required.isEmpty()) text += "\n\n" + list(required);
                    p.connection.disconnect(Component.literal(text));
                }
            }
        }
        refresh(server);
    }

    public static void onServerStopped() {
        awaitingMods.clear();
        reportedMods.clear();
        snapshot = List.of();
    }

    // -------------------------------------------------------------------------------------------- actions

    public static void setOp(UUID id, boolean op) {
        run(server -> {
            ServerPlayer p = server.getPlayerList().getPlayer(id);
            if (p == null || isHost(p)) return;
            Compat.command(server, (op ? "op " : "deop ") + p.getName().getString());
            refresh(server);
        });
    }

    public static void kick(UUID id) {
        run(server -> {
            ServerPlayer p = server.getPlayerList().getPlayer(id);
            if (p == null || isHost(p)) return;
            p.connection.disconnect(Component.literal(tr("vibey.kick.kicked")));
        });
    }

    public static void kickAllGuests(MinecraftServer server, String key) {
        for (ServerPlayer p : new ArrayList<>(server.getPlayerList().getPlayers())) {
            if (!isHost(p)) p.connection.disconnect(Component.literal(tr(key)));
        }
    }

    /** New game mode for every guest that is online right now. */
    public static void applyGameMode(String mode) {
        run(server -> {
            for (ServerPlayer p : server.getPlayerList().getPlayers()) {
                if (!isHost(p)) {
                    Compat.command(server, "gamemode " + mode + " " + p.getName().getString());
                }
            }
        });
    }

    // -------------------------------------------------------------------------------------------- helpers

    private static void refresh(MinecraftServer server) {
        List<View> list = new ArrayList<>();
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            boolean host = isHost(p);
            View v = new View(p.getUUID(), p.getName().getString(), host, host || Compat.isOp(server, p),
                    host || reportedMods.containsKey(p.getUUID()));
            if (host) list.add(0, v);
            else list.add(v);
        }
        snapshot = List.copyOf(list);
    }

    /** Mods a guest must have: everything on the host that is not client-only, a library or the game itself. */
    public static List<Platform.ModInfo> requiredMods() {
        List<Platform.ModInfo> out = new ArrayList<>();
        for (Platform.ModInfo m : Vibey.platform.mods()) {
            if (m.clientOnly() || m.library() || NEVER_REQUIRED.contains(m.id()) || m.id().startsWith("fabric-")) continue;
            out.add(m);
        }
        return out;
    }

    private static List<Platform.ModInfo> missingMods(Map<String, String> theirs, boolean exact) {
        List<Platform.ModInfo> missing = new ArrayList<>();
        for (Platform.ModInfo m : requiredMods()) {
            String v = theirs.get(m.id());
            if (v == null || (exact && !v.equals(m.version()))) missing.add(m);
        }
        return missing;
    }

    private static String list(List<Platform.ModInfo> mods) {
        StringBuilder sb = new StringBuilder();
        int shown = 0;
        for (Platform.ModInfo m : mods) {
            if (shown == 10) {
                sb.append(tr("vibey.kick.more", mods.size() - shown));
                break;
            }
            sb.append("• ").append(m.name()).append(' ').append(m.version()).append('\n');
            shown++;
        }
        return sb.toString().trim();
    }
}
