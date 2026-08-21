// Static checks on demos/pokemon-park.html

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const PAGE = 'demos/pokemon-park.html';
let pass = 0, fail = 0;
const problems = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

const html = readFileSync(PAGE, 'utf8');

// ===================== the module parses =====================

const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
ok('the page has a module script', !!m);
const js = m ? m[1] : '';

{
  const tmp = join(tmpdir(), 'pokemon-park-check.mjs');
  try {
    writeFileSync(tmp, js);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    ok('the module script parses', true);
  } catch (e) {
    ok('the module script parses', false, String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 240));
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// ===================== every imported name exists =====================

{
  const imports = [...js.matchAll(/import\s+(?:\*\s+as\s+\w+|\{([^}]*)\}|(\w+))\s+from\s+'(\.\.?\/[^']+)'/g)];
  ok('the page imports from repo modules', imports.length > 8, `${imports.length} relative imports`);
  let missing = [];
  let unresolved = [];
  for (const [, named, dflt, spec] of imports) {
    const path = resolve(dirname(PAGE), spec.split('?')[0]);
    if (!existsSync(path)) { unresolved.push(spec); continue; }
    let mod;
    try { mod = await import(`file://${path.replace(/\\/g, '/')}`); }
    catch (e) { unresolved.push(`${spec} (${String(e.message).slice(0, 80)})`); continue; }
    if (dflt && !('default' in mod)) missing.push(`${spec}: default`);
    for (const raw of (named || '').split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!(name in mod)) missing.push(`${spec}: ${name}`);
    }
  }
  ok('every relative import resolves to a file that loads', unresolved.length === 0, unresolved.join('; '));
  ok('every imported name is actually exported', missing.length === 0, missing.join('; '));
}

// ===================== the light pool ordering =====================

{
  const poolAt = js.indexOf('const lightPool = []');
  const groundAt = js.indexOf('buildParkGround({');
  const waterAt = js.indexOf('createWaterSystem({');
  const skyAt = js.indexOf('createSky({');
  const creaturesAt = js.indexOf('createParkCreatures({');
  ok('the move light pool exists', poolAt > 0);
  ok('and is built before the ground', poolAt < groundAt, `pool at ${poolAt}, ground at ${groundAt}`);
  ok('and before the water', poolAt < waterAt);
  ok('and before the sky', poolAt < skyAt);
  ok('and before any creature', poolAt < creaturesAt);
  ok('and the pool is fixed size, never grown', /for \(let i = 0; i < 6; i\+\+\)/.test(js) && !/scene\.add\(new THREE\.PointLight/.test(js));
  ok('acquire survives an empty pool', /return l \|\| null/.test(js),
    'every fx module must be able to be handed null');
}

// ===================== the frame loop's two guards =====================

{
  ok('the frame loop drops re-entrant vsyncs', /if \(_frameBusy\) return;/.test(js),
    'setAnimationLoop does not await an async callback; overlapping submits recycle each other\'s buffers');
  ok('and always clears the busy flag', /\} finally \{ _frameBusy = false; \}/.test(js));
  ok('the normal play path follows display vsync instead of forcing 60 fps',
    /const FPS_CAP_URL = FPS_CAP_VALUES\.has\(fpsCapQuery\) \? fpsCapQuery : 'off';/.test(js)
      && !/Q\.get\('fpsCap'\) \?\? '60'/.test(js),
    'fixed-rate callback skipping judders when 60 is not a divisor of the display refresh');
  ok('the fps cap has the vsync tolerance', /fpsCapMs - 0\.5/.test(js),
    'explicit caps remain available for profiling; a hard comparison locks a 60 Hz display to 30');
  ok('sky disposals are drained after the submit',
    js.indexOf('flushDisposals') > js.indexOf('renderer.render(scene, camera)'),
    'draining before the submit frees objects the submit still references');
}

// ===================== subsystem isolation controls =====================

