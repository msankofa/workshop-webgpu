# Multiplayer host→guest jam — implementation plan

Reviewer verification of `consolidated-investigation.md`, comparison against the Claude Craft
reference bundle, and a phased fix plan. No product code was changed while producing this plan.

---

## 1. Verdict: CONFIRMED (with refinements)

The diagnosis is correct: the host broadcasts a full O(creatures) JSON snapshot on a blind
50 ms `setInterval` with no `ws.bufferedAmount` check, all host→guest world state rides that
one ordered socket, and the guest's 3-snapshot clamp-on-stall interpolation buffer turns the
resulting backlog into the observed freeze / mach-speed signature. Every load-bearing claim
checked out against the source. Refinements and one missed implementation constraint below.

### Confirmed claims, with my own citations

- **Blind 20 Hz send, no backpressure check.** `BROADCAST_MS = 50` (`multiplayer.js:57`).
  `createHostSession` installs `setInterval(() => { ... ws.send(JSON.stringify({type:'sim_state',
  seq: seq++, ...state})) }, BROADCAST_MS)` (`multiplayer.js:75-79`). The only guard is
  `ws.readyState !== WebSocket.OPEN` (`multiplayer.js:76`); `ws.bufferedAmount` is never read
  anywhere in the file. `ws.send()` never blocks, so when per-tick bytes exceed what the link
  drains in 50 ms, the buffer grows without bound.
- **Payload is O(creatures × limbs), verbose JSON, full snapshot every tick.** `getState()`
  (`environment-viewer.html:238-253`) maps every creature to
  `{ id, p:[3], q:[4], ypr:[3], hp, feet:[legs×3], hands:[arms×3] }`
  (`environment-viewer.html:239-247`) with unrounded doubles (up to ~17 chars per number in
  JSON). Entities are a **full** snapshot every tick by design: `entity-registry.js:135-148`
  ("Full snapshots only this milestone", returns `{ full: true, ... }`). No deltas anywhere.
- **All host→guest world events share the one socket, inside `sim_state`.** Host avatar rides
  in `sim_state.players` (`getLocalPlayerState('host')` pushed at
  `environment-viewer.html:249-250`); placed lights ride in `sim_state.entities =
  entityRegistry.snapshot()` (`environment-viewer.html:252`); a creature-count change is just a
  reshaped `sim_state.creatures`. TCP+WebSocket deliver in order → a saturated socket
  head-of-line-blocks avatar, lights, and roster together.
- **Relay is a dumb in-order forwarder with no guard.** Host branch: one `JSON.stringify(msg)`
  then unconditional `g.send(payload)` to every guest with `readyState === 1`
  (`server/server.js:68-74`). Guest branch forwards `{...msg, clientId}` to the host
  (`server/server.js:75-79`). No `bufferedAmount` check on either side.
- **Guest→host is O(1) and on independent sockets**, so the host never loses sight of guests.
  Guests send only a tiny `{type:'player_state', player}` at 20 Hz
  (`environment-viewer.html:266-270`) plus occasional `set_target`/`entity_intent` frames. The
  two directions do not share a queue.
- **Freeze:** `InterpolationBuffer` keeps the last 3 snapshots (`multiplayer.js:13-16`) and
  `sample()` clamps to the newest snapshot when `renderTime >= s[last].t`
  (`multiplayer.js:26`). The guest rAF samples `performance.now() - 100`
  (`multiplayer.js:139-143`). When the stream stalls, the sampler runs past the buffer and
  holds the last pose — creatures, host avatar, lights, and roster all freeze together because
  they are all inside the same stalled `sim_state`.
- **Mach speed on count decrease:** shrinking the payload lets the backlog drain in a burst;
  the 3-deep ring discards intermediates and the sampler crosses large position deltas in a few
  rAF frames.

### Refinements / corrections

1. **The mach-speed mechanism is sharper than "discarded intermediates".** The guest stamps
   every snapshot with **arrival time**, not host time: `buffer.push(msg, performance.now())`
   (`multiplayer.js:128`). During a burst drain, snapshots that are seconds apart in sim time
   arrive milliseconds apart, so the buffer's timebase is compressed: the sampler legitimately
   interpolates across a huge sim-time gap in a few ms of buffer time. Both effects (timebase
   compression + 3-deep discard) produce the teleport; arrival-time stamping is the dominant
   one. This doesn't change the fix, but it means "bigger buffer" alone would *not* fix
   mach-speed — pacing would need sender timestamps.
