# bot-viewer-v2 panel — proposed structure (for approval)

Merged from proposals A/B/C plus the user's decisions on 2026-08-06:
roster-first ordering · 6 tabs · Session first · Dummies last · pinning included.

Status: **APPROVED 2026-08-06.** No open items. This is the target structure to build against.

---

## Pinned chrome — always visible, above the tab strip

| Element | Source | Note |
|---|---|---|
| Panel title + expand-all / collapse-all / hide | existing | expand/collapse now scope to the active tab |
| Search box | new | substring match over section + control labels, all tabs; a hit switches tab, expands the card, opens its advanced disclosure |
| ★ pinned drawer | new | slim row of pinned cards; star icon in every `.sec-head`; persisted in the `ui` slot |
| Camera mode strip | from §2 Camera | Orbit / Follow / POV / Fly — one row, 4 buttons, no card |
| Compact-density toggle | new | one class on the panel root |
| **Bot readout** | §25, unchanged | pinned, **collapsed by default** |

`Frame followed bot` / `Follow nearest bot` are not pinned; they have hotkeys (`F`, `]`) and
live in the Session tab's camera card.

---

## Tab 1 — SESSION

### cluster: SAVE STATE
**Card: Save / load** *(was §1)*
- maze — slot picker, name field, Save / Load / ✕, status line
- bots — slot picker, name field, Save / Load / ✕, status line
- ui — slot picker, name field, Save / Load / ✕, status line
- Export layout JSON *(demoted to a small footer link, not a full-width button)*

### cluster: CAMERA
**Card: Framing & follow** *(from §2)*
- framing (select) · view distance (m)
- Frame followed bot · Follow nearest bot
- Auto rotate (orbit) · Auto follow bots · Occlusion guard (follow)

**Card: POV & fly** *(from §2)*
- POV comfort (select) · POV eye up/down (m) · POV eye forward (m) · Target diamond size
- POV recenter · POV recenter delay (s) · Recenter POV now
- fly mode: Walk ground / Free flight · fly speed (m/s)

---

## Tab 2 — BOTS  *(default active tab)*

### cluster: ROSTER & SPAWN
**Card: Spawn & composition** *(was §11 Bot controls, minus the 6 perf toggles)* — **expanded on load**
- Spawn team (Alpha ↔ Bravo) · Spawn `<team>` bot · bot count
- Add `<team>` bots · Add `<other team>` bots
- medic % · sniper % · technical %
- Spawn medic · Spawn sniper · Spawn technical
- Stance override (Auto / Stand / Crouch / Prone / Run)
- Remove all bots (N)

**Card: Squads** *(was §13, minus Squad overlay → Debug)*
- Squads · squad size · formation · spacing (m) · Form squads from existing bots · squad roster readout

**Card: Sides & home bases** *(was §14, unchanged)*
- Side mode · Home base build · Spawn near squad

**Card: Auto-add & corpses** *(was §15, unchanged)*
- Auto-add · Target · bots / wave · every (s) · max / team · max total · Cull bodies · max corpses

### cluster: LOADOUT
**Card: Weapons & ammo** *(was §16, unchanged)*
- Weapon · Randomize weapons · Reload · Auto refill on reload · No ammo · Sidearm · Knife secondary

**Card: Body & ragdoll** *(was §17, unchanged)*
- Procedural body · Body (soldier / armoured) · Ragdoll death · Blood FX · Death impulse ×

**Card: Explosives** *(was §24)*
- Grenades · Blast FX · Synth SFX fallback · Restock grenades
- Carried per bot · Min range (m) · Max range (m) · Throw cooldown (ms) · Squad cooldown (ms)
- Friendly veto ×blast · Self veto ×blast · Cluster weight · Blind throw max age · Min enemies (visible)
- *ordnance spec:* Explode delay (s) · Delay randomness (± s) · Area of impact (m) · Damage (centre) · Explosion effect size (×)

### cluster: AI TUNING
**Card: Movement tuning** *(was §20, unchanged — 9 sliders)*
- Turn follow · Turn drag · Chest lead · Chest follow · Run speed × · Foot width · Foot reach · Body bob · Body sway

