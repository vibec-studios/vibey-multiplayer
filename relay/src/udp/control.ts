import * as crypto from "node:crypto";
import { DOMAIN, log } from "../config.ts";
import { type Host, dropHooks } from "../hosts.ts";
import { send } from "../lines.ts";
import { openBedrock } from "./bedrock.ts";
import { bucket } from "./bucket.ts";
import { BEDROCK_PORTS, DEFAULT_CHANNELS, HOST_BPS, MAX_PEERS, UDP_PUBLIC_PORT, type ChannelName } from "./config.ts";
import { closePeer, sessions, sharedSocket, tellControl, totalPeers } from "./registry.ts";
import type { Denied, UdpSession } from "./session.ts";

const DISABLED: Denied = { code: "disabled", msg: "This is not available for your world on this relay." };
const NO_PORT: Denied = { code: "no_port", msg: "No Bedrock port is free right now. Try again later." };
const LIMIT: Denied = { code: "limit", msg: "The relay is busy right now. Try again later." };

dropHooks.push(closeUdp);

export function requestUdp(host: Host, wanted: ChannelName[]) {
  if (host.gone) return;
  if (!sharedSocket() && !host.udp) {
    const denied = Object.fromEntries(wanted.map((c) => [c, DISABLED]));
    send(host.sock, { t: "udp_ready", token: "", tunnel: { port: UDP_PUBLIC_PORT }, channels: {}, denied });
    return;
  }
  const s = host.udp ?? createSession(host);
  s.queue = s.queue.then(() => apply(s, wanted)).catch((e) => log("udp:", (e as Error).message));
}

export function resendUdp(host: Host) {
  const s = host.udp;
  if (s) s.queue = s.queue.then(() => tellControl(s, readyMessage(s)));
}

export function closeUdp(host: Host) {
  const s = host.udp;
  if (s) closeSession(s);
}

export function closeAllUdp() {
  for (const s of [...sessions.values()]) closeSession(s);
}

function createSession(host: Host): UdpSession {
  const token = crypto.randomBytes(16);
  const s: UdpSession = {
    host, token, tokenHex: token.toString("hex"), channels: new Map(), denied: {}, peers: new Map(), nextPeer: 1,
    tunnel: null, confirmed: false, out: bucket(HOST_BPS), queue: Promise.resolve(), closed: false,
  };
  host.udp = s;
  sessions.set(s.tokenHex, s);
  return s;
}

async function apply(s: UdpSession, wanted: ChannelName[]) {
  if (s.closed) return;
  if (!wanted.length) {
    closeSession(s);
    send(s.host.sock, { t: "udp_ready", token: "", tunnel: { port: UDP_PUBLIC_PORT }, channels: {}, denied: {} });
    return;
  }
  for (const name of [...s.channels.keys()]) if (!wanted.includes(name)) closeChannel(s, name);
  s.denied = {};
  const allowed = s.host.udpAllow ?? DEFAULT_CHANNELS;
  const shared = sharedSocket();
  for (const name of wanted) {
    if (s.channels.has(name)) continue;
    if (!shared || !allowed.includes(name) || (name === "bedrock" && !BEDROCK_PORTS.length)) {
      s.denied[name] = DISABLED;
      continue;
    }
    if (totalPeers() >= MAX_PEERS) {
      s.denied[name] = LIMIT;
      continue;
    }
    if (name === "voice") {
      s.channels.set("voice", { name, port: UDP_PUBLIC_PORT, sock: shared, peers: new Map() });
      continue;
    }
    const ch = await openBedrock(s);
    if (s.closed) {
      ch?.release?.();
      return;
    }
    if (ch) s.channels.set("bedrock", ch);
    else s.denied.bedrock = NO_PORT;
  }
  log(`udp ${s.host.name}#${s.host.slot}: ${[...s.channels.values()].map((c) => `${c.name}:${c.port}`).join(", ") || "none"}`);
  tellControl(s, readyMessage(s));
}

function readyMessage(s: UdpSession): Record<string, unknown> {
  const host = `${s.host.label}.${DOMAIN}`;
  const channels: Record<string, unknown> = {};
  for (const [name, ch] of s.channels) {
    const base = { port: ch.port, address: `${host}:${ch.port}` };
    channels[name] = name === "voice" ? { ...base, voiceHost: String(ch.port) } : { ...base, host };
  }
  return { t: "udp_ready", token: s.tokenHex, tunnel: { port: UDP_PUBLIC_PORT }, channels, denied: s.denied };
}

function closeChannel(s: UdpSession, name: ChannelName) {
  const ch = s.channels.get(name);
  if (!ch) return;
  for (const p of [...ch.peers.values()]) closePeer(p, true);
  ch.release?.();
  s.channels.delete(name);
}

function closeSession(s: UdpSession) {
  if (s.closed) return;
  s.closed = true;
  sessions.delete(s.tokenHex);
  for (const p of [...s.peers.values()]) closePeer(p, false);
  for (const ch of s.channels.values()) ch.release?.();
  s.channels.clear();
  if (s.host.udp === s) s.host.udp = undefined;
}
