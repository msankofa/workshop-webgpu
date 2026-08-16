// scratch probe: does FK over the pivot chain reproduce coherent motion from a ROM clip?
import fs from 'node:fs';
import { parseGLB, readAccessor, nodeWorldMatrices, nodeLocalMatrix, matMultiply, matIdentity, transformPoint, readSkinnedVertices } from './stadium-glb.js';

const file = process.argv[2] || 'models/stadium/019_rattata.glb';
const clipName = process.argv[3] || 'idle';
const { json, bin } = parseGLB(fs.readFileSync(file));
const rest = nodeWorldMatrices(json);
const verts = readSkinnedVertices(json, bin, rest);

// local rest vertex offsets per bone
const restLocal = new Map();   // nodeId -> {n, cx, cy, cz} in that node's local frame
function invAffine(m) {
  // rotation+scale 3x3 inverse via adjugate, then translation
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = 1 / det;
  const r = [A * s, B * s, C * s, 0, -(b * i - c * h) * s, (a * i - c * g) * s, -(a * h - b * g) * s, 0, (b * f - c * e) * s, -(a * f - c * d) * s, (a * e - b * d) * s, 0, 0, 0, 0, 1];
  const t = transformPoint(r, m[12], m[13], m[14]);
  r[12] = -t[0]; r[13] = -t[1]; r[14] = -t[2];
  return r;
}
const invRest = json.nodes.map((_, i) => invAffine(rest.world[i]));
for (let i = 0; i < verts.count; i++) {
  const j = verts.joint[i];
  let s = restLocal.get(j);
  if (!s) restLocal.set(j, s = { n: 0, cx: 0, cy: 0, cz: 0 });
  const p = transformPoint(invRest[j], verts.position[i * 3], verts.position[i * 3 + 1], verts.position[i * 3 + 2]);
  s.n++; s.cx += p[0]; s.cy += p[1]; s.cz += p[2];
}

const clip = (json.animations || []).find(a => a.name === clipName);
if (!clip) throw new Error(`no clip ${clipName}; have ${(json.animations || []).map(a => a.name)}`);
const samplers = clip.samplers.map(s => ({
  input: readAccessor(json, bin, s.input),
  output: readAccessor(json, bin, s.output),
  interpolation: s.interpolation || 'LINEAR',
}));
const duration = Math.max(...samplers.map(s => s.input[s.input.length - 1]));

function sampleAt(t) {
  const local = json.nodes.map(n => nodeLocalMatrix(n));
  const trs = json.nodes.map(n => ({
    t: (n.translation || [0, 0, 0]).slice(),
    r: (n.rotation || [0, 0, 0, 1]).slice(),
    s: (n.scale || [1, 1, 1]).slice(),
  }));
  for (const ch of clip.channels) {
    const s = samplers[ch.sampler];
    const times = s.input;
    let k = 0;
    while (k < times.length - 2 && times[k + 1] < t) k++;
    const t0 = times[k], t1 = times[Math.min(k + 1, times.length - 1)];
    const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    const stride = ch.target.path === 'rotation' ? 4 : 3;
    const a = [], b = [];
    for (let c = 0; c < stride; c++) {
      a.push(s.output[k * stride + c]);
      b.push(s.output[Math.min(k + 1, times.length - 1) * stride + c]);
    }
    const out = a.map((v, c) => v + (b[c] - v) * u);
    const node = trs[ch.target.node];
    if (ch.target.path === 'translation') node.t = out;
    else if (ch.target.path === 'rotation') { const l = Math.hypot(...out) || 1; node.r = out.map(v => v / l); }
    else if (ch.target.path === 'scale') node.s = out;
  }
  for (let i = 0; i < json.nodes.length; i++) {
    local[i] = nodeLocalMatrix({ translation: trs[i].t, rotation: trs[i].r, scale: trs[i].s });
  }
  const world = json.nodes.map(() => matIdentity());
  const parent = rest.parent;
  const order = json.nodes.map((_, i) => i).sort((x, y) => depth(x, parent) - depth(y, parent));
  for (const i of order) world[i] = parent[i] === -1 ? local[i] : matMultiply(world[parent[i]], local[i]);
  return world;
}
function depth(i, parent) { let d = 0; while (parent[i] !== -1) { i = parent[i]; d++; } return d; }

const animatedNodes = new Set(clip.channels.map(c => c.target.node));
const paths = new Set(clip.channels.map(c => c.target.path));
console.log(`${file} clip=${clipName} dur=${duration.toFixed(2)}s channels=${clip.channels.length} nodes=${animatedNodes.size} paths=${[...paths]}`);
console.log('animated node names:', [...animatedNodes].map(n => json.nodes[n].name).join(' '));

// track the geometry centroid of a few bones over the clip
const track = ['bone30', 'bone24', 'bone05', 'bone01', 'bone20', 'bone41'];
const ids = track.map(name => json.nodes.findIndex(n => n.name === name));
const rows = [];
for (let f = 0; f <= 8; f++) {
  const t = duration * f / 8;
  const world = sampleAt(t);
  const cells = ids.map(id => {
    const leaf = (json.nodes[id].children || []).find(c => /_scale$/.test(json.nodes[c].name));
    const s = restLocal.get(leaf);
    if (!s) return '        -       ';
    const p = transformPoint(world[leaf], s.cx / s.n, s.cy / s.n, s.cz / s.n);
    return p.map(v => v.toFixed(1).padStart(6)).join(',');
  });
  rows.push(`t=${t.toFixed(2)}  ` + cells.map((c, i) => `${track[i]}=(${c})`).join('  '));
}
console.log(rows.join('\n'));

// whole-model bbox over the clip, to catch a rig that explodes
let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let f = 0; f < 16; f++) {
  const world = sampleAt(duration * f / 16);
  for (let i = 0; i < verts.count; i++) {
    const j = verts.joint[i];
    const l = transformPoint(invRest[j], verts.position[i * 3], verts.position[i * 3 + 1], verts.position[i * 3 + 2]);
    const p = transformPoint(world[j], l[0], l[1], l[2]);
    for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p[c]); hi[c] = Math.max(hi[c], p[c]); }
  }
}
console.log('animated bbox', lo.map(v => v.toFixed(2)), hi.map(v => v.toFixed(2)));
