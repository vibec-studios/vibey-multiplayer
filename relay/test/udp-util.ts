import * as dgram from "node:dgram";
import { type LauncherClient, startLauncherClient } from "./launcher-client.ts";
import { sleep } from "./util.ts";

export type Local = { port: number; received: Buffer[]; close: () => void };

export async function udpServer(reply: (msg: Buffer) => Buffer | null): Promise<Local> {
  const sock = dgram.createSocket("udp4");
  const received: Buffer[] = [];
  sock.on("message", (m, r) => {
    received.push(m);
    const out = reply(m);
    if (out) sock.send(out, r.port, r.address);
  });
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
  return { port: sock.address().port, received, close: () => sock.close() };
}

export async function freeUdpPort(): Promise<number> {
  const s = dgram.createSocket("udp4");
  await new Promise<void>((r) => s.bind(0, "127.0.0.1", () => r()));
  const port = s.address().port;
  s.close();
  return port;
}

export async function freeUdpRange(n: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 41000 + Math.floor(Math.random() * 18000);
    const socks: dgram.Socket[] = [];
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const s = dgram.createSocket("udp4");
      ok = await new Promise<boolean>((r) => {
        s.once("error", () => r(false));
        s.bind(base + i, "0.0.0.0", () => r(true));
      });
      socks.push(s);
    }
    for (const s of socks) {
      try {
        s.close();
      } catch {
        continue;
      }
    }
    if (ok) return base;
  }
  throw new Error("no free udp range");
}

export type Client = { sock: dgram.Socket; replies: Buffer[]; send: (port: number, b: Buffer) => void; close: () => void };

export async function udpClient(bindIp = "127.0.0.1"): Promise<Client> {
  const sock = dgram.createSocket("udp4");
  const replies: Buffer[] = [];
  sock.on("message", (m) => replies.push(m));
  await new Promise<void>((r) => sock.bind(0, bindIp, () => r()));
  return { sock, replies, send: (port, b) => sock.send(b, port, "127.0.0.1"), close: () => sock.close() };
}

export async function ask(c: Client, port: number, b: Buffer, ms = 1500): Promise<Buffer | null> {
  const before = c.replies.length;
  c.send(port, b);
  for (let waited = 0; waited < ms; waited += 20) {
    if (c.replies.length > before) return c.replies[before];
    await sleep(20);
  }
  return null;
}

export const voice = (text: string) => Buffer.concat([Buffer.from([0xff]), Buffer.alloc(16, 7), Buffer.from(text)]);

export type Hosted = {
  client: LauncherClient;
  address: string;
  udp: any;
  udpOk: Promise<boolean>;
  next: () => Promise<any>;
  errors: string[];
};

export async function hostWithUdp(
  relayPort: number, mcPort: number, udp: { voice?: number; bedrock?: number }, uuid: string, slot = 1,
): Promise<Hosted> {
  let resolveReady: (a: string) => void = () => {};
  const ready = new Promise<string>((r) => (resolveReady = r));
  const waiters: ((m: any) => void)[] = [];
  const queue: any[] = [];
  const errors: string[] = [];
  let okResolve: (v: boolean) => void = () => {};
  const udpOk = new Promise<boolean>((r) => (okResolve = r));
  const client = startLauncherClient({
    relayHost: "127.0.0.1", relayPort, serverPort: mcPort, name: "Host" + slot, uuid, slot, mc: "test", version: "test",
    udp,
    onReady: (a) => resolveReady(a),
    onError: (c, m) => errors.push(`${c}: ${m}`),
    onUdpReady: (m) => {
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    },
    onUdpOk: () => okResolve(true),
  });
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise<any>((r) => waiters.push(r)));
  const address = await Promise.race([ready, sleep(6000).then(() => "timeout")]);
  const first = await Promise.race([next(), sleep(4000).then(() => null)]);
  return {
    client, address, udp: first, next, errors,
    udpOk: Promise.race([udpOk, sleep(4000).then(() => false)]),
  };
}
