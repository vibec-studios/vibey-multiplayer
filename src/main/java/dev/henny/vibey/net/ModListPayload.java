package dev.henny.vibey.net;

import dev.henny.vibey.Compat;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;

import java.util.ArrayList;
import java.util.List;

/** Joining player -> host: "these mods are installed on my side" (entries are {@code id@version}). */
public record ModListPayload(List<String> mods) implements CustomPacketPayload {
    public static final CustomPacketPayload.Type<ModListPayload> TYPE = Compat.payloadType("mods");
    private static final int MAX = 1024;

    public static final StreamCodec<FriendlyByteBuf, ModListPayload> CODEC = StreamCodec.of(
            (buf, p) -> {
                List<String> list = p.mods.size() > MAX ? p.mods.subList(0, MAX) : p.mods;
                buf.writeVarInt(list.size());
                for (String s : list) buf.writeUtf(s, 256);
            },
            buf -> {
                int n = Math.min(buf.readVarInt(), MAX);
                List<String> list = new ArrayList<>(n);
                for (int i = 0; i < n; i++) list.add(buf.readUtf(256));
                return new ModListPayload(list);
            });

    @Override
    public CustomPacketPayload.Type<? extends CustomPacketPayload> type() {
        return TYPE;
    }
}