2. **`broadcast()` is dead code — the single-channel claim is even stronger than stated.**
   The diagnosis says lights/avatar "are bundled into, or queued strictly behind" the creature
   frames via `broadcast()` (`multiplayer.js:96-98`). In fact nothing in the codebase calls
   `.broadcast(` at all (searched all `.js`/`.html`/`.mjs`); every host→guest world event
   travels *inside* `sim_state` itself. The only non-`sim_state` frames a guest ever receives
   (`joined`, `host_joined`, `host_left`) originate at the **relay**, not the host
   (`server/server.js:53,59,88`).
3. **Which hop saturates is plausible but not proven.** The diagnosis asserts the host uplink
   is the tight link. That is the most likely candidate (host uplink carries the payload once
   and home uplinks are the smallest pipe in the path), but nothing measured it, and a
   host-side `bufferedAmount` check only observes the host→relay leg. If the relay→guest leg
   is ever the bottleneck (slow guest, relay egress limits), the host's own buffer stays empty
   and Phase 1 alone will not cure that guest. This upgrades the relay-side guard (Phase 1b)
   from "defensive nicety" to the required second half of the fix.
4. **Missed implementation constraint: the skip must happen *before* `getState()` runs.**
   `getState()` has send-marking side effects that assume the result is actually transmitted:
   - `entityRegistry.snapshot()` **drains** the `pendingRemoves` tombstone queue
     (`entity-registry.js:146`) — build a snapshot and throw it away and entity removals are
     silently lost to guests.
   - `makeSharedWorldSettingsPacket` / `makeSharedNpcConfigPacket` update their
     last-sent timestamps and signatures when they return a packet
     (`environment-viewer.html:184-192, 216-224`) — discard the result and a changed
     settings/config packet marks itself delivered without any guest seeing it.
   So the Phase 1 check is an early-return before calling `getState()`, which is also the
   cheapest place for it. (Skipped ticks are then genuinely free: no snapshot build, no
   stringify.)
5. **Minor, not the bug:** `_lerpState` matches creatures **by array index**
   (`multiplayer.js:206-208`), unlike players which match by id. When the count changes between
   two buffered snapshots, mismatched tail entries render unlerped. Cosmetic; note only.
6. All other line citations in the investigation doc check out (`:57`, `:75-79`, `:96-98`,
   `:13-16`, `:26`, `:128-131`, `:139-143`, `server.js:68-79`).

### Reference 2

Confirmed: `research/threejs-game-skills-main.zip` contains nine single-player authoring
skills (3d-generator, aaa-graphics-builder, audio-generator, ...) and no networking content.
It contributes nothing to this fix.

---

## 2. What Claude Craft does, and what transfers to a dumb-relay + browser-host design

Claude Craft (extracted at `scratchpad/claudecraft-net/`) is **server-authoritative**: its Node
server is the snapshot source, so all of its protections live server-side.

| Claude Craft mechanism | What it does | Transfers to us? |
|---|---|---|
| `ws_backpressure.ts` — `isBackpressureExceeded(bufferedAmount, 8 MiB)`; the 20 Hz broadcast loop `terminate()`s any session past the cap | Kill-switch for non-draining clients so one stuck socket can't OOM the process or starve others. Their snapshots are a few KiB, so 8 MiB can only mean a dead client. | **Yes, adapted twice.** (a) On the **host's own outbound socket** — but as a *skip/coalesce latency governor*, not a kill switch: our frames are 10–100× bigger and the "slow peer" is our only relay link, so we skip ticks with a small cap instead of terminating (Phase 1). (b) On the **relay per-guest socket** — closest to their original meaning: skip superseded `sim_state` frames at a soft cap, terminate at a hard 8 MiB cap (Phase 1b). |
| Interest-scoped delta snapshots (`CLAUDE.md`: distance tiers with enter/drop hysteresis, lite-vs-full records, encoder omits unchanged/heavy fields via `maybe(...)`) | Structural payload reduction — the real reason their snapshots are a few KiB. | **Eventually, not now.** Per-client scoping/deltas require per-client encoding and baselines. Our relay broadcasts one identical payload to all guests (`server/server.js:71-73`) and has no per-guest addressing, and our own doc defers deltas to "milestone B" (`docs/subsystems/multiplayer.md:414-416`). Phase 2 takes the cheap subset (quantization, rate splitting) that works within broadcast. |
| `msg_rate_limit.ts` — inbound token bucket (60 burst / 40 s⁻¹ refill, drop-then-kick) | Protects server CPU from inbound floods. | **Not needed for this bug.** Our inbound (guest→host) direction is the healthy one. Could someday guard the relay against a hostile guest; out of scope. |
| `guarded_iter.ts` — per-item try/catch in the broadcast hot loop | One bad session can't unwind the tick for everyone. | **Yes, trivially**, in the relay's guest loop (folded into Phase 1b). |
| `serial_writer.ts`, `tick_profiler.ts` | DB write ordering; tick profiling. | No (no DB), and we already have `frame-profiler.js`. |

