// claudecraft-bridge/sim-mob-snapshot.js
// Serializes sim mob entities (yard space) to the multiplayer wire shape
// (world space): { id, tid, p:[x,y,z], q:[x,y,z,w], hp:0..1, dead, s }.
// `s` is the per-mob scale multiplier (e.template.scale, or a runtime override
// from the spawn panel); it multiplies the render worldScale so big mobs render
// big. Defaults to 1 for a mob template with no scale. Quaternion is a pure yaw
// from facing (0 = +Z), so guests need no sim.
function yawQuat(facing) {
  const h = facing / 2;
  return [0, Math.sin(h), 0, Math.cos(h)];
}
export function serializeMobs(entities, scale) {
  const out = [];
  for (const [key, e] of entities.entries()) {
    if (e.kind !== 'mob') continue;
    out.push({
      id: e.id ?? key,
      tid: e.templateId,
      p: [scale.toWorld(e.pos.x), scale.toWorld(e.pos.y), scale.toWorld(e.pos.z)],
      q: yawQuat(e.facing),
      hp: e.maxHp > 0 ? e.hp / e.maxHp : 0,
      dead: !!e.dead,
      s: Number.isFinite(e.scale) && e.scale > 0 ? e.scale : 1,
    });
  }
  return out;
}
