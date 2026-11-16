package dev.henny.vibey.client;

import dev.henny.vibey.BuildInfo;
import dev.henny.vibey.Compat;
import dev.henny.vibey.client.ui.BaseScreen;
import dev.henny.vibey.client.ui.Gfx;
import dev.henny.vibey.host.Guests;
import dev.henny.vibey.host.HostConfig;
import dev.henny.vibey.host.HostSession;
import net.minecraft.ChatFormatting;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.resources.language.I18n;
import net.minecraft.locale.Language;
import net.minecraft.network.chat.Component;
import net.minecraft.world.level.GameType;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The host screen, square like the studio website: one card, three simple switches, the player list and a folded "Advanced" part. Drawn by hand
 * (immediate mode): every frame lays everything out again and records the clickable areas for the next click.
 */
public final class HostScreen extends BaseScreen {
    // Palette: dark and calm, one blue accent.
    static final int DIM_BG = 0xB0000000;
    static final int CARD = 0xFF141417;
    static final int CARD_LINE = 0xFF26262C;
    static final int SURFACE = 0xFF1E1E23;
    static final int SURFACE_HOVER = 0xFF282830;
    static final int SURFACE_2 = 0xFF2C2C34;
    static final int TEXT = 0xFFF4F4F6;
    static final int MUTED = 0xFFA0A0AA;
    static final int DIM = 0xFF6E6E78;
    static final int ACCENT = 0xFF3B82F6;
    static final int ACCENT_HOVER = 0xFF5B9BFF;
    static final int GREEN = 0xFF34C759;
    static final int AMBER = 0xFFFFB224;
    static final int RED = 0xFFFF5A4F;

    private static final GameType[] MODES = {GameType.SURVIVAL, GameType.CREATIVE, GameType.ADVENTURE, GameType.SPECTATOR};
    private static final int PAD = 14;
    private static final int HEADER = 46;
    private static final int FOOTER = 42;

    private record Hit(int x, int y, int w, int h, int button, Runnable action) {}

    private final Screen parent;
    private final List<Hit> hits = new ArrayList<>();
    private final Map<String, Float> anim = new HashMap<>();
    private EditBox relayBox;
    private long lastFrame;
    private float dt;
    private double scroll;
    private int contentHeight;
    private int clipTop = Integer.MIN_VALUE;
    private int clipBottom = Integer.MAX_VALUE;
    private int mouseX;
    private int mouseY;
    private long copiedAt;
    private long rotateArmedAt;

    public HostScreen(Screen parent) {
        super(Component.translatable("vibey.title"));
        this.parent = parent;
    }

    @Override
    protected void init() {
        HostConfig cfg = HostConfig.get();
        relayBox = new EditBox(this.font, 0, 0, 120, 12, Component.translatable("vibey.adv.relay"));
        relayBox.setBordered(false);
        relayBox.setMaxLength(253);
        relayBox.setTextColor(TEXT);
        relayBox.setValue(cfg.relay);
        relayBox.setResponder(v -> cfg.relay = v);
        relayBox.visible = false;
        addWidget(relayBox);
    }

    @Override
    public void removed() {
        HostConfig.save();
    }

    @Override
    public void onClose() {
        HostConfig.save();
        Compat.openScreen(parent);
    }

    // ============================================================================================ drawing

