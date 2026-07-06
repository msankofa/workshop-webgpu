// claudecraft-render/anim_state.js
// Hand-ported (types stripped) from ClaudeCraft
// src/render/characters/anim_state.ts. Pure, three-free pose math: the AnimState
// (renderer-derived input) and BaseState selection that visual.js delegates to.
// Kept byte-faithful to the source so mob locomotion matches ClaudeCraft.

const RUN_SPEED_THRESHOLD = 4.5; // u/s - sim walk/wander sits well below
const DEFAULT_WALK_REF = 2.2;
const DEFAULT_RUN_REF = 7;

// AnimState shape (documented, not enforced):
//   { speed, moving, airborne, backwards, reverseBackpedal?, dead, casting, swimming, sitting }
// BaseState: 'idle' | 'walk' | 'walkBack' | 'run' | 'cast' | 'swim' | 'sit' | 'jump'

export function desiredBaseState(s, hasWalkBackClip) {
  if (s.swimming) return 'swim';
  if (s.airborne) return 'jump';
  if (s.casting) return 'cast';
  if (s.sitting) return 'sit';
  if (s.moving) {
    if (s.backwards && hasWalkBackClip && !s.reverseBackpedal) return 'walkBack';
    return s.speed >= RUN_SPEED_THRESHOLD ? 'run' : 'walk';
  }
  return 'idle';
}

export function locomotionTimeScale(baseState, s, walkRef = DEFAULT_WALK_REF, runRef = DEFAULT_RUN_REF) {
  let timeScale;
  if (baseState === 'walk' || baseState === 'walkBack') {
    timeScale = clamp(s.speed / walkRef, 0.6, 1.8);
  } else if (baseState === 'run') {
    timeScale = clamp(s.speed / runRef, 0.6, 1.6);
  } else {
    return null;
  }
  return s.reverseBackpedal && s.backwards && baseState !== 'walkBack' ? -timeScale : timeScale;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
