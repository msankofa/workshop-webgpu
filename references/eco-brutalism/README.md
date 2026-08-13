# Eco-brutalism reference set

Source photographs for the `ecobrutal` theme in `bot-viewer-visuals-style.js` and the concrete /
flora work documented in `docs/subsystems/bots.md` ("Eco-brutalism: concrete surfaces and growth").

Each entry below names what the shader or placement code actually took from that image, so a later
tuning pass can tell which reference a parameter is answerable to.

| File | What it drives |
|---|---|
| `01-moss-courtyard.jpeg` | Moss carpeting every up-facing surface, and damp green creeping up the base of vertical faces — the `algae` term, which the shared `mossWeight` law deliberately does not cover. |
| `02-flooded-interior.png` | Moss claiming a flat interior floor. Standing water is **not** implemented. |
| `03-underpass-grass.jpeg` | Tall grass right up to the wall line, under a hard concrete soffit. The grass field's height and density. |
| `04-board-formed-shrubs.jpeg` | Board-formed concrete: horizontal boards, each pouring a slightly different shade. The `boardToneVar` parameter exists because of this image. |
| `05-board-formed-woods.jpeg` | Same board system at a larger scale, with shrubs massed at the base. |
| `06-ruin-blocks-meadow.jpeg` | Bare concrete blocks standing in an open meadow — closest to what a bot-viewer arena actually looks like. |
| `07-underpass-panel-formed.jpeg` | **Form-panel** concrete: a grid of large rectangular panels, thin recessed joints, regular tie-hole dots, under real sun with sharp cast shadows. The primary form system, and the reason the theme ships with a sun rather than overcast. |
| `08-ramp-slot-panels.png` | The same panel system read in flat shade — how little contrast the joints need. |
| `09-quarry-ivy-ledges.jpeg` | Where growth lands on a big vertical mass: horizontal ledges, dripping vertically down the faces below. |
| `10-mossy-ruin-blocks.png` | Moss on tumbled blocks; every upward face furred, vertical faces much less so. |
| `12-aggregate-steps-vines.jpeg` | Exposed aggregate (dense dark speckle), vines spilling over a wall's **top edge**, and moss cushions packed into concave step corners. The vine system comes from this image. |
| `13-house-in-thicket.jpeg` | Board-formed structure with planting grown right up against it. |

There is no image 11 - the set was supplied in two batches and that index was not used.

These were recovered from the session transcript on 2026-08-09 after the paste cache was pruned;
extensions follow each file's real encoding, which is a mix of JPEG and PNG.
