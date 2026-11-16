package dev.henny.vibey.client;

import dev.henny.vibey.Compat;
import dev.henny.vibey.host.HostSession;
import net.minecraft.ChatFormatting;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.chat.contents.TranslatableContents;

import java.util.List;
import java.util.function.Consumer;

/**
 * Puts "Host World" into the pause menu: in place of "Open to LAN" (or of "Player Reporting", which vanilla shows in
 * that slot once a world is published; it stays reachable with P), otherwise as a small button in the top right.
 */
public final class PauseMenu {
    private PauseMenu() {}

    public static void decorate(Screen screen, List<? extends GuiEventListener> widgets,
                                Consumer<AbstractWidget> add, Consumer<AbstractWidget> remove) {
        if (!(screen instanceof PauseScreen) || !HostSession.canHost()) return;
        if (find(widgets, "menu.returnToGame") == null) return; // pause menu hidden (F3 + Esc)

        // "Open to LAN" before hosting, "Player Reporting" in the same slot once the world is published.
        Button lan = find(widgets, "menu.shareToLan");
        if (lan == null) lan = find(widgets, "menu.playerReporting");
        if (lan != null) {
            Button replacement = Button.builder(label(), b -> open(screen))
                    .bounds(lan.getX(), lan.getY(), lan.getWidth(), lan.getHeight()).build();
            remove.accept(lan);
            add.accept(replacement);
            return;
        }
        int w = 98;
        add.accept(Button.builder(label(), b -> open(screen)).bounds(screen.width - w - 6, 6, w, 20).build());
    }

    private static void open(Screen parent) {
        Compat.openScreen(new HostScreen(parent));
    }

    private static Component label() {
        if (HostSession.isHosting()) {
            MutableComponent dot = Component.literal("● ").withStyle(
                    HostSession.status() == HostSession.Status.ONLINE ? ChatFormatting.GREEN : ChatFormatting.GOLD);
            return dot.append(Component.translatable("vibey.pause.online").withStyle(ChatFormatting.WHITE));
        }
        return Component.translatable("vibey.pause.host");
    }

    private static Button find(List<? extends GuiEventListener> widgets, String key) {
        for (GuiEventListener l : widgets) {
            if (l instanceof Button b && b.getMessage().getContents() instanceof TranslatableContents tc
                    && tc.getKey().equals(key)) {
                return b;
            }
        }
        return null;
    }
}
