export type Handshake = { protocol: number; host: string; next: number; length: number };
export type Login = { name: string; uuid: string };

export const STATE_STATUS = 1;

export function readVarInt(buf: Buffer, off: number): [value: number, next: number] | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (off + i >= buf.length) return null;
    const b = buf[off + i];
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return [value, off + i + 1];
  }
  throw new Error("varint too long");
}

export function varInt(value: number): Buffer {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

export function string(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([varInt(b.length), b]);
}

export function packet(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(body.length), body]);
}

class Reader {
  private readonly buf: Buffer;
  private off: number;
  private readonly end: number;

  constructor(buf: Buffer, off: number, end: number) {
    this.buf = buf;
    this.off = off;
    this.end = end;
  }

  left(): number {
    return this.end - this.off;
  }

  varInt(): number {
    const r = readVarInt(this.buf, this.off);
    if (!r || r[1] > this.end) throw new Error("truncated packet");
    this.off = r[1];
    return r[0];
  }

  bytes(n: number): Buffer {
    if (n < 0 || n > this.left()) throw new Error("truncated packet");
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  string(maxChars: number): string {
    return this.bytes(this.varIntAtMost(maxChars * 4)).toString("utf8");
  }

  u16(): number {
    return this.bytes(2).readUInt16BE(0);
  }

  private varIntAtMost(max: number): number {
    const n = this.varInt();
    if (n > max) throw new Error("field too long");
    return n;
  }
}

export type Frame = { id: number; body: Reader; end: number };

/** One length-prefixed packet starting at `off`, or null while bytes are missing. */
export function readFrame(buf: Buffer, off: number, maxSize: number): Frame | null {
  const len = readVarInt(buf, off);
  if (!len) return null;
  const [size, start] = len;
  if (size <= 0 || size > maxSize) throw new Error("bad packet length");
  if (buf.length < start + size) return null;
  const body = new Reader(buf, start, start + size);
  return { id: body.varInt(), body, end: start + size };
}

export function parseHandshake(buf: Buffer): Handshake | null {
  const f = readFrame(buf, 0, 1024);
  if (!f) return null;
  if (f.id !== 0) throw new Error("not a handshake");
  const protocol = f.body.varInt();
  const host = f.body.string(255);
  f.body.u16();
  return { protocol, host, next: f.body.varInt(), length: f.end };
}

export function parseLoginStart(buf: Buffer, off: number): Login | null {
  const f = readFrame(buf, off, 512);
  if (!f) return null;
  if (f.id !== 0) throw new Error("not a login start");
  const name = f.body.string(16);
  const uuid = f.body.left() >= 16 ? f.body.bytes(16).toString("hex") : "";
  return { name, uuid };
}
