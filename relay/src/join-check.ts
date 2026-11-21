import { HttpError, call, enabled, healthy, trouble } from "./backend.ts";
import { log } from "./config.ts";
import type { Host } from "./hosts.ts";
import type { Login } from "./wire.ts";

export type JoinVerdict =
  | { allow: true; role: string | null; fallback: boolean }
  | { allow: false; code: string; message: string };

const OFF_AFTER_404_MS = 600_000;
const DENIED = "You may not join this world.";
const FALLBACK: JoinVerdict = { allow: true, role: null, fallback: true };

let offUntil = 0;

export function joinChecks(): boolean {
  return enabled && Date.now() >= offUntil;
}

export async function joinCheck(h: Host, login: Login, ip: string): Promise<JoinVerdict> {
  let body: any;
  try {
    body = await call("POST", "/join-check", {
      uuid: h.uuid, slot: h.slot, player: { name: login.name, uuid: login.uuid || null }, ip,
    });
    healthy("join-check");
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 405)) {
      offUntil = Date.now() + OFF_AFTER_404_MS;
      log("backend: no join-check (older backend), joins are not checked for 10 minutes");
    } else {
      trouble("join-check", e);
    }
    return FALLBACK;
  }
  return parseVerdict(body);
}

function parseVerdict(b: any): JoinVerdict {
  if (b?.allow === false) {
    const code = typeof b.code === "string" && /^[a-z_]{1,32}$/.test(b.code) ? b.code : "denied";
    const message = typeof b.message === "string" && b.message ? b.message.slice(0, 256) : DENIED;
    return { allow: false, code, message };
  }
  if (b?.allow === true) {
    const role = typeof b.role === "string" && /^[a-z_]{1,16}$/.test(b.role) ? b.role : null;
    return { allow: true, role, fallback: false };
  }
  return FALLBACK;
}
