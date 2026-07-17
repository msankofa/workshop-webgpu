# Time-of-Day Cycle — Spec + Implementation Plan

Date: 2026-07-16
Subsystems: sky, lighting (spans both)

## Goal

A 24-hour clock that drives the sun and moon along realistic arcs (latitude + season
aware) and cross-fades the scene lighting between day and night. Both the sun and the
moon are present at once — the moon rides an anti-sun arc so it is up while the sun is
down. The clock drives the existing rig sliders; a master toggle hands control back for
manual tuning.

## Decisions (locked)

- **Solar model:** real solar-position math — declination from day-of-year, hour angle
  from the clock, elevation/azimuth from latitude.
- **Moon:** anti-sun. Same solar math with the clock shifted by a `phaseOffsetHours`
  knob (default 12). No lunar ephemeris.
- **Clock drives:** elevation, azimuth, sun intensity, sun color, ambient (full auto
  lighting).
- **Lighting richness:** warm/golden low sun near sunrise/sunset, neutral at noon, cool
  dim moonlit night.
- **Inputs:** Time (0–24), Latitude (−90…90, default 45), Day-of-year (1–365, default
  ~172 midsummer), Moon phase offset (0–24 h, default 12).
- **Override model:** master "Drive from time of day" toggle. While on, the clock owns
  the driven sliders and manual drags to them are overwritten next frame. Off → current
  manual behavior, unchanged.
- **Auto-advance:** manual Time slider + Play/Pause + Speed (game-minutes per real
  second).
- **Celestials:** while the driver is active, auto-enable the existing
  `setCelestialOpacityMode(true)` so stars/Milky Way/planets fade in at night.
- **Persistence:** `exportConfig`/`importConfig` gain a `timeOfDay` block.

## Coordinate convention (verified)

`lights.js` `toDir(az, el) = (sin az·cos el, sin el, cos az·cos el)` ⇒ +Z is North,
+X is East, azimuth increases clockwise from north. The solar `azimuthDeg` below
(compass degrees clockwise from north, east = 90°) and `elevationDeg` therefore map
**directly** onto `rig.setAzimuth` / `rig.setElevation` — no conversion. Elevation may
be negative (sun/moon below horizon); the rig does not clamp (only the old slider did).

---

## Component 1 — `solar-position.js` (new, pure math)

Pure JS, no three.js import (same pattern as `sky-field.js` and the CPU/GPU twins), so
it is Node-testable without a GPU.

```js
export function sunPosition({ hour, latitudeDeg, dayOfYear }) // → { elevationDeg, azimuthDeg }
export function moonPosition({ hour, latitudeDeg, dayOfYear, phaseOffsetHours = 12 })
  // → sunPosition with hour := hour + phaseOffsetHours (wrapped to [0,24))
```

Math (degrees in/out, standard approximations):

- Declination: `decl = 23.44 * sin(rad(360/365 * (dayOfYear - 81)))`
- Hour angle: `H = 15 * (hour - 12)`  (degrees; solar noon = 0)
- Elevation: `elev = asin( sin(lat)·sin(decl) + cos(lat)·cos(decl)·cos(H) )`
- Azimuth (compass, clockwise from north):
  `cosA = (sin(decl) - sin(elev)·sin(lat)) / (cos(elev)·cos(lat))`,
  `A = acos(clamp(cosA, -1, 1))`; if `H > 0` (afternoon) then `A = 360 - A`.
  Guard the `cos(elev)·cos(lat) ≈ 0` degenerate case (poles / sun at zenith) → return a
  stable azimuth (e.g. fallback to 180) rather than NaN.

Return `{ elevationDeg, azimuthDeg }`, azimuth normalized to `[0,360)`.

### `test-solar-position.mjs` (new, plain Node, no framework)

- Equinox (`dayOfYear = 81`) at equator (`lat = 0`): noon (`hour = 12`) elevation ≈ 90°;
  sunrise (`hour = 6`) elevation ≈ 0°.
