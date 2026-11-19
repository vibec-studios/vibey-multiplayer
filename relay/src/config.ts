const env = process.env;

export const PORT = Number(env.PORT ?? 25565);
// axolite.cc, vibey.henny.dev and vibe.axolite.app / vibe.henny.dev are the official Vibe services: for official builds
// only, see SERVICES.md (https://github.com/vibec-studios/.github/blob/main/SERVICES.md). A relay of your own needs its
// own DOMAINS.
/** The id the official relay has had since 1.0 (it was its DOMAIN). The backend knows the relay by it. */
export const LEGACY_RELAY_ID = "vibey.henny.dev";
/**
 * Wildcard domains of the addresses. `DOMAINS` is a comma-separated list, the first one is the primary: new addresses
 * are handed out (and reported to hosts, backend and logs) under it, the others are still accepted in the handshake.
 * `DOMAIN` (a single domain) is the fallback when `DOMAINS` is not set.
 */
export const DOMAINS = parseDomains(env.DOMAINS) ?? parseDomains(env.DOMAIN) ?? [LEGACY_RELAY_ID];
/** The primary domain. */
export const DOMAIN = DOMAINS[0];
export const PUBLIC_PORT = Number(env.PUBLIC_PORT ?? PORT);
export const DATA_DIR = env.DATA_DIR ?? "data";
export const HTTP_PORT = env.HTTP_PORT ? Number(env.HTTP_PORT) : 0;
export const MAX_STREAMS = Number(env.MAX_STREAMS ?? 64);
export const ALLOW_OFFLINE = env.ALLOW_OFFLINE === "1";
export const SESSION_SERVER = env.SESSION_SERVER ?? "https://sessionserver.mojang.com";
/** Hosts (slots) one account may run at the same time when no backend says otherwise. */
export const MAX_HOSTS_PER_ACCOUNT = intEnv("MAX_HOSTS_PER_ACCOUNT", 2);
/** Players per host when no backend says otherwise, 0 = no limit. */
export const MAX_PLAYERS_PER_HOST = intEnv("MAX_PLAYERS_PER_HOST", 0);
export const MAX_SLOT = 63;

/** Optional Vibe Backend: authorizes hosts, receives events, sends commands. The official one (vibe.axolite.app) serves
 *  official builds only, see SERVICES.md; point a relay of your own at a backend you run yourself. */
export const BACKEND_URL = (env.BACKEND_URL ?? "").replace(/\/+$/, "");
export const BACKEND_SECRET = env.BACKEND_SECRET ?? "";
export const BACKEND_FAIL_MODE: "open" | "closed" = env.BACKEND_FAIL_MODE === "closed" ? "closed" : "open";
/**
 * Sent as `X-Relay-Id` so one backend can tell several relay workers apart. It must not change when the primary domain
 * does: before relay 1.4 it defaulted to DOMAIN, which was `vibey.henny.dev` for the official relay. So without an
 * explicit RELAY_ID it is `vibey.henny.dev` whenever that domain is still configured (also when `axolite.cc` is the
 * primary), otherwise the primary domain as before. Set RELAY_ID explicitly when you change a relay's primary domain.
 */
export const RELAY_ID = env.RELAY_ID?.trim() || (DOMAINS.includes(LEGACY_RELAY_ID) ? LEGACY_RELAY_ID : DOMAIN);
export const BACKEND_TIMEOUT_MS = intEnv("BACKEND_TIMEOUT_MS", 5_000);
export const BACKEND_EVENTS_MS = intEnv("BACKEND_EVENTS_MS", 2_000);
export const BACKEND_COMMANDS_MS = intEnv("BACKEND_COMMANDS_MS", 5_000);
export const BACKEND_HEARTBEAT_MS = intEnv("BACKEND_HEARTBEAT_MS", 30_000);
export const BACKEND_EVENT_BUFFER = intEnv("BACKEND_EVENT_BUFFER", 10_000);

export const VERSION = "1.4.0";
export const PROTOCOL = 1;
export const MAGIC = Buffer.from([0x00, 0x56, 0x42, 0x59]);

export const FIRST_BYTES_TIMEOUT_MS = 8_000;
export const AUTH_TIMEOUT_MS = 20_000;
export const DATA_CONNECT_TIMEOUT_MS = 10_000;
export const CONTROL_IDLE_MS = 75_000;
export const MAX_LINE = 8 * 1024;
export const MAX_PLAYER_PREFIX = 4 * 1024;
export const ROTATIONS_PER_HOUR = 6;

/** `" Axolite.cc., vibey.henny.dev "` → `["axolite.cc", "vibey.henny.dev"]`; null when nothing is left. */
export function parseDomains(v: string | undefined): string[] | null {
  const list = (v ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean);
  const unique = [...new Set(list)];
  return unique.length ? unique : null;
}

function intEnv(key: string, fallback: number): number {
  const v = env[key];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}
