import os
p = os.path.join(os.path.dirname(__file__), '..', '..', 'tree-viewer.html')
s = open(p, encoding='utf-8').read()

def rep(a, b):
    global s
    assert s.count(a) == 1, a[:70]
    s = s.replace(a, b)

# (3) atlas: both texture sets carry a leaf grid, so the cell survives a save in procedural mode
rep("""function applyAtlas() {
  const grid = texSet.leafMap ? texSet.leafAtlas : null;
  opts.leaves.atlas = grid""", """function applyAtlas() {
  // Both texture sets carry a grid; nulling it in procedural mode used to strip a species' pinned cell on save.
  const grid = texSet.leafAtlas;
  opts.leaves.atlas = grid""")

rep("""function optsSlider(path, label, min, max, step, fmt, refit = false) {""",
"""// One declaration per path so the slider and its Mutate entry can never drift apart. Ranges
// cover every stock preset (Ash Large leaves.size 4.62, Pine Medium force.strength -0.003).
const PATH_RANGES = {
  'force.strength': [-0.05, 0.2, 0.001],
  'bark.roughness': [0, 1, 0.01], 'bark.vScale': [0.05, 2, 0.01],
  'leaves.count': [0, 120, 1], 'leaves.size': [0.2, 6, 0.01], 'leaves.sizeVariance': [0, 1, 0.01],
  'leaves.start': [0, 0.9, 0.01], 'leaves.spread': [0, 1, 0.01], 'leaves.angle': [0, 90, 1],
  'leaves.shadowFraction': [0, 1, 0.01], 'leaves.roughness': [0, 1, 0.01], 'leaves.alphaTest': [0, 1, 0.01],
};
function rangedSlider(path, label, fmt) { return optsSlider(path, label, ...PATH_RANGES[path], fmt); }
function rangedMutateEntry(path) { return optsMutateEntry(path, ...PATH_RANGES[path]); }

function optsSlider(path, label, min, max, step, fmt, refit = false) {""")

rep("""function optsMutateEntry(path, min, max) {
  return { min, max, get: () => getPath(opts, path), set: v => setPath(opts, path, v) };
}
function mutateParams(list) {
  for (const p of list) {
    const range = p.max - p.min;
    const delta = (Math.random() * 2 - 1) * mutationDegree * range;
    p.set(Math.max(p.min, Math.min(p.max, p.get() + delta)));
  }
}""", """function optsMutateEntry(path, min, max, step = 0) {
  return { min, max, step, get: () => getPath(opts, path), set: v => setPath(opts, path, v) };
}
// Integer sliders (step 1) round: a fractional children count is NaN geometry in trees.js.
// Circular axes (wrap) go around instead of sticking at the ends.
function mutateParams(list) {
  for (const p of list) {
    const range = p.max - p.min;
    const delta = (Math.random() * 2 - 1) * mutationDegree * range;
    let v = p.get() + delta;
    v = p.wrap ? ((v - p.min) % range + range) % range + p.min : Math.max(p.min, Math.min(p.max, v));
    if (p.step === 1) v = Math.round(v);
    p.set(v);
  }
}""")

rep("""  for (let level = 0; level <= opts.levels; level++) list.push(optsMutateEntry(`${p.key}.${level}`, p.min, p.max));""",
"""  for (let level = 0; level <= opts.levels; level++) list.push(optsMutateEntry(`${p.key}.${level}`, p.min, p.max, p.step));""")

rep("""    { min: 0, max: 360, get: () => forceAz, set: v => { forceAz = v; applyForceDirection(); } },
    { min: -90, max: 90, get: () => forceEl, set: v => { forceEl = v; applyForceDirection(); } },
    optsMutateEntry('force.strength', 0, 0.2),""", """    { min: 0, max: 360, wrap: true, get: () => forceAz, set: v => { forceAz = v; applyForceDirection(); } },
    { min: -90, max: 90, get: () => forceEl, set: v => { forceEl = v; applyForceDirection(); } },
    rangedMutateEntry('force.strength'),""")

rep("""  return [optsMutateEntry('bark.roughness', 0, 1), optsMutateEntry('bark.vScale', 0.05, 2)];""",
"""  return [rangedMutateEntry('bark.roughness'), rangedMutateEntry('bark.vScale')];""")

rep("""  return [
    optsMutateEntry('leaves.count', 0, 40),
    optsMutateEntry('leaves.size', 0.2, 3),
    optsMutateEntry('leaves.sizeVariance', 0, 1),
    optsMutateEntry('leaves.start', 0, 0.9),
    optsMutateEntry('leaves.spread', 0, 1),
    optsMutateEntry('leaves.angle', 0, 90),
    optsMutateEntry('leaves.shadowFraction', 0, 1),
    optsMutateEntry('leaves.roughness', 0, 1),
    optsMutateEntry('leaves.alphaTest', 0, 1),
  ];""", """  return ['leaves.count', 'leaves.size', 'leaves.sizeVariance', 'leaves.start', 'leaves.spread',
    'leaves.angle', 'leaves.shadowFraction', 'leaves.roughness', 'leaves.alphaTest'].map(rangedMutateEntry);""")

