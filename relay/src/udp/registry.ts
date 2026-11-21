import type * as dgram from "node:dgram";
import { send } from "../lines.ts";
import { WindowLimiter, bucket, take } from "./bucket.ts";
import {
  AMPLIFICATION, AMPLIFICATION_ALLOWANCE, CHANNEL_ID, MAX_PEERS, MAX_PEERS_PER_HOST, NEW_PEERS_PER_IP,
  NEW_PEERS_WINDOW_MS, PEER_BPS, PEER_PPS, TUNNEL_IDLE_MS, type ChannelName,
} from "./config.ts";
import { isRakNetSession, relayClose, relayData } from "./frame.ts";
import { countOut, dropped, udpTotals } from "./metrics.ts";
import { type Channel, type Peer, type UdpSession, endpoint } from "./session.ts";

export const sessions = new Map<string, UdpSession>();
export const voicePeers = new Map<string, Peer[]>();
export const newPeers = new WindowLimiter(NEW_PEERS_PER_IP, NEW_PEERS_WINDOW_MS);
let shared: dgram.Socket | null = null;
let peerCount = 0;

export function setShared(sock: dgram.Socket | null) {
  shared = sock;
}

export function sharedSocket(): dgram.Socket | null {
  return shared;
}

export function totalPeers(): number {
  return peerCount;
}

export function admitPeer(s: UdpSession, ch: Channel, ip: string): boolean {
  if (s.host.access.banIps.has(ip)) {
    dropped("banned");
    return false;
  }
  if (peerCount >= MAX_PEERS || ch.peers.size >= MAX_PEERS_PER_HOST) {
    dropped("limit");
    return false;
  }
  return true;
}

export function allowNewPeer(ip: string): boolean {
  if (newPeers.allow(ip)) return true;
  dropped("rate");
  return false;
}

export function openPeer(s: UdpSession, ch: Channel, ip: string, port: number, probe = false): Peer {
  const now = Date.now();
  const id = s.nextPeer;
  s.nextPeer = s.nextPeer >= 0xffffffff ? 1 : s.nextPeer + 1;
  const peer: Peer = {
    id, session: s, channel: ch.name, ip, port, key: endpoint(ip, port), pps: bucket(PEER_PPS), bps: bucket(PEER_BPS),
    bytesIn: 0, bytesOut: 0, validated: ch.name === "voice", probe, since: now, lastIn: now, lastOut: 0,
  };
  s.peers.set(id, peer);
  ch.peers.set(peer.key, peer);
  peerCount++;
  udpTotals.peersOpened++;
  return peer;
}

export function closePeer(peer: Peer, tellHost = true) {
  const s = peer.session;
  if (s.peers.get(peer.id) !== peer) return;
  s.peers.delete(peer.id);
  peerCount--;
  const ch = s.channels.get(peer.channel);
  if (ch?.peers.get(peer.key) === peer) ch.peers.delete(peer.key);
  if (peer.channel === "voice") {
    const list = voicePeers.get(peer.key)?.filter((p) => p !== peer) ?? [];
    if (list.length) voicePeers.set(peer.key, list);
    else voicePeers.delete(peer.key);
  }
  if (tellHost) toHost(s, relayClose(peer.id), true);
}

export function fromPlayer(peer: Peer, payload: Buffer) {
  const now = Date.now();
  if (!take(peer.pps, 1, now) || !take(peer.bps, payload.length, now)) return dropped("rate");
  peer.lastIn = now;
  peer.bytesIn += payload.length;
  if (!peer.validated && isRakNetSession(payload)) peer.validated = true;
  toHost(peer.session, relayData(peer.id, CHANNEL_ID[peer.channel], payload));
}

export function toPeer(peer: Peer, payload: Buffer) {
  const s = peer.session;
  const ch = s.channels.get(peer.channel);
  if (!ch) return dropped("peer");
  if (!peer.validated && peer.bytesOut + payload.length > AMPLIFICATION * peer.bytesIn + AMPLIFICATION_ALLOWANCE) {
    return dropped("amplification");
  }
  if (!take(s.out, payload.length)) return dropped("rate");
  if (peer.probe) settleProbe(peer);
  peer.lastOut = Date.now();
  peer.bytesOut += payload.length;
  ch.sock.send(payload, peer.port, peer.ip);
  countOut(payload.length);
}

export function toHost(s: UdpSession, buf: Buffer, quiet = false): boolean {
  const t = s.tunnel;
  if (!shared || !t || Date.now() - t.seen > TUNNEL_IDLE_MS) {
    if (!quiet) dropped("no_tunnel");
    return false;
  }
  shared.send(buf, t.port, t.ip);
  countOut(buf.length);
  return true;
}

export function sendShared(buf: Buffer, port: number, ip: string) {
  if (!shared) return;
  shared.send(buf, port, ip);
  countOut(buf.length);
}

export function tellControl(s: UdpSession, msg: Record<string, unknown>) {
  if (!s.closed) send(s.host.sock, msg);
}

export function countPeers(channel: ChannelName): number {
  let n = 0;
  for (const s of sessions.values()) n += s.channels.get(channel)?.peers.size ?? 0;
  return n;
}

function settleProbe(winner: Peer) {
  for (const other of voicePeers.get(winner.key) ?? []) if (other !== winner) closePeer(other);
  winner.probe = false;
  voicePeers.set(winner.key, [winner]);
}
