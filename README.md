<div align="center">

# Colyseus Cloudflare

**Run Colyseus rooms and authoritative physics on Cloudflare Durable Objects.**

[![CI](https://github.com/yocontra/colyseus-cloudflare/actions/workflows/ci.yml/badge.svg)](https://github.com/yocontra/colyseus-cloudflare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

This independent TypeScript adapter connects Colyseus rooms to Cloudflare
Durable Objects. Add headless PlayCanvas and Ammo/Bullet when the server needs
authoritative physics.

**Play the demo.** [Out West](https://contra.io/experiments/out-west/) uses the
library in Frontier multiplayer. [Open Frontier](https://contra.io/experiments/out-west/frontier/).

## How it works

The application Worker routes each room to a Durable Object. The Object owns the
WebSockets, Colyseus room, and simulation. Colyseus handles room messages and
state synchronization. Your game defines the room state, validates player
commands, and decides what runs on each tick.

```mermaid
flowchart LR
    Client["Browser · Colyseus SDK"]
    Worker["Application Worker · identity and routing"]
    subgraph DO["Durable Object · one room"]
        Socket["WebSocket adapter"]
        Room["Colyseus room · game rules and state"]
        Seats["SQLite · expiring seats"]
        World["Optional PlayCanvas and Bullet world"]
        Socket <-->|"Colyseus packets"| Room
        Room -->|"fixed physics steps"| World
        World -->|"positions and contacts"| Room
        Socket --- Seats
    end
    Client -->|"Reserve a seat and upgrade"| Worker
    Worker -->|"Route by room ID"| Socket
    Socket -->|"State patches and messages"| Client
```

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as Application Worker
    participant D as Room Durable Object
    participant R as Colyseus room
    B->>W: Request a seat
    W->>D: Route verified identity and room
    D-->>B: Return the expiring reservation
    B->>W: Open a WebSocket with the reservation
    W->>D: Forward the upgrade
    D->>D: Consume the seat atomically
    D->>R: Join with CloudflareClient
    loop While the room is active
        B->>R: Send input through the socket adapter
        R->>R: Advance game state and optional physics
        R-->>B: Send Colyseus state patches
    end
    B->>D: Disconnect
    D->>R: Forward the close
    Note over D,R: When the room empties, stop its timer and destroy its world
```

## Use it in a Worker

1. Bind a SQLite-backed Durable Object namespace in Wrangler with
   `new_sqlite_classes` and enable `nodejs_compat`.
2. Authenticate the browser in your Worker. Route seats and upgrades to the
   same Object. Use `DurableSeats` if you want SQLite-backed, single-use
   reservations.
3. In the Object, wrap the server socket with `CloudflareClient` and join it
   with Colyseus. Forward message events to `dispatch()` and socket closure
   to `disconnected()`.
4. When your room runs physics, load the Worker Wasm modules once with
   `initializeWorkerAmmo()`. Create a separate world for each active room,
   step it with a fixed timestep, and call `app.destroy()` when the room
   ends. See the [Worker](example/worker.ts), [physics room](example/physics-room.ts),
   and [Wrangler configuration](example/wrangler.jsonc).

The application owns authentication, room routing, game rules, and admission
policy. If a Durable Object restarts, clients need a new authenticated join.
The in-memory Colyseus room and Bullet world must be recreated.

| Package export                       | Purpose                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `colyseus-cloudflare/transport`      | Adapt a Durable Object WebSocket to a Colyseus server client.                                                    |
| `colyseus-cloudflare/clock`          | Give Colyseus a clock that advances during quiet Worker timer callbacks. Match `stepMs` to your simulation tick. |
| `colyseus-cloudflare/seats`          | Issue and consume expiring seat reservations. Schedule an alarm from `nextExpiry()` and run `expire()` on wake.  |
| `colyseus-cloudflare/admission`      | Reserve budget for room duration and inbound frames in a shared SQLite ledger.                                   |
| `colyseus-cloudflare/worker-physics` | Load precompiled Ammo and callback Wasm modules in Wrangler.                                                     |
| `colyseus-cloudflare/physics`        | Create a headless PlayCanvas application and a room-owned Bullet world.                                          |
| `colyseus-cloudflare/ammo`           | Initialize Ammo with a compiled module or load it from a URL.                                                    |
| `colyseus-cloudflare/ammo.wasm`      | Serve the same Ammo binary to browser prediction code.                                                           |
| `colyseus-cloudflare/client`         | Optionally batch two reliable SDK input packets into one socket frame. Use with the matching server adapter.     |

The input batcher sends pairs of eligible packets at once and flushes a lone
packet after 100 ms. Control packets pass through immediately and can overtake
queued inputs.

## Out West integration

| In Out West                                                                                                                     | What it does                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Town lobby](https://github.com/yocontra/yocontra.github.io/blob/master/api/src/town/lobby.ts)                                  | Authenticates the connection, consumes its seat, and connects the Durable Object WebSocket to Colyseus. |
| [Server room](https://github.com/yocontra/yocontra.github.io/blob/master/api/src/game/room.ts)                                  | Loads Worker Ammo and advances the authoritative Frontier simulation.                                   |
| [Physics world](https://github.com/yocontra/yocontra.github.io/blob/master/src/experiments/out-west/runtime/world.ts)           | Builds Frontier's bodies and collisions on the shared PlayCanvas physics wrapper.                       |
| [Browser session](https://github.com/yocontra/yocontra.github.io/blob/master/src/experiments/out-west/client/remote-session.ts) | Connects the Colyseus SDK and batches reliable player inputs.                                           |

## Build and run the example

Use Node 24 or newer. The package emits ESM and TypeScript declarations.

```sh
git clone https://github.com/yocontra/colyseus-cloudflare.git
cd colyseus-cloudflare
npm ci
npm pack --pack-destination example
cd example
npm install --ignore-scripts --no-package-lock
npm run dev
```

From a second terminal in `example/`, run `npm run smoke`. Three SDK clients
join two rooms. The test checks that a seat reservation leaves physics idle,
players see a box land and hop, and the second room keeps running after the
first room empties. The example uses local test identities.

To use the tarball in your own project, run
`npm install /path/to/colyseus-cloudflare-0.1.0.tgz` from that project.

## Keep rooms within your budget

Start physics and timers when a player joins. Stop them after the last player
leaves. A running room can consume Durable Object duration even when its sockets
are quiet.

To share a budget across rooms, keep `AdmissionLeases` in a single SQLite-backed
Object. Reserve and renew a lease per live room, report its final use when it
closes, and stop a room when renewal is denied. Unreported leases retain their
reservation for the day. Leases that cross midnight UTC carry their reservations
into the next day. Reported seconds count from midnight and the message count
since the last report is charged to the new day. The ledger tracks the
application's configured allowance. Cloudflare meters the account separately.
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) ·
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks, [SECURITY.md](SECURITY.md) for
private reporting, and [third-party notices](THIRD_PARTY_NOTICES.md) for the
bundled Ammo assets.
