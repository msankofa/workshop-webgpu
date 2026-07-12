# All-Weapons Implementation — Orchestration Plan

**Date:** 2026-07-11
**Goal:** Make every GLB in `models/guns/` a fully playable weapon. Today only `m1911`
and `m24` (both `hitscan`) work end-to-end. This plan brings the remaining five to
parity: two unregistered hitscan guns, one melee, two explosives.

## Scope — the five weapons

| Weapon | GLB | Class | Fire mode | Status today |
|---|---|---|---|---|
| `five_seven` | `low_poly_five_seven.glb` | Pistol | hitscan, semi | **not in registry** |
| `cz_805_bren` | `low-poly_cz_805_bren.glb` | Assault rifle | hitscan, **full-auto** | **not in registry** |
| `knife` | `low_poly_combat_knife.glb` | Melee | melee swing | in registry, `disabled` |
| `grenade` | `low-poly_mk2_grenade.glb` | Thrown | projectile + explosion | in registry, `disabled` |
| `rpg` | `low-poly_rpg-7.glb` | Launcher | projectile + explosion | in registry, `disabled` |

## Why it's not a flag flip

- `applyCombatIntent` (`environment-viewer.html:5839`) hard-rejects `mode !== 'hitscan'`.
- No player melee path exists anywhere in the codebase.
- The only projectile (`entity-types/projectile.js`, the light gun) collides with terrain
  height only — no target raycast, no damage, no explosion.
- Effects support `gun_tracer`/`hit_spark` only.
- No full-auto (hold-to-fire) input.

## Architecture decisions (defaults — confirm before build)

1. **CZ 805 Bren is full-auto**: holding primary fire repeats at `fireIntervalMs` cadence,
   gated by the existing `validateShot` cooldown. Add `automatic: true` to its def.
2. **Grenade is thrown** with a cook-and-arc projectile; detonates on a fuse timer OR
   first solid contact, whichever comes first. Reuses fire input (no separate throw key).
3. **RPG is a straight-flight rocket** (minimal gravity), detonates on first solid contact
   (target/obstacle/terrain).
4. **Explosions do radial damage with linear falloff** to players + creatures + mobs inside
   `blastRadius`. **Friendly fire ON, self-damage ON** (simplest + host-authoritative;
   revisit later if it feels bad).
5. **Melee is a short forward capsule/ray sweep** on swing, single target, using the
   existing hitscan capsule math at `range` ≈ 2m; no lunge movement.
