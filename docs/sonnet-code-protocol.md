# Sonnet code protocol

How Claude should run a non-trivial feature request in this repo, from "I want X" to shipped code.
Established during the bot-trace-viewer heatmap-layers / notes-panel / stamp-button work
(2026-08-02). Not a replacement for the workshop-webgpu `CLAUDE.md` conventions (snapshot to
`versions/`, update the subsystem doc, append `agent_log.csv`, `node --check`) — this is the
process that runs *before* those, deciding what gets built and whether it's sound.

## When this applies

Any request with real design surface: new UI, new persistence, new interaction model, anything
that touches more than a couple of functions. Skip all of this for genuine one-liners and
mechanical fixes — the phases are overhead the task has to earn.

## The five phases

Each phase ends when the user says a trigger word. Don't advance on your own inference — advance
on the word.

1. **Design ("tell me first" / any open design ask).** Produce a design, not code. Ground it in
   the real files first (read the actual functions/routes/structures you're proposing to touch —
   don't design from memory or assumption). State inputs, UI shape, and explicitly walk the
   [standards checklist](#the-standards-checklist) against this specific feature. If a criterion
   doesn't apply, say so — that's a finding too, not a gap.
2. **Compatibility.** If the user flags forward-compatibility explicitly, treat it as a request to
   phrase every design claim as what *will* hold once built, not what already holds — and to
   double-check each claim against the current code rather than asserting it.
3. **Scout ("scout" / "scout your assumptions").** Two agents independently explore the idea —
   ground the design's claims against the real codebase and platform behavior, and surface anything
   relevant they find. They report back *information*, not a verdict on the design — they are not
   asked to approve or reject it, just to bring back what's actually true. **Once both return, I
   form the plan**: fold their findings into the design, correcting anything the initial pass got
   wrong. This is a distinct sub-step, not automatic — the plan is the design *as revised by what
   scouting found*, and it's what gets shown next, before critique runs against it.
4. **Critique ("critique").** A separate stage that runs against **the plan** (the scout-revised
   version), not the original design — two independent, adversarial reviewers try to find fault with
   it and break it, not to fact-check it (that already happened in Scout). Once both return, **I
   revise the plan again**, folding in whatever critique findings survive. "scout critique" run
   together as one combined trigger means: run Scout, form the plan, then run Critique against that
   plan, then revise it again — the full pipeline, still ending in a plan for me to show before any
   code is written.
5. **Begin ("begin").** Only now write code — implementing the final, twice-revised plan. Snapshot
   first, then implement, then the required doc/log/syntax steps from `CLAUDE.md`.

If the user substantially changes the feature's scope mid-design (not a tweak — a different
shape), redo phase 1's checklist against the new shape before continuing. Don't quietly patch the
old checklist; a scope change can invalidate findings that looked settled.

## The standards checklist

Walk all eleven for every design, even the ones that end up not applying:

1. **Backup first.** Snapshot every file about to change to `versions/` before editing.
2. **Reuse existing idioms over inventing new ones.** Same helpers, same CSS classes, same route
   family, same click-delegation pattern already in the file — new code should be unable to tell
   apart from old code by style.
3. **Cost-aware architecture.** Separate anything expensive from anything cheap; cache each
   independently so a cheap interaction never re-triggers an expensive one. State explicitly when
   this doesn't apply (not every feature has an expensive part) rather than forcing a cache split
   that isn't earning its complexity.
4. **DOM update discipline.** Never let a periodic rebuild (draw loop, table re-render, per-frame
   update) destroy an in-progress user interaction — a drag, a selection, a focused input, typed
   text. Identify every rebuild trigger the new feature's state has to survive, and how.
5. **Stable identity for anything ordered, persisted, or selected.** Monotonic IDs or real data
   keys, never array indices or raw DOM references — those don't survive add/remove/reorder/rerender.
6. **Purely additive compatibility.** New code hooks into existing reset/lifecycle points the same
   way existing features already do (same function, same call site pattern), and touches nothing
   else. If it must diverge from an existing pattern, say why in a comment at the divergence point.
7. **Zero new dependencies.** This codebase has no bundler; everything is vanilla DOM/JS (or, for
   `serve.py`, stdlib only).
8. **`node --check` (or `python -m py_compile`) is the only available syntax gate.** No test
   framework covers the HTML/JS files. Run it against the actual final state, after every edit
   that touches the module script, not just once at the end.
9. **Doc + `agent_log.csv` update in the same change.** Per `CLAUDE.md`: subsystem doc first
   (fix drift, don't just append), then one append-only log row.
10. **No Chrome-driven self-QA.** Hand it back to the user to try in the browser. Don't claim
    "browser QA pending" or tell them to go test it — their trying it *is* the QA step.
11. **Scout/critique risky claims before implementing**, not after. A claim about a browser API's
    support/deprecation status, an assumption about how existing code behaves, a performance
    assumption — anything asserted from memory rather than verified against the real file or
    platform docs is a candidate.

## Scout dispatch mechanics

- Two agents (`Agent` tool, `model: "haiku"`, `subagent_type: "Explore"`, `run_in_background: false`
  for synchronous, directly-comparable results). Cheap and fast — this stage is reconnaissance, not
  judgment, so a lighter model is the right tool.
- **Identical prompts, no per-agent differentiation.** Same self-contained brief to both — file
  paths to read, the full proposed design, what to explore/verify. Do not tailor one agent's scope
  differently from the other's, and do not hand out a curated checklist of the two or three things
  you're worried about — that substitutes your judgment about what's risky for theirs and narrows
  what an independent pass can catch. State the design in full and let each agent use its own
  judgment about what's worth surfacing.
- Each agent reads the real files (not take the brief's claims on faith) and reports back findings —
  what's true, what's missing, what exists that the design didn't account for. Not a verdict.
- The two agents are redundancy, not division of labor: two independent passes over identical
  instructions catch more than one pass would, and where they disagree is itself signal.
- **After both return, I form the plan** — fold the findings into the design myself, resolving every
  factual gap they surfaced. Don't bounce a finding back to the user as another open question unless
  it's a genuine product decision (not an engineering one) that only the user can make.

## Critique dispatch mechanics

- Runs against **the plan** produced above, not the original design — this stage assumes the facts
  are already right (Scout's job) and instead attacks the plan's decisions.
- Two agents, `model: "sonnet"` (or the session's default reasoning model) — deliberately *not*
  haiku. Finding a real weakness in a plan takes stronger reasoning than fact-checking claims does.
- **Adversarial framing.** Each critic is briefed to try to refute or break the plan — assume it's
  wrong and argue against it — not to give a balanced review. Same identical-brief, no-per-agent-
  differentiation rule as Scout: both critics get the full plan and the same instruction to attack
  it, independently.
- **After both return, I revise the plan again** — resolve every surviving finding myself the same
  way as after Scout, then show the revised plan before writing any code (`begin` is the only trigger
  that starts implementation).

## Reference

Lived examples of this protocol's output: `docs/subsystems/bot-state-codes.md`'s Heatmaps, Notes,
and Stamping sections, and the `versions/bot-trace-viewer-before-*` /
`versions/serve-before-*` snapshots from the same changes.
