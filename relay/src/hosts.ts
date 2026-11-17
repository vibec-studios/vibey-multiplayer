import * as crypto from "node:crypto";
import type * as net from "node:net";
import type { Access } from "./access.ts";
import { owner } from "./addresses.ts";
import { DATA_CONNECT_TIMEOUT_MS } from "./config.ts";
import { send } from "./lines.ts";
import { OFFLINE, refuse } from "./reply.ts";
import type { Login } from "./wire.ts";

export type Player = { name: string; uuid: string; ip: string; since: number };

export type Host = {
  sock: net.Socket;
  uuid: string;
  name: string;
  label: string;
  ip: string;
  mc: string;
  since: number;
  lastSeen: number;
  access: Access;
  rotations: number[];
  /** Waiting plus spliced player connections, for MAX_STREAMS. */
  streams: number;
  live: Set<net.Socket>;
  players: Map<net.Socket, Player>;
};

export type Pending = {
  sid: number;
  key: string;
  host: Host;
  player: net.Socket;
  head: Buffer;
  login: Login | null;
  ip: string;
  timer: NodeJS.Timeout;
  gone: () => void;
};

const byUuid = new Map<string, Host>();
const pending = new Map<number, Pending>();
let nextSid = 1;

export function hosts(): IterableIterator<Host> {
  return byUuid.values();
}

export function lookup(label: string | null): { uuid?: string; host?: Host } {
  const uuid = label ? owner(label) : undefined;
  return { uuid, host: uuid ? byUuid.get(uuid) : undefined };
}

export function register(h: Host) {
  const prev = byUuid.get(h.uuid);
  if (prev) {
    send(prev.sock, { t: "replaced" });
    prev.sock.end();
    drop(prev);
  }
  byUuid.set(h.uuid, h);
}

export function drop(h: Host) {
  if (byUuid.get(h.uuid) === h) byUuid.delete(h.uuid);
  for (const p of pending.values()) if (p.host === h) unpark(p, true);
  for (const s of h.live) s.destroy();
}

/** Holds a player connection until the host opens the matching data connection. */
export function park(host: Host, player: net.Socket, head: Buffer, login: Login | null, ip: string): Pending {
  player.pause();
  const p: Pending = {
    sid: nextSid++,
    key: crypto.randomBytes(16).toString("hex"),
    host, player, head, login, ip,
    timer: setTimeout(() => unpark(p, true), DATA_CONNECT_TIMEOUT_MS),
    gone: () => unpark(p, false),
  };
  player.once("close", p.gone);
  pending.set(p.sid, p);
  host.streams++;
  return p;
}

export function claim(sid: number, key: string): Pending | null {
  const p = pending.get(sid);
  if (!p || !sameKey(p.key, key)) return null;
  pending.delete(sid);
  clearTimeout(p.timer);
  p.player.off("close", p.gone);
  return p;
}

function unpark(p: Pending, tellPlayer: boolean) {
  if (!pending.delete(p.sid)) return;
  clearTimeout(p.timer);
  p.player.off("close", p.gone);
  p.host.streams--;
  if (tellPlayer) refuse(p.player, p.head, OFFLINE);
}

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
