import * as net from "node:net";
import { normalizeIp } from "./access.ts";
import * as addresses from "./addresses.ts";
import { ALLOW_OFFLINE, CONTROL_IDLE_MS, DOMAIN, FIRST_BYTES_TIMEOUT_MS, HTTP_PORT, MAGIC, PORT, VERSION, log } from "./config.ts";
import { hosts } from "./hosts.ts";
import { handlePlayer } from "./player.ts";
import { serveStatus } from "./stats.ts";
import { handleTunnel } from "./tunnel.ts";

const LEGACY_PING = 0xfe;

function accept(sock: net.Socket) {
  sock.setNoDelay(true);
  sock.on("error", () => sock.destroy());
  const ip = normalizeIp(sock.remoteAddress ?? "?");
  const timer = setTimeout(() => sock.destroy(), FIRST_BYTES_TIMEOUT_MS);
  sock.once("data", (first: Buffer) => {
    clearTimeout(timer);
    if (first[0] === LEGACY_PING) return sock.destroy();
    if (first[0] !== 0x00) return handlePlayer(sock, first, ip);
    if (first.length < MAGIC.length || !first.subarray(0, MAGIC.length).equals(MAGIC)) return sock.destroy();
    handleTunnel(sock, first.subarray(MAGIC.length), ip);
  });
}

function dropSilentHosts() {
  const now = Date.now();
  for (const h of hosts()) if (now - h.lastSeen > CONTROL_IDLE_MS) h.sock.destroy();
}

addresses.load();
const relay = net.createServer(accept).listen(PORT, () => {
  log(`Vibey relay ${VERSION} on :${PORT}, addresses *.${DOMAIN}${ALLOW_OFFLINE ? " (offline mode!)" : ""}`);
});
const statusServer = HTTP_PORT ? serveStatus(HTTP_PORT) : null;
setInterval(dropSilentHosts, 15_000).unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log(`${signal}, shutting down`);
    addresses.flush();
    relay.close();
    statusServer?.close();
    process.exit(0);
  });
}
