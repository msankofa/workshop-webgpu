// world-coordinates.js — global simulation coordinates, render-local coordinates,
// origin rebasing, and stable three-dimensional spatial cell keys.
//
// Canonical vectors at this boundary are numeric [x, y, z] arrays. Three.js and
// other render/simulation types adapt at their own edge instead of becoming part
// of the world contract.

export const WORLD_COORDINATE_CONTRACT_VERSION = 1;

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

export function assertWorldVec3(value, label = 'vector') {
  if (!value || typeof value.length !== 'number' || value.length < 3) {
    throw new TypeError(`${label} must be an [x, y, z] array`);
  }
  finiteNumber(value[0], `${label}[0]`);
  finiteNumber(value[1], `${label}[1]`);
  finiteNumber(value[2], `${label}[2]`);
  return value;
}

export function copyWorldVec3(value, out = [0, 0, 0]) {
  assertWorldVec3(value);
  out[0] = value[0];
  out[1] = value[1];
  out[2] = value[2];
  return out;
}

export function globalToRenderLocal(globalPosition, renderOrigin, out = [0, 0, 0]) {
  assertWorldVec3(globalPosition, 'globalPosition');
  assertWorldVec3(renderOrigin, 'renderOrigin');
  out[0] = globalPosition[0] - renderOrigin[0];
  out[1] = globalPosition[1] - renderOrigin[1];
  out[2] = globalPosition[2] - renderOrigin[2];
  return out;
}

export function renderLocalToGlobal(localPosition, renderOrigin, out = [0, 0, 0]) {
  assertWorldVec3(localPosition, 'localPosition');
  assertWorldVec3(renderOrigin, 'renderOrigin');
  out[0] = localPosition[0] + renderOrigin[0];
  out[1] = localPosition[1] + renderOrigin[1];
  out[2] = localPosition[2] + renderOrigin[2];
  return out;
}

// Existing render-local objects add this delta after an origin change.
export function renderOriginShiftDelta(previousOrigin, nextOrigin, out = [0, 0, 0]) {
  assertWorldVec3(previousOrigin, 'previousOrigin');
  assertWorldVec3(nextOrigin, 'nextOrigin');
  out[0] = previousOrigin[0] - nextOrigin[0];
  out[1] = previousOrigin[1] - nextOrigin[1];
  out[2] = previousOrigin[2] - nextOrigin[2];
  return out;
}

export function snapRenderOrigin(globalPosition, snap = 1024, out = [0, 0, 0]) {
  assertWorldVec3(globalPosition, 'globalPosition');
  finiteNumber(snap, 'snap');
  if (snap <= 0) throw new RangeError('snap must be greater than zero');
  out[0] = Math.round(globalPosition[0] / snap) * snap;
  out[1] = Math.round(globalPosition[1] / snap) * snap;
  out[2] = Math.round(globalPosition[2] / snap) * snap;
  return out;
}