# (1) level ranges wide enough for the stock presets
rep("""const LEVEL_PARAMS = [
  { key: 'length', label: 'Length', min: 1, max: 30, step: 0.5, fmt: f2 },
  { key: 'radius', label: 'Radius', min: 0.05, max: 2, step: 0.01, fmt: f2 },
  { key: 'taper', label: 'Taper', min: 0, max: 1, step: 0.01, fmt: f2 },
  { key: 'children', label: 'Children', min: 0, max: 10, step: 1, fmt: fi },
  { key: 'branchStart', label: 'Branch start', min: 0, max: 1, step: 0.01, fmt: f2 },
  { key: 'angle', label: 'Angle', min: 0, max: 90, step: 1, fmt: fi },
  { key: 'gnarliness', label: 'Gnarliness', min: 0, max: 1, step: 0.01, fmt: f2 },
  { key: 'twist', label: 'Twist', min: -1, max: 1, step: 0.01, fmt: f2 },
  { key: 'sections', label: 'Sections', min: 3, max: 16, step: 1, fmt: fi },
  { key: 'segments', label: 'Segments', min: 3, max: 16, step: 1, fmt: fi },
];""", """// Ranges cover every stock preset: Pine Large has 100 children, a 129 degree droop and a 65 m trunk.
const LEVEL_PARAMS = [
  { key: 'length', label: 'Length', min: 0.1, max: 80, step: 0.1, fmt: f2 },
  { key: 'radius', label: 'Radius', min: 0.05, max: 4, step: 0.01, fmt: f2 },
  { key: 'taper', label: 'Taper', min: 0, max: 1, step: 0.01, fmt: f2 },
  { key: 'children', label: 'Children', min: 0, max: 120, step: 1, fmt: fi },
  { key: 'branchStart', label: 'Branch start', min: 0, max: 1, step: 0.01, fmt: f2 },
  { key: 'angle', label: 'Angle', min: 0, max: 180, step: 1, fmt: fi },
  { key: 'gnarliness', label: 'Gnarliness', min: -1, max: 1, step: 0.01, fmt: f2 },
  { key: 'twist', label: 'Twist', min: -1, max: 1, step: 0.01, fmt: f2 },
  { key: 'sections', label: 'Sections', min: 1, max: 16, step: 1, fmt: fi },
  { key: 'segments', label: 'Segments', min: 3, max: 16, step: 1, fmt: fi },
];""")

# (4) azimuth in the slider's 0..360, not atan2's -180..180
rep("""  forceAz = Math.atan2(opts.force.direction[0], opts.force.direction[2]) * 180 / Math.PI;""",
"""  forceAz = (Math.atan2(opts.force.direction[0], opts.force.direction[2]) * 180 / Math.PI + 360) % 360;""")

rep("""optsSlider('force.strength', 'Strength', 0, 0.2, 0.001, v => v.toFixed(3));""",
"""rangedSlider('force.strength', 'Strength', v => v.toFixed(3));""")
rep("""optsSlider('bark.roughness', 'Roughness', 0, 1, 0.01, f2);""", """rangedSlider('bark.roughness', 'Roughness', f2);""")
rep("""optsSlider('bark.vScale', 'Texture V scale', 0.05, 2, 0.01, f2);""", """rangedSlider('bark.vScale', 'Texture V scale', f2);""")
rep("""optsSlider('leaves.count', 'Count', 0, 40, 1, fi);
optsSlider('leaves.size', 'Size', 0.2, 3, 0.01, f2);
optsSlider('leaves.sizeVariance', 'Size variance', 0, 1, 0.01, f2);
optsSlider('leaves.start', 'Start', 0, 0.9, 0.01, f2);
optsSlider('leaves.spread', 'Spread', 0, 1, 0.01, f2);
optsSlider('leaves.angle', 'Angle', 0, 90, 1, fi);""", """rangedSlider('leaves.count', 'Count', fi);
rangedSlider('leaves.size', 'Size', f2);
rangedSlider('leaves.sizeVariance', 'Size variance', f2);
rangedSlider('leaves.start', 'Start', f2);
rangedSlider('leaves.spread', 'Spread', f2);
rangedSlider('leaves.angle', 'Angle', fi);""")
rep("""optsSlider('leaves.shadowFraction', 'Shadow fraction', 0, 1, 0.01, pct);
optsColor('leaves.tint', 'Tint');
optsSlider('leaves.roughness', 'Roughness', 0, 1, 0.01, f2);
optsSlider('leaves.alphaTest', 'Alpha test', 0, 1, 0.01, f2);""", """rangedSlider('leaves.shadowFraction', 'Shadow fraction', pct);
optsColor('leaves.tint', 'Tint');
rangedSlider('leaves.roughness', 'Roughness', f2);
rangedSlider('leaves.alphaTest', 'Alpha test', f2);""")

# (5) age preview goes through the same debounce as every other slider
rep("""rangeControl('Age preview', 0, 1, 0.01, () => previewAge, v => { previewAge = v; regenerateSolo(false); }, pct, () => {});""",
"""rangeControl('Age preview', 0, 1, 0.01, () => previewAge, v => { previewAge = v; }, pct, () => scheduleRegenerate());""")

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('patched')
