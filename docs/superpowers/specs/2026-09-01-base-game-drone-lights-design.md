# Base-Game Drone Lights — Design

**Date:** 2026-09-01
**Subsystem:** bots (drones) + lighting
**Status:** design agreed, not yet planned

## Goal

Every drone a player owns carries a lamp, and a drone can drop lights. Both use the light kinds
the dev gun already has. The player picks the lamp kind and the drop kind independently, from two
racks modelled on the flight sim's offensive/defensive weapon selectors, and can set both while the
drone is still in their hands, before the throw.

## What this is not

It is not a new lighting system. An earlier round of this design covered all six Three.js light
types (ambient, directional, point, spot, hemisphere, rect-area). That was cut. The dev gun's
existing kinds are point lights and that is sufficient. Nothing here adds a light type.

## Decisions locked in

- **Light kinds are the dev gun's.** `lantern`, `ember`, `floater`, `flare` from `DEV_LIGHT_KINDS`
  in `base-game.html`, plus a fifth entry `current` that reads the live `devLight*` sliders so the
  existing sliders remain the way to tune a drone light. All are `THREE.PointLight`.
- **Two independent selections.** A lamp kind and a drop kind. Either can be any kind; they do not
  constrain each other.
- **Every drone you own carries its lamp**, including one flying autonomously while you are back on
  the ground. The lamp is not tied to being at the stick.
- **The selection is player loadout, not drone state.** It lives on the player, transfers into the
  drone record at launch, and stays editable while flying. That is what makes configuring before
  the throw work at all.
- **Keys**, following `demos/flight-sim.html` (`i.fire = Space`, `i.deploy = KeyC`):
  Space toggles the lamp, C drops a light, left Alt cycles the lamp kind, right Alt cycles the drop
  kind. The existing fly key (F) enters the same control mode with the drone still in hand.
- **Dropping works while the drone is held.** The light leaves the held position. No special case.
- **Drones only.** Base-game has since grown a driveable vehicle path (`BASE_GAME_VEHICLE_DEFS`,
  `playerController.controlledVehicle`) that shares the fly key and the chase camera. Vehicles get
  no lamp here.
- **Space and C are taken by this mode, not shared.** Space is jump and C is the kneel stance on
  foot. Both the flying mode and the held-config mode capture them, the way flying already captures
  the movement keys, and release them on exit.
- **Shadows are a three-way setting:** `none`, `lamp`, `both`.
- **One pool of 16 resident point lights**, split into a fixed lamp range and a fixed drop range.
- **Local only in v1.** No replication, matching the dev-gun lights and the flashlight. The data is
  shaped so the server can carry it later without a rewrite.

## Why 16 and why a fixed split

Base-game uses plain forward lighting with resident Three.js lights. In the node material system
every light in the scene compiles into every material's shader, so each fragment shades every light
regardless of distance and regardless of whether its intensity is zero. Cost is lights times
fragments. The existing dev-gun pool is 8 for that reason.

This is not a WebGPU limit. `clustered-lights.js` in this repo bins lights into a froxel grid so a
fragment only shades the lights whose sphere touches its own cluster, with a cap of 512 and a
33-slot reserve for entity lights bound through `light-entity-renderer.js`. Environment-viewer
loads both. Base-game wires up neither. Moving base-game onto clustered lighting is the real answer
to running many lights, but it drags in how the clustered pass injects an additive term over the
existing sun, moon, fog and vision-mode chain, so it is its own job and explicitly out of scope
here.

So the pool goes from 8 to 16 and stays forward. **The split is 6 lamp slots and 10 drop slots.**
The split is fixed rather than dynamic because `castShadow` feeds the material compile: a slot that
was a lamp one frame and a drop the next would have to flip its shadow flag, recompiling every
material in the scene. With a fixed range, the shadow flag is a property of the range and changes
only when the setting changes. Six lamp slots covers three players' worth of drones, since a player
owns at most one quad and one UAV.

Resident light count after this change is roughly 14 existing plus 16 pooled. That is a real
per-fragment cost and the implementation plan must measure it with `frame-profiler.js` rather than
assume it is free.

## Architecture

### New module: `base-game-drone-lights.js`

Pure, no THREE, Node-testable, in the style of `forest-cull.js` and `base-game-drones.js`.

It owns:

- **The loadout state.** `{ lampOn, lampKind, dropKind }` plus the cycle functions over the kind
  order. This is the thing the two racks display and the Alt keys drive.
