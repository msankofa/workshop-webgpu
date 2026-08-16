# Handoff — Stadium model procedural locomotion demo

Written 2026-08-13, end of a session that took the DramaticShapeVoxelMod repo from
"understand this" through feasibility analysis to a working extraction + viewer
toolchain. This document is the spec for the NEXT task and the context a fresh
session needs to execute it without rediscovering anything.

## The next task, in one sentence

Auto-map the unnamed skeleton of a quadruped Stadium model (target: #019 Rattata),
retarget the user's existing gait/IK module onto it, and have it trot across a
ground plane in the three.js viewer — proving that ROM models can play locomotion
cycles that were never in the ROM.

## Why this matters

It is the load-bearing claim under two mods the user wants to build for
DramaticShapeVoxelMod (follower Pokémon, ambient wild mobs): Stadium models have
NO walk/run animations — only battle moves — so followers/mobs need procedural
locomotion. See feasibility-report.md for the full mod context.

## What already exists (in this zip)

- `reference/sdfbugv2.html` — the user's own demo: a six-legged SDF bug walking
  an alternating tripod gait. THE LOCOMOTION CODE COMES FROM HERE. Key facts
  read from its source:
  - The gait lives in a separate module (`bug-rig.js`, importing
    `../creature-locomotion.js` — user has these; not in this zip). The page
    "reads eighteen joint positions and a rotation" — that interface is the
    retarget seam.
  - Two leg solvers, switchable: unbounded FABRIK (measured 59.5% knee
    inversion during walk) vs analytic two-bone + pole + limits (0.0%). Use the
    two-bone path; it also naturally yields joint ROTATIONS, which skinned
    meshes need (the SDF consumed positions).
  - Joint limits: fore/aft swing clamp (radians) and "straightest the knee may
    get" (% of chain span). Pole vector prevents knee inversion.
  - Feet plant on a curved dome and a Node CPU-twin test asserts contact at
    every phase — the pattern to copy for verification.
- `gen_viewer.py` — generates a hardened single-file viewer for any species.
- `tooling/template2.html` + `tooling/GLTFLoader.patched.js` — the viewer
  runtime. The walker demo should extend template2.
- `pokedex-151.html`, `stadium-extras.html`, per-species viewers — working
  references for the whole delivery pattern.

## What must be regenerated (not in this zip — too large)

The extracted models. Recipe:
1. Clone https://github.com/scottcandy34/DramaticShapeVoxelMod-latest
   (the original DramaticShape repo is dead — 401 on git; this mirror is
   "a faithful copy of the last update", v1.8.2).
2. Obtain the user's Pokémon Stadium (US) 1.0 ROM
   (md5 must be ed1378bc12115f71209a77844965ba50).
3. `python3 model_extract/pipeline/build.py --rom=<rom> --out=<dir> --no-js`
   → ~105 s → 151 Pokémon glbs + 64 extras + manifest.json + moves.json.
   Rattata is glb/019_rattata.glb.

## Hard-won facts about these glTF files — DO NOT REDISCOVER

1. **Vertices are authored 10x in bone-local space**; a `model_root` node
   scales down. Consequences: geometry bounding boxes/spheres are garbage →
   (a) frame cameras from skeleton joint world positions, (b) set
   `frustumCulled = false` on every mesh or parts vanish with camera angle.
2. **Some face-decal triangles are wound backwards** for glTF conventions. The
   game renders with culling OFF (`Voxel3D.lua: setMeshCullMode("none")`).
   Set `material.side = THREE.DoubleSide` everywhere.
3. **Two-node scale rig**: every game bone = `boneNN` pivot (rotation +
   translation, scale 1) + `boneNN_scale` leaf child (holds accumulated scale,
   no children, skin binds to it). IK/animation must drive the PIVOT nodes and
   never touch `_scale` leaves. Upside: the pivot chain is scale-free, which is
   exactly what IK solvers want. All inverse bind matrices are identity.
4. **Bones are semantically unnamed** (`bone00`…). Nothing says "left leg".
5. Animations are 30 fps; every ROM animation wraps (one-shots are ended by
   the game's state machine, not the player). glTF importers loop by default.
6. Eyes/blinks are texture-swap animations glTF can't carry — the glb has the
   open-eye frame only.

## Viewer/sandbox delivery constraints (learned by failure)

- The Claude app's HTML preview sandbox blocks ALL network fetch AND
  `fetch()` of blob: URLs. GLTFLoader r128 on non-Firefox uses
  ImageBitmapLoader which fetches blob: URLs → "Failed to fetch".
  `tooling/GLTFLoader.patched.js` fixes this (forces image-element path,
  data: URIs instead of blob). Use it, never stock GLTFLoader.
- Everything must be ONE self-contained HTML file (inline three.js r128 —
  0.128.0 is the last npm version shipping examples/js loaders as plain
  scripts).
- File delivery cap is 30 MiB. For big payloads: LZMA (Python
  `lzma.compress(format=FORMAT_ALONE, filters=[{'id': FILTER_LZMA1,
  'preset': 9|PRESET_EXTREME}])`) + npm `lzma` package's pure-JS
  `lzma_worker.js` decoder inline (~110 KB, no WASM/eval — sandbox-safe;
  decode verified byte-identical). ~70% smaller than raw, ~22% smaller than
  zlib-9 on this data. Model data is ~69% animation samplers + ~20% JSON —
  Draco (geometry-only) is useless here.
- Add the on-screen error overlay + status line from template2.html to
  everything; silent failures on the user's device are undebuggable.

## Suggested plan for the walker demo

1. **Auto-map** (Python, over 019_rattata.glb): parse skeleton from the glb
   JSON; bones = nodes reachable from model_root, pivots only. Extract chains
   (branch-point → leaf paths). Classify using: rest/idle-pose ground contact
   of bound vertices (rigid one-bone binding = each bone owns a definite mesh
   patch), bilateral symmetry across X (mirrored pairs = limbs; left/right),
   front/back extent (head vs tail), eye-texture material binding (= head).
   Output: JSON of {legs: [{hip, knee, foot, lengths}], spine, head, tail}.
   Body-plan zoo warning: heuristics should cover most; keep a manual override
   file for oddballs (Voltorb, Exeggcute, Diglett, serpents, floaters).
2. **Retarget layer** (JS, in the viewer): per frame, gait module emits foot
   targets + body pose → analytic two-bone solve per leg (with the demo's
   swing/reach limits and rest-pose-derived pole vectors: joints already bend
   slightly the correct way — use that bend direction) → convert solved
   positions to local rotations on the pivot bones relative to rest pose.
   Smooth targets (exponential) per the user's "bone rules + movement
   smoothing" approach.
3. **Layer** the ROM idle clip on spine/head/tail while legs are procedural.
4. **Verify** like everything else in this project: headless Playwright
   screenshots (Chromium at /opt/pw-browsers/chromium, flags
   --use-gl=swiftshader --enable-unsafe-swiftshader), plus a foot-contact
   assertion pass (all feet reach ground within tolerance across a full gait
   cycle) — the CPU-twin discipline from sdfbugv2 and from the mod repo's own
   stadium_extract_test oracle pattern.
5. Deliver as one self-contained HTML through SendUserFile with
   display:render.

Note: `creature-locomotion.js` / `bug-rig.js` are NOT in this zip — ask the
user for them, or reimplement the gait scheduler from the extensive comments
in sdfbugv2.html if they're unavailable.

## Open threads beyond the walker (from the feasibility report)

- Trainer models: SETTLED — not in the ROM's model archive (the 64 extras are
  minigame props/trophies/Mewtwo-flying/Substitute-doll?; Stadium never drew
  trainers in 3D). The mod idea needs external model sources.
- Substitute doll (extras file 151) looks like the real doll model — the mod
  currently falls back to a sprite for Substitute; low-hanging mod contribution.
- Corrupt standby loops: Exeggutor (#103), Tangela (#114), Magmar (#126) —
  bespoke replacement animations are another use of the same retarget stack.
- The user's chosen mod shortlist and per-idea difficulty: feasibility-report.md.
