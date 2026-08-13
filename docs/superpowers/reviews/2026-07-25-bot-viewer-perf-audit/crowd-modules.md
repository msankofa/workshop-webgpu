# Lens: crowd modules (bot-separation / bot-cover) — model: sonnet

Scope: every line of `bot-separation.js` (97 lines) and `bot-cover.js` (123 lines), plus every
call site of their exported functions in `bot-viewer.html` (grepped and read in context) to
establish actual invocation frequency. Only findings whose cost scales with bot count or call
frequency are listed.

## Finding: `followPath` reallocates the full bot list every waypoint pop, for every moving bot, every frame

- File: `bot-viewer.html`, line 2698 (inside `followPath`, function spans 2692-2740)
- Excerpt:
  ```js
  while (path.length > 0) {
    const target = path[0];
    const p = botXZ(entity);
    const dx = target.x - p.x, dz = target.z - p.z;
    const dist = Math.hypot(dx, dz);
    const others = botActors.map((a) => a.entity);
  ```
- Why slow at high N: `others = botActors.map(...)` allocates a brand-new `Array` of length N
  (all bots, dead ones included — `waypointContested`/`separationXZ` filter dead bots out
  internally, but the array itself still holds them and is walked) on **every** call to
  `followPath`, and it sits inside the `while` loop so a single call that pops more than one
  waypoint (common right after a re-path or a relaxed-reach pop) allocates multiple times.
  `followPath` is the movement primitive for essentially every bot state — grep shows 11 call
  sites (patrol, pursue, recover, flee, pack-seek, cover-move, muzzle-recovery, medic-move,
  roam) — so this runs once per moving bot per frame.
- Cost scaling: O(N) allocation × O(N) moving bots called per frame = O(N²) array-element
  writes/sec of garbage, on top of the CPU cost below. At 100 bots with ~80 concurrently in a
  movement state, that's roughly 80 fresh 100-element arrays every frame (≈480,000
  array-element writes/sec at 60 fps), pure GC pressure with zero caching.
- Estimated severity at 100 bots: High (GC pauses/stalls are the classic symptom of exactly this
  pattern — many short-lived same-shape arrays created every frame).
- Fix sketch: hoist `others` out of the `while` loop (compute once per `followPath` call, not
  per waypoint pop), and cache/reuse a single live-bots array per frame in `updateAllBots`
  (already computed once as `living` at line 939) instead of re-deriving `botActors.map(...)`
  inside a per-bot hot path.
- Call-site evidence: `followPath` invoked at `bot-viewer.html:1823, 2906, 3013, 3232, 3262,
  3282, 3356, 3384, 3454, 3653, 3708` — i.e. from nearly every per-state movement handler,
  each itself called once per living bot per frame from `updateBotSentry`/`updateBot`
  (`bot-viewer.html:934-935`, inside the per-bot loop in `updateAllBots`, `bot-viewer.html:924`).

## Finding: `separationXZ` / `waypointContested` are O(N) linear scans invoked once per moving bot per frame — O(N²) aggregate, no spatial partitioning

- File: `bot-separation.js`, lines 36-49 (`separationXZ`) and 64-73 (`waypointContested`)
- Excerpt (`separationXZ`):
  ```js
  export function separationXZ(self, bots, radius) {
    let sx = 0, sz = 0, any = false;
    for (const other of bots) {
      if (other === self || other.alive === false) continue;
      const dx = self.capsule.start.x - other.capsule.start.x;
      const dz = self.capsule.start.z - other.capsule.start.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1e-6 || dist > radius) continue;
  ```
  Excerpt (`waypointContested`):
  ```js
  export function waypointContested(self, bots, waypoint, wpDist, contactDist) {
    for (const other of bots) {
      if (other === self || other.alive === false) continue;
      const dx = other.capsule.start.x - self.capsule.start.x;
      const dz = other.capsule.start.z - self.capsule.start.z;
      if (Math.hypot(dx, dz) >= contactDist) continue;
  ```