**Card: Stance** *(was §21)*
- Stance system · Allow prone · Stance height
- Crouch speed × · Prone speed × · Crouch spread × · Prone spread × · Run spread ×
- Crouch height × · Prone height ×
- Crouch blend · Prone blend · Crouch turn × · Prone turn × · Stand-up (ms) · Crouch-down (ms) · Prone min hold (ms) · Seek crouch radius · Aim crouch range · Seek crouch hysteresis · Aim crouch hysteresis

**Card: Lost-sight pursuit** *(was §22, unchanged)*
- Sight distance · Field of view · Knife engage range · Standoff / weapon range · Kite trigger
- Pursue after N misses · Pursue health floor · Flee goal memory · Heal threshold · Drop test pack ahead of bot

**Card: Aim & reaction** *(was §23)*
- Reaction delay · Weapon spread
- Reaction (ms) · Base spread (deg) · Moving spread (deg) · First-shot spread (deg) · Aim settle (ms) · Recoil per shot (deg)
- Reaction per metre · Reaction cap · Reaction floor · Alerted reaction × · Primed reaction × · Reaction jitter ± · Re-acquire grace · Recoil cap · Recoil recovery

### cluster: RESULTS & TEST AIDS
**Card: Scoreboard** *(was §12, unchanged)*
- Scoreboard HUD · Reset scoreboard · score detail textarea

**Card: Dummies** *(was §26 — last card in the tab, per "never really used now")*
- Spawn dummy · Remove dummy · Reset dummy · Immortality · Roam dummies · random count · Place random dummies · health readout

---

## Tab 3 — WORLD

**Presets strip** *(plain button row at the top, no card)*
- Big open field *(promoted from §4)* · Test condition *(promoted from §4)* · Preset: eroded highlands *(promoted from §9)*

### cluster: LAYOUT & STRUCTURE
**Card: Map layout** *(§3 + §4 merged into one card)*
- Rooms layout · Maze layout (new) / Open layout (new) · keep bots on rebuild
- cols × rows · seed + 🎲 · hall width (m) · wall thickness (m) · wall height (m)
- walls (Maze corridors / Perimeter only / None) · start/goal · perimeter entrances
- loop chance · straightness · braid (kill dead-ends)
- open rooms · room count · room size (cells)
- cover pieces · cover density · cover height (m)
- structures · structure count · structure spacing (m) · structure mix

**Card: Scene shuffle** *(pulled out of §3 Map layout)*
- Auto scene shuffle · Shuffle look too · shuffle every (s) · Shuffle scene now

### cluster: TERRAIN GENERATION  *(pipeline order, unchanged)*
**Card: Terrain** *(was §5)* — uneven ground · level pads · seed + 🎲 · hill height · hill scale · hill detail · ripple height · ripple scale · grain · mesh cell · max walk slope · pad blend

**Card: Landform** *(was §6)* — landform · warp · warp scale · terrace steps · terrace sharpness · ripple mode

**Card: Erosion** *(was §7)* — channel depth · channel area · channel width · fill depressions

**Card: Landmarks** *(was §8)* — landmarks · landmark kind · landmark height

**Card: Terrain shading** *(was §9, minus its preset)* — rock on slopes · channel sediment · altitude spread

---

## Tab 4 — DEBUG & PERF

### cluster: PERFORMANCE
**Card: Perf / LOD** *(new — the 6 toggles pulled out of §11 Bot controls)*
- Think stagger · Rig LOD · Flush LOD · Behind-camera cull · Body hide · Armour LOD
  *(Armour LOD keeps a note that it also changes how bots look)*

### cluster: OVERLAYS
**Card: Debug overlays** *(was §18, now the single home for every overlay toggle)*
- Bot POV · State orbs · Sight + health visuals · FOV wedge
- Movement debug · Feet · Limits · Turn · Body motion
- Muzzle recovery debug · Tactical nav debug (focused bot) · Debug focus
- **POV debug widgets** *(moved from §2 Camera)* · **POV debug markers** *(moved from §2 Camera)*
- **Squad overlay** *(moved from §13 Squads)*
- **Nav overlay** *(§27 dissolved — the whole section was one button)*

