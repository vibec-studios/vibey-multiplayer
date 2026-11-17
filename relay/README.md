# Vibey Relay

Tunnel for worlds hosted inside a normal Minecraft client. Friends join with an unmodded Minecraft using a fixed
address like `mossy-otter-27.vibey.henny.dev`; the relay reads the host name from the Minecraft handshake and hands
the connection to the client that owns the address. No dependencies at runtime, Node 23.6+ or Bun.

```bash
npm start        # node src/main.ts
npm test         # end-to-end test with a fake host and fake players
npm run check    # type check (npm install first)
```

## Files

| File | |
|---|---|
| `src/main.ts` | Accepts connections on the one TCP port, tells players and hosts apart, shutdown |
| `src/config.ts` | Environment and limits |
| `src/player.ts` | Minecraft clients: handshake, Login Start, routing, network-level access checks |
| `src/tunnel.ts` | Connections from the mod: control or data |
| `src/control.ts` | Control connection: hello, Mojang check, address, rotation, access lists |
| `src/data.ts` | Data connection: splices a player socket with the host |
| `src/hosts.ts` | Online hosts and players waiting for their data connection |
| `src/addresses.ts` | Address ownership (`DATA_DIR/addresses.json`) |
| `src/access.ts` | Whitelist and ban lists |
| `src/reply.ts` | Answers for worlds that are offline, unknown, busy or blocked |
| `src/wire.ts` | Minecraft packet reading and writing |
| `src/mojang.ts` | `hasJoined` session check |
| `src/stats.ts` | `/status` and `/health` |
| `status-proxy.ts` | Separate app: serves `/status` over HTTPS for the website |

## Environment

| Variable | Default | |
|---|---|---|
| `PORT` | `25565` | Port for players **and** hosts |
| `DOMAIN` | `vibey.henny.dev` | Wildcard domain of the addresses |
| `PUBLIC_PORT` | `PORT` | Port shown in addresses (if not 25565) |
| `DATA_DIR` | `./data` | Where address ownership is stored |
| `HTTP_PORT` | off | `/health` and `/status` (public numbers, no names or addresses) |
| `MAX_STREAMS` | `64` | Connections per host |
| `ALLOW_OFFLINE` | off | `1` skips the Mojang check (local testing only!) |

## Protocol

Everything shares one TCP port. Minecraft clients connect normally; nothing is decrypted, in online mode the
connection is end-to-end encrypted between player and host. The mod starts its connections with the magic bytes
`0x00 'V' 'B' 'Y'`: a Minecraft packet can never start with `0x00` (a zero-length packet), so both kinds of traffic
can share the port. After the magic: newline-delimited JSON.

**Control connection** (one per hosting client)

| Direction | Message | |
|---|---|---|
| C → S | `{"t":"hello","v":1,"name":"…","uuid":"…","mc":"1.21.11","mod":"1.0.0"}` | |
| S → C | `{"t":"challenge","serverId":"<hex>"}` | Client calls Mojang `joinServer(serverId)` |
| C → S | `{"t":"auth"}` | Relay checks Mojang `hasJoined` |
| S → C | `{"t":"ready","address":"a-b-12.domain","label":"a-b-12","domain":"domain","port":25565}` | |
| C → S | `{"t":"rotate"}` | New address, answered with `ready` (6 per hour) |
| C → S | `{"t":"access","whitelist":["name"]\|null,"banNames":[…],"banIps":[…],"messages":{"banned":"…","whitelist":"…"}}` | Enforced by the relay before a byte reaches the host |
| S → C | `{"t":"open","sid":7,"key":"<hex>","ip":"1.2.3.4","state":2,"name":"Steve","uuid":"…"}` | A player knocked; `name`/`uuid` only for joins |
| S → C | `{"t":"blocked","name":"Steve","ip":"1.2.3.4","reason":"banned"\|"whitelist"}` | |
| C → S / S → C | `{"t":"ping"}` / `{"t":"pong"}` | Hosts that stay silent for 75 s are dropped |
| S → C | `{"t":"error","code":"…","msg":"…"}`, `{"t":"replaced"}` | `replaced`: same account hosts somewhere else |

**Data connection** (one per player): `{"t":"data","sid":7,"key":"<hex>"}\n`, then raw bytes in both directions.
