package dev.henny.vibey;

import net.minecraft.client.Minecraft;
import net.minecraft.client.User;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.GameType;
//? if >=1.21.9
import net.minecraft.server.players.NameAndId;
//? if >=1.21.11 {
import net.minecraft.resources.Identifier;
//?} else
/*import net.minecraft.resources.ResourceLocation;*/

/**
 * Every call whose shape changed between Minecraft 1.21.1 and 26.3 lives here, so the rest of the mod reads the
 * same on every version.
 */
public final class Compat {
    private Compat() {}

    public static <T extends CustomPacketPayload> CustomPacketPayload.Type<T> payloadType(String path) {
        //? if >=1.21.11 {
        return new CustomPacketPayload.Type<>(Identifier.fromNamespaceAndPath(Vibey.MOD_ID, path));
        //?} else
        /*return new CustomPacketPayload.Type<>(ResourceLocation.fromNamespaceAndPath(Vibey.MOD_ID, path));*/
    }

    // -------------------------------------------------------------------------------------------- client

    public static void openScreen(Screen screen) {
        //? if >=26.2 {
        /*Minecraft.getInstance().setScreenAndShow(screen);
        *///?} else
        Minecraft.getInstance().setScreen(screen);
    }

    /** Mojang "join server" call, proves to the relay that we own this account. Returns null or an error text. */
    public static String joinServer(String serverId) {
        Minecraft mc = Minecraft.getInstance();
        User user = mc.getUser();
        try {
            //? if >=1.21.9 {
            mc.services().sessionService().joinServer(user.getProfileId(), user.getAccessToken(), serverId);
            //?} else
            /*mc.getMinecraftSessionService().joinServer(user.getProfileId(), user.getAccessToken(), serverId);*/
            return null;
        } catch (Exception e) {
            return e.getMessage() == null ? e.toString() : e.getMessage();
        }
    }

    // -------------------------------------------------------------------------------------------- integrated server

    public static boolean publish(IntegratedServer server, GameType mode, boolean cheats, int port) {
        //? if >=26.3 {
        /*server.setGuestCommandAccess(cheats);
        return server.publishServer(MinecraftServer.MultiplayerScope.LAN, port);
        *///?}
        //? if >=26.2 <26.3 {
        /*return server.publishServer(MinecraftServer.MultiplayerScope.LAN, mode, cheats, port);
        *///?}
        //? if <26.2
        return server.publishServer(mode, cheats, port);
    }

    /** Closes the LAN port again. Only 26.2+ can do that; older versions keep it open until the world closes. */
    public static boolean unpublish(IntegratedServer server) {
        //? if >=26.2 {
        /*return server.unpublishServer();
        *///?} else
        return false;
    }

    /** Cheats on = every player may use commands (vanilla "Allow Cheats" of Open to LAN). */
    public static void setCheats(MinecraftServer server, boolean cheats) {
        //? if >=26.3 {
        /*((IntegratedServer) server).setGuestCommandAccess(cheats);
        *///?} else
        server.getPlayerList().setAllowCommandsForAllPlayers(cheats);
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            server.getPlayerList().sendPlayerPermissionLevel(p);
        }
    }

    public static boolean isOp(MinecraftServer server, ServerPlayer player) {
        //? if >=1.21.9 {
        return server.getPlayerList().isOp(new NameAndId(player.getGameProfile()));
        //?} else
        /*return server.getPlayerList().isOp(player.getGameProfile());*/
    }

    public static void setPvp(MinecraftServer server, boolean pvp) {
        //? if >=1.21.9 {
        command(server, "gamerule pvp " + pvp);
        //?} else
        /*server.setPvpAllowed(pvp);*/
    }

    public static void command(MinecraftServer server, String command) {
        try {
            server.getCommands().performPrefixedCommand(server.createCommandSourceStack().withSuppressedOutput(), command);
        } catch (Exception e) {
            Vibey.LOG.warn("Command '{}' failed: {}", command, e.toString());
        }
    }
}
