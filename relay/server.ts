// Vibey Multiplayer Relay
//
// Tunnel for worlds that are hosted inside a normal Minecraft client (the integrated server). Friends join with a
// plain, unmodded Minecraft using a fixed address like `mossy-otter-27.vibey.henny.dev`; the relay reads the host
// name out of the Minecraft handshake and hands the connection to the client that owns this address.
//
// Every player (Mojang UUID) owns exactly one address. It stays the same across sessions and worlds until the
// player rotates it; after a rotation the old address stops working immediately.
//
// Everything runs on ONE TCP port (default 25565):
//   - Minecraft clients connect normally. No world runs here and nothing is decrypted: in online mode the
//     Minecraft connection is end-to-end encrypted between the joining player and the host.
//   - Hosts (the mod) connect to the same port and start with the magic bytes 0x00 'V' 'B' 'Y'. A Minecraft packet
//     can never start with 0x00 (that would be a zero-length packet), so both kinds of traffic can share the port.
//
// Host protocol: after the magic, newline-delimited JSON.
//   Control connection (one per hosting client):
//     C -> S  {"t":"hello","v":1,"name":"...","uuid":"...","mc":"1.21.11","mod":"1.0.0"}
//     S -> C  {"t":"challenge","serverId":"<hex>"}          client calls Mojang joinServer(serverId)
//     C -> S  {"t":"auth"}                                   relay checks Mojang hasJoined
//     S -> C  {"t":"ready","address":"a-b-12.domain","label":"a-b-12","domain":"domain","port":25565}
//     C -> S  {"t":"rotate"}                                 new address, answered with "ready"
//     C -> S  {"t":"access","whitelist":["name"]|null,"banNames":["name"],"banIps":["1.2.3.4"],
//              "messages":{"banned":"...","whitelist":"..."}}
//             Who may reach this world at all. Enforced here, before a byte reaches the host.
//     S -> C  {"t":"open","sid":7,"key":"<hex>","ip":"1.2.3.4","state":2,"name":"Steve","uuid":"..."}
//             a player knocked, open a data connection (name/uuid only for joins, not for server list pings)
//     S -> C  {"t":"blocked","name":"Steve","ip":"1.2.3.4","reason":"banned"|"whitelist"}
//     C -> S  {"t":"ping"}  /  S -> C {"t":"pong"}
//     S -> C  {"t":"error","code":"...","msg":"..."}, {"t":"replaced"} (same account hosted somewhere else)
//   Data connection (one per joining player):
//     C -> S  {"t":"data","sid":7,"key":"<hex>"}\n followed by raw bytes in both directions.
//
// Environment: PORT (25565), DOMAIN (vibey.henny.dev, the wildcard DNS name), PUBLIC_PORT (shown in addresses,
// defaults to PORT), DATA_DIR (./data), ALLOW_OFFLINE (1 = skip the Mojang check, only for local testing),
// HTTP_PORT (optional: /health and /status for the status page), MAX_STREAMS (64 per host).

import * as net from "node:net";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? 25565);
const DOMAIN = (process.env.DOMAIN ?? "vibey.henny.dev").toLowerCase().replace(/^\.+|\.+$/g, "");
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? PORT);
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const ALLOW_OFFLINE = process.env.ALLOW_OFFLINE === "1";
const HTTP_PORT = process.env.HTTP_PORT ? Number(process.env.HTTP_PORT) : 0;
const MAX_STREAMS = Number(process.env.MAX_STREAMS ?? 64);
const SESSION_SERVER = process.env.SESSION_SERVER ?? "https://sessionserver.mojang.com";

const MAGIC = Buffer.from([0x00, 0x56, 0x42, 0x59]); // 0x00 "VBY"
const PROTOCOL = 1;
const RELAY_VERSION = "1.1.0";
const STARTED = Date.now();
const HANDSHAKE_TIMEOUT_MS = 8_000;
const DATA_CONNECT_TIMEOUT_MS = 10_000;
const CONTROL_IDLE_MS = 75_000;
const MAX_LINE = 8 * 1024;
const ROTATIONS_PER_HOUR = 6;

