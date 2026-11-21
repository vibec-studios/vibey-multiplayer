import type * as dgram from "node:dgram";
import type { Host } from "../hosts.ts";
import type { Bucket } from "./bucket.ts";
import type { ChannelName } from "./config.ts";

export type Peer = {
  id: number;
  session: UdpSession;
  channel: ChannelName;
  ip: string;
  port: number;
  key: string;
  pps: Bucket;
  bps: Bucket;
  bytesIn: number;
  bytesOut: number;
  validated: boolean;
  probe: boolean;
  since: number;
  lastIn: number;
  lastOut: number;
};

export type Channel = {
  name: ChannelName;
  port: number;
  sock: dgram.Socket;
  peers: Map<string, Peer>;
  release?: () => void;
};

export type Denied = { code: "disabled" | "no_port" | "limit"; msg: string };

export type UdpSession = {
  host: Host;
  token: Buffer;
  tokenHex: string;
  channels: Map<ChannelName, Channel>;
  denied: Partial<Record<ChannelName, Denied>>;
  peers: Map<number, Peer>;
  nextPeer: number;
  tunnel: { ip: string; port: number; seen: number } | null;
  confirmed: boolean;
  out: Bucket;
  queue: Promise<void>;
  closed: boolean;
};

export const endpoint = (ip: string, port: number) => `${ip}:${port}`;