The key inversion: Claude Craft never needs *sender-side* backpressure because its sender is the
server it controls, sitting on datacenter bandwidth with KiB-sized interest-scoped frames. Our
sender is a browser on a home uplink emitting 10s-of-KiB frames through a relay it can't see
past. So the primary control point moves to the host's own `ws.bufferedAmount` — the one
congestion signal the browser exposes — and the relay keeps a per-guest copy of the original
pattern for the hop the host can't observe. That adaptation is correct, and both layers are
needed (see Verdict refinement 3).

---

## 3. Phased plan (ordered by impact per effort)

### Phase 1 — host-side backpressure skip (the cure)

- **Problem:** `createHostSession`'s interval enqueues a full snapshot every 50 ms regardless
  of whether the previous ones left the machine (`multiplayer.js:75-79`). Backlog grows
  unboundedly; every host→guest event is behind it.
- **Change:** in `multiplayer.js`:
  1. Add a small exported pure helper (mirrors Claude Craft's `isBackpressureExceeded`, kept
     Node-importable like `InterpolationBuffer`):
     ```js
     export const HOST_MAX_BUFFERED_BYTES = 128 * 1024;
     export function shouldSendSnapshot(bufferedAmount, limit = HOST_MAX_BUFFERED_BYTES) {
       return bufferedAmount <= limit;
     }
     ```
  2. In the interval callback (`createHostSession`), before `getState()` is called:
     ```js
     if (ws.readyState !== WebSocket.OPEN) return;
     if (!shouldSendSnapshot(ws.bufferedAmount)) { skippedTicks++; return; }
     ```
     The early return **must** precede `getState()` — see Verdict refinement 4 (tombstone
     drain at `entity-registry.js:146`, send-marking at `environment-viewer.html:184-192,
     216-224`). `seq` increments only on actual sends. Coalescing is implicit: the next
     permitted tick calls `getState()` fresh, so guests always get the latest state, never a
     stale queued one.
  3. Cheap observability: keep a `skippedTicks` counter and dispatch a throttled
     `window` CustomEvent (`mp:backpressure`, at most once per ~2 s) with
     `{ skippedTicks, bufferedAmount }` so the perf HUD / console can show the link is
     saturated instead of failing silently.
- **Threshold justification (128 KiB):** a worst-case frame today is roughly 50–100 KiB
  (~0.8–1.2 KiB per creature: ~11 pose numbers + up to ~24 limb numbers, ~19 bytes each as
  unrounded JSON doubles, × 50–100 creatures). 128 KiB ≈ 1–2 worst-case frames: a healthy link
  that can carry the stream at all drains a frame well inside the 50 ms tick, so the check
  never trips in the good case; when it does trip, guest staleness is bounded by
  128 KiB ÷ uplink rate (~0.2 s at 5 Mbps, ~1 s at 1 Mbps) instead of growing without bound.
  Claude Craft's 8 MiB is the wrong number here — theirs is a dead-session detector for KiB
  frames; ours is a latency governor for 50 KiB frames. We skip, never terminate: the peer is
  our only relay link and reconnect/backoff already exists (`multiplayer.js:86-91`).
- **Win:** directly removes the unbounded queue. Under saturation, guests degrade to a lower
  effective snapshot rate with bounded (~0.2–1 s) latency instead of freezing for minutes;
  host movement, light placement, and creature-count changes stay visible; mach-speed bursts
  shrink to sub-second corrections.
- **Risk:** low. Behavior on healthy links is unchanged (buffer is ~0 at each tick). Worst
  case on a saturated link is a lower snapshot rate — which is already what the guest-side
  interpolation tolerates. One subtlety: `bufferedAmount` only sees the host→relay hop
  (covered by Phase 1b).