// ------------------------------------------------------------------------------------------------ Logging

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

// ------------------------------------------------------------------------------------------------ Addresses

const ADJECTIVES = [
  "amber", "brave", "bright", "calm", "chill", "clever", "cosmic", "cozy", "crisp", "dusty", "eager", "fancy",
  "fluffy", "frosty", "fuzzy", "gentle", "giant", "glossy", "golden", "happy", "hidden", "humble", "icy", "jolly",
  "kind", "lazy", "lively", "lucky", "lunar", "mellow", "mighty", "misty", "mossy", "neon", "nimble", "noble",
  "olive", "pixel", "plucky", "polar", "proud", "quick", "quiet", "rapid", "rosy", "royal", "rusty", "shiny",
  "silent", "silver", "sleepy", "snowy", "solar", "spicy", "sunny", "swift", "tidy", "tiny", "vivid", "wild",
  "windy", "witty", "zesty", "zippy",
];
const NOUNS = [
  "axolotl", "badger", "bamboo", "beacon", "bee", "birch", "cactus", "cat", "cave", "comet", "coral", "creeper",
  "crystal", "dolphin", "dragon", "ember", "falcon", "fern", "forest", "fox", "frog", "geode", "glacier", "golem",
  "harbor", "hedgehog", "island", "koala", "lantern", "lava", "lynx", "maple", "meadow", "moon", "moose", "nebula",
  "oak", "ocelot", "otter", "owl", "panda", "parrot", "peak", "pebble", "penguin", "pine", "planet", "rabbit",
  "raven", "reef", "river", "rocket", "salmon", "sloth", "spruce", "squid", "star", "storm", "tiger", "turtle",
  "valley", "volcano", "wolf", "yeti",
];

type Store = { owners: Record<string, string> }; // uuid -> label

const storeFile = path.join(DATA_DIR, "addresses.json");
let store: Store = { owners: {} };
const labelOwner = new Map<string, string>(); // label -> uuid

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    if (raw && typeof raw.owners === "object") store = { owners: raw.owners };
  } catch {
    store = { owners: {} };
  }
  labelOwner.clear();
  for (const [uuid, label] of Object.entries(store.owners)) labelOwner.set(label, uuid);
}

let saveTimer: NodeJS.Timeout | null = null;
function saveStore() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = storeFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
    fs.renameSync(tmp, storeFile);
  }, 200);
}

function randomLabel(): string {
  for (let i = 0; i < 1000; i++) {
    const a = ADJECTIVES[crypto.randomInt(ADJECTIVES.length)];
    const n = NOUNS[crypto.randomInt(NOUNS.length)];
    const d = crypto.randomInt(10, 100);
    const label = `${a}-${n}-${d}`;
    if (!labelOwner.has(label)) return label;
  }
  return crypto.randomBytes(6).toString("hex");
}

function labelFor(uuid: string, rotate: boolean): string {
  const old = store.owners[uuid];
  if (old && !rotate) return old;
  if (old) labelOwner.delete(old);
  const label = randomLabel();
  store.owners[uuid] = label;
  labelOwner.set(label, uuid);
  saveStore();
  return label;
}

function addressOf(label: string): string {
  return PUBLIC_PORT === 25565 ? `${label}.${DOMAIN}` : `${label}.${DOMAIN}:${PUBLIC_PORT}`;
}

// ------------------------------------------------------------------------------------------------ Hosts

type Pending = { player: net.Socket; head: Buffer; timer: NodeJS.Timeout; key: string; login: Login | null; ip: string };

type Login = { name: string; uuid: string };

