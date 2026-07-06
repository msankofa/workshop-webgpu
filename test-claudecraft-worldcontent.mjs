// test-claudecraft-worldcontent.mjs
import { MOBS } from './claudecraft-sim.bundle.js';
import { makeScale } from './claudecraft-bridge/sim-scale.js';
import { buildClaudecraftWorldContent } from './claudecraft-bridge/sim-world-content.js';

// pick any real mob template id from the roster
const anyMobId = Object.keys(MOBS)[0];
const s = makeScale(5.2); // SCALE = 2
const content = buildClaudecraftWorldContent({
  scale: s,
  waterLevelWorld: -8,
  playerStartWorld: { x: 20, z: 40 },
  camps: [{ mobId: anyMobId, count: 3, centerWorld: { x: 100, z: 200 }, radiusWorld: 30 }],
});

console.assert(content.camps.length === 1, 'one camp');
console.assert(content.camps[0].mobId === anyMobId, 'mob id preserved');
console.assert(content.camps[0].count === 3, 'count preserved');
console.assert(Math.abs(content.camps[0].center.x - 50) < 1e-9, 'center x converted to sim yards (100/2)');
console.assert(Math.abs(content.camps[0].radius - 15) < 1e-9, 'radius converted (30/2)');
console.assert(Math.abs(content.waterLevel - -4) < 1e-9, 'water level converted (-8/2)');
console.assert(Math.abs(content.playerStart.x - 10) < 1e-9, 'player start converted (20/2)');
console.assert(Array.isArray(content.zones) && content.zones.length >= 1, 'has at least one zone');
console.assert(Object.keys(content.npcs).length === 0, 'no npcs');
console.assert(content.groundObjects.length === 0, 'no ground objects');
console.log('worldcontent OK');

// Step 5: verify the sim actually spawns the requested roster.
import { Sim, setActiveWorldContent, setHeightProvider } from './claudecraft-sim.bundle.js';
setHeightProvider((sx, sz) => 0);
setActiveWorldContent(content);
const sim = new Sim({ seed: 1, playerClass: 'warrior' });
let count = 0;
for (const e of sim.entities.values()) if (e.kind === 'mob' && e.templateId === anyMobId) count++;
console.assert(count === 3, `expected 3 spawned mobs of ${anyMobId}, got ${count}`);
console.log('spawn OK');