- **Effort:** small — ~15 lines in `multiplayer.js`, one test file.
- **Test:** `test-host-backpressure.mjs` (repo root, plain node, `console.assert` +
  `process.exit`, same style as `multiplayer-test.mjs`): `shouldSendSnapshot` at 0 / at limit /
  past limit / custom limit; plus a fake-socket loop test — drive a stub
  `{ readyState: 1, bufferedAmount, send(p){...} }` through the send-or-skip decision and
  assert (a) sends stop while `bufferedAmount` is held above the limit, (b) resume after it
  drops, (c) a `getState` spy is **not called** on skipped ticks (pins the
  before-`getState` ordering, which is load-bearing per refinement 4). If the interval body is
  too entangled to test directly, extract it as an exported
  `hostBroadcastTick(ws, getState, sendFrame)` helper and test that.

### Phase 1b — relay-side per-guest guard (the hop the host can't see)

- **Problem:** the relay `g.send(payload)`s unconditionally (`server/server.js:72-74`). A slow
  guest accumulates unbounded buffer in the relay process (memory risk on the Render
  instance), and if the relay→guest hop is the saturated one, Phase 1 never triggers and that
  guest still jams.
- **Change:** in `server/server.js` host-branch forwarding loop (`server/server.js:68-74`),
  mirroring Claude Craft's `ws_backpressure.ts` but with a two-tier verdict, plus per-guest
  try/catch (their `guarded_iter.ts` pattern):
  ```js
  const RELAY_GUEST_SKIP_BYTES = 1 * 1024 * 1024;  // skip superseded sim_state frames
  const RELAY_GUEST_KILL_BYTES = 8 * 1024 * 1024;  // non-draining session, terminate
  for (const g of r.guests.values()) {
    try {
      if (g.readyState !== 1) continue;
      if (g.bufferedAmount > RELAY_GUEST_KILL_BYTES) { g.terminate(); continue; }
      if (msg.type === 'sim_state' && g.bufferedAmount > RELAY_GUEST_SKIP_BYTES) continue;
      g.send(payload);
    } catch { /* one bad socket must not stop the loop */ }
  }
  ```
  Put the verdict in a pure helper (e.g. `guestSendVerdict(bufferedAmount, isSimState) →
  'send' | 'skip' | 'kill'` in a small `server/backpressure.js`) so it's testable without
  sockets. **Drop-frame vs terminate decision:** both — *skip* `sim_state` frames (each is
  superseded by the next; dropping is lossless in the limit), *terminate* only past the 8 MiB
  hard cap where the guest is provably not draining (Claude Craft's original semantics;
  `terminate()` fires the existing `close` handler, so `guest_left` bookkeeping at
  `server/server.js:82-94` runs for free). Non-`sim_state` messages are never skipped — they
  are not superseded by later frames (none exist from the host today since `broadcast()` is
  unused, but the protocol allows them).
- **Win:** caps relay memory per guest; fixes the jam when relay→guest is the tight hop;
  isolates one slow guest so it can't affect the relay process or (indirectly) other rooms.
- **Risk:** low. `bufferedAmount` on the `ws` package is the documented equivalent property.
  Thresholds are generous: 1 MiB ≈ 10–20 frames ≈ 0.5–1 s of stream.
- **Effort:** small — ~15 lines in `server/server.js` + helper + test.
- **Test:** `server/test-backpressure.mjs` (same conventions as existing
  `server/test-relay.mjs`): `guestSendVerdict` boundary cases at both caps and for
  sim_state-vs-other message types.

### Phase 2 — structural payload reduction (ranked)

