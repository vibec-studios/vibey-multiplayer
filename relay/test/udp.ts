import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ask, freeUdpPort, freeUdpRange, hostWithUdp, udpClient, udpServer, voice } from "./udp-util.ts";
import { assert, echoServer, join, sleep, startRelay } from "./util.ts";

const U1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const U2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const U3 = "cccccccccccccccccccccccccccccccc";
const labelOf = (address: string) => address.split(".")[0];
const tunnelHello = (token: Buffer) => Buffer.concat([Buffer.from([0x00, 0x56, 0x42, 0x55, 0x01]), token]);

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibey-relay-udp-"));
  const udpPort = await freeUdpPort();
  const base = await freeUdpRange(4);
  const env = { UDP_PORT: String(udpPort), UDP_BEDROCK_PORTS: `${base}-${base + 3}` };
  let relay = await startRelay(env, dataDir);
  const mc = await echoServer();
  const svc = await udpServer((m) => Buffer.concat([Buffer.from("SVC:"), m]));
  const silent = await udpServer(() => null);
  const geyser = await udpServer((m) => (m[0] === 0x01 ? Buffer.alloc(1400, 1) : Buffer.concat([Buffer.from("BED:"), m])));
  const metric = async (name: string) => {
    const text = await (await fetch(`http://127.0.0.1:${relay.httpPort}/metrics`)).text();
    const line = text.split("\n").find((l) => l.startsWith(name + " "));
    return line ? Number(line.split(" ").pop()) : NaN;
  };
  const status = async () => (await (await fetch(`http://127.0.0.1:${relay.httpPort}/status`)).json()).udp;

  try {
    let h1 = await hostWithUdp(relay.port, mc.port, { voice: svc.port, bedrock: geyser.port }, U1);
    assert(h1.udp?.t === "udp_ready", "ready announces udp and the host gets udp_ready");
    const ch = h1.udp.channels;
    assert(ch.voice.port === udpPort && ch.voice.voiceHost === String(udpPort), "voice runs on the shared port, voiceHost is the port");
    assert(ch.bedrock.port >= base && ch.bedrock.port <= base + 3, "bedrock gets a port from the pool: " + ch.bedrock.port);
    assert(ch.bedrock.host === labelOf(h1.address) + ".play.test", "bedrock host is the world address");
    assert(/^[0-9a-f]{32}$/.test(h1.udp.token) && h1.udp.tunnel.port === udpPort, "token and tunnel port are handed out");
    assert(await h1.udpOk, "udp_ok confirms the host tunnel");
    const bedrockPort = ch.bedrock.port;

    const stranger = await udpClient();
    assert((await ask(stranger, udpPort, voice("nobody"), 600)) === null, "voice from an IP without a joined player is dropped");
    assert((await metric(`vibey_udp_dropped_total{reason="unknown"}`)) >= 1, "metrics count unknown voice packets");

    const steve = await join(relay.port, labelOf(h1.address), "Steve");
    assert(steve.data.startsWith("MC:"), "player joined over TCP");
    const talker = await udpClient();
    const hello = voice("hello voice");
    const back = await ask(talker, udpPort, hello);
    assert(back?.equals(Buffer.concat([Buffer.from("SVC:"), hello])) === true, "voice packet reaches the local SVC server and comes back");

    const bedrockPlayer = await udpClient();
    const b1 = await ask(bedrockPlayer, bedrockPort, Buffer.from("hello-bedrock"));
    assert(b1?.toString() === "BED:hello-bedrock", "bedrock packet reaches local Geyser and comes back");

    const pinger = await udpClient();
    const ping = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(9, 2)]);
    assert((await ask(pinger, bedrockPort, ping))?.length === 1400, "first big pong to an unvalidated peer passes");
    assert((await ask(pinger, bedrockPort, ping, 600)) === null, "amplification guard stops further big pongs");
    const session = await ask(pinger, bedrockPort, Buffer.from([0x84, 0, 0, 0]));
    assert(session?.subarray(0, 4).toString() === "BED:", "a RakNet datagram validates the peer");
    assert((await metric(`vibey_udp_dropped_total{reason="amplification"}`)) >= 1, "metrics count amplification drops");

    const forger = await udpClient();
    const forged = await ask(forger, udpPort, tunnelHello(crypto.randomBytes(16)), 600);
    assert(forged === null, "tunnel packet with a wrong token gets no answer");
    assert((await metric(`vibey_udp_dropped_total{reason="auth"}`)) >= 1, "metrics count bad tokens");

    h1.client.pushAccess({ whitelist: null, banNames: [], banIps: ["127.0.0.1"] });
    await sleep(150);
    const banned = await udpClient();
    assert((await ask(banned, bedrockPort, Buffer.from("x"), 600)) === null, "banIps also blocks new bedrock peers");
    assert((await metric(`vibey_udp_dropped_total{reason="banned"}`)) >= 1, "metrics count banned peers");
    h1.client.pushAccess({ whitelist: null, banNames: [], banIps: [] });
    await sleep(150);

    const rotated = h1.next();
    h1.client.rotate();
    const r2 = await Promise.race([rotated, sleep(3000).then(() => null)]);
    assert(r2?.token === h1.udp.token && r2.channels.bedrock.port === bedrockPort, "rotate resends udp_ready, token and port stay");
    assert(r2.channels.bedrock.host !== ch.bedrock.host, "rotate changes the bedrock host name");
    assert((await ask(talker, udpPort, voice("after rotate")))?.toString().startsWith("SVC:") === true, "voice keeps working after rotate");

    const h2 = await hostWithUdp(relay.port, mc.port, { voice: silent.port }, U2);
    const alex = await join(relay.port, labelOf(h2.address), "Alex");
    assert(alex.data.startsWith("MC:"), "the same IP also joined a second world");
    const probe = await udpClient();
    const svcBefore = svc.received.length;
    const p1 = await ask(probe, udpPort, voice("probe 1"));
    assert(p1?.toString().startsWith("SVC:") === true, "ambiguous voice source: the answering world wins");
    assert(silent.received.length === 1 && svc.received.length === svcBefore + 1, "the first packet went to both candidates");
    await ask(probe, udpPort, voice("probe 2"));
    assert(silent.received.length === 1, "after the answer, packets only go to the winning world");

    const st = await status();
    assert(st.enabled && st.sessions === 2 && st.voicePeers >= 2 && st.bedrockPeers >= 2, "status shows udp sessions and peers");
    assert(!JSON.stringify(st).includes("127.0.0.1"), "udp status leaks no IPs");

    steve.sock.destroy();
    alex.sock.destroy();
    await sleep(6000);
    assert((await status()).voicePeers === 0, "voice peers are removed when the player leaves the world");
    assert((await ask(talker, udpPort, voice("gone"), 600)) === null, "voice after leaving is dropped");

    h2.client.stop();
    h1.client.stop();
    await sleep(400);
    const after = await status();
    assert(after.sessions === 0 && after.bedrockPorts.used === 0, "host offline closes udp sessions and frees the bedrock port");
    assert((await ask(bedrockPlayer, bedrockPort, Buffer.from("still?"), 600)) === null, "bedrock port is closed after the host left");

    h1 = await hostWithUdp(relay.port, mc.port, { voice: svc.port, bedrock: geyser.port }, U1);
    assert(h1.udp?.channels.bedrock.port === bedrockPort, "bedrock port is stable across reconnects");
    const elsewhere = await hostWithUdp(relay.port, mc.port, { voice: svc.port, bedrock: geyser.port }, U1);
    assert(elsewhere.udp?.channels.bedrock.port === bedrockPort, "a replacing session gets the same bedrock port at once");
    assert(h1.errors.some((e) => e.startsWith("replaced")), "the old session is replaced");
    h1.client.stop();
    h1 = elsewhere;
    assert((await ask(bedrockPlayer, bedrockPort, Buffer.from("new session")))?.toString() === "BED:new session",
      "bedrock works on the replacing session");
    const other = await hostWithUdp(relay.port, mc.port, { bedrock: geyser.port }, U3);
    assert(other.udp?.channels.bedrock.port !== bedrockPort, "another account gets another bedrock port");
    h1.client.stop();
    other.client.stop();
    await sleep(400);

    await relay.stop();
    relay = await startRelay(env, dataDir);
    h1 = await hostWithUdp(relay.port, mc.port, { bedrock: geyser.port }, U1);
    assert(h1.udp?.channels.bedrock.port === bedrockPort, "bedrock port survives a relay restart");
    const leases = JSON.parse(fs.readFileSync(path.join(dataDir, "udp-ports.json"), "utf8"));
    assert(leases.version === 1 && leases.leases[`${U1}/1`].port === bedrockPort, "port leases are saved to disk");
    h1.client.stop();
    await relay.stop();

    relay = await startRelay({
      UDP_PORT: String(udpPort), UDP_BEDROCK_PORTS: `${base}-${base + 3}`, UDP_CHANNELS: "voice", UDP_PEER_PPS: "20",
      UDP_NEW_PEERS_PER_IP: "3",
    });
    const limited = await hostWithUdp(relay.port, mc.port, { voice: svc.port, bedrock: geyser.port }, U1);
    assert(limited.udp?.denied?.bedrock?.code === "disabled" && limited.udp.channels.voice, "UDP_CHANNELS=voice denies bedrock");
    const bob = await join(relay.port, labelOf(limited.address), "Bob");
    const flood = await udpClient();
    for (let i = 0; i < 200; i++) flood.send(udpPort, voice("flood " + i));
    await sleep(800);
    assert(flood.replies.length > 0 && flood.replies.length < 100, `per-peer packet limit (got ${flood.replies.length} of 200)`);
    assert((await metric(`vibey_udp_dropped_total{reason="rate"}`)) > 0, "metrics count rate drops");
    let answered = 0;
    for (let i = 0; i < 4; i++) if (await ask(await udpClient(), udpPort, voice("new " + i), 500)) answered++;
    assert(answered === 2, `new peers per IP are limited (3 per 10 s, one used by the flood): ${answered} of 4`);
    bob.sock.destroy();
    limited.client.stop();
    await relay.stop();

    relay = await startRelay({});
    const noUdp = await hostWithUdp(relay.port, mc.port, { voice: svc.port }, U1);
    assert(noUdp.address !== "timeout" && noUdp.udp === null, "without UDP_PORT the relay announces no udp and stays TCP only");
    noUdp.client.stop();

    console.log("\nall udp checks passed");
  } finally {
    mc.close();
    svc.close();
    silent.close();
    geyser.close();
    await relay.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