- Sunrise azimuth ≈ east (~90°), sunset (`hour = 18`) azimuth ≈ west (~270°).
- Summer solstice noon elevation > winter solstice noon elevation at `lat = 45`.
- Determinism (same inputs → same output) and elevation range `[-90, 90]`, azimuth
  `[0, 360)`.
- `moonPosition` with `phaseOffsetHours = 12` at a given time ≈ `sunPosition` 12h later
  (moon up when sun is down).
- Run: `node test-solar-position.mjs` → exit 0 on pass.

---

## Component 2 — `sky.js` (moon independence)

Today `setSunDir(d)` places **both** discs at `d`; `updateDiscVisibility` shows one based
on `primaryBody`/`isMoonBody`. Add independent moon control without breaking the existing
`primaryBody` path (used when the driver is off).

New returned methods:

- `setMoonDir(v)` — normalize and store a separate moon direction; place the moon
  sprite (and expose it so the viewer can point `moonLight` at it). Does **not** move the
  sun sprite.
- `setCelestialVisibility(sunVisible, moonVisible)` — explicit per-disc visibility,
  bypassing `updateDiscVisibility` while the driver owns it. When the driver is off, the
  existing `setCelestialType`/`updateDiscVisibility` continue to govern visibility.

Internal changes:

- Split the single `dir` into `sunDir` (existing `dir`) and a new `moonDir`.
- `placeSun()` places the sun sprite from `sunDir`; a new `placeMoon()` places the moon
  sprite from `moonDir`. `setSunDir` calls `placeMoon` only if `moonDir` is unset
  (back-comp: before this change both tracked the same dir).
- Keep sprite depth behavior as-is. Below-horizon discs are hidden via
  `setCelestialVisibility` from the driver (sun/moon `elevationDeg > -2` ⇒ visible).

Update `docs/subsystems/sky.md`: new `setMoonDir` / `setCelestialVisibility` in the
public API list and an architecture note that sun and moon discs now have independent
directions (previously shared).

---

## Component 3 — `environment-viewer.html` (driver, UI, persistence)

### 3a. Import + params

- `import { sunPosition, moonPosition } from './solar-position.js'` (lazy or static
  alongside sky).
- New params (defaults): `todEnabled=false`, `todHour=12`, `todLatitude=45`,
  `todDayOfYear=172`, `todMoonPhase=12`, `todSpeed=0` (game-min/real-sec), `todPlaying=false`.
- Lighting ramp constants: `todSunMax = rigP.sunIntensity` (4.0 env), `todAmbMax =
  rigP.ambientIntensity` (0.8), `todAmbNight = 0.12`, warm sun `#ffb066`, neutral sun
  `#fff4e0`, moon light max `0.35`.

### 3b. `applyTimeOfDay()` — called per frame when `todEnabled`

1. `sun = sunPosition({ hour: todHour, latitudeDeg: todLatitude, dayOfYear: todDayOfYear })`
   `moon = moonPosition({ ...same, phaseOffsetHours: todMoonPhase })`.
2. Geometry: `rig.setElevation(sun.elevationDeg)`, `rig.setAzimuth(sun.azimuthDeg)`; keep
   `rigP.elevation/azimuth` and the slider displays in sync.
3. `skyRef.updateDome(sun.elevationDeg)` (dome day/dusk/night already keyed to elevation);
   then read `nightness = skyRef.nightness`.
4. `skyRef.setSunDir(dirFromAzEl(sun))`, `skyRef.setMoonDir(dirFromAzEl(moon))`,
   `skyRef.setCelestialVisibility(sun.elevationDeg > -2, moon.elevationDeg > -2)`.
5. Sun intensity: `todSunMax * smoothstep(-2, 8, sun.elevationDeg)` → `rig.setSunIntensity`.
6. Sun color: `lerpHex('#ffb066', '#fff4e0', smoothstep(0, 12, sun.elevationDeg))` →
   `rig.setSunColor`. (Reuse `lerpHex` from `sky-field.js`.)
