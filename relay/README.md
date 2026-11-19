# Vibey Relay

Tunnel for worlds hosted inside a normal Minecraft client, and for local dedicated servers started by the Vibe
Launcher. Friends join with an unmodded Minecraft using a fixed address like `mossy-otter-27.axolite.cc`; the relay
reads the host name from the Minecraft handshake and hands the connection to the client that owns the address.
No dependencies at runtime, Node 23.6+ or Bun.

```bash
npm start        # node src/main.ts
npm test         # end-to-end tests: fake hosts, fake players, fake Vibe Backend
npm run check    # type check (npm install first)
npm run launcher-client -- --relay host:port --port <server port> --name <name> --uuid <uuid> --slot 1
```

## Files

| File | |
|---|---|
| `src/main.ts` | Accepts connections on the one TCP port, tells players and hosts apart, shutdown |
| `src/config.ts` | Environment and limits |
| `src/player.ts` | Minecraft clients: handshake, Login Start, routing, network-level access checks, player limit |
| `src/tunnel.ts` | Connections from the mod or launcher: control or data |
| `src/control.ts` | Control connection: hello, Mojang check, authorization, address, rotation, access lists |
| `src/data.ts` | Data connection: splices a player socket with the host |
| `src/hosts.ts` | Online hosts (per account and slot) and players waiting for their data connection |
| `src/addresses.ts` | Address ownership (`DATA_DIR/addresses.json`) |
| `src/access.ts` | Whitelist and ban lists |
| `src/backend.ts` | Optional Vibe Backend: authorize, commands, heartbeat, local limits |
| `src/events.ts` | Buffered event delivery to the backend |
| `src/reply.ts` | Answers for worlds that are offline, unknown, busy, full or blocked |
| `src/wire.ts` | Minecraft packet reading and writing |
| `src/mojang.ts` | `hasJoined` session check |
| `src/stats.ts` | `/status` and `/health` |
| `status-proxy.ts` | Separate app: serves `/status` over HTTPS for the website |
| `test/selftest.ts` | End-to-end test without backend (addresses, access, slots, migration) |
| `test/domains.ts` | Several domains, reserved names, `DOMAIN` fallback, stable `RELAY_ID` |
| `test/backend.ts` | End-to-end test of the backend contract with a fake backend |
| `test/launcher-client.ts` | Reference client for a local dedicated server (what the launcher does), also a CLI |

## Environment

