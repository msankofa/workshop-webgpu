export function dampAlpha(dt, rate) {
  return 1 - Math.exp(-Math.max(0, dt) * Math.max(0, rate));
}

export function dampAngle(current, target, dt, rate) {
  const tau = Math.PI * 2;
  const delta = ((target - current + Math.PI) % tau + tau) % tau - Math.PI;
  return current + delta * dampAlpha(dt, rate);
}

export function chooseOcclusionCandidate(
  clearances,
  penalties,
  currentIndex = 0,
  switchMargin = 0.35,
) {
  if (!clearances.length) return 0;
  const current = Math.min(Math.max(0, currentIndex | 0), clearances.length - 1);
  const score = index => (Number.isFinite(clearances[index]) ? clearances[index] : 0)
    - (Number.isFinite(penalties[index]) ? penalties[index] : 0);
  let best = current;
  let bestScore = score(current);
  for (let i = 0; i < clearances.length; i++) {
    const candidateScore = score(i);
    if (candidateScore > bestScore + (i === current ? 0 : switchMargin)) {
      best = i;
      bestScore = candidateScore;
    }
  }
  return best;
}

export function stepOcclusionMemory({
  distance,
  clearDistance,
  obstructed,
  now,
  holdUntil,
  dt,
  holdMs = 700,
  recoveryRate = 1.15,
  closerEpsilon = 0.02,
}) {
  let nextDistance = Math.max(0, distance);
  let nextHoldUntil = Math.max(0, holdUntil);
  const safeDistance = Math.max(0, clearDistance);

  if (obstructed) {
    if (safeDistance < nextDistance - closerEpsilon) nextHoldUntil = now + holdMs;
    nextDistance = Math.min(nextDistance, safeDistance);
  }
  if (now >= nextHoldUntil) {
    nextDistance += (safeDistance - nextDistance) * dampAlpha(dt, recoveryRate);
  }
  return { distance: nextDistance, holdUntil: nextHoldUntil };
}

export function stepPovRecenter({
  yaw,
  pitch,
  enabled,
  dragging,
  now,
  lastInputAt,
  delayMs,
  dt,
  rate = 2.4,
}) {
  if (!enabled || dragging || now - lastInputAt < delayMs) return { yaw, pitch };
  const alpha = dampAlpha(dt, rate);
  return {
    yaw: yaw + (0 - yaw) * alpha,
    pitch: pitch + (0 - pitch) * alpha,
  };
}
