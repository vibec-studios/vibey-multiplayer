import * as http from "node:http";
import { count } from "./addresses.ts";
import { DOMAIN, DOMAINS, VERSION, log } from "./config.ts";
import { hosts } from "./hosts.ts";
import { udpMetrics, udpStatus } from "./udp/status.ts";

const started = Date.now();

export const totals = { joins: 0, pings: 0, blocked: 0 };

/** Public numbers for the status page: no names, addresses or IPs. `domain` is where new addresses live. */
export function status() {
  const worlds = [...hosts()]
    .map((h) => ({ players: h.players.size, since: new Date(h.since).toISOString(), mc: h.mc, kind: h.kind }))
    .sort((a, b) => b.players - a.players);
  return {
    ok: true,
    version: VERSION,
    domain: DOMAIN,
    domains: DOMAINS,
    time: new Date().toISOString(),
    uptime: Math.round((Date.now() - started) / 1000),
    worlds: worlds.length,
    players: worlds.reduce((n, w) => n + w.players, 0),
    addresses: count(),
    totals,
    health: { relay: "ok", memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
    list: worlds.slice(0, 50),
    udp: udpStatus(),
  };
}

export function serveStatus(port: number): http.Server {
  return http
    .createServer((req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("cache-control", "no-store");
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/health") return res.end("ok");
      if (path === "/status" || path === "/stats") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(status()));
      }
      if (path === "/metrics") {
        res.setHeader("content-type", "text/plain; version=0.0.4");
        return res.end(metrics());
      }
      res.statusCode = 404;
      res.end();
    })
    .listen(port, () => log(`status on :${port}`));
}

function metrics(): string {
  const all = [...hosts()];
  return [
    "# TYPE vibey_hosts gauge",
    `vibey_hosts ${all.length}`,
    "# TYPE vibey_players gauge",
    `vibey_players ${all.reduce((n, h) => n + h.players.size, 0)}`,
    "# TYPE vibey_joins_total counter",
    `vibey_joins_total ${totals.joins}`,
    "# TYPE vibey_pings_total counter",
    `vibey_pings_total ${totals.pings}`,
    "# TYPE vibey_blocked_total counter",
    `vibey_blocked_total ${totals.blocked}`,
    ...udpMetrics(),
    "",
  ].join("\n");
}
