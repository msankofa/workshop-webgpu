# Observable vegetation debugging

The Base Game vegetation HUD lives in the existing bottom debug dock, below the FPS line.
Its scrollable details are capped at 20% of the viewport height. It refreshes twice a second.
Press Esc to release the mouse, then use its buttons. Hide collapses the HUD and stops its
sampling requests. An open grass settings panel or a performance capture can still request
diagnostics independently. HUD-only sampling reads one survivor counter about once a second;
it does not dispatch the two ground probes. Tree LOD counts are CPU estimates, not GPU reads.

## Occlusion comparison

1. Wait for tree startup and terrain streaming to settle. Stand still facing a building.
2. Pin counts / FPS once a fresh grass sample is available.
3. Toggle grass occlusion, stay still, wait at least two seconds, then compare.
4. Repeat in the reverse direction. Keep density, camera, lighting and other settings fixed.

The comparison rejects changed views/settings/coverage or stale counts. It reports observed
survivors on/off, the difference, and FPS snapshots; these are not isolated GPU timings.
Streaming and other dynamic rendering can still confound the result. The full-cover blade
estimate is NOT the count before occlusion: cover, water, distance and cone culling also thin it.
The HUD caps drawn blades at buffer capacity but shows the uncapped survivor counter separately.
Its exact GPU-cull line partitions tested candidates into planar/cone/fade, density,
ground/water, off-screen, depth-occlusion, and survivor totals, with capacity overflow separate.
Those rejection atomics run only while diagnostics are requested and may reduce FPS; hide the
HUD and close the grass panel when measuring normal play. Occlusion A/B FPS while the HUD is
open includes this constant instrumentation overhead.

Base Game's world updater still invokes flora synchronization every frame because online room
flags can change independently of local settings. The setters are identity-idempotent: unchanged
structure textures and unchanged ordered root/filter pairs neither force a grass recull nor
invalidate the static depth cache. The terrain filter is a stable function reference. Bias,
depth revision and depth-camera changes are ignored by the grass cull while master occlusion is
off; enabling it applies the latest cached values in one recull. Actual terrain residency and
structure-version changes continue through `remarkOccluders()` explicitly.
Depth render and cache-skip rates expose the occlusion pass's activity; its CPU submission
duration does not measure GPU depth rasterization. Trees currently have no depth-occlusion cull.

## Latest inspected capture

Source: `research/stats/base-game-performance-log.json`, capture `2026-09-05T12:12:34.667Z`.

- 71.773 effective FPS; p95 frame time 18.5 ms.
- 1,601 resident/uploaded trees; estimated LOD counts 26 / 82 / 243; no capacity drops.
- 5,146 grass survivors; 155,952 candidate threads; 3,000,000-blade capacity.
- Tree first publication 28.329 s; completion 51.786 s; render warmup 51.535 s.
  Palette CPU 103 ms, setup 31.2 ms, variant installation 7.3 ms. Render warmup dominates.
- CPU-side update averages: grass 0.268 ms, forest 0.051 ms. Main/post submission bucket
  averaged 7.386 ms. Its similarly valued direct/plain/shadow buckets overlap; do not sum them.
- GPU timestamps were NOT requested, despite reported device support. No isolated GPU
  grass/tree/occlusion cost can be established from this capture.

The preceding two captures were at a different camera position with trees absent or still
building. They are not a controlled before/after comparison. Earlier captures also used
different locations and blade counts. No FPS improvement is claimed from those comparisons.

## Verification

Automated checks cover HUD labels, capacity clamping, comparison guards, hide/show sampling,
the page module syntax, count-only readback publication/cancellation, and existing panel,
profiler and occlusion contracts. Browser layout and real GPU behavior still require an
interactive run. Only the HUD integration and focused tests/docs are committed by this task;
concurrent agents' changes are left untouched.
