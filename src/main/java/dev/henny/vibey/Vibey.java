package dev.henny.vibey;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Shared entry point. Each loader sets {@link #platform} and forwards its events to the common code. */
public final class Vibey {
    public static final String MOD_ID = "vibey";
    public static final Logger LOG = LoggerFactory.getLogger("Vibey");

    public static Platform platform;

    private Vibey() {}

    public static void init(Platform p) {
        platform = p;
        dev.henny.vibey.host.HostConfig.load();
        LOG.info("Vibey Multiplayer {} on {}", BuildInfo.VERSION, p.loader());
    }
}