    @Override
    protected void draw(Gfx g, int mx, int my, float delta) {
        long now = System.nanoTime();
        dt = lastFrame == 0 ? 0f : Math.min(0.1f, (now - lastFrame) / 1e9f);
        lastFrame = now;
        mouseX = mx;
        mouseY = my;
        hits.clear();
        clipTop = Integer.MIN_VALUE;
        clipBottom = Integer.MAX_VALUE;

        float open = anim("open", 1f, 10f);
        g.rect(0, 0, width, height, alpha(DIM_BG, open));

        int w = Math.min(330, width - 20);
        int maxH = height - 20;
        int h = Math.min(HEADER + contentHeight + FOOTER, maxH);
        int x = (width - w) / 2;
        int y = (height - h) / 2 + Math.round((1f - open) * 8);

        // Card with a soft shadow
        g.rect(x + 3, y + 3, w, h, 0x50000000);
        g.rect(x, y, w, h, CARD);
        g.outline(x, y, w, h, CARD_LINE);

        drawHeader(g, x, y, w);

        int top = y + HEADER;
        int bottom = y + h - FOOTER;
        int maxScroll = Math.max(0, contentHeight - (bottom - top));
        scroll = Math.max(0, Math.min(scroll, maxScroll));

        g.scissor(x + 1, top, x + w - 1, bottom);
        clipTop = top;
        clipBottom = bottom;
        int cy = top - (int) Math.round(scroll);
        int start = cy;
        cy = drawAddress(g, x + PAD, cy, w - PAD * 2);
        cy += 14;
        cy = drawWorld(g, x + PAD, cy, w - PAD * 2);
        cy += 10;
        cy = drawPlayers(g, x + PAD, cy, w - PAD * 2);
        cy += 10;
        cy = drawAdvanced(g, x + PAD, cy, w - PAD * 2, delta);
        cy += 8;
        contentHeight = cy - start;
        g.endScissor();
        clipTop = Integer.MIN_VALUE;
        clipBottom = Integer.MAX_VALUE;

        // Fades at the edges of the scroll area and a slim scrollbar
        if (maxScroll > 0) {
            if (scroll > 0) g.rect(x + 1, top, w - 2, 1, CARD_LINE);
            if (scroll < maxScroll) g.rect(x + 1, bottom - 1, w - 2, 1, CARD_LINE);
            int track = bottom - top - 8;
            int thumb = Math.max(16, track * (bottom - top) / Math.max(1, contentHeight));
            int ty = top + 4 + (int) ((track - thumb) * (scroll / maxScroll));
            g.rect(x + w - 5, ty, 2, thumb, 0x50FFFFFF);
        }

        drawFooter(g, x, bottom, w);
    }

