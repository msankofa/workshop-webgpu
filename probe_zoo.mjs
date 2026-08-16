// scratch probe: run the auto-mapper across every extracted species and summarise the outcomes
import fs from 'node:fs';
import path from 'node:path';
import { mapStadiumRigFromGLB } from './stadium-rig-map.js';

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => f.endsWith('.glb')).sort();
const byLegs = new Map();
const rows = [];
for (const f of files) {
  let r;
  try {
    const { map } = mapStadiumRigFromGLB(fs.readFileSync(path.join(dir, f)), { source: f });
    r = { f, legs: map.legs.length, rows: new Set(map.legs.map(l => l.row)).size, warn: map.warnings.length, map };
  } catch (e) {
    r = { f, legs: -1, rows: 0, warn: 1, error: e.message };
  }
  rows.push(r);
  byLegs.set(r.legs, (byLegs.get(r.legs) || 0) + 1);
}
console.log('legs -> species count:', [...byLegs].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join('  '));
console.log('clean (no warnings):', rows.filter(r => !r.warn).length, '/', rows.length);
for (const r of rows) {
  if (r.legs === 4 && !r.warn) continue;
  console.log(`  ${r.f.padEnd(22)} legs=${String(r.legs).padStart(2)} rows=${r.rows} ${r.error ? 'ERROR ' + r.error : (r.map.warnings.join(' | ') || '')}`);
}
