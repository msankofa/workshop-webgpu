# Bot design studio

`bot-design-studio.html` is the harness the bot's *appearance* is authored in. It renders several
design variants side by side through the same materials, themes and post chain as
`bot-viewer-v2.html`, so what you judge there is what ships.

This doc is the **workflow** — how to run a session and what order to do things in. The reference
material lives elsewhere and is not repeated here:

- Panel semantics, which fields are live during a drag versus applied on release, group-edit rules,
  the Gallery's five axes, and the rig constraints the panel is built around:
  `procedural-body-weapon-contracts.md` (the "Studio control panel" section).
- What the design descriptors themselves mean: the same file, earlier.
- Where the studio sits among the bot modules: `bots.md`.

## Running it

It needs the local server — the page imports modules and fetches weapon GLBs, neither of which
works over `file://`:

```
python serve.py          # 8080
```

then `http://127.0.0.1:8080/bot-design-studio.html`.

Two things about the server matter beyond serving files. The critique popup POSTs its comment to
`/api/save-notes`, which `serve.py` exposes, so critique notes only persist when the page is served
by `serve.py` rather than any static server. And the studio must be the **foreground window** for
any capture: `requestAnimationFrame` is suspended in a background tab, so `captureViews` rejects
with a message saying so rather than hanging on a frame that will never arrive.

## The default scene

Four slots: bare head, helmet, helmet + shades, helmet + shades + mask — all on the clothed human
carrying `cz_805_bren`, so the design is judged in a combat pose rather than a T-stance. One design
object is shared across every slot, and the geometry cache is keyed on descriptor content, so N
slots of the same body cost the same geometry as one and a panel edit shows up on all of them at
once.

**Slot 0 is the editable copy. The others stay on the shipped design as a reference you can
compare against.** Losing track of which slot you are editing is the most common way to waste a
round trip, which is also why `critiqueSlot()` picks the helmeted slot rather than slot 0.

## The loop

1. **Change one thing** — a panel field, or `__studio.controls.select([...])` then a field for a
   group edit.
2. **Frame it** — `focusPart(name, { dir })` or `glideTo`. Never judge from the lineup camera.
3. **Capture** — `__studio.critique('head')` renders the part from six angles into one contact
   sheet and opens the comment box.
4. **Wait for the comment.** Nothing changes until a critique lands. This is the point of the
   popup: it is a stop, not a report.
5. **Paste back** — `Copy gear JS` or `Copy diff` from the panel, into `bot-body-design.js`.

### Why every angle, not one

A single view is what let a boom mic ship as five disconnected pieces, each of which looked
correctly placed from the side. `CRITIQUE_VIEWS` is `front / three / side / back / left / top`, the
sim is paused so the pose is identical across all six, and labels are hidden. Tiles are a
centre-square **crop**, not a fit, because letterboxing a wide viewport into a square cell shrinks
the subject to a third of the tile and defeats the point of looking closely.

### Review at part distance, never at lineup distance

The near-black head, the buried eyes, the faceted silhouettes and the invisible boot detail were
all invisible in full-body screenshots. Every one was found by framing a single part.

## The three tools that break a stall

When something looks wrong but you cannot say what:

- **`auditVisibility(names, { views, samples })`** — the one that answers "is this part actually
  visible, or is it buried?" It raycasts surface samples from several directions against a mesh
  mirror of the body and reports the fraction whose first hit is the part itself, **plus who is
  occluding it**. Verdicts are `INVISIBLE from every view tested` (< 0.02), `barely visible`
  (< 0.12), or `reads`. A part you have been nudging for twenty minutes may simply be inside the
  torso.
- **`measurePart(name, { side })`** — extents in the part's **own frame**, in metres. A world AABB
  inflates as soon as the pose rotates the part, so proportions read from one are wrong in a way
  that looks plausible.
- **`setExplode(1, { mode })`** — peels armour off the chassis (`'gear'` along each piece's authored
  offset, `'groups'` by body region). The weapon is suppressed while exploded because it is posed
  from body motion in a separate pool and would float.

`solo(name)` and `setLayers({ gear: false })` do the cruder version of the same job: strip
everything else away and look at the bare chassis.

## `window.__studio` API

Scene and slots:

| Call | Does |
|---|---|
| `setSlots(specs)` / `getSlots()` | Rebuild the lineup. Each spec takes `label`, `design`, `style`, `weapon`. |
| `setAnim(mode)` | `idle`, `turntable`, `walk`, `run`, `crouchIdle`, `crouchWalk`, `prone`, and the `aim*` variants. |
| `setTheme(key)` | Same theme keys as bot-viewer-v2. |
| `setPaused(v)` / `paused` | Freeze the sim so a part holds still while you inspect it. A paused frame still re-solves at `dt` 0, so the pose holds exactly while the camera moves. |
| `showLabels(v)` | Slot labels. |

Camera:

| Call | Does |
|---|---|
| `preset(name)` | `lineup`, `front`, `high`, `side`, `back`. |
| `setCamera({ pos, target, fov })` | Direct placement. |
| `frameSlot(i, dist, y)` | Portrait framing of one slot; `y` picks the focus height (1.55 for the head). |
| `focusPart(name, { slot, dir, margin, side })` | Fills the viewport with one part's real world bounds, gear children included. Returns its centre and size. |
| `glideTo(name, { seconds, ... })` | Same framing, tweened, resolving once the image has settled. Disables orbit controls during the tween so a drag cannot fight it. |
| `tourParts(names, { secondsPer, dwell })` | Chained glides — one call for a whole review sweep. |
| `cameraMoving` | True mid-glide. |

Inspection: `auditVisibility`, `measurePart`, `gearParts()`, `partGroups()`, `solo`, `setLayers`,
`setExplode` / `getExplode`, `critique(part, opts)`.

Editing (`__studio.controls`): `design`, `selection`, `select(indices)`, `gearSource()`, `diff()`,
`rebuild()`, `undo()`, `redo()`.

Also on the object: `THREE`, `scene`, `camera`, `visuals`, `batches`, `slotBodies()`, `viewDirs`,
`partNames`, `shipped` (a frozen deep copy of the design as shipped), and `designWith`.

**Part names** accept joint and core names, group names, and `gear#<index>` — the index being the
position in `design.gear`, which is what an authoring tool actually edits. **View directions** are
`front`, `back`, `side`, `left`, `three`, `top`, `low`; an unknown one silently falls back to
`three`, so a typo costs a duplicate tile rather than an error. Check against `__studio.viewDirs`.

## Two costs to know before you extend it

The importmap pins the **minified** three builds. Unminified `three.webgpu.js` is 1.97 MB against
0.61 MB — 3.2x the bytes and 3.2x the parse before the first frame.

`buildSlots` **clears the shared geometry cache every time**, so every rebuild, including every
slider release, regenerates all geometry and every body. For the full gallery that is 126 unique
geometries across roughly 2,100 part placeholders. The geometries are cheap; rebuilding twenty
whole bodies for a one-piece edit is not.
