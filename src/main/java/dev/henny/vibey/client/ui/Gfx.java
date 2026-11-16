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

    /** 1px frame. */
    public void outline(int x, int y, int w, int h, int color) {
        fill(x, y, x + w, y + 1, color);
        fill(x, y + h - 1, x + w, y + h, color);
        fill(x, y + 1, x + 1, y + h - 1, color);
        fill(x + w - 1, y + 1, x + w, y + h - 1, color);
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
