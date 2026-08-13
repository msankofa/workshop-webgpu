// test-materials.mjs -- contract tests for the portable material demos in materials/.
//
// These build real NodeMaterials headlessly (three/webgpu resolves in Node) but never compile a
// shader, so they verify the API contract and the node graph wiring, not the pixels. Whether the
// effect looks right is a browser question, answered in material-viewer.html.
import * as THREE from 'three';
import { DEMOS, demoEntry, loadDemo } from './materials/index.js';
import { paramDefaults, resolveParams, paramSpec } from './materials/material-demo-api.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (cond) pass++; else fail++;
}

// ---- registry ----
ok(DEMOS.length > 0, 'registry lists at least one demo');
ok(new Set(DEMOS.map(d => d.id)).size === DEMOS.length, 'demo ids are unique');
ok(demoEntry('dissolve') !== null, 'demoEntry finds a known demo');
ok(demoEntry('nope') === null, 'demoEntry returns null for an unknown demo');

let threw = false;
try { await loadDemo('nope'); } catch { threw = true; }
ok(threw, 'loadDemo throws on an unknown demo id');

// ---- per-demo contract ----
for (const entry of DEMOS) {
  const mod = await entry.load();
  const { meta } = mod;
  const tag = `[${entry.id}]`;

  // Registry summary must not drift from the module's own meta.
  ok(meta.id === entry.id, `${tag} meta.id matches registry id`);
  ok(meta.name === entry.name, `${tag} registry name in sync with meta`);
  ok(meta.blurb === entry.blurb, `${tag} registry blurb in sync with meta`);
  ok(meta.targets === entry.targets, `${tag} registry targets in sync with meta`);
  ok(meta.cost === entry.cost, `${tag} registry cost in sync with meta`);

  ok(Array.isArray(meta.params) && meta.params.length > 0, `${tag} declares params`);
  ok(new Set(meta.params.map(p => p.key)).size === meta.params.length, `${tag} param keys are unique`);

  const badFloat = meta.params.filter(p =>
    (p.type ?? 'float') === 'float' && !(typeof p.min === 'number' && typeof p.max === 'number'));
  ok(badFloat.length === 0, `${tag} every float param has a min and max`);

  const outOfRange = meta.params.filter(p =>
    (p.type ?? 'float') === 'float' && (p.value < p.min || p.value > p.max));
  ok(outOfRange.length === 0, `${tag} every float default sits inside its own range`);

  // ---- instantiation ----
  const handle = mod.create();
  ok(handle.material && handle.material.isMaterial === true, `${tag} create returns a material`);
  ok(handle.material.isNodeMaterial === true, `${tag} material is a NodeMaterial`);
  ok(handle.material.colorNode != null, `${tag} colorNode is wired`);
  ok(handle.material.emissiveNode != null, `${tag} emissiveNode is wired`);
  ok(typeof handle.update === 'function', `${tag} exposes update()`);
  ok(typeof handle.dispose === 'function', `${tag} exposes dispose()`);

  // Defaults survive the round trip through resolveParams.
  const defaults = paramDefaults(meta);
  ok(Object.keys(handle.params).length === Object.keys(defaults).length,
    `${tag} handle carries every declared param`);

  // ---- rebuildOn keys are baked, not uniforms ----
  for (const key of meta.rebuildOn ?? []) {
    ok(handle.uniforms[key] === undefined, `${tag} '${key}' is baked into the graph, not a uniform`);
  }

  // ---- setParam per declared type ----
  for (const p of meta.params) {
    if ((meta.rebuildOn ?? []).includes(p.key)) continue;
    const type = p.type ?? 'float';
    if (type === 'float') {
      const target = (p.min + p.max) / 2;
      handle.setParam(p.key, target);
      ok(handle.uniforms[p.key].value === target && handle.params[p.key] === target,
        `${tag} setParam updates float '${p.key}'`);
    } else if (type === 'color') {
      handle.setParam(p.key, 0x123456);
      const c = handle.uniforms[p.key].value;
      ok(c instanceof THREE.Color && c.getHex() === 0x123456,
        `${tag} setParam updates color '${p.key}'`);
    } else if (type === 'vec3') {
      handle.setParam(p.key, [1, 2, 3]);
      const v = handle.uniforms[p.key].value;
      ok(v.x === 1 && v.y === 2 && v.z === 3, `${tag} setParam updates vec3 '${p.key}' from an array`);
      handle.setParam(p.key, { x: 4, y: 5, z: 6 });
      ok(v.x === 4 && v.y === 5 && v.z === 6, `${tag} setParam updates vec3 '${p.key}' from an object`);
    }
  }

  ok(handle.setParam('definitely-not-a-param', 1) === false,
    `${tag} setParam rejects an undeclared key`);

  // setParams applies a batch.
  const floatKeys = meta.params
    .filter(p => (p.type ?? 'float') === 'float' && !(meta.rebuildOn ?? []).includes(p.key));
  if (floatKeys.length >= 2) {
    const [a, b] = floatKeys;
    handle.setParams({ [a.key]: a.min, [b.key]: b.min });
    ok(handle.params[a.key] === a.min && handle.params[b.key] === b.min,
      `${tag} setParams applies a batch`);
  }

  // ---- overrides at construction ----
  const first = floatKeys[0];
  if (first) {
    const custom = mod.create({ params: { [first.key]: first.max } });
    ok(custom.params[first.key] === first.max, `${tag} create honours a param override`);
    custom.dispose();
  }

  handle.update(1 / 60, 1.0);   // must not throw
  handle.dispose();
  ok(true, `${tag} update and dispose run clean`);
}

// ---- resolveParams ignores unknown keys ----
const someMeta = (await DEMOS[0].load()).meta;
const resolved = resolveParams(someMeta, { nonsense: 42 });
ok(!('nonsense' in resolved), 'resolveParams drops undeclared keys');
ok(paramSpec(someMeta, someMeta.params[0].key) !== null, 'paramSpec finds a declared param');
ok(paramSpec(someMeta, 'nonsense') === null, 'paramSpec returns null for an undeclared param');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
