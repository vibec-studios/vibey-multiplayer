import {
  BACKEND_COMMANDS_MS, BACKEND_FAIL_MODE, BACKEND_HEARTBEAT_MS, BACKEND_SECRET, BACKEND_TIMEOUT_MS, BACKEND_URL,
  MAX_HOSTS_PER_ACCOUNT, MAX_PLAYERS_PER_HOST, RELAY_ID, VERSION, log,
} from "./config.ts";
import { type RelayEvent, flushEvents, startEvents } from "./events.ts";
import { type Client, type Kind, hosts, kick } from "./hosts.ts";
import { normUuid } from "./mojang.ts";

/** Optional connection to the Vibe Backend (contract: relay/README.md, "Backend"). */
export const enabled = Boolean(BACKEND_URL && BACKEND_SECRET);

export type AuthorizeRequest = {
  uuid: string; name: string; ip: string; client: Client; kind: Kind; slot: number; mc: string; version: string;
  /** Other hosts of this account online on this worker (a host on the same slot would be replaced, so not counted). */
  active: number;
};
export type Decision =
  | { allow: true; maxHosts: number; maxPlayers: number | null }
  | { allow: false; code: string; message: string };

/** Limits without a backend, or when it is unreachable in fail-open mode. Changed by `config` commands. */
export const settings = {
  maxHostsPerAccount: MAX_HOSTS_PER_ACCOUNT,
  maxPlayers: (MAX_PLAYERS_PER_HOST || null) as number | null,
  failMode: BACKEND_FAIL_MODE,
};

const BAN_MESSAGE = "This Minecraft account may not host on Vibey.";
const UNAVAILABLE = "Vibey is not available right now. Please try again in a moment.";

/** uuid -> message. Filled by `ban_uuid` commands; after a restart the backend's authorize answer takes over. */
const banned = new Map<string, string>();
const cache = new Map<string, { until: number; decision: Decision }>();

