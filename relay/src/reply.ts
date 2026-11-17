import type * as net from "node:net";
import { STATE_STATUS, packet, parseHandshake, readFrame, string, type Handshake } from "./wire.ts";

export type Text = { title: string; sub: string };

export const UNKNOWN: Text = { title: "Unknown address", sub: "Check the address or ask the host for a new one." };
export const OFFLINE: Text = { title: "This world is offline", sub: "The host is not playing right now. Try again later." };
export const BUSY: Text = { title: "This world is busy", sub: "Too many connections right now. Try again in a moment." };

const PING = 0x01;

/** Answers a player the relay cannot forward: a server list entry for pings, a disconnect message for joins. */
export function refuse(sock: net.Socket, head: Buffer, text: Text) {
  let hs: Handshake | null = null;
  try {
    hs = parseHandshake(head);
  } catch {}
  if (!hs) return sock.destroy();
  if (hs.next !== STATE_STATUS) return sock.end(packet(0x00, string(chat(text, "\n\n"))));

  const status = {
    version: { name: "Vibey", protocol: hs.protocol },
    players: { max: 0, online: 0 },
    description: JSON.parse(chat(text, "\n")),
  };
  sock.write(packet(0x00, string(JSON.stringify(status))));
  answerPing(sock, head.subarray(hs.length));
}

function answerPing(sock: net.Socket, first: Buffer) {
  let rest = first;
  const timer = setTimeout(() => sock.destroy(), 5_000);
  const pump = () => {
    try {
      let f;
      while ((f = readFrame(rest, 0, 64))) {
        const frame = rest.subarray(0, f.end);
        rest = rest.subarray(f.end);
        if (f.id === PING) {
          clearTimeout(timer);
          sock.off("data", onData);
          return sock.end(frame);
        }
      }
    } catch {
      sock.destroy();
    }
  };
  const onData = (d: Buffer) => {
    rest = Buffer.concat([rest, d]);
    pump();
  };
  sock.on("data", onData);
  sock.on("close", () => clearTimeout(timer));
  sock.resume();
  pump();
}

function chat(text: Text, gap: string): string {
  const extra = [{ text: text.title, color: "red" }];
  if (text.sub) extra.push({ text: gap + text.sub, color: "gray" });
  return JSON.stringify({ text: "", extra });
}
