// test-forest-gpu-rebuild.mjs
// CPU mirror of forest-gpu.js rebuild() logic.
// Verifies setChunks(map) ≡ N×setChunk and calls rebuild() exactly once.

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

function makeHarness({ V = 3, CAP = 8, variantsPerSpecies = 1 } = {}) {
  const srcArray    = new Float32Array(V * CAP * 8);
  const countsArray = new Uint32Array(V);
  const chunkRecords = new Map();
  let rebuildCount = 0;

  const variantSel = slot => (Math.imul(slot + 1, 2654435761) >>> 0) % variantsPerSpecies;

  function rebuild() {
    rebuildCount++;
    countsArray.fill(0);
    srcArray.fill(0);
    for (const records of chunkRecords.values()) {
      for (const r of records) {
        const g = r.speciesIdx * variantsPerSpecies + variantSel(r.slot);
        if (g < 0 || g >= V) continue;
        const slot = countsArray[g];
        if (slot >= CAP) continue;
        countsArray[g] = slot + 1;
        const base = (g * CAP + slot) * 8;
        srcArray[base]     = r.x;
        srcArray[base + 1] = 0;    // y (heightAt stub)
        srcArray[base + 2] = r.z;
        srcArray[base + 3] = r.scale;
        srcArray[base + 4] = r.yaw;
      }
    }
  }

  return {
    setChunk(key, records) { chunkRecords.set(key, records); rebuild(); },
    setChunks(map)         { for (const [k, v] of map) chunkRecords.set(k, v); rebuild(); },
    get rebuildCount()     { return rebuildCount; },
    srcSnapshot()          { return srcArray.slice(); },
    countSnapshot()        { return countsArray.slice(); },
  };
}

// ---- fixtures ----
const r0 = [{ x: 1, z: 1, scale: 0.5, yaw: 0.1, speciesIdx: 0, slot: 0 }];
const r1 = [{ x: 5, z: 5, scale: 0.7, yaw: 1.2, speciesIdx: 1, slot: 0 }];
const r2 = [{ x: 9, z: 9, scale: 0.4, yaw: 2.3, speciesIdx: 2, slot: 0 }];

// ---- test 1: rebuild call count ----
const a = makeHarness({ V: 3, CAP: 4, variantsPerSpecies: 1 });
a.setChunk('0,0', r0);
a.setChunk('1,0', r1);
a.setChunk('0,1', r2);
ok(a.rebuildCount === 3, `setChunk: rebuild called ${a.rebuildCount} times, expected 3`);

const b = makeHarness({ V: 3, CAP: 4, variantsPerSpecies: 1 });
b.setChunks(new Map([['0,0', r0], ['1,0', r1], ['0,1', r2]]));
ok(b.rebuildCount === 1, `setChunks: rebuild called ${b.rebuildCount} time(s), expected 1`);

// ---- test 2: identical source buffer ----
const aSnap = a.srcSnapshot(), bSnap = b.srcSnapshot();
ok(aSnap.every((v, i) => v === bSnap[i]), 'setChunks src buffer matches N×setChunk');
ok(a.countSnapshot().every((v, i) => v === b.countSnapshot()[i]), 'setChunks counts match N×setChunk');

// ---- test 3: order independence (different insertion order, same final state) ----
const c = makeHarness({ V: 3, CAP: 4, variantsPerSpecies: 1 });
c.setChunks(new Map([['0,1', r2], ['0,0', r0], ['1,0', r1]]));  // reversed order
ok(c.rebuildCount === 1, 'reversed setChunks: still one rebuild');
// Note: source buffer order may differ by insertion order (Map preserves insertion),
// but total instance count per variant must match.
ok(c.countSnapshot().every((v, i) => v === b.countSnapshot()[i]), 'reversed setChunks: same counts');

// ---- test 4: empty batch is a no-op ----
const d = makeHarness();
d.setChunks(new Map());
ok(d.rebuildCount === 1, 'empty setChunks still calls rebuild once');
ok(d.srcSnapshot().every(v => v === 0), 'empty setChunks: src buffer stays zero');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
