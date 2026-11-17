// End-to-end check of the relay with a fake host, a fake integrated server and fake players: npm test

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MAGIC } from "../src/config.ts";
import { packet, string, varInt } from "../src/wire.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 26000 + Math.floor(Math.random() * 2000);
const HTTP_PORT = PORT + 1;
const DOMAIN = "play.test";
const UUID = "0123456789abcdef0123456789abcdef";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibey-relay-"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function handshake(host: string, next: number) {
  const port = Buffer.alloc(2);
  port.writeUInt16BE(25565);
  return packet(0, Buffer.concat([varInt(774), string(host), port, varInt(next)]));
}

const loginStart = (name: string) => packet(0, Buffer.concat([string(name), Buffer.alloc(16, 0xab)]));
const statusRequest = () => packet(0, Buffer.alloc(0));
const line = (msg: object) => Buffer.from(JSON.stringify(msg) + "\n");
const tunnel = (msg: object) => Buffer.concat([MAGIC, line(msg)]);

async function connect(): Promise<net.Socket> {
  const s = net.connect(PORT, "127.0.0.1");
  await new Promise((r) => s.once("connect", r));
  return s;
}

function lines(sock: net.Socket, cb: (msg: any) => void) {
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

function collect(sock: net.Socket, until: (b: Buffer) => boolean, ms = 4000): Promise<Buffer> {
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

const closed = (sock: net.Socket, ms = 4000) =>
  new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    sock.once("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });

async function expectText(payload: Buffer, text: string) {
  const p = await connect();
  p.write(payload);
  const got = await collect(p, (b) => b.includes(Buffer.from(text)));
  p.destroy();
  return got.length > 0;
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok  " + msg);
}

async function hostSession(mcPort: number) {
  const ctl = await connect();
  const opens: any[] = [];
  const blocked: any[] = [];
  const readies: any[] = [];
  let onReady: ((m: any) => void) | null = null;
  lines(ctl, (msg) => {
    if (msg.t === "challenge") ctl.write(line({ t: "auth" }));
    if (msg.t === "blocked") blocked.push(msg);
    if (msg.t === "ready") {
      readies.push(msg);
      onReady?.(msg);
    }
    if (msg.t === "open") {
      opens.push(msg);
      const d = net.connect(PORT, "127.0.0.1", () => {
        d.write(tunnel({ t: "data", sid: msg.sid, key: msg.key }));
        const local = net.connect(mcPort, "127.0.0.1");
        d.pipe(local);
        local.pipe(d);
      });
    }
  });
  const nextReady = () => new Promise<any>((r) => (onReady = r));
  const first = nextReady();
  ctl.write(tunnel({ t: "hello", v: 1, name: "Tester", uuid: UUID, mc: "test" }));
  return { ctl, opens, blocked, nextReady, ready: await first };
}

async function main() {
  const relay = spawn(process.execPath, [path.join(here, "..", "src", "main.ts")], {
    env: { ...process.env, PORT: String(PORT), DOMAIN, DATA_DIR: dataDir, ALLOW_OFFLINE: "1", HTTP_PORT: String(HTTP_PORT) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await sleep(800);

  try {
    assert(await expectText(Buffer.concat([handshake("nobody-here-11." + DOMAIN, 1), statusRequest()]), "Unknown address"),
      "unknown address gets a status reply");

    const mc = net.createServer((s) => s.on("data", (d) => s.write(Buffer.concat([Buffer.from("MC:"), d]))));
    await new Promise<void>((r) => mc.listen(0, "127.0.0.1", () => r()));
    const mcPort = (mc.address() as net.AddressInfo).port;

    const host = await hostSession(mcPort);
    const r1 = host.ready;
    assert(/^[a-z]+-[a-z]+-\d\d\.play\.test(:\d+)?$/.test(r1.address), "host gets an address: " + r1.address);

    {
      const p = await connect();
      const hs = Buffer.concat([handshake(r1.label.toUpperCase() + "." + DOMAIN + ".\0FML3\0", 2), loginStart("Steve")]);
      p.write(hs);
      const echoed = await collect(p, (b) => b.length >= hs.length + 3);
      assert(echoed.subarray(0, 3).toString() === "MC:" && echoed.subarray(3).equals(hs), "handshake reaches the host unchanged");
      assert(host.opens.some((o) => o.name === "Steve" && o.state === 2), "host learns the name of the joining player");
      const st = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/status`)).json();
      assert(st.ok && st.worlds === 1 && st.players === 1, "status API counts 1 world and 1 player");
      assert(!JSON.stringify(st).includes("Steve") && !JSON.stringify(st).includes(r1.label), "status API leaks no names or addresses");
      const big = Buffer.alloc(512 * 1024, 7);
      const back = collect(p, (b) => b.length >= big.length + 3 * Math.ceil(big.length / 65536), 8000);
      p.write(big);
      assert((await back).length >= big.length, "large payload flows through the tunnel");
      p.destroy();
    }

    {
      const p = await connect();
      p.write(Buffer.concat([handshake(r1.label + "." + DOMAIN, 1), statusRequest()]));
      const got = await collect(p, (b) => b.length > 0);
      assert(got.toString().startsWith("MC:"), "server list ping reaches the host");
      p.destroy();
      await sleep(100);
      const st = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/status`)).json();
      assert(st.players === 0 && st.totals.pings === 1, "closed connections leave the player count");
    }

    {
      const d = await connect();
      d.write(tunnel({ t: "data", sid: 1, key: "wrong" }));
      assert(await closed(d), "data connection with a wrong key is dropped");
      const idle = await connect();
      assert(await closed(idle, 10_000), "silent connection is dropped");
    }

    const opensBefore = host.opens.length;
    const deny = (name: string, text: string) => expectText(Buffer.concat([handshake(r1.label + "." + DOMAIN, 2), loginStart(name)]), text);
    host.ctl.write(line({ t: "access", whitelist: ["Alex"], banNames: ["griefer"], banIps: [], messages: { banned: "GEBANNT", whitelist: "NICHT AUF DER LISTE" } }));
    await sleep(100);
    assert(await deny("Steve", "NICHT AUF DER LISTE"), "whitelist blocks players that are not on it");
    assert(await deny("Griefer", "GEBANNT"), "banned name is blocked (case-insensitive)");
    host.ctl.write(line({ t: "access", whitelist: null, banNames: [], banIps: ["127.0.0.1"] }));
    await sleep(100);
    assert(await deny("Alex", "banned"), "banned IP is blocked even with a fresh name");
    assert(host.opens.length === opensBefore, "blocked players never reach the host");
    assert(host.blocked.length === 3, "host is told about every blocked join");
    host.ctl.write(line({ t: "access", whitelist: null, banNames: [], banIps: [] }));
    await sleep(100);

    const rotated = host.nextReady();
    host.ctl.write(line({ t: "rotate" }));
    const r2 = await rotated;
    assert(r2.label !== r1.label, "rotate gives a new address: " + r2.label);
    assert(await expectText(Buffer.concat([handshake(r1.label + "." + DOMAIN, 1), statusRequest()]), "Unknown address"),
      "old address no longer reaches the host");

    host.ctl.destroy();
    await sleep(300);
    assert(await expectText(handshake(r2.label + "." + DOMAIN, 2), "offline"), "offline host -> friendly kick message");

    const again = await hostSession(mcPort);
    assert(again.ready.label === r2.label, "address survives reconnects");

    const second = await hostSession(mcPort);
    assert(await closed(again.ctl), "hosting the same account elsewhere replaces the old session");
    second.ctl.destroy();

    await sleep(400);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "addresses.json"), "utf8"));
    assert(saved.owners[UUID] === r2.label, "addresses are saved to disk");

    mc.close();
    console.log("\nall relay checks passed");
  } finally {
    relay.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
