export const UDP_MAGIC = Buffer.from([0x00, 0x56, 0x42, 0x55]);
export const TOKEN_BYTES = 16;

export const HOST_HELLO = 0x01;
export const HOST_DATA = 0x02;
export const HOST_CLOSE = 0x03;
export const RELAY_ACK = 0x81;
export const RELAY_DATA = 0x82;
export const RELAY_CLOSE = 0x83;

export const SVC_MAGIC = 0xff;

export type HostPacket =
  | { type: typeof HOST_HELLO; token: string }
  | { type: typeof HOST_DATA; token: string; peer: number; payload: Buffer }
  | { type: typeof HOST_CLOSE; token: string; peer: number };

const HEAD = UDP_MAGIC.length + 1 + TOKEN_BYTES;

export function isTunnel(msg: Buffer): boolean {
  return msg.length >= UDP_MAGIC.length + 1 && msg.subarray(0, UDP_MAGIC.length).equals(UDP_MAGIC);
}

export function parseHostPacket(msg: Buffer): HostPacket | null {
  if (msg.length < HEAD || !isTunnel(msg)) return null;
  const type = msg[UDP_MAGIC.length];
  const token = msg.subarray(UDP_MAGIC.length + 1, HEAD).toString("hex");
  if (type === HOST_HELLO) return { type, token };
  if (msg.length < HEAD + 4) return null;
  const peer = msg.readUInt32BE(HEAD);
  if (type === HOST_DATA) return { type, token, peer, payload: msg.subarray(HEAD + 4) };
  if (type === HOST_CLOSE) return { type, token, peer };
  return null;
}

export function relayAck(): Buffer {
  return Buffer.concat([UDP_MAGIC, Buffer.from([RELAY_ACK])]);
}

export function relayData(peer: number, channel: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(UDP_MAGIC.length + 6);
  UDP_MAGIC.copy(head);
  head[4] = RELAY_DATA;
  head.writeUInt32BE(peer, 5);
  head[9] = channel;
  return Buffer.concat([head, payload]);
}

export function relayClose(peer: number): Buffer {
  const b = Buffer.alloc(UDP_MAGIC.length + 5);
  UDP_MAGIC.copy(b);
  b[4] = RELAY_CLOSE;
  b.writeUInt32BE(peer, 5);
  return b;
}

export function hostPacket(type: number, token: Buffer, peer?: number, payload?: Buffer): Buffer {
  const parts = [UDP_MAGIC, Buffer.from([type]), token];
  if (peer !== undefined) {
    const p = Buffer.alloc(4);
    p.writeUInt32BE(peer);
    parts.push(p);
  }
  if (payload) parts.push(payload);
  return Buffer.concat(parts);
}

export function isRakNetSession(payload: Buffer): boolean {
  return payload.length > 0 && payload[0] >= 0x80 && payload[0] <= 0x8f;
}
