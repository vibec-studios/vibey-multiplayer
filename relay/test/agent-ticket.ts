// Vibe Server Agent hosting with a relay ticket instead of the Mojang session (relay 1.7): npm test

import { SECRET, fakeBackend, until } from "./fake-backend.ts";
import { startLauncherClient } from "./launcher-client.ts";
import { freeUdpPort } from "./udp-util.ts";
import { assert, closed, echoServer, freePort, hostSession, join, line, sleep, startRelay } from "./util.ts";

const OWNER = "55555555555555555555555555555555";
const STRANGER = "66666666666666666666666666666666";
const fast = { BACKEND_EVENTS_MS: "150", BACKEND_COMMANDS_MS: "150", BACKEND_HEARTBEAT_MS: "300", KICK_GRACE_MS: "300" };

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number, n = 0) => `${b64({ alg: "HS256" })}.${b64({ sub: OWNER, exp, n })}.c2lnbmF0dXJl${n}`;
const soon = () => Math.floor(Date.now() / 1000) + 300;
const agentHello = (slot: number) => ({ client: "agent", kind: "server", slot, version: "0.1.0", mc: "1.21.11", name: "Owner" });

async function main() {
  const fake = await fakeBackend();
  const mc = await echoServer();
  const relay = await startRelay({ BACKEND_URL: fake.url, BACKEND_SECRET: SECRET, ALLOW_OFFLINE: "", SESSION_SERVER: fake.url, UDP_PORT: String(await freeUdpPort()), ...fast });
  const relays = [relay];
  const PORT = relay.port;
  const good = jwt(soon(), 1);
  fake.tickets.set(good, { uuid: "55555555-5555-5555-5555-555555555555", name: "Owner", agentId: "ag_1", serverId: "srv_1" });
  fake.decide = () => ({ allow: true, maxHosts: 3, maxPlayers: 5, ttl: 0, udp: { voice: true, bedrock: false } });

  try {
    // ----------------------------------------------------------------------------------------- ticket accepted
    const host = await hostSession(PORT, mc.port, agentHello(2), OWNER, 6000, { ticket: good });
    assert(host.ready.t === "ready" && host.ready.slot === 2, "valid agent ticket -> host online without a Mojang session: " + JSON.stringify(host.ready));
    assert(fake.ticketChecks.length === 1 && fake.ticketChecks[0] === good, "the relay checks the ticket at the backend");
    assert(fake.badAuth === 0, "the ticket check carries the relay secret");
    const a = fake.authorize.at(-1);
    assert(a.uuid === OWNER && a.name === "Owner" && a.client === "launcher" && a.kind === "server" && a.slot === 2,
      "authorize: owner account, client launcher (known to every backend), kind server: " + JSON.stringify(a));
    assert(a.agent?.id === "ag_1" && a.agent?.serverId === "srv_1", "authorize is told which agent and server");
    const label = host.ready.label;

    const p = await join(PORT, label, "Alex");
    assert(p.data.startsWith("MC:"), "a player reaches the agent's server");
    const jc = fake.joinChecks.at(-1);
    assert(jc?.uuid === OWNER && jc.slot === 2 && jc.player.name === "Alex", "join-check runs for the owner and slot");
    assert(await until(() => fake.events.some((e) => e.type === "host_online" && e.uuid === OWNER && e.slot === 2)), "host_online for the owner");

    fake.commands.push({ id: "kp", type: "kick_player", uuid: OWNER, slot: 2, player: { uuid: null, name: "alex" }, message: "Raus" });
    assert(await until(() => host.messages.some((m) => m.t === "kick" && m.name === "alex")), "kick_player reaches the agent host");
    assert(await closed(p.sock, 8000), "kick_player cuts the player");

    host.ctl.write(line({ t: "udp", channels: ["voice", "bedrock"] }));
    assert(await until(() => host.messages.some((m) => m.t === "udp_ready")), "agent host gets udp_ready");
    const udp = host.messages.find((m) => m.t === "udp_ready");
    assert(udp.channels.voice && udp.denied.bedrock && !udp.channels.bedrock, "udp channels follow the backend's authorize answer");

    fake.commands.push({ id: "kh", type: "kick_host", uuid: OWNER, slot: 2, message: "Wartung" });
    assert(await until(() => host.errors.some((e) => e.code === "kicked")), "kick_host reaches the agent host");
    assert(await closed(host.ctl), "kick_host disconnects the agent host");

    // ------------------------------------------------------------------------------------------- refused tickets
    const checks = () => fake.ticketChecks.length;
    let before = checks();
    const old = await hostSession(PORT, mc.port, agentHello(3), OWNER, 6000, { ticket: jwt(Math.floor(Date.now() / 1000) - 5) });
    assert(old.ready.t === "error" && old.ready.code === "ticket_expired", "expired ticket -> ticket_expired");
    assert(checks() === before, "an expired ticket is refused without asking the backend");
    assert(await closed(old.ctl), "expired ticket -> disconnected");

    before = checks();
    const unknown = await hostSession(PORT, mc.port, agentHello(3), OWNER, 6000, { ticket: jwt(soon(), 2) });
    assert(unknown.ready.code === "ticket_invalid" && checks() === before + 1, "backend 401 -> ticket_invalid");
    assert(await closed(unknown.ctl), "invalid ticket -> disconnected");

    const garbage = await hostSession(PORT, mc.port, agentHello(3), OWNER, 6000, { ticket: "x" });
    assert(garbage.ready.code === "ticket_invalid", "malformed ticket -> ticket_invalid");
    const empty = await hostSession(PORT, mc.port, agentHello(3), OWNER, 6000, { ticket: "" });
    assert(empty.ready.code === "ticket_invalid", "empty ticket never falls back to the Mojang check");

    const other = await hostSession(PORT, mc.port, { ...agentHello(3), name: "Stranger" }, STRANGER, 6000, { ticket: good });
    assert(other.ready.code === "ticket_invalid", "a ticket of another account -> ticket_invalid");
    assert(!fake.authorize.some((r) => r.uuid === STRANGER), "a refused ticket never reaches authorize");

    fake.ticketStatus = 503;
    const down = await hostSession(PORT, mc.port, agentHello(3), OWNER, 6000, { ticket: good });
    assert(down.ready.code === "unavailable", "backend error on the ticket check -> unavailable (also in fail-open mode)");
    fake.ticketStatus = 200;

    const plain = await hostSession(PORT, mc.port, { slot: 4, kind: "server", client: "launcher" }, OWNER, 15_000);
    assert(plain.ready.t === "error" && plain.ready.code === "auth_failed", "without a ticket the Mojang check still applies");

    // ------------------------------------------------------------------------------- reference client with ticket
    let address = "";
    const tickets: string[] = [];
    const agent = startLauncherClient({
      relayHost: "127.0.0.1", relayPort: PORT, serverPort: mc.port, name: "Owner", uuid: OWNER, slot: 5, mc: "1.21.11", version: "0.1.0",
      ticket: () => (tickets.push(good), good),
      onReady: (x) => (address = x),
    });
    assert(await until(() => address), "reference client hosts with a ticket: " + address);
    assert(tickets.length === 1 && fake.authorize.at(-1).slot === 5, "the client fetched one ticket for the connection");
    const viaAgent = await join(PORT, address.split(".")[0], "Bea");
    assert(viaAgent.data.startsWith("MC:"), "players join through the reference agent client");
    viaAgent.sock.destroy();
    agent.stop();

    // ---------------------------------------------------------------------------------------- no / dead backend
    const lonely = await startRelay({ ...fast });
    relays.push(lonely);
    const none = await hostSession(lonely.port, mc.port, agentHello(2), OWNER, 6000, { ticket: good });
    assert(none.ready.code === "auth_failed", "relay without a backend refuses tickets (even with ALLOW_OFFLINE)");

    const dead = await startRelay({ BACKEND_URL: `http://127.0.0.1:${await freePort()}`, BACKEND_SECRET: SECRET, ...fast });
    relays.push(dead);
    const gone = await hostSession(dead.port, mc.port, agentHello(2), OWNER, 10_000, { ticket: good });
    assert(gone.ready.code === "unavailable", "unreachable backend -> unavailable");

    await sleep(50);
    console.log("\nall agent ticket checks passed");
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
