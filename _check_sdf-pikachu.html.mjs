// Static checks on demos/sdf-pikachu.html: does its module parse, and is the panel actually wired to it.
// The field and both bakes are checked for real by test-sdf-pikachu.mjs and test-sdf-mesh-bake.mjs; this
// only covers the shell, which is the part Node cannot import.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const html = readFileSync(new URL('./demos/sdf-pikachu.html', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const problems = [];
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; return true; }
  fail++; problems.push(`${label}${detail ? ' — ' + detail : ''}`);
  return false;
};

const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
ok(!!m, 'the page has a module script');
const js = m[1];

const tmp = join(tmpdir(), 'sdf-pikachu-check.mjs');
try {
  writeFileSync(tmp, js);
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  ok(true, 'the module script parses');
} catch (e) {
  ok(false, 'the module script parses', String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 240));
} finally {
  try { unlinkSync(tmp); } catch {}
}

// ---- the panel is wired ---------------------------------------------------------------------------
const domIds = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((x) => x[1]));
const referenced = new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((x) => x[1]));
const missing = [...referenced].filter((id) => !domIds.has(id));
ok(missing.length === 0, 'every $() target exists in the markup', missing.join(', '));

const controls = [...html.matchAll(/<(?:input|select|button)[^>]*\sid="([\w-]+)"/g)].map((x) => x[1]);
const dead = controls.filter((id) => !js.includes(`'${id}'`));
ok(dead.length === 0, 'no control in the panel is unwired', dead.join(', '));

// ---- both fields are reachable --------------------------------------------------------------------
const options = html.match(/<select id="field">([\s\S]*?)<\/select>/)?.[1] ?? '';
const kinds = [...options.matchAll(/value="(\w+)"/g)].map((x) => x[1]).sort();
ok(String(kinds) === 'boxes,volume', 'the field dropdown offers both bakes', String(kinds));
ok(/bakeVolume\(json, bin, images\)/.test(js), 'the volume bake gets the decoded textures too',
  'without them every bone falls back to grey');
ok(/uploadVolume\(field, baked\)/.test(js), 'and the tiles reach the atlas texture');
ok(/field\.u\.volume\.value = kind === 'volume'/.test(js), 'the shader is told which field it is marching');

// A bake is ~700 ms of blocked main thread, so the notice has to be painted before it starts, not after.
ok(/requestAnimationFrame\(\(\) => requestAnimationFrame\(r\)\)/.test(js),
  'the baking notice gets a frame to paint before the bake blocks',
  'setting textContent and baking in the same task shows the notice only once the bake is over');

// Both bakes are kept, so flipping the dropdown does not re-pay for one already made.
ok(/cache\.has\(key\)/.test(js) && /cache\.set\(key, out\)/.test(js), 'each bake is cached per species');
ok(/const key = `\$\{name\}\|\$\{kind\}`/.test(js), 'keyed by species AND kind, so the two do not overwrite');

// ---- the defaults, which are the thing that made it look like a blob ------------------------------
// A joint blend of 0.05 on a model normalised to one unit tall is a smoothing radius of 5% of body height:
// measured at 1.31% surface error against 0.13% at zero. It exists to close the seam a ROTATED bone tears
// open, and nothing on this page rotates a bone, so shipping it on by default melted the creature.
const field = readFileSync(new URL('./demos/sdf-pikachu-field.js', import.meta.url), 'utf8');
const sliderDefault = (id) => {
  const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
  return Number(tag.match(/value="([\d.]+)"/)?.[1] ?? NaN);
};
ok(sliderDefault('blend') === 0, 'the joint blend slider starts at zero', String(sliderDefault('blend')));
ok(/blend: uniform\(0\)/.test(field), 'and so does the uniform behind it');
ok(/const BLEND_FOR = \{ boxes: 0\.05, volume: 0 \}/.test(js),
  'the blend follows the bake: boxes leave real gaps at a joint, the volume chunks already overlap');
ok(/\$\('blend'\)\.dispatchEvent\(new Event\('input'\)\)/.test(js),
  'and switching bake pushes the new blend to the uniform, not only to the slider');
const thick = sliderDefault('thicken');
ok(thick > 0 && thick <= 0.003, `skin thickness starts small (${thick})`,
  '0.006 costs 0.65% surface error on its own, five times the base');
ok(new RegExp(`thicken: uniform\\(${thick}\\)`).test(field), 'and the uniform agrees with the slider');

// ---- colour comes from the texture, per voxel ------------------------------------------------------
ok(/tintTex/.test(field), 'there is a colour volume');
ok(/texture3D\(tintTex, tileUVW\(p, base\)\)/.test(field),
  'sampled at the SAME coordinate as the distance, so the two cannot drift apart');
ok(/const map = Fn\(\(\[p\]\) => \{[\s\S]{0,900}return res;/.test(field) && /const shade = Fn/.test(field),
  'distance and colour are separate passes',
  'carrying the tint through the march would fetch the colour volume on all 110 steps to use one');
ok(!/albedo\.assign\(r\.yzw\)/.test(field), 'and the march no longer carries an albedo it mostly discards');

// ---- the knobs that do nothing say so -------------------------------------------------------------
ok(/\$\(id\)\.disabled = live !== kind/.test(js), 'knobs that belong to the other bake are disabled');
ok(/\['round', 'boxes'\], \['shrink', 'boxes'\], \['thicken', 'volume'\]/.test(js),
  'and the mapping names all three of them');
ok(/thicken.*field\.u\.thicken\.value/s.test(js), 'the thickness slider reaches its uniform');

console.log(`${pass}/${pass + fail} static checks passed on demos/sdf-pikachu.html`);
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
