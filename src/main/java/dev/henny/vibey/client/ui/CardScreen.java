package dev.henny.vibey.client.ui;

import dev.henny.vibey.Compat;
import dev.henny.vibey.host.HostSession;
import net.minecraft.ChatFormatting;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.resources.language.I18n;
import net.minecraft.locale.Language;
import net.minecraft.network.chat.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * One square card in the middle of the screen, drawn by hand in immediate mode: every frame lays everything out again
 * and records the clickable areas for the next click. Subclasses fill the header, a scrollable body and a footer.
 */
public abstract class CardScreen extends BaseScreen {
    // Palette: dark and calm, one blue accent, no rounded corners (like the studio website).
    public static final int DIM_BG = 0xB0000000;
    public static final int CARD = 0xFF141417;
    public static final int CARD_LINE = 0xFF26262C;
    public static final int SURFACE = 0xFF1E1E23;
    public static final int SURFACE_HOVER = 0xFF282830;
    public static final int SURFACE_2 = 0xFF2C2C34;
    public static final int TEXT = 0xFFF4F4F6;
    public static final int MUTED = 0xFFA0A0AA;
    public static final int DIM = 0xFF6E6E78;
    public static final int ACCENT = 0xFF3B82F6;
    public static final int ACCENT_HOVER = 0xFF5B9BFF;
    public static final int GREEN = 0xFF34C759;
    public static final int AMBER = 0xFFFFB224;
    public static final int RED = 0xFFFF5A4F;
    public static final int RED_BG = 0xFF3A1C1F;

    protected static final int PAD = 14;

    public enum Style { PRIMARY, SECONDARY, DANGER, DISABLED }

    private record Hit(int x, int y, int w, int h, int button, Runnable action) {}

    protected final Screen parent;
    private final List<Hit> hits = new ArrayList<>();
    private final Map<String, Float> anim = new HashMap<>();
    private final Map<EditBox, Runnable> inputs = new LinkedHashMap<>();
    private long lastFrame;
    private float dt;
    protected double scroll;
    private int contentHeight;
    private int clipTop = Integer.MIN_VALUE;
    private int clipBottom = Integer.MAX_VALUE;
    protected int mouseX;
    protected int mouseY;
    private float delta;

    protected CardScreen(Component title, Screen parent) {
        super(title);
        this.parent = parent;
    }

    // ============================================================================================ layout hooks

    protected abstract int cardWidth();

    protected abstract int headerHeight();

    protected abstract int footerHeight();

    protected abstract void drawHeader(Gfx g, int x, int y, int w);

    /** Draws the scrollable body starting at {@code y}, returns where it ended. */
    protected abstract int drawBody(Gfx g, int x, int y, int w);

    protected abstract void drawFooter(Gfx g, int x, int y, int w);

    /** Fixed card height, or -1 to fit the content. */
    protected int fixedHeight() {
        return -1;
    }

    // ============================================================================================ frame

