package dev.henny.vibey.client;

import dev.henny.vibey.Compat;
import dev.henny.vibey.client.ui.CardScreen;
import dev.henny.vibey.client.ui.Gfx;
import dev.henny.vibey.host.Guests;
import dev.henny.vibey.host.HostConfig;
import dev.henny.vibey.host.HostSession;
import net.minecraft.ChatFormatting;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.resources.language.I18n;
import net.minecraft.network.chat.Component;
import net.minecraft.world.level.GameType;

import java.util.ArrayList;
import java.util.List;

/**
 * The main host window, kept as small as possible: your address, whether you are online, start/stop. Everything
 * else (players, whitelist, bans, world settings) lives in {@link AdminScreen}.
 */
public final class HostScreen extends CardScreen {
    private long copiedAt;

    public HostScreen(Screen parent) {
        super(Component.translatable("vibey.title"), parent);
    }

    @Override
    public void removed() {
        HostConfig.save();
    }

    @Override
    protected int cardWidth() {
        return 300;
    }

    @Override
    protected int headerHeight() {
        return 34;
    }

    @Override
    protected int footerHeight() {
        return 38;
    }

    @Override
    protected void drawHeader(Gfx g, int x, int y, int w) {
        title(g, I18n.get("vibey.title"), x + PAD, y + 13);
        int closeLeft = closeButton(g, x, y, w);
        statusPill(g, closeLeft - 6, y + 10);
    }

    @Override
    protected int drawBody(Gfx g, int x, int y, int w) {
        y = drawAddress(g, x, y, w);
        y += 8;
        g.text(g.clip(summary(), w), x, y, DIM);
        return y + 12;
    }

    private int drawAddress(Gfx g, int x, int y, int w) {
        HostSession.Status st = HostSession.status();
        if (st == HostSession.Status.ERROR) {
            List<String> lines = wrap(g, HostSession.error(), w - 20);
            int h = 22 + lines.size() * 10 + 12;
            g.rect(x, y, w, h, 0xFF2A1416);
            g.outline(x, y, w, h, 0xFF4A2024);
            g.text(I18n.get("vibey.status.error"), x + 10, y + 8, RED);
            int ly = y + 21;
            for (String l : lines) {
                g.text(l, x + 10, ly, TEXT);
                ly += 10;
            }
            g.text(g.clip(I18n.get("vibey.error.hint"), w - 20), x + 10, ly + 2, MUTED);
            return y + h;
        }

        int h = 44;
        g.rect(x, y, w, h, SURFACE);
        g.text(I18n.get("vibey.address"), x + 10, y + 8, MUTED);

        String address = HostSession.address();
        boolean live = st == HostSession.Status.ONLINE;
        boolean pending = st == HostSession.Status.CONNECTING || st == HostSession.Status.RECONNECTING;

        int btnW = 0;
        if (!address.isEmpty()) {
            boolean copied = System.currentTimeMillis() - copiedAt < 1500;
            String bl = I18n.get(copied ? "vibey.copied" : "vibey.copy");
            btnW = g.width(bl) + 16;
            int bx = x + w - 8 - btnW;
            int by = y + 13;
            boolean hov = hover(bx, by, btnW, 18);
            g.rect(bx, by, btnW, 18, copied ? 0xFF1F3A28 : (hov ? ACCENT_HOVER : ACCENT));
            g.textCenter(bl, bx + btnW / 2, by + 5, copied ? GREEN : 0xFFFFFFFF);
            hit(bx, by, btnW, 18, () -> {
                this.minecraft.keyboardHandler.setClipboard(address);
                copiedAt = System.currentTimeMillis();
            });
        }

        int textW = w - 20 - (btnW > 0 ? btnW + 8 : 0);
        if (address.isEmpty()) {
            String t = pending ? I18n.get("vibey.status.connecting") + dots() : I18n.get("vibey.address.none");
            g.text(g.clip(t, textW), x + 10, y + 21, pending ? TEXT : DIM);
        } else {
            // Bold glyphs are one pixel wider than the plain ones the clip measures.
            g.text(Component.literal(g.clip(address, textW - address.length())).withStyle(ChatFormatting.BOLD), x + 10, y + 21, live ? TEXT : MUTED);
        }
        String sub;
        if (live) sub = I18n.get("vibey.address.hint");
        else if (pending) sub = I18n.get("vibey.address.pending");
        else sub = I18n.get(address.isEmpty() ? "vibey.address.first" : "vibey.address.offline");
        String notice = HostSession.notice();
        if (live && !notice.isEmpty()) g.text(g.clip(notice, textW), x + 10, y + 32, AMBER);
        else g.text(g.clip(sub, textW), x + 10, y + 32, DIM);
        return y + h;
    }

    /** One line: players · game mode · whitelist. */
    private String summary() {
        HostConfig cfg = HostConfig.get();
        List<String> parts = new ArrayList<>();
        if (HostSession.isHosting()) {
            parts.add(I18n.get("vibey.summary.players", Guests.snapshot().size(), cfg.maxPlayers));
        }
        parts.add(GameType.byName(cfg.gameMode, GameType.SURVIVAL).getShortDisplayName().getString());
        if (cfg.cheats) parts.add(I18n.get("vibey.cheats"));
        if (cfg.whitelistEnabled) parts.add(I18n.get("vibey.summary.whitelist"));
        if (cfg.forceMods) parts.add(I18n.get("vibey.forcemods"));
        return String.join("  ·  ", parts);
    }

    @Override
    protected void drawFooter(Gfx g, int x, int bottom, int w) {
        int y = bottom + 8;
        int bx = x + PAD;
        int bw = w - PAD * 2;
        int manageW = Math.max(80, g.width(I18n.get("vibey.manage")) + 24);
        button(g, bx, y, manageW, 20, I18n.get("vibey.manage"), Style.SECONDARY,
                () -> Compat.openScreen(new AdminScreen(this)));

        int px = bx + manageW + 6;
        int pw = bw - manageW - 6;
        if (!HostSession.canHost()) {
            button(g, px, y, pw, 20, I18n.get("vibey.button.noworld"), Style.DISABLED, null);
        } else if (HostSession.isHosting()) {
            button(g, px, y, pw, 20, I18n.get("vibey.button.stop"), Style.DANGER, HostSession::stop);
        } else {
            String key = HostSession.status() == HostSession.Status.ERROR ? "vibey.button.retry" : "vibey.button.start";
            button(g, px, y, pw, 20, I18n.get(key), Style.PRIMARY, () -> {
                HostConfig.save();
                HostSession.start();
            });
        }
    }
}
