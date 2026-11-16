package dev.henny.vibey.client;

import dev.henny.vibey.BuildInfo;
import dev.henny.vibey.client.ui.CardScreen;
import dev.henny.vibey.client.ui.Gfx;
import dev.henny.vibey.host.Access;
import dev.henny.vibey.host.Guests;
import dev.henny.vibey.host.HostConfig;
import dev.henny.vibey.host.HostSession;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.resources.language.I18n;
import net.minecraft.network.chat.Component;
import net.minecraft.world.level.GameType;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * "Manage": players (OP, kick, ban), access (whitelist and ban list, both enforced by the relay on network level),
 * world settings and advanced options, each on its own tab.
 */
public final class AdminScreen extends CardScreen {
    private enum Tab { PLAYERS, ACCESS, WORLD, ADVANCED }

    private static final GameType[] MODES = {GameType.SURVIVAL, GameType.CREATIVE, GameType.ADVENTURE, GameType.SPECTATOR};
    private static Tab lastTab = Tab.PLAYERS;

    private Tab tab = lastTab;
    private EditBox whitelistInput;
    private EditBox banInput;
    private EditBox relayInput;
    private String inputError = "";
    private long inputErrorAt;
    private long rotateArmedAt;

    public AdminScreen(Screen parent) {
        super(Component.translatable("vibey.admin.title"), parent);
    }

    @Override
    protected void init() {
        HostConfig cfg = HostConfig.get();
        whitelistInput = input(new EditBox(font, 0, 0, 100, 12, Component.translatable("vibey.access.name")), this::addWhitelist);
        whitelistInput.setMaxLength(16);
        whitelistInput.setHint(Component.translatable("vibey.access.name"));
        banInput = input(new EditBox(font, 0, 0, 100, 12, Component.translatable("vibey.access.ban.hint")), this::addBan);
        banInput.setMaxLength(45);
        banInput.setHint(Component.translatable("vibey.access.ban.hint"));
        relayInput = input(new EditBox(font, 0, 0, 100, 12, Component.translatable("vibey.adv.relay")), null);
        relayInput.setMaxLength(253);
        relayInput.setValue(cfg.relay);
        relayInput.setResponder(v -> cfg.relay = v.trim());
    }

    @Override
    public void removed() {
        HostConfig.save();
    }

    @Override
    protected int cardWidth() {
        return 360;
    }

    @Override
    protected int fixedHeight() {
        return 300;
    }

    @Override
    protected int headerHeight() {
        return 58;
    }

    @Override
    protected int footerHeight() {
        return 10;
    }

    // ============================================================================================ header

    @Override
    protected void drawHeader(Gfx g, int x, int y, int w) {
        // Back
        int bx = x + PAD - 4;
        boolean bh = hover(bx, y + 8, 16, 16);
        if (bh) g.rect(bx, y + 8, 16, 16, SURFACE_HOVER);
        arrow(g, bx + 6, y + 12, false, bh ? TEXT : MUTED);
        hit(bx, y + 8, 16, 16, this::onClose);

        title(g, I18n.get("vibey.admin.title"), x + PAD + 16, y + 13);
        int closeLeft = closeButton(g, x, y, w);
        statusPill(g, closeLeft - 6, y + 10);

        // Tabs
        int tx = x + PAD;
        int ty = y + 34;
        for (Tab t : Tab.values()) {
            String label = I18n.get("vibey.tab." + t.name().toLowerCase(java.util.Locale.ROOT));
            if (t == Tab.PLAYERS && HostSession.isHosting()) label += " " + Math.max(0, Guests.snapshot().size() - 1);
            int tw = g.width(label) + 16;
            boolean active = t == tab;
            boolean hov = hover(tx, ty, tw, 18);
            if (active) g.rect(tx, ty, tw, 18, SURFACE_2);
            else if (hov) g.rect(tx, ty, tw, 18, SURFACE);
            g.textCenter(label, tx + tw / 2, ty + 5, active ? TEXT : hov ? TEXT : MUTED);
            if (active) g.rect(tx, ty + 17, tw, 1, ACCENT);
            Tab target = t;
            hit(tx, ty, tw, 18, () -> {
                tab = target;
                lastTab = target;
                scroll = 0;
            });
            tx += tw + 2;
        }
        g.rect(x + 1, y + headerHeight() - 5, w - 2, 1, CARD_LINE);
    }

    @Override
    protected int drawBody(Gfx g, int x, int y, int w) {
        y += 4;
        return switch (tab) {
            case PLAYERS -> drawPlayers(g, x, y, w);
            case ACCESS -> drawAccess(g, x, y, w);
            case WORLD -> drawWorld(g, x, y, w);
            case ADVANCED -> drawAdvanced(g, x, y, w);
        };
    }

