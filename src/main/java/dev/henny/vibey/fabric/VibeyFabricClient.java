package dev.henny.vibey.fabric;

import dev.henny.vibey.Platform;
import dev.henny.vibey.Vibey;
import dev.henny.vibey.client.ClientHooks;
import dev.henny.vibey.client.PauseMenu;
import dev.henny.vibey.host.Guests;
import dev.henny.vibey.host.HostSession;
import dev.henny.vibey.net.ModListPayload;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.loader.api.ModContainer;
import net.fabricmc.loader.api.metadata.ModEnvironment;
import net.fabricmc.loader.api.metadata.ModMetadata;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

public final class VibeyFabricClient implements ClientModInitializer, Platform {
    private List<ModInfo> mods;

    @Override
    public void onInitializeClient() {
        Vibey.init(this);

        //? if >=26.1 {
        /*PayloadTypeRegistry.serverboundPlay().register(ModListPayload.TYPE, ModListPayload.CODEC);
        *///?} else
        PayloadTypeRegistry.playC2S().register(ModListPayload.TYPE, ModListPayload.CODEC);
        ServerPlayNetworking.registerGlobalReceiver(ModListPayload.TYPE, (payload, context) ->
                Guests.onModList(context.server(), context.player(), payload.mods()));

        ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> Guests.onJoin(server, handler.getPlayer()));
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> Guests.onLeave(server, handler.getPlayer()));
        ServerTickEvents.END_SERVER_TICK.register(Guests::tick);
        ServerLifecycleEvents.SERVER_STOPPING.register(HostSession::onServerStopping);

        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> ClientHooks.onJoinedServer());

        ScreenEvents.AFTER_INIT.register((client, screen, w, h) -> {
            //? if >=26.1 {
            /*var buttons = Screens.getWidgets(screen);
            *///?} else
            var buttons = Screens.getButtons(screen);
            PauseMenu.decorate(screen, new ArrayList<>(buttons), buttons::add, buttons::remove);
        });
    }

    @Override
    public String loader() {
        return "Fabric";
    }

    @Override
    public Path configDir() {
        return FabricLoader.getInstance().getConfigDir();
    }

    @Override
    public List<ModInfo> mods() {
        if (mods == null) {
            List<ModInfo> list = new ArrayList<>();
            for (ModContainer c : FabricLoader.getInstance().getAllMods()) {
                ModMetadata m = c.getMetadata();
                boolean nested = c.getContainingMod().isPresent();
                boolean builtin = "builtin".equals(m.getType());
                list.add(new ModInfo(m.getId(), m.getName(), m.getVersion().getFriendlyString(),
                        m.getEnvironment() == ModEnvironment.CLIENT, nested || builtin));
            }
            mods = List.copyOf(list);
        }
        return mods;
    }

    @Override
    public boolean sendToServer(ModListPayload payload) {
        if (!ClientPlayNetworking.canSend(ModListPayload.TYPE)) return false;
        ClientPlayNetworking.send(payload);
        return true;
    }
}
