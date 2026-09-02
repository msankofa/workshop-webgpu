# Stadium walker baseline — 2026-08-30

This is the Phase 0 baseline for `docs/stadium-walker-validation-plan.md`. It records the walker before
paper-informed telemetry or Lab-map integration changes. The two Phase 0 tests added to
`test-stadium-rig.mjs` are observational only; no production movement file changed.

## Reproduction identity

- Git HEAD: `e4cd176e381e29e80661709ba720d4394bd4c104`
- Node: `v22.20.0`
- Terrain: flat height function
- Gait: default walk
- Warmup: 2 seconds
- Measurement: 20 seconds at 60 Hz
- Seed: `7`, as set by `sweep-gait.mjs`

Production-file SHA-256:

| File | SHA-256 |
|---|---|
| `stadium-walker.js` | `815A655A3B2FDEBDCEE4248C89C1716BF15EF4EB5C04DEE8ED417839907D6FED` |
| `creature-locomotion.js` | `22C1C67BD8FD50ECBDBF37D121EB96DBDDF96534913EFF31CBD1CA0BF2112371` |
| `gait-diagnostics.js` | `FA794D14B732ED4FE4A75F580A2045E9371DB1A2841A6BC22E7BCC60E613B23E` |

## Commands

```powershell
node test-gait-diagnostics.mjs
node test-stadium-rig.mjs

$env:ONLY='019_rattata,058_growlithe,077_ponyta,128_tauros,033_nidorino,079_slowpoke,002_ivysaur,028_sandslash,086_seel,025_pikachu,006_charizard,066_machop,027_sandshrew,046_paras'
$env:MEASURE='20'
node sweep-gait.mjs
```

## Test status

`test-gait-diagnostics.mjs` passes all checks.

The two new Phase 0 checks pass:

- `reading a diagnostic frame does not mutate the walker`
- `sampling diagnostics cannot change a deterministic walk`

`test-stadium-rig.mjs` has one pre-existing data-dependent failure:

```text
FAIL every species with an authored stance still stands up in it
     048_venonat: its stance leaves it with no legs
```

Venonat's saved stance in `stadium-saves/stadium-stances.json` has pose data but `roles: null`. The legacy
mapper finds no legs after that pose is applied. This baseline does not delete the stance, invent leg
roles, weaken the assertion, or treat it as a walker regression. All other Stadium checks pass.

## Reference sweep summary

```text
DEFAULTS  tap 0/14  drag 0/14  down 1
height median 96%  stance-skate median 0.0%  clamp median 0.1%
worst stray 0.74%  tap/s median 0.00  steps/s median 1.76
stride median 32% of leg span  blocked median 91%  speed efficiency median 82%
```

The one `down` result is Seel at 70% of its mapped ride height. It is part of the baseline and must not be
silently hidden by later diagnostic work.

## Per-species baseline

Percentages are reported by the existing sweep. `Height` is achieved body height divided by mapped ride
height. `Stance skate` is planted-foot travel divided by body travel over a stance. `Clamp` is the
fraction of planted frames whose requested reach exceeded the solver limit. `Blocked` is the fraction of
wanted steps refused by scheduling. `Speed` is achieved divided by commanded speed.

| Species | Legs | Height | Stride / span | Stance skate | Clamp | Blocked | Speed |
|---|---:|---:|---:|---:|---:|---:|---:|
| Rattata | 4 | 96% | 29% | 0.0% | 0.1% | 89.5% | 82.6% |
| Growlithe | 4 | 96% | 18% | 0.0% | 0.0% | 96.4% | 55.9% |
| Ponyta | 4 | 94% | 56% | 0.0% | 1.1% | 90.9% | 84.0% |
| Tauros | 4 | 94% | 32% | 0.0% | 0.0% | 89.7% | 85.9% |
| Ivysaur | 4 | 91% | 23% | 0.0% | 0.5% | 89.8% | 90.6% |
| Sandslash | 4 | 104% | 67% | 0.0% | 0.0% | 90.6% | 74.6% |
| Nidorino | 4 | 96% | 29% | 0.0% | 0.5% | 89.7% | 80.6% |
| Slowpoke | 4 | 94% | 26% | 0.0% | 0.3% | 89.4% | 79.1% |
| Seel | 4 | 70% | 22% | 0.0% | 0.4% | 90.7% | 94.2% |
| Pikachu | 2 | 100% | 38% | 1.5% | 0.0% | 93.5% | 81.7% |
| Charizard | 2 | 104% | 53% | 4.2% | 0.0% | 93.4% | 81.9% |
| Machop | 2 | 96% | 38% | 2.4% | 0.0% | 93.8% | 81.6% |
| Sandshrew | 2 | 101% | 22% | 4.2% | 0.3% | 93.6% | 81.3% |
| Paras | 6 | 103% | 33% | 0.1% | 0.0% | 85.1% | 84.6% |

## Baseline interpretation

- The current verdicts find no tapping or dragging across the fourteen reference species.
- The raw measurements are not all zero. Bipeds show more stance skate than quadrupeds, which future
  diagnostics must preserve and explain rather than erase.
- Scheduler blockage is high across the set by design; a later named-failure counter must not relabel
  every refused turn as an error. It must distinguish ordinary turn-taking from pathological starvation.
- Growlithe has the lowest speed efficiency at 55.9% without a drag verdict.
- Seel's 70% height is the only current `down` case and is the clearest baseline candidate for later
  support-margin analysis.
- Ponyta has the highest clamp rate at 1.1% without crossing the existing drag threshold.

This document is a comparison fixture, not a claim that the defaults are correct. A later phase may
improve these values, but Phase 1 telemetry alone must reproduce the same motion and verdicts.

## Phase 1 comparison — 2026-08-31

After adding named failure telemetry to `stadium-walker.js` and `gait-diagnostics.js`, the exact Phase 0
command above reproduced every printed per-species and summary value in this document. The new
non-interference tests still pass. Default reference scheduling produced no starvation event; ordinary
support/phase waiting remains separate from starvation. The Venonat authored-stance failure is unchanged.

## Phase 2 retarget measurements — 2026-08-31

The dedicated `retarget` sweep ran the same 14 species for 20 seconds each after warm-up. All legs kept a
positive bend sign of 1.0 and exact segment lengths. P95 knee changes ranged from 9.55 to 27.02 degrees;
the largest single-frame change was 41.29 degrees. P95 planted-foot ground error was zero for every
species, with rare maxima up to 9.95 mm. No reference leg needed a fallback pole.

Joint continuity was exactly zero on 13 species. Sandslash reported 53.6579% because the guessed map
creates two legs per side from two toe branches while reusing the same upper three bones. That is an
existing semantic mapping failure now made visible by the telemetry, and a concrete case the Lab-authored
ground-movement adapter must represent as one limb with multiple foot bones.

## Phase 3 comparison — 2026-08-31

After adding dropped-time, signed-support-margin, and body-clearance telemetry, the exact Phase 0 command
again reproduced every printed per-species and summary value. Normal 60 Hz input reported no discarded
simulation time. The telemetry tests separately force a cap overrun, polygon-edge crossing, degenerate
support, and body-floor crossing so each path is known to produce a non-zero reading.

## Phase 4 comparison — 2026-08-31

Extracting shared leg measurement, adding a separate linear joint path, and allowing additional foot
branches did not change the old guessed maps. The exact Phase 0 command again reproduced every printed
value. The new path is separately proven by starting the controller from a Lab-authored map and by
representing Sandslash as two non-overlapping legs with two foot bones each.
