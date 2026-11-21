import * as dgram from "node:dgram";

const MAGIC = Buffer.from([0x00, 0x56, 0x42, 0x55]);
const HELLO = 0x01;
const DATA = 0x02;
const CLOSE = 0x03;
const ACK = 0x81;
const RELAY_DATA = 0x82;
const RELAY_CLOSE = 0x83;
const CHANNEL_PORT_KEY: Record<number, "voice" | "bedrock"> = { 1: "voice", 2: "bedrock" };

export type UdpHostOptions = {
  relayHost: string;
  tunnelPort: number;
  token: string;
  local: { voice?: number; bedrock?: number };
  helloMs?: number;
  idleMs?: number;
  log?: (...a: unknown[]) => void;
};

export type UdpHost = {
  update: (token: string, tunnelPort: number) => void;
  stop: () => void;
  acked: () => boolean;
  peers: () => number;
};

type LocalPeer = { sock: dgram.Socket; last: number };

export function startUdpHost(o: UdpHostOptions): UdpHost {
  const log = o.log ?? (() => {});
  const sock = dgram.createSocket("udp4");
  const peers = new Map<number, LocalPeer>();
  let token = Buffer.from(o.token, "hex");
  let tunnelPort = o.tunnelPort;
  let acked = false;
  let stopped = false;

  const packet = (type: number, peer?: number, payload?: Buffer) => {
    const parts: Buffer[] = [MAGIC, Buffer.from([type]), token];
    if (peer !== undefined) {
      const p = Buffer.alloc(4);
      p.writeUInt32BE(peer);
      parts.push(p);
    }
    if (payload) parts.push(payload);
    return Buffer.concat(parts);
  };
  const toRelay = (buf: Buffer) => !stopped && sock.send(buf, tunnelPort, o.relayHost);
  const hello = () => toRelay(packet(HELLO));

  const closeLocal = (id: number, tell: boolean) => {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    p.sock.close();
    if (tell) toRelay(packet(CLOSE, id));
  };

  const localFor = (id: number, port: number): LocalPeer => {
    const existing = peers.get(id);
    if (existing) return existing;
    const local = dgram.createSocket("udp4");
    const p: LocalPeer = { sock: local, last: Date.now() };
    local.on("message", (m, rinfo) => {
      if (rinfo.address !== "127.0.0.1" || rinfo.port !== port) return;
      p.last = Date.now();
      toRelay(packet(DATA, id, m));
    });
    local.on("error", (e) => log("local udp:", e.message));
    local.bind(0, "127.0.0.1");
    peers.set(id, p);
    return p;
  };

  sock.on("message", (msg, rinfo) => {
    if (rinfo.port !== tunnelPort || msg.length < 5 || !msg.subarray(0, 4).equals(MAGIC)) return;
    const type = msg[4];
    if (type === ACK) {
      acked = true;
      return;
    }
    if (msg.length < 9) return;
    const id = msg.readUInt32BE(5);
    if (type === RELAY_CLOSE) return closeLocal(id, false);
    if (type !== RELAY_DATA || msg.length < 10) return;
    const name = CHANNEL_PORT_KEY[msg[9]];
    const port = name ? o.local[name] : undefined;
    if (!port) return;
    const p = localFor(id, port);
    p.last = Date.now();
    p.sock.send(msg.subarray(10), port, "127.0.0.1");
  });
  sock.on("error", (e) => log("udp:", e.message));

  const idleMs = o.idleMs ?? 60_000;
  const keepalive = setInterval(hello, o.helloMs ?? 15_000);
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, p] of peers) if (now - p.last > idleMs) closeLocal(id, true);
  }, Math.min(idleMs, 5_000));
  sock.bind(0, () => hello());

  return {
    update: (t, port) => {
      token = Buffer.from(t, "hex");
      tunnelPort = port;
      hello();
    },
    stop: () => {
      stopped = true;
      clearInterval(keepalive);
      clearInterval(sweep);
      for (const id of [...peers.keys()]) closeLocal(id, false);
      sock.close();
    },
    acked: () => acked,
    peers: () => peers.size,
  };
}
