import * as dgram from "node:dgram";
import { normalizeIp } from "../access.ts";
import { log } from "../config.ts";
import { PEER_IDLE_MS, PROBE_MS, UDP_BIND, UDP_PORT, enabled, MAX_PACKET } from "./config.ts";
import { closeAllUdp } from "./control.ts";
import { SVC_MAGIC, isTunnel } from "./frame.ts";
import { countIn, dropped } from "./metrics.ts";
import { flushLeases, loadLeases } from "./ports.ts";
import { closePeer, newPeers, sessions, setShared } from "./registry.ts";
import { handleHostPacket } from "./tunnel.ts";
import { handleVoice, playerStillThere } from "./voice.ts";

const SWEEP_MS = 5_000;
const TUNNEL_OVERHEAD = 32;

export async function startUdp(): Promise<() => void> {
  if (!enabled) return () => {};
  loadLeases();
  const sock = await bindShared();
  if (!sock) return () => {};
  setShared(sock);
  const timer = setInterval(sweep, SWEEP_MS).unref();
  log(`udp on :${UDP_PORT} (voice and host tunnel)`);
  return () => {
    clearInterval(timer);
    closeAllUdp();
    flushLeases();
    setShared(null);
    sock.close();
  };
}

function bindShared(): Promise<dgram.Socket | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const fail = (e: Error) => {
      log(`WARNING: udp :${UDP_PORT} not available, voice and Bedrock are off:`, e.message);
      resolve(null);
    };
    sock.once("error", fail);
    sock.on("message", onMessage);
    sock.bind(UDP_PORT, UDP_BIND, () => {
      sock.off("error", fail);
      sock.on("error", (e) => log("udp:", e.message));
      resolve(sock);
    });
  });
}

function onMessage(msg: Buffer, rinfo: dgram.RemoteInfo) {
  countIn(msg.length);
  if (msg.length === 0 || msg.length > MAX_PACKET + TUNNEL_OVERHEAD) return dropped("size");
  const ip = normalizeIp(rinfo.address);
  if (isTunnel(msg)) return handleHostPacket(msg, ip, rinfo.port);
  if (msg[0] === SVC_MAGIC) {
    if (msg.length > MAX_PACKET) return dropped("size");
    return handleVoice(msg, ip, rinfo.port);
  }
  dropped("unknown");
}

function sweep() {
  const now = Date.now();
  for (const s of sessions.values()) {
    for (const peer of [...s.peers.values()]) {
      const idle = now - Math.max(peer.lastIn, peer.lastOut) > PEER_IDLE_MS;
      const left = peer.channel === "voice" && !playerStillThere(s, peer.ip);
      const unanswered = peer.probe && now - peer.since > PROBE_MS;
      if (idle || left || unanswered) closePeer(peer, true);
    }
  }
  newPeers.sweep(now);
}
