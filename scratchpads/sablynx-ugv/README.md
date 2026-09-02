# Sablynx UGV: what is specific to this design

Reconstruction of the Roboneers Sablynx / Lynx ("Рись") UGV for the Base Game `ugv` vehicle.
The measurements and the observation-versus-inference split are in `intake-analysis.md`.

## Where this design departs from the pipeline in `../README.md`

The parent pipeline assumes an **orthographic three-view drawing**, which is what lets
`compare_views.py` report a silhouette IoU and per-station edge error. Both references here are
**perspective photographs**: in the studio shot the near front tyre is 531 px across and the near
rear only 373 px, a 1.42x scale change over one wheelbase. There is no orthographic view to
intersect a rendered silhouette against, so that gate cannot run and forcing it would produce a
number that means nothing.

So steps 1, 2, 5, 6 and 8 were run and steps 3, 4 and 7 (author a sculpt spec, generate a
TypeScript factory, log spec review rounds) were skipped: the spec exists to feed the factory and
the IoU, and the factory is thrown away at step 8 anyway. The model was hand-authored straight into
`flight-meshes.js`, which is the pipeline's own endpoint.

What replaces the missing gate:

- `intake-analysis.md` holds a **band table** in fractions of the tyre diameter above ground, every
  row marked measured or inferred.
- `silhouette_ascii.mjs` renders CPU side and front silhouettes with those band fractions printed
  down the margin, so each band can be read straight off the model and compared with the table.
- `test-vehicle-meshes.mjs` in the repo root pins the bands, the wheel placement, the ground
  contact and the winding.
- `viewer.html` puts the model beside the reference for the only check that catches a wrong shape.

## Files

| File | Role |
|---|---|
| `ref/side-studio.jpeg` | Studio side-on 3/4, subject cut out on black. The geometry source. |
| `ref/front-field.jpeg` | Field photograph, gun firing. Settles the 4x4 and the deck layout only. |
| `intake-analysis.md` | Measurements, inferences and the band table. |
| `zones/` | Component crops. `z1` turret and mast, `z2` cage and deck, `z3` hull and wheels, `z4` the brightened field shot. |
| `builder.js` | The authored builder, spliced into `flight-meshes.js` as `buildUgv`. Kept as the working copy. |
| `viewer.html` | Model beside reference, view presets, wireframe, ground grid. Also serves the buggy with `?kind=buggy`. |
| `silhouette_ascii.mjs` | CPU side and front silhouettes, labelled in tyre diameters. |
| `probe_ugv.mjs` | Bounds, mesh and triangle count, band check. |
| `probe_wind.mjs` | Signed volume per merged part. Catches an inside-out loft. |

## Looking at it

```
python serve.py 8080
```
then `http://127.0.0.1:8080/scratchpads/sablynx-ugv/viewer.html`. The reference is on the left and
the model on the right; `swap reference` cycles the zone crops.

## Things that bit, on this design

- The hull tub is a hand-rolled ring loft, and the first winding was **inside-out**. Nothing in the
  band table or the dimension test noticed; only signed volume did. `probe_wind.mjs` exists for
  that, and the check is now in the repo test.
- `mergeByMaterial` flattens static parts, so the weapon station has to be passed to
  `finishVehicle` as an animated group or it fuses to the hull and can never be trained.
- The reference vehicle is about 1.85 m long; the game's definition fixes a 1.1 m wheelbase, so the
  model comes out near 0.85x. Raising `wheelbase` in `BASE_GAME_VEHICLE_DEFS` is now the only edit
  needed to rescale it, since every dimension derives from that.
- The hull floor is authored **above** the mesh origin, not on it. The origin is the simulation's
  reference height (ground + `clearance`); pinning the tub to it would have flattened the
  reference's 0.55 clearance-to-tyre ratio.
