// test-vision-modes.mjs — the thermal view is heat, not light.
//
// The composite needs a GPU and is not tested. What is: that tagging a material actually rewires it
// so lighting cannot reach the picture under IR, that a scene sweep leaves nothing untagged that
// could be tagged, that the palettes are monotonic and inverse where they should be, and that the
// flight demo has opted its own TSL materials in.
//
//   node test-vision-modes.mjs

import { readFileSync } from 'node:fs';
import {
  MeshStandardNodeMaterial, MeshBasicNodeMaterial, LineBasicNodeMaterial, MeshBasicMaterial,
  Mesh, Group, BoxGeometry,
} from 'three/webgpu';
import {
  heatTag, tagScene, heatMix, PALETTE, lumaOf, HEAT, DEFAULT_HEAT, VISION_MODES, VISION_LABEL,
  setVisionMode, visionMode, uIR, uMode,
} from './vision-modes.js';

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

// ---------------------------------------------------------------------------
console.log('--- 1. tagging rewires the material, once ---');
// ---------------------------------------------------------------------------
{
  const lit = new MeshStandardNodeMaterial({ color: 0xff0000 });
  heatTag(lit, HEAT.skin);
  ok('a lit material gets colour, emissive, roughness and metalness nodes',
    !!lit.colorNode && !!lit.emissiveNode && !!lit.roughnessNode && !!lit.metalnessNode);
  ok('and remembers its heat', lit.userData.irTagged === true && lit.userData.heat === HEAT.skin);
  const before = lit.colorNode;
  heatTag(lit, 0.9);
  ok('tagging twice is a no-op, not a stack of mixes', lit.colorNode === before && lit.userData.heat === HEAT.skin);

  const flat = heatTag(new MeshBasicNodeMaterial(), HEAT.fire);
  ok('an unlit material gets a colour node only', !!flat.colorNode && !flat.emissiveNode);
  const line = heatTag(new LineBasicNodeMaterial(), HEAT.tracer);
  ok('a line material can be tagged too — the tracers', line.userData.irTagged === true);

  const classic = heatTag(new MeshBasicMaterial(), 1);
  ok('a classic material is refused and marked, not silently accepted',
    classic.userData.irTagged === false && classic.userData.irUntaggable === true);
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. the scene sweep ---');
// ---------------------------------------------------------------------------
{
  const g = new Group();
  const own = new MeshStandardNodeMaterial(); own.userData.irTagged = true;   // a terrain-style opt-in
  g.add(new Mesh(new BoxGeometry(), new MeshStandardNodeMaterial()));
  g.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
  g.add(new Mesh(new BoxGeometry(), own));
  g.add(new Mesh(new BoxGeometry(), [new MeshBasicNodeMaterial(), new MeshBasicNodeMaterial()]));
  const r = tagScene(g);
  ok('tags every untagged node material, including multi-material meshes', r.tagged === 3, `${r.tagged}`);
  ok('reports the classic one it could not', r.untaggable.length === 1);
  ok('and leaves a material that opted in alone', own.colorNode === null || own.colorNode === undefined);
  const r2 = tagScene(g);
  ok('a second sweep finds nothing to do', r2.tagged === 0 && r2.untaggable.length === 0);
  const tagged = g.children[0].material;
  ok('untagged things get the default heat, which is cool and visible', tagged.userData.heat === DEFAULT_HEAT && DEFAULT_HEAT > 0.1);
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. modes and uniforms ---');
// ---------------------------------------------------------------------------
{
  ok('four modes, each labelled', VISION_MODES.length === 4 && VISION_MODES.every((m) => VISION_LABEL[m]));
  setVisionMode('rgb'); ok('rgb: not IR', uIR.value === 0 && uMode.value === 0 && visionMode() === 'rgb');
  setVisionMode('nvg'); ok('nvg: still not IR — it amplifies light, it does not see heat', uIR.value === 0 && uMode.value === 1);
  setVisionMode('whot'); ok('white hot: IR on', uIR.value === 1 && uMode.value === 2);
  setVisionMode('bhot'); ok('black hot: IR on', uIR.value === 1 && uMode.value === 3);
  setVisionMode('nonsense'); ok('an unknown mode falls back to rgb rather than a random index', uMode.value === 0 && uIR.value === 0);
  ok('heatMix returns a node', !!heatMix(HEAT.sky, 0.1) && typeof heatMix === 'function');
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. palettes ---');
// ---------------------------------------------------------------------------
{
  const mono = (f) => { let last = -1; for (let l = 0; l <= 1; l += 0.05) { const v = f(l)[1]; if (v < last - 1e-9) return false; last = v; } return true; };
  ok('nvg brightens with luminance', mono(PALETTE.nvg));
  ok('nvg is green — the phosphor', PALETTE.nvg(0.5)[1] > PALETTE.nvg(0.5)[0] * 3 && PALETTE.nvg(0.5)[1] > PALETTE.nvg(0.5)[2] * 2);
  ok('nvg has gain: mid grey comes out near full', PALETTE.nvg(0.4)[1] > 0.9);
  ok('white hot brightens with heat', mono(PALETTE.whot));
  ok('and black hot is its inverse', [0, 0.2, 0.5, 0.8, 1].every((l) => Math.abs(PALETTE.whot(l)[0] + PALETTE.bhot(l)[0] - 1) < 1e-9));
  ok('the sky\'s heat reads black under white hot', PALETTE.whot(HEAT.sky)[0] === 0);
  ok('and an exhaust reads white', PALETTE.whot(HEAT.exhaust)[0] === 1);
  ok('luma weights sum to one', Math.abs(lumaOf(1, 1, 1) - 1) < 1e-9);
  ok('the heat table orders things sensibly',
    HEAT.sky < HEAT.water && HEAT.water < HEAT.terrain && HEAT.terrain < HEAT.skin && HEAT.skin < HEAT.engine && HEAT.engine <= HEAT.exhaust);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. the flight demo opted its own materials in ---');
// ---------------------------------------------------------------------------
{
  const src = readFileSync('./demos/flight-sim.html', 'utf8');
  ok('terrain: diffuse to black and heat into emissive under IR',
    /mat\.colorNode = mix\(select\(lit, terrainColor, vec3\(0, 0, 0\)\), vec3\(0, 0, 0\), uIR\)/.test(src)
    && /mat\.emissiveNode = mix\(select\(lit, vec3\(0, 0, 0\), debugColor\), terrainHeat, uIR\)/.test(src)
    && /mat\.userData\.irTagged = true/.test(src));
  ok('sky and clouds mix to their heat and mark themselves', /skyMat\.userData\.irTagged = true/.test(src)
    && /cloudMat\.colorNode = heatMix\(/.test(src) && /return heatMix\(c, float\(HEAT\.sky\)/.test(src));
  ok('the tracers are a node line material, tagged hot', /new LineBasicNodeMaterial\(/.test(src) && /HEAT\.tracer\)/.test(src));
  ok('the pools are tagged fire and smoke', /additive \? HEAT\.fire : HEAT\.smoke/.test(src));
  ok('the render switches on the mode', /if \(visionMode === 'rgb'\) renderer\.render\(scene, camera\);\s*else vision\.render\(\);/.test(src));
  ok('a scene sweep runs at boot and on every mode change', (src.match(/tagScene\(scene\)/g) || []).length >= 2);
  const mod = readFileSync('./vision-modes.js', 'utf8');
  ok('the composite applies renderOutput itself and tells the pipeline not to',
    /outputColorTransform = false/.test(mod) && /renderOutput\(scenePass\.getTextureNode\(\)\)/.test(mod));
}

console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
