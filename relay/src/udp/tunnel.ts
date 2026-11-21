import { HOST_SAME_IP, MAX_PACKET } from "./config.ts";
import { HOST_CLOSE, HOST_DATA, HOST_HELLO, parseHostPacket, relayAck } from "./frame.ts";
import { dropped } from "./metrics.ts";
import { closePeer, sendShared, sessions, tellControl, toPeer } from "./registry.ts";

export function handleHostPacket(msg: Buffer, ip: string, port: number) {
  const pkt = parseHostPacket(msg);
  if (!pkt) return dropped("unknown");
  const s = sessions.get(pkt.token);
  if (!s || s.closed || (HOST_SAME_IP && s.host.ip !== ip)) return dropped("auth");
  s.tunnel = { ip, port, seen: Date.now() };
  if (!s.confirmed) {
    s.confirmed = true;
    tellControl(s, { t: "udp_ok" });
  }
  if (pkt.type === HOST_HELLO) return sendShared(relayAck(), port, ip);
  const peer = s.peers.get(pkt.peer);
  if (!peer) return dropped("peer");
  if (pkt.type === HOST_CLOSE) return closePeer(peer, false);
  if (pkt.type === HOST_DATA) {
    if (pkt.payload.length === 0 || pkt.payload.length > MAX_PACKET) return dropped("size");
    toPeer(peer, pkt.payload);
  }
}
