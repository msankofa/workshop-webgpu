# bot-viewer-v2 control panel — full UI inventory

Snapshot of every section and control in the `#ctrl` panel of `bot-viewer-v2.html`, in the order
they currently appear on screen. Built for the UI refactor: this is the "what exists today" input,
not a proposal.

Source: `bot-viewer-v2.html` lines ~10492–13406, plus `bot-viewer-visuals.js buildPanel()`
(Visuals section) and `bot-viewer-slots.js createSlotSection()` (Save / load section).

Counts: **28 sections**, **~330 controls** (buttons, sliders, number fields, dropdowns, readouts).

---

## Panel chrome (always visible, not in a section)

| Element | Type | Notes |
|---|---|---|
| "Bot viewer / v2" | title | panel header bar |
| ⌄ Expand every section | button | |
| ⌃ Collapse every section | button | |
| – / + | button | hide/show the whole panel body |

Sections are collapsible cards. **All default to collapsed except `Bot readout`.**

### Off-panel HUD (screen overlays, listed for completeness)

| Element | Where | Notes |
|---|---|---|
| Help/hint line | top-left | drag orbit, scroll zoom, click to follow, Shift+click POV, WASD dummy |
| fps counter | bottom-left | |
| perf recorder badge | bottom-left | Y key |
| nav warning banner | bottom-left | |
| floor warning banner | bottom-left | BB-004 fall rescue |
| scoreboard | bottom-left | toggled from Scoreboard section |
| now-playing toast | bottom-left | 5.2 s slide-in |

### Keyboard shortcuts (no UI affordance except tooltips)

`F` frame · `O` orbit · `V`/`P` POV · `G` fly · `Esc` leave fly · `]` cycle follow ·
`H` start/stop state capture · `L` live map · `J` copy last 10 s · `Shift+J` fall forensics ·
`Y` perf log · `Shift+Y` perf summary · `Alt+click a bot` set debug focus

---

## 1. Save / load  *(built last, prepended to the top)*

Three independent slot sets, each identical in shape:

| Element | Type |
|---|---|
| maze — slot picker | select (6 slots) |
| maze — slot name | text input |
| maze — Save / Load / ✕ | 3 buttons |
| maze — status line | readout |
| bots — slot picker | select (6 slots) |
| bots — slot name | text input |
| bots — Save / Load / ✕ | 3 buttons |
| bots — status line | readout |
| ui — slot picker | select (6 slots) |
| ui — slot name | text input |
| ui — Save / Load / ✕ | 3 buttons |
| ui — status line | readout |
| Export layout JSON | button |

Scope split: `maze` = map geometry + terrain (load rebuilds, clears bots). `bots` = every AI tuning
value (retunes live roster). `ui` = camera, debug overlays, look/theme, audio (never touches sim).

## 2. Camera

| Element | Type | Notes |
|---|---|---|
| Orbit / Follow / POV / Fly | 4 buttons, one row | mode selector |
| fly mode: Walk ground / Free flight | button | |
| fly speed (m/s) | slider 1–120 | |
| view distance (m) | slider 200–2000 | also scales the sky dome |
| framing | select | framing presets + Custom |
| Frame followed bot | button | |
| Follow nearest bot | button | |
| Auto rotate (orbit) | toggle button | |
| Auto follow bots | toggle button | |
| Occlusion guard (follow) | toggle button | |
| POV comfort | select | comfort presets |
| POV eye up/down (m) | slider −0.5–0.5 | |
| POV eye forward (m) | slider −0.5–1 | |
| Target diamond size | slider 0.3–3 | POV contact markers |
| POV debug widgets | toggle button | crosshair, reaction ring, target plate, vitals, squad bars |
| POV debug markers | toggle button | aim reticle, nav path, last-known ghost, cover anchor |
| POV recenter | toggle button | |
| POV recenter delay (s) | number 0–10 | |
| Recenter POV now | button | |

## 3. Map layout

