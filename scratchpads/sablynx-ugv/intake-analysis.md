# Roboneers Sablynx / Lynx ("Рись") UGV: intake analysis

Sources: `ref/side-studio.jpeg` (1601 x 1999, the subject cut out on pure black; the geometry
source) and `ref/front-field.jpeg` (1880 x 1058, a dark field photograph of the gun firing; used
only to settle what the studio shot hides). Zone crops in `zones/`.

## How this reference differs from the Sentinel's, and what that changes

The Sentinel was reconstructed from an **orthographic three-view drawing**, so `compare_views.py`
could report a top-view IoU and per-station edge error against it. Both references here are
**perspective photographs**, and the studio shot is a close one: on the near side the front tyre
measures 531 px across and the rear only 373 px, a 1.42x scale change over one wheelbase. There is
no orthographic view to intersect a rendered silhouette with, so the IoU gate cannot run and would
be meaningless if forced.

The pipeline steps that still pay for themselves are the ones used here: measure before authoring,
separate observation from inference, cut component zones and look at every one, then hand-author
the builder and pin it with a test. The spec-to-factory-to-IoU machinery is skipped deliberately
for this design, not forgotten. **Proportions are therefore ratios, not absolute metres**, anchored
on the one feature the perspective distorts least.

## Anchor

The near-side front tyre is the closest object to the lens and the only clean circle in the frame.
Everything below is quoted as a multiple of its diameter, **D**, measured above the ground line.

- Near-side front tyre: x 460-991, so **D = 531 px**. Its lowest row is y = 1992, taken as the
  **ground line**.

## Observations (measured on the studio shot)

- Four wheels. The studio shot shows three: near-side front (D = 531 px, bottom y 1992), near-side
  rear (373 px, bottom y 1884) and far-side front (245 px, bottom y 1825). The field photograph
  shows the fourth and confirms a 4x4.
- Vehicle front is to the **left**: the gun barrel, the sloped nose and the front mudguard are all
  at low x, and the "Рись" lettering runs along the hull side between the two near wheels.
- Hull is a **monocoque tub**, not a box. Between the near wheels its visible side runs from
  y 1201 (1.49 D) down to y 1636 (0.67 D), and the lower edge is a continuous inward curve; the
  underside is never visible.
- Hull side, ahead of the front wheel, drops away as a **sloped nose**: at x 60 the green ends at
  y 1311 (1.28 D), at x 140 y 1480 (0.96 D), at x 180 y 1570 (0.79 D), at x 260 y 1656 (0.63 D).
- A horizontal **flange with bolt heads** runs the length of the hull top edge.
- The **deck** is expanded metal / diamond plate, flat, covering the hull top.
- A **tubular perimeter rail** stands around the deck: a lower tube at deck level, short vertical
  posts, and an upper tube. Top rail measured at y 1086 (1.71 D); deck edge at about 1.42 D. So the
  rail stands roughly 0.3 D above the deck.
- Between the rail tubes are **flat plates with rectangular slots and round holes**, and two
  **clamp blocks with black knurled knobs** per side. Wire R-clips hang at the corners.
- The **RWS** sits centrally on a stepped cylindrical **pedestal**. Topmost green by column: y ~600
  across x 320-800 (the gun cowl, 2.62 D), rising to y 536 at x 1040.
- The gun cowl is angular sheet metal with **six or seven vertical louvre slots** on its side.
- A green **cylindrical ammunition drum** sits on the right of the gun with its flat circular end
  facing the camera.
- A black **optic** with a blue-tinted lens sits under and ahead of the barrel; black elevation
  rails and linkages sit below the receiver.
- Barrel is long and thin, muzzle at x ≈ 38, which is 687 px (1.29 D) ahead of the front-wheel
  centre at x 725.
- A **square-section mast** rises at the rear right (x 1390-1490) to an L-shaped top arm that
  extends forward, carrying a small green **camera box** with a black lens, **two black antenna
  whips** with ribbed bases, and a **black dome** on a short green stalk. Mast plate about 2.85 D,
  dome top y 404 (3.00 D).
- Antenna whips leave the top of the frame; their tips are **not observed**.
- Black **corrugated flexible conduit** runs from the turret down to the deck.
- Tyres are knobbly ATV type on **deep-dish steel rims with a smooth domed centre cap** and no
  visible lug detail at this distance.
- Paint is a single flat olive green over hull, cage and mast, scuffed and worn on the lower hull.
  Tyres, optic, conduit, knobs and antennas are near-black. Rims are dark grey.

## Inferences (not measured; labelled because they cost correction rounds later)

- The hull's true lowest point is taken at **0.55 D** above ground. Only the side's visible lower
  edge (0.67 D) was measured; the tub curves under and is hidden. This is consistent with published
  figures for the type of about 0.35 m clearance on a 0.635 m (25 inch) ATV tyre, a ratio of 0.55.
- Wheelbase is **not measurable** from this shot: the two near wheels sit at different depths and
  scales. It is taken from the game's own simulation definition instead.
- Antenna tips are set at **3.4 D**, chosen so the whips read at gameplay distance without
  dominating the silhouette. They are cut off in the reference.
- The far side of the deck, everything under the hull, and the rear face are unobserved.
- The two references are **different configurations**. The studio unit carries the tall mast with
  camera, whips and dome. The field unit has no such mast: its whips rise from the deck corners.
  The studio unit is modelled, since it is the cleaner reference and the one asked for.

## Scale, and why it is not the real vehicle's

The published vehicle is roughly 1.85 m long on a 0.635 m tyre. The game's `BASE_GAME_VEHICLE_DEFS`
already fixes `wheelbase` 1.1 m, `track` 0.8 m and `clearance` 0.25 m, and those numbers are what
`fitVehicleGround` samples and what the room and prediction tests assert. The model is therefore
authored **to the definition**, with the reference supplying only the ratios, and it comes out
about 0.85x of the real machine.

Two consequences worth stating:

- Tyre diameter is set at **0.55 x wheelbase**, from the reference's own tyre-to-body relationship,
  giving 0.605 m rather than the real 0.635 m.
- The hull's lowest point is authored **above** the mesh origin, not on it. The origin is the
  simulation's reference height (ground + `clearance`), not a geometric requirement; putting the
  tub floor 0.08 m above it restores the reference's 0.55 clearance-to-tyre ratio while the tyres
  still reach the ground at `-clearance`.

If the vehicle should instead be true Lynx size, raising `wheelbase` in the definition is now the
only edit needed: the builder derives every dimension from it.

## Vertical band table (fractions of D above ground)

| Feature | D | Source |
|---|---|---|
| Tyre centre | 0.50 | measured |
| Hull tub floor | 0.55 | inferred |
| Hull side lower edge | 0.66 | measured (0.67) |
| Deck / hull top edge | 1.42 | measured (1.40-1.49 by column) |
| Cage lower rail | 1.45 | measured |
| Cage top rail | 1.71 | measured (y 1086) |
| Turret pedestal top | 1.95 | measured |
| RWS body centre | 2.45 | measured |
| Gun axis | 2.62 | measured (y ~584) |
| Cowl top | 2.75 | measured (y ~600) |
| Mast top plate | 2.85 | measured |
| Dome top | 3.00 | measured (y 404) |
| Antenna tips | 3.40 | inferred, cut off in frame |

## Materials

One flat olive green (hull, cage, mast, cowl, ammo drum, pedestal). Near-black for tyres, optic
housing, conduit, knurled knobs and antenna whips. Dark grey for rims, deck plate and the bolt
flange. Blue-green tint on the optic lens only. The lettering is albedo-only and is not modelled.
