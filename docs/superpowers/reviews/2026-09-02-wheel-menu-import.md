# Importing environment-viewer's tool wheel into base-game's dev gun

Review only — no code changed. Motivated by the user's complaint about the dev gun (key 9): "way
too hard to get out of it, or tell what you are trying to place... several times I've tried to
switch back to shooting and it spawns another sentinel." This asks whether `environment-viewer.html`'s
radial/wheel tool picker is a good replacement, and if so, how to bring it over.

## What the wheel menu actually is

It is entirely inline in `environment-viewer.html`. It is **not** a module: a repo-wide grep for
`toolRadial` returns only `environment-viewer.html`, the frozen `environment-viewer-v2.html` (which
carries its own copy, presumably duplicated before the freeze), and `_check_environment-viewer-v2.html.mjs`
(a generated check file). No `.js`/`.mjs` file owns any part of it.

Total surface is small, about 70 lines, in two neighborhoods of the file:

- **Definition, state, and lifecycle** — `environment-viewer.html:7201-7260`:
  - `toolRadial` (`:7201-7204`) — a plain `position:fixed` DOM div, `z-index:70`, `pointer-events:none`
    on the container (each generated button opts back in with `pointer-events:auto`).
  - `toolRadialOpen`, `radialMoveX`, `radialMoveY` (`:7205-7206`) — the only state.
  - `renderToolRadial()` (`:7207-7223`) — rebuilds the DOM every open/redraw: one absolutely-positioned
    `<button>` per option, placed on a circle of radius 92px via `cos/sin`, the currently-selected one
    given a gold border. Each button's own `mousedown` commits immediately (`:7220`).
  - `openToolRadial()` (`:7224-7230`) — sets `toolRadialOpen = true`, seeds `selectedRadialTool` to the
    player's current tool, zeroes the accumulated mouse delta, shows the div, renders.
  - `updateToolRadialByMovement(e)` (`:7231-7243`) — accumulates `movementX/movementY` into
    `radialMoveX/Y`; below 14px of accumulated distance nothing happens (dead zone so a light touch
    doesn't jump the selection); above it, `atan2` on the accumulated vector picks a slice index into
    `toolOptions()`, proportional to slice count, and re-renders.
  - `closeToolRadial(commit)` (`:7244-7250`) — hides the div; if `commit` is true, calls
    `selectLocalTool(selectedRadialTool)`.
  - `selectLocalTool(toolId)` (`:7251-7260`) — the one and only place tool selection is applied
    (`setPlayerTool`, `setPlayerWeapon`, view-hand/weapon-view sync, HUD refresh). A repo grep shows
    it has no other caller — in this app the wheel is the **only** way to switch tools; there is no
    hotbar/number-key alternative to fall back on.
  - Item source: `toolOptions()` (`:7137-7139`) — `[{ id, label }, ...]`, one entry for the light gun
    plus one per enabled weapon. Flat. There is no nesting or sub-menu anywhere in this code.

- **Input wiring**, folded into the page's big shared listeners rather than owned by the wheel:
  - Open on `KeyE` keydown while in FPS mode (`:8335-8338`).
  - Commit-and-close on `KeyE` keyup (`:8400-8403`) — so the gesture is *hold E, look toward a wedge,
    release E*, not click-to-open/click-to-close.
  - `mousemove` routes to the wheel instead of look whenever it's open (`:8288-8289`); look resumes
    the instant it's closed.
  - Left `mousedown` is a no-op while the wheel is open (`:8417`, `if (!fpsMode || toolRadialOpen) return;`).
  - `exitFPS()` force-cancels an open wheel (`closeToolRadial(false)` at `:8234`) so leaving first
    person always drops it rather than leaving it stuck open.

Mechanics, restated plainly: **E is held down**, not toggled. Releasing E without moving the mouse
re-commits whatever was already selected (a safe no-op), so there is effectively always a way out
that isn't "keep pressing until you land on off" — because there is no "off": the wheel always shows
your current live options and defaults to your current tool.

Pointer lock is never released. The wheel reads the same `movementX/movementY` deltas FPS look
already consumes; it just intercepts them while open (`:8289`) instead of applying them to camera
yaw/pitch, then hands the mousemove listener back once closed. Nothing about it fights pointer lock.

## What it would replace in base-game.html

- `devGun` state object (`base-game.html:1707-1713`): `active`, `tool` (`bots`/`lights`/`vehicles`/
  `sentinel`), `side`, `roleIndex`, `clickEdge`, `chargeStartMs`, `fireRatio`, `dropEdge`,
  `sentinelPreset`, `note`/`noteUntil`.
- `cycleSpawner()` (`:1716-1720`) — the bots tool's R-cycle, and it's two levels deep in one key: role
  advances first, side only flips once role wraps around. 5 roles (`BASE_GAME_NPC_ROLE_IDS`,
  `base-game-protocol.mjs:627`) × 2 sides = 10 reachable combinations, none visible except in the HUD text.
- `devLightCycleKind()` (`:1917-1920`) — R-cycle through `DEV_LIGHT_KIND_ORDER` (4 named presets:
  lantern/ember/floater/flare, `:1906-1911`) plus an implicit `custom` (reached only by touching a
  slider, `:3418-3423`).
- The sentinel preset toggle, inline in the `KeyR` handler (`:4958`) — low/high, not its own function.
- `Digit9` keydown handler (`:4961-4968`) — the blind top-level cycle: off → bots → lights → vehicles
  → sentinel → off. Also force-selects weapon slot 1 whenever devGun turns on (`:4967`,
  "the sidearm carries the laser").
- `devGunHudLine()` (`:1748-1760`) — the **only** visible state: one text line folded into the corner
  combat HUD's `innerHTML` (`:2501`, `#combat` div, styled at `:17-23`). This is the whole problem
  surface: a small line of white monospace text the player has to read and parse every time, easy to
  miss mid-fight.
- Click routing: `mousedown`/`mouseup` special-case `devGun.active` (`:5010-5027`) to feed
  `chargeStartMs`/`clickEdge` instead of `weaponState.firing`; the per-tick dispatcher
  (`:5552-5557`) turns those into `spawnerPlace()` / `devLightFire()` / `devLightDrop()`.
- **The exact bug the user is describing**: fire is gated as `fire: weaponState.firing && !devGun.active`
  (`:5552`). While `devGun.active` is true, in *any* tool including `sentinel`, left-click never reaches
  the weapon — it always calls `spawnerPlace()`. Getting back to "off" costs up to four `Digit9`
  presses, the only feedback is that one HUD line, and `sentinel` is the tool right before off. A
  player who miscounts, or isn't looking at the corner text, clicks one press early and spawns a
  sentinel instead of firing. That is the reported symptom, not a separate bug.

## Import strategy

**Extract into a shared module.** Not a copy, and not "leave it in environment-viewer.html and call
into it" (that would make base-game.html depend on a page, not a library). Two things point at
extraction specifically:

1. Base-game.html already has the exact precedent: `base-game-menu.mjs` (imported at `:131`) holds the
   pause and start-screen overlays as `createBaseGamePauseMenu({ onResume, onSettings, ... })` →
   `{ get open(), show(label), hide(), destroy() }`, and `showBaseGameStartMenu({ connect, ... })`.
   Same shape of problem: a DOM overlay, driven by callbacks, installed once (`installStyles()` with an
   idempotency guard) and instantiated per page. The wheel should follow that same convention, not a
   new one.
2. The wheel has no game-specific coupling once `toolOptions()`/`selectLocalTool()` are pulled out as
   caller-supplied callbacks — everything else (`renderToolRadial`, `openToolRadial`,
   `updateToolRadialByMovement`, `closeToolRadial`) is generic circle-layout-and-mouse-delta code.

Proposed file: **`wheel-menu.js`**, at the repo root next to `base-game-menu.mjs`. Proposed API,
concrete enough to implement without re-deciding it:

```js
export function createWheelMenu({
  getOptions,       // () => [{ id, label, sublabel? }]   called fresh on every open/redraw
  getActive,        // () => id                            pre-selected wedge when opened
  onCommit,         // (id) => void                        called once, on a successful close
  onOpen,           // () => void                          optional
  onCancel,         // () => void                          optional, called on a cancelled close
  radius = 92,      // px, wedge placement radius
  moveThreshold = 14, // px of accumulated pointer delta before the wheel starts tracking direction
} = {}) {
  // returns:
  // { open(), close(commit), isOpen, get selected(), handleMouseMove(e), destroy() }
}
```

`open()`/`close(commit)`/`handleMouseMove(e)` map 1:1 onto today's `openToolRadial`/`closeToolRadial`/
`updateToolRadialByMovement`; `isOpen` replaces the free `toolRadialOpen` global so two independent
wheel instances (one per page, or even two per page) don't collide. `getOptions`/`getActive`/`onCommit`
replace `toolOptions`/`toolIdFor(localPlayerId())`/`selectLocalTool` as constructor-time callbacks.
`sublabel` is new (see "what has to be invented" below) — optional, so the straight port for
environment-viewer needs none of the base-game additions.

Steps, in order:

1. Write `wheel-menu.js` by moving the bodies of `renderToolRadial`, `openToolRadial`,
   `updateToolRadialByMovement`, `closeToolRadial` (`environment-viewer.html:7201-7250`) into
   `createWheelMenu()`, parameterized as above. Keep the DOM/CSS approach (plain absolutely-positioned
   buttons on a circle) — it already themes cleanly and needs no canvas/WebGPU work.
2. In `environment-viewer.html`, replace that block with
   `const toolWheel = createWheelMenu({ getOptions: toolOptions, getActive: () => toolIdFor(localPlayerId()), onCommit: selectLocalTool });`
   and rewire the five call sites (`:8288-8289` mousemove, `:8335-8338` open, `:8400-8403` close-commit,
   `:8417` click-suppress, `:8234` exitFPS cancel) to `toolWheel.handleMouseMove/open/close/isOpen`.
   This is a pure refactor of an already-shipped page — verify by eye there is no behavior change
   before moving on; there is no headless test for this input loop (see Risks).
3. In `base-game.html`, `import { createWheelMenu } from './wheel-menu.js'` and instantiate a second,
   independent wheel for the dev gun. Its `getOptions()` returns the flattened top-level item list
   (see below), `onCommit` writes `devGun.active`/`devGun.tool` and does the slot-1 force-select that
   `:4967` does today.
4. Keep `KeyR` and its three existing per-tool cycle functions (`cycleSpawner`, `devLightCycleKind`,
   the sentinel toggle) exactly as they are for the **sub**-option within a tool. The wheel replaces
   only the top-level `Digit9` cascade, not the R-cycle — see the flattening decision below.
5. Rebind the wheel's open gesture to **`Digit9` held down** rather than a fresh key. `Digit9` is
   already free of collision with weapon slots (`SLOT_KEYS` only spans `Digit1`-`Digit7`, from
   `BASE_GAME_WEAPON_SLOTS` in `base-game-protocol.mjs:40`, seven entries), so this reuses muscle
   memory the user already has instead of asking them to learn a new key. `KeyE` — the wheel's key in
   environment-viewer — is unavailable in base-game: it already means "drop a light" while the lights
   tool is active and "drone seat toggle" otherwise (`:4978-4981`).
6. Add an explicit **off** wedge to the flattened item list (`{ id: 'off', label: 'Weapon' }`), so
   leaving the dev gun is one visible pick, not a counted sequence of presses. `onCommit` treats
   `'off'` as `devGun.active = false` and leaves everything else untouched.
7. Once implemented, update `docs/subsystems/base-game.md` (the dev gun's home doc — confirmed by
   grep alongside `docs/superpowers/plans/2026-09-01-base-game-dev-gun-lights.md` and
   `docs/superpowers/specs/2026-09-01-base-game-drone-lights-design.md`) and append a row to
   `agent_log.csv`, per this directory's `CLAUDE.md`. Not done here since this review changes no code.

## What has to be invented

Kept short by reusing the R-cycle rather than trying to fit two levels of state into one wheel.

- **The flattening decision itself.** The wheel's item model is flat (`toolOptions()` returns one
  array, no nesting exists anywhere in the source). Rather than inventing nested wheels, the top-level
  wheel should show four wedges — `Bots`, `Lights`, `Vehicles`, `Sentinel` — plus the new `Weapon`
  (off) wedge, and leave `R` to keep cycling the sub-option inside whichever tool is picked, exactly as
  today. This is a design choice this review is making explicitly so a later agent doesn't have to
  re-decide it or invent nested-wheel support that doesn't exist anywhere in this codebase (checked:
  no other page in this repo has a nested/sub-wheel to copy from).
