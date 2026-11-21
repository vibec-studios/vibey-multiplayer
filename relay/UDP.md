# UDP through the relay (relay 1.5): voice chat and Bedrock players

The relay forwards UDP for two things, next to the Minecraft TCP traffic on 25565:

| Channel | For | Public port | How the relay finds the host |
|---|---|---|---|
| `voice` | [Simple Voice Chat](https://modrinth.com/mod/simple-voice-chat) (SVC) | one shared port, `UDP_PORT` (24454) | the player's source IP has a live TCP connection into that world |
| `bedrock` | [Geyser](https://geysermc.org) (RakNet) | one port per host from `UDP_BEDROCK_PORTS` (19200-19299), fixed per (account, slot) | the port |

Hosts need no port forwarding: they open a UDP tunnel to the relay themselves (`relay.axolite.cc:24454`, the same port
as voice) and keep it open with keepalives, like the TCP control connection. Everything is optional: a host that does
not ask for UDP, and relays before 1.5, behave exactly as before.

## Files

| File | |
|---|---|
| `src/udp/config.ts` | Environment and limits |
| `src/udp/server.ts` | Shared socket (voice + tunnel), dispatch, sweep of idle peers |
| `src/udp/control.ts` | `udp` / `udp_ready` on the control connection, session lifecycle |
| `src/udp/tunnel.ts` | Packets from hosts (token, IP check, data, close) |
| `src/udp/voice.ts` | SVC packets on the shared port, candidate worlds by source IP, probing |
| `src/udp/bedrock.ts` | Per-host Bedrock port |
| `src/udp/ports.ts` | Bedrock port pool and leases (`DATA_DIR/udp-ports.json`) |
| `src/udp/registry.ts` | Sessions, peers, forwarding, limits |
| `src/udp/bucket.ts` | Token buckets and the new-peer limiter |
| `src/udp/frame.ts` | Tunnel packet format |
| `src/udp/metrics.ts`, `src/udp/status.ts` | Counters, `/status` part, `/metrics` lines |
| `test/udp-host.ts` | Reference host side of the tunnel (no dependencies) |
| `test/udp.ts`, `test/udp-util.ts` | End-to-end tests with local UDP echo servers |

## Authentication

- UDP is only handed out on a control connection that passed the Mojang check and the backend's `authorize`.
- The relay gives the host a random 16-byte token over the control connection; every tunnel packet carries it.
  Unknown tokens are dropped silently (never answered, so nothing can be reflected).
- With `UDP_HOST_SAME_IP=1` (default) the source IP of tunnel packets must equal the IP of the control connection. The
  source port may change (NAT); the relay always uses the one it saw last.
- Token, channels and peers end with the control connection (`replaced`, `kick_host`, `ban_uuid`, disconnect).

## Control messages

`ready` has `"features":["udp"]` when the relay can do UDP. Without it, do not ask.

| Direction | Message | |
|---|---|---|
| C → S | `{"t":"udp","channels":["voice","bedrock"]}` | Ask for channels. May come before `auth` (like `access`), applied after `ready`. Send again to change; `[]` closes everything |
| S → C | `udp_ready` | The answer, sent again after every `rotate` |
| S → C | `{"t":"udp_ok"}` | The first valid tunnel packet arrived |

```json
{ "t": "udp_ready", "token": "<32 hex>", "tunnel": { "port": 24454 },
  "channels": {
    "voice":   { "port": 24454, "address": "mossy-otter-27.axolite.cc:24454", "voiceHost": "24454" },
    "bedrock": { "port": 19207, "address": "mossy-otter-27.axolite.cc:19207", "host": "mossy-otter-27.axolite.cc" } },
  "denied": { "bedrock": { "code": "no_port", "msg": "No Bedrock port is free right now. Try again later." } } }
```

`denied` codes: `disabled` (not allowed by relay or backend), `no_port` (Bedrock pool full), `limit` (relay full).
After `{"t":"udp","channels":[]}` the answer has `"token":""` and no channels.

## Tunnel packets

Every packet starts with `00 56 42 55` ("\0VBU"); numbers are big endian.

Host → relay: `magic | type(1) | token(16) | …`

| Type | Rest | |
|---|---|---|
| `0x01` HELLO | | Right after `udp_ready`, then every 15 s. Without a packet for 45 s (`UDP_TUNNEL_IDLE_MS`) the tunnel counts as gone |
| `0x02` DATA | `peer(4) | payload` | Answer to a peer |
| `0x03` CLOSE | `peer(4)` | The host closed the peer |

Relay → host: `magic | type(1) | …` (no token; accept only packets from the relay's address)

| Type | Rest | |
|---|---|---|
| `0x81` ACK | | Answer to HELLO |
| `0x82` DATA | `peer(4) | channel(1) | payload` | Channel `1` = voice, `2` = bedrock |
| `0x83` CLOSE | `peer(4)` | The relay removed the peer (idle, limit, player left) |

For every `peer` the host opens its **own local UDP socket** and sends the payload to `127.0.0.1:<local port>` of the
channel (the SVC port or the Geyser port); what comes back on that socket goes to the relay as DATA with the same
`peer`. The local server thus sees every remote player as its own address. Close local sockets after 60 s without
traffic and send CLOSE. Never send anywhere else than 127.0.0.1. Payloads are at most `UDP_MAX_PACKET` (2048) bytes.

No `udp_ok` within 5 s of the first HELLO means the host's network blocks UDP: keep sending HELLO (every 2 s for up
to 30 s) and tell the user. There is no TCP fallback (yet).

## Voice (Simple Voice Chat)

- SVC packets from players start with `0xFF`, followed by a random connection id (not the player UUID) and the
  encrypted payload. The relay cannot see which world a packet belongs to, so it uses the source IP: a voice packet
  is accepted only when the same IP currently has a joined player (TCP, through the relay) in a world with a voice
  channel. With several such worlds (two players of one home network in different worlds) the first packets go to all
  of them (at most 4) and the peer is bound to the world that answers first; the SVC servers of the others drop the
  unknown connection id. When the player leaves the world, the voice peer is removed (within 5 s).
- Hosts make SVC hand out `voiceHost` from `udp_ready`, which is just the port (`"24454"`): SVC then uses the host
  name the player is connected to, i.e. the relay address. This survives `rotate` and domain changes.
  - Mod / Vibey Client (integrated world): `de.maxhenkel.voicechat.api.events.VoiceHostEvent#setVoiceHost`.
  - Launcher (dedicated server): `voice_host=24454`, `bind_address=127.0.0.1` and a free local `port` in
    `config/voicechat/voicechat-server.properties` (Fabric/NeoForge) or `plugins/voicechat/voicechat-server.properties`
    (Paper).
- Players only need SVC and the normal relay address.

## Bedrock (Geyser + Floodgate)

- Meant for dedicated servers started by the launcher. Geyser listens on `127.0.0.1:<local port>` (`bedrock.address`,
  `bedrock.port`, `clone-remote-port: false`), `remote` points at the Java server, `auth-type: floodgate`.
- Bedrock players add a server with address `channels.bedrock.host` and port `channels.bedrock.port`.
- The port is leased per (account, slot) and survives reconnects and relay restarts. Only when the pool is full does
  the lease that was unused for the longest time go to someone else.
- `banIps` of `access` also applies to new Bedrock peers. The relay's whitelist and name bans do not (Bedrock has no
  plain-text login); use the server whitelist / Floodgate.

## Abuse protection

| Variable | Default | |
|---|---|---|
| `UDP_PORT` | `24454` | Shared port for voice and the host tunnel, `0` = UDP off |
| `UDP_PUBLIC_PORT` | `UDP_PORT` | Port reported in `udp_ready` |
| `UDP_BIND` | `0.0.0.0` | Bind address (IPv4 only) |
| `UDP_BEDROCK_PORTS` | `19200-19299` | Bedrock pool, empty = no Bedrock |
| `UDP_CHANNELS` | `voice,bedrock` | Allowed channels when the backend says nothing |
| `UDP_HOST_SAME_IP` | `1` | Tunnel packets only from the control connection's IP |
| `UDP_MAX_PEERS` | `4096` | Peers on the whole relay |
| `UDP_MAX_PEERS_PER_HOST` | `MAX_STREAMS` | Peers per host and channel |
| `UDP_NEW_PEERS_PER_IP` | `20` | New peers per source IP per 10 s |
| `UDP_PEER_PPS` / `UDP_PEER_BPS` | `300` / `262144` | Player → host per peer, burst 2 s |
| `UDP_HOST_BPS` | `4194304` | Host → all its players, burst 2 s |
| `UDP_MAX_PACKET` | `2048` | Largest payload |
| `UDP_PEER_IDLE_MS` | `60000` | Peers without traffic are removed |
| `UDP_TUNNEL_IDLE_MS` | `45000` | Host tunnel without packets counts as gone |

- The relay never answers unknown sources or wrong tokens.
- Voice peers only come from IPs with a live TCP join into that world: no amplification, no scanning of hosts.
- Bedrock amplification guard: until a peer has sent a RakNet datagram (`0x80-0x8f`, a real session), the relay sends
  it at most 3 × the bytes it received + 1500 bytes. Spoofed ping floods do not pay off.

## Backend

- `authorize` may answer `udp`: `false` (no UDP) or `{ "voice": true, "bedrock": false }`; a missing key falls back to
  `UDP_CHANNELS`. Refused channels come back as `denied.<channel>.code = "disabled"`.
- `heartbeat` additionally sends `udp: { sessions, peers, voicePeers, bedrockPeers }`.
- No new event types.

## Metrics

- `/status` has `udp`: `enabled`, `port`, `bedrockPorts { from, to, used }`, `sessions`, `peers`, `voicePeers`,
  `bedrockPeers`, `totals { packetsIn, packetsOut, bytesIn, bytesOut, peersOpened, dropped { … } }`. No IPs or names.
- `/metrics` (Prometheus text): `vibey_udp_packets_total{dir}`, `vibey_udp_bytes_total{dir}`,
  `vibey_udp_peers_opened_total`, `vibey_udp_dropped_total{reason}`, `vibey_udp_peers{channel}`, `vibey_udp_sessions`,
  `vibey_udp_bedrock_ports_used`, plus `vibey_hosts`, `vibey_players`, `vibey_joins_total`, `vibey_pings_total`,
  `vibey_blocked_total`.
- Drop reasons: `unknown`, `auth`, `rate`, `size`, `limit`, `banned`, `amplification`, `no_tunnel`, `peer`.

## Deployment

Open inbound on the server (in addition to TCP 25565): **UDP 24454** and **UDP 19200-19299**, e.g.
`ufw allow 24454/udp` and `ufw allow 19200:19299/udp`, plus the cloud firewall if there is one. `docker-compose.yml`
maps both. Docker forwards UDP with DNAT, so the real source IP stays visible (the voice check needs it). With 100
mapped ports Docker may start many `docker-proxy` processes; `"userland-proxy": false` in the daemon config or
`network_mode: host` avoids that. DNS needs nothing new: UDP uses the same IP as `*.axolite.cc` and `relay.axolite.cc`
(DNS-only records). The volume now also holds `udp-ports.json`.

Check from outside with the reference client and a local echo, e.g. SVC on 24454 and Geyser on 19132:

```bash
node test/launcher-client.ts --relay relay.axolite.cc:25565 --port 25565 --name <name> --uuid <uuid> --slot 1 \
  --voice-port 24454 --bedrock-port 19132
curl http://<server>:8765/metrics | grep vibey_udp
```

## Limits

- IPv4 only (the relay addresses have A records only).
- No TCP fallback when a host's network blocks UDP.
- Plasmo Voice is not supported (different protocol); a generic channel with its own port would be easy to add.
- Bedrock players are not covered by the relay whitelist.