- **Kind resolution.** `resolveKind(name, liveSliders)` returns a full parameter set
  (`{ r, g, b, brightness, radius, lifespan, float, drift, trajectory }`). For the four presets it
  returns the preset. For `current` it returns the live `devLight*` values. This is why a drone
  lamp and a drone drop can be two different kinds at once, which the dev gun cannot do: the dev
  gun has one live slider set plus a preset name, whereas drones resolve a kind to parameters
  directly.
- **The lamp wire builder.** Given the drone records and the loadout, it emits the array
  `point-light-pool.js` already consumes: `{ id, p, color, radius, intensity }`, with
  `id` of the form `lamp:<droneId>` and `p` the drone's global position. No new binding code is
  needed on either side, because a lamp's wire shape is identical to a light entity's.

### Changes to `point-light-pool.js`

- `createPointLightPool` gains a range concept: `sync(entities, toLocal, { range })` where a range
  names a contiguous block of slots. Two ranges, `lamp` and `drop`, over one array of 16 lights.
- Each range carries a `castShadow` flag set from the shadows setting, applied on construction and
  re-applied only when the setting changes.
- The existing reject-newest rule when a range is full is unchanged.

### Changes to `base-game-drones.js`

The drone record gains `lamp: { on, kind }`, populated at `createBaseGameDrone` from the launching
player's loadout. It lives on the record rather than in a page-local map specifically so that
`droneWireState` can add one field when the server work happens.

### Changes to `base-game.html`

- **Drops** create a `light` entity in the existing `devLightRegistry`, so the falling, floating,
  drift and fade simulation in `entity-types/light.js` is reused untouched. A drop from a moving
  craft needs nothing new; it is a `create` at the craft's global position.
- **Lamp ramping** uses `rampToward` from `weapon-light.js`, the way the held lantern does, so
  toggling the lamp fades rather than pops.
- **Held-config mode.** `droneCtl` gains a held state. Entering it with a gadget in hand and no
  drone launched shows the racks and accepts Space, C and the Alt cycles. While in it, the body's
  jump and kneel keys are suppressed, the same way flying already takes the movement keys. The fly
  key exits.
- **HUD.** `droneHudLine()` gains two rack lines. Base-game's HUD is HTML, not the flight sim's 2D
  canvas, so the racks are rendered as chips in the style of the existing weapon slot chips, with
  the selected entry marked. The sim's canvas rack drawing is the model for the content, not the
  mechanism.
- **Settings:** `droneLampOn`, `droneLampKind`, `droneDropKind`, `droneLightShadows`, with a panel
  section following the flashlight section's precedent, including a note that the lights are local
  to this client.

## Data flow

1. The player cycles the racks. The loadout in `base-game-drone-lights.js` changes.
2. On launch, `createBaseGameDrone` copies the lamp selection onto the drone record.
3. Each frame, the lamp builder walks the drone records and emits lamp entries. The pool binds them
   into the lamp slot range.
4. Pressing C creates a light entity at the drone's position. The registry simulates it. Its
   serialized output binds into the drop slot range.
5. Both ranges convert global to render-local through `worldCoordinates.toRenderLocal` at draw time,
   the existing convention.

## Testing

- **`test-base-game-drone-lights.mjs`** (new): loadout cycling and toggling, kind resolution
  including `current`, and the lamp wire builder against fabricated drone records.
- **`test-point-light-pool.mjs`** (extend): range isolation, that a full range rejects rather than
  evicting, that shadow flags follow the range, and that the two ranges do not steal each other's
  slots.
- **`test-base-game-drones.mjs`** (extend): that a launched drone carries the lamp selection.

## Limitations, stated plainly

- Other players' drones will not light your scene in v1, because the lamp state is not on the wire.
- A dropped light in a map world with no terrain falls forever unless its kind floats. This is the
  existing dev-gun behaviour and the same caveat applies.
- Point-light shadows are cube maps, so six render passes per shadow-casting light. With the setting
  on `both` and a full drop range this is expensive by construction. The setting defaults to `none`.

## Deferred to a later pass

- Replicating lamps and drops through the room. The lamp is one boolean and a kind on the drone
  input and wire state. The drops need the room to run its own light registry, which is clean
  because `entity-registry.js` and `entity-types/light.js` are pure and import in Node, and
  snapshots already carry `projectiles` and `drones` so lights become a third array.
- Moving base-game onto `clustered-lights.js`.
- Spot or directional lamps.
