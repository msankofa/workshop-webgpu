# Damage FX — four plans, 2026-08-07

Four ideas, one plan each, written in parallel by separate agents against the same architectural
brief so they are comparable. Read this first: it records what they found in common, what I verified
myself, and the order that falls out of it.

**Target file (2026-08-08):** these plans were written against `bot-viewer-v2.html`, but v2 is now a
frozen snapshot. Implement all of them in `bot-viewer-v3.html`, which was forked from it verbatim.
The filename is not the only thing that changed — v3 has since grown, so **grep the symbol, never
trust a line number below.**

**Superseded by:** [`../2026-08-08-v3-damage-fx-implementation.md`](../2026-08-08-v3-damage-fx-implementation.md),
which sequences the remaining work (idea 2, idea 4, and the two unplanned blood problems) against
current v3 line numbers. Idea 1 and idea 3's early phases have shipped; these four documents stay as
the research behind that plan.

| Plan | Idea |
|---|---|
| [`idea-1-wound-centred-blood.md`](idea-1-wound-centred-blood.md) | Bullet wounds at the centre of blood stains, darker at the centre; blood drips or sprays by health |
| [`idea-2-limb-loss.md`](idea-2-limb-loss.md) | Limb and head loss from bullets and grenades, leaving bots wounded or worse |
| [`idea-3-class-damage-language.md`](idea-3-class-damage-language.md) | Damage effects separated by class: humans bleed, armoured humans bleed only at low health, robots spark and go haywire |
| [`idea-4-pools-and-fire.md`](idea-4-pools-and-fire.md) | Blood pools for humans, fire for robots, potentially both for armoured |

## The blocker all four run into

**Body kind is one global variable.** `BOT_BODY_KINDS = ['armoured', 'soldier']` and `_bodyKind` is a
single module-level value in `bot-body-design.js`; `setBotBodyKind` swaps *every* bot on the field, as
the UI tooltip says outright. Ideas 3 and 4 found this independently and I verified it.

Mixed human / armoured / robot fights are therefore impossible today, and **every one of the four
ideas needs a per-bot class field before it can route anything**. Idea 3 Phase 0 (a
`bot-roles.js`-style `bot-damage-class.js` descriptor) is the unblocking change. The rename of
`'armoured'` → armoured human is the smaller half of that job; the per-bot plumbing is the real cost.

## What I verified myself

These are checked against the code, not taken from an agent:

- `BOT_BODY_KINDS` has exactly two entries and `_bodyKind` is global. ✔
- **Per-part hit resolution is wired for FX, not for damage.** `bot-viewer-v2.html` imports
  `resolveBodyHit`, `botWoundHitMode = 'mesh'` is the **default**, and `refineWoundHit` re-traces
  every hit against the rig. `refineWoundHit` has exactly one call site, inside `spawnHitBloodFx`.
  Damage still resolves against one capsule and is still flat. ✔
  (This landed at `2026-08-07T12:05` and invalidated part of the brief the agents were given —
  idea 1's agent caught it independently.)
- `spawnHitBloodFx` runs **before** `target.health` is decremented, in both `applyBotDamage` and
  `detonateBlast`. Idea 1's health-driven drip-vs-spray depends on this; its fix (pass `amount` in)
  is the right one. Note `hpBefore01` is already computed a line later. ✔
- Budgets: `maxBloodDecals = 512` in `effect-renderer.js` caps `blood_stain` + `blood_splatter`
  **combined** as one instanced draw; a separate projected-decal pool is capped at 256;
  `botCorpseCap = 24`. ✔

## Convergences worth trusting

- **Two agents independently refused to touch the state-code encoder.** Idea 2 wants "wounded" as a
  `bot-stance.js`-style derived channel; idea 3 found the latch slot at 5/5 bits and designed spasms
  and haywire as render-time and death-flourish effects. Converging on that from different
  directions, in a system whose own history records rules being wrong on first authoring, is a
  strong signal.
- **Material-level damage is blocked, same cause both times.** Rig materials are shared
  `InstancedMesh`es per role bucket with a per-instance colour and no per-instance damage/heat
  uniform, so `materials/damage-overheat.js` cannot reach a bot shell. Ideas 3 and 4 both scoped
  glowing cracks and scorch out. Consistent with the known bot-material migration blocker.
- **The class gap runs in both directions.** Idea 3 found `bot-damage-audio.js` gives *every* bot
  synthesized struck-metal audio, including the human `soldier` body; the flesh-sample path exists
  but only the practice dummy reaches it. So visuals are all-blood and audio is all-metal, which
  makes idea 3's early phases cheaper than they look.

## Suggested order

1. **Idea 3 Phase 0** — the per-bot damage-class descriptor. Ideas 2 and 4 both name it as their
   dependency.
2. **Idea 1** — cheapest by a distance, needs no new hit wiring, two independently shippable phases.
3. **Idea 4 phases 1–5** behind a global-toggle fallback; phase 6 gated on idea 3.
4. **Idea 2** last, with head loss gated on Phase 3 of
   [`../2026-08-06-height-aware-los-plan.md`](../2026-08-06-height-aware-los-plan.md) — the head is
   not currently inside the hit volume, so headshots are not a detectable event yet (BB-008).

## Open decision before any of this ships

All four contend for the same 512-decal budget, and a separate 256 projected pool. Idea 4's
persistent pools are the only ones that can actually exhaust it; idea 1 raises per-hit spawn at the
lethal end. **Those two want a shared budget decision made once, up front**, rather than each
discovering the ceiling separately.

## Caveats

The plans are not cross-verified against each other — each agent read the code independently, and one
corrected the brief. Treat idea 2's citations as the least reliable: it ran earliest, against the
oldest copy of a file that moved roughly 140 lines during the session. **Grep the symbol, not the
line number** — `combatCapsuleFor` went 2328 → 2358 → 2497 in a few hours.