> **Official services:** `axolite.cc`, the default `vibey.henny.dev` and `https://vibe.axolite.app` (formerly
> `https://vibe.henny.dev`) are the Vibe services, for official builds only, see
> [SERVICES.md](https://github.com/vibec-studios/.github/blob/main/SERVICES.md). A relay of your own needs its own
> `DOMAINS` and, if any, a backend you run yourself.

| Variable | Default | |
|---|---|---|
| `PORT` | `25565` | Port for players **and** hosts |
| `DOMAINS` | | Wildcard domains of the addresses, comma-separated, the **first is the primary**, e.g. `axolite.cc,vibey.henny.dev`. See [Domains](#domains) |
| `DOMAIN` | `vibey.henny.dev` | One domain; only used when `DOMAINS` is not set (relays before 1.4) |
| `PUBLIC_PORT` | `PORT` | Port shown in addresses (if not 25565) |
| `DATA_DIR` | `./data` | Where address ownership is stored |
| `HTTP_PORT` | off | `/health` and `/status` (public numbers, no names or addresses) |
| `MAX_STREAMS` | `64` | Connections per host |
| `MAX_HOSTS_PER_ACCOUNT` | `2` | Hosts (slots) one account may run at once, used without backend and in fail-open mode |
| `MAX_PLAYERS_PER_HOST` | `0` | Joined players per host without backend (`0` = no limit) |
| `ALLOW_OFFLINE` | off | `1` skips the Mojang check (local testing only!) |
| `BACKEND_URL` | off | Vibe Backend, e.g. `https://vibe.henny.dev`. Needs `BACKEND_SECRET` too |
| `BACKEND_SECRET` | | Shared secret, sent as `Authorization: Bearer …` |
| `BACKEND_FAIL_MODE` | `open` | Backend unreachable: `open` = allow with the local limits, `closed` = refuse new hosts |
| `RELAY_ID` | see [Domains](#domains) | Sent as `X-Relay-Id` header so the backend can tell workers apart |
| `BACKEND_TIMEOUT_MS` | `5000` | Timeout of every backend request |
| `BACKEND_EVENTS_MS` / `BACKEND_COMMANDS_MS` / `BACKEND_HEARTBEAT_MS` | `2000` / `5000` / `30000` | Intervals |
| `BACKEND_EVENT_BUFFER` | `10000` | Events kept while the backend is down; the oldest are dropped beyond that |

## Domains

A relay can serve several wildcard domains at once (relay 1.4), for a domain move without breaking old addresses.
The official relay runs with `DOMAINS=axolite.cc,vibey.henny.dev`; both `*.axolite.cc` and `*.vibey.henny.dev` are
DNS-only A records pointing at it.

- **Accepted:** the handshake host name may end in any configured domain. `mossy-otter-27.axolite.cc` and
  `mossy-otter-27.vibey.henny.dev` are the same address (case, a trailing dot and the Forge `\0FML3\0` marker are
  ignored; the longest matching domain wins). Other host names get "Unknown address".
- **Reported:** everything the relay says uses the **primary** (first) domain: `ready.address` and `ready.domain` for
  hosts, `address` in backend events, `domain` in `/status` (plus `domains`, the full list), the start-up log.
  Nothing is stored per domain: `addresses.json` holds labels only, so a label moves to the new primary domain as is.
- **Reserved names:** `relay`, `www`, `api`, `status` and a few more (`RESERVED` in `src/addresses.ts`) are never an
  address on any domain: they are never handed out, ignored in `addresses.json`, and a player connecting to
  `relay.axolite.cc` gets "Unknown address". Hosts use these names to reach the relay: the mod and the launcher
  connect to `relay.axolite.cc:25565` (new builds) or `relay.vibey.henny.dev:25565` (old builds), the same server.
  The relay does not look at the host name of control and data connections, only at the magic bytes.
- **`RELAY_ID` stays stable:** the backend knows a relay by its `X-Relay-Id`. Before 1.4 it defaulted to `DOMAIN`,
  i.e. `vibey.henny.dev` for the official relay. A new primary domain must not change it, so without an explicit
  `RELAY_ID` it is **`vibey.henny.dev` whenever that domain is in the list** (also when it is not the primary), and
  otherwise the primary domain as before. A relay of your own that changes its primary domain should set `RELAY_ID`
  to its old domain.
- **`DOMAIN`** still works as a single domain when `DOMAINS` is not set; when both are set, `DOMAINS` wins.

## Protocol

Everything shares one TCP port. Minecraft clients connect normally; nothing is decrypted, in online mode the
connection is end-to-end encrypted between player and host. The mod and the launcher start their connections with the
magic bytes `0x00 'V' 'B' 'Y'`: a Minecraft packet can never start with `0x00` (a zero-length packet), so both kinds
of traffic can share the port. After the magic: newline-delimited JSON (one object per line, at most 8 KiB).

**Control connection** (one per host)

| Direction | Message | |
|---|---|---|
| C → S | `{"t":"hello","v":1,"name":"…","uuid":"…","mc":"1.21.11","mod":"1.0.0"}` | Mod hello (unchanged since 1.0) |
| C → S | `{"t":"hello","v":1,"name":"…","uuid":"…","mc":"1.21.11","client":"launcher","kind":"server","slot":1,"version":"0.5.0"}` | Optional fields since relay 1.3, see below |
| S → C | `{"t":"challenge","serverId":"<hex>"}` | Client calls Mojang `joinServer(serverId)` |
| C → S | `{"t":"auth"}` | Relay checks Mojang `hasJoined`, then asks the backend (if configured) |
| S → C | `{"t":"ready","address":"a-b-12.domain","label":"a-b-12","domain":"domain","port":25565,"slot":0}` | `domain` = the primary domain |
| C → S | `{"t":"rotate"}` | New address for this slot, answered with `ready` (6 per hour) |
| C → S | `{"t":"access","whitelist":["name"]\|null,"banNames":[…],"banIps":[…],"messages":{"banned":"…","whitelist":"…"}}` | Enforced by the relay before a byte reaches the host; may be sent any time, also before `auth` |
| S → C | `{"t":"open","sid":7,"key":"<hex>","ip":"1.2.3.4","state":2,"name":"Steve","uuid":"…"}` | A player knocked; `name`/`uuid` only for joins (`state` 2), pings have `state` 1 |
| S → C | `{"t":"blocked","name":"Steve","ip":"1.2.3.4","reason":"banned"\|"whitelist"}` | |
| C → S / S → C | `{"t":"ping"}` / `{"t":"pong"}` | Hosts that stay silent for 75 s are dropped; ping every 20 s |
| S → C | `{"t":"error","code":"…","msg":"…"}`, `{"t":"replaced"}` | Then the relay closes. `replaced`: the same account and slot is hosted somewhere else |

Error codes: `version`, `bad_hello`, `auth_failed`, `limit`, `banned`, `disabled`, `unavailable` (backend down in
fail-closed mode), `kicked` (by the backend), `rate_limited` (rotation only, the connection stays open). `msg` is
meant for the user. Except for `rate_limited`, a client should show `msg` and **not** reconnect on its own.

**Data connection** (one per player): `{"t":"data","sid":7,"key":"<hex>"}\n`, then raw bytes in both directions. The
first bytes the relay sends are the player's handshake and Login Start (or status request), unchanged. The `sid` and
`key` are valid for 10 s; after that the player gets an "offline" answer.

### Several hosts per account (relay 1.3)

`hello` may carry three optional fields. A hello without them behaves exactly like before (slot 0, a world from the
mod), so old mod versions keep their address and behaviour.

| Field | Values | Default | |
|---|---|---|---|
| `slot` | integer `0`–`63` | `0` | Which host of the account this is. Each (account, slot) has its own stable address |
| `kind` | `"world"`, `"server"` | `"world"` | A world opened in the client, or a dedicated server |
| `client` | `"mod"`, `"launcher"` | `"mod"` | Who connects |
| `version` | string | value of `mod` | Version of the client |

- Slot 0 is the classic address of the account (the one the mod always had). Other slots get their own address on
  first use; it survives reconnects, restarts and `rotate` of other slots.
- `replaced` only happens for the same (account, slot). Different slots run side by side, up to the limit
  (`MAX_HOSTS_PER_ACCOUNT` or the backend's `maxHosts`); beyond it the new host gets `error` `limit`.
- Convention: the mod uses slot 0; the launcher gives every local server its own fixed slot from 1 upwards and keeps
  it with the server (so the server keeps its address).

### Launcher as a client (local dedicated servers)

The launcher speaks exactly the same protocol as the mod. `test/launcher-client.ts` is a complete reference
implementation (about 150 lines, no dependencies) and runs as a CLI. Steps:

1. **Control connection:** TCP to the relay (`relay.axolite.cc:25565`; older builds use `relay.vibey.henny.dev:25565`,
   the same server), write `00 56 42 59`, then
   `{"t":"hello","v":1,"name":<profile name>,"uuid":<profile uuid>,"mc":<server version>,"client":"launcher","kind":"server","slot":<n ≥ 1>,"version":<launcher version>}`
   and right after it the current `access` lists (whitelist/bans of that server, see below).
2. **Mojang check:** on `challenge`, call Mojang `joinServer` with the signed-in account of the launcher, exactly
   like a Minecraft client joining a server:
   `POST https://sessionserver.mojang.com/session/minecraft/join`
   `{"accessToken":"<Minecraft token>","selectedProfile":"<uuid without dashes>","serverId":"<serverId as received>"}`
   (204 = ok). `serverId` is used as-is, it is not hashed. Then send `{"t":"auth"}` (also when the join failed, the
   relay answers `auth_failed`). The relay never sees the token.
3. **Ready:** `ready.address` is what players type. Keep the control connection alive with `{"t":"ping"}` every 20 s.
   On a lost connection reconnect with backoff (1 s doubling to 30 s); on `error` (except `rate_limited`) or
   `replaced` show the message and stop.
4. **Players:** for every `open`, make a **new** TCP connection to the relay, write the magic and
   `{"t":"data","sid":…,"key":…}\n`, connect to **`127.0.0.1:<server-port>`** and pipe both sockets in both
   directions until either closes. Within 10 s, or the player gets "offline". Never connect anywhere else than the
   local server port.
5. **Access lists:** whitelist and bans are checked by the relay on network level (name from Login Start, IP as the
   relay sees it), before a byte reaches the server. Send `access` again whenever they change.

Notes for dedicated servers:

- `online-mode=true` works end to end like with the mod: the relay only forwards bytes; encryption and the Mojang
  check of each player happen between the player and the server.
- Keep `prevent-proxy-connections=false` (the default): the server sees every player as `127.0.0.1`, and with `true`
  it would send that IP to Mojang and reject everyone.
- For the same reason the server's own IP bans and IP logs only see `127.0.0.1`; use the relay `access` lists
  (`banIps`) and the `ip` in `open` instead. Name bans and the whitelist on the server keep working.
- The server may listen on `127.0.0.1` only (`server-ip=127.0.0.1`), nothing needs to be reachable from outside.
- The address in the handshake is the relay address; servers do not care, BungeeCord/Velocity forwarding is not used.

## Backend (optional)

With `BACKEND_URL` and `BACKEND_SECRET` set, the relay talks to the Vibe Backend. All calls go to
`{BACKEND_URL}/internal/relay/v1/…` with `Authorization: Bearer <BACKEND_SECRET>`, `X-Relay-Id: <RELAY_ID>` and JSON
bodies. UUIDs are 32 lowercase hex digits without dashes, `at` is an ISO 8601 timestamp, `ttl` is in seconds. No
backend call ever blocks a running tunnel.

**`POST /authorize`**, after the Mojang check and before a host goes online:

```json
{ "uuid": "…", "name": "Steve", "ip": "1.2.3.4", "client": "mod", "kind": "world", "slot": 0,
  "mc": "1.21.11", "version": "1.0.0", "active": 1 }
```

`active` = other hosts of this account online on this worker (a host on the same slot would be replaced and is not
counted). Answers:

- `{ "allow": true, "maxHosts": 2, "maxPlayers": 10 | null, "ttl": 60 }`: the relay refuses with `limit` itself if
  `active >= maxHosts`, and turns away joins beyond `maxPlayers` (`null` = no limit) with "This world is full".
  Missing `maxHosts`/`maxPlayers` fall back to the local limits.
- `{ "allow": false, "code": "limit" | "banned" | "disabled", "message": "…" }`: the client gets
  `{"t":"error","code":code,"msg":message}` and the connection closes.

Answers are cached per (uuid, client, kind) for `ttl` seconds (`0` or missing = no cache); `limit` denials are never
cached. Backend unreachable (network error, timeout, non-2xx, bad JSON): `BACKEND_FAIL_MODE=open` allows with the
local limits, `closed` refuses with `unavailable`. Failures are logged once, then at most every 5 minutes, and
recovery is logged.

**`POST /events`**, batched every 2 s (at most 500 per request), retried with backoff, kept in a bounded buffer:

```json
{ "events": [
  { "type": "host_online", "uuid": "…", "slot": 0, "address": "a-b-12.axolite.cc", "at": "…", "ip": "1.2.3.4" },
  { "type": "player_join", "uuid": "…", "slot": 0, "address": "…", "at": "…",
    "player": { "name": "Alex", "uuid": "…" }, "ip": "5.6.7.8" }
] }
```

Types: `host_online`, `host_offline` (`ip` = host), `player_join`, `player_leave`, `blocked` (whitelist/ban; `player`
and `ip` = player). `uuid`/`slot` are always the host's. `player.uuid` is what the client sent in Login Start (in online
mode the server checks it; it can be empty for very old clients). Any 2xx counts as delivered.

**`GET /commands`** every 5 s → `{ "commands": [ { "id": "…", "type": "…", … } ] }` (a bare array works too), then
`POST /commands/ack` `{ "ids": [ … ] }` with every id that was handled (also unknown types, which are ignored).

| Type | Fields | |
|---|---|---|
| `kick_host` | `uuid`, `slot?` (missing/null = all slots), `message?` | Host gets `error` `kicked` and is disconnected |
| `ban_uuid` | `uuid`, `message?` | All hosts of the account are disconnected (`banned`), new ones refused until restart |
| `unban_uuid` | `uuid` | Lifts a `ban_uuid` |
| `config` | `config: { maxHostsPerAccount?, maxPlayers?, failMode? }` | Changes the local limits and fail mode |

Bans from `ban_uuid` live in memory; after a restart the backend's `authorize` answer is what counts.

**`POST /heartbeat`** every 30 s (and at start) `{ "version": "1.4.0", "hosts": 3, "players": 7, "uptime": 3600 }` →
`{ "config": { … } }` (same keys as the `config` command, optional).

## Addresses file

`DATA_DIR/addresses.json`, format 2:

```json
{ "version": 2, "owners": { "<uuid>": "mossy-otter-27" }, "slots": { "<uuid>": { "1": "brave-fox-42" } } }
```

`owners` holds slot 0 and is the same table as in format 1, so a relay older than 1.3 still finds every classic
address in a format-2 file. A format-1 file is upgraded on start; the original is kept as `addresses.v1.json`.

## License

Apache-2.0, like the whole repository: see [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