| Element | Type | Notes |
|---|---|---|
| Rooms layout | button | |
| Maze layout (new) / Open layout (new) | button | label tracks wall mode |
| keep bots on rebuild | toggle button | |
| Auto scene shuffle | toggle button | |
| Shuffle look too | toggle button | |
| shuffle every (s) | number 5–300 | |
| Shuffle scene now | button | |
| cols × rows | 2 number inputs | |
| seed + 🎲 | number + button | |
| hall width (m) | slider 1.5–6 | |
| wall thickness (m) | slider 0.1–1.0 | |
| wall height (m) | slider 1–6 | |
| loop chance | slider 0–1 | carve-only, greys out in wall-less modes |
| straightness | slider 0–1 | carve-only |
| braid (kill dead-ends) | slider 0–1 | carve-only |

## 4. Maze structure

| Element | Type | Notes |
|---|---|---|
| walls | select | Maze corridors / Perimeter only / None (open ground) |
| structures | toggle button | open-mode only |
| structure count | slider 0–24 | open-mode only |
| structure spacing (m) | slider 2–24 | open-mode only |
| structure mix | select | Mixed / Buildings / Maze pockets / Obstacle fields |
| start/goal | select | Opposite corners / Center → corner / Random cells |
| perimeter entrances | slider 0–8 | |
| open rooms | toggle button | carve-only |
| room count | slider 1–8 | carve-only |
| room size (cells) | slider 2–6 | carve-only |
| cover pieces | toggle button | |
| cover density | slider 0–1 | |
| cover height (m) | slider 0.4–2.5 | |
| Big open field | button | one-click workspace preset |
| Test condition | button | reproducible 30×30 + 200 dummies harness |

## 5. Terrain

| Element | Type |
|---|---|
| uneven ground | toggle button |
| level pads | toggle button |
| seed + 🎲 | number + button |
| hill height (m) | slider 0–4 |
| hill scale (m) | slider 4–60 |
| hill detail | slider 1–5 |
| ripple height (m) | slider 0–0.6 |
| ripple scale (m) | slider 1–12 |
| grain (m) | slider 0–0.3 |
| mesh cell (m) | slider 0.2–1.5 |
| max walk slope | slider 0.2–2 |
| pad blend (m) | slider 0.5–6 |

## 6. Landform

| Element | Type |
|---|---|
| landform | select — Rolling / Ridged / Billowy |
| warp (m) | slider 0–15 |
| warp scale (m) | slider 5–80 |
| terrace steps | slider 0–10 |
| terrace sharpness | slider 0–1 |
| ripple mode | select — Isotropic / Dunes |

## 7. Erosion

| Element | Type |
|---|---|
| channel depth (m) | slider 0–3 |
| channel area | slider 50–1200 |
| channel width | slider 0–1 |
| fill depressions | toggle button |

## 8. Landmarks

| Element | Type |
|---|---|
| landmarks | slider 0–16 |
| landmark kind | select — Mixed / Plateaus / Ravines / Escarpments |
| landmark height (m) | slider 0–6 |

## 9. Terrain shading

| Element | Type |
|---|---|
| rock on slopes | slider 0–0.8 |
| channel sediment | slider 0–0.8 |
| altitude spread | slider 0–0.8 |
| Preset: eroded highlands | button |

## 10. Visuals  *(built by `bot-viewer-visuals.js`; its own `.ttl` subheads survive)*

| Element | Type |
|---|---|
| theme | select — 7 themes + Random (seeded) |
| 🎲 Roll a new look | button |
| Reset theme defaults | button |
| brightness | slider 0–3 |
| saturation | slider 0–2 |
| bloom | slider 0–3 |
| neon gain | slider 0–3 |
| fog density | slider 0–4 |
| tone map | select — agx / aces / reinhard / neutral / none |
| exposure | slider 0.2–2.5 |
| contrast | slider 0.5–2 |
| vignette | slider 0–1 |

**subhead: Visual toggles** — Sky dome · Stars · Nebula · Planet · Sun glow · Fog · Floor grid ·
Scan pulse · Neon trim · Trim travel pulse · Edge rim light · Shadows · Reflections (IBL)
*(13 toggle buttons)*