export function createWorldCoordinateSpace({
  renderOrigin = [0, 0, 0],
  rebaseDistance = 8192,
  rebaseSnap = 1024,
} = {}) {
  const origin = copyWorldVec3(renderOrigin);
  finiteNumber(rebaseDistance, 'rebaseDistance');
  finiteNumber(rebaseSnap, 'rebaseSnap');
  if (rebaseDistance <= 0) throw new RangeError('rebaseDistance must be greater than zero');
  if (rebaseSnap <= 0) throw new RangeError('rebaseSnap must be greater than zero');

  const listeners = new Set();
  let revision = 0;

  function setRenderOrigin(nextOrigin) {
    assertWorldVec3(nextOrigin, 'nextOrigin');
    if (origin[0] === nextOrigin[0] && origin[1] === nextOrigin[1] && origin[2] === nextOrigin[2]) {
      return { changed: false, revision, previous: copyWorldVec3(origin), current: copyWorldVec3(origin), delta: [0, 0, 0] };
    }
    const previous = copyWorldVec3(origin);
    const delta = renderOriginShiftDelta(previous, nextOrigin);
    copyWorldVec3(nextOrigin, origin);
    revision++;
    const event = Object.freeze({
      changed: true,
      revision,
      previous: Object.freeze(previous),
      current: Object.freeze(copyWorldVec3(origin)),
      delta: Object.freeze(delta),
    });
    for (const listener of [...listeners]) listener(event);
    return event;
  }

  return {
    get revision() { return revision; },
    getOrigin(out = [0, 0, 0]) { return copyWorldVec3(origin, out); },
    toRenderLocal(globalPosition, out = [0, 0, 0]) {
      return globalToRenderLocal(globalPosition, origin, out);
    },
    toGlobal(localPosition, out = [0, 0, 0]) {
      return renderLocalToGlobal(localPosition, origin, out);
    },
    setRenderOrigin,
    maybeRebase(focusGlobal) {
      assertWorldVec3(focusGlobal, 'focusGlobal');
      const distance = Math.hypot(
        focusGlobal[0] - origin[0],
        focusGlobal[1] - origin[1],
        focusGlobal[2] - origin[2],
      );
      if (distance <= rebaseDistance) {
        return { changed: false, revision, distance, previous: copyWorldVec3(origin), current: copyWorldVec3(origin), delta: [0, 0, 0] };
      }
      const event = setRenderOrigin(snapRenderOrigin(focusGlobal, rebaseSnap));
      return { ...event, distance };
    },
    onRebase(listener) {
      if (typeof listener !== 'function') throw new TypeError('rebase listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function positiveCellSize(cellSize) {
  finiteNumber(cellSize, 'cellSize');
  if (cellSize <= 0) throw new RangeError('cellSize must be greater than zero');
  return cellSize;
}

export function worldCell3(globalPosition, cellSize, out = [0, 0, 0]) {
  assertWorldVec3(globalPosition, 'globalPosition');
  positiveCellSize(cellSize);
  out[0] = Math.floor(globalPosition[0] / cellSize);
  out[1] = Math.floor(globalPosition[1] / cellSize);
  out[2] = Math.floor(globalPosition[2] / cellSize);
  return out;
}

function validCellIndex(value, label) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer`);
  return value;
}

function validLod(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('lod must be a non-negative safe integer');
  return value;
}

function validLayer(value) {
  const layer = String(value ?? 'solid');
  if (!/^[A-Za-z0-9_.-]+$/.test(layer)) {
    throw new TypeError('layer may contain only letters, numbers, underscore, dot, and dash');
  }
  return layer;
}

export function worldCellKey3(cell, { lod = 0, layer = 'solid' } = {}) {
  assertWorldVec3(cell, 'cell');
  const x = validCellIndex(cell[0], 'cell[0]');
  const y = validCellIndex(cell[1], 'cell[1]');
  const z = validCellIndex(cell[2], 'cell[2]');
  return `${validLayer(layer)}:${validLod(lod)}:${x}:${y}:${z}`;
}

export function worldPositionKey3(globalPosition, cellSize, options) {
  return worldCellKey3(worldCell3(globalPosition, cellSize), options);
}

export function parseWorldCellKey3(key) {
  const parts = String(key).split(':');
  if (parts.length !== 5) throw new TypeError('invalid 3D world-cell key');
  const layer = validLayer(parts[0]);
  const lod = validLod(Number(parts[1]));
  const cell = [Number(parts[2]), Number(parts[3]), Number(parts[4])];
  validCellIndex(cell[0], 'cell[0]');
  validCellIndex(cell[1], 'cell[1]');
  validCellIndex(cell[2], 'cell[2]');
  return { layer, lod, cell };
}

export function worldCellBounds3(cell, cellSize) {
  assertWorldVec3(cell, 'cell');
  positiveCellSize(cellSize);
  const min = [
    validCellIndex(cell[0], 'cell[0]') * cellSize,
    validCellIndex(cell[1], 'cell[1]') * cellSize,
    validCellIndex(cell[2], 'cell[2]') * cellSize,
  ];
  return { min, max: [min[0] + cellSize, min[1] + cellSize, min[2] + cellSize] };
}
