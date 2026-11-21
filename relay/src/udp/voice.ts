import { MAX_PROBES } from "./config.ts";
import { dropped } from "./metrics.ts";
import { admitPeer, allowNewPeer, fromPlayer, openPeer, sessions, voicePeers } from "./registry.ts";
import { type Channel, type Peer, type UdpSession, endpoint } from "./session.ts";

const INDEX_TTL_MS = 500;
const INDEX_MIN_REBUILD_MS = 100;

let index = new Map<string, UdpSession[]>();
let builtAt = 0;

export function handleVoice(msg: Buffer, ip: string, port: number) {
  const key = endpoint(ip, port);
  const known = voicePeers.get(key);
  if (known) {
    for (const p of known) fromPlayer(p, msg);
    return;
  }
  const found = candidates(ip);
  if (!found.length) return dropped("unknown");
  if (!allowNewPeer(ip)) return;
  const admitted = found.filter(([s, ch]) => admitPeer(s, ch, ip)).slice(0, MAX_PROBES);
  if (!admitted.length) return;
  const probe = admitted.length > 1;
  const peers: Peer[] = admitted.map(([s, ch]) => openPeer(s, ch, ip, port, probe));
  voicePeers.set(key, peers);
  for (const p of peers) fromPlayer(p, msg);
}

export function playerStillThere(s: UdpSession, ip: string): boolean {
  for (const p of s.host.players.values()) if (p.ip === ip) return true;
  return false;
}

function candidates(ip: string): [UdpSession, Channel][] {
  const now = Date.now();
  let hit = now - builtAt < INDEX_TTL_MS ? index.get(ip) : undefined;
  if (!hit && now - builtAt >= INDEX_MIN_REBUILD_MS) {
    rebuild(now);
    hit = index.get(ip);
  }
  const out: [UdpSession, Channel][] = [];
  for (const s of hit ?? []) {
    const ch = s.channels.get("voice");
    if (ch && !s.closed && playerStillThere(s, ip)) out.push([s, ch]);
  }
  return out;
}

function rebuild(now: number) {
  const next = new Map<string, UdpSession[]>();
  for (const s of sessions.values()) {
    if (!s.channels.has("voice")) continue;
    const ips = new Set<string>();
    for (const p of s.host.players.values()) ips.add(p.ip);
    for (const ip of ips) {
      const list = next.get(ip);
      if (list) list.push(s);
      else next.set(ip, [s]);
    }
  }
  index = next;
  builtAt = now;
}
