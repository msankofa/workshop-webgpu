// Audit the two assumptions the tuning work rests on. `node audit-stadium-rig.mjs [mapping|clips|all]`.
//
// This is a measuring instrument, not a test — it prints findings and never fails. `test-rig-audit.mjs`
// is where any conclusion gets pinned down so it cannot drift.
//
//   mapping  did the mapper pick plausible bones, joints and feet
//   clips    how much does each ROM animation move the points the legs hang off
//
// `ONLY=pikachu` narrows to matching species.

import fs from 'node:fs';
import { parseGLB, readAccessor } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import { auditMapping, clipChannels, clipDisturbance, rankClips, parentMap, ancestorsOf } from './rig-audit.js';
import * as THREE from 'three';
import { createStadiumWalker } from './stadium-walker.js';

/**
 * The stride envelope this model actually gets, so hip travel can be stated against the thing it has to
 * be small compared to. `rig-audit.js` stays free of THREE; the runner is allowed to build a walker.
 */
function strideEnvelopeOf(json, map) {
  const scene = new THREE.Group();
  const objs = new Map();
  (json.nodes || []).forEach((n, i) => {
    const o = new THREE.Object3D();
    o.name = map.names[i] ?? `node${i}`;
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    objs.set(i, o);
  });
  (json.nodes || []).forEach((n, i) => { for (const c of n.children || []) objs.get(i).add(objs.get(c)); });
  for (const [i, o] of objs) if (!o.parent) scene.add(o);
  const walker = createStadiumWalker({ THREE, scene, map, terrainHeight: () => 0, worldHeight: 0.5 });
  return { envelope: walker.state.strideEnvelope, span: walker.state.legSpanWorld };
}

const SPECIES = fs.readdirSync('models/stadium').filter(f => f.endsWith('.glb')).map(f => f.replace('.glb', ''))
  .filter(s => !process.env.ONLY || process.env.ONLY.split(',').some(p => s.includes(p)));

const load = (s) => {
  const bytes = fs.readFileSync(`models/stadium/${s}.glb`);
  const { json, bin } = parseGLB(bytes);
  return { json, bin, map: mapStadiumRig(json, bin, { source: s }) };
};

const mode = process.argv[2] || 'all';
const pct = (v) => `${(v * 100).toFixed(1)}%`;

if (mode === 'mapping' || mode === 'all') {
  console.log('=== MAPPING ===\n');
  let errs = 0, warns = 0, clean = 0;
  for (const s of SPECIES) {
    const { json, map } = load(s);
    const a = auditMapping(map, json);
    errs += a.errors; warns += a.warnings;
    if (!a.findings.length) { clean++; console.log(`${s.padEnd(14)} clean — ${a.legs.length} legs`); continue; }
    console.log(`${s.padEnd(14)} ${a.errors} error(s), ${a.warnings} warning(s)`);
    for (const f of a.findings) console.log(`    ${f.level === 'error' ? 'ERR ' : 'warn'} ${f.text}`);
    for (const l of a.legs) {
      console.log(`      ${l.name.padEnd(4)} ${l.bones.join('>').padEnd(24)} on ${String(l.attach).padEnd(8)}`
        + ` span ${l.span.toFixed(2)}  ${l.l1.toFixed(2)}+${l.l2.toFixed(2)}  foot ${pct(l.footAbove)} up`);
    }
  }
  console.log(`\n${clean} of ${SPECIES.length} models clean; ${errs} errors and ${warns} warnings in total\n`);
}

if (mode === 'clips' || mode === 'all') {
  console.log('=== CLIPS: how far each one moves the points the legs hang off ===');
  console.log('(leg spans of attach-point travel; the viewer strips leg-bone tracks, so this is what reaches the rig)\n');
  for (const s of SPECIES) {
    const { json, bin, map } = load(s);
    // Exactly what `demos/stadium-walker.html` removes before playing: tracks targeting a leg BONE. Note
    // it does not remove tracks targeting the bone a leg hangs off, which is the whole point here.
    const strip = new Set(map.legs.flatMap(l => l.bones));
    const parent = parentMap(json);
    const attaches = [...new Set(map.legs.map(l => l.attach))];
    const chains = new Set(attaches.flatMap(a => [a, ...ancestorsOf(a, parent)]));

    const clips = clipChannels(json, bin, readAccessor);
    const rows = rankClips(clips.map(c => clipDisturbance(json, map, c, { strip })));
    const idle = rows.find(r => /^idle$/i.test(r.clip));
    const best = rows[0];
    // THE COMPARISON THAT DECIDES IT. Hip travel only matters against the stride envelope: the whole
    // distance a foot has to work in. A clip that moves the hips a whole envelope while the creature is
    // supposedly standing still is not a layer on top of the walk, it is a second walk fighting the first.
    const { envelope, span } = strideEnvelopeOf(json, map);
    const envInSpans = span > 0 ? envelope / span : 0;
    console.log(`${s}  (${map.legs.length} legs, attach ${attaches.map(a => map.names[a] ?? a).join('/')}`
      + `, stride envelope ${pct(envInSpans)} of a leg)`);
    for (const r of rows) {
      const mark = /^idle$/i.test(r.clip) ? ' <- the one the viewer plays' : '';
      const envelopes = envInSpans > 0 ? r.worst / envInSpans : 0;
      const flag = envelopes > 0.25 ? `  ${envelopes.toFixed(1)}x THE ENVELOPE` : '';
      console.log(`   ${r.clip.padEnd(16)} ${r.duration.toFixed(2)}s  hip travel ${pct(r.worst).padStart(7)}`
        + `  x ${pct(Math.max(...r.perAttach.map(a => a.dx))).padStart(6)}`
        + ` y ${pct(Math.max(...r.perAttach.map(a => a.dy))).padStart(6)}`
        + ` z ${pct(Math.max(...r.perAttach.map(a => a.dz))).padStart(6)}${flag}${mark}`);
    }
    // The count that says whether stripping leg-bone tracks was ever going to be enough.
    const overlapping = clips.filter(c => [...c.nodes].some(n => chains.has(n))).length;
    console.log(`   ${overlapping} of ${clips.length} clips animate a leg attach or one of its ancestors`);
    if (idle && best && best.clip !== idle.clip && idle.worst > best.worst * 1.5) {
      console.log(`   a quieter clip exists: ${best.clip} at ${pct(best.worst)} against idle's ${pct(idle.worst)}`);
    }
    console.log('');
  }
}