**subhead: Bot lighting**

| Element | Type |
|---|---|
| Bot glow (emissive) | toggle |
| Bot edge rim | toggle |
| Ground pools | toggle |
| Dynamic lights (flashes) | toggle |
| Coloured flashes | toggle |
| Flashlights | toggle |
| body glow | slider 0–4 |
| plate glow | slider 0–2 |
| trim glow | slider 0–4 |
| visor glow | slider 0–4 |
| visor colour | color picker |
| bot rim gain | slider 0–3 |
| pool gain | slider 0–3 |
| pool radius | slider 0.2–2 |
| flash intensity | slider 0–120 |
| flash falloff | slider 2–30 |
| flash tint | color picker |
| flash hue cycle | slider 0–2 |
| beam gain | slider 0–3 |
| beam length | slider 2–25 |
| beam angle | slider 4–40 |

**subhead: Sky detail** — star gain · star density · stars below horizon · nebula gain ·
planet size · planet azimuth · planet elevation *(7 sliders)*

## 11. Bot controls

| Element | Type | Notes |
|---|---|---|
| Spawn <team> bot | button | |
| Remove all bots (N) | button | |
| Think stagger | cycle button | Auto / Off / 1/2 / 1/3 frames — **perf** |
| Rig LOD | toggle button | **perf** |
| Flush LOD | toggle button | **perf** |
| Behind-camera cull | toggle button | **perf** |
| Body hide | cycle button | Off / 120 / 240 / 480 m — **perf** |
| Armour LOD | cycle button | Off / 15 / 25 / 40 / 60 m / Global — **perf**, changes looks |
| Spawn team | toggle button | Alpha ↔ Bravo |
| bot count | number | |
| medic % | number 0–100 | |
| sniper % | number 0–100 | |
| technical % | number 0–100 | |
| Spawn medic | button | |
| Spawn sniper | button | |
| Spawn technical | button | |
| Add <team> bots | button | |
| Add <other team> bots | button | |
| Stance | cycle button | Auto (FSM) / Stand / Crouch / Prone / Run |

## 12. Scoreboard

| Element | Type |
|---|---|
| Scoreboard HUD | toggle button |
| Reset scoreboard | button |
| score detail | readonly textarea, 12 rows |

## 13. Squads

| Element | Type |
|---|---|
| Squads | toggle button |
| squad size | number 2–SQUAD_MAX |
| formation | select — auto + formation kinds |
| spacing (m) | number 1–8 |
| Form squads from existing bots | button |
| Squad overlay | toggle button |
| squad roster | live readout list |

## 14. Sides & home bases

| Element | Type |
|---|---|
| Side mode | toggle button |
| Home base build | toggle button (disabled unless side mode) |
| Spawn near squad | toggle button |

## 15. Auto-add & corpses

| Element | Type |
|---|---|
| Auto-add | toggle button |
| Target | cycle button — Both / Alpha / Bravo |
| bots / wave | number |
| every (s) | number |
| max / team | number |
| max total | number |
| Cull bodies | toggle button |
| max corpses | number (disabled when cull off) |

## 16. Weapons & ammo

| Element | Type |
|---|---|
| Weapon | cycle button through weapon ids |
| Randomize weapons | button |
| Reload <weapon> (mag/reserve) | button |
| Auto refill on reload | toggle button |
| No ammo | toggle button |
| Sidearm | toggle button (shows drawn pistol state) |
| Knife secondary | toggle button |

## 17. Body & ragdoll

| Element | Type |
|---|---|
| Procedural body | toggle button |
| Body | cycle button — Human soldier / Armoured bot |
| Ragdoll death | toggle button |
| Blood FX | toggle button |
| Death impulse × | slider 0–3 |

## 18. Debug overlays

| Element | Type |
|---|---|
| Bot POV | toggle button |
| State orbs | toggle button |
| Sight + health visuals | toggle button |
| FOV wedge | toggle button |
| Movement debug | toggle button (master) |
| Feet | toggle button |
| Limits | toggle button |
| Turn | toggle button |
| Body motion | toggle button |
| Muzzle recovery debug | toggle button |
| Tactical nav debug (focused bot) | toggle button |
| Debug focus | button — shows focused bot id, Alt-click to set |

