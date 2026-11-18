const env = process.env;

export const PORT = Number(env.PORT ?? 25565);
// vibey.henny.dev and vibe.henny.dev are the official Vibe services: for official builds only, see SERVICES.md
// (https://github.com/vibec-studios/.github/blob/main/SERVICES.md). A relay of your own needs its own DOMAIN.
export const DOMAIN = (env.DOMAIN ?? "vibey.henny.dev").toLowerCase().replace(/^\.+|\.+$/g, "");
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

/** Optional Vibe Backend: authorizes hosts, receives events, sends commands. The official one (vibe.henny.dev) serves
 *  official builds only, see SERVICES.md; point a relay of your own at a backend you run yourself. */
export const BACKEND_URL = (env.BACKEND_URL ?? "").replace(/\/+$/, "");
export const BACKEND_SECRET = env.BACKEND_SECRET ?? "";
export const BACKEND_FAIL_MODE: "open" | "closed" = env.BACKEND_FAIL_MODE === "closed" ? "closed" : "open";
/** Sent as `X-Relay-Id` so one backend can tell several relay workers apart. */
export const RELAY_ID = env.RELAY_ID || DOMAIN;
export const BACKEND_TIMEOUT_MS = intEnv("BACKEND_TIMEOUT_MS", 5_000);
export const BACKEND_EVENTS_MS = intEnv("BACKEND_EVENTS_MS", 2_000);
export const BACKEND_COMMANDS_MS = intEnv("BACKEND_COMMANDS_MS", 5_000);
export const BACKEND_HEARTBEAT_MS = intEnv("BACKEND_HEARTBEAT_MS", 30_000);
export const BACKEND_EVENT_BUFFER = intEnv("BACKEND_EVENT_BUFFER", 10_000);

export const VERSION = "1.3.0";
export const PROTOCOL = 1;
export const MAGIC = Buffer.from([0x00, 0x56, 0x42, 0x59]);

export const FIRST_BYTES_TIMEOUT_MS = 8_000;
export const AUTH_TIMEOUT_MS = 20_000;
export const DATA_CONNECT_TIMEOUT_MS = 10_000;
export const CONTROL_IDLE_MS = 75_000;
export const MAX_LINE = 8 * 1024;
export const MAX_PLAYER_PREFIX = 4 * 1024;
export const ROTATIONS_PER_HOUR = 6;

function intEnv(key: string, fallback: number): number {
  const v = env[key];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}
