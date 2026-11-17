// Serves the relay /status over HTTPS (behind Traefik + Cloudflare) for the website. Env: PORT, UPSTREAM.

import * as http from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:8765/status";
const CACHE_MS = 5_000;

let cached: { at: number; body: string; ok: boolean } | null = null;

async function load(): Promise<{ body: string; ok: boolean }> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;
  const started = Date.now();
  try {
    const res = await fetch(UPSTREAM, { signal: AbortSignal.timeout(4_000) });
    const data = (await res.json()) as Record<string, any>;
    data.health = { ...(data.health ?? {}), latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
    cached = { at: Date.now(), body: JSON.stringify(data), ok: true };
  } catch (e) {
    const body = {
      ok: false,
      time: new Date().toISOString(),
      worlds: 0,
      players: 0,
      health: { relay: "down", error: (e as Error).message, checkedAt: new Date().toISOString() },
      list: [],
    };
    cached = { at: Date.now(), body: JSON.stringify(body), ok: false };
  }
  return cached;
}

http
  .createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("cache-control", "no-store");
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") return res.end("ok");
    if (path === "/" || path === "/status") {
      const r = await load();
      res.statusCode = r.ok ? 200 : 503;
      res.setHeader("content-type", "application/json");
      return res.end(r.body);
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(PORT, () => console.log(`status proxy on :${PORT} -> ${UPSTREAM}`));