export async function authorize(req: AuthorizeRequest): Promise<Decision> {
  const ban = banned.get(req.uuid);
  if (ban !== undefined) return { allow: false, code: "banned", message: ban };
  if (!enabled) return local();

  // The backend may decide differently for worlds and servers, so those are cached apart.
  const key = `${req.uuid}/${req.client}/${req.kind}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.decision;
  cache.delete(key);

  let body: any;
  try {
    body = await callWithRetry("/authorize", req);
    healthy("authorize");
  } catch (e) {
    trouble("authorize", e);
    if (settings.failMode === "closed") return { allow: false, code: "unavailable", message: UNAVAILABLE };
    return local();
  }
  const decision = parseDecision(body);
  const ttl = Number(body?.ttl);
  // A "limit" answer depends on `active`, so it is never reused.
  if (ttl > 0 && (decision.allow || decision.code !== "limit")) {
    cache.set(key, { until: Date.now() + ttl * 1000, decision });
  }
  return decision;
}

function local(): Decision {
  return { allow: true, maxHosts: settings.maxHostsPerAccount, maxPlayers: settings.maxPlayers };
}

function parseDecision(b: any): Decision {
  if (b?.allow === true) {
    const maxHosts = count(b.maxHosts) ?? settings.maxHostsPerAccount;
    const maxPlayers = b.maxPlayers === null ? null : (count(b.maxPlayers) ?? settings.maxPlayers);
    return { allow: true, maxHosts, maxPlayers };
  }
  const code = typeof b?.code === "string" && /^[a-z_]{1,32}$/.test(b.code) ? b.code : "disabled";
  const message = typeof b?.message === "string" && b.message ? b.message.slice(0, 256) : "Hosting is not allowed for this account.";
  return { allow: false, code, message };
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

// ------------------------------------------------------------------------------------------------ commands, config

export type Command = { id: string | number; type: string; [k: string]: unknown };

export function applyCommand(c: Command) {
  const uuid = normUuid(c.uuid);
  const message = typeof c.message === "string" && c.message ? c.message.slice(0, 256) : undefined;
  switch (c.type) {
    case "kick_host": {
      const slot = c.slot == null ? null : Number(c.slot);
      for (const h of [...hosts()]) {
        if (h.uuid === uuid && (slot === null || h.slot === slot)) kick(h, "kicked", message ?? "You were disconnected by Vibey.");
      }
      return;
    }
    case "ban_uuid":
      if (uuid.length !== 32) return;
      banned.set(uuid, message ?? BAN_MESSAGE);
      forget(uuid);
      for (const h of [...hosts()]) if (h.uuid === uuid) kick(h, "banned", message ?? BAN_MESSAGE);
      return;
    case "unban_uuid":
      banned.delete(uuid);
      forget(uuid);
      return;
    case "config":
      applyConfig(c.config ?? c);
      return;
    default:
      log(`backend: unknown command type ${String(c.type)}, ignored`);
  }
}

function forget(uuid: string) {
  for (const k of cache.keys()) if (k.startsWith(uuid + "/")) cache.delete(k);
}

/** `{ maxHostsPerAccount?, maxPlayers?: number|null, failMode?: "open"|"closed" }`, unknown keys are ignored. */
export function applyConfig(c: any) {
  if (!c || typeof c !== "object") return;
  const before = JSON.stringify(settings);
  const hostsLimit = count(c.maxHostsPerAccount ?? c.maxHosts);
  if (hostsLimit !== undefined) settings.maxHostsPerAccount = hostsLimit;
  if ("maxPlayers" in c) settings.maxPlayers = c.maxPlayers === null ? null : (count(c.maxPlayers) || null);
  if (c.failMode === "open" || c.failMode === "closed") settings.failMode = c.failMode;
  if (JSON.stringify(settings) !== before) {
    cache.clear();
    log("backend: config", JSON.stringify(settings));
  }
}

async function pollCommands() {
  let body: any;
  try {
    body = await call("GET", "/commands");
    healthy("commands");
  } catch (e) {
    return trouble("commands", e);
  }
  const list: Command[] = Array.isArray(body) ? body : Array.isArray(body?.commands) ? body.commands : [];
  const ids: (string | number)[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object" || c.id == null) continue;
    try {
      applyCommand(c);
    } catch (e) {
      log(`backend: command ${String(c.id)} failed:`, (e as Error).message);
    }
    ids.push(c.id);
  }
  if (!ids.length) return;
  try {
    await call("POST", "/commands/ack", { ids });
  } catch (e) {
    trouble("commands/ack", e);
  }
}

async function heartbeat() {
  const all = [...hosts()];
  try {
    const body: any = await call("POST", "/heartbeat", {
      version: VERSION,
      hosts: all.length,
      players: all.reduce((n, h) => n + h.players.size, 0),
      uptime: Math.round(process.uptime()),
    });
    healthy("heartbeat");
    applyConfig(body?.config);
  } catch (e) {
    trouble("heartbeat", e);
  }
}

async function sendEvents(events: RelayEvent[]): Promise<boolean> {
  try {
    await call("POST", "/events", { events });
    healthy("events");
    return true;
  } catch (e) {
    trouble("events", e);
    return false;
  }
}

/** Starts event delivery, command polling and the heartbeat. Returns a function that stops them. */
export function startBackend(): () => Promise<void> {
  if (!enabled) {
    if (BACKEND_URL || BACKEND_SECRET) log("WARNING: BACKEND_URL and BACKEND_SECRET must both be set, backend is off");
    return async () => {};
  }
  log(`backend ${BACKEND_URL} (fail mode ${settings.failMode})`);
  const guard = (f: () => Promise<void>) => {
    let busy = false;
    return () => {
      if (busy) return;
      busy = true;
      void f().finally(() => (busy = false));
    };
  };
  const beat = guard(heartbeat);
  const timers = [
    startEvents(sendEvents),
    setInterval(guard(pollCommands), BACKEND_COMMANDS_MS).unref(),
    setInterval(beat, BACKEND_HEARTBEAT_MS).unref(),
  ];
  setTimeout(beat, 0).unref();
  return async () => {
    for (const t of timers) clearInterval(t);
    await Promise.race([flushEvents(), new Promise((r) => setTimeout(r, 2_000))]);
  };
}

// ------------------------------------------------------------------------------------------------ http

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BACKEND_URL}/internal/relay/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${BACKEND_SECRET}`,
      "user-agent": `VibeyRelay/${VERSION} (+https://github.com/vibec-studios/vibey-multiplayer)`,
      "x-relay-id": RELAY_ID,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Say who answered (backend or a proxy such as Cloudflare) so a block in front of the backend is easy to spot
    const via = res.headers.get("cf-mitigated") ? `cloudflare ${res.headers.get("cf-mitigated")}` : res.headers.get("server") ?? "?";
    const snippet = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`HTTP ${res.status} (${via}) ${snippet}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** One quick retry for errors that are not a timeout (connection refused or reset), so a blip does not fail open. */
async function callWithRetry(path: string, body: unknown): Promise<unknown> {
  try {
    return await call("POST", path, body);
  } catch (e) {
    if ((e as Error).name === "TimeoutError") throw e;
    await new Promise((r) => setTimeout(r, 250));
    return call("POST", path, body);
  }
}

/** Failing endpoint -> when it was last logged. Logs the first failure, then at most every 5 minutes, and the recovery. */
const failing = new Map<string, number>();

function trouble(what: string, e: unknown) {
  const last = failing.get(what);
  const now = Date.now();
  if (last !== undefined && now - last < 300_000) return;
  failing.set(what, now);
  const mode = what === "authorize" ? ` (fail ${settings.failMode})` : "";
  log(`backend: ${what} failed: ${(e as Error)?.message ?? e}${mode}`);
}

function healthy(what: string) {
  if (failing.delete(what)) log(`backend: ${what} works again`);
}