type Access = {
  whitelist: Set<string> | null; // lower-case names, null = everyone may join
  banNames: Set<string>;
  banIps: Set<string>;
  messages: { banned: string; whitelist: string };
};

type Player = { name: string; uuid: string; ip: string; since: number };

type Host = {
  sock: net.Socket;
  uuid: string;
  name: string;
  label: string;
  ip: string;
  nextSid: number;
  pending: Map<number, Pending>;
  live: Set<net.Socket>;
  rotations: number[];
  lastSeen: number;
  since: number;
  mc: string;
  access: Access;
  players: Map<net.Socket, Player>;
};

const stats = { joins: 0, pings: 0, blocked: 0 };

function defaultAccess(): Access {
  return {
    whitelist: null,
    banNames: new Set(),
    banIps: new Set(),
    messages: { banned: "You are banned from this world.", whitelist: "You are not on the whitelist of this world." },
  };
}

function nameList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z0-9_]{1,16}$/.test(x)).slice(0, 1000);
}

function ipList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim().replace(/^::ffff:/, "")).filter((x) => /^[0-9a-f.:]{3,45}$/i.test(x)).slice(0, 1000);
}

function parseAccess(msg: any): Access {
  const a = defaultAccess();
  a.whitelist = msg.whitelist == null ? null : new Set(nameList(msg.whitelist));
  a.banNames = new Set(nameList(msg.banNames));
  a.banIps = new Set(ipList(msg.banIps));
  if (msg.messages && typeof msg.messages === "object") {
    if (typeof msg.messages.banned === "string") a.messages.banned = msg.messages.banned.slice(0, 256);
    if (typeof msg.messages.whitelist === "string") a.messages.whitelist = msg.messages.whitelist.slice(0, 256);
  }
  return a;
}

const hostsByUuid = new Map<string, Host>();

function sendJson(sock: net.Socket, msg: Record<string, unknown>) {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n");
}

function readyMsg(h: Host) {
  return { t: "ready", address: addressOf(h.label), label: h.label, domain: DOMAIN, port: PUBLIC_PORT };
}

function dropHost(h: Host) {
  if (hostsByUuid.get(h.uuid) === h) hostsByUuid.delete(h.uuid);
  for (const p of h.pending.values()) {
    clearTimeout(p.timer);
    offlineKick(p.player, p.head);
  }
  h.pending.clear();
  for (const s of h.live) s.destroy();
  h.live.clear();
  h.players.clear();
}

// ------------------------------------------------------------------------------------------------ Minecraft wire

function readVarInt(buf: Buffer, off: number): [number, number] | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (off + i >= buf.length) return null;
    const b = buf[off + i];
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return [value, off + i + 1];
  }
  throw new Error("varint too long");
}

function writeVarInt(value: number): Buffer {
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

function mcString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([writeVarInt(b.length), b]);
}

