import type { Msg } from "./lines.ts";

export type Reason = "banned" | "whitelist";

export type Access = {
  whitelist: Set<string> | null;
  banNames: Set<string>;
  banIps: Set<string>;
  messages: Record<Reason, string>;
};

const LIMIT = 1000;

export function openAccess(): Access {
  return {
    whitelist: null,
    banNames: new Set(),
    banIps: new Set(),
    messages: { banned: "You are banned from this world.", whitelist: "You are not on the whitelist of this world." },
  };
}

export function parseAccess(msg: Msg): Access {
  const a = openAccess();
  a.whitelist = msg.whitelist == null ? null : new Set(names(msg.whitelist));
  a.banNames = new Set(names(msg.banNames));
  a.banIps = new Set(ips(msg.banIps));
  const m = msg.messages;
  if (m && typeof m === "object") {
    for (const r of ["banned", "whitelist"] as const) if (typeof m[r] === "string") a.messages[r] = m[r].slice(0, 256);
  }
  return a;
}

/** Name checks only apply to joins; IP bans also hide the world from the server list. */
export function blockReason(a: Access, ip: string, name: string | null): Reason | null {
  if (a.banIps.has(ip)) return "banned";
  if (name == null) return null;
  const n = name.toLowerCase();
  if (a.banNames.has(n)) return "banned";
  if (a.whitelist && !a.whitelist.has(n)) return "whitelist";
  return null;
}

function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z0-9_]{1,16}$/.test(x)).slice(0, LIMIT);
}

function ips(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => normalizeIp(String(x))).filter((x) => /^[0-9a-f.:]{3,45}$/i.test(x)).slice(0, LIMIT);
}

export function normalizeIp(ip: string): string {
  return ip.trim().replace(/^::ffff:/, "");
}
