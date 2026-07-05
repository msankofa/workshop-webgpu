# Multiplayer host→guest jam — consolidated investigation

**Symptom (operator report).** With many creatures, guests cannot see the host move, place
lights, or decrease creature count, and creatures appear to freeze on the guest. When the host
*decreases* creature count, guests briefly see everything move at "mach speed", then normal, and
regain sight of the host. The host *never* loses sight of guests moving. The jam is
**one-directional**: host→guest world events jam; guest→host input does not.

> Provenance: the three Sonnet domain investigators (host-outbound / relay / guest-ingest) were
> dispatched but all died on the account session-limit reset before their first write. This
> document is the equivalent investigation done inline against the same source, fully cited.

## Verdict: CONFIRMED — single-socket head-of-line block from unbounded host send-buffer growth, no backpressure anywhere.

## Domain 1 — Host outbound (`multiplayer.js`, `environment-viewer.html` `getState`)

- The host broadcasts on a blind `setInterval(BROADCAST_MS=50ms)` that calls `getState()` and
  `ws.send(JSON.stringify({type:'sim_state', seq, ...state}))` with **no `ws.bufferedAmount`
  check** (`multiplayer.js:75-79`). `BROADCAST_MS=50` at `:57`.
- `ws.send()` never blocks; unacked bytes pile into the socket's outbound buffer
  (`ws.bufferedAmount`). If the per-tick JSON exceeds what the host's **uplink** can flush in 50 ms,
  the buffer grows every tick and never drains. Home uplinks are asymmetric and small (~1–10 Mbps),
  and the host payload is O(creatures), so this is the tight link.
- **Payload scales with creature count.** Per the multiplayer doc, each creature contributes
  `id, p, q, hp, ypr, feet[], hands[]` — `feet`/`hands` are arrays of vec3, so bytes per creature
  scale with limb count; `_lerpState` confirms the decoded shape (`multiplayer.js:206-217`).
  Encoding is verbose JSON text, **full snapshot every tick, no deltas** (multiplayer doc §"Host
  Snapshot Broadcast" limitations, and §9 "Full snapshots every tick").
- **Everything host→guest shares this one ordered socket.** The host's own avatar rides in
  `sim_state.players` (the `id:'host'` capsule), placed lights ride in `sim_state.entities =
  entityRegistry.snapshot()`, and a creature-count change just reshapes `sim_state.creatures`.
  There is **no separate control channel**: `broadcast()` (`multiplayer.js:96-98`) sends on the
  same `ws`. So avatar/light/roster updates are bundled into, or queued strictly behind, the fat
  creature frames. TCP + WebSocket deliver in order → head-of-line blocking of *all* host→guest
  traffic together. This is precisely "the queue of host world events to the client was jammed."

## Domain 2 — Relay (`server/server.js`)

- Dumb in-order forwarder, **no backpressure, no coalescing, no rate limit**. On a host message it
  does `JSON.stringify(msg)` once then `g.send(payload)` to every guest whose `readyState===1`
  (`server.js:68-74`). On a guest message it forwards `{...msg, clientId}` to the host
  (`server.js:75-79`).
- The two directions use **independent sockets**, so there is no single shared queue coupling them.
  The asymmetry is inherent: host→guest carries O(creatures) snapshots; guest→host carries only
  tiny per-guest `player_state`/`set_target`/`entity_intent` frames. The guest uplink never
  saturates, so the host keeps seeing guests perfectly.
- Secondary risk: the relay calls `g.send()` unconditionally, so a slow guest accumulates unbounded
  buffer on the *relay's* per-guest socket (same failure claudecraft's `ws_backpressure.ts` guards
  against). Not the primary cause here — the host uplink saturates first — but worth a defensive
  guard.

## Domain 3 — Guest ingest/render (`multiplayer.js` guest session)

- `sim_state` frames are pushed into an `InterpolationBuffer` that keeps only the **last 3
  snapshots** (`push`, `:13-16`); the rAF `tick()` samples at `now-100ms` (`:139-143`).
- **Freeze:** when the backlogged stream stalls, `sample()` runs past the newest buffered time and
  **clamps to the last snapshot** (`:26`) → ghosts hold still = "creatures stop." Host avatar,
  lights, and roster are all inside that same stalled `sim_state`, so they freeze together.
- **Mach-speed catch-up:** when the host payload shrinks (creature count dropped) the host uplink
  drains its backlog in a burst. The buffer holds only 3 snapshots, so a burst **discards
  intermediate snapshots** and the sampler jumps across large position deltas in a few rAF frames →
  ghosts teleport forward = "mach speed", then real-time resumes once caught up.
- Guest ingest is **not** the root cause (it faithfully reflects whatever arrives) but it fully
  explains the *visible* freeze-then-mach-speed signature. Note `mp:*` events for non-`sim_state`
  types are dispatched immediately (`:129-131`), but the world-state that jams all travels inside
  `sim_state`.

## Root cause (one line)

No backpressure on the host broadcast: `setInterval` blindly enqueues a full-state JSON every 50 ms
regardless of `ws.bufferedAmount`, so when per-tick payload × 20 Hz exceeds host uplink the single
ordered socket's send buffer grows without bound and head-of-line-blocks every host→guest event.
Guest→host is O(1) and unaffected.

## How Claude Craft (`research/world-of-claudecraft-main.zip`) solves the same problem

Extracted references in `scratchpad/claudecraft-net/`. Claude Craft is an **authoritative Node
server** (not a dumb relay), so its server is the snapshot *source* and applies backpressure per
client:

1. **`ws_backpressure.ts`** — `isBackpressureExceeded(bufferedAmount, limit=8 MiB)`. The 20 Hz
   `broadcastSnapshots()` loop checks each client's `bufferedAmount` and `terminate()`s any session
   past the cap, so a non-draining client cannot OOM the process or starve others
   (`ws_backpressure.test.ts`, `backpressure.test.ts` prove "does not starve other players when one
   session is stuck"). Comment names our exact failure: *"a single client that stops draining its
   socket accumulates an unbounded write buffer."*
2. **Interest-scoped delta snapshots** (`src/net/CLAUDE.md`) — per-client distance tiers
   (`INTEREST_RADIUS`/`DROP_RADIUS` with enter/drop hysteresis), "lite vs full" records, and the
   encoder **omits unchanged/heavy fields** (`maybe(...)`, delta-guarded decode). This is the
   structural payload fix our own doc lists as deferred "milestone B."
3. **`msg_rate_limit.ts`** — token-bucket cap on *inbound* frames (drop-then-kick), protects server
   CPU from floods.
4. **`guarded_iter.ts`** — per-item try/catch in the broadcast loop so one bad session can't unwind
   the whole tick.

**Architectural adaptation for us.** Their backpressure lives on the server because the server is
the source. In our design the *browser host* is the source and the relay is dumb, so the primary
backpressure point is the **host's own outbound socket**: before enqueuing the next `sim_state`,
check `ws.bufferedAmount` and **skip (coalesce to latest) when it's backed up**. That is the piece
claudecraft doesn't need but we do. The relay-side per-guest guard (drop/kick a non-draining guest,
their `ws_backpressure.ts` pattern) is a secondary defensive layer. Interest scoping / deltas are
the same long-term payload fix, higher effort.

## `research/threejs-game-skills-main.zip`

No networking content. Nine single-player authoring skills (3d-generator, aaa-graphics-builder,
audio-generator, debug-profiler, game-director, game-ui-designer, gameplay-systems, image-generator,
qa-release). Nothing applicable to this bug; the debug-profiler is at most tangential for measuring a
fix. Not a source for the plan.
