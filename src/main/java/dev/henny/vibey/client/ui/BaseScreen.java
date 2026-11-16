package dev.henny.vibey.client.ui;

import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
//? if >=26.1 {
/*import net.minecraft.client.gui.GuiGraphicsExtractor;
*///?} else
import net.minecraft.client.gui.GuiGraphics;
//? if >=1.21.9 {
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
//?}

/**
 * Version glue for screens: subclasses implement {@link #draw}, {@link #click} and {@link #scroll} and never touch the
 * per-version render/input signatures.
 */
public abstract class BaseScreen extends Screen {
    protected BaseScreen(Component title) {
        super(title);
    }

    protected abstract void draw(Gfx gfx, int mouseX, int mouseY, float delta);

    /** @return true if the click was used */
    protected abstract boolean click(double x, double y, int button);

    protected abstract boolean scroll(double x, double y, double amount);

    /** @return true if the key was used (called before the focused text field sees it) */
    protected boolean key(int keyCode) {
        return false;
    }

    //? if >=26.1 {
    /*@Override
    public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float delta) {
        draw(new Gfx(g, this.font), mouseX, mouseY, delta);
    }

    @Override
    public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float delta) {
    }
    *///?} else {
    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float delta) {
        draw(new Gfx(g, this.font), mouseX, mouseY, delta);
    }

    @Override
    public void renderBackground(GuiGraphics g, int mouseX, int mouseY, float delta) {
    }
    //?}

    //? if >=1.21.9 {
    @Override
    public boolean mouseClicked(MouseButtonEvent event, boolean doubleClick) {
        if (click(event.x(), event.y(), event.button())) return true;
        return super.mouseClicked(event, doubleClick);
    }
    //?} else {
    /*@Override
    public boolean mouseClicked(double x, double y, int button) {
        if (click(x, y, button)) return true;
        return super.mouseClicked(x, y, button);
    }
    *///?}

    //? if >=1.21.9 {
    @Override
    public boolean keyPressed(KeyEvent event) {
        if (key(event.key())) return true;
        return super.keyPressed(event);
    }
    //?} else {
    /*@Override
    public boolean keyPressed(int keyCode, int scanCode, int modifiers) {
        if (key(keyCode)) return true;
        return super.keyPressed(keyCode, scanCode, modifiers);
    }
    *///?}

    @Override
    public boolean mouseScrolled(double x, double y, double h, double v) {
        if (scroll(x, y, v)) return true;
        return super.mouseScrolled(x, y, h, v);
    }
}
