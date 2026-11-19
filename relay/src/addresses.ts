import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR, DOMAIN, DOMAINS, PUBLIC_PORT, log } from "./config.ts";
import { ADJECTIVES, NOUNS } from "./words.ts";

const file = path.join(DATA_DIR, "addresses.json");
export const FORMAT = 2;

/** Who owns an address: the account and which of its hosts (slot 0 = the classic one-world-per-account address). */
export type Owner = { uuid: string; slot: number };

/** Key `uuid` for slot 0, `uuid/slot` for the others. */
const labelOf = new Map<string, string>();
const ownerOf = new Map<string, Owner>();
let saveTimer: NodeJS.Timeout | null = null;

const keyOf = (uuid: string, slot: number) => (slot === 0 ? uuid : `${uuid}/${slot}`);

/**
 * Names under the relay domains that are never an address: `relay.<domain>` is where hosts connect, the others are
 * kept free for services. Generated labels (adjective-noun-NN) cannot collide with them anyway; this also keeps a hand
 * edited addresses.json from claiming one, and makes the handshake treat them as unknown addresses.
 */
export const RESERVED = new Set([
  "relay", "www", "api", "status", "admin", "app", "vibe", "vibey", "play", "join", "j", "mail", "smtp", "imap", "mx",
  "ns", "ns1", "ns2", "dns", "cdn", "static", "assets", "docs", "help", "support", "auth", "login", "id", "account",
]);

export const reserved = (label: string) => RESERVED.has(label.toLowerCase());

/** Longest first, so a domain that is a suffix of another one never steals its host names. */
const MATCH_DOMAINS = [...DOMAINS].sort((a, b) => b.length - a.length);

/**
 * Format 1: `{ "owners": { uuid: label } }`.
 * Format 2: `{ "version": 2, "owners": { uuid: label }, "slots": { uuid: { "1": label, … } } }`. `owners` stays the
 * slot-0 table, so an older relay that reads a format-2 file still finds every classic address.
 */
export function load() {
  labelOf.clear();
  ownerOf.clear();
  let raw: any = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log("could not read", file, (e as Error).message);
  }
  if (!raw || typeof raw !== "object") return;
  const put = (uuid: string, slot: number, label: unknown) => {
    if (typeof label !== "string" || !label || ownerOf.has(label)) return;
    if (reserved(label)) return log(`addresses.json: ignoring reserved name ${label} (${uuid}#${slot} gets a new address)`);
    labelOf.set(keyOf(uuid, slot), label);
    ownerOf.set(label, { uuid, slot });
  };
  if (raw.owners && typeof raw.owners === "object") for (const [uuid, label] of Object.entries(raw.owners)) put(uuid, 0, label);
  if (raw.slots && typeof raw.slots === "object") {
    for (const [uuid, slots] of Object.entries(raw.slots)) {
      if (!slots || typeof slots !== "object") continue;
      for (const [slot, label] of Object.entries(slots as Record<string, unknown>)) {
        const n = Number(slot);
        if (Number.isInteger(n) && n > 0) put(uuid, n, label);
      }
    }
  }
  if (raw.version !== FORMAT) {
    try {
      fs.copyFileSync(file, path.join(DATA_DIR, `addresses.v${Number(raw.version) || 1}.json`));
    } catch (e) {
      log("could not back up", file, (e as Error).message);
    }
    log(`addresses.json: upgrading format ${Number(raw.version) || 1} -> ${FORMAT} (${ownerOf.size} addresses)`);
    save();
  }
}

export function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const owners: Record<string, string> = {};
  const slots: Record<string, Record<string, string>> = {};
  for (const [label, { uuid, slot }] of ownerOf) {
    if (slot === 0) owners[uuid] = label;
    else (slots[uuid] ??= {})[slot] = label;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: FORMAT, owners, slots }, null, 1));
    fs.renameSync(tmp, file);
  } catch (e) {
    log("could not save", file, (e as Error).message);
  }
}

export function checkWritable() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch (e) {
    log(`WARNING: ${DATA_DIR} is not writable, addresses will not survive a restart:`, (e as Error).message);
  }
}

function save() {
  saveTimer ??= setTimeout(flush, 200);
}

export function owner(label: string): Owner | undefined {
  return ownerOf.get(label);
}

export function count(): number {
  return ownerOf.size;
}

/** The stable address label of (account, slot); `renew` hands out a new one (rotate). */
export function labelFor(uuid: string, slot = 0, renew = false): string {
  const key = keyOf(uuid, slot);
  const old = labelOf.get(key);
  if (old && !renew) return old;
  if (old) ownerOf.delete(old);
  const label = freshLabel();
  labelOf.set(key, label);
  ownerOf.set(label, { uuid, slot });
  save();
  return label;
}

function freshLabel(): string {
  for (let i = 0; i < 1000; i++) {
    const a = ADJECTIVES[crypto.randomInt(ADJECTIVES.length)];
    const n = NOUNS[crypto.randomInt(NOUNS.length)];
    const label = `${a}-${n}-${crypto.randomInt(10, 100)}`;
    if (!ownerOf.has(label) && !reserved(label)) return label;
  }
  return crypto.randomBytes(6).toString("hex");
}

/** The address players type, always under the primary domain. */
export function addressOf(label: string): string {
  return PUBLIC_PORT === 25565 ? `${label}.${DOMAIN}` : `${label}.${DOMAIN}:${PUBLIC_PORT}`;
}

/**
 * `Mossy-Otter-27.axolite.cc.\0FML3\0` → `mossy-otter-27`; every configured domain works, so
 * `mossy-otter-27.vibey.henny.dev` is the same address. Null for foreign host names and reserved names.
 */
export function labelFromHost(host: string): string | null {
  const h = host.split("\0")[0].trim().toLowerCase().replace(/\.+$/, "");
  const domain = MATCH_DOMAINS.find((d) => h.endsWith("." + d));
  if (!domain) return null;
  const parts = h.slice(0, -(domain.length + 1)).split(".");
  const label = parts[parts.length - 1];
  return label && !reserved(label) ? label : null;
}
