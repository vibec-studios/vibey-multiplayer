import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR, log } from "../config.ts";
import { BEDROCK_PORTS, UDP_BIND } from "./config.ts";

type Lease = { port: number; used: number };
export type Handler = (msg: Buffer, rinfo: dgram.RemoteInfo) => void;

const file = path.join(DATA_DIR, "udp-ports.json");
const FORMAT = 1;
const MAX_TRIES = 32;
const REBIND_TRIES = 5;
const REBIND_DELAY_MS = 100;
const leases = new Map<string, Lease>();
const busy = new Set<number>();
let saveTimer: NodeJS.Timeout | null = null;

export function loadLeases() {
  leases.clear();
  let raw: any = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log("could not read", file, (e as Error).message);
  }
  const taken = new Set<number>();
  for (const [key, v] of Object.entries(raw?.leases ?? {})) {
    const port = Number((v as any)?.port);
    const used = Date.parse(String((v as any)?.used ?? "")) || 0;
    if (!BEDROCK_PORTS.includes(port) || taken.has(port)) continue;
    taken.add(port);
    leases.set(key, { port, used });
  }
}

export function flushLeases() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const out: Record<string, { port: number; used: string }> = {};
  for (const [k, l] of leases) out[k] = { port: l.port, used: new Date(l.used).toISOString() };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: FORMAT, leases: out }, null, 1));
    fs.renameSync(tmp, file);
  } catch (e) {
    log("could not save", file, (e as Error).message);
  }
}

export function portsInUse(): number {
  return busy.size;
}

export async function acquirePort(key: string, onMessage: Handler): Promise<{ port: number; sock: dgram.Socket } | null> {
  const mine = leases.get(key)?.port;
  for (const port of candidates(key).slice(0, MAX_TRIES)) {
    busy.add(port);
    const sock = await bind(port, port === mine ? REBIND_TRIES : 1);
    if (!sock) {
      busy.delete(port);
      continue;
    }
    sock.on("message", onMessage);
    for (const [k, l] of leases) if (l.port === port && k !== key) leases.delete(k);
    leases.set(key, { port, used: Date.now() });
    save();
    return { port, sock };
  }
  return null;
}

export function releasePort(key: string, port: number, sock: dgram.Socket) {
  sock.removeAllListeners("message");
  closeQuietly(sock);
  busy.delete(port);
  const l = leases.get(key);
  if (l?.port === port) {
    l.used = Date.now();
    save();
  }
}

function candidates(key: string): number[] {
  const mine = leases.get(key)?.port;
  const free = BEDROCK_PORTS.filter((p) => !busy.has(p));
  const owner = new Map<number, Lease>();
  for (const [k, l] of leases) if (k !== key) owner.set(l.port, l);
  const fresh = free.filter((p) => p !== mine && !owner.has(p));
  const evictable = free
    .filter((p) => p !== mine && owner.has(p))
    .sort((a, b) => owner.get(a)!.used - owner.get(b)!.used);
  const first = mine !== undefined && free.includes(mine) ? [mine] : [];
  return [...first, ...fresh, ...evictable];
}

async function bind(port: number, tries: number): Promise<dgram.Socket | null> {
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, REBIND_DELAY_MS));
    const sock = await bindOnce(port);
    if (sock) return sock;
  }
  return null;
}

function bindOnce(port: number): Promise<dgram.Socket | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const fail = () => {
      closeQuietly(sock);
      resolve(null);
    };
    sock.once("error", fail);
    sock.bind(port, UDP_BIND, () => {
      sock.off("error", fail);
      sock.on("error", (e) => log(`udp :${port}:`, e.message));
      resolve(sock);
    });
  });
}

function closeQuietly(sock: dgram.Socket) {
  try {
    sock.close();
  } catch {
    return;
  }
}

function save() {
  saveTimer ??= setTimeout(flushLeases, 200);
}
