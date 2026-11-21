// Fake Vibe Backend for the relay tests: records every call and answers like the real one.

import * as http from "node:http";
import type * as net from "node:net";
import { sleep } from "./util.ts";

export const SECRET = "test-secret";

export type Fake = {
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
  joinChecks: any[];
  joinDecide: (req: any) => any;
  joinCheckStatus: number;
  tickets: Map<string, any>;
  ticketChecks: string[];
  ticketStatus: number;
  close: () => void;
};

export async function fakeBackend(): Promise<Fake> {
  const f: Fake = {
    url: "", authorize: [], events: [], acks: [], heartbeats: [], badAuth: 0, relayIds: new Set(), commands: [], failEvents: 0,
    failAuthorize: false, decide: () => ({ allow: true, maxHosts: 2, maxPlayers: null, ttl: 0 }), heartbeatConfig: null,
    joinChecks: [], joinDecide: () => ({ allow: true, role: "guest" }), joinCheckStatus: 200,
    tickets: new Map(), ticketChecks: [], ticketStatus: 200,
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
      case "POST /internal/relay/v1/join-check":
        f.joinChecks.push(body);
        if (f.joinCheckStatus !== 200) return reply(f.joinCheckStatus, { error: { code: "x", message: "x" } });
        return reply(200, f.joinDecide(body));
      case "POST /internal/relay/v1/agent-ticket": {
        f.ticketChecks.push(body?.ticket);
        if (f.ticketStatus !== 200) return reply(f.ticketStatus, { error: { code: "x", message: "x" } });
        const identity = f.tickets.get(body?.ticket);
        if (!identity) return reply(401, { error: { code: "invalid_token", message: "Anmeldung abgelaufen" } });
        return reply(200, identity);
      }
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

export async function until(cond: () => unknown, ms = 4000): Promise<boolean> {
  for (let t = 0; t < ms; t += 50) {
    if (cond()) return true;
    await sleep(50);
  }
  return Boolean(cond());
}
