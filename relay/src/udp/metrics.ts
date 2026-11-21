export type DropReason =
  | "unknown" | "auth" | "rate" | "size" | "limit" | "banned" | "amplification" | "no_tunnel" | "peer";

const REASONS: DropReason[] = ["unknown", "auth", "rate", "size", "limit", "banned", "amplification", "no_tunnel", "peer"];

export const udpTotals = {
  packetsIn: 0,
  packetsOut: 0,
  bytesIn: 0,
  bytesOut: 0,
  peersOpened: 0,
  dropped: Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<DropReason, number>,
};

export function countIn(bytes: number) {
  udpTotals.packetsIn++;
  udpTotals.bytesIn += bytes;
}

export function countOut(bytes: number) {
  udpTotals.packetsOut++;
  udpTotals.bytesOut += bytes;
}

export function dropped(reason: DropReason) {
  udpTotals.dropped[reason]++;
}

export function reasons(): DropReason[] {
  return REASONS;
}
