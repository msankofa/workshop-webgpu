# Target-confidence decay model — plan stub (2026-08-04)

**Status: stub only.** Raised in chat, not scoped. No Chapter 1 design brief, no scout, no
implementation. Written for whichever agent picks this up next to scout and design properly —
follow `docs/sonnet-code-protocol.md` from Chapter 1 rather than treating this stub as the plan.

Related: `docs/subsystems/bots.md`, `docs/subsystems/audio.md` §"Bot voices and squad chatter",
the 2026-08-03 fix in `bot-viewer-v2.html`/`environment-viewer-v2.html` that decoupled the
"contact!" voice re-arm from `MISS_STREAK_SIGHT_RESET_MS` and pointed it at `TARGET_RETAIN_MAX_MS`
instead (this stub is about going further than that fix, not undoing it).

## The question that prompted this

The "repeated contact! callout" bug (fixed 2026-08-03) was caused by a short LOS-flicker timer
being reused to gate a voice-line re-arm decision it wasn't designed for. The immediate fix reused
an existing, better-fitted constant (`TARGET_RETAIN_MAX_MS`, 6000ms). That's a reasonable v1, but
it raised a broader question: is a flat time gate the right model at all for "has this bot lost
track of the enemy," or is it a coarse proxy standing in for something that should actually be
tracked?

## Current state (as of 2026-08-03/04)

One constant, `TARGET_RETAIN_MAX_MS` (6000ms in both `bot-viewer-v2.html` and
`environment-viewer-v2.html`), currently gates three conceptually distinct decisions:

1. Whether `botTarget` (aim-lock) is retained after LOS is broken.
2. Whether `lastKnownTarget` keeps driving `BOT_SEEK` (search/investigate behavior).
3. Whether the "contact!" voice line is allowed to re-arm (post 2026-08-03 fix).

`environment-viewer-v2.html` additionally has an independently-tunable `botSeekTenacitySec` slider
(defaults to 6s) that lets #2 diverge from #1/#3 — `bot-viewer-v2.html` does not have this slider;
there, losing the target (#1) and dropping the search (#2) collapse to the same tick, gated by the
same constant. This divergence between the two "should be identical" viewers is itself worth
resolving as part of this work, not just the modeling question.

The codebase already tracks `lastKnownTargetMotion` (velocity at last sighting) per bot but does
not currently use it to influence any of the three decisions above — it's stored but not consumed
for this purpose today (verify still true before designing against it).

## The critique (why a flat timer is a weak proxy)

What all three decisions actually want to know is something like "how confident am I that the
enemy is still near where I last saw them." Time-since-last-seen is one input to that, but a flat
6-second cutoff, applied identically regardless of context, misses:

- **Target speed at last sighting.** A sprinting target could be 30+m from its last-known position
  after 6s; a crouched/stationary one could still be exactly there. `lastKnownTargetMotion` is
  already tracked and unused for this.
- **Sighting quality.** A quarter-second glimpse of movement and a 5-second locked stare both
  currently count as "acquired" the same way once they clear the acquisition bar.
- **Terrain/geometry at the break point.** Lost around a corner into another room is a different
  situation than lost in open ground, independent of elapsed time.
- **Squad corroboration.** A target "lost by me" that a teammate can still see is a different
  epistemic state than one nobody has eyes on — ally-report seeding of `lastKnownTarget` exists
  today but interacts with the timer in ways that weren't fully traced this session.
- **Synchronized give-up artifact.** Every bot that loses the same target at the same moment gives
  up at exactly the same instant (a shared hardcoded constant, no jitter), which reads as visibly
  artificial across a squad, independent of whether 6s is otherwise "correct."

## Directions worth scouting (not decided, not compared against each other yet)

- **Decaying confidence value** per bot-target pair, initialized on acquisition, decaying over
  time at a rate influenced by `lastKnownTargetMotion` (faster decay for a target that was moving
  fast) — replacing the flat cutoff with a threshold crossing on a curve instead of a fixed clock.
- **Spatial give-up condition** in addition to (or instead of) a pure timer: search ends when the
  bot physically reaches the last-known position and finds nothing, not (only) when a duration
  elapses.
- **Splitting the three consumers onto different curves/thresholds** instead of one shared
  constant — aim-lock decaying fastest, search persistence scaling with last-known speed and
  terrain, voice re-arm keyed off a genuine identity/re-acquisition event rather than duration at
  all.
- **Per-bot jitter** on whatever the final threshold/curve is, purely to break the synchronized-
  squad-give-up artifact, independent of whether the underlying model changes.

## Explicitly open, not pre-decided

- Whether this is worth the complexity at all versus tuning the existing flat constant(s) — a real
  product call, not just an engineering one.
- Whether `environment-viewer-v2.html`'s `botSeekTenacitySec` slider should be ported into
  `bot-viewer-v2.html`, removed from `environment-viewer-v2.html`, or superseded entirely by
  whatever model comes out of this work.
- Whether ally-report/squad corroboration should factor into confidence, and how it currently
  interacts with `lastKnownTarget` (only partially traced this session — needs a fresh read of the
  report-seeding code path in both viewers before designing against it).
- Scope: aim-lock, search persistence, and voice re-arm may not all need to move off a timer at
  once — could ship as separable, sequenced changes.

## Next step for whoever picks this up

Start at Chapter 1 of the protocol: confirm the claims above against current code (this stub is a
chat-derived summary, not a verified scout pass), then scope which of the three consumers is worth
touching first.
