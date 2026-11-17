import * as http from "node:http";
import { count } from "./addresses.ts";
import { VERSION, log } from "./config.ts";
import { hosts } from "./hosts.ts";

const started = Date.now();

export const totals = { joins: 0, pings: 0, blocked: 0 };

/** Public numbers for the status page: no names, addresses or IPs. */
export function status() {
  const worlds = [...hosts()]
    .map((h) => ({ players: h.players.size, since: new Date(h.since).toISOString(), mc: h.mc, kind: h.kind }))
    .sort((a, b) => b.players - a.players);
  return {
    ok: true,
    version: VERSION,
    time: new Date().toISOString(),
    uptime: Math.round((Date.now() - started) / 1000),
    worlds: worlds.length,
    players: worlds.reduce((n, w) => n + w.players, 0),
    addresses: count(),
    totals,
    health: { relay: "ok", memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
    list: worlds.slice(0, 50),
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
      res.statusCode = 404;
      res.end();
    })
    .listen(port, () => log(`status on :${port}`));
}
