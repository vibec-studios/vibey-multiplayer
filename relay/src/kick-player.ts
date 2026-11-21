import { KICK_GRACE_MS, log } from "./config.ts";
import { type Host, hosts, pendingOf, refusePending } from "./hosts.ts";
import { send } from "./lines.ts";
import { normUuid } from "./mojang.ts";
import type { Login } from "./wire.ts";

const DEFAULT_MESSAGE = "You were removed from this world by the host.";
const REMEMBERED = 200;

type Target = { uuid: string; name: string };

export function kickPlayer(hostUuid: string, slot: number, player: unknown, message: string | undefined) {
  const target = parseTarget(player);
  if (!target || !Number.isInteger(slot)) return;
  const msg = message ?? DEFAULT_MESSAGE;
  for (const h of [...hosts()]) {
    if (h.uuid !== hostUuid || h.slot !== slot) continue;
    remember(h, target, msg);
    send(h.sock, { t: "kick", name: target.name || null, uuid: target.uuid || null, msg });
    for (const p of pendingOf(h, (l) => matches(target, l))) refusePending(p, { title: msg, sub: "" });
    let cut = 0;
    for (const [sock, p] of h.players) {
      if (!matches(target, p)) continue;
      cut++;
      setTimeout(() => sock.destroy(), KICK_GRACE_MS).unref();
    }
    log(`player ${target.name || target.uuid} kicked from ${h.name}#${h.slot} (${cut} connection(s))`);
  }
}

export function kickedMessage(h: Host, login: Login): string | null {
  const k = h.kicked;
  if (!k) return null;
  const uuid = normUuid(login.uuid);
  return (uuid.length === 32 ? k.get("u:" + uuid) : undefined) ?? k.get("n:" + login.name.toLowerCase()) ?? null;
}

function remember(h: Host, t: Target, msg: string) {
  const k = (h.kicked ??= new Map());
  if (t.uuid) k.set("u:" + t.uuid, msg);
  if (t.name) k.set("n:" + t.name.toLowerCase(), msg);
  while (k.size > REMEMBERED) k.delete(k.keys().next().value!);
}

function matches(t: Target, p: { name: string; uuid: string }): boolean {
  if (t.uuid && normUuid(p.uuid) === t.uuid) return true;
  return Boolean(t.name) && p.name.toLowerCase() === t.name.toLowerCase();
}

function parseTarget(v: unknown): Target | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const uuid = typeof o.uuid === "string" ? normUuid(o.uuid) : "";
  const name = typeof o.name === "string" && /^[A-Za-z0-9_.]{1,16}$/.test(o.name) ? o.name : "";
  if (uuid.length !== 32 && !name) return null;
  return { uuid: uuid.length === 32 ? uuid : "", name };
}
