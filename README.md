<img src="assets/icon.svg" width="64" height="64" alt="">

# Vibey Multiplayer

**Host your singleplayer world for friends anywhere. One fixed address, no port forwarding, no server.**

A client mod for Fabric and NeoForge by Vibe Craft Studios. Open your world from the pause menu, copy your address,
send it to your friends. They join with a normal, unmodded Minecraft through *Multiplayer → Direct Connection*.

![Minecraft](https://img.shields.io/badge/Minecraft-1.21%E2%80%9326.3-green)
![Loader](https://img.shields.io/badge/Loader-Fabric%20%7C%20NeoForge-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

## Features

- **Your own address.** Every player gets one address like `mossy-otter-27.play.example.com`. It stays the same
  every time you host, in every world, until you decide to **renew** it (the old one stops working right away).
- **Host World** button in the pause menu, in place of *Open to LAN*.
- **Simple by default:** game mode for guests, cheats, force mods. That's it.
- **Players:** see who is online, give or take **OP** with one click, kick.
- **Advanced** (folded away): PvP, max players, exact mod versions, new address, own relay server.
- **Force mods:** guests need Vibey and the same mods as you. Anyone who is missing something gets a clear list
  of what to install instead of a cryptic registry error.
- **Friends don't need the mod** (unless you turn on *Force mods*).
- End-to-end encrypted in online mode: the relay forwards bytes, it never sees inside the Minecraft connection.

| Hosting | Advanced |
|---|---|
| ![Host screen while online](docs/screenshots/host-online.png) | ![Advanced options](docs/screenshots/host-advanced.png) |

*Screenshots from the automated client test (Fabric 1.21.11, local test relay).*

## Supported versions

| Minecraft | Fabric | NeoForge |
|---|---|---|
| 1.21, 1.21.1 | ✔ | ✔ |
| 1.21.2, 1.21.3 | ✔ | ✔ |
| 1.21.4 | ✔ | ✔ |
| 1.21.5 | ✔ | ✔ |
| 1.21.6 – 1.21.8 | ✔ | ✔ |
| 1.21.9, 1.21.10 | ✔ | ✔ |
| 1.21.11 | ✔ | ✔ |
| 26.1, 26.2, 26.3 | ✔ | ✔ |

Fabric needs [Fabric API](https://modrinth.com/mod/fabric-api). The mod only runs on the client.

## How it works

```
 Friend (vanilla MC)            Relay (one TCP port)                 You (Minecraft + Vibey)
 ───────────────────            ────────────────────                 ───────────────────────
 connect mossy-otter-27… ──►   reads the host name from the   ◄──   control connection
                                Minecraft handshake, knocks          ("I own mossy-otter-27",
                                on your control connection           proven with your Mojang login)
                                                                ◄──   opens a data connection
                                splices both sockets          ──►   and glues it to 127.0.0.1:<LAN port>
                                                                     of your integrated server
```

- Your world is published like *Open to LAN*; Vibey connects that port to the relay. Nothing else on your
  computer is reachable.
- The relay proves who you are with the same Mojang session check servers use, so nobody can take your address.
- Addresses come from wildcard DNS (`*.play.example.com`) pointing at the relay, so friends never type a port.
- When you are offline, your address still answers in the server list: *"This world is offline"*.

## Running the relay

The relay is one file without dependencies: [`relay/server.ts`](relay/server.ts) (Node 23.6+ or Bun).

1. Point a wildcard DNS record at your server: `*.play.example.com  A  <server IP>`.
2. Start it:
   ```bash
   cd relay
   DOMAIN=play.example.com node server.ts
   # or: docker compose up -d   (edit DOMAIN in docker-compose.yml)
   ```
3. Put the relay address into `default_relay` in [`gradle.properties`](gradle.properties) before building, or
   let players enter it under *Advanced → Relay server*.

| Variable | Default | |
|---|---|---|
| `PORT` | `25565` | Port for players **and** hosts |
| `DOMAIN` | `play.example.com` | Wildcard domain of the addresses |
| `PUBLIC_PORT` | `PORT` | Port shown in addresses (if not 25565) |
| `DATA_DIR` | `./data` | Where address ownership is stored (`addresses.json`) |
| `HTTP_PORT` | off | `/health` and `/stats` |
| `MAX_STREAMS` | `64` | Connections per host |
| `ALLOW_OFFLINE` | off | `1` skips the Mojang check (local testing only!) |

`node relay/selftest.ts` runs an end-to-end test with a fake host and fake players.

## Building

```bash
./gradlew buildAll          # every Fabric and NeoForge version, jars land in build/dist
./gradlew :fabric-1.21.11:runClient
```

Requires JDK 21 and JDK 25 (Minecraft 26.x). Multi-version builds use
[Stonecutter](https://stonecutter.kikugie.dev/): one source tree, version-specific lines are marked with
`//? if >=1.21.9` comments. Everything that differs between versions sits in `Compat.java`, `client/ui/Gfx.java`,
`client/ui/BaseScreen.java` and the two loader entry points.

## Settings file

`config/vibey.json` holds the host settings (game mode, cheats, force mods, PvP, max players, relay, last address).

## License

[MIT](LICENSE). Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
