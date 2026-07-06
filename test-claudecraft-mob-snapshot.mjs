// test-claudecraft-mob-snapshot.mjs
import { serializeMobs } from './claudecraft-bridge/sim-mob-snapshot.js';
import { makeScale } from './claudecraft-bridge/sim-scale.js';
const s = makeScale(5.2); // SCALE = 2
const fakeEntities = new Map([
  [1, { kind: 'mob', templateId: 'forest_wolf', pos: { x: 10, y: 2, z: 4 }, facing: 0, hp: 30, maxHp: 40, dead: false, aiState: 'chase', scale: 2.5 }],
  [2, { kind: 'player', pos: { x: 0, y: 0, z: 0 } }],
  [3, { kind: 'mob', templateId: 'wild_boar', pos: { x: -1, y: 0, z: 0 }, facing: Math.PI, hp: 0, maxHp: 20, dead: true, aiState: 'idle' }],
]);
const wire = serializeMobs(fakeEntities, s);
console.assert(wire.length === 2, `only mobs serialized, got ${wire.length}`);
const wolf = wire.find((m) => m.id === 1);
console.assert(wolf.tid === 'forest_wolf', 'template id');
console.assert(Math.abs(wolf.p[0] - 20) < 1e-9, 'x scaled to world (10*2)');
console.assert(Math.abs(wolf.p[1] - 4) < 1e-9, 'y scaled to world (2*2)');
console.assert(Math.abs(wolf.hp - 0.75) < 1e-9, 'hp normalized 30/40');
console.assert(wolf.q.length === 4, 'quaternion has 4 components');
console.assert(wolf.s === 2.5, `per-mob scale carried, got ${wolf.s}`);
const boar = wire.find((m) => m.id === 3);
console.assert(boar.dead === true, 'dead flag carried');
console.assert(boar.s === 1, `per-mob scale defaults to 1 when absent, got ${boar.s}`);
console.log('mob snapshot OK');