    @Override
    protected final void draw(Gfx g, int mx, int my, float delta) {
        long now = System.nanoTime();
        dt = lastFrame == 0 ? 0f : Math.min(0.1f, (now - lastFrame) / 1e9f);
        lastFrame = now;
        mouseX = mx;
        mouseY = my;
        this.delta = delta;
        hits.clear();
        clipTop = Integer.MIN_VALUE;
        clipBottom = Integer.MAX_VALUE;
        for (EditBox box : inputs.keySet()) box.visible = false;

        float open = anim("open", 1f, 10f);
        g.rect(0, 0, width, height, alpha(DIM_BG, open));

        int w = Math.min(cardWidth(), width - 20);
        int maxH = height - 20;
        int wanted = fixedHeight() > 0 ? fixedHeight() : headerHeight() + contentHeight + footerHeight();
        int h = Math.min(wanted, maxH);
        int x = (width - w) / 2;
        int y = (height - h) / 2 + Math.round((1f - open) * 8);

        g.rect(x + 3, y + 3, w, h, 0x50000000);
        g.rect(x, y, w, h, CARD);
        g.outline(x, y, w, h, CARD_LINE);

        drawHeader(g, x, y, w);

        int top = y + headerHeight();
        int bottom = y + h - footerHeight();
        int maxScroll = Math.max(0, contentHeight - (bottom - top));
        scroll = Math.max(0, Math.min(scroll, maxScroll));

        g.scissor(x + 1, top, x + w - 1, bottom);
        clipTop = top;
        clipBottom = bottom;
        int start = top - (int) Math.round(scroll);
        int end = drawBody(g, x + PAD, start, w - PAD * 2);
        contentHeight = end - start + 8;
        g.endScissor();
        clipTop = Integer.MIN_VALUE;
        clipBottom = Integer.MAX_VALUE;

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

    @Override
    public void onClose() {
        Compat.openScreen(parent);
    }

    // ============================================================================================ header pieces

    protected void title(Gfx g, String text, int x, int y) {
        g.text(Component.literal(text).withStyle(ChatFormatting.BOLD), x, y, TEXT);
    }

    /** Close button in the top right corner. Returns its left edge. */
    protected int closeButton(Gfx g, int x, int y, int w) {
        int cx = x + w - PAD - 9;
        int cy = y + 11;
        boolean hov = hover(cx - 3, cy - 3, 15, 15);
        if (hov) g.rect(cx - 3, cy - 3, 15, 15, SURFACE_HOVER);
        cross(g, cx, cy, 9, hov ? TEXT : MUTED);
        hit(cx - 3, cy - 3, 15, 15, this::onClose);
        return cx - 3;
    }

    /** "● Online" pill, right-aligned to {@code right}. */
    protected void statusPill(Gfx g, int right, int y) {
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
        int px = right - pw;
        g.rect(px, y, pw, 14, SURFACE);
        float pulse = st == HostSession.Status.CONNECTING || st == HostSession.Status.RECONNECTING
                ? 0.55f + 0.45f * (float) Math.sin(System.currentTimeMillis() / 180.0) : 1f;
        if (st == HostSession.Status.ONLINE) {
            float ring = (System.currentTimeMillis() % 1600) / 1600f;
            int r = 2 + Math.round(ring * 3);
            g.outline(px + 8 - r, y + 7 - r, r * 2, r * 2, alpha(color, (1f - ring) * 0.5f));
        }
        g.rect(px + 6, y + 5, 4, 4, alpha(color, pulse));
        g.text(label, px + 14, y + 3, st == HostSession.Status.OFF ? MUTED : TEXT);
    }

    // ============================================================================================ body pieces

    protected int section(Gfx g, String title, int x, int y) {
        g.text(title, x, y, MUTED);
        return y + 13;
    }

    /** Label + one muted line of explanation (from {@code key.desc} if it exists). Returns the row height. */
    protected int row(Gfx g, int x, int y, int w, String key) {
        g.text(g.clip(I18n.get(key), w - 110), x, y + 5, TEXT);
        String desc = key + ".desc";
        if (Language.getInstance().has(desc)) {
            g.text(g.clip(I18n.get(desc), w - 110), x, y + 16, DIM);
            return 30;
        }
        return 22;
    }

    /** A note in a box, e.g. empty lists. */
    protected int note(Gfx g, int x, int y, int w, String text, int color) {
        g.rect(x, y, w, 24, SURFACE);
        g.textCenter(g.clip(text, w - 16), x + w / 2, y + 8, color);
        return y + 24;
    }

    protected void toggle(Gfx g, String id, int right, int cy, boolean on, Runnable action) {
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

    /** Flat button. Returns its width. */
    protected int button(Gfx g, int x, int y, int w, int h, String label, Style style, Runnable action) {
        boolean enabled = style != Style.DISABLED;
        boolean hov = enabled && hover(x, y, w, h);
        int bg;
        int fg;
        switch (style) {
            case PRIMARY -> {
                bg = hov ? ACCENT_HOVER : ACCENT;
                fg = 0xFFFFFFFF;
            }
            case DANGER -> {
                bg = hov ? RED_BG : SURFACE;
                fg = hov ? RED : TEXT;
            }
            case DISABLED -> {
                bg = 0xFF1A1A1E;
                fg = DIM;
            }
            default -> {
                bg = hov ? SURFACE_2 : SURFACE;
                fg = TEXT;
            }
        }
        g.rect(x, y, w, h, bg);
        g.textCenter(g.clip(label, w - 6), x + w / 2, y + (h - 8) / 2, fg);
        if (enabled) hit(x, y, w, h, action);
        return w;
    }

    /** Button sized to its label, right-aligned to {@code right}. Returns its left edge. */
    protected int buttonRight(Gfx g, int right, int y, int h, String label, Style style, Runnable action) {
        int w = g.width(label) + 14;
        button(g, right - w, y, w, h, label, style, action);
        return right - w;
    }

    protected void stepper(Gfx g, int right, int cy, int value, int min, int max, java.util.function.IntConsumer set) {
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

    /** Text field registered with {@link #input(EditBox, Runnable)}, drawn as a flat box. */
    protected void inputBox(Gfx g, EditBox box, int x, int y, int w) {
        boolean focused = box.isFocused();
        g.rect(x, y, w, 16, focused ? SURFACE_2 : SURFACE);
        if (focused) g.outline(x, y, w, 16, ACCENT);
        box.setX(x + 6);
        box.setY(y + 4);
        box.setWidth(w - 10);
        boolean inView = y >= clipTop && y + 16 <= clipBottom;
        box.visible = inView;
        if (inView) g.widget(box, mouseX, mouseY, delta);
    }

    protected void avatar(Gfx g, UUID id, String name, int x, int y) {
        float hue = ((id == null ? name.hashCode() : id.hashCode()) & 0xFFFF) / 65535f;
        g.rect(x, y, 14, 14, hsv(hue, 0.45f, 0.75f));
        String initial = name.isEmpty() ? "?" : name.substring(0, 1).toUpperCase();
        g.textCenter(initial, x + 7, y + 3, 0xFFFFFFFF);
    }

    /** Small × that runs {@code action}. */
    protected void removeButton(Gfx g, int x, int y, Runnable action) {
        boolean h = hover(x, y, 16, 16);
        if (h) g.rect(x, y, 16, 16, RED_BG);
        cross(g, x + 4, y + 4, 8, h ? RED : DIM);
        hit(x, y, 16, 16, action);
    }

    protected static void cross(Gfx g, int x, int y, int size, int color) {
        for (int i = 0; i < size; i++) {
            g.rect(x + i, y + i, 1, 1, color);
            g.rect(x + size - 1 - i, y + i, 1, 1, color);
        }
    }

    protected static void arrow(Gfx g, int x, int y, boolean right, int color) {
        for (int i = 0; i < 3; i++) {
            int len = 1 + i * 2;
            int col = right ? x + 2 - i : x + i;
            g.rect(col, y + 3 - i, 1, len, color);
        }
    }

    protected static List<String> wrap(Gfx g, String text, int width) {
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

    protected static String dots() {
        return ".".repeat((int) (System.currentTimeMillis() / 400 % 4));
    }

    // ============================================================================================ input

    /** Registers a text field; {@code onEnter} runs when Enter is pressed while it is focused. */
    protected EditBox input(EditBox box, Runnable onEnter) {
        box.setBordered(false);
        box.setTextColor(TEXT);
        box.visible = false;
        inputs.put(box, onEnter);
        addWidget(box);
        return box;
    }

    protected void hit(int x, int y, int w, int h, Runnable action) {
        hit(x, y, w, h, 0, action);
    }

    protected void hit(int x, int y, int w, int h, int button, Runnable action) {
        int y1 = Math.max(y, clipTop);
        int y2 = Math.min(y + h, clipBottom);
        if (y2 <= y1) return;
        hits.add(new Hit(x, y1, w, y2 - y1, button, action));
    }

    protected boolean hover(int x, int y, int w, int h) {
        if (mouseY < clipTop || mouseY >= clipBottom) return false;
        return mouseX >= x && mouseX < x + w && mouseY >= y && mouseY < y + h;
    }

    @Override
    protected boolean click(double x, double y, int button) {
        for (EditBox box : inputs.keySet()) {
            if (box.visible && x >= box.getX() - 6 && x < box.getX() + box.getWidth() + 4
                    && y >= box.getY() - 4 && y < box.getY() + 12) {
                return false; // the text field handles it
            }
        }
        for (EditBox box : inputs.keySet()) box.setFocused(false);
        setFocused(null);
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
    protected boolean key(int keyCode) {
        if (keyCode == 257 || keyCode == 335) { // Enter, keypad Enter
            for (Map.Entry<EditBox, Runnable> e : inputs.entrySet()) {
                if (e.getKey().isFocused() && e.getKey().visible && e.getValue() != null) {
                    e.getValue().run();
                    return true;
                }
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

    protected float anim(String key, float target, float speed) {
        float cur = anim.getOrDefault(key, key.equals("open") ? 0f : target);
        float next = cur + (target - cur) * (1f - (float) Math.exp(-dt * speed));
        if (Math.abs(next - target) < 0.002f) next = target;
        anim.put(key, next);
        return next;
    }

    protected static int hsv(float h, float s, float v) {
        float c = v * s;
        float hp = (h * 6f) % 6f;
        float x = c * (1 - Math.abs(hp % 2 - 1));
        float r = 0, g = 0, b = 0;
        if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; } else if (hp < 3) { g = c; b = x; }
        else if (hp < 4) { g = x; b = c; } else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
        float m = v - c;
        return 0xFF000000 | (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
    }

    public static int alpha(int color, float a) {
        int base = color >>> 24;
        int na = Math.max(0, Math.min(255, Math.round(base * a)));
        return (na << 24) | (color & 0xFFFFFF);
    }

    public static int mix(int a, int b, float t) {
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
