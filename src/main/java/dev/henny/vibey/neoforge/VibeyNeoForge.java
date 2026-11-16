package dev.henny.vibey.neoforge;

import dev.henny.vibey.Platform;
import dev.henny.vibey.Vibey;
import dev.henny.vibey.client.ClientHooks;
import dev.henny.vibey.client.PauseMenu;
import dev.henny.vibey.host.Guests;
import dev.henny.vibey.host.HostSession;
import dev.henny.vibey.net.ModListPayload;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModList;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.ScreenEvent;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.entity.player.PlayerEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
import net.neoforged.neoforgespi.language.IModInfo;
//? if >=1.21.9 {
import net.neoforged.neoforge.client.network.ClientPacketDistributor;
//?} else
/*import net.neoforged.neoforge.network.PacketDistributor;*/

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

@Mod(value = Vibey.MOD_ID, dist = Dist.CLIENT)
public final class VibeyNeoForge implements Platform {
    private List<ModInfo> mods;

    public VibeyNeoForge(IEventBus modBus) {
        Vibey.init(this);
        modBus.addListener(this::registerPayloads);

        IEventBus bus = NeoForge.EVENT_BUS;
        bus.addListener((PlayerEvent.PlayerLoggedInEvent e) -> {
            if (e.getEntity() instanceof ServerPlayer p) Guests.onJoin(((ServerLevel) p.level()).getServer(), p);
        });
        bus.addListener((PlayerEvent.PlayerLoggedOutEvent e) -> {
            if (e.getEntity() instanceof ServerPlayer p) Guests.onLeave(((ServerLevel) p.level()).getServer(), p);
        });
        bus.addListener((ServerTickEvent.Post e) -> Guests.tick(e.getServer()));
        bus.addListener((ServerStoppingEvent e) -> HostSession.onServerStopping(e.getServer()));
        bus.addListener((ClientPlayerNetworkEvent.LoggingIn e) -> ClientHooks.onJoinedServer());
        bus.addListener((ScreenEvent.Init.Post e) -> PauseMenu.decorate(e.getScreen(),
                new ArrayList<>(e.getListenersList()), e::addListener, e::removeListener));
    }

    private void registerPayloads(RegisterPayloadHandlersEvent event) {
        event.registrar("1").optional().playToServer(ModListPayload.TYPE, ModListPayload.CODEC, (payload, context) ->
                context.enqueueWork(() -> {
                    if (context.player() instanceof ServerPlayer p) {
                        Guests.onModList(((ServerLevel) p.level()).getServer(), p, payload.mods());
                    }
                }));
    }

    @Override
    public String loader() {
        return "NeoForge";
    }

    @Override
    public Path configDir() {
        return FMLPaths.CONFIGDIR.get();
    }

    @Override
    public List<ModInfo> mods() {
        if (mods == null) {
            List<ModInfo> list = new ArrayList<>();
            for (IModInfo m : ModList.get().getMods()) {
                list.add(new ModInfo(m.getModId(), m.getDisplayName(), m.getVersion().toString(), false, false));
            }
            mods = List.copyOf(list);
        }
        return mods;
    }

    @Override
    public boolean sendToServer(ModListPayload payload) {
        ClientPacketListener connection = Minecraft.getInstance().getConnection();
        if (connection == null || !connection.hasChannel(ModListPayload.TYPE)) return false;
        //? if >=1.21.9 {
        ClientPacketDistributor.sendToServer(payload);
        //?} else
        /*PacketDistributor.sendToServer(payload);*/
        return true;
    }
}
