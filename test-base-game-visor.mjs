// The visor in base-game: night vision and the two thermal palettes from vision-modes.js.
//
// The thing worth testing is not the palette (test-vision-modes.mjs already covers that) but the
// claim the whole feature rests on: every material a player can see must be able to carry a heat
// tag. A material that cannot renders lit and in colour inside a heat frame, which is backwards.
// So this builds the real body materials, the real batch materials and a converted GLB material,
// and asserts tagScene() leaves nothing behind.
import * as THREE_WEBGPU from 'three/webgpu';
import { vec3, vec4, uniform, float } from 'three/tsl';
import { buildMaterial } from './tsl-build-check.mjs';
import { readFileSync } from 'node:fs';
import { tagScene, heatTag, HEAT, setVisionMode, visionMode, uIR, VISION_MODES } from './vision-modes.js';
import { createBodyPartBatches } from './body-part-batches.js';

let pass = 0, fail = 0;
const ok = (condition, message) => { if (condition) pass++; else { fail++; console.error('FAIL:', message); } };

// The page's THREE is the WebGPU build, which is what makes the node twins available. Node's bare
// 'three' is the WebGL build and has none of them, which is why the body modules fall back.
const THREE = THREE_WEBGPU;
ok(!!THREE.MeshStandardNodeMaterial, 'the webgpu build is what the page imports, and it has the node materials');

// ---- the mode switch ----
ok(VISION_MODES.length === 4 && VISION_MODES[0] === 'rgb', 'four modes, and the first is plain sight');
setVisionMode('rgb');
ok(uIR.value === 0, 'plain sight is not an infrared mode');
setVisionMode('nvg');
ok(uIR.value === 0, 'night vision is an intensifier, not a heat sensor, so it is not IR either');
setVisionMode('whot');
ok(uIR.value === 1 && visionMode() === 'whot', 'white hot is IR');
setVisionMode('bhot');
ok(uIR.value === 1, 'and so is black hot');
setVisionMode('rgb');

// ---- the instanced bodies: every role material must take a tag ----
{
  const scene = new THREE.Scene();
  const batches = createBodyPartBatches({ THREE, scene, capacity: 8 });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const matrix = new THREE.Matrix4();
  batches.beginFrame();
  for (const role of ['shell', 'plate', 'trim', 'accent', 'metal', 'rubber', 'fabric', 'visor', 'eye',
    'skin', 'hair', 'sclera', 'pupil', 'mouth', 'cloth']) {
    batches.add(geo, role, matrix, new THREE.Color(0x3366ff));
  }
  batches.endFrame();
  const swept = tagScene(scene);
  ok(swept.tagged > 0, 'the sweep tags the instanced body materials');
  ok(swept.untaggable.length === 0,
    `every body role can carry heat; these could not: ${swept.untaggable.join(', ')}`);
}

// ---- the per-instance colour question ----
// three multiplies instanceColor into colorNode and nothing else (build: "INSTANCED COLORS", where
// colorNode = instanceColor.mul(colorNode) feeds diffuseColor). heatTag sends a LIT material's heat
// out through emissiveNode instead, so a bot's team colour cannot change how hot it looks. On an
// UNLIT material the colour is the output, and there the tint does reach the heat -- which is the
// limitation vision-modes.js records for the flight sim's debris pools.
{
  const lit = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  heatTag(lit, HEAT.skin);
  ok(!!lit.emissiveNode, 'a lit material carries its heat on the emissive, which instanceColor never touches');
  ok(!!lit.colorNode, 'and its diffuse is driven to black under IR, so lighting cannot reach the picture');
  ok(lit.userData.heat === HEAT.skin, 'the heat is recorded on the material');

  const unlit = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
  heatTag(unlit, HEAT.fire);
  ok(!!unlit.colorNode && !unlit.emissiveNode, 'an unlit material has only the one channel, so its heat is the colour');

  // The eye is the one unlit body role. body-part-batches never gives it a per-instance colour, so
  // the tint that would reach an unlit heat value is never allocated in the first place.
  const html = readFileSync(new URL('./body-part-batches.js', import.meta.url), 'utf8');
  ok(html.includes('eye role is never colored'), 'the one unlit body role is documented as never tinted');
}