## 19. State recorder

| Element | Type |
|---|---|
| Record states [H] | toggle button |
| Record scope | toggle button — All bots / Focused bot |
| Live map | toggle button — BroadcastChannel to bot-trace-viewer.html |
| Motion heartbeat | cycle button — Off / N ms |
| Copy state log | button |
| Copy state-code TSV (N) | button |
| Save state-code TSV (N) | button |
| Copy fall forensics (Shift+J) | button |
| Copy live ring (focused bot) | button |
| state log | readonly textarea, 7 rows |

## 20. Movement tuning  *(9 sliders)*

Turn follow · Turn drag · Chest lead (m) · Chest follow · Run speed × · Foot width ·
Foot reach · Body bob · Body sway

## 21. Stance  *(3 toggles + 18 sliders)*

Toggles: Stance system · Allow prone · Stance height

Sliders: Crouch speed × · Prone speed × · Crouch spread × · Prone spread × · Run spread × ·
Crouch height × · Prone height × · Crouch blend (1/s) · Prone blend (1/s) · Crouch turn × ·
Prone turn × · Stand-up (ms) · Crouch-down (ms) · Prone min hold (ms) · Seek crouch radius (m) ·
Aim crouch range (m) · Seek crouch hysteresis (m) · Aim crouch hysteresis (m)

## 22. Lost-sight pursuit

| Element | Type |
|---|---|
| Sight distance | slider 4–50 |
| Field of view (deg) | slider 1–360 |
| Knife engage range | slider 1.5–15 |
| Standoff / weapon range | slider 0–0.20 |
| Kite trigger (× standoff) | slider 0.20–0.90 |
| Pursue after N misses | slider 1–10 |
| Pursue health floor | slider 0–1 |
| Flee goal memory | slider 0–8 |
| Heal threshold | slider 5–70 % |
| Drop test pack ahead of bot | button |

## 23. Aim & reaction

| Element | Type |
|---|---|
| Reaction delay | toggle button |
| Weapon spread | toggle button |
| Reaction (ms) | slider 0–1200 |
| Reaction per metre (ms) | slider 0–40 |
| Reaction cap (ms) | slider 100–2500 |
| Reaction floor (ms) | slider 0–400 |
| Alerted reaction × | slider 0.1–1 |
| Primed reaction × | slider 0.1–1 |
| Reaction jitter ± | slider 0–0.8 |
| Re-acquire grace (ms) | slider 0–2000 |
| Base spread (deg) | slider 0–4 |
| Moving spread (deg) | slider 0–10 |
| First-shot spread (deg) | slider 0–10 |
| Aim settle (ms) | slider 0–3000 |
| Recoil per shot (deg) | slider 0–2 |
| Recoil cap (deg) | slider 0–12 |
| Recoil recovery (deg/s) | slider 0–12 |

## 24. Explosives

| Element | Type |
|---|---|
| Grenades | toggle button |
| Blast FX | toggle button |
| Synth SFX fallback | toggle button |
| Restock grenades | button |
| Carried per bot | slider 0–6 |
| Throw cooldown (ms) | slider 0–30000 |
| Squad cooldown (ms) | slider 0–10000 |
| Min range (m) | slider 0–40 |
| Max range (m) | slider 5–60 |
| Friendly veto ×blast | slider 0–2 |
| Self veto ×blast | slider 0–2 |
| Cluster weight | slider 0–3 |
| Blind throw max age (ms) | slider 0–12000 |
| Min enemies (visible) | slider 1–5 |
| Explode delay (s) | slider 0.2–6 |
| Delay randomness (± s) | slider 0–2 |
| Area of impact (m) | slider 1–30 |
| Damage (centre) | slider 0–250 |
| Explosion effect size (×) | slider 0.2–3 |

*(the last 5 write into the ordnance spec, the first 10 into the throw decision)*

## 25. Bot readout  *(the only section open by default)*

