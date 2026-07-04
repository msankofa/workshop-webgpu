import crypto from 'node:crypto';

export const MAX_BODY_BYTES = 60_000_000; // same cap as serve.py's /api/save-map
const SAFE_SEGMENT = /^[A-Za-z0-9 _-]+$/;

export function validateSegment(value) {
  return typeof value === 'string' && SAFE_SEGMENT.test(value.trim()) && value.trim().length > 0;
}

// Constant-time compare; guards the length-mismatch case explicitly because
// crypto.timingSafeEqual throws (rather than returning false) when buffer
// lengths differ.
export function validateSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Mirrors serve.py's _handle_save_map upsert rule: only add the key if absent,
// same default entry shape serve.py already produces.
export function mergeMapConfig(existingConfigText, mapKey, name) {
  let cfg;
  try {
    cfg = JSON.parse(existingConfigText);
    if (typeof cfg !== 'object' || cfg === null) cfg = {};
  } catch {
    cfg = {};
  }
  if (typeof cfg.maps !== 'object' || cfg.maps === null) cfg.maps = {};
  if (!(mapKey in cfg.maps)) {
    const display = name.replace(/_/g, ' ').replace(/-/g, ' ').trim()
      .replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
    cfg.maps[mapKey] = {
      displayName: display, gameName: display, image: '',
      playable: true, mapScale: 1, snapStep: 0.5,
    };
  }
  return cfg;
}