    @Override
    protected void drawFooter(Gfx g, int x, int y, int w) {
    }

    // ============================================================================================ players

    private int drawPlayers(Gfx g, int x, int y, int w) {
        if (!HostSession.isHosting()) {
            y = note(g, x, y, w, I18n.get("vibey.players.offline"), DIM);
        } else {
            List<Guests.View> guests = Guests.snapshot().stream().filter(p -> !p.host()).toList();
            if (guests.isEmpty()) y = note(g, x, y, w, I18n.get("vibey.players.empty"), DIM);
            for (Guests.View p : guests) {
                int h = 24;
                boolean hov = hover(x, y, w, h);
                g.rect(x, y, w, h, hov ? SURFACE_HOVER : SURFACE);
                avatar(g, p.id(), p.name(), x + 6, y + 5);
                UUID id = p.id();
                String name = p.name();

                int right = x + w - 4;
                right = buttonRight(g, right, y + 4, 16, I18n.get("vibey.players.ban"), Style.DANGER,
                        () -> Guests.ban(id, name)) - 3;
                right = buttonRight(g, right, y + 4, 16, I18n.get("vibey.players.kick"), Style.SECONDARY,
                        () -> Guests.kick(id)) - 3;
                boolean op = p.op();
                right = buttonRight(g, right, y + 4, 16, I18n.get("vibey.players.op"), op ? Style.PRIMARY : Style.SECONDARY,
                        () -> Guests.setOp(id, !op)) - 6;
                g.text(g.clip(name, right - x - 26), x + 26, y + 8, TEXT);
                y += h + 3;
            }
            y -= 3;
        }

        List<Access.Blocked> blocked = Access.recentlyBlocked();
        if (!blocked.isEmpty()) {
            y += 12;
            y = section(g, I18n.get("vibey.blocked.title"), x, y);
            for (Access.Blocked b : blocked) {
                g.rect(x, y, w, 22, SURFACE);
                avatar(g, null, b.name(), x + 5, y + 4);
                String reason = I18n.get("whitelist".equals(b.reason()) ? "vibey.blocked.whitelist" : "vibey.blocked.banned");
                int right = buttonRight(g, x + w - 4, y + 3, 16, I18n.get("vibey.blocked.allow"), Style.SECONDARY, () -> {
                    if ("whitelist".equals(b.reason())) Access.whitelistAdd(b.name());
                    else Access.unbanName(b.name());
                });
                String line = b.name() + "  ·  " + reason;
                g.text(g.clip(line, right - x - 30), x + 25, y + 7, MUTED);
                y += 25;
            }
            y -= 3;
        }
        return y;
    }

    // ============================================================================================ access

    private int drawAccess(Gfx g, int x, int y, int w) {
        HostConfig cfg = HostConfig.get();

        // Whitelist
        int rowH = row(g, x, y, w, "vibey.access.whitelist");
        toggle(g, "whitelist", x + w, y + rowH / 2, cfg.whitelistEnabled, () -> Access.setWhitelistEnabled(!cfg.whitelistEnabled));
        y += rowH + 2;
        int addLeft = buttonRight(g, x + w, y, 16, I18n.get("vibey.access.add"), Style.SECONDARY, this::addWhitelist);
        inputBox(g, whitelistInput, x, y, addLeft - x - 4);
        y += 20;
        if (cfg.whitelistEnabled && cfg.whitelist.isEmpty()) {
            g.text(g.clip(I18n.get("vibey.access.whitelist.warn"), w), x, y + 2, AMBER);
            y += 13;
        }
        for (String name : cfg.whitelist) {
            g.rect(x, y, w, 20, SURFACE);
            avatar(g, null, name, x + 4, y + 3);
            g.text(g.clip(name, w - 50), x + 23, y + 6, TEXT);
            removeButton(g, x + w - 18, y + 2, () -> Access.whitelistRemove(name));
            y += 22;
        }
        if (cfg.whitelist.isEmpty() && !cfg.whitelistEnabled) {
            g.text(g.clip(I18n.get("vibey.access.whitelist.empty"), w), x, y + 2, DIM);
            y += 13;
        }

        // Ban list
        y += 12;
        rowH = row(g, x, y, w, "vibey.access.bans");
        y += rowH + 2;
        int banLeft = buttonRight(g, x + w, y, 16, I18n.get("vibey.access.ban"), Style.DANGER, this::addBan);
        inputBox(g, banInput, x, y, banLeft - x - 4);
        y += 20;
        if (!inputError.isEmpty() && System.currentTimeMillis() - inputErrorAt < 2500) {
            g.text(g.clip(inputError, w), x, y + 2, RED);
            y += 13;
        }
        boolean any = false;
        for (String name : cfg.bannedNames) {
            any = true;
            g.rect(x, y, w, 20, SURFACE);
            avatar(g, null, name, x + 4, y + 3);
            String ip = cfg.bannedIps.entrySet().stream().filter(e -> e.getValue().equalsIgnoreCase(name))
                    .map(Map.Entry::getKey).findFirst().orElse("");
            g.text(g.clip(name, w - 50), x + 23, y + 6, TEXT);
            if (!ip.isEmpty()) g.textRight(I18n.get("vibey.access.ip_too"), x + w - 24, y + 6, DIM);
            removeButton(g, x + w - 18, y + 2, () -> Access.unbanName(name));
            y += 22;
        }
        for (Map.Entry<String, String> e : cfg.bannedIps.entrySet()) {
            if (!e.getValue().isEmpty() && cfg.bannedNames.stream().anyMatch(n -> n.equalsIgnoreCase(e.getValue()))) continue;
            any = true;
            String ip = e.getKey();
            g.rect(x, y, w, 20, SURFACE);
            g.text("IP", x + 6, y + 6, DIM);
            String label = e.getValue().isEmpty() ? ip : ip + "  (" + e.getValue() + ")";
            g.text(g.clip(label, w - 50), x + 23, y + 6, TEXT);
            removeButton(g, x + w - 18, y + 2, () -> Access.unbanIp(ip));
            y += 22;
        }
        if (!any) {
            g.text(g.clip(I18n.get("vibey.access.bans.empty"), w), x, y + 2, DIM);
            y += 13;
        }
        return y;
    }