- Why slow at high N: both functions visit **every** bot in the passed-in list unconditionally
  (the `radius`/`contactDist` filters are applied per-candidate after the distance is already
  computed — there is no spatial hash/grid bucketing to skip far-away bots up front), even
  though `SEPARATION_RADIUS`/`WAYPOINT_CONTEST_RANGE` are small, local radii. Called from
  `bot-viewer.html:2703` and `2723` inside `followPath`'s `while` loop, i.e. once per moving bot
  per frame (see previous finding for call frequency).
- Cost scaling: O(N) per call × O(N) moving bots per frame = O(N²) `Math.hypot` calls/frame just
  for these two checks combined. At 100 bots (~80 moving) that's ~2 × 80 × 100 = 16,000 hypot
  calls/frame (960,000/sec at 60 fps); at 200 bots it roughly quadruples to ~3.8M/sec.
- Estimated severity at 100 bots: High (compounds directly with the allocation finding above
  since they share the same hot loop and the same `others` array).
- Fix sketch: bucket bots into a coarse XZ grid (cell size ~= max(radius, contactDist)) rebuilt
  once per frame in `updateAllBots`, and have both functions query only the 3×3 neighboring
  cells instead of the full bot list.
- Call-site evidence: `separationXZ` called at `bot-viewer.html:2723`; `waypointContested`
  called at `bot-viewer.html:2703`; both exclusively from inside `followPath`, confirmed called
  once per living moving bot per frame via the 11 `followPath` call sites listed in the previous
  finding.

## Finding: `resolveBotPairs` is an explicit all-pairs O(N²) pass with no spatial hash

- File: `bot-separation.js`, lines 13-33
- Excerpt:
  ```js
  export function resolveBotPairs(bots, radius) {
    const moved = new Set();
    for (let i = 0; i < bots.length; i++) {
      const a = bots[i];
      for (let j = i + 1; j < bots.length; j++) {
        const b = bots[j];
  ```
- Why slow at high N: nested loop over every pair of living, non-ragdolled bots with no
  broad-phase (grid/quadtree) culling — the file's own comment even labels it "One O(n^2) XZ
  pushout pass". Each pair does 2 subtractions + `Math.hypot`, so the constant factor is small,
  but the pair count itself grows quadratically.
- Cost scaling: O(N²) pairs per call. 100 bots → 4,950 pair checks/frame; 200 bots (top of the
  stated 50-200 target) → 19,900 pair checks/frame, a 4x jump for a 2x bot count.
- Estimated severity at 100 bots: Medium (individually cheap — sub-millisecond — but it's called
  unconditionally every frame regardless of how spread out the crowd is, and it's the clearest
  "textbook O(n²), no spatial hash" pattern in the module; at the upper end of the stated 200-bot
  target it becomes a non-trivial single-frame cost, especially stacked with the other O(N²)
  findings above which run in the same frame).
- Fix sketch: same grid-bucketing approach as `separationXZ`/`waypointContested` — only test
  pairs whose capsules could plausibly overlap given `radius`, via neighboring-cell lookup
  instead of the full cross product.
- Call-site evidence: `bot-viewer.html:940`, called exactly once per frame (not per bot) inside
  `updateAllBots` (`bot-viewer.html:920-944`), which is itself the top-level per-frame bot
  update entry point:
  ```js
  const living = botActors.filter((a) => a.entity.alive !== false && !a.ragdoll).map((a) => a.entity);
  for (const entity of resolveBotPairs(living)) {
  ```

## Finding: `createGoalClaims`'s `release()` is an O(claims) linear scan, invoked unconditionally for every living bot every frame

- File: `bot-separation.js`, lines 78-96, specifically the `release` closure at lines 80-82,
  and `claim()` at lines 84-87 which calls `release()` first
- Excerpt:
  ```js
  function release(id, kind = null) {
    for (const [key, c] of cells) if (c.id === id && (kind == null || c.kind === kind)) cells.delete(key);
  }
  return {
    claim(id, kind, cellIdx) {
      release(id, kind);
      cells.set(cellIdx, { id, kind });
    },
  ```