6. **First-person functional parity is the bar for "done".** Third-person body holds + IK
   anchors are authored assets (need a browser) and are a *separate, non-blocking* phase —
   weapons fire and damage correctly without them (they'd just be invisible in 3rd person).

## Reference: explosion system in `G:\My Drive\Scripts\html game\html-game-v2`

Port the *math*, not the code (that game is THREE-coupled, has lock-on/salvo/merge we don't
want). Key functions in `src/game/main.js`:

- **Radial falloff damage** (`damageEnemiesInRadius`, ~15628): for each target, closest point
  on its collider to blast center; if `dist <= radius`, `falloff = 1 - dist/radius`,
  `dmg = max(FLOOR, round(baseDamage * (0.45 + falloff*0.55)))`. Edge = 45%, center = 100%.
- **Projectile step** (`updatePlayerProjectiles`, ~21988): decrement life; apply gravity
  (grenade only); advance by `velocity*dt`; enemy-collider hit (`dist <= radius`) → detonate;
  grenade ground-bounce up to 2× (dampen vel ×0.38 vertical, ×0.72 horizontal) then detonate;
  terrain (`y <= groundY+0.12`) / wall hit → detonate; `life<=0` → grenade airbursts, rocket
  fizzles (no blast).
- **Impact** (`explodePlayerProjectile`, ~21931): sound + blast-impact FX + `damageEnemiesInRadius`.
- **Tuning** (`fireGrenade`/`fireRocket`, ~15125): grenade = speed 35, dmg 95, blast 15,
  life 2.15s, radius 0.45, gravity 24, upward arc `(0, 4.8+, 0)`; rocket = speed 108, dmg 110,
  blast 8.2, life 19.2s, radius 0.42, no gravity, straight.

Our port keeps this falloff curve and step logic but expresses collision via the injected
`ctx.raycast`/`ctx.applyBlast` (reusing `resolveWorldShot`/capsule math) so it stays THREE-free
and Node-testable.

### Exact contracts for the new pure entities

**`entity-types/explosion.js`** — `ExplosionEntity`:
- `create({ p:[x,y,z], radius, damage, ownerId, color?, life? }, ctx)` — on create, calls
  `ctx.applyBlast?.({ center:p, radius, damage, ownerId })` ONCE (host-authoritative damage at
  spawn), stores color/life for rendering. `applyBlast` owns the falloff curve + friendly-fire
  (ON per decision 1/4) + self-damage. Default `life` ~0.5s.
- `update(entity, dt)` — ages; `{destroy:true}` at `life`.
- `serialize` — `{ id, type:'explosion', p, radius, color, life }` for `effect-renderer`/light.

**`entity-types/combat-projectile.js`** — `CombatProjectileEntity`:
- `create({ origin, dir, speed, damage, blastRadius, life, radius, gravity, arc, color, fuse?, ownerId })`.
- `update(entity, dt, ctx)` — gravity → integrate → step-collision via `ctx.raycast?.(from,to,radius,ownerId)`
  (returns `{point,kind}|null`) AND `ctx.terrainHeight`; grenade-style bounce if `entity.sim.bounces`
  enabled; on detonation `ctx.spawn('explosion', { p, radius:blastRadius, damage, ownerId, color })`
  then `{destroy:true}`; `fuse`/`life` expiry detonates (grenade) or fizzles (rocket, `fizzleOnExpire`).
- `serialize` — `{ id, type:'projectile'|'combat-projectile', p, color, radius, intensity, renders:true }`
  so it renders as a moving light like the light-gun projectile.

## Shared foundation (blocking — build first, mostly new pure modules)

These are dependencies for the per-weapon work. New `.js` files are Node-testable and can be
built/tested in parallel; the `environment-viewer.html` edits must be **serialized** (one
6000-line file, high contention).

- **F1 — Fire-path mode dispatch** (`environment-viewer.html`, `applyCombatIntent`).
  Replace the `mode !== 'hitscan'` reject with a switch: `hitscan` → existing path;
  `melee` → melee branch (F5); `projectile` → spawn a combat-projectile entity (F3).
  Keep ammo/cooldown/`validateShot`/replication identical across modes.
- **F2 — Explosion entity** (`entity-types/explosion.js`, NEW). A short-lived entity that,
  on creation, applies radial falloff damage via injected ctx queries
  (`ctx.damagePlayers/damageCreatures/damageMobs` or a single `ctx.applyBlast`), then lives
  ~`life` seconds as a render marker for the explosion effect. Pure, no THREE.
- **F3 — Combat projectile entity** (`entity-types/combat-projectile.js`, NEW). Like
  `projectile.js` but `update()` sweeps its segment each step against players/creatures/
  mobs/obstacles (via injected `ctx.raycast`) AND terrain; on hit or fuse-expiry spawns an
  `explosion` (F2) at the impact point. Carries `{ arc, gravity, fuse, blastRadius, damage }`.
  Pure, no THREE.
- **F4 — Effect kinds** (`entity-types/effect.js` + `effect-renderer.js`). Add
  `explosion` (expanding flash/sphere) and `smoke_trail` (rocket trail) kinds with sane
  default lifetimes; renderer draws them.
- **F5 — Melee branch** (`environment-viewer.html`). In the dispatch, a melee "fire" does a
  single short forward `resolveWorldShot`-style capsule query at `weapon.range`, applies
  `weapon.damage` to the first target, spawns a hit_spark. No projectile, no tracer.
- **F6 — ctx wiring** (`environment-viewer.html`). The host tick already builds a ctx for
  `entityRegistry.tick`; extend it with `raycast`/`applyBlast` closures that reuse
  `resolveWorldShot`, `creatureCombatCapsules`, `claudecraftCreatures`, and `playerCombat`.
- **F7 — Audio events** (`sound-events.js`, `weaponFireEvent`). Add `rifle_shoot`,
  `rocket_launch`, `explosion`, `knife_swing`, `grenade_throw`; extend `weaponFireEvent`
  mapping beyond the current `m24 → sniper_shoot, else pistol_shoot`.

## Per-weapon workstreams (after foundation)

- **W1 — five_seven** (`weapons.js`, `weapon-anchors.json`, `weapon-poses.json`). New
  registry entry, hitscan pistol stats close to m1911. Cheapest — no new mechanics.
- **W2 — cz_805_bren** (`weapons.js` + full-auto input in `environment-viewer.html`). New
  registry entry (`automatic: true`), and hold-to-fire input handling in the primary-fire
  loop (repeat while held, cadence-gated).
- **W3 — knife** (`weapons.js` un-disable + F5 melee branch + swing anim/SFX).
- **W4 — grenade** (`weapons.js` un-disable + tune arc/fuse/blast; uses F3/F2/F4).
- **W5 — rpg** (`weapons.js` un-disable + tune rocket/blast + smoke trail; uses F3/F2/F4).

## Authoring phase (browser, non-blocking, sequential)

- **A1 — IK anchors** for five_seven, cz_805_bren, knife, grenade, rpg via
  `weapon-anchor-editor.html` → `weapon-anchors.json`.
- **A2 — Third-person holds** (`thirdPersonHold`/`crouchHold`/`proneHold`) via
  `body-preview.html` → `weapons.js`.
- **A3 — Reload/idle poses + sequences** via `weapon-anchor-editor.html`/`body-preview.html`
  → `weapon-poses.json` (rifle reload for the Bren; the rest can share pistol poses initially).
  Seed all three with reasonable first-pass numeric values in the code phase; visual tuning
  here.

## Verification & housekeeping (every workstream)

- Node tests: extend `test-weapons.mjs` (all weapons have valid stats), new
  `test-explosion.mjs` / `test-combat-projectile.mjs` (falloff, collision, fuse). Keep
  `test-combat.mjs` green.
- Browser smoke test via `python serve.py` → each weapon selectable, fires, damages a
  target, explosions deal falloff damage, full-auto repeats, knife hits at range.
- Per CLAUDE.md: snapshot `environment-viewer.html` into `versions/` before editing; update
  affected `docs/subsystems/*.md` (multiplayer, audio, infra, entry-point, creature as
  touched); append one `agent_log.csv` row per logical change.

## Sequencing / contention notes

- `environment-viewer.html` is the contended file (F1, F5, F6, W2 full-auto, projectile
  wiring). **Serialize all edits to it** — do not parallelize agents on it.
- New pure modules (F2, F3, F4-effect, tests) are independent files → safe to build in
  parallel and unit-test headless.
- Authoring (A1–A3) needs a running server + browser → cannot be done headless; do last.

## Status

- [ ] Foundation F1–F7
- [ ] W1 five_seven
- [ ] W2 cz_805_bren (+ full-auto)
- [ ] W3 knife (+ melee)
- [ ] W4 grenade
- [ ] W5 rpg
- [ ] Authoring A1–A3
- [ ] Tests + docs + agent_log + browser verify
