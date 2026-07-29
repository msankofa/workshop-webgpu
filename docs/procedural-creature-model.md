# The Procedural Creature Model

*Written in plain language, following ISO 24495-1. Companion diagram: `creature-model.html`
at the repo root.*

## Who this document is for

This document is for anyone who:

- works on the bots in `bot-viewer-v2.html`, or
- plans to build new creature types (for example a dog, a bird, or a fish) on the same code.

## What this document explains

It names the four parts of a procedural creature, shows how they work together, and states
the one design rule that keeps the code healthy.

## What a procedural creature is

A procedural creature is a creature that code defines completely. Variable values decide its
appearance, its actions, its states, and how it responds to its environment. Change the values
and you get a different creature.

The creature you see is the result of all its variables acting together. In that sense, every
variable relates to every other variable. But the code must not tangle them together. Keep each
variable independent in the code. Let the connections appear only in the creature on screen.

## The four parts

### Body: structure and movement

The body is the creature's structure plus its movement machinery.

- Structure: which parts exist, how they connect, and their proportions.
- Movement machinery: gait, inverse kinematics (IK), stepping, stance, and balance.

The body moves itself. Give it a destination, and it works out the limbs on its own. The mind
never controls the knees.

### Mind: the state machine

The mind holds the creature's current intent: patrol, flee, pursue, or help a wounded ally.
It changes intent when conditions change. Its output is small: a goal, an urgency, and a
stance. It never sends muscle commands.

### Senses: the filter in front of the mind

The mind never reacts to the world directly. It reacts only to what passes through the
field-of-view cone, the hearing radius, and the reaction delay. Two creatures in the same
situation often act differently. The main reason: they perceived different situations.

### Environment: everything that puts pressure on the creature

The environment is terrain, threats, sounds, and other creatures. It does not command the
creature. It only exists, and pressure comes from that.

## How the parts work together

The parts run in a loop:

1. The environment produces events.
2. The senses decide what the creature notices.
3. The mind decides what to do about it, and when.
4. The body decides whether it can do it, and how.
5. The action changes the environment. The loop repeats.

## How mind and body limit each other

The limits run in both directions:

- **The body limits the mind.** The mind can only choose actions the body can perform.
  A prone creature cannot start sprinting instantly. A creature without hands cannot grab.
- **The mind activates the body.** The body acts only when the mind commits to a goal.

The code shows this directly. The state machine picks "get to cover". The nav grid answers
"here is a path you can reach". The stance and gait system answers "here is how fast you
cross it".

## Two ways to make creatures different

### Change values — works today

Change parameter values and a different creature appears. The specialist roles prove this:
sniper and technical are pure data (`sightScale`, `closeRange`, `swapOnDryMag`). The logic
has no role branches. Stances derive from the rig instead of hardcoded heights. Weapon
carries resolve through one shared table.

### Change structure — not ready yet

The current bots assume a humanoid: two legs, arms and hands, and combat-shaped states.
These assumptions live in the structure of the code, not in data. To build a dog, a bird,
or a fish, each assumption must become swappable data:

- a body plan (leg count, proportions, skeleton),
- a gait module that reads the body plan,
- a species-specific state set that plugs into the same state machine,
- sense tuning (field of view, hearing, reaction) per species.

The legacy `creature-viewer.html` (one directory up) already solved the structure half. Its
`BODY_PLANS`, `GAITS`, and `MODEL_STYLES` are composable data with arbitrary leg counts. But
it has none of v2's behavior depth. The goal is the merge: that structural generality carrying
bot-v2's behavior machinery.

## The design rule: data, not branches

When two creatures differ, express the difference as a data field, not as an if-branch.
Every `if (role === …)` you avoid brings "creature = a point in parameter space" closer to
being literally true. The seams already cut this way — the role registry, rig-derived stance,
the weapon-hold resolver — are the seams a species system will need.

## Where each part lives in the code (bot-viewer-v2)

| Part | Code |
|---|---|
| Mind | FSM in `bot-entity.js` + `bot-states/`, roles in `bot-roles.js`, squads in `bot-squad.js` |
| Senses | FOV cone + hearing in `bot-alert.js`, reaction delay, squad alert propagation |
| Body | instanced rig (`body-part-batches.js`), stances (`bot-stance.js`), weapon holds (`weapon-hold-resolver.js`), ragdoll (`ragdoll.js`) |
| Environment | maze/walls, `bot-terrain.js`, `nav-grid.js` (the body's reachability answer), `bot-cover.js` |
| The limits | FSM goal → nav-grid path → stance/gait speed |