- Why slow at high N: `release` has no secondary index from `id`/`kind` to `cellIdx` — the only
  way to find "this bot's existing claim of this kind" is to walk the entire `cells` Map. This
  by itself is unsurprising for a rarely-called operation, but the call site at
  `bot-viewer.html:3817-3822` invokes `goalClaims.claim(...)` or `goalClaims.release(...)` for
  the `'pack'` kind **unconditionally, every frame, for every living bot**, regardless of bot
  state (it's not gated behind a movement/goal-selection state — it runs inside the always-on
  prelude of `updateBotSentry`):
  ```js
  if (seekable) {
    const packCell = worldToCell(navGrid, seekable.record.x, seekable.record.z);
    goalClaims.claim(bot.id, 'pack', cellIdxOf(packCell.c, packCell.r));
  } else {
    goalClaims.release(bot.id, 'pack');
  }
  ```
  `cells` map size grows with the number of bots holding any active claim (pack/flee/cover/recover),
  so this is effectively an O(N) scan, called N times per frame just for the `'pack'` kind alone
  (plus additional, less frequent claim/release calls for `'flee'`, `'cover'`, `'recover'` kinds
  from other state handlers).
- Cost scaling: O(N) scan × N bots per frame = O(N²), and unlike the movement-related findings
  above this one fires for **every** living bot regardless of whether it's moving, in combat, or
  idle — there's no state gate to reduce the population that pays this cost.
- Estimated severity at 100 bots: High (guaranteed worst-case-shaped cost every single frame;
  easy to overlook because `claim`/`release` read as O(1) bookkeeping calls at each of their
  ~15+ call sites in `bot-viewer.html`).
- Fix sketch: maintain a second `Map<id, Map<kind, cellIdx>>` (or `id+':'+kind` keyed map)
  alongside `cells` so `release(id, kind)` is O(1) instead of O(claims); update both maps in
  `claim`/`clear`.
- Call-site evidence: `goalClaims.claim`/`release` for `'pack'` at `bot-viewer.html:3817-3822`,
  inside `updateBotSentry` (function starts `bot-viewer.html:3752`), which is called once per
  living bot per frame from `updateAllBots` at `bot-viewer.html:934`. Other kinds (`'recover'`
  line 2893, `'flee'` lines 3373/3382/3385, `'cover'` lines 3425/3431, `'pack'` also at 3819/3821)
  add further, less frequent but still per-map-scan, calls on top.

## Finding: `pickCoverCorner` linearly scans every baked corner record with no spatial index, called per bot per frame while probing for cover

- File: `bot-cover.js`, lines 102-122
- Excerpt:
  ```js
  export function pickCoverCorner({ corners, field, navGrid, searchRadius, skip }, botPos, threatPos) {
    ...
    for (const rec of corners) {
      const dist = Math.hypot(rec.anchorPos.x - botPos.x, rec.anchorPos.z - botPos.z);
      if (dist > searchRadius) continue;
      if (skip && skip(rec)) continue;
      if (field.canSee(threatCell, rec.anchorCell) || !field.canSee(threatCell, rec.peekCell)) continue;
  ```
- Why slow at high N: `corners` is the *entire* map-wide baked corner list (`cornerMap.corners`,
  logged at bake time via `bot-viewer.html:2424`); every candidate's distance is computed before
  the `searchRadius` filter discards it, i.e. the radius filter is a late `continue`, not a
  bounding-box/grid prefilter that would skip far-away corners without touching them at all.
  There's no per-cell or quadtree bucketing of corners by location, so cost is O(total corners)
  regardless of how few are actually within `COVER_SEARCH_RADIUS` (10m, `bot-viewer.html:2448`).