Read-only rows, updated per frame: pos · onFloor · state · health · visible · last shot · aim

## 26. Dummies (WASD moves first)

| Element | Type |
|---|---|
| Spawn dummy | button |
| Remove dummy | button |
| Reset dummy | button |
| Immortality | toggle button |
| Roam dummies | toggle button |
| random count | number |
| Place random dummies | button |
| health | readout |

## 27. Nav grid (Phase 2)

| Element | Type |
|---|---|
| Toggle nav overlay | button |

## 28. Audio

| Element | Type | Notes |
|---|---|---|
| master | slider 0–1 | |
| music | slider 0–1 | |
| sfx | slider 0–1 | |
| Mute all / Unmute all | button | |
| Bot SFX | toggle button | |
| Squad chatter | toggle button | |
| Chatter voice | toggle button — radio / clean | |
| Voice source | cycle button — robot + baked TTS engines | shows load progress |
| Vocode speech | toggle button (disabled on synth voice) | |
| Death beacon | toggle button | |
| chatter vol | slider 0–1.5 | |
| chattiness | slider 0–2 | |
| reflex range | slider 3–40 | |
| reflex vol | slider 0–1.5 | |
| Reactive lights | toggle button | music-driven lighting master |
| reactive drive | slider 0–2.5 | |
| reactive target chips | 5 toggle chips | lights / bloom / map neon / bot glow / sky |
| music src | select — sfx/music/ / picked folder / sound-map events | |
| **player card** | composite | PLAY/SHUF segments, track index, source, scrolling title, 28-bar spectrum canvas, seek strip, elapsed/duration clock (click to flip remaining) |
| ⏮ / ▶⏸ / ⏭ / 🔀 | 4 transport buttons | |
| playlist | scrolling list of clickable track rows | |
| sfx folder status | readout | |
| Choose SFX folder… | button | |
| Choose music folder… | button | |

## 29. Music FX

| Element | Type |
|---|---|
| bass | slider 0–18 dB |
| echo | slider 0–100 % |
| reverb | slider 0–100 % |
| attenuation | slider 0–200 % |
| tempo | slider 50–200 % |
| pitch | slider −12–+12 st |
| music out | select — global / speaker (spatial) |
| speaker | select — front / behind / orbit / above |

---

## Observations worth carrying into the refactor

These are structural facts, not proposals.

1. **Ordering is historical, not functional.** Sections sit roughly in the order they were written.
   Terrain occupies five consecutive sections (Terrain, Landform, Erosion, Landmarks, Terrain
   shading) while Map layout and Maze structure are split for no stated reason.
2. **Bot concerns are scattered across 11 sections** (Bot controls, Scoreboard, Squads, Sides,
   Auto-add, Weapons, Body, Debug overlays, State recorder, Movement tuning, Stance, Lost-sight,
   Aim, Explosives, Dummies) with no grouping level above the section.
3. **Perf toggles live inside Bot controls**, mixed with spawn buttons: Think stagger, Rig LOD,
   Flush LOD, Behind-camera cull, Body hide, Armour LOD. They are A/B instruments, not gameplay.
4. **Debug/diagnostic controls appear in at least four places**: Camera (POV debug widgets/markers),
   Debug overlays, State recorder, Nav grid, plus the Squad overlay in Squads.
5. **Two one-click scenario presets are buried**: "Big open field" and "Test condition" sit at the
   bottom of Maze structure; "Preset: eroded highlands" at the bottom of Terrain shading.
6. **Everything is one flat list of 28 collapsible cards** with no tabs, no search, and no grouping.
   Expand-all produces a panel several screens tall.
7. **Save/load is prepended at the top** and its three slot sets take 13 controls before the user
   reaches anything they can actually change.
8. **Section defaults**: all collapsed except Bot readout, so the panel opens showing almost nothing.
9. **The toggle idiom is a button whose label carries the state** (`Rig LOD: On`), not a checkbox.
   There are no checkboxes anywhere in the panel.
10. **Sliders show their value in a right-floated span**; number fields are bare 52 px inputs.
