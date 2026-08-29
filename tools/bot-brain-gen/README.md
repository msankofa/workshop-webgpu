# bot-brain-gen

Generates `bot-brain.js` from `bot-viewer-v3.html`. Run from the repo root, in order:

```
python tools/bot-brain-gen/1-inventory.py <work>/inv.json <seeds>
python tools/bot-brain-gen/2-closure.py <work>/inv.json <seeds> > <work>/closure3.txt
python tools/bot-brain-gen/3-generate.py <work> setSquadLeaderMark,refreshGrenadeThreats
node --check bot-brain.js && node test-bot-brain.mjs
```

`<seeds>` is the comma list in `seeds.txt`. Step 1 indexes every top-level function in the
harness; step 2 walks the call graph from the seeds and stops at effect systems (its `stop`
regex: voice, FX, mounts, wounds, drones, debug, damage application, ammo is kept); step 3
writes the module: imports, the Vec3 shim, every module-scope declaration the bodies touch
(host-owned ones nulled for `configure()`), hook stubs for the cut functions, the verbatim
bodies with the `PATCHES` applied, and the hand-written host surface. The extra names passed to
step 3 are cut as hooks on top of the regex.
