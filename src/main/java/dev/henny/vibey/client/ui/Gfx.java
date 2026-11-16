package dev.henny.vibey.client.ui;

import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.network.chat.Component;
//? if >=26.1 {
/*import net.minecraft.client.gui.GuiGraphicsExtractor;
*///?} else
import net.minecraft.client.gui.GuiGraphics;

/** Thin drawing layer over GuiGraphics (1.21) / GuiGraphicsExtractor (26). Colors are always ARGB. */
public final class Gfx {
    //? if >=26.1 {
    /*public final GuiGraphicsExtractor g;
    *///?} else
    public final GuiGraphics g;
    public final Font font;

    //? if >=26.1 {
    /*public Gfx(GuiGraphicsExtractor g, Font font) {
    *///?} else
    public Gfx(GuiGraphics g, Font font) {
        this.g = g;
        this.font = font;
    }

    public void fill(int x1, int y1, int x2, int y2, int color) {
        if (x2 <= x1 || y2 <= y1 || (color >>> 24) == 0) return;
        g.fill(x1, y1, x2, y2, color);
    }

    public void rect(int x, int y, int w, int h, int color) {
        fill(x, y, x + w, y + h, color);
    }

    /** Filled rectangle with rounded corners, drawn row by row so it stays crisp at every GUI scale. */
    public void round(int x, int y, int w, int h, int r, int color) {
        r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
        if (r == 0) {
            rect(x, y, w, h, color);
            return;
        }
        fill(x, y + r, x + w, y + h - r, color);
        for (int i = 0; i < r; i++) {
            int inset = inset(r, i);
            fill(x + inset, y + i, x + w - inset, y + i + 1, color);
            fill(x + inset, y + h - 1 - i, x + w - inset, y + h - i, color);
        }
    }

    /** Rounded outline of 1px. */
    public void roundOutline(int x, int y, int w, int h, int r, int color) {
        r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
        int top = r == 0 ? 0 : inset(r, 0);
        fill(x + top, y, x + w - top, y + 1, color);
        fill(x + top, y + h - 1, x + w - top, y + h, color);
        fill(x, y + Math.max(r, 1), x + 1, y + h - Math.max(r, 1), color);
        fill(x + w - 1, y + Math.max(r, 1), x + w, y + h - Math.max(r, 1), color);
        for (int i = 1; i < r; i++) {
            int in = inset(r, i);
            int end = Math.max(in + 1, inset(r, i - 1));
            fill(x + in, y + i, x + end, y + i + 1, color);
            fill(x + w - end, y + i, x + w - in, y + i + 1, color);
            fill(x + in, y + h - 1 - i, x + end, y + h - i, color);
            fill(x + w - end, y + h - 1 - i, x + w - in, y + h - i, color);
        }
    }

    private static int inset(int r, int row) {
        double dy = r - row - 0.5;
        return (int) Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
    }

    public void circle(int cx, int cy, int r, int color) {
        round(cx - r, cy - r, r * 2, r * 2, r, color);
    }

    public void text(String s, int x, int y, int color) {
        //? if >=26.1 {
        /*g.text(font, s, x, y, color, false);
        *///?} else
        g.drawString(font, s, x, y, color, false);
    }

    public void text(Component c, int x, int y, int color) {
        //? if >=26.1 {
        /*g.text(font, c, x, y, color, false);
        *///?} else
        g.drawString(font, c, x, y, color, false);
    }

    public void textRight(String s, int right, int y, int color) {
        text(s, right - font.width(s), y, color);
    }

    public void textCenter(String s, int cx, int y, int color) {
        text(s, cx - font.width(s) / 2, y, color);
    }

    public int width(String s) {
        return font.width(s);
    }

    public String clip(String s, int maxWidth) {
        if (font.width(s) <= maxWidth) return s;
        return font.plainSubstrByWidth(s, Math.max(0, maxWidth - font.width("…"))) + "…";
    }

    public void scissor(int x1, int y1, int x2, int y2) {
        g.enableScissor(x1, y1, x2, y2);
    }

    public void endScissor() {
        g.disableScissor();
    }

    public void widget(AbstractWidget w, int mouseX, int mouseY, float delta) {
        //? if >=26.1 {
        /*w.extractRenderState(g, mouseX, mouseY, delta);
        *///?} else
        w.render(g, mouseX, mouseY, delta);
    }
}
