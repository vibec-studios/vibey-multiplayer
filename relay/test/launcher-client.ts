// Reference relay client for a local dedicated server (what the Vibe Launcher does), see relay/README.md.
//
//   MC_ACCESS_TOKEN=… node test/launcher-client.ts --relay relay.axolite.cc:25565 --port 25566 \
//     --name Steve --uuid <uuid> --slot 1 [--voice-port 24454] [--bedrock-port 19132]
//
// relay.axolite.cc is the host name of the official relay; relay.vibey.henny.dev (old builds) reaches the same server.
// Without MC_ACCESS_TOKEN the Mojang join is skipped (only works against a relay with ALLOW_OFFLINE=1).

import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type UdpHost, startUdpHost } from "./udp-host.ts";

const MAGIC = Buffer.from([0x00, 0x56, 0x42, 0x59]);

export type LauncherOptions = {
  relayHost: string;
  relayPort: number;
  /** Port of the local dedicated server; data connections only ever go to 127.0.0.1:serverPort. */
  serverPort: number;
  name: string;
  uuid: string;
  slot: number;
  mc: string;
  version: string;
  /** Minecraft access token for Mojang's joinServer; omit only against ALLOW_OFFLINE relays. */
  accessToken?: string;
  sessionServer?: string;
  /** Vibe Server Agent (relay 1.7): a fresh relay ticket from the Vibe agent gateway instead of the Mojang join. */
  ticket?: () => Promise<string> | string;
  access?: { whitelist: string[] | null; banNames: string[]; banIps: string[] };
  onReady?: (address: string) => void;
  /** Fatal: the relay refused or replaced this host, no retry. */
  onError?: (code: string, msg: string) => void;
  onPlayer?: (name: string, ip: string) => void;
  udp?: { voice?: number; bedrock?: number };
  onUdpReady?: (msg: any) => void;
  onUdpOk?: () => void;
  log?: (...a: unknown[]) => void;
};

export type LauncherClient = { stop: () => void; rotate: () => void; pushAccess: (a: LauncherOptions["access"]) => void };

