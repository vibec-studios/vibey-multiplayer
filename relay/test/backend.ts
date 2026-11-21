// End-to-end check of the Vibe Backend contract with a fake backend: npm test

import * as http from "node:http";
import type * as net from "node:net";
import { startLauncherClient } from "./launcher-client.ts";
import { freeUdpPort, freeUdpRange, hostWithUdp } from "./udp-util.ts";
import { DOMAIN, UUID, assert, closed, echoServer, freePort, hostSession, join, line, sleep, startRelay } from "./util.ts";

const SECRET = "test-secret";
const BANNED = "22222222222222222222222222222222";
const CACHED = "33333333333333333333333333333333";
const OTHER = "44444444444444444444444444444444";

type Fake = {
  url: string;
  authorize: any[];
  events: any[];
  acks: any[];
  heartbeats: any[];
  badAuth: number;
  relayIds: Set<string>;
  commands: any[];
  failEvents: number;
  failAuthorize: boolean;
  decide: (req: any) => any;
  heartbeatConfig: any;
  close: () => void;
};

async function fakeBackend(): Promise<Fake> {
  const f: Fake = {
    url: "", authorize: [], events: [], acks: [], heartbeats: [], badAuth: 0, relayIds: new Set(), commands: [], failEvents: 0,
    failAuthorize: false, decide: () => ({ allow: true, maxHosts: 2, maxPlayers: null, ttl: 0 }), heartbeatConfig: null,
    close: () => server.close(),
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    const reply = (code: number, data?: unknown) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    f.relayIds.add(String(req.headers["x-relay-id"]));
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      f.badAuth++;
      return reply(401, { error: "unauthorized" });
    }
    switch (`${req.method} ${req.url}`) {
      case "POST /internal/relay/v1/authorize":
        f.authorize.push(body);
        if (f.failAuthorize) return reply(503);
        return reply(200, f.decide(body));
      case "POST /internal/relay/v1/events":
        if (f.failEvents > 0) {
          f.failEvents--;
          return reply(500);
        }
        f.events.push(...body.events);
        return reply(200, { ok: true });
      case "GET /internal/relay/v1/commands":
        return reply(200, { commands: f.commands.splice(0) });
      case "POST /internal/relay/v1/commands/ack":
        f.acks.push(...body.ids);
        return reply(200, { ok: true });
      case "POST /internal/relay/v1/heartbeat":
        f.heartbeats.push(body);
        return reply(200, { config: f.heartbeatConfig ?? {} });
    }
    reply(404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  f.url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return f;
}

async function until(cond: () => unknown, ms = 4000): Promise<boolean> {
  for (let t = 0; t < ms; t += 50) {
    if (cond()) return true;
    await sleep(50);
  }
  return Boolean(cond());
}

const fast = { BACKEND_EVENTS_MS: "150", BACKEND_COMMANDS_MS: "150", BACKEND_HEARTBEAT_MS: "300", BACKEND_TIMEOUT_MS: "1000" };

async function main() {
  const fake = await fakeBackend();
  const mc = await echoServer();
  // Like the official relay: a new primary domain next to vibey.henny.dev, no explicit RELAY_ID.
  const relay = await startRelay({ BACKEND_URL: fake.url + "/", BACKEND_SECRET: SECRET, DOMAINS: `${DOMAIN},vibey.henny.dev`, ...fast });
  const PORT = relay.port;
  const relays = [relay];

  try {
    // -------------------------------------------------------------------------------------------------- authorize
    fake.decide = () => ({ allow: true, maxHosts: 1, maxPlayers: 1, ttl: 0 });
    const host = await hostSession(PORT, mc.port, { mod: "1.0.0" });
    assert(host.ready.t === "ready", "backend allow -> host online");
    const a = fake.authorize[0];
    assert(a && a.uuid === UUID && a.name === "Tester" && a.ip === "127.0.0.1" && a.client === "mod" && a.kind === "world"
      && a.slot === 0 && a.mc === "test" && a.version === "1.0.0" && a.active === 0, "authorize gets the documented fields");
    assert(fake.badAuth === 0, "every backend call carries the bearer secret");
    assert(fake.relayIds.size === 1 && fake.relayIds.has("vibey.henny.dev"),
      "X-Relay-Id stays vibey.henny.dev with a new primary domain: " + [...fake.relayIds].join(","));

    const second = await hostSession(PORT, mc.port, { slot: 1, kind: "server", client: "launcher" });
    assert(second.ready.t === "error" && second.ready.code === "limit", "maxHosts from the backend is enforced");
    assert(fake.authorize[1].active === 1 && fake.authorize[1].slot === 1, "authorize is told how many hosts are active");

    const replaced = await hostSession(PORT, mc.port);
    assert(replaced.ready.t === "ready" && fake.authorize[2].active === 0, "the slot being replaced is not counted as active");
    assert(await closed(host.ctl), "same slot still replaces");

    fake.decide = (req) => (req.uuid === BANNED
      ? { allow: false, code: "banned", message: "Du bist gesperrt." }
      : { allow: false, code: "limit", message: "Zu viele Welten." });
    const banned = await hostSession(PORT, mc.port, {}, BANNED);
    assert(banned.ready.t === "error" && banned.ready.code === "banned" && banned.ready.msg === "Du bist gesperrt.",
      "backend deny (banned) -> error with the backend's message");
    assert(await closed(banned.ctl), "denied host is disconnected");
    const limited = await hostSession(PORT, mc.port, { slot: 3 }, OTHER);
    assert(limited.ready.code === "limit" && limited.ready.msg === "Zu viele Welten.", "backend deny (limit) is passed on");

    // ------------------------------------------------------------------------------------------------ maxPlayers
    const p1 = await join(PORT, replaced.ready.label, "Alex");
    assert(p1.data.startsWith("MC:"), "first player joins");
    const p2 = await join(PORT, replaced.ready.label, "Bob");
    assert(p2.data.includes("This world is full"), "maxPlayers: the next player gets a friendly 'full' answer");
    assert(!replaced.opens.some((o) => o.name === "Bob"), "the extra player never reaches the host");
    p1.sock.destroy();
    p2.sock.destroy();
    await sleep(100);
    const p3 = await join(PORT, replaced.ready.label, "Bob");
    assert(p3.data.startsWith("MC:"), "a free slot can be taken again");
    p3.sock.destroy();

    // ---------------------------------------------------------------------------------------------------- events
    replaced.ctl.write(line({ t: "access", whitelist: null, banNames: ["griefer"], banIps: [] }));
    await sleep(100);
    (await join(PORT, replaced.ready.label, "Griefer")).sock.destroy();
    assert(await until(() => fake.events.some((e) => e.type === "blocked")), "blocked event arrives");
    await until(() => fake.events.filter((e) => e.type === "player_leave").length >= 2);
    const ev = (type: string) => fake.events.filter((e) => e.type === type && e.uuid === UUID);
    const on = ev("host_online").at(-1);
    assert(on && on.slot === 0 && on.address === replaced.ready.address && !Number.isNaN(Date.parse(on.at)), "host_online event");
    assert(fake.events.every((e) => !e.address || e.address.startsWith(e.address.split(".")[0] + "." + DOMAIN)),
      "event addresses use the primary domain");
    assert(ev("host_offline").length >= 1, "host_offline event for the replaced session");
    const pj = ev("player_join");
    assert(pj.length === 2 && pj[0].player.name === "Alex" && pj[0].ip === "127.0.0.1" && pj[0].player.uuid.length === 32,
      "player_join events with player and ip");
    assert(ev("player_leave").length === 2, "player_leave events");
    assert(ev("blocked")[0].player.name === "Griefer", "blocked event names the player");

    fake.failEvents = 2;
    const before = fake.events.length;
    (await join(PORT, replaced.ready.label, "Carl")).sock.destroy();
    assert(await until(() => fake.events.length >= before + 2, 8000), "events survive backend errors (retry from buffer)");

    // -------------------------------------------------------------------------------------- heartbeat, commands
    assert(await until(() => fake.heartbeats.length > 0), "heartbeat arrives");
    const hb = fake.heartbeats.at(-1);
    assert(typeof hb.version === "string" && hb.hosts === 1 && typeof hb.players === "number" && typeof hb.uptime === "number",
      "heartbeat has version, hosts, players, uptime");

    fake.commands.push({ id: "c1", type: "kick_host", uuid: UUID, slot: 0, message: "Wartung" });
    assert(await until(() => replaced.errors.some((e) => e.code === "kicked" && e.msg === "Wartung")), "kick_host -> host gets an error");
    assert(await closed(replaced.ctl), "kick_host disconnects the host");
    assert(await until(() => fake.acks.includes("c1")), "commands are acknowledged");

    fake.decide = () => ({ allow: true, maxHosts: 3, maxPlayers: null, ttl: 60 });
    const c1 = await hostSession(PORT, mc.port, {}, CACHED);
    const c2 = await hostSession(PORT, mc.port, { slot: 1 }, CACHED);
    assert(c1.ready.t === "ready" && c2.ready.t === "ready", "ttl answer allows both slots");
    assert(fake.authorize.filter((r) => r.uuid === CACHED).length === 1, "authorize answers are cached for ttl seconds");

    fake.commands.push({ id: 7, type: "ban_uuid", uuid: CACHED, message: "Gesperrt." });
    assert(await closed(c1.ctl) && await closed(c2.ctl), "ban_uuid disconnects every host of the account");
    assert(c1.errors[0]?.code === "banned", "banned host is told why");
    const again = await hostSession(PORT, mc.port, {}, CACHED);
    assert(again.ready.code === "banned", "a banned account cannot come back (even with a cached allow)");
    assert(await until(() => fake.acks.includes(7)), "numeric command ids are acknowledged too");

    // --------------------------------------------------------------------------------------------- launcher client
    fake.decide = () => ({ allow: true, maxHosts: 2, maxPlayers: null, ttl: 0 });
    let address = "";
    const launcher = startLauncherClient({
      relayHost: "127.0.0.1", relayPort: PORT, serverPort: mc.port, name: "Tester", uuid: OTHER, slot: 1,
      mc: "1.21.11", version: "0.5.0", onReady: (x) => (address = x),
    });
    assert(await until(() => address), "launcher client gets an address: " + address);
    const la = fake.authorize.at(-1);
    assert(la.client === "launcher" && la.kind === "server" && la.slot === 1 && la.version === "0.5.0", "launcher identifies itself");
    const viaLauncher = await join(PORT, address.split(".")[0], "Dana");
    assert(viaLauncher.data.startsWith("MC:"), "a player reaches the dedicated server through the launcher client");
    viaLauncher.sock.destroy();
    launcher.stop();

    // ----------------------------------------------------------------------------------------------- udp (1.5)
    const ports = await freeUdpRange(2);
    const udpRelay = await startRelay({
      BACKEND_URL: fake.url, BACKEND_SECRET: SECRET, UDP_PORT: String(await freeUdpPort()), UDP_BEDROCK_PORTS: `${ports}-${ports + 1}`, ...fast,
    });
    relays.push(udpRelay);
    fake.decide = (req) => ({ allow: true, maxHosts: 2, maxPlayers: null, ttl: 0, udp: req.uuid === OTHER ? { bedrock: false } : false });
    const u1 = await hostWithUdp(udpRelay.port, mc.port, { voice: 1, bedrock: 2 }, OTHER);
    assert(u1.udp?.channels.voice && u1.udp.denied.bedrock?.code === "disabled", "authorize udp {bedrock:false}: voice yes, bedrock denied");
    const u2 = await hostWithUdp(udpRelay.port, mc.port, { voice: 1 }, UUID, 2);
    assert(u2.udp && !u2.udp.channels.voice && u2.udp.denied.voice?.code === "disabled", "authorize udp:false denies every channel");
    assert(await until(() => fake.heartbeats.some((h) => h.udp?.sessions === 2 && typeof h.udp.peers === "number")),
      "heartbeat reports udp sessions and peers");
    u1.client.stop();
    u2.client.stop();

    // ------------------------------------------------------------------------------------------ fail open/closed
    fake.heartbeatConfig = { maxHostsPerAccount: 1 };
    const beats = fake.heartbeats.length;
    await until(() => fake.heartbeats.length >= beats + 2);
    fake.failAuthorize = true;
    const o1 = await hostSession(PORT, mc.port, {}, OTHER);
    assert(o1.ready.t === "ready", "fail open: backend error -> host still goes online");
    const o2 = await hostSession(PORT, mc.port, { slot: 2 }, OTHER);
    assert(o2.ready.code === "limit", "fail open uses the local limit (here 1 from the heartbeat config)");
    o1.ctl.destroy();

    const dead = `http://127.0.0.1:${await freePort()}`;
    const open = await startRelay({ BACKEND_URL: dead, BACKEND_SECRET: SECRET, ...fast });
    relays.push(open);
    const h1 = await hostSession(open.port, mc.port);
    assert(h1.ready.t === "ready", "fail open (default): unreachable backend -> host online");
    h1.ctl.destroy();

    const shut = await startRelay({ BACKEND_URL: dead, BACKEND_SECRET: SECRET, BACKEND_FAIL_MODE: "closed", ...fast });
    relays.push(shut);
    const h2 = await hostSession(shut.port, mc.port);
    assert(h2.ready.t === "error" && h2.ready.code === "unavailable", "fail closed: unreachable backend -> host refused");

    console.log("\nall backend checks passed");
  } finally {
    for (const r of relays) await r.stop();
    fake.close();
    mc.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