    private void drawHeader(Gfx g, int x, int y, int w) {
        g.text(Component.translatable("vibey.title").withStyle(ChatFormatting.BOLD), x + PAD, y + 13, TEXT);
        g.text(I18n.get("vibey.subtitle"), x + PAD, y + 26, MUTED);

        // Close
        int cx = x + w - PAD - 9;
        int cyy = y + 11;
        boolean hov = hover(cx - 3, cyy - 3, 15, 15);
        if (hov) g.rect(cx - 3, cyy - 3, 15, 15, SURFACE_HOVER);
        cross(g, cx, cyy, 9, hov ? TEXT : MUTED);
        hit(cx - 3, cyy - 3, 15, 15, this::onClose);

        // Status pill
        HostSession.Status st = HostSession.status();
        int color;
        String label;
        switch (st) {
            case ONLINE -> {
                color = GREEN;
                label = I18n.get("vibey.status.online");
            }
            case CONNECTING -> {
                color = AMBER;
                label = I18n.get("vibey.status.connecting");
            }
            case RECONNECTING -> {
                color = AMBER;
                label = I18n.get("vibey.status.reconnecting");
            }
            case ERROR -> {
                color = RED;
                label = I18n.get("vibey.status.error");
            }
            default -> {
                color = DIM;
                label = I18n.get("vibey.status.off");
            }
        }
        int pw = g.width(label) + 20;
        int px = cx - 8 - pw;
        int py = y + 10;
        g.rect(px, py, pw, 14, SURFACE);
        float pulse = st == HostSession.Status.CONNECTING || st == HostSession.Status.RECONNECTING
                ? 0.55f + 0.45f * (float) Math.sin(System.currentTimeMillis() / 180.0) : 1f;
        if (st == HostSession.Status.ONLINE) {
            float ring = (System.currentTimeMillis() % 1600) / 1600f;
            int r = 2 + Math.round(ring * 3);
            g.outline(px + 8 - r, py + 7 - r, r * 2, r * 2, alpha(color, (1f - ring) * 0.5f));
        }
        g.rect(px + 6, py + 5, 4, 4, alpha(color, pulse));
        g.text(label, px + 14, py + 3, st == HostSession.Status.OFF ? MUTED : TEXT);
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
            int bg = copied ? 0xFF1F3A28 : (hov ? ACCENT_HOVER : ACCENT);
            g.rect(bx, by, btnW, 18, bg);
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
            int color = live ? TEXT : MUTED;
            g.text(Component.literal(g.clip(address, textW)).withStyle(ChatFormatting.BOLD), x + 10, y + 21, color);
        }
        String sub;
        if (live) {
            int guests = Math.max(0, Guests.snapshot().size() - 1);
            sub = guests == 0 ? I18n.get("vibey.address.hint") : I18n.get("vibey.address.guests", guests);
        } else if (pending) {
            sub = I18n.get("vibey.address.pending");
        } else {
            sub = I18n.get(address.isEmpty() ? "vibey.address.first" : "vibey.address.offline");
        }
        String notice = HostSession.notice();
        if (live && !notice.isEmpty()) {
            g.text(g.clip(notice, textW), x + 10, y + 32, AMBER);
        } else {
            g.text(g.clip(sub, textW), x + 10, y + 32, DIM);
        }
        return y + h;
    }

    private int drawWorld(Gfx g, int x, int y, int w) {
        HostConfig cfg = HostConfig.get();
        y = section(g, I18n.get("vibey.section.world"), x, y);

        int rowH = row(g, x, y, w, "vibey.gamemode");
        gameModePicker(g, x + w, y + rowH / 2);
        y += rowH;

        rowH = row(g, x, y, w, "vibey.cheats");
        toggle(g, "cheats", x + w, y + rowH / 2, cfg.cheats, () -> {
            cfg.cheats = !cfg.cheats;
            HostSession.applyCheats();
            HostConfig.save();
        });
        y += rowH;

        rowH = row(g, x, y, w, "vibey.forcemods");
        toggle(g, "forcemods", x + w, y + rowH / 2, cfg.forceMods, () -> {
            cfg.forceMods = !cfg.forceMods;
            HostConfig.save();
        });
        y += rowH;
        return y;
    }

    private int drawPlayers(Gfx g, int x, int y, int w) {
        HostConfig cfg = HostConfig.get();
        List<Guests.View> players = HostSession.isHosting() ? Guests.snapshot() : List.of();
        String title = I18n.get("vibey.section.players");
        if (HostSession.isHosting()) title += "  " + players.size() + "/" + cfg.maxPlayers;
        y = section(g, title, x, y);

        List<Guests.View> guests = players.stream().filter(p -> !p.host()).toList();
        if (guests.isEmpty()) {
            g.rect(x, y, w, 26, SURFACE);
            String key = HostSession.isHosting() ? "vibey.players.empty" : "vibey.players.offline";
            g.textCenter(g.clip(I18n.get(key), w - 16), x + w / 2, y + 9, DIM);
            return y + 26;
        }
        for (Guests.View p : guests) {
            int h = 24;
            boolean hov = hover(x, y, w, h);
            g.rect(x, y, w, h, hov ? SURFACE_HOVER : SURFACE);
            avatar(g, p.id(), p.name(), x + 6, y + 5);
            g.text(g.clip(p.name(), w - 110), x + 26, y + 8, TEXT);

            // Kick
            int kx = x + w - 6 - 16;
            int ky = y + 4;
            boolean kh = hover(kx, ky, 16, 16);
            if (kh) g.rect(kx, ky, 16, 16, 0xFF3A1C1F);
            cross(g, kx + 4, ky + 4, 8, kh ? RED : DIM);
            UUID id = p.id();
            hit(kx, ky, 16, 16, () -> Guests.kick(id));

            // OP chip
            String op = I18n.get("vibey.players.op");
            int ow = g.width(op) + 12;
            int ox = kx - 6 - ow;
            boolean oh = hover(ox, ky + 1, ow, 14);
            int bg = p.op() ? (oh ? ACCENT_HOVER : ACCENT) : (oh ? SURFACE_2 : 0xFF24242A);
            g.rect(ox, ky + 1, ow, 14, bg);
            g.textCenter(op, ox + ow / 2, ky + 4, p.op() ? 0xFFFFFFFF : MUTED);
            boolean isOp = p.op();
            hit(ox, ky + 1, ow, 14, () -> Guests.setOp(id, !isOp));
            y += h + 3;
        }
        return y - 3;
    }

    private int drawAdvanced(Gfx g, int x, int y, int w, float delta) {
        HostConfig cfg = HostConfig.get();
        boolean hov = hover(x - 4, y - 2, w + 8, 16);
        float rot = anim("adv", cfg.advancedOpen ? 1f : 0f, 16f);
        chevron(g, x + 2, y + 4, rot, hov ? TEXT : MUTED);
        g.text(I18n.get("vibey.section.advanced"), x + 12, y + 3, hov ? TEXT : MUTED);
        hit(x - 4, y - 2, w + 8, 16, () -> {
            cfg.advancedOpen = !cfg.advancedOpen;
            HostConfig.save();
        });
        y += 16;
        if (!cfg.advancedOpen) {
            relayBox.visible = false;
            if (relayBox.isFocused()) setFocused(null);
            return y;
        }
        y += 4;

        int rowH = row(g, x, y, w, "vibey.adv.pvp");
        toggle(g, "pvp", x + w, y + rowH / 2, cfg.pvp, () -> {
            cfg.pvp = !cfg.pvp;
            HostSession.applyPvp();
            HostConfig.save();
        });
        y += rowH;

        rowH = row(g, x, y, w, "vibey.adv.max");
        stepper(g, x + w, y + rowH / 2, cfg.maxPlayers, 2, 8, v -> {
            cfg.maxPlayers = v;
            HostConfig.save();
        });
        y += rowH;

        rowH = row(g, x, y, w, "vibey.adv.exact");
        toggle(g, "exact", x + w, y + rowH / 2, cfg.exactModVersions, () -> {
            cfg.exactModVersions = !cfg.exactModVersions;
            HostConfig.save();
        });
        y += rowH;

        rowH = row(g, x, y, w, "vibey.adv.rotate");
        boolean armed = System.currentTimeMillis() - rotateArmedAt < 3000;
        boolean canRotate = HostSession.status() == HostSession.Status.ONLINE;
        String rl = I18n.get(armed ? "vibey.adv.rotate.confirm" : "vibey.adv.rotate.button");
        int rw = g.width(rl) + 16;
        int rx = x + w - rw;
        int ry = y + rowH / 2 - 8;
        boolean rh = canRotate && hover(rx, ry, rw, 16);
        int rbg = !canRotate ? 0xFF1A1A1E : armed ? (rh ? 0xFFFF7A70 : RED) : (rh ? SURFACE_2 : SURFACE);
        g.rect(rx, ry, rw, 16, rbg);
        g.textCenter(rl, rx + rw / 2, ry + 4, !canRotate ? DIM : armed ? 0xFFFFFFFF : TEXT);
        if (canRotate) {
            hit(rx, ry, rw, 16, () -> {
                if (System.currentTimeMillis() - rotateArmedAt < 3000) {
                    rotateArmedAt = 0;
                    HostSession.rotate();
                } else {
                    rotateArmedAt = System.currentTimeMillis();
                }
            });
        }
        y += rowH;

        rowH = row(g, x, y, w, "vibey.adv.relay");
        int bw = Math.min(150, w / 2);
        int bx = x + w - bw;
        int by = y + rowH / 2 - 8;
        boolean focused = relayBox.isFocused();
        g.rect(bx, by, bw, 16, focused ? SURFACE_2 : SURFACE);
        if (focused) g.outline(bx, by, bw, 16, ACCENT);
        relayBox.setX(bx + 6);
        relayBox.setY(by + 4);
        relayBox.setWidth(bw - 10);
        boolean inView = by >= clipTop && by + 16 <= clipBottom;
        relayBox.visible = inView;
        if (inView) g.widget(relayBox, mouseX, mouseY, delta);
        y += rowH;

        String info = I18n.get("vibey.adv.info",
                HostSession.lanPort() > 0 ? String.valueOf(HostSession.lanPort()) : "–", BuildInfo.VERSION);
        g.text(g.clip(info, w), x, y + 4, DIM);
        return y + 14;
    }

    private void drawFooter(Gfx g, int x, int bottom, int w) {
        int bx = x + PAD;
        int by = bottom + 11;
        int bw = w - PAD * 2;
        int bh = 20;
        boolean canHost = HostSession.canHost();
        HostSession.Status st = HostSession.status();
        boolean running = HostSession.isHosting();
        boolean hov = canHost && hover(bx, by, bw, bh);
        String label;
        int bg;
        int fg;
        if (!canHost) {
            label = I18n.get("vibey.button.noworld");
            bg = SURFACE;
            fg = DIM;
        } else if (running) {
            label = I18n.get("vibey.button.stop");
            bg = hov ? 0xFF3A1C1F : SURFACE;
            fg = hov ? RED : TEXT;
        } else {
            label = I18n.get(st == HostSession.Status.ERROR ? "vibey.button.retry" : "vibey.button.start");
            bg = hov ? ACCENT_HOVER : ACCENT;
            fg = 0xFFFFFFFF;
        }
        g.rect(bx, by, bw, bh, bg);
        g.textCenter(label, bx + bw / 2, by + 6, fg);
        if (canHost) {
            hit(bx, by, bw, bh, () -> {
                if (HostSession.isHosting()) HostSession.stop();
                else {
                    HostConfig.get().relay = relayBox.getValue().trim();
                    HostConfig.save();
                    HostSession.start();
                }
            });
        }
    }

    // ============================================================================================ pieces

    private int section(Gfx g, String title, int x, int y) {
        g.text(title, x, y, MUTED);
        return y + 13;
    }

    /** Label + one muted line of explanation. Returns the row height. */
    private int row(Gfx g, int x, int y, int w, String key) {
        g.text(g.clip(I18n.get(key), w - 110), x, y + 5, TEXT);
        String desc = key + ".desc";
        if (Language.getInstance().has(desc)) {
            g.text(g.clip(I18n.get(desc), w - 110), x, y + 16, DIM);
            return 30;
        }
        return 22;
    }

    private void toggle(Gfx g, String id, int right, int cy, boolean on, Runnable action) {
        int tw = 24;
        int th = 13;
        int tx = right - tw;
        int ty = cy - th / 2 - 1;
        float t = anim("t." + id, on ? 1f : 0f, 18f);
        boolean hov = hover(tx - 4, ty - 4, tw + 8, th + 8);
        int track = mix(hov ? 0xFF3A3A44 : 0xFF303038, hov ? ACCENT_HOVER : ACCENT, t);
        g.rect(tx, ty, tw, th, track);
        int knob = th - 4;
        int kx = tx + 2 + Math.round(t * (tw - knob - 4));
        g.rect(kx, ty + 2, knob, knob, mix(0xFFC8C8D0, 0xFFFFFFFF, t));
        hit(tx - 4, ty - 4, tw + 8, th + 8, action);
    }

    private void gameModePicker(Gfx g, int right, int cy) {
        HostConfig cfg = HostConfig.get();
        int index = 0;
        for (int i = 0; i < MODES.length; i++) if (MODES[i].getName().equals(cfg.gameMode)) index = i;
        String label = MODES[index].getShortDisplayName().getString();
        int pw = 104;
        int px = right - pw;
        int py = cy - 8;
        boolean hl = hover(px, py, pw / 2, 16);
        boolean hr = hover(px + pw / 2, py, pw - pw / 2, 16);
        g.rect(px, py, pw, 16, hl || hr ? SURFACE_HOVER : SURFACE);
        g.textCenter(g.clip(label, pw - 28), px + pw / 2, py + 4, TEXT);
        arrow(g, px + 6, py + 5, false, hl ? TEXT : DIM);
        arrow(g, px + pw - 10, py + 5, true, hr ? TEXT : DIM);
        int cur = index;
        hit(px, py, pw / 2, 16, () -> setMode(MODES[(cur + MODES.length - 1) % MODES.length]));
        hit(px + pw / 2, py, pw - pw / 2, 16, () -> setMode(MODES[(cur + 1) % MODES.length]));
        hit(px, py, pw, 16, 1, () -> setMode(MODES[(cur + MODES.length - 1) % MODES.length]));
    }

    private void setMode(GameType mode) {
        HostConfig.get().gameMode = mode.getName();
        HostConfig.save();
        HostSession.applyGameMode();
    }

    private void stepper(Gfx g, int right, int cy, int value, int min, int max, java.util.function.IntConsumer set) {
        int bw = 16;
        int vw = 24;
        int x = right - bw * 2 - vw;
        int y = cy - 8;
        g.rect(x, y, bw * 2 + vw, 16, SURFACE);
        boolean canDown = value > min;
        boolean canUp = value < max;
        boolean hd = canDown && hover(x, y, bw, 16);
        boolean hu = canUp && hover(x + bw + vw, y, bw, 16);
        if (hd) g.rect(x, y, bw, 16, SURFACE_2);
        if (hu) g.rect(x + bw + vw, y, bw, 16, SURFACE_2);
        g.rect(x + 5, y + 7, 6, 2, canDown ? (hd ? TEXT : MUTED) : 0xFF3A3A42);
        int px = x + bw + vw;
        g.rect(px + 5, y + 7, 6, 2, canUp ? (hu ? TEXT : MUTED) : 0xFF3A3A42);
        g.rect(px + 7, y + 5, 2, 6, canUp ? (hu ? TEXT : MUTED) : 0xFF3A3A42);
        g.textCenter(String.valueOf(value), x + bw + vw / 2, y + 4, TEXT);
        if (canDown) hit(x, y, bw, 16, () -> set.accept(value - 1));
        if (canUp) hit(x + bw + vw, y, bw, 16, () -> set.accept(value + 1));
    }

    private void avatar(Gfx g, UUID id, String name, int x, int y) {
        float hue = (id.hashCode() & 0xFFFF) / 65535f;
        int color = hsv(hue, 0.45f, 0.75f);
        g.rect(x, y, 14, 14, color);
        String initial = name.isEmpty() ? "?" : name.substring(0, 1).toUpperCase();
        g.textCenter(initial, x + 7, y + 3, 0xFFFFFFFF);
    }

    private static void cross(Gfx g, int x, int y, int size, int color) {
        for (int i = 0; i < size; i++) {
            g.rect(x + i, y + i, 1, 1, color);
            g.rect(x + size - 1 - i, y + i, 1, 1, color);
        }
    }

    private static void arrow(Gfx g, int x, int y, boolean right, int color) {
        for (int i = 0; i < 3; i++) {
            int len = 1 + i * 2;
            int col = right ? x + 2 - i : x + i;
            g.rect(col, y + 3 - i, 1, len, color);
        }
    }

    /** Small chevron, t = 0 points right, t = 1 points down. */
    private static void chevron(Gfx g, int x, int y, float t, int color) {
        for (int i = 0; i < 3; i++) {
            if (t < 0.5f) g.rect(x + 1 + i, y + i, 1, 5 - i * 2, color);
            else g.rect(x + i, y + 1 + i, 5 - i * 2, 1, color);
        }
    }

    private static List<String> wrap(Gfx g, String text, int width) {
        List<String> out = new ArrayList<>();
        StringBuilder line = new StringBuilder();
        for (String word : text.split(" ")) {
            String next = line.isEmpty() ? word : line + " " + word;
            if (g.width(next) > width && !line.isEmpty()) {
                out.add(line.toString());
                line = new StringBuilder(word);
            } else {
                line = new StringBuilder(next);
            }
            if (out.size() == 3) break;
        }
        if (!line.isEmpty() && out.size() < 3) out.add(g.clip(line.toString(), width));
        return out;
    }

    private static String dots() {
        int n = (int) (System.currentTimeMillis() / 400 % 4);
        return ".".repeat(n);
    }

    // ============================================================================================ input

    private void hit(int x, int y, int w, int h, Runnable action) {
        hit(x, y, w, h, 0, action);
    }

    private void hit(int x, int y, int w, int h, int button, Runnable action) {
        int y1 = Math.max(y, clipTop);
        int y2 = Math.min(y + h, clipBottom);
        if (y2 <= y1) return;
        hits.add(new Hit(x, y1, w, y2 - y1, button, action));
    }

    private boolean hover(int x, int y, int w, int h) {
        if (mouseY < clipTop || mouseY >= clipBottom) return false;
        return mouseX >= x && mouseX < x + w && mouseY >= y && mouseY < y + h;
    }

    @Override
    protected boolean click(double x, double y, int button) {
        if (relayBox.visible && x >= relayBox.getX() - 6 && x < relayBox.getX() + relayBox.getWidth() + 4
                && y >= relayBox.getY() - 4 && y < relayBox.getY() + 12) {
            return false; // let the text field handle it
        }
        if (relayBox.isFocused()) {
            relayBox.setFocused(false);
            setFocused(null);
        }
        for (int i = hits.size() - 1; i >= 0; i--) {
            Hit h = hits.get(i);
            if (h.button == button && x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) {
                h.action.run();
                return true;
            }
        }
        return false;
    }

    @Override
    protected boolean scroll(double x, double y, double amount) {
        scroll -= amount * 18;
        return true;
    }

    // ============================================================================================ util

    private float anim(String key, float target, float speed) {
        float cur = anim.getOrDefault(key, key.equals("open") ? 0f : target);
        float next = cur + (target - cur) * (1f - (float) Math.exp(-dt * speed));
        if (Math.abs(next - target) < 0.002f) next = target;
        anim.put(key, next);
        return next;
    }

    static int hsv(float h, float s, float v) {
        float c = v * s;
        float hp = (h * 6f) % 6f;
        float x = c * (1 - Math.abs(hp % 2 - 1));
        float r = 0, g = 0, b = 0;
        if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; } else if (hp < 3) { g = c; b = x; }
        else if (hp < 4) { g = x; b = c; } else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
        float m = v - c;
        return 0xFF000000 | (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
    }

    static int alpha(int color, float a) {
        int base = color >>> 24;
        int na = Math.max(0, Math.min(255, Math.round(base * a)));
        return (na << 24) | (color & 0xFFFFFF);
    }

    static int mix(int a, int b, float t) {
        t = Math.max(0, Math.min(1, t));
        int r = 0;
        for (int s = 0; s <= 24; s += 8) {
            int ca = (a >>> s) & 0xFF;
            int cb = (b >>> s) & 0xFF;
            r |= (Math.round(ca + (cb - ca) * t) & 0xFF) << s;
        }
        return r;
    }
}
