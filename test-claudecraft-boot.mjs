// test-claudecraft-boot.mjs
import { Sim } from './claudecraft-sim.bundle.js';
const sim = new Sim({ seed: 1, playerClass: 'warrior' });
let events = [];
for (let i = 0; i < 20; i++) events = sim.tick();
console.assert(Array.isArray(events), 'tick returns an event array');
let mobCount = 0;
for (const e of sim.entities.values()) if (e.kind === 'mob') mobCount++;
console.assert(mobCount > 0, `expected mobs from the built-in world, got ${mobCount}`);
console.log('boot OK, mobs:', mobCount);
