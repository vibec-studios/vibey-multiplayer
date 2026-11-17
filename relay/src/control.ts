import * as crypto from "node:crypto";
import type * as net from "node:net";
import { openAccess, parseAccess } from "./access.ts";
import { addressOf, labelFor } from "./addresses.ts";
import { ALLOW_OFFLINE, AUTH_TIMEOUT_MS, DOMAIN, PROTOCOL, PUBLIC_PORT, ROTATIONS_PER_HOUR, log } from "./config.ts";
import { type Host, drop, register } from "./hosts.ts";
import { type Msg, send } from "./lines.ts";
import { hasJoined, normUuid } from "./mojang.ts";

const HOUR = 3_600_000;

export function startControl(sock: net.Socket, ip: string, hello: Msg): (msg: Msg) => void {
  const name = String(hello.name ?? "");
  const claimed = normUuid(hello.uuid);
  if (Number(hello.v) !== PROTOCOL) return fail(sock, "version", "Please update Vibey Multiplayer.");
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name) || claimed.length !== 32) return fail(sock, "bad_hello", "Invalid profile.");

  const serverId = crypto.randomBytes(16).toString("hex");
  const mc = String(hello.mc ?? "").slice(0, 24);
  let access = openAccess();
  let host: Host | null = null;
  let authing = false;

  const authTimer = setTimeout(() => host || sock.destroy(), AUTH_TIMEOUT_MS);
  sock.on("close", () => {
    clearTimeout(authTimer);
    if (!host) return;
    log(`host offline ${host.name}`);
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
    const now = Date.now();
    host = {
      sock, uuid: claimed, name: profile.name, label: labelFor(claimed), ip, mc, since: now, lastSeen: now,
      access, rotations: [], streams: 0, live: new Set(), players: new Map(),
    };
    register(host);
    log(`host online ${host.name} -> ${host.label}`);
    send(sock, ready(host));
  };

  const rotate = (h: Host) => {
    const now = Date.now();
    h.rotations = h.rotations.filter((t) => now - t < HOUR);
    if (h.rotations.length >= ROTATIONS_PER_HOUR) {
      return send(sock, { t: "error", code: "rate_limited", msg: "Too many new addresses. Try again later." });
    }
    h.rotations.push(now);
    const old = h.label;
    h.label = labelFor(h.uuid, true);
    log(`host ${h.name} rotated ${old} -> ${h.label}`);
    send(sock, ready(h));
  };

  return (msg) => {
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
    }
  };
}

function ready(h: Host): Msg {
  return { t: "ready", address: addressOf(h.label), label: h.label, domain: DOMAIN, port: PUBLIC_PORT };
}

function fail(sock: net.Socket, code: string, msg: string): () => void {
  send(sock, { t: "error", code, msg });
  sock.end();
  return () => {};
}