function mcPacket(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

type Handshake = { protocol: number; host: string; port: number; next: number; length: number };

/** Parses the first packet. Returns null when more bytes are needed. */
function parseHandshake(buf: Buffer): Handshake | null {
  const len = readVarInt(buf, 0);
  if (!len) return null;
  const [packetLen, start] = len;
  if (packetLen <= 0 || packetLen > 1024) throw new Error("bad handshake length");
  if (buf.length < start + packetLen) return null;
  let off = start;
  const id = readVarInt(buf, off);
  if (!id || id[0] !== 0) throw new Error("not a handshake");
  off = id[1];
  const proto = readVarInt(buf, off)!;
  off = proto[1];
  const strLen = readVarInt(buf, off)!;
  off = strLen[1];
  if (strLen[0] > 255 * 4) throw new Error("host too long");
  const host = buf.subarray(off, off + strLen[0]).toString("utf8");
  off += strLen[0];
  const port = buf.readUInt16BE(off);
  off += 2;
  const next = readVarInt(buf, off)!;
  return { protocol: proto[0], host, port, next: next[0], length: start + packetLen };
}

/** Login Start (1.20.2+): name + UUID. Returns null when more bytes are needed, throws on garbage. */
function parseLoginStart(buf: Buffer, off: number): Login | null {
  const len = readVarInt(buf, off);
  if (!len) return null;
  const [packetLen, start] = len;
  if (packetLen <= 0 || packetLen > 512) throw new Error("bad login length");
  if (buf.length < start + packetLen) return null;
  let o = start;
  const id = readVarInt(buf, o);
  if (!id || id[0] !== 0) throw new Error("not a login start");
  o = id[1];
  const n = readVarInt(buf, o)!;
  o = n[1];
  if (n[0] > 64) throw new Error("name too long");
  const name = buf.subarray(o, o + n[0]).toString("utf8");
  o += n[0];
  const uuid = start + packetLen - o >= 16 ? buf.subarray(o, o + 16).toString("hex") : "";
  return { name, uuid };
}

/** `Mossy-Otter-27.vibey.henny.dev.\0FML3\0` -> `mossy-otter-27` (or null if it is not one of ours). */
function labelFromHost(host: string): string | null {
  let h = host.split("\0")[0].trim().toLowerCase().replace(/\.+$/, "");
  if (h.endsWith("." + DOMAIN)) h = h.slice(0, -(DOMAIN.length + 1));
  else return null;
  const parts = h.split(".");
  return parts[parts.length - 1] || null;
}

function chat(text: string, color = "gray") {
  return JSON.stringify({ text, color });
}

/** Answers a Minecraft client that cannot reach a host: a status entry in the server list or a kick on join. */
function offlineKick(sock: net.Socket, head: Buffer, reason = "offline", custom?: { title: string; sub: string }) {
  let hs: Handshake | null = null;
  try {
    hs = parseHandshake(head);
  } catch {
    hs = null;
  }
  if (!hs) return sock.destroy();
  const title = custom ? custom.title : reason === "unknown" ? "Unknown address" : "This world is offline";
  const sub = custom
    ? custom.sub
    : reason === "unknown"
      ? "Check the address or ask the host for a new one."
      : "The host is not playing right now. Try again later.";
  if (hs.next === 1) {
    const status = {
      version: { name: "Vibey", protocol: hs.protocol },
      players: { max: 0, online: 0 },
      description: { text: "", extra: [{ text: title + "\n", color: "red" }, { text: sub, color: "gray" }] },
    };
    sock.write(mcPacket(0x00, mcString(JSON.stringify(status))));
    // Wait for the ping (0x01 + long) and echo it so the list shows a latency instead of an error.
    let rest = head.subarray(hs.length);
    const onData = (d: Buffer) => {
      rest = Buffer.concat([rest, d]);
      tryPong();
    };
    const tryPong = () => {
      try {
        while (rest.length) {
          const len = readVarInt(rest, 0);
          if (!len || rest.length < len[1] + len[0]) return;
          const id = readVarInt(rest, len[1]);
          const body = rest.subarray(len[1], len[1] + len[0]);
          rest = rest.subarray(len[1] + len[0]);
          if (id && id[0] === 0x01) {
            sock.end(Buffer.concat([writeVarInt(body.length), body]));
            return;
          }
        }
      } catch {
        sock.destroy();
      }
    };
    sock.on("data", onData);
    tryPong();
    setTimeout(() => sock.destroy(), 5_000);
  } else {
    const msg = JSON.stringify({ text: "", extra: [{ text: title + "\n\n", color: "red" }, { text: sub, color: "gray" }] });
    sock.end(mcPacket(0x00, mcString(msg)));
  }
}

// ------------------------------------------------------------------------------------------------ Mojang auth

async function hasJoined(name: string, serverId: string): Promise<{ id: string; name: string } | null> {
  const url = `${SESSION_SERVER}/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${encodeURIComponent(serverId)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { id?: string; name?: string };
    if (!body.id || !body.name) return null;
    return { id: body.id, name: body.name };
  } catch (e) {
    log("hasJoined failed", (e as Error).message);
    return null;
  }
}

function normUuid(u: string): string {
  return String(u ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
}

// ------------------------------------------------------------------------------------------------ Connections

function lineReader(sock: net.Socket, first: Buffer, onLine: (line: string) => void, onRest?: (rest: Buffer) => boolean) {
  let buf = first;
  const pump = () => {
    let i: number;
    while ((i = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, i).toString("utf8").trim();
      buf = buf.subarray(i + 1);
      if (line) onLine(line);
      if (onRest && onRest(buf)) {
        sock.off("data", onData);
        return;
      }
    }
    if (buf.length > MAX_LINE) sock.destroy();
  };
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    pump();
  };
  sock.on("data", onData);
  pump();
}

function handleTunnel(sock: net.Socket, first: Buffer, ip: string) {
  let onMessage: ((msg: any) => void) | null = null;
  let toRaw: ((rest: Buffer) => void) | null = null;
  lineReader(
    sock,
    first,
    (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return sock.destroy();
      }
      if (onMessage) return onMessage(msg);
      if (toRaw) return;
      if (msg.t === "hello") onMessage = startControl(sock, ip, msg);
      else if (msg.t === "data") toRaw = startData(sock, msg);
      else sock.destroy();
    },
    (rest) => {
      // Data connections switch to raw bytes right after their first line.
      if (!toRaw) return false;
      toRaw(rest);
      return true;
    },
  );
}

function startControl(sock: net.Socket, ip: string, hello: any): ((msg: any) => void) | null {
  const name = String(hello.name ?? "").slice(0, 16);
  const claimed = normUuid(hello.uuid);
  if (Number(hello.v) !== PROTOCOL) {
    sendJson(sock, { t: "error", code: "version", msg: "Please update Vibey Multiplayer." });
    sock.end();
    return null;
  }
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name) || claimed.length !== 32) {
    sendJson(sock, { t: "error", code: "bad_hello", msg: "Invalid profile." });
    sock.end();
    return null;
  }
  const serverId = crypto.randomBytes(16).toString("hex");
  let host: Host | null = null;
  let authing = false;
  let pendingAccess: Access | null = null;
  sendJson(sock, { t: "challenge", serverId });
  sock.setTimeout(CONTROL_IDLE_MS, () => sock.destroy());

  const cleanup = () => {
    if (host) {
      log(`host offline ${host.name}`);
      dropHost(host);
      host = null;
    }
  };
  sock.on("close", cleanup);

  return async (msg: any) => {
    if (msg.t === "ping") {
      if (host) host.lastSeen = Date.now();
      return sendJson(sock, { t: "pong" });
    }
    if (msg.t === "access") {
      const a = parseAccess(msg);
      if (host) host.access = a;
      else pendingAccess = a;
      return;
    }
    if (msg.t === "auth" && !host && !authing) {
      authing = true;
      let uuid = claimed;
      let realName = name;
      if (!ALLOW_OFFLINE) {
        const res = await hasJoined(name, serverId);
        if (!res || normUuid(res.id) !== claimed) {
          sendJson(sock, { t: "error", code: "auth_failed", msg: "Could not verify your Minecraft account." });
          return sock.end();
        }
        uuid = normUuid(res.id);
        realName = res.name;
      }
      if (sock.destroyed) return;
      const prev = hostsByUuid.get(uuid);
      if (prev) {
        sendJson(prev.sock, { t: "replaced" });
        prev.sock.end();
        dropHost(prev);
      }
      host = {
        sock, uuid, name: realName, label: labelFor(uuid, false), ip, nextSid: 1,
        pending: new Map(), live: new Set(), rotations: [], lastSeen: Date.now(), since: Date.now(),
        mc: String(hello.mc ?? "").slice(0, 24), access: pendingAccess ?? defaultAccess(), players: new Map(),
      };
      hostsByUuid.set(uuid, host);
      log(`host online ${realName} -> ${host.label}`);
      return sendJson(sock, readyMsg(host));
    }
    if (!host) return;
    if (msg.t === "rotate") {
      const now = Date.now();
      host.rotations = host.rotations.filter((t) => now - t < 3_600_000);
      if (host.rotations.length >= ROTATIONS_PER_HOUR) {
        return sendJson(sock, { t: "error", code: "rate_limited", msg: "Too many new addresses. Try again later." });
      }
      host.rotations.push(now);
      const old = host.label;
      host.label = labelFor(host.uuid, true);
      log(`host ${host.name} rotated ${old} -> ${host.label}`);
      return sendJson(sock, readyMsg(host));
    }
  };
}

function startData(sock: net.Socket, msg: any): ((rest: Buffer) => void) | null {
  const sid = Number(msg.sid);
  const key = Buffer.from(String(msg.key ?? ""));
  let target: Pending | null = null;
  let owner: Host | null = null;
  for (const h of hostsByUuid.values()) {
    const p = h.pending.get(sid);
    if (p && p.key.length === key.length && crypto.timingSafeEqual(Buffer.from(p.key), key)) {
      target = p;
      owner = h;
      break;
    }
  }
  if (!target || !owner) {
    sock.destroy();
    return null;
  }
  owner.pending.delete(sid);
  clearTimeout(target.timer);
  const player = target.player;
  const head = target.head;
  const login = target.login;
  const pip = target.ip;
  const h = owner;
  sock.setNoDelay(true);
  return (rest: Buffer) => {
    // Bytes the host already sent after its first line belong to the player.
    if (rest.length) player.write(rest);
    sock.write(head);
    player.pipe(sock);
    sock.pipe(player);
    player.resume();
    h.live.add(player);
    h.live.add(sock);
    if (login) {
      stats.joins++;
      h.players.set(player, { name: login.name, uuid: login.uuid, ip: pip, since: Date.now() });
    }
    const done = () => {
      h.live.delete(player);
      h.live.delete(sock);
      h.players.delete(player);
      player.destroy();
      sock.destroy();
    };
    player.on("close", done);
    sock.on("close", done);
    player.on("error", done);
    sock.on("error", done);
  };
}

function blockedText(host: Host, reason: "banned" | "whitelist") {
  return { title: reason === "banned" ? host.access.messages.banned : host.access.messages.whitelist, sub: "" };
}

function handlePlayer(sock: net.Socket, first: Buffer, ip: string) {
  let buf = first;
  let hs: Handshake | null = null;
  const timer = setTimeout(() => sock.destroy(), HANDSHAKE_TIMEOUT_MS);
  const attempt = () => {
    let login: Login | null = null;
    let host: Host | undefined;
    let uuid: string | undefined;
    try {
      if (!hs) hs = parseHandshake(buf);
      if (hs) {
        const label = labelFromHost(hs.host);
        uuid = label ? labelOwner.get(label) : undefined;
        host = uuid ? hostsByUuid.get(uuid) : undefined;
      }
      // Joins send Login Start right after the handshake; we need the name for whitelist and ban list.
      if (hs && host && hs.next !== 1) login = parseLoginStart(buf, hs.length);
    } catch {
      clearTimeout(timer);
      return sock.destroy();
    }
    if (!hs || (host && hs.next !== 1 && !login)) {
      if (buf.length > 4096) {
        clearTimeout(timer);
        sock.destroy();
      }
      return;
    }
    clearTimeout(timer);
    sock.off("data", onData);
    sock.pause();
    if (!host) {
      sock.resume();
      return offlineKick(sock, buf, uuid ? "offline" : "unknown");
    }

    // Network level access control: blocked players never reach the host.
    const acc = host.access;
    let blocked: "banned" | "whitelist" | null = null;
    if (acc.banIps.has(ip)) blocked = "banned";
    else if (login && acc.banNames.has(login.name.toLowerCase())) blocked = "banned";
    else if (login && acc.whitelist && !acc.whitelist.has(login.name.toLowerCase())) blocked = "whitelist";
    if (blocked) {
      stats.blocked++;
      sock.resume();
      if (login) sendJson(host.sock, { t: "blocked", name: login.name, ip, reason: blocked });
      return offlineKick(sock, buf, "blocked", blockedText(host, blocked));
    }

    if (host.pending.size + host.live.size / 2 >= MAX_STREAMS) {
      sock.resume();
      return offlineKick(sock, buf, "offline");
    }
    if (hs.next === 1) stats.pings++;
    const sid = host.nextSid++;
    const key = crypto.randomBytes(16).toString("hex");
    const head = buf;
    const p: Pending = {
      player: sock,
      head,
      key,
      login,
      ip,
      timer: setTimeout(() => {
        host.pending.delete(sid);
        sock.resume();
        offlineKick(sock, head, "offline");
      }, DATA_CONNECT_TIMEOUT_MS),
    };
    host.pending.set(sid, p);
    const open: Record<string, unknown> = { t: "open", sid, key, ip, state: hs.next };
    if (login) {
      open.name = login.name;
      open.uuid = login.uuid;
    }
    sendJson(host.sock, open);
  };
  const onData = (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    attempt();
  };
  sock.on("data", onData);
  attempt();
}

const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  const ip = (sock.remoteAddress ?? "?").replace(/^::ffff:/, "");
  sock.on("error", () => sock.destroy());
  sock.once("data", (first: Buffer) => {
    if (first.length >= 1 && first[0] === 0xfe) return sock.destroy(); // legacy ping, nothing to show
    if (first[0] === 0x00) {
      if (first.length < MAGIC.length || !first.subarray(0, MAGIC.length).equals(MAGIC)) return sock.destroy();
      return handleTunnel(sock, first.subarray(MAGIC.length), ip);
    }
    handlePlayer(sock, first, ip);
  });
});

loadStore();
server.listen(PORT, () => log(`Vibey relay on :${PORT}, addresses *.${DOMAIN}${ALLOW_OFFLINE ? " (offline mode!)" : ""}`));

/** Public numbers for the status page. No names, no addresses, no IPs. */
function statusJson() {
  const worlds = [...hostsByUuid.values()].map((h) => ({
    players: h.players.size,
    since: new Date(h.since).toISOString(),
    mc: h.mc,
  }));
  worlds.sort((a, b) => b.players - a.players);
  const mem = process.memoryUsage();
  return {
    ok: true,
    version: RELAY_VERSION,
    time: new Date().toISOString(),
    uptime: Math.round((Date.now() - STARTED) / 1000),
    worlds: worlds.length,
    players: worlds.reduce((n, w) => n + w.players, 0),
    addresses: labelOwner.size,
    totals: { joins: stats.joins, pings: stats.pings, blocked: stats.blocked },
    health: { relay: "ok", memoryMb: Math.round(mem.rss / 1048576) },
    list: worlds.slice(0, 50),
  };
}

if (HTTP_PORT) {
  http
    .createServer((req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("cache-control", "no-store");
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/health") return res.end("ok");
      if (path === "/status" || path === "/stats") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(statusJson()));
      }
      res.statusCode = 404;
      res.end();
    })
    .listen(HTTP_PORT, () => log(`status on :${HTTP_PORT}`));
}

// Drop hosts that stopped pinging (sleeping laptops, dead NATs).
setInterval(() => {
  const now = Date.now();
  for (const h of hostsByUuid.values()) if (now - h.lastSeen > CONTROL_IDLE_MS) h.sock.destroy();
}, 15_000).unref();

export { parseHandshake, labelFromHost, writeVarInt, mcPacket, mcString };