- **A `sublabel` line on each wedge**, e.g. "Bots — enemy rifleman" / "Lights — lantern", so the R-cycle
  target is visible without pressing R blind first. Today's `renderToolRadial` sets
  `btn.textContent = opt.label` only (`:7217`), a single line. `devGunHudLine()` (`:1748-1760`)
  already computes this exact text per tool, so this is threading an existing string into a second
  `<span>` under the label, not inventing new derivation logic.
- **The `off`/`Weapon` wedge.** Environment-viewer's `toolOptions()` never needs a "none" entry
  because the player always holds either the light gun or a weapon. Base-game's dev gun has a genuine
  off state that has no counterpart in the source list; it needs its own id and a one-line check in
  `onCommit`.
- **A mousemove-priority guard in base-game.html.** Environment-viewer has exactly one `mousemove`
  listener to gate (`:8288`). Base-game has at least two live at once during play — the general look
  handler (`:5048-5053`) and, while piloting a drone, the missile-sensor slew handler
  (`:5041-5046`, `{ capture: true }`). Both need `if (toolWheel.isOpen) return;` (or equivalent) added
  ahead of their existing early-outs so the wheel wins whichever is currently attached. This is wiring,
  not new mechanics, but it's wiring the source didn't need because it only had one listener.

Everything else — circle layout, dead-zone/threshold math, DOM button styling, hold-to-open/
release-to-commit gesture, pointer-lock compatibility — carries over unchanged.

