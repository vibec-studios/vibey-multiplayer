import { BEDROCK_PORTS, UDP_PUBLIC_PORT, enabled } from "./config.ts";
import { reasons, udpTotals } from "./metrics.ts";
import { portsInUse } from "./ports.ts";
import { countPeers, sessions, sharedSocket } from "./registry.ts";

export function udpSummary() {
  const voice = countPeers("voice");
  const bedrock = countPeers("bedrock");
  return { sessions: sessions.size, peers: voice + bedrock, voicePeers: voice, bedrockPeers: bedrock };
}

export function udpStatus() {
  const running = enabled && sharedSocket() !== null;
  return {
    enabled: running,
    port: running ? UDP_PUBLIC_PORT : null,
    bedrockPorts: BEDROCK_PORTS.length
      ? { from: BEDROCK_PORTS[0], to: BEDROCK_PORTS[BEDROCK_PORTS.length - 1], used: portsInUse() }
      : null,
    ...udpSummary(),
    totals: { ...udpTotals, dropped: { ...udpTotals.dropped } },
  };
}

export function udpMetrics(): string[] {
  const s = udpSummary();
  const t = udpTotals;
  return [
    "# TYPE vibey_udp_packets_total counter",
    `vibey_udp_packets_total{dir="in"} ${t.packetsIn}`,
    `vibey_udp_packets_total{dir="out"} ${t.packetsOut}`,
    "# TYPE vibey_udp_bytes_total counter",
    `vibey_udp_bytes_total{dir="in"} ${t.bytesIn}`,
    `vibey_udp_bytes_total{dir="out"} ${t.bytesOut}`,
    "# TYPE vibey_udp_peers_opened_total counter",
    `vibey_udp_peers_opened_total ${t.peersOpened}`,
    "# TYPE vibey_udp_dropped_total counter",
    ...reasons().map((r) => `vibey_udp_dropped_total{reason="${r}"} ${t.dropped[r]}`),
    "# TYPE vibey_udp_peers gauge",
    `vibey_udp_peers{channel="voice"} ${s.voicePeers}`,
    `vibey_udp_peers{channel="bedrock"} ${s.bedrockPeers}`,
    "# TYPE vibey_udp_sessions gauge",
    `vibey_udp_sessions ${s.sessions}`,
    "# TYPE vibey_udp_bedrock_ports_used gauge",
    `vibey_udp_bedrock_ports_used ${portsInUse()}`,
  ];
}

export function udpAvailable(): boolean {
  return enabled && sharedSocket() !== null;
}