export function startLauncherClient(o: LauncherOptions): LauncherClient {
  const log = o.log ?? (() => {});
  let stopped = false;
  let control: net.Socket | null = null;
  let backoff = 1000;
  const streams = new Set<net.Socket>();
  let udp: UdpHost | null = null;
  const send = (msg: object) => control && !control.destroyed && control.write(JSON.stringify(msg) + "\n");

  const session = () => {
    const sock = net.connect(o.relayPort, o.relayHost);
    control = sock;
    let online = false;
    let fatal = false;
    let ping: NodeJS.Timeout | null = null;
    let udpAsked = false;
    sock.setNoDelay(true);
    sock.on("connect", () => {
      sock.write(MAGIC);
      send({
        t: "hello", v: 1, name: o.name, uuid: o.uuid, mc: o.mc,
        client: o.ticket ? "agent" : "launcher", kind: "server", slot: o.slot, version: o.version,
      });
      send({ t: "access", ...(o.access ?? { whitelist: null, banNames: [], banIps: [] }) });
      ping = setInterval(() => send({ t: "ping" }), 20_000);
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const lineText = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!lineText) continue;
        const msg = JSON.parse(lineText);
        switch (msg.t) {
          case "challenge":
            if (o.ticket) {
              void Promise.resolve()
                .then(o.ticket)
                .then((ticket) => send({ t: "auth", ticket }), (e) => (log("no relay ticket:", e), send({ t: "auth", ticket: "" })));
              break;
            }
            void joinServer(msg.serverId).then((err) => {
              if (err) log("Mojang join failed:", err);
              send({ t: "auth" });
            });
            break;
          case "ready":
            online = true;
            backoff = 1000;
            o.onReady?.(msg.address);
            if (o.udp && !udpAsked && Array.isArray(msg.features) && msg.features.includes("udp")) {
              udpAsked = true;
              send({ t: "udp", channels: Object.keys(o.udp) });
            }
            break;
          case "udp_ready":
            if (!msg.token) {
              udp?.stop();
              udp = null;
            } else if (udp) udp.update(msg.token, msg.tunnel.port);
            else udp = startUdpHost({ relayHost: o.relayHost, tunnelPort: msg.tunnel.port, token: msg.token, local: o.udp ?? {}, log });
            o.onUdpReady?.(msg);
            break;
          case "udp_ok":
            o.onUdpOk?.();
            break;
          case "open":
            if (msg.name) o.onPlayer?.(msg.name, msg.ip);
            openStream(msg.sid, msg.key);
            break;
          case "replaced":
            fatal = true;
            o.onError?.("replaced", "This server is now hosted somewhere else.");
            break;
          case "error":
            if (msg.code === "rate_limited") break;
            fatal = true;
            o.onError?.(msg.code, msg.msg);
            break;
        }
      }
    });
    sock.on("error", (e) => log("relay:", e.message));
    sock.on("close", () => {
      if (ping) clearInterval(ping);
      udp?.stop();
      udp = null;
      if (stopped || fatal) return;
      if (online) backoff = 1000;
      log(`relay connection lost, retrying in ${backoff} ms`);
      setTimeout(() => !stopped && session(), backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  };

  const openStream = (sid: number, key: string) => {
    const data = net.connect(o.relayPort, o.relayHost);
    const local = net.connect(o.serverPort, "127.0.0.1");
    for (const s of [data, local]) {
      streams.add(s);
      s.setNoDelay(true);
      s.on("error", () => {});
      s.on("close", () => {
        streams.delete(s);
        data.destroy();
        local.destroy();
      });
    }
    // The relay sends the player's handshake right after this line; pipe() buffers it until the server accepts.
    data.on("connect", () => data.write(Buffer.concat([MAGIC, Buffer.from(JSON.stringify({ t: "data", sid, key }) + "\n")])));
    data.pipe(local);
    local.pipe(data);
  };

  const joinServer = async (serverId: string): Promise<string | null> => {
    if (!o.accessToken) return null;
    try {
      const res = await fetch(`${o.sessionServer ?? "https://sessionserver.mojang.com"}/session/minecraft/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken: o.accessToken, selectedProfile: o.uuid.replace(/-/g, ""), serverId }),
        signal: AbortSignal.timeout(8_000),
      });
      return res.status === 204 || res.ok ? null : `HTTP ${res.status}`;
    } catch (e) {
      return (e as Error).message;
    }
  };

  session();
  return {
    stop: () => {
      stopped = true;
      control?.destroy();
      udp?.stop();
      udp = null;
      for (const s of streams) s.destroy();
    },
    rotate: () => send({ t: "rotate" }),
    pushAccess: (a) => send({ t: "access", ...a }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({
    options: {
      relay: { type: "string", default: "relay.axolite.cc:25565" },
      port: { type: "string", default: "25565" },
      name: { type: "string" },
      uuid: { type: "string" },
      slot: { type: "string", default: "1" },
      mc: { type: "string", default: "1.21.11" },
      "voice-port": { type: "string" },
      "bedrock-port": { type: "string" },
    },
  });
  if (!v.name || !v.uuid) {
    console.error("usage: node test/launcher-client.ts --relay host:port --port <server port> --name <name> --uuid <uuid> [--slot 1]");
    process.exit(2);
  }
  const [relayHost, relayPort = "25565"] = v.relay!.split(":");
  startLauncherClient({
    relayHost, relayPort: Number(relayPort), serverPort: Number(v.port), name: v.name, uuid: v.uuid, slot: Number(v.slot),
    mc: v.mc!, version: "launcher-client-test", accessToken: process.env.MC_ACCESS_TOKEN,
    ticket: process.env.VIBE_RELAY_TICKET ? () => process.env.VIBE_RELAY_TICKET! : undefined,
    onReady: (a) => console.log("online:", a),
    onError: (c, m) => (console.error(`refused (${c}): ${m}`), process.exit(1)),
    onPlayer: (n, ip) => console.log(`player ${n} from ${ip}`),
    udp: v["voice-port"] || v["bedrock-port"]
      ? {
        ...(v["voice-port"] ? { voice: Number(v["voice-port"]) } : {}),
        ...(v["bedrock-port"] ? { bedrock: Number(v["bedrock-port"]) } : {}),
      }
      : undefined,
    onUdpReady: (m) => console.log("udp:", JSON.stringify(m.channels), JSON.stringify(m.denied)),
    onUdpOk: () => console.log("udp tunnel works"),
    log: console.log,
  });
}
