const env = process.env;

export const PORT = Number(env.PORT ?? 25565);
export const DOMAIN = (env.DOMAIN ?? "vibey.henny.dev").toLowerCase().replace(/^\.+|\.+$/g, "");
export const PUBLIC_PORT = Number(env.PUBLIC_PORT ?? PORT);
export const DATA_DIR = env.DATA_DIR ?? "data";
export const HTTP_PORT = env.HTTP_PORT ? Number(env.HTTP_PORT) : 0;
export const MAX_STREAMS = Number(env.MAX_STREAMS ?? 64);
export const ALLOW_OFFLINE = env.ALLOW_OFFLINE === "1";
export const SESSION_SERVER = env.SESSION_SERVER ?? "https://sessionserver.mojang.com";

export const VERSION = "1.2.0";
export const PROTOCOL = 1;
export const MAGIC = Buffer.from([0x00, 0x56, 0x42, 0x59]);

export const FIRST_BYTES_TIMEOUT_MS = 8_000;
export const AUTH_TIMEOUT_MS = 20_000;
export const DATA_CONNECT_TIMEOUT_MS = 10_000;
export const CONTROL_IDLE_MS = 75_000;
export const MAX_LINE = 8 * 1024;
export const MAX_PLAYER_PREFIX = 4 * 1024;
export const ROTATIONS_PER_HOUR = 6;

export function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}
