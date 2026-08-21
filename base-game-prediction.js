// Renderer-independent owning-client prediction for Base Game, lockstep-tick edition. Each local
// fixed step is a numbered tick with its own input. The same tick is sent to the server, which runs
// exactly one step per tick through the same controller, so replaying unacknowledged ticks after
// an authoritative snapshot reproduces the server's arithmetic exactly.

import {
  BASE_GAME_TICK_QUEUE_DRAIN,
  BASE_GAME_TICK_QUEUE_TARGET,
  sanitizeBaseGamePlayerState,
} from './base-game-protocol.mjs';

const DEFAULTS = Object.freeze({
  historyLimit: 600,
  hardSnapDistance: 3,
  softCorrectionDistance: 1e-4,
  maxStepsPerFrame: 8,
});

export function createBaseGamePrediction({
  controller,
  onTick = null,
  historyLimit,
  hardSnapDistance,
  softCorrectionDistance,
  maxStepsPerFrame,
} = {}) {
  if (!controller?.stepOnce || !controller.applyState || !controller.captureState) {
    throw new TypeError('prediction requires a base-game player controller with stepOnce()');
  }
  const cfg = {
    historyLimit: historyLimit ?? DEFAULTS.historyLimit,
    hardSnapDistance: hardSnapDistance ?? DEFAULTS.hardSnapDistance,
    softCorrectionDistance: softCorrectionDistance ?? DEFAULTS.softCorrectionDistance,
    maxStepsPerFrame: maxStepsPerFrame ?? DEFAULTS.maxStepsPerFrame,
  };
  const history = [];
  let tick = 0;
  let accumulator = 0;
  let timeScale = 1;
  let spawnRevision = 0;
  let lastAckedTick = 0;
  let ackBase = null;
  let lastError = 0;
  let reconciliations = 0;
  let hardSnaps = 0;
  let replayedSteps = 0;
  let droppedHistory = 0;
  let droppedSeconds = 0;
  let lastQueueDepth = null;

  function fixedDt() {
    return 1 / controller.config.fixedHz;
  }

  // Runs as many fixed ticks as the frame allows. `sampleInput(indexInFrame)` returns the input for
  // each tick (including a one-shot `jump`); the caller owns the edge so it is consumed once.
  function advance(dt, sampleInput) {
    const fixed = fixedDt();
    const safeDt = Math.max(0, Number(dt) || 0) * timeScale;
    const maxAccumulated = fixed * cfg.maxStepsPerFrame;
    const accepted = Math.min(safeDt, maxAccumulated);
    droppedSeconds += Math.max(0, safeDt - accepted);
    accumulator = Math.min(maxAccumulated, accumulator + accepted);
    let steps = 0;
    while (accumulator + 1e-9 >= fixed && steps < cfg.maxStepsPerFrame) {
      const input = sampleInput(steps) ?? {};
      tick += 1;
      const entry = {
        tick,
        moveX: Number(input.moveX) || 0,
        moveZ: Number(input.moveZ) || 0,
        yaw: Number.isFinite(input.yaw) ? input.yaw : 0,
        pitch: Number.isFinite(input.pitch) ? input.pitch : 0,
        sprint: !!input.sprint,
        jump: !!input.jump,
        position: null,
      };
      controller.stepOnce({ moveX: entry.moveX, moveZ: entry.moveZ, yaw: entry.yaw, sprint: entry.sprint }, entry.jump);
      entry.position = controller.getPosition();
      history.push(entry);
      onTick?.(entry);
      accumulator -= fixed;
      steps++;
    }
    if (history.length > cfg.historyLimit) {
      droppedHistory += history.length - cfg.historyLimit;
      history.splice(0, history.length - cfg.historyLimit);
    }
    return { steps, alpha: Math.max(0, Math.min(1, accumulator / fixed)) };
  }

  // Keeps the server's per-player queue near its target depth: run slightly fast when the server
  // is starving, slightly slow when the queue is deep. Small factors so pacing is never visible.
  function adjustPacing(queueDepth) {
    if (!Number.isFinite(queueDepth)) return timeScale;
    lastQueueDepth = queueDepth;
    if (queueDepth < BASE_GAME_TICK_QUEUE_TARGET - 1) timeScale = 1.06;
    else if (queueDepth > BASE_GAME_TICK_QUEUE_DRAIN) timeScale = 0.94;
    else timeScale = 1;
    return timeScale;
  }

  function installAuthoritative(state) {
    controller.applyState({ position: state.position, velocity: state.velocity, grounded: state.grounded });
  }

  // Applies one authoritative player entry. Returns what happened so presentation can decide
  // whether to reset camera smoothing.
  function reconcile(entry) {
    const state = sanitizeBaseGamePlayerState(entry);
    if (!state) return { applied: false, reason: 'invalid' };
    adjustPacing(state.queueDepth);
    const ack = state.lastProcessedTick;
    let hard = false;
    if (state.spawnRevision !== spawnRevision) {
      spawnRevision = state.spawnRevision;
      history.length = 0;
      hard = true;
    }
    let reference = null;
    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index].tick <= ack) { reference = history[index].position; break; }
    }
    if (!reference && ackBase && ackBase.tick === ack) reference = ackBase.position;
    const predicted = controller.getPosition();
    const basis = reference ?? predicted;
    const error = Math.hypot(basis[0] - state.position[0], basis[1] - state.position[1], basis[2] - state.position[2]);
    lastError = error;
    lastAckedTick = ack;
    ackBase = { tick: ack, position: [...state.position] };
    if (!hard && error > cfg.hardSnapDistance) hard = true;

    let firstUnacked = 0;
    while (firstUnacked < history.length && history[firstUnacked].tick <= ack) firstUnacked++;
    if (firstUnacked > 0) history.splice(0, firstUnacked);
    if (!hard && error <= cfg.softCorrectionDistance) {
      return { applied: true, hard: false, replayed: 0, error, reason: 'in-tolerance' };
    }

    installAuthoritative(state);
    let replayed = 0;
    if (!hard) {
      for (const item of history) {
        controller.stepOnce({ moveX: item.moveX, moveZ: item.moveZ, yaw: item.yaw, sprint: item.sprint }, item.jump);
        item.position = controller.getPosition();
        replayed++;
      }
    } else {
      history.length = 0;
      hardSnaps++;
    }
    replayedSteps += replayed;
    reconciliations++;
    return { applied: true, hard, replayed, error, reason: hard ? 'hard-snap' : 'replay' };
  }

  return {
    advance,
    reconcile,
    adjustPacing,
    reset() {
      history.length = 0;
      accumulator = 0;
      timeScale = 1;
      lastError = 0;
      lastAckedTick = 0;
      ackBase = null;
      spawnRevision = 0;
      lastQueueDepth = null;
    },
    get tick() { return tick; },
    get timeScale() { return timeScale; },
    get spawnRevision() { return spawnRevision; },
    get historyLength() { return history.length; },
    get diagnostics() {
      return {
        tick,
        historyLength: history.length,
        lastAckedTick,
        predictionError: lastError,
        reconciliations,
        hardSnaps,
        replayedSteps,
        droppedHistory,
        droppedSeconds,
        timeScale,
        serverQueueDepth: lastQueueDepth,
      };
    },
  };
}