{
  ok('creatures can be disabled without changing population code',
    /const CREATURES_MODE = Q\.get\('creatures'\)/.test(js)
      && /const POPULATION = CREATURES_MODE === 'off'\s*\? 0/.test(js));
  ok('zero is a valid explicit population',
    /Math\.max\(0, Number\.isFinite\(populationQuery\)/.test(js));
  ok('terrain rendering can be isolated while height queries remain live',
    /ground\.mesh\.visible = TERRAIN_MODE !== 'off'/.test(js)
      && /scene\.add\(ground\.mesh\)/.test(js));
  ok('shadow rendering can be disabled at the renderer and light',
    /renderer\.shadowMap\.enabled = SHADOWS_MODE !== 'off'/.test(js)
      && /rig\.dirLight\.castShadow = SHADOWS_MODE !== 'off'/.test(js));
  const liveToggleCount = (js.match(/subsystemToggle\('/g) || []).length;
  ok('the controls expose live subsystem toggles',
    /header\('Subsystems', true\)/.test(js) && liveToggleCount >= 6);
  ok('disabled subsystems stop their frame work',
    /if \(subsystemEnabled\.water && waterRef\) waterRef\.update/.test(js)
      && /if \(subsystemEnabled\.flora && flora\) \{\s*await flora\.update/.test(js)
      && /if \(subsystemEnabled\.creatures && creatureRuntime\.simulation\)/.test(js)
      && /if \(subsystemEnabled\.sky && skyRef\)/.test(js));
  ok('the subsystem panel has live performance feedback',
    /subsystemPerf\.textContent = drawCalls/.test(js));
  ok('Pokémon runtime paths have independent live controls',
    /toggle\('Render models'/.test(js)
      && /toggle\('Simulation \+ posing'/.test(js)
      && /toggle\('Streaming \+ spawning'/.test(js)
      && /toggle\('Move casting'/.test(js));
  ok('Pokémon simulation and streaming have separate timing spans',
    /creaturePerf\.streamLast = performance\.now\(\) - streamStartedAt/.test(js)
      && /creaturePerf\.simulationLast = performance\.now\(\) - simulationStartedAt/.test(js)
      && /creaturePerfEl\.textContent = 'Simulation '/.test(js));
  ok('move effects are warmed during boot, including pooled palette variants',
    /async function warmMoveEffects\(\)/.test(js)
      && /POOLED_MOVE_FX/.test(js)
      && /renderer\.compileAsync\(inst\.group, camera, scene\)/.test(js)
      && /await warmMoveEffects\(\)/.test(js));
  ok('autonomous move setup is limited to one cast per frame',
    /cast: \(c\) => \{ if \(Math\.random\(\) < params\.moveFrequency\) enqueueCast\(c\); \}/.test(js)
      && /processOnePendingCast\(\)/.test(js)
      && /MAX_PENDING_CASTS/.test(js));
  ok('move casting reports synchronous setup time in the live panel',
    /movePerf\.castLast = performance\.now\(\) - castStartedAt/.test(js)
      && /movePerf\.castPeak/.test(js)
      && /movePerf\.lastMove/.test(js));
  ok('flora has independent live render and work isolation controls',
    /header\('Flora isolation', true\)/.test(js)
      && /toggle\('Grass rendering'/.test(js)
      && /toggle\('Grass compute'/.test(js)
      && /toggle\('Tree rendering'/.test(js)
      && /toggle\('Tree stream \+ cull'/.test(js)
      && /toggle\('Rock rendering'/.test(js)
      && /toggle\('Rock stream \+ cull'/.test(js)
      && /toggle\('Flora collisions'/.test(js)
      && /toggle\('Flora shadows'/.test(js));
  ok('flora update gates reach the individual grass, tree, and rock paths',
    /flora\.update\(camera\.position, now \/ 1000, \{/.test(js)
      && /grass: floraRuntime\.grassUpdate/.test(js)
      && /trees: floraRuntime\.treesUpdate/.test(js)
      && /rocks: floraRuntime\.rocksUpdate/.test(js));
  ok('tree isolation exposes bark, leaves, size, density, distance, LOD, culling, and shadows',
    /header\('Tree isolation', true\)/.test(js)
      && /toggle\('Bark geometry'/.test(js)
      && /toggle\('Leaf geometry'/.test(js)
      && /numberInput\('treeScalePct'/.test(js)
      && /slider\('treeLeafDensity', 'Leaf density'/.test(js)
      && /slider\('treeLeafSize', 'Leaf size'/.test(js)
      && /slider\('treeDensityPct'/.test(js)
      && /slider\('treeDrawDistance'/.test(js)
      && /slider\('treeLod0'/.test(js)
      && /slider\('treeLod2'/.test(js)
      && /toggle\('Frustum cone culling'/.test(js)
      && /toggle\('Bark shadows'/.test(js)
      && /toggle\('Leaf shadows'/.test(js));
  ok('tree density rebuilds on slider release rather than every drag event',
    /slider\('treeDensityPct',[\s\S]{0,180}setTreeDensity[\s\S]{0,40}, true\);/.test(js)
      && /if \(commitOnly\)/.test(js));
  const forestGpu = readFileSync('forest-gpu.js', 'utf8');
  ok('forest render-part masks survive variant visibility rebuilds',
    /const renderParts =/.test(forestGpu)
      && /function syncRenderParts\(\)/.test(forestGpu)
      && /variantPopulated/.test(forestGpu)
      && /setRenderParts\(partial/.test(forestGpu)
      && /syncRenderParts\(\);/.test(forestGpu));
  const parkFlora = readFileSync('park-flora.js', 'utf8');
  ok('tree size is an unlimited number spinner, not a bounded slider',
    /function numberInput[\s\S]{0,500}inp\.type = 'number'/.test(js)
      && /numberInput\('treeScalePct', 'Tree size %', 1, 5/.test(js)
      && !/slider\('treeScalePct'/.test(js));
  ok('whole-tree size follows Bot Viewer placement-record scaling',
    /let treeSizeScale = 1/.test(parkFlora)
      && /scale: r\.scale \* treeSizeScale/.test(parkFlora)
      && /r0 \* r\.scale/.test(parkFlora));
  ok('leaf density and size follow Bot Viewer species-relative palette rebaking',
    /sp\.leaves\?\.count \?\? 10\) \* treeLeafDensity/.test(parkFlora)
      && /leafSize: treeLeafScale/.test(parkFlora)
      && /createForestPaletteForPark/.test(parkFlora)
      && /setTreeLeafOptions\(\{ size = treeLeafScale, density = treeLeafDensity \}/.test(parkFlora)
      && !/forest\?\.setLeafScale/.test(js));
  ok('tree edits preserve the active chunk window and leaf rebakes swap only after prepopulation',
    /nextForest\.setChunks\(active\);[\s\S]{0,100}await nextForest\.update\(\)/.test(parkFlora)
      && /forestGPU\?\.setChunks\(treeBatch\)/.test(parkFlora)
      && !/setTreeScale\(scale\)[\s\S]{0,300}resetTreeStreaming\(\)/.test(parkFlora));
  ok('tree density atomically regenerates active placement and collision chunks together',
    /let treeDensityScale = 1/.test(parkFlora)
      && /count: FOREST_PARAMS\.count \* treeDensityScale/.test(parkFlora)
      && /function rebuildActiveTreePlacements\(\)/.test(parkFlora)
      && /forestGPU\.setChunks\(batch\)/.test(parkFlora)
      && /trunkIndex\.clearTrunks/.test(parkFlora));
  ok('moves have independent rendering, update, light, core, particle, and decal controls',
    /header\('Move isolation', true\)/.test(js)
      && /toggle\('All effect rendering'/.test(js)
      && /toggle\('Active effect updates'/.test(js)
      && /toggle\('Move lights'/.test(js)
      && /toggle\('Core geometry'/.test(js)
      && /toggle\('Particles \+ debris'/.test(js)
      && /slider\('moveParticlePct'/.test(js)
      && /toggle\('Ground decals'/.test(js));
  ok('move update time and occupied lights are reported live',
    /movePerf\.updateLast = performance\.now\(\) - moveUpdateStartedAt/.test(js)
      && /lightPool\.filter\(\(light\) => light\.userData\.busy\)/.test(js));
  const moveParts = readFileSync('moves/move-parts.js', 'utf8');
  ok('shared particle and debris kits obey the live particle budget',
    /setMoveComponentRuntime/.test(moveParts)
      && (moveParts.match(/MOVE_COMPONENT_RUNTIME\.particleScale/g) || []).length >= 4
      && (moveParts.match(/moveComponent = 'particles'/g) || []).length >= 2);
  ok('shared ground decals are tagged for live isolation',
    /moveComponent = 'decals'/.test(moveParts));
}

// ===================== state goes to a file =====================

{
  ok('the page uses the disk store', /from '\.\.\/disk-store\.js'/.test(js));
  ok('and reads it before anything uses it', /await store\.load\(\);/.test(js),
    'reading it later lets an empty default overwrite the file');
  const uses = [...js.matchAll(/localStorage/g)].map((x) => {
    const line = js.slice(js.lastIndexOf('\n', x.index) + 1, js.indexOf('\n', x.index));
    return line.trim();
  });
  const stray = uses.filter((l) => !/storage: localStorage/.test(l) && !l.startsWith('//'));
  ok('localStorage is only the fallback cache, never a store', stray.length === 0, stray.join(' | '));
  ok('a closing tab flushes with a beacon',
    /addEventListener\('pagehide'/.test(js) && /sendBeacon/.test(js),
    'fetch is cancelled during unload, so a debounced autosave would lose the last edit');
}

// ===================== the client and the server agree on filenames =====================

{
  const serve = readFileSync('serve.py', 'utf8');
  ok('serve.py has the write route', /_SAFE_PARK_FILENAME/.test(serve) && /def save_park/.test(serve));
  const name = js.match(/const SESSION_FILE = '([^']+)'/)?.[1];
  ok('the page names its file as a constant', !!name, String(name));
  const pattern = serve.match(/_SAFE_PARK_FILENAME = re\.compile\(\s*r'([^']+)'/s)?.[1] ?? '';
  const re = new RegExp(pattern);
  // A rename on one side and not the other is a silent 400 and a lost session.
  ok('the server accepts the live document', re.test(name), `${name} against ${pattern}`);
  ok('and the timestamped snapshot the button builds',
    /park-session-\$\{stamp\}\.json/.test(js) && re.test('park-session-20260818-120000.json'));
  ok('the route is dispatched', /self\.path\.startswith\('\/api\/save-park'\)/.test(serve));
}

// ===================== the arrangements a screenshot cannot show =====================

{
  ok('the field is sampled for feet and physics', /const terrainHeight = \(x, z\) => park\.map\.heightAt\(x, z\)/.test(js));
  ok('the mesh stride divides the field',
    (() => {
      const t = readFileSync('park-biomes.js', 'utf8');
      const res = Number(t.match(/resolution:\s*(\d+)/)?.[1]);
      const st = Number(t.match(/meshStride:\s*(\d+)/)?.[1]);
      return res && st && (res - 1) % st === 0;
    })(),
    'otherwise the drawn sheet stops short of the park edge');
  ok('the field effect is banned rather than quietly wrong', /FX_BANNED = new Set\(\['field'\]\)/.test(js),
    'fx-field.js anchors to a hardcoded world origin, which in a 2.4 km park is the middle of the meadow');
  ok('makeLine uses a step suited to a big world', /step: 0\.4[5-9]|step: 0\.[5-9]/.test(js),
    'it calls terrainHeight once per step; the demo\'s 0.08 over 30 m is 375 samples a cast');
  ok('the body is fed horizontal velocity only', /_bodyVel\.set\(playerVelocity\.x, 0, playerVelocity\.z\)/.test(js),
    'feeding it fall velocity makes a jumping body sprint in mid-air');
  ok('the body is fed the standing height, not the lerped capsule', /height: fp\.heightStand/.test(js),
    'the rig applies the crouch itself, so a lerped height squashes it twice');
  ok('concurrent moves are capped', /MAX_LIVE_MOVES/.test(js));
  ok('and a dropped move is disposed, not just forgotten',
    /liveMoves\.shift\(\)[\s\S]{0,60}dispose\(\)/.test(js), 'every cast holds pooled geometry until disposed');
}

// ===================== the interface it promises =====================

{
  const domIds = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((x) => x[1]));
  for (const id of ['err', 'boot', 'hud', 'toast', 'minimap', 'guide']) {
    ok(`#${id} exists and is wired`, domIds.has(id) && js.includes(`'${id}'`));
  }
  ok('the error overlay catches pre-module failures', /window.addEventListener\('error'/.test(html),
    'a page that fails to start must not look like a page that started and drew nothing');
  for (const [key, what] of [['KeyV', 'first/third person'], ['KeyF', 'the field guide'], ['KeyM', 'the map'], ['KeyP', 'pause'], ['KeyH', 'hiding the interface']]) {
    ok(`${what} is bound`, js.includes(`'${key}'`));
  }
}

// ===================== the camera actually turns =====================

{
  // Writing look.yaw and never composing camera.rotation from it spins the body and leaves the
  // camera pointing where it started.
  ok('the mouse writes the authoritative look angles', /look\.yaw\s*-=\s*e\.movementX/.test(js));
  ok('and camera.rotation is composed from them every frame',
    /camera\.rotation\.set\([\s\S]{0,220}look\.yaw/.test(js));
  ok('the walk direction comes off look.yaw, not the camera matrix',
    /_fwd\.set\(-sy/.test(js) && !/setFromMatrixColumn\(camera\.matrixWorld/.test(js),
    'visual tilt and lean must not steer the player');
  ok('the camera is placed after the view feel is composed',
    js.indexOf('updateViewFeel(rawDt)') > 0 && js.lastIndexOf('placeCamera(rawDt);') > js.indexOf('updateViewFeel(rawDt)'));
  ok('the old pull-in solver is isolated behind the Pokemon legacy profile',
    /function placePokemonLegacyCamera[\s\S]{0,2400}resolveCollision/.test(js)
      && /cameraProfile === CAMERA_PROFILE_PARK\) placePokemonLegacyCamera/.test(js));
  ok('the boom hangs off a smoothed eye, not the collider itself',
    /camEye\.y = easeToward\(camEye\.y/.test(js) && !/camera\.position\.copy\(playerCollider\.end\)/.test(js),
    'the raw capsule top carries every push-out and step as a one-frame snap');
  ok('and a long jump snaps rather than dragging the view', /camEye\.distanceToSquared\(eye\) > CAM\.snapDist/.test(js));
  ok('the boom snaps in and eases out', /camDistNow = want < camDistNow \? want : easeToward/.test(js));
  ok('Bot Viewer v3 is the default camera profile',
    /let cameraProfile = restoredCameraProfile \|\| CAMERA_PROFILE_BOT/.test(js));
  ok('Environment Viewer profile directly couples the camera to the resolved eye',
    /function placeEnvironmentCamera\(\)[\s\S]{0,260}camera\.position\.copy\(eye\)/.test(js));
  ok('Bot Viewer profile reuses frame-rate-independent camera damping',
    /import \{ dampAlpha \} from '\.\.\/bot-camera-control\.js'/.test(js)
      && /function placeBotViewerCamera[\s\S]{0,1800}dampAlpha/.test(js));
  ok('and marches in fine steps rather than halving',
    /d -= CAM\.boomStep/.test(js) && !/dist \*= 0\.72/.test(js));
  ok('a species compiles its pipeline at load, not on first sight',
    /warmMaterials: \(obj\) => renderer\.compileAsync\(obj, camera, scene\)/.test(js));
  ok('species parsing and pipeline warm-up default to the boot screen',
    /const SPECIES_LOAD_MODE = Q\.get\('speciesLoad'\) === 'stream' \? 'stream' : 'preload';/.test(js)
      && /SPECIES_LOAD_MODE === 'preload' \? loadQueue\.length/.test(js));
  ok('legacy runtime species streaming remains an explicit A\/B mode',
    /Math\.min\(6, loadQueue\.length\)/.test(js) && /function pumpSpeciesLoads\(\)/.test(js));
  ok('species load one at a time', /while \(loading < 1 && loadQueue\.length\)/.test(js));
  ok('failed species are not requeued every streaming tick', /if \(creatures\.hasFailed\(r\.key\)\) continue;/.test(js));
  ok('repeated error text is deduplicated', /failedMessages\.has\(msg\)/.test(js) && /failedMessages\.add\(msg\)/.test(js));
  ok('one resident may activate per streaming tick', /maxActivations: 1/.test(js));
  ok('streaming waits for a frame with room', /rawDt < 0\.028/.test(js));
  ok('the HUD reports draw calls and triangles, so "is it culled" is answerable from the page',
    /renderer\.info\.render\.drawCalls/.test(js) && /renderer\.info\.render\.triangles/.test(js));
  ok('the HUD reports the worst frame, so a hitch is a number not an impression',
    /worst \$\{hitchMs\.toFixed\(0\)\} ms/.test(js));
}

// ===================== trails =====================

{
  const roadAt = js.indexOf('createRoadSystem(');
  const floraAt = js.indexOf('createParkFlora(');
  ok('the trails are cut before the flora is sown', roadAt > 0 && floraAt > roadAt,
    'the grass density grid is baked once, so the road clearance has to exist first');
  ok('and the flora is told where not to grow', /clearFn: roadClearsFlora/.test(js));
  ok('roads sample the drawn sheet, not the field',
    /heightAt: \(x, z\) => ground\.surfaceHeightAt/.test(js),
    'the two disagree by up to a cell, which is a road that floats');
  ok('a route that will not connect is reported', /built\.skipped/.test(js));
}

// ===================== trees and grass =====================

{
  // tree-textures resolves TEX_DIR against the DOCUMENT, and this page is in demos/. Passing the
  // default silently 404s every map and the trees render as their flat vertex colour, which three
  // of the four ez families authored as white.
  ok('the page points the tree textures out of demos/', /texDir: '\.\.\/textures'/.test(js));
  ok('and asks for the authored set', /treeTextures: [\s\S]{0,60}'authored'/.test(js));
  const dir = 'textures';
  for (const rel of ['leaves/oak.png', 'leaves/aspen.png', 'leaves/ash.png', 'leaves/pine.png']) {
    ok(`${rel} is on disk`, existsSync(resolve(dir, rel)));
  }
  ok('the bark set is on disk', existsSync(resolve(dir, 'bark/Bark014_1K-JPG/Bark014_1K-JPG_Color.jpg')));
}


{
  ok('the grass is handed the direction toward the sun', /setSunDir/.test(js));
  ok('the tree variant count is capped', /Number\(Q\.get\('treeVariants'\)/.test(js));
}

console.log(`\n${pass}/${pass + fail} static checks passed on ${PAGE}`);
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
