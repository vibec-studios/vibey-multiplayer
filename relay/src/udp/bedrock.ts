import type * as dgram from "node:dgram";
import { MAX_PACKET } from "./config.ts";
import { countIn, dropped } from "./metrics.ts";
import { acquirePort, releasePort } from "./ports.ts";
import { admitPeer, allowNewPeer, fromPlayer, openPeer } from "./registry.ts";
import { type Channel, type UdpSession, endpoint } from "./session.ts";
import { normalizeIp } from "../access.ts";

export async function openBedrock(s: UdpSession): Promise<Channel | null> {
  const key = `${s.host.uuid}/${s.host.slot}`;
  let ch: Channel | null = null;
  const got = await acquirePort(key, (msg, rinfo) => ch && onMessage(s, ch, msg, rinfo));
  if (!got) return null;
  ch = { name: "bedrock", port: got.port, sock: got.sock, peers: new Map() };
  ch.release = () => releasePort(key, got.port, got.sock);
  return ch;
}

function onMessage(s: UdpSession, ch: Channel, msg: Buffer, rinfo: dgram.RemoteInfo) {
  countIn(msg.length);
  if (s.closed) return;
  if (msg.length === 0 || msg.length > MAX_PACKET) return dropped("size");
  const ip = normalizeIp(rinfo.address);
  const peer = ch.peers.get(endpoint(ip, rinfo.port));
  if (peer) return fromPlayer(peer, msg);
  if (!admitPeer(s, ch, ip) || !allowNewPeer(ip)) return;
  fromPlayer(openPeer(s, ch, ip, rinfo.port), msg);
}
