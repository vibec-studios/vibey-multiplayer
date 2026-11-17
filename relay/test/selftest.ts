// End-to-end check of the relay with a fake host, a fake integrated server and fake players: npm test

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DOMAIN, UUID, assert, closed, collect, connect, echoServer, expectText, handshake, hostSession, join, line,
  loginStart, sleep, startRelay, statusRequest, tunnel,
} from "./util.ts";

const OLD_UUID = "fedcba9876543210fedcba9876543210";

async function main() {
  // An addresses.json from relay 1.2 (format 1): must keep working and be upgraded.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibey-relay-"));
  fs.writeFileSync(path.join(dataDir, "addresses.json"), JSON.stringify({ owners: { [OLD_UUID]: "brave-fox-42" } }));
  let relay = await startRelay({}, dataDir);
  const PORT = relay.port;
  const HTTP_PORT = relay.httpPort;
  const mc = await echoServer();

  try {
    assert(await expectText(PORT, Buffer.concat([handshake("nobody-here-11." + DOMAIN, 1), statusRequest()]), "Unknown address"),
      "unknown address gets a status reply");

    const host = await hostSession(PORT, mc.port);
    const r1 = host.ready;
    assert(/^[a-z]+-[a-z]+-\d\d\.play\.test(:\d+)?$/.test(r1.address), "host gets an address: " + r1.address);

    {
      const p = await connect(PORT);
      const hs = Buffer.concat([handshake(r1.label.toUpperCase() + "." + DOMAIN + ".\0FML3\0", 2), loginStart("Steve")]);
      p.write(hs);
      const echoed = await collect(p, (b) => b.length >= hs.length + 3);
      assert(echoed.subarray(0, 3).toString() === "MC:" && echoed.subarray(3).equals(hs), "handshake reaches the host unchanged");
      assert(host.opens.some((o) => o.name === "Steve" && o.state === 2), "host learns the name of the joining player");
      const st = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/status`)).json();
      assert(st.ok && st.worlds === 1 && st.players === 1, "status API counts 1 world and 1 player");
      assert(!JSON.stringify(st).includes("Steve") && !JSON.stringify(st).includes(r1.label), "status API leaks no names or addresses");
      const big = Buffer.alloc(512 * 1024, 7);
      // The echo server prefixes every chunk with "MC:", so count the payload bytes themselves.
      const sevens = (b: Buffer) => b.reduce((n, x) => n + (x === 7 ? 1 : 0), 0);
      const back = collect(p, (b) => sevens(b) >= big.length, 15_000);
      p.write(big);
      assert(sevens(await back) === big.length, "large payload flows through the tunnel");
      p.destroy();
    }

    {
      const p = await connect(PORT);
      p.write(Buffer.concat([handshake(r1.label + "." + DOMAIN, 1), statusRequest()]));
      const got = await collect(p, (b) => b.length > 0);
      assert(got.toString().startsWith("MC:"), "server list ping reaches the host");
      p.destroy();
      await sleep(100);
      const st = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/status`)).json();
      assert(st.players === 0 && st.totals.pings === 1, "closed connections leave the player count");
    }

    {
      const d = await connect(PORT);
      d.write(tunnel({ t: "data", sid: 1, key: "wrong" }));
      assert(await closed(d), "data connection with a wrong key is dropped");
      const idle = await connect(PORT);
      assert(await closed(idle, 10_000), "silent connection is dropped");
    }

    const opensBefore = host.opens.length;
    const deny = (name: string, text: string) =>
      expectText(PORT, Buffer.concat([handshake(r1.label + "." + DOMAIN, 2), loginStart(name)]), text);
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
    assert(await expectText(PORT, Buffer.concat([handshake(r1.label + "." + DOMAIN, 1), statusRequest()]), "Unknown address"),
      "old address no longer reaches the host");

    host.ctl.destroy();
    await sleep(300);
    assert(await expectText(PORT, handshake(r2.label + "." + DOMAIN, 2), "offline"), "offline host -> friendly kick message");

    const again = await hostSession(PORT, mc.port);
    assert(again.ready.label === r2.label, "address survives reconnects");

    const second = await hostSession(PORT, mc.port);
    assert(await closed(again.ctl), "hosting the same account elsewhere replaces the old session");
    assert(again.messages.some((m) => m.t === "replaced"), "the old session is told it was replaced");

    // ------------------------------------------------------------------------------------ several hosts per account

    const server = await hostSession(PORT, mc.port, { slot: 1, kind: "server", client: "launcher", version: "0.9.0" });
    assert(server.ready.t === "ready" && server.ready.label !== r2.label, "slot 1 gets its own address: " + server.ready.label);
    assert(!second.ctl.destroyed && (await sleep(200), !second.ctl.destroyed), "a second slot does not replace slot 0");
    {
      const a = await join(PORT, r2.label, "Alex");
      const b = await join(PORT, server.ready.label, "Bob");
      assert(a.data.startsWith("MC:") && b.data.startsWith("MC:"), "both addresses of one account reach their host");
      assert(second.opens.some((o) => o.name === "Alex") && server.opens.some((o) => o.name === "Bob")
        && !second.opens.some((o) => o.name === "Bob"), "players are routed to the right slot");
      a.sock.destroy();
      b.sock.destroy();
    }
    const third = await hostSession(PORT, mc.port, { slot: 2, kind: "server", client: "launcher" });
    assert(third.ready.t === "error" && third.ready.code === "limit", "a third slot hits MAX_HOSTS_PER_ACCOUNT (2)");
    assert(await closed(third.ctl), "refused host is disconnected");

    const serverAgain = await hostSession(PORT, mc.port, { slot: 1, kind: "server", client: "launcher" });
    assert(serverAgain.ready.label === server.ready.label, "slot address is stable");
    assert(await closed(server.ctl), "same (account, slot) replaces");
    assert(!second.ctl.destroyed, "replacing slot 1 leaves slot 0 alone");

    const rot = serverAgain.nextReady();
    serverAgain.ctl.write(line({ t: "rotate" }));
    const r3 = await rot;
    assert(r3.label !== server.ready.label && r3.slot === 1, "slot 1 rotates on its own");
    const zero = await hostSession(PORT, mc.port, {}, UUID);
    assert(zero.ready.label === r2.label, "slot 0 keeps the classic address after slot 1 rotated");

    const bad = await hostSession(PORT, mc.port, { slot: 999 }, "11111111111111111111111111111111");
    assert(bad.ready.t === "error" && bad.ready.code === "bad_hello", "an invalid slot is refused");

    const old = await hostSession(PORT, mc.port, {}, OLD_UUID);
    assert(old.ready.label === "brave-fox-42", "addresses from a format-1 file keep working");

    zero.ctl.destroy();
    serverAgain.ctl.destroy();
    old.ctl.destroy();
    second.ctl.destroy();
    await sleep(500);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "addresses.json"), "utf8"));
    assert(saved.version === 2 && saved.owners[UUID] === r2.label && saved.owners[OLD_UUID] === "brave-fox-42",
      "addresses are saved to disk (format 2, slot 0 under owners)");
    assert(saved.slots[UUID]["1"] === r3.label, "slot addresses are saved to disk");
    assert(fs.existsSync(path.join(dataDir, "addresses.v1.json")), "the format-1 file is kept as a backup");

    await relay.stop();
    relay = await startRelay({}, dataDir);
    const back0 = await hostSession(relay.port, mc.port);
    const back1 = await hostSession(relay.port, mc.port, { slot: 1, kind: "server", client: "launcher" });
    assert(back0.ready.label === r2.label && back1.ready.label === r3.label, "slot addresses survive a relay restart");
    back0.ctl.destroy();
    back1.ctl.destroy();

    console.log("\nall relay checks passed");
  } finally {
    mc.close();
    await relay.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