### cluster: CAPTURE
**Card: State recorder** *(was §19, unchanged)*
- Record states [H] · Record scope · Live map · Motion heartbeat
- Copy state log · Copy state-code TSV · Save state-code TSV
- Copy fall forensics (Shift+J) · Copy live ring (focused bot) · state log textarea

---

## Tab 5 — VISUALS  *(§10 split into 4 cards, using the subheads already in the DOM)*

**Card: Look & post** — theme · 🎲 Roll a new look · Reset theme defaults · brightness · saturation · bloom · neon gain · fog density · tone map · exposure · contrast · vignette

**Card: Visual toggles** — Sky dome · Stars · Nebula · Planet · Sun glow · Fog · Floor grid · Scan pulse · Neon trim · Trim travel pulse · Edge rim light · Shadows · Reflections (IBL)

**Card: Bot lighting** — Bot glow · Bot edge rim · Ground pools · Dynamic lights · Coloured flashes · Flashlights · body/plate/trim/visor glow · visor colour · bot rim gain · pool gain · pool radius · flash intensity · flash falloff · flash tint · flash hue cycle · beam gain · beam length · beam angle

**Card: Sky detail** — star gain · star density · stars below horizon · nebula gain · planet size · planet azimuth · planet elevation

---

## Tab 6 — AUDIO

**Card: Mixer & voices** *(from §28)*
- master · music · sfx · Mute all
- Bot SFX · Squad chatter · Chatter voice · Voice source · Vocode speech · Death beacon
- chatter vol · chattiness · reflex range · reflex vol

**Card: Music player** *(from §28)*
- music src · player card (segments, title, spectrum, seek, clock) · ⏮ ▶⏸ ⏭ 🔀 · playlist · sfx folder status · Choose SFX folder… · Choose music folder…

**Card: Reactive lighting** *(from §28)*
- Reactive lights · reactive drive · 5 target chips (lights / bloom / map neon / bot glow / sky)

**Card: Music FX** *(was §29, unchanged)*
- bass · echo · reverb · attenuation · tempo · pitch · music out · speaker

---

## Defaults

- Active tab on load: **Bots**.
- Expanded on load: **Spawn & composition** only. The pinned Bot readout starts collapsed, as does
  every other card in every tab.
- Expand-all / collapse-all scope to the active tab plus the pinned chrome.
- The `ui` save slot gains two fields: active tab, and the pinned-card list.

## Card count

29 sections today → **34 cards** across 6 tabs, plus the pinned Bot readout.
The count goes up, not down: the win is that no tab shows more than 13 cards at once, where today
one list holds all 29.

- Dissolved: Nav grid (1 button) into Debug overlays.
- Merged: Map layout + Maze structure into one card.
- Split: Visuals → 4, Camera → 2 + a pinned strip, Audio → 3 + Music FX.

Per tab: Bots 13 · World 7 · Session 3 · Debug 3 · Visuals 4 · Audio 4.

## Decisions log — 2026-08-06

- Roster-first ordering in the Bots tab (setup before tuning), over frequency-first.
- Six tabs, Session first in the strip.
- Camera mode buttons, search, ★ drawer and the Bot readout pinned above the tabs.
- Bot readout **collapsed** on load. Only Spawn & composition is expanded.
- Scene shuffle lives in **World**, not Session.
- Map layout and Maze structure **merge into one card**.
- Dummies last in the Bots tab — rarely used now.
- Pinning/favourites included in this pass, not deferred.
- **No advanced disclosures.** Every slider in Stance, Aim & reaction and Explosives stays visible.
  Hiding a third of them would trade discoverability for scroll length the tabs already recovered;
  a per-card disclosure stays available later if one card proves unusable in practice.
- Toggle idiom unchanged — buttons keep carrying their state in the label. All three proposals
  independently declined to switch to checkboxes.

## Not covered by this document

Implementation sequencing, and whether the tab bar reuses `environment-ui.js`'s `.wui-tabs` markup
or gets its own. `createSection(host, title, opts)` already accepts an arbitrary host, so each tab
body is just a different host — no change needed to `workshop-panel-theme.js` itself. Only the
expand/collapse-all header buttons need a narrower host passed in.