## Risks and open questions

- **Unverified in a browser.** Per this repo's convention, tools don't drive Chrome to check renders;
  the user tests in-browser. The 92px radius and 14px move-threshold were tuned for
  environment-viewer's mouse feel (`fp.sensitivity`); base-game has its own look-sensitivity scaling
  (`settings.cameraSensitivity`, seen at `:5043`) which may need the wheel's constants retuned, or
  made to scale with the same sensitivity setting. Not something source-reading settles.
- **Does the sub-option also need to be on a wheel?** This review recommends keeping `R` for the
  bots/lights/sentinel sub-cycle and only replacing the top-level `Digit9` cascade with the wheel. That
  fixes the reported bug (can't tell what tool you're on, can't get out of it) but leaves a smaller,
  same-shaped problem one level down — the user still won't see "medic" vs "rifleman" without holding
  `R` and reading the HUD line (mitigated some by the `sublabel` addition above, but not to the same
  degree the wheel fixes the top level). Worth confirming with the user whether that's an acceptable
  scope cut before implementing, rather than assuming it.
- **No headless safety net.** Both pages' pointer-lock input loops are DOM/canvas-driven with no Node
  test harness (unlike, say, `port-creature-system.js`, which is deliberately headless-testable). An
  implementation of this plan can't get a `node test-*.mjs` regression check for the wheel's open/
  commit/cancel edge cases — only manual browser QA closes that gap.
- **`environment-viewer-v2.html` carries its own copy** of the same inline block (confirmed by the
  `toolRadial` grep). Extracting `wheel-menu.js` out of the live `environment-viewer.html` doesn't
  automatically fix v2's copy; whether v2 (frozen, per the same convention used elsewhere in this repo
  for frozen snapshots) should be left alone or also migrated wasn't investigated here and should be a
  deliberate call, not a byproduct.
