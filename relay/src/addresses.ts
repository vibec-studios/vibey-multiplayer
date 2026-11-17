import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR, DOMAIN, PUBLIC_PORT, log } from "./config.ts";
import { ADJECTIVES, NOUNS } from "./words.ts";

const file = path.join(DATA_DIR, "addresses.json");
const labelOf = new Map<string, string>();
const ownerOf = new Map<string, string>();
let saveTimer: NodeJS.Timeout | null = null;

export function load() {
  labelOf.clear();
  ownerOf.clear();
  let owners: Record<string, string> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw.owners === "object") owners = raw.owners;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log("could not read", file, (e as Error).message);
  }
  for (const [uuid, label] of Object.entries(owners)) {
    labelOf.set(uuid, label);
    ownerOf.set(label, uuid);
  }
}

export function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ owners: Object.fromEntries(labelOf) }, null, 1));
  fs.renameSync(tmp, file);
}

function save() {
  saveTimer ??= setTimeout(flush, 200);
}

export function owner(label: string): string | undefined {
  return ownerOf.get(label);
}

export function count(): number {
  return ownerOf.size;
}

export function labelFor(uuid: string, renew = false): string {
  const old = labelOf.get(uuid);
  if (old && !renew) return old;
  if (old) ownerOf.delete(old);
  const label = freshLabel();
  labelOf.set(uuid, label);
  ownerOf.set(label, uuid);
  save();
  return label;
}

function freshLabel(): string {
  for (let i = 0; i < 1000; i++) {
    const a = ADJECTIVES[crypto.randomInt(ADJECTIVES.length)];
    const n = NOUNS[crypto.randomInt(NOUNS.length)];
    const label = `${a}-${n}-${crypto.randomInt(10, 100)}`;
    if (!ownerOf.has(label)) return label;
  }
  return crypto.randomBytes(6).toString("hex");
}

export function addressOf(label: string): string {
  return PUBLIC_PORT === 25565 ? `${label}.${DOMAIN}` : `${label}.${DOMAIN}:${PUBLIC_PORT}`;
}

/** `Mossy-Otter-27.vibey.henny.dev.\0FML3\0` → `mossy-otter-27`, null for foreign host names. */
export function labelFromHost(host: string): string | null {
  const h = host.split("\0")[0].trim().toLowerCase().replace(/\.+$/, "");
  if (!h.endsWith("." + DOMAIN)) return null;
  const parts = h.slice(0, -(DOMAIN.length + 1)).split(".");
  return parts[parts.length - 1] || null;
}
