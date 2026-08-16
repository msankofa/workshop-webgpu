# Stadium session package

The documents and tooling from the 2026-08-13 DramaticShapeVoxelMod session, plus the one script this
repo added. The session's viewers (`pokedex-151.html`, `stadium-extras.html`, the per-species pages)
and the ROM are **not** here — they live in `dramaticshape-session.zip` and
`demos/Pokemon Stadium (USA).zip`, both outside git.

- `HANDOFF.md` — the spec that started this work: auto-map an unnamed Stadium skeleton, retarget the
  repo's gait onto it, walk it. Done; see `docs/subsystems/stadium.md` for what was built and what the
  handoff got wrong about the rig (bone origins are not joints).
- `feasibility-report.md` — eight mod ideas assessed against the mod and engine source, with a build
  order. Still the reference for what this is all for.
- `tooling/extract_glb.py` — pulls individual `.glb` models back out of the session's
  `pokedex-151.html` viewer, which carries all 151 LZMA-compressed. **This is the ROM-free path to any
  species.** Run it from a directory containing `package/pokedex-151.html`:
  `python extract_glb.py 019 058`, or with no arguments for all 151 (~74 MB).
- `tooling/gen_viewer.py`, `template*.html`, `GLTFLoader.patched.js`, `extras_grid.html`,
  `mat_probe.html`, `probe2.html` — the session's own single-file viewer generator and the probes it
  was debugged with. The patched loader exists because the Claude app's HTML preview sandbox blocks
  `fetch()` of blob URLs; **it is not needed here**, where pages are served over http and the stock
  `GLTFLoader` works.
