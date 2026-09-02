# Base Game NPC bots audit remediation

**Date:** 2026-08-29  
**Source audit:** `docs/superpowers/reviews/2026-08-28-base-game-npc-bots-audit.md`

## Goal

Correct the audit record without erasing its original claims, fix the implementation defects found
during review, and add regression coverage that keeps the machine-readable record and runtime code
in agreement.

## Work

1. **Repair the record.** Recompute the frontmatter rollups, strike through disproved or overstated
   prose in place, append the corrected statements, and add findings for issues the original pass
   missed. Extend the parser test so every review document, including the NPC audit, has its declared
   finding and rollup counts checked.
2. **Make `holeAt` caching exact.** Retain the repeated-query speedup without sharing an answer
   between different coordinates. Add a cave-boundary test that queries two points in the same old
   half-metre bucket in both orders. Re-run the NPC v5 benchmark after correctness tests pass.
3. **Repair NPC aim settings.** Make partial brain configuration merge with the existing aim settings,
   map `npcAccuracy` onto the spread and bloom controls around the current `0.5` baseline, and test
   notice delay plus the accuracy endpoints through the room wiring.
4. **Repair profiling.** Log the existing `heights` counter instead of the nonexistent `heightAt`
   property and test the formatter so `undefined` cannot silently return.
5. **Remove remaining remote-feed churn.** Reuse the audio/body feed records and compute remote gadget
   phases once per remote per frame. Verify consumers do not retain the scratch records.
6. **Reconcile status.** Keep the UAV symptom unverified until an online manual-flight retest. Record
   the existing terrain-handoff failure separately; do not let a later passing command hide its
   nonzero assertion count.

## Verification

- `node test-terrain-volume.mjs`
- `node test-world-query-heightfield.mjs`
- `node test-bot-aim.mjs`
- `node test-bot-brain.mjs`
- `node server/test-base-game-npcs-room.mjs`
- `node server/test-base-game-rooms.mjs`
- `node test-base-game-replication.mjs`
- `node test-audit-doc.mjs`
- `node bench-base-game-npcs.mjs --v5 --fight`
- Online UAV manual-flight retest with the `[base-game prof]` line captured (manual, still pending)