// ---- a material that owns a colour graph is wrapped, never overwritten ----
// This is the one that would break the page rather than just look wrong. heatTag builds colorNode
// from the material's flat `.color`, so tagging the terrain splat, the sky gradient or the water
// would throw the whole graph away in EVERY mode, plain sight included.
{
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  const splat = vec4(vec3(uniform(0.2), uniform(0.4), uniform(0.6)).mul(float(3.14159)), 1);
  const roughGraph = uniform(0.77).mul(float(2.71828));
  m.colorNode = splat;
  m.roughnessNode = roughGraph;
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), m));
  ok(tagScene(scene, HEAT.terrain).untaggable.length === 0, 'a material with its own colour graph can still take a heat');
  ok(m.userData.irWrapped === true, 'and it is recorded as wrapped rather than replaced');

  setVisionMode('whot');
  const built = await buildMaterial(m, new THREE.BoxGeometry());
  const frag = built.fragment;
  ok((frag.match(/3\.14159/g) || []).length === 1,
    'the wrapped graph is built once, not once for the colour and again for the alpha');
  ok((frag.match(/2\.71828/g) || []).length >= 1, "and the material's own roughness graph survives too");
  setVisionMode('rgb');

  // A vec3 colour graph has no alpha of its own. three pads it with 1 when it converts colorNode,
  // and the wrap leans on the same conversion, so a vec3 graph does not come out invisible.
  const m3 = new THREE.MeshBasicNodeMaterial();
  m3.colorNode = vec3(uniform(0.5), uniform(0.5), uniform(0.5));
  heatTag(m3, HEAT.cold);
  const built3 = await buildMaterial(m3, new THREE.BoxGeometry());
  ok(/1\.0\s*\)/.test(built3.fragment), 'a vec3 graph keeps a solid alpha through the wrap');
}

// ---- the heat table ----
{
  const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  ok(html.includes('VISOR_HEATS'), 'base-game names what each thing radiates');
  // The whole point: people must be the warmest thing that is not on fire.
  ok(html.includes("['BodyBatch:', HEAT.skin]") && html.includes("['proceduralPlayerBody', HEAT.skin]"),
    'both the instanced bodies and the local one are tagged as skin');
  ok(html.includes("['skyDome', HEAT.sky]"), 'the sky is cold, so bodies read against it');
  ok(HEAT.skin > HEAT.terrain && HEAT.skin > HEAT.sky && HEAT.skin > HEAT.water,
    'skin is warmer than the ground, the sky and the water');
  ok(HEAT.fire > HEAT.skin, 'and fire is warmer than skin');
  const sky = readFileSync(new URL('./sky.js', import.meta.url), 'utf8');
  ok(sky.includes("dome.name = 'skyDome'"), 'the sky dome carries the name the table looks for');
  // Streamed terrain and lazily loaded trees arrive long after boot.
  ok(html.includes('visorSweepTick') && html.includes("settings.visorMode !== 'rgb' && (visorSweepTick"),
    'the sweep repeats while the visor is up, so material built later still gets a heat');
}

// ---- a classic material is still refused, which is why the conversions matter ----
{
  const classic = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  heatTag(classic, HEAT.skin);
  ok(classic.userData.irUntaggable === true && !classic.userData.irTagged,
    'a classic material cannot carry a node, and says so rather than pretending');
  // three's own converter is what base-game hands the weapon mount for GLB materials. The full node
  // library is not exported, so take it off a renderer the way the page does. No GPU is touched:
  // the library exists from the constructor, before init().
  const renderer = new THREE.WebGPURenderer({ canvas: { getContext: () => null, addEventListener() {}, style: {} } });
  const converted = renderer.library.fromMaterial(new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.4 }));
  ok(converted?.isNodeMaterial === true, "three's own fromMaterial turns a GLB material into a node material");
  ok(converted.roughness === 0.4, 'and carries its properties across');
  heatTag(converted, HEAT.metal ?? HEAT.cold);
  ok(converted.userData.irTagged === true, 'so a converted weapon material can carry heat');
}

// ---- wiring ----
{
  const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  const markers = ['vision-modes.js', 'visionNode(', 'applyVisor(', 'setVisionMode(', 'tagScene(',
    "event.code === 'KeyH'", "'visorMode'", 'convertMaterial:', 'renderer.library.fromMaterial'];
  for (const marker of markers) ok(html.includes(marker), `base-game.html wires ${marker}`);

  // One pipeline, not two: a second pass(scene, camera) would render the whole scene twice.
  ok(html.split('new RenderPipeline(').length === 2, 'there is exactly one post pipeline');
  ok(!html.includes('createVisionComposite'), 'the visor uses the shared pipeline, not its own composite');
  // The palette runs on display-referred colour, so the pipeline must not encode a second time.
  ok(html.includes('postPipeline.outputColorTransform = false'),
    'the pipeline is told not to apply the output transform twice');
  // The pipeline now runs for the visor too, so depth of field has to be able to turn itself off.
  ok(html.includes('dofApplied.enabled = settings.dofEnabled'),
    "depth of field's enabled uniform follows its setting rather than being pinned on");
  ok(html.includes("settings.dofEnabled || settings.visorMode !== 'rgb'"),
    'the direct render is kept for plain sight with depth of field off');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
