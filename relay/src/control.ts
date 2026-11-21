import * as crypto from "node:crypto";
import type * as net from "node:net";
import { openAccess, parseAccess } from "./access.ts";
import { addressOf, labelFor } from "./addresses.ts";
import { authorize } from "./backend.ts";
import { ALLOW_OFFLINE, AUTH_TIMEOUT_MS, DOMAIN, MAX_SLOT, PROTOCOL, PUBLIC_PORT, ROTATIONS_PER_HOUR, log } from "./config.ts";
import { type Client, type Host, type Kind, drop, hostsOf, register } from "./hosts.ts";
import { type Msg, send } from "./lines.ts";
import { hasJoined, normUuid } from "./mojang.ts";
import { type ChannelName, parseChannels } from "./udp/config.ts";
import { requestUdp, resendUdp } from "./udp/control.ts";
import { udpAvailable } from "./udp/status.ts";

const HOUR = 3_600_000;
const KINDS: Kind[] = ["world", "server"];
const CLIENTS: Client[] = ["mod", "launcher"];

export function startControl(sock: net.Socket, ip: string, hello: Msg): (msg: Msg) => void {
  const name = String(hello.name ?? "");
  const claimed = normUuid(hello.uuid);
  if (Number(hello.v) !== PROTOCOL) return fail(sock, "version", "Please update Vibey Multiplayer.");
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name) || claimed.length !== 32) return fail(sock, "bad_hello", "Invalid profile.");
  // Optional since relay 1.3; a hello without them is exactly the old one-world-per-account hello.
  const slot = hello.slot == null ? 0 : Number(hello.slot);
  const kind = (hello.kind ?? "world") as Kind;
  // The Vibey Client bundles the multiplayer mod and says "vibey-client"; it hosts like the mod (slot 0 world).
  const rawClient = String(hello.client ?? "mod");
  const client = (rawClient === "vibey-client" ? "mod" : rawClient) as Client;
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) return fail(sock, "bad_hello", `Invalid slot (0-${MAX_SLOT}).`);
  if (!KINDS.includes(kind)) return fail(sock, "bad_hello", "Invalid kind.");
  if (!CLIENTS.includes(client)) return fail(sock, "bad_hello", "Invalid client.");

  const serverId = crypto.randomBytes(16).toString("hex");
  const mc = String(hello.mc ?? "").slice(0, 24);
  const version = String(hello.version ?? hello.mod ?? "").slice(0, 32);
  let access = openAccess();
  let host: Host | null = null;
  let authing = false;
  let udpWanted: ChannelName[] | null = null;

  const authTimer = setTimeout(() => host || sock.destroy(), AUTH_TIMEOUT_MS);
  sock.on("close", () => {
    clearTimeout(authTimer);
    if (!host) return;
    drop(host);
    host = null;
  });
  send(sock, { t: "challenge", serverId });

  const auth = async () => {
    authing = true;
    const profile = ALLOW_OFFLINE ? { id: claimed, name } : await hasJoined(name, serverId);
    if (!profile || normUuid(profile.id) !== claimed) {
      fail(sock, "auth_failed", "Could not verify your Minecraft account.");
      return;
    }
    if (sock.destroyed) return;
    const decision = await authorize({
      uuid: claimed, name: profile.name, ip, client, kind, slot, mc, version, active: hostsOf(claimed, slot).length,
    });
    if (sock.destroyed) return;
    if (!decision.allow) {
      log(`host refused ${profile.name}#${slot}: ${decision.code}`);
      fail(sock, decision.code, decision.message);
      return;
    }
    // Counted again after the await: another slot of the same account may have come online meanwhile.
    const others = hostsOf(claimed, slot).length;
    if (others >= decision.maxHosts) {
      log(`host refused ${profile.name}#${slot}: limit ${decision.maxHosts}`);
      const msg = decision.maxHosts === 0
        ? "Hosting is not available for this account."
        : `This account already hosts ${others} of ${decision.maxHosts} possible worlds or servers. Stop one first.`;
      fail(sock, "limit", msg);
      return;
    }
    const now = Date.now();
    host = {
      sock, uuid: claimed, name: profile.name, slot, kind, client, version, maxPlayers: decision.maxPlayers,
      label: labelFor(claimed, slot), ip, mc, since: now, lastSeen: now,
      access, rotations: [], streams: 0, live: new Set(), players: new Map(), udpAllow: decision.udp,
    };
    register(host);
    log(`host online ${host.name}#${slot} (${client} ${kind}) -> ${host.label}`);
    send(sock, ready(host));
    if (udpWanted) requestUdp(host, udpWanted);
  };

  const rotate = (h: Host) => {
    const now = Date.now();
    h.rotations = h.rotations.filter((t) => now - t < HOUR);
    if (h.rotations.length >= ROTATIONS_PER_HOUR) {
      return send(sock, { t: "error", code: "rate_limited", msg: "Too many new addresses. Try again later." });
    }
    h.rotations.push(now);
    const old = h.label;
    h.label = labelFor(h.uuid, h.slot, true);
    log(`host ${h.name}#${h.slot} rotated ${old} -> ${h.label}`);
    send(sock, ready(h));
    resendUdp(h);
  };

  return (msg) => {
    // A replaced or kicked session may still talk until its socket closes; it must not touch the slot anymore.
    if (host?.gone) return;
    if (host) host.lastSeen = Date.now();
    switch (msg.t) {
      case "ping":
        return send(sock, { t: "pong" });
      case "access":
        access = parseAccess(msg);
        if (host) host.access = access;
        return;
      case "auth":
        if (!host && !authing) void auth();
        return;
      case "rotate":
        if (host) rotate(host);
        return;
      case "udp":
        udpWanted = parseChannels(msg.channels);
        if (host) requestUdp(host, udpWanted);
        return;
    }
  };
}

function ready(h: Host): Msg {
  return {
    t: "ready", address: addressOf(h.label), label: h.label, domain: DOMAIN, port: PUBLIC_PORT, slot: h.slot,
    features: udpAvailable() ? ["udp"] : [],
  };
}

function fail(sock: net.Socket, code: string, msg: string): () => void {
  send(sock, { t: "error", code, msg });
  sock.end();
  return () => {};
}
