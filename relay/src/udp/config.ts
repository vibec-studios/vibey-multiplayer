import { MAX_STREAMS } from "../config.ts";

const env = process.env;

export type ChannelName = "voice" | "bedrock";
export const CHANNELS: ChannelName[] = ["voice", "bedrock"];
export const CHANNEL_ID: Record<ChannelName, number> = { voice: 1, bedrock: 2 };

export const UDP_PORT = int("UDP_PORT", 24454);
export const UDP_PUBLIC_PORT = int("UDP_PUBLIC_PORT", UDP_PORT);
export const UDP_BIND = env.UDP_BIND?.trim() || "0.0.0.0";
export const BEDROCK_PORTS = parseRange(env.UDP_BEDROCK_PORTS ?? "19200-19299");
export const DEFAULT_CHANNELS = parseChannels((env.UDP_CHANNELS ?? "voice,bedrock").split(","));
export const HOST_SAME_IP = env.UDP_HOST_SAME_IP !== "0";
export const MAX_PEERS = int("UDP_MAX_PEERS", 4096);
export const MAX_PEERS_PER_HOST = int("UDP_MAX_PEERS_PER_HOST", MAX_STREAMS);
export const NEW_PEERS_PER_IP = int("UDP_NEW_PEERS_PER_IP", 20);
export const NEW_PEERS_WINDOW_MS = 10_000;
export const PEER_PPS = int("UDP_PEER_PPS", 300);
export const PEER_BPS = int("UDP_PEER_BPS", 256 * 1024);
export const HOST_BPS = int("UDP_HOST_BPS", 4 * 1024 * 1024);
export const MAX_PACKET = int("UDP_MAX_PACKET", 2048);
export const PEER_IDLE_MS = int("UDP_PEER_IDLE_MS", 60_000);
export const TUNNEL_IDLE_MS = int("UDP_TUNNEL_IDLE_MS", 45_000);
export const PROBE_MS = 10_000;
export const MAX_PROBES = 4;
export const BURST_SECONDS = 2;
export const AMPLIFICATION = 3;
export const AMPLIFICATION_ALLOWANCE = 1500;

export const enabled = UDP_PORT > 0;

export function parseChannels(v: unknown): ChannelName[] {
  if (!Array.isArray(v)) return [];
  const names = v.map((x) => String(x).trim().toLowerCase());
  return CHANNELS.filter((c) => names.includes(c));
}

export function parseRange(v: string): number[] {
  const m = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5}))?\s*$/.exec(v);
  if (!m) return [];
  const from = Number(m[1]);
  const to = Number(m[2] ?? m[1]);
  if (from < 1 || to > 65535 || to < from || to - from > 4096) return [];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function int(key: string, fallback: number): number {
  const v = env[key];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
