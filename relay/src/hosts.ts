import * as crypto from "node:crypto";
import type * as net from "node:net";
import type { Access } from "./access.ts";
import { addressOf, owner } from "./addresses.ts";
import { DATA_CONNECT_TIMEOUT_MS, log } from "./config.ts";
import { emit } from "./events.ts";
import { send } from "./lines.ts";
import { OFFLINE, type Text, refuse } from "./reply.ts";
import type { ChannelName } from "./udp/config.ts";
import type { UdpSession } from "./udp/session.ts";
import type { Login } from "./wire.ts";

export type Player = { name: string; uuid: string; ip: string; since: number };

export type Kind = "world" | "server";
export type Client = "mod" | "launcher";

export type Host = {
  sock: net.Socket;
  uuid: string;
  name: string;
  /** 0 = the classic address of the account; other slots have their own stable addresses. */
  slot: number;
  kind: Kind;
  client: Client;
  /** Version of the mod or launcher, as sent in hello. */
  version: string;
  /** Joined players at most, null = no limit. */
  maxPlayers: number | null;
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
  gone?: boolean;
  kicked?: Map<string, string>;
  udpAllow?: ChannelName[];
  udp?: UdpSession;
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

export const dropHooks: ((h: Host) => void)[] = [];

const byKey = new Map<string, Host>();
const pending = new Map<number, Pending>();
let nextSid = 1;

const keyOf = (uuid: string, slot: number) => `${uuid}/${slot}`;

export function hosts(): IterableIterator<Host> {
  return byKey.values();
}

/** Online hosts of one account, optionally without the one on `exceptSlot` (it would be replaced). */
export function hostsOf(uuid: string, exceptSlot?: number): Host[] {
  return [...byKey.values()].filter((h) => h.uuid === uuid && h.slot !== exceptSlot);
}

export function lookup(label: string | null): { uuid?: string; host?: Host } {
  const o = label ? owner(label) : undefined;
  return { uuid: o?.uuid, host: o ? byKey.get(keyOf(o.uuid, o.slot)) : undefined };
}

/** Puts a host online; an older session of the same (account, slot) gets `replaced`. */
export function register(h: Host) {
  const prev = byKey.get(keyOf(h.uuid, h.slot));
  if (prev) {
    send(prev.sock, { t: "replaced" });
    prev.sock.end();
    drop(prev);
  }
  byKey.set(keyOf(h.uuid, h.slot), h);
  emit({ type: "host_online", uuid: h.uuid, slot: h.slot, address: addressOf(h.label), ip: h.ip });
}

/** Takes a host offline (idempotent): waiting players get the offline answer, live ones are cut. */
export function drop(h: Host) {
  if (h.gone) return;
  h.gone = true;
  if (byKey.get(keyOf(h.uuid, h.slot)) === h) byKey.delete(keyOf(h.uuid, h.slot));
  for (const p of pending.values()) if (p.host === h) unpark(p, true);
  for (const s of h.live) s.destroy();
  for (const hook of dropHooks) hook(h);
  log(`host offline ${h.name}#${h.slot}`);
  emit({ type: "host_offline", uuid: h.uuid, slot: h.slot, address: addressOf(h.label), ip: h.ip });
}

/** Sends the host an error (the mod shows it and stops retrying) and disconnects it. */
export function kick(h: Host, code: string, msg: string) {
  send(h.sock, { t: "error", code, msg });
  h.sock.end();
  setTimeout(() => h.sock.destroy(), 2_000).unref();
  drop(h);
}

/** Joined plus joining players, for maxPlayers. */
export function joinCount(h: Host): number {
  let n = h.players.size;
  for (const p of pending.values()) if (p.host === h && p.login) n++;
  return n;
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

export function pendingOf(h: Host, match: (login: Login) => boolean): Pending[] {
  return [...pending.values()].filter((p) => p.host === h && p.login && match(p.login));
}

export function refusePending(p: Pending, text: Text) {
  if (!pending.has(p.sid)) return;
  unpark(p, false);
  refuse(p.player, p.head, text);
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
