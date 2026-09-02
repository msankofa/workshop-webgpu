import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BASE_GAME_MAX_LOOK_RADIANS_PER_FRAME,
  createBaseGamePointerLook,
} from './base-game-pointer-look.js';

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12,
  `${message}: expected ${expected}, received ${actual}`);

// Ordinary events retain the old feel: raw deltas add together and sensitivity is applied once.
{
  const look = createBaseGamePointerLook();
  look.add(12, -5);
  look.add(8, 2);
  const delta = look.consume(0.002);
  near(delta.deltaYaw, -0.04, 'horizontal input is unchanged');
  near(delta.deltaPitch, 0.006, 'vertical input is unchanged');
  assert.equal(delta.clamped, false);
  const empty = look.consume(0.002);
  near(empty.deltaYaw, 0, 'consuming clears horizontal input');
  near(empty.deltaPitch, 0, 'consuming clears vertical input');
}

// A lag backlog cannot rotate the view more than 45 degrees in one rendered frame.
{
  const look = createBaseGamePointerLook();
  for (let i = 0; i < 500; i++) look.add(20, 10);
  const delta = look.consume(0.01);
  near(Math.hypot(delta.deltaYaw, delta.deltaPitch), BASE_GAME_MAX_LOOK_RADIANS_PER_FRAME,
    'a queued backlog is angularly capped');
  assert.equal(delta.clamped, true);
  near(delta.deltaYaw / delta.deltaPitch, 2, 'the cap preserves the input direction');
}

// Losing pointer lock or focus discards movement that has not reached a rendered frame.
{
  const look = createBaseGamePointerLook();
  look.add(9000, -4000);
  look.clear();
  const delta = look.consume(0.01);
  near(delta.deltaYaw, 0, 'clear discards stale horizontal movement');
  near(delta.deltaPitch, 0, 'clear discards stale vertical movement');
  look.add(Number.NaN, Infinity);
  assert.deepEqual(look.consume(0.002), { deltaYaw: 0, deltaPitch: 0, clamped: false });
}

// Integration guard: events queue raw movement; the frame consumes it before constructing input.
{
  const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  assert.match(html, /pointerLook\.add\(event\.movementX, event\.movementY\)/);
  assert.doesNotMatch(html, /playerView\.addLook\(-event\.movementX/);
  const consumeAt = html.indexOf('pointerLook.consume(settings.cameraSensitivity');
  const inputAt = html.indexOf('const input = canControl ?', consumeAt);
  assert.ok(consumeAt >= 0 && inputAt > consumeAt, 'look is consumed before movement input snapshots yaw');
  assert.match(html, /pointerlockchange[\s\S]{0,250}pointerLook\.clear\(\)/);
}

console.log('base-game pointer-look tests passed');
