import type * as net from "node:net";
import { FIRST_BYTES_TIMEOUT_MS } from "./config.ts";
import { startControl } from "./control.ts";
import { startData } from "./data.ts";
import { type Msg, readLines } from "./lines.ts";

/** A connection from the mod: either the control connection of a host or a data connection for one player. */
export function handleTunnel(sock: net.Socket, first: Buffer, ip: string) {
  const timer = setTimeout(() => sock.destroy(), FIRST_BYTES_TIMEOUT_MS);
  let control: ((msg: Msg) => void) | null = null;
  readLines(sock, first, (msg) => {
    if (control) return control(msg);
    clearTimeout(timer);
    if (msg.t === "hello") {
      control = startControl(sock, ip, msg);
      return;
    }
    const raw = msg.t === "data" ? startData(sock, msg) : null;
    if (raw) return raw;
    sock.destroy();
  });
}
