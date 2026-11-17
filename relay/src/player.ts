import type * as net from "node:net";
import { blockReason } from "./access.ts";
import { labelFromHost } from "./addresses.ts";
import { FIRST_BYTES_TIMEOUT_MS, MAX_PLAYER_PREFIX, MAX_STREAMS } from "./config.ts";
import { type Host, lookup, park } from "./hosts.ts";
import { send } from "./lines.ts";
import { BUSY, OFFLINE, UNKNOWN, refuse } from "./reply.ts";
import { totals } from "./stats.ts";
import { type Handshake, type Login, STATE_STATUS, parseHandshake, parseLoginStart } from "./wire.ts";

type Knock = { hs: Handshake; uuid?: string; host?: Host; login: Login | null };

/** A Minecraft client. Waits for the handshake (and Login Start for joins), then routes or refuses it. */
export function handlePlayer(sock: net.Socket, first: Buffer, ip: string) {
  let buf = first;
  const timer = setTimeout(() => sock.destroy(), FIRST_BYTES_TIMEOUT_MS);
  const step = () => {
    let knock: Knock | null = null;
    let garbage = false;
    try {
      knock = inspect(buf);
    } catch {
      garbage = true;
    }
    if (!knock && !garbage && buf.length <= MAX_PLAYER_PREFIX) return;
    clearTimeout(timer);
    sock.off("data", onData);
    if (knock) route(sock, buf, ip, knock);
    else sock.destroy();
  };
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    step();
  };
  sock.on("data", onData);
  step();
}

/** Null while bytes are missing, throws on garbage. */
function inspect(buf: Buffer): Knock | null {
  const hs = parseHandshake(buf);
  if (!hs) return null;
  const { uuid, host } = lookup(labelFromHost(hs.host));
  if (!host || hs.next === STATE_STATUS) return { hs, uuid, host, login: null };
  const login = parseLoginStart(buf, hs.length);
  return login ? { hs, uuid, host, login } : null;
}

function route(sock: net.Socket, head: Buffer, ip: string, { hs, uuid, host, login }: Knock) {
  if (!host) return refuse(sock, head, uuid ? OFFLINE : UNKNOWN);

  const reason = blockReason(host.access, ip, login?.name ?? null);
  if (reason) {
    totals.blocked++;
    if (login) send(host.sock, { t: "blocked", name: login.name, ip, reason });
    return refuse(sock, head, { title: host.access.messages[reason], sub: "" });
  }
  if (host.streams >= MAX_STREAMS) return refuse(sock, head, BUSY);

  if (hs.next === STATE_STATUS) totals.pings++;
  const p = park(host, sock, head, login, ip);
  send(host.sock, { t: "open", sid: p.sid, key: p.key, ip, state: hs.next, ...(login ?? {}) });
}
