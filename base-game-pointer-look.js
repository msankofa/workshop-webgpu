// Pointer-lock events can queue while rendering stalls. Consume them once per rendered frame so a
// backlog can be bounded before it becomes a multi-radian camera jump.
export const BASE_GAME_MAX_LOOK_RADIANS_PER_FRAME = Math.PI / 4;

export function createBaseGamePointerLook({
  maxRadiansPerFrame = BASE_GAME_MAX_LOOK_RADIANS_PER_FRAME,
} = {}) {
  const maxRadians = Number.isFinite(maxRadiansPerFrame) && maxRadiansPerFrame > 0
    ? maxRadiansPerFrame
    : BASE_GAME_MAX_LOOK_RADIANS_PER_FRAME;
  let movementX = 0;
  let movementY = 0;

  function add(dx, dy) {
    if (Number.isFinite(dx)) movementX += dx;
    if (Number.isFinite(dy)) movementY += dy;
    if (!Number.isFinite(movementX)) movementX = 0;
    if (!Number.isFinite(movementY)) movementY = 0;
  }

  function clear() {
    movementX = 0;
    movementY = 0;
  }

  function consume(sensitivity, out = {}) {
    const scale = Number.isFinite(sensitivity) && sensitivity >= 0 ? sensitivity : 0;
    let deltaYaw = movementX === 0 ? 0 : -movementX * scale;
    let deltaPitch = movementY === 0 ? 0 : -movementY * scale;
    clear();
    const magnitude = Math.hypot(deltaYaw, deltaPitch);
    const clamped = magnitude > maxRadians;
    if (clamped) {
      const ratio = maxRadians / magnitude;
      deltaYaw *= ratio;
      deltaPitch *= ratio;
    }
    out.deltaYaw = deltaYaw;
    out.deltaPitch = deltaPitch;
    out.clamped = clamped;
    return out;
  }

  return { add, clear, consume };
}
