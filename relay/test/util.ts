// Shared helpers for the relay tests: start a relay, fake hosts, fake players.

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MAGIC } from "../src/config.ts";
import { packet, string, varInt } from "../src/wire.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DOMAIN = "play.test";
export const UUID = "0123456789abcdef0123456789abcdef";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function handshake(host: string, next: number) {
  const port = Buffer.alloc(2);
  port.writeUInt16BE(25565);
  return packet(0, Buffer.concat([varInt(774), string(host), port, varInt(next)]));
}

export const loginStart = (name: string) => packet(0, Buffer.concat([string(name), Buffer.alloc(16, 0xab)]));
export const statusRequest = () => packet(0, Buffer.alloc(0));
export const line = (msg: object) => Buffer.from(JSON.stringify(msg) + "\n");
export const tunnel = (msg: object) => Buffer.concat([MAGIC, line(msg)]);

export function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok  " + msg);
}

export type Relay = { port: number; httpPort: number; dataDir: string; proc: ChildProcess; stop: () => Promise<void> };

export async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** Starts `src/main.ts` in offline mode on a free port and waits until it accepts connections. */
export async function startRelay(env: Record<string, string> = {}, dataDir?: string): Promise<Relay> {
  const port = await freePort();
  const httpPort = await freePort();
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "vibey-relay-"));
  const proc = spawn(process.execPath, [path.join(here, "..", "src", "main.ts")], {
    env: {
      ...process.env, DOMAINS: "", RELAY_ID: "", PORT: String(port), DOMAIN, DATA_DIR: dir, ALLOW_OFFLINE: "1", HTTP_PORT: String(httpPort), ...env,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await sleep(100);
    up = await new Promise<boolean>((r) => {
      const s = net.connect(port, "127.0.0.1", () => (s.destroy(), r(true)));
      s.on("error", () => r(false));
    });
  }
  if (!up) throw new Error(`relay did not start on :${port}`);
  const stop = async () => {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill();
    await Promise.race([exited, sleep(3000)]);
    if (!dataDir) fs.rmSync(dir, { recursive: true, force: true });
  };
  return { port, httpPort, dataDir: dir, proc, stop };
}

/** Connects to 127.0.0.1; retries a few times because loopback connects on some Windows machines time out at random. */
export async function connect(port: number): Promise<net.Socket> {
  for (let attempt = 1; ; attempt++) {
    const s = net.connect(port, "127.0.0.1");
    const err = await new Promise<Error | null>((r) => {
      s.once("connect", () => r(null));
      s.once("error", r);
    });
    if (!err) return s;
    s.destroy();
    if (attempt >= 5 || (err as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw err;
  }
}

export function lines(sock: net.Socket, cb: (msg: any) => void) {
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    let i;
    while ((i = buf.indexOf(10)) >= 0) {
      const l = buf.subarray(0, i).toString();
      buf = buf.subarray(i + 1);
      if (l.trim()) cb(JSON.parse(l));
    }
  });
}

export function collect(sock: net.Socket, until: (b: Buffer) => boolean, ms = 4000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => reject(new Error("timeout, got " + buf.toString("hex"))), ms);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (until(buf)) {
        clearTimeout(t);
        resolve(buf);
      }
    });
  });
}

/** True when the socket closes within `ms` (or already has). */
export const closed = (sock: net.Socket, ms = 4000) =>
  new Promise<boolean>((resolve) => {
    if (sock.destroyed || sock.readableEnded) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    sock.once("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });

export async function expectText(port: number, payload: Buffer, text: string) {
  const p = await connect(port);
  p.write(payload);
  const got = await collect(p, (b) => b.includes(Buffer.from(text)));
  p.destroy();
  return got.length > 0;
}

/** Echo server standing in for the integrated / dedicated Minecraft server. */
export async function echoServer(): Promise<{ port: number; close: () => void }> {
  const mc = net.createServer((s) => s.on("data", (d) => s.write(Buffer.concat([Buffer.from("MC:"), d]))));
  await new Promise<void>((r) => mc.listen(0, "127.0.0.1", () => r()));
  return { port: (mc.address() as net.AddressInfo).port, close: () => mc.close() };
}

export type HostSession = {
  ctl: net.Socket;
  opens: any[];
  blocked: any[];
  errors: any[];
  messages: any[];
  nextReady: () => Promise<any>;
  /** The first `ready`, or the `error` that ended the session. */
  ready: any;
};

/** A fake mod (or launcher with `extra` hello fields): authenticates and splices every `open` to `mcPort`. */
export async function hostSession(port: number, mcPort: number, extra: object = {}, uuid = UUID): Promise<HostSession> {
  const ctl = await connect(port);
  const opens: any[] = [];
  const blocked: any[] = [];
  const errors: any[] = [];
  const messages: any[] = [];
  let onReady: ((m: any) => void) | null = null;
  lines(ctl, (msg) => {
    messages.push(msg);
    if (msg.t === "challenge") ctl.write(line({ t: "auth" }));
    if (msg.t === "blocked") blocked.push(msg);
    if (msg.t === "error") {
      errors.push(msg);
      onReady?.(msg);
    }
    if (msg.t === "ready") onReady?.(msg);
    if (msg.t === "open") {
      opens.push(msg);
      void (async () => {
        const d = await connect(port);
        d.on("error", () => {});
        d.write(tunnel({ t: "data", sid: msg.sid, key: msg.key }));
        const local = await connect(mcPort);
        d.pipe(local);
        local.pipe(d);
        local.on("error", () => d.destroy());
        d.on("close", () => local.destroy());
      })().catch(() => {});
    }
  });
  ctl.on("error", () => {});
  const nextReady = () => new Promise<any>((r) => (onReady = r));
  const first = nextReady();
  ctl.write(tunnel({ t: "hello", v: 1, name: "Tester", uuid, mc: "test", ...extra }));
  const ready = await Promise.race([first, sleep(6000).then(() => ({ t: "timeout" }))]);
  return { ctl, opens, blocked, errors, messages, nextReady, ready };
}

/** Joins `label` as `name`; resolves to what came back first ("MC:" echo or a disconnect text). */
export async function join(port: number, label: string, name: string, domain = DOMAIN): Promise<{ sock: net.Socket; data: string }> {
  const p = await connect(port);
  p.write(Buffer.concat([handshake(label + "." + domain, 2), loginStart(name)]));
  const got = await collect(p, (b) => b.length > 0);
  return { sock: p, data: got.toString() };
}