    private void addWhitelist() {
        String v = whitelistInput.getValue().trim();
        if (v.isEmpty()) return;
        if (Access.whitelistAdd(v)) whitelistInput.setValue("");
        else error(I18n.get("vibey.access.invalid_name"));
    }

    private void addBan() {
        String v = banInput.getValue().trim();
        if (v.isEmpty()) return;
        if (Access.ban(v)) {
            banInput.setValue("");
            // Kick right away if they are online.
            for (Guests.View p : Guests.snapshot()) {
                if (!p.host() && p.name().equalsIgnoreCase(v)) Guests.ban(p.id(), p.name());
            }
        } else {
            error(I18n.get("vibey.access.invalid"));
        }
    }

    private void error(String text) {
        inputError = text;
        inputErrorAt = System.currentTimeMillis();
    }

    // ============================================================================================ world

    private int drawWorld(Gfx g, int x, int y, int w) {
        HostConfig cfg = HostConfig.get();
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

        rowH = row(g, x, y, w, "vibey.adv.pvp");
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

        rowH = row(g, x, y, w, "vibey.forcemods");
        toggle(g, "forcemods", x + w, y + rowH / 2, cfg.forceMods, () -> {
            cfg.forceMods = !cfg.forceMods;
            HostConfig.save();
        });
        y += rowH;
        return y;
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
    }

    private void setMode(GameType mode) {
        HostConfig.get().gameMode = mode.getName();
        HostConfig.save();
        HostSession.applyGameMode();
    }

    // ============================================================================================ advanced

    private int drawAdvanced(Gfx g, int x, int y, int w) {
        HostConfig cfg = HostConfig.get();
        int rowH = row(g, x, y, w, "vibey.adv.exact");
        toggle(g, "exact", x + w, y + rowH / 2, cfg.exactModVersions, () -> {
            cfg.exactModVersions = !cfg.exactModVersions;
            HostConfig.save();
        });
        y += rowH;

        rowH = row(g, x, y, w, "vibey.adv.rotate");
        boolean armed = System.currentTimeMillis() - rotateArmedAt < 3000;
        boolean canRotate = HostSession.status() == HostSession.Status.ONLINE;
        String rl = I18n.get(armed ? "vibey.adv.rotate.confirm" : "vibey.adv.rotate.button");
        Style style = !canRotate ? Style.DISABLED : armed ? Style.DANGER : Style.SECONDARY;
        buttonRight(g, x + w, y + rowH / 2 - 8, 16, rl, style, () -> {
            if (System.currentTimeMillis() - rotateArmedAt < 3000) {
                rotateArmedAt = 0;
                HostSession.rotate();
            } else {
                rotateArmedAt = System.currentTimeMillis();
            }
        });
        y += rowH;

        rowH = row(g, x, y, w, "vibey.adv.relay");
        int bw = Math.min(160, w / 2);
        inputBox(g, relayInput, x + w - bw, y + rowH / 2 - 8, bw);
        y += rowH;

        String info = I18n.get("vibey.adv.info",
                HostSession.lanPort() > 0 ? String.valueOf(HostSession.lanPort()) : "–", BuildInfo.VERSION);
        g.text(g.clip(info, w), x, y + 4, DIM);
        return y + 14;
    }
}
