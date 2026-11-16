// End-to-end check of the relay without Minecraft: fake host, fake "integrated server" and fake players.
// Run: node relay/selftest.ts   (or bun relay/selftest.ts)

import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 26000 + Math.floor(Math.random() * 2000);
const DOMAIN = "play.test";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibey-relay-"));

function varint(v: number): Buffer {
  const out: number[] = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
function str(s: string) {
  const b = Buffer.from(s);
  return Buffer.concat([varint(b.length), b]);
}
function packet(id: number, body: Buffer) {
  const inner = Buffer.concat([varint(id), body]);
  return Buffer.concat([varint(inner.length), inner]);
}
function handshake(host: string, next: number) {
  const port = Buffer.alloc(2);
  port.writeUInt16BE(25565);
  return packet(0, Buffer.concat([varint(774), str(host), port, varint(next)]));
}

const MAGIC = Buffer.from([0x00, 0x56, 0x42, 0x59]);

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

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok  " + msg);
}

async function main() {
  const relay = spawn(process.execPath, [path.join(here, "server.ts")], {
    env: { ...process.env, PORT: String(PORT), DOMAIN, DATA_DIR: dataDir, ALLOW_OFFLINE: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await new Promise((r) => setTimeout(r, 800));

  try {
    // 1) Unknown address -> status answer from the relay itself.
    {
      const p = net.connect(PORT, "127.0.0.1");
      await new Promise((r) => p.once("connect", r));
      p.write(Buffer.concat([handshake("nobody-here-11." + DOMAIN, 1), packet(0, Buffer.alloc(0))]));
      const got = await collect(p, (b) => b.includes(Buffer.from("Unknown address")));
      assert(got.length > 0, "unknown address gets a status reply");
      p.destroy();
    }

    // 2) Fake integrated server: echoes everything back prefixed with "MC:".
    const mc = net.createServer((s) => s.on("data", (d) => s.write(Buffer.concat([Buffer.from("MC:"), d]))));
    await new Promise<void>((r) => mc.listen(0, "127.0.0.1", () => r()));
    const mcPort = (mc.address() as net.AddressInfo).port;

    // 3) Host control connection.
    const ctl = net.connect(PORT, "127.0.0.1");
    await new Promise((r) => ctl.once("connect", r));
    const ready = new Promise<any>((resolve) => {
      lines(ctl, (msg) => {
        if (msg.t === "challenge") ctl.write(JSON.stringify({ t: "auth" }) + "\n");
        if (msg.t === "ready") resolve(msg);
        if (msg.t === "open") {
          // Data connection to relay, bridge to the fake integrated server.
          const d = net.connect(PORT, "127.0.0.1", () => {
            d.write(Buffer.concat([MAGIC, Buffer.from(JSON.stringify({ t: "data", sid: msg.sid, key: msg.key }) + "\n")]));
            const local = net.connect(mcPort, "127.0.0.1");
            d.pipe(local);
            local.pipe(d);
          });
        }
      });
    });
    ctl.write(Buffer.concat([MAGIC, Buffer.from(JSON.stringify({ t: "hello", v: 1, name: "Tester", uuid: "0123456789abcdef0123456789abcdef", mc: "test" }) + "\n")]));
    const r1 = await ready;
    assert(/^[a-z]+-[a-z]+-\d\d\.play\.test(:\d+)?$/.test(r1.address), "host gets an address: " + r1.address);

    // 4) Player joins with that address (mixed case + Forge marker) and talks through the tunnel.
    {
      const p = net.connect(PORT, "127.0.0.1");
      await new Promise((r) => p.once("connect", r));
      const hs = handshake(r1.label.toUpperCase() + "." + DOMAIN + ".\0FML3\0", 2);
      p.write(hs);
      const echoed = await collect(p, (b) => b.length >= hs.length + 3);
      assert(echoed.subarray(0, 3).toString() === "MC:" && echoed.subarray(3).equals(hs), "handshake reaches the host unchanged");
      const big = Buffer.alloc(512 * 1024, 7);
      const back = collect(p, (b) => b.length >= big.length + 3 * Math.ceil(big.length / 65536), 8000);
      p.write(big);
      const got = await back;
      assert(got.length >= big.length, "large payload flows through the tunnel (" + got.length + " bytes back)");
      p.destroy();
    }

    // 5) Same account reconnects -> same address.
    // 6) Rotation -> new address, old one is dead.
    const rotated = new Promise<any>((resolve) => lines(ctl, (m) => m.t === "ready" && resolve(m)));
    ctl.write(JSON.stringify({ t: "rotate" }) + "\n");
    const r2 = await rotated;
    assert(r2.label !== r1.label, "rotate gives a new address: " + r2.label);
    {
      const p = net.connect(PORT, "127.0.0.1");
      await new Promise((r) => p.once("connect", r));
      p.write(Buffer.concat([handshake(r1.label + "." + DOMAIN, 1), packet(0, Buffer.alloc(0))]));
      const got = await collect(p, (b) => b.includes(Buffer.from("Unknown address")));
      assert(got.length > 0, "old address no longer reaches the host");
      p.destroy();
    }

    // 7) Host goes away -> address answers "offline", and stays reserved.
    ctl.destroy();
    await new Promise((r) => setTimeout(r, 300));
    {
      const p = net.connect(PORT, "127.0.0.1");
      await new Promise((r) => p.once("connect", r));
      p.write(handshake(r2.label + "." + DOMAIN, 2));
      const got = await collect(p, (b) => b.includes(Buffer.from("offline")));
      assert(got.length > 0, "offline host -> friendly kick message");
      p.destroy();
    }

    // 8) Reconnect keeps the address.
    {
      const c2 = net.connect(PORT, "127.0.0.1");
      await new Promise((r) => c2.once("connect", r));
      const again = new Promise<any>((resolve) =>
        lines(c2, (m) => {
          if (m.t === "challenge") c2.write(JSON.stringify({ t: "auth" }) + "\n");
          if (m.t === "ready") resolve(m);
        }),
      );
      c2.write(Buffer.concat([MAGIC, Buffer.from(JSON.stringify({ t: "hello", v: 1, name: "Tester", uuid: "01234567-89ab-cdef-0123-456789abcdef" }) + "\n")]));
      const r3 = await again;
      assert(r3.label === r2.label, "address survives reconnects");
      c2.destroy();
    }
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