- Cost scaling: O(corners) per call, called via `findCoverCorner` (`bot-viewer.html:3408-3414`)
  from inside `updateBotSentry`'s per-bot, per-frame cover block at two points — the re-pick path
  (`bot-viewer.html:3932`, gated by `g.maySwitch`) and the entry-probe path
  (`bot-viewer.html:3944`, evaluated whenever a bot isn't already committed to cover and has an
  in-band threat). During a firefight's opening seconds many bots simultaneously satisfy
  `coverEntryOk` and are not yet committed, so this becomes O(N × corners) for that burst, then
  settles back down once bots lock corners — but re-fires every time a held corner is
  invalidated (LOS break, threat move) since `stepCoverGate`'s `maySwitch` re-triggers the same
  O(corners) probe.
- Estimated severity at 100 bots: Medium (bounded by `coverSwitchAllowed`'s 0.8s cooldown and the
  entry/re-pick gating, so it's not a guaranteed every-frame-every-bot cost like the goal-claims
  finding, but on maps with large corner counts and many simultaneously-uncommitted bots — e.g.
  a fresh combat wave — this is an O(N × corners) spike with no caching between calls).
- Fix sketch: bucket `corners` into the same coarse grid used for the nav grid (or reuse
  `navGrid` cell indices) so the search only walks corners in cells within `searchRadius`,
  instead of the full array.
- Call-site evidence: `findCoverCorner` wraps `pickCoverCorner` at `bot-viewer.html:3408-3414`;
  invoked at `bot-viewer.html:3932` (re-pick, inside the `coverCommitted` branch of
  `updateBotSentry`) and `bot-viewer.html:3944` (`coverProbe`, entry path) — both inside
  `updateBotSentry`, called once per living bot per frame (`bot-viewer.html:934`).

## Finding: `peekPosition` / `approachXZ` allocate a fresh `{x,z}` object on every call, made once per bot per frame while holding cover

- File: `bot-cover.js`, lines 41-44 (`peekPosition`) and 51-56 (`approachXZ`)
- Excerpt:
  ```js
  export function peekPosition(peek, anchorPos, peekPos) {
    const e = peek.exposure;
    return { x: anchorPos.x + (peekPos.x - anchorPos.x) * e, z: anchorPos.z + (peekPos.z - anchorPos.z) * e };
  }
  ...
  export function approachXZ(current, target, maxStep) {
    const dx = target.x - current.x, dz = target.z - current.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= maxStep || dist < 1e-9) return { x: target.x, z: target.z };
    return { x: current.x + (dx / dist) * maxStep, z: current.z + (dz / dist) * maxStep };
  }
  ```
- Why slow at high N: both are pure functions that allocate and return a new plain object every
  invocation instead of writing into a caller-supplied/reusable buffer. Individually trivial, but
  they're called together, twice each (`peekPosition` is called both standalone and nested inside
  the `approachXZ` call), every frame for every bot sitting in `BOT_COVER_HOLD`.
- Cost scaling: O(N) small-object allocations per frame (linear, not quadratic) — scales with the
  number of bots simultaneously holding cover, which grows with total bot count in any
  cover-heavy fight composition.
- Estimated severity at 100 bots: Low (linear GC churn, small objects; unlikely to be the
  dominant cost next to the O(N²) findings above, but it's avoidable and adds up alongside them
  in the same frame budget).
- Fix sketch: accept an optional `out` object parameter (`peekPosition(peek, anchorPos, peekPos, out = {})`)
  and write into it, mirroring the mutate-in-place style already used by `stepPeekCycle`/`resolveBotPairs`
  in the same file/module family.
- Call-site evidence: `bot-viewer.html:4056`, inside the `BOT_COVER_HOLD` branch of the big
  per-bot state dispatch (`bot-viewer.html:4047-4056`), itself reached once per living bot per
  frame while that bot's `botState === BOT_COVER_HOLD`:
  ```js
  if (rec) placeBotXZ(bot, approachXZ(botXZ(bot), peekPosition(peek, rec.anchorPos, rec.peekPos), PEEK_APPROACH_SPEED * dt));
  ```
