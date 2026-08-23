// flash-lights.js — the dynamic light budget extracted verbatim from bot-viewer-visuals.js
// (createVisualSystem's "dynamic light budget" block) so pages that do not run the full visual
// system — base-game.html first — can borrow a real point light for a muzzle flash or a blast.
// Not one light per event: a fixed pool of resident lights that transient events borrow for a few
// frames, scored by flashCurve/pickLightSlotsInto from bot-viewer-visuals-style.js.
//
// NEVER touch `.visible` per flash. On the WebGPU backend the set of visible lights feeds the
// lights hash that keys the render pipeline, so a light appearing or disappearing recompiles EVERY
// material in the scene. Visibility is structural; intensity is a uniform, and an unused slot
// idles at intensity 0 (bot-viewer-visuals.js's rule, kept here word for word).
import { flashCurve, pickLightSlotsInto } from './bot-viewer-visuals-style.js';

export const FLASH_DEFAULTS = Object.freeze({
  color: 0xffe0b0, intensity: 30, distance: 12, life: 0.07,   // a gunshot (the style module's theme numbers)
});
export const BLAST_FLASH = Object.freeze({
  color: 0xffb066, intensity: 140, life: 0.28,                 // a blast (bot-viewer-v3's spawnBlastFx); distance = min(60, shown * 3.2)
});

export function createFlashLights({ THREE, scene, getViewPosition, count = 2, cap = 64 }) {
  const dynLights = [];
  for (let i = 0; i < count; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 10, 2);
    l.name = `flashLight${i}`;
    scene.add(l);
    dynLights.push(l);
  }
  // Ring of reusable flash records: a new flash overwrites the oldest slot, so a sustained
  // full-auto exchange never allocates.
  const flashRing = [];
  for (let i = 0; i < cap; i++) {
    flashRing.push({ x: 0, y: 0, z: 0, color: new THREE.Color(0xffffff), intensity: 0, distance: 0, life: 0, age: 0, weight: 0, curve: 0, active: false });
  }
  let flashCursor = 0;
  const _live = [], _picked = [];

  // pos: anything with x/y/z. opts overrides colour/intensity/distance/life.
  function flash(pos, opts) {
    if (!pos) return;
    const f = flashRing[flashCursor];
    flashCursor = (flashCursor + 1) % cap;
    f.x = pos.x; f.y = pos.y; f.z = pos.z;
    f.color.set(opts?.color ?? FLASH_DEFAULTS.color);
    f.intensity = opts?.intensity ?? FLASH_DEFAULTS.intensity;
    f.distance = opts?.distance ?? FLASH_DEFAULTS.distance;
    f.life = opts?.life ?? FLASH_DEFAULTS.life;
    f.age = 0;
    f.active = true;
  }

  function update(dt, brightness = 1) {
    const view = getViewPosition();
    _live.length = 0;
    for (const f of flashRing) {
      if (!f.active) continue;
      f.age += dt;
      f.curve = flashCurve(f.age, f.life);
      if (f.curve <= 0) { f.active = false; continue; }
      // Brighter and nearer wins the slot; distance is soft so a far-off firefight still registers.
      const dx = f.x - view.x, dy = f.y - view.y, dz = f.z - view.z;
      f.weight = (f.intensity * f.curve) / (1 + Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.25);
      _live.push(f);
    }
    const picked = pickLightSlotsInto(_live, dynLights.length, _picked);
    for (let i = 0; i < dynLights.length; i++) {
      const l = dynLights[i], f = picked[i];
      if (!f) { l.intensity = 0; continue; }
      l.position.set(f.x, f.y, f.z);
      l.color.copy(f.color);
      l.distance = f.distance;
      l.intensity = f.intensity * f.curve * brightness;
    }
  }

  function dispose() {
    for (const l of dynLights) { scene.remove(l); l.dispose?.(); }
    dynLights.length = 0;
  }

  return { flash, update, dispose, lights: dynLights };
}
