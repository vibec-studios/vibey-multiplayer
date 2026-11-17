import type * as net from "node:net";
import { type Pending, claim } from "./hosts.ts";
import { addressOf } from "./addresses.ts";
import { emit } from "./events.ts";
import type { Msg, RawHandler } from "./lines.ts";
import { totals } from "./stats.ts";

export function startData(sock: net.Socket, msg: Msg): RawHandler | null {
  const p = claim(Number(msg.sid), String(msg.key ?? ""));
  if (!p) return null;
  sock.setNoDelay(true);
  return (rest) => splice(p, sock, rest);
}

function splice(p: Pending, data: net.Socket, rest: Buffer) {
  const { host, player } = p;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    host.live.delete(player);
    if (host.players.delete(player) && p.login) {
      emit({ type: "player_leave", uuid: host.uuid, slot: host.slot, address: addressOf(host.label), player: p.login, ip: p.ip });
    }
    host.streams--;
    player.destroy();
    data.destroy();
  };
  for (const s of [player, data]) {
    s.on("close", close);
    s.on("error", close);
  }
  if (player.destroyed || data.destroyed) return close();

  host.live.add(player);
  if (p.login) {
    totals.joins++;
    host.players.set(player, { name: p.login.name, uuid: p.login.uuid, ip: p.ip, since: Date.now() });
    emit({ type: "player_join", uuid: host.uuid, slot: host.slot, address: addressOf(host.label), player: p.login, ip: p.ip });
  }
  if (rest.length) player.write(rest);
  data.write(p.head);
  player.pipe(data);
  data.pipe(player);
  player.resume();
}
