import type * as net from "node:net";
import { MAX_LINE } from "./config.ts";

export type Msg = Record<string, any>;
export type RawHandler = (rest: Buffer) => void;

export function send(sock: net.Socket, msg: Msg) {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n");
}

/**
 * Feeds newline-delimited JSON objects to `onMessage`. When it returns a function, reading stops and that function
 * gets the bytes that came after the line (data connections switch to raw bytes after their first line).
 */
export function readLines(sock: net.Socket, first: Buffer, onMessage: (msg: Msg) => RawHandler | void) {
  let buf = first;
  const pump = () => {
    let i: number;
    while ((i = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, i).toString("utf8").trim();
      buf = buf.subarray(i + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return sock.destroy();
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return sock.destroy();
      const raw = onMessage(msg as Msg);
      if (typeof raw === "function") {
        sock.off("data", onData);
        return raw(buf);
      }
      if (sock.destroyed) return;
    }
    if (buf.length > MAX_LINE) sock.destroy();
  };
  const onData = (d: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    pump();
  };
  sock.on("data", onData);
  pump();
}