7. Ambient: `todAmbNight + (todAmbMax - todAmbNight) * (1 - nightness)` →
   `rig.setAmbientIntensity`.
8. Moon light: `moonLight.intensity = 0.35 * smoothstep(-2, 10, moon.elevationDeg) *
   nightness`; point `moonLight` at the moon dir (not the sun dir).
9. `forestGPURef?.setBillboardBrightness(billBrightness(effectiveSunIntensity))`.
10. First activation: `skyRef.setCelestialOpacityMode(true)`.

`dirFromAzEl` mirrors `toDir` locally, or reuse `skyLightDir()`-style math.

### 3c. Per-frame branch

In the sky block (`environment-viewer.html` ~8471–8484): if `todEnabled`, call
`applyTimeOfDay()` (which sets sun/moon dirs + dome); else keep the existing
`setSunDir(skyLightDir())` + `updateDome(rig.elevation)` + moon-light-tracks-sun path
unchanged. Advance the clock when playing: `todHour = (todHour + todSpeed * dt / 60) % 24`.

### 3d. UI — new "Time of day" section at the top of the Lighting panel

Built with the inline `header()/slider()/toggle()` helpers, before the existing
Sun-elevation/azimuth sliders:

- `toggle('todEnabled', 'Drive from time of day', …)` — master enable.
- `slider('todHour', 'Time', 0, 24, 0.05, …)` with an HH:MM display formatter.
- `slider('todLatitude', 'Latitude', -90, 90, 1, …)`.
- `slider('todDayOfYear', 'Day of year', 1, 365, 1, …)`.
- `slider('todMoonPhase', 'Moon phase offset (h)', 0, 24, 0.5, …)`.
- `slider('todSpeed', 'Speed (min/sec)', 0, 600, 5, …)` + a Play/Pause button toggling
  `todPlaying`.

While `todEnabled`, the existing elevation/azimuth/sunIntensity/ambient sliders are
overwritten each frame (documented behavior); the master toggle off restores manual
control.

### 3e. Persistence

Extend `exportConfig`/`importConfig` with:
`timeOfDay: { enabled, hour, latitude, dayOfYear, moonPhaseOffset, speed, playing }`.
Import applies values and refreshes the relevant slider displays.

### Docs + log

- Update `docs/subsystems/lighting.md`: new "Time-of-day driver" section documenting
  `applyTimeOfDay`, the ramp curves, the master toggle, and that the clock overwrites
  the manual rig sliders while active.
- Update `docs/subsystems/sky.md` (Component 2 above).
- Append one `agent_log.csv` row (subsystem `multi`).

---

## Implementation plan / orchestration

**Phase 1 (parallel — two Sonnet agents, disjoint files):**

- Agent A — `solar-position.js` + `test-solar-position.mjs`. Deliverable: `node
  test-solar-position.mjs` exits 0.
- Agent B — `sky.js` `setMoonDir` + `setCelestialVisibility` + sun/moon dir split, and
  the `docs/subsystems/sky.md` API/architecture updates. Deliverable: no other sky
  behavior changes; `node test-celestial-bodies-smoke.mjs` and `node test-sky-field.mjs`
  still pass.

**Phase 2 (one Sonnet agent, after Phase 1 — single large file):**

- Agent C — `environment-viewer.html` integration (import, params, `applyTimeOfDay`,
  per-frame branch, UI section, persistence), plus `docs/subsystems/lighting.md` and the
  `agent_log.csv` row. Integrates against the real APIs from A and B.

**Phase 3 — orchestrator review** (me): read all diffs, run the Node tests, check the
per-frame branch preserves the driver-off path, verify azimuth/elevation mapping and the
ramp math against this spec, confirm docs/log updated.

## Out of scope (YAGNI)

- Lunar ephemeris / real moon phase-lit disc.
- Atmospheric scattering / physically-based sky color.
- Twilight civil/nautical distinctions beyond the existing day/dusk/night dome states.
- Shadow-length or shadow-color changes beyond what intensity already drives.