The multiplayer doc already lists deltas/interest management as deferred **milestone B**
(`docs/subsystems/multiplayer.md:414-416` "Full snapshots every tick (no deltas) …
milestone B", and §Missing Subsystems 7). Options ranked by impact per effort *within the
current broadcast-only relay*:

1. **2a — Quantize numbers in `getState()` (do this with Phase 1).**
   Problem: unrounded doubles serialize at up to ~17 chars each; they dominate the payload.
   Change: round in `getState()` (`environment-viewer.html:239-247`) — positions/feet/hands to
   3 decimals (mm), quaternion/ypr to 4, hp to 3 (e.g. a local `q3 = v => Math.round(v * 1e3) / 1e3`).
   Win: ~2.5–3× fewer bytes for a few lines, no protocol or guest change at all.
   Risk: negligible (mm precision is far below ghost/creature visual scale).
   Effort: trivial. Test: not warranted beyond eyeballing; optionally log
   `JSON.stringify(state).length` once to record the before/after.
2. **2b — Decouple creature broadcast rate from player/entity rate.**
   Problem: creature poses are the O(n) bulk but tolerate lower rates; the host avatar and
   lights are tiny and deserve the full 20 Hz.
   Change: in `createHostSession`'s tick, include `creatures` (and per-creature `feet`/`hands`)
   only every 2nd tick (10 Hz), full frame otherwise. Guest side already half-tolerates this:
   `applyNetworkCreaturePose` skips missing `feet`/`hands` arrays gracefully
   (`port-creature-system.js:4938-4956`), but `_lerpState` dereferences `a.creatures.map`
   unconditionally (`multiplayer.js:206`) — it needs a guard to carry the other snapshot's
   `creatures` through when one side omits them (same pattern as the existing missing-`entities`
   guard pinned by `multiplayer-test.mjs:62-70`).
   Win: ~2× on the dominant term (~4× combined with 2a). Risk: moderate — interpolation edge
   cases when consecutive buffered snapshots disagree about the field being present.
   Effort: medium. Test: extend `multiplayer-test.mjs` with an omitted-`creatures` snapshot.
   Note: guests pose **real** creature meshes from `feet`/`hands` in network mode
   (`applyNetworkCreaturePose`, `port-creature-system.js:4922-4957`), so dropping limbs from
   the wire entirely is *not* an option without visibly killing limb animation — rate-halving
   and quantizing them is.
3. **2c — Interest scoping by guest camera.** Requires per-guest payloads: the host would have
   to encode per guest and the relay to address individual guests, breaking the current
   one-`stringify`-for-all broadcast (`server/server.js:71-73`) and adding a
   guest-camera-position uplink. This is Claude Craft's model and the right long-term shape,
   but it's a protocol change. Defer to milestone B.
4. **2d — Delta encoding.** Needs per-guest baselines and either acks or periodic keyframes,
   which the broadcast-only relay can't express today — explicitly the milestone B item
   (`docs/subsystems/multiplayer.md:414-416`). Defer; do after 2c since both need per-guest
   addressing.
5. **2e (optional, orthogonal) — `perMessageDeflate: true` on the relay's `WebSocketServer`.**
   Repetitive JSON compresses well (likely 4–8×) and browsers negotiate it automatically.
   Costs relay CPU/memory per connection (zlib contexts; the `ws` docs warn about memory
   fragmentation) on a small Render instance, and it does nothing for host CPU. Try only after
   measuring, and note it changes what `bufferedAmount` thresholds mean in compressed bytes.

### Guest-side robustness (noted, explicitly not the fix)

The guest faithfully renders what arrives; hardening it treats symptoms. If desired later:
carry a host timestamp in `sim_state` and use it (not arrival time, `multiplayer.js:128`) for
interpolation pacing, which would remove the mach-speed artifact for any residual bursts;
enlarge the ring past 3 with a drop-older-than-250 ms rule; surface a "connection degraded" HUD
from `seq` gaps (guests currently ignore `seq` entirely). None of these stop the queue from
forming — the fix is host-side (Phase 1) and relay-side (Phase 1b).

---

## 4. Leave alone / non-goals

- **No terminate on the host side.** The host's single socket is its only link; skip only.
  Reconnect/backoff already exists (`multiplayer.js:86-91`).
- **No binary serialization / schema rework / server-authoritative migration** in this pass —
  that's the "Multiplayer Reframe" roadmap in `docs/subsystems/multiplayer.md:178+`, not a bug
  fix.
- **Don't touch `InterpolationBuffer` clamp semantics** (no extrapolation): clamping is the
  correct stall behavior; with Phases 1/1b the stalls it papers over stop happening.
- **Don't "fix" `_lerpState`'s creature index-matching** (refinement 5) here — cosmetic,
  separate concern, and 2b will revisit that code anyway.
- **No inbound rate limiting** (Claude Craft `msg_rate_limit.ts`) — guest→host is the healthy
  direction; out of scope.

## 5. Required follow-ups (per workshop-webgpu CLAUDE.md)

- Update `docs/subsystems/multiplayer.md` in the same change: `createHostSession` behavior
  (skip-when-buffered, `HOST_MAX_BUFFERED_BYTES`, `mp:backpressure` event), relay forwarding
  rules (skip/kill thresholds), and the Tests section (new `test-host-backpressure.mjs`,
  `server/test-backpressure.mjs`); strike the "no backpressure" limitation lines that become
  false.
- Append one `agent_log.csv` row per logical change (`multiplayer` subsystem), e.g. one for
  Phase 1 (+ test + doc), one for Phase 1b (+ test + doc), one for 2a if done alongside.
- If `server/backpressure.js` is added, no code-map/doc-table changes are needed (it's part of
  the existing multiplayer subsystem, listed in its Files table).
