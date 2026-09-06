// Readouts are refreshed by the host's half-second HUD tick, never an independent timer.
// Tree culling figures are CPU estimates; the grass survivor count is GPU readback.
const n = value => Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '?';
const ms = value => Number.isFinite(value) ? value.toFixed(2) : '?';
export const vegetationView = camera => [...camera.position.toArray(), ...camera.quaternion.toArray(), ...camera.projectionMatrix.elements];
const sameView = (a, b) => a?.length === b?.length && !!a && a.every((v, i) => Math.abs(v - b[i]) < 0.00001);
export function vegetationOcclusionAvailability(s) {
  const roots = Number.isFinite(s.occluderRoots) ? s.occluderRoots : (s.occlusion ? 1 : 0);
  const available = roots > 0;
  const terrain = s.grass?.terrainOcclusion;
  const reason = available ? '' : terrain?.requested && terrain.reason
    ? terrain.reason : 'no active building, structure, or compatible terrain occluders';
  return { available, roots, requested: !!s.occlusionRequested, reason };
}

export function freshVegetationCount(s) {
  const sample = s.grass.drawnSample;
  return s.grass.enabled && s.grass.built && Number.isFinite(s.grass.drawn)
    && sample && s.now - sample.atMs >= 0 && s.now - sample.atMs < 2500
    && sample.occlusion === !!s.occlusion?.enabled && sameView(sample.view, s.view);
}

export function compareVegetationSamples(a, b) {
  if (!a || !b) return 'Pin a sample, toggle occlusion, stand still, wait for a fresh count, then compare.';
  if (!freshVegetationCount(b)) return 'Wait for a fresh GPU count at this view.';
  if (!sameView(a.view, b.view) || a.configuration !== b.configuration) return 'Comparison invalid: camera, settings, or terrain coverage changed. Pin again.';
  if (!!a.occlusion?.enabled === !!b.occlusion?.enabled) return 'Toggle occlusion before comparing.';
  const off = a.occlusion?.enabled ? b : a, on = a.occlusion?.enabled ? a : b;
  const removed = off.grass.drawn - on.grass.drawn;
  return `Observed occlusion A/B: ${n(off.grass.drawn)} off -> ${n(on.grass.drawn)} on; ${n(removed)} fewer survivors (${off.grass.drawn > 0 ? (removed / off.grass.drawn * 100).toFixed(1) : '0'}%). FPS ${ms(off.fps)} off -> ${ms(on.fps)} on.\nNot an isolated GPU saving: streaming, wind and other rendering can still change. Repeat both directions.`;
}

export function vegetationDebugLines(s, previous = null) {
  const g = s.grass, t = s.trees, o = s.occlusion;
  const oa = vegetationOcclusionAvailability(s);
  const elapsed = previous ? (s.now - previous.now) / 1000 : 0;
  const rate = key => elapsed > 0 && o && previous.occlusion ? n(Math.max(0, o[key] - previous.occlusion[key]) / elapsed) : '?';
  const sample = g.drawnSample;
  const c = g.cull;
  const rejected = c ? c.planar + c.density + c.ground + c.view + c.occlusion : null;
  const tested = c ? c.survivors + rejected : null;
  const pct = (part, total) => total > 0 ? (part * 100 / total).toFixed(1) : '0.0';
  return [
    `${ms(s.fps)} FPS | worst ${ms(s.worstMs)} ms | ${n(s.draws)} draws | ${n(s.triangles)} triangles`,
    !g.enabled ? 'Grass OFF' : !g.built ? 'Grass building / waiting for terrain' :
      `Grass GPU: ${n(g.drawn == null ? null : Math.min(g.drawn, g.capacity))} drawn / ${n(g.drawn)} survivors / ${n(g.capacity)} capacity${g.drawn >= g.capacity ? ' [CAP REACHED]' : ''}\n  ${n(g.dispatch)} candidate threads; ~${n(g.expected)} full-cover estimate (NOT occlusion rejects)\n  ${n(g.recullRate)} reculls/s; ${g.lastRecull || '?'}; sample ${sample ? ms(Math.max(0, s.now - sample.atMs) / 1000) + 's old' : 'pending'}${sample && !sameView(sample.view, s.view) ? ' (earlier view)' : ''}`,
    c ? `Exact GPU cull: ${n(rejected)} / ${n(tested)} rejected (${pct(rejected, tested)}%); ${pct(c.survivors, tested)}% survived\n  planar/cone/fade ${n(c.planar)} (${pct(c.planar, tested)}%); density ${n(c.density)} (${pct(c.density, tested)}%); ground/water ${n(c.ground)} (${pct(c.ground, tested)}%)\n  off-screen ${n(c.view)} (${pct(c.view, tested)}%); depth occlusion ${n(c.occlusion)} (${pct(c.occlusion, tested)}%); capacity overflow ${n(c.overflow)}\n  Diagnostic rejection atomics are enabled and can lower FPS.` : 'Exact GPU cull: waiting for diagnostic counters.',
    !t.enabled ? 'Trees OFF' : `Trees: ${n(t.trees)} placed / ${n(t.instances)} uploaded / ${n(t.dropped)} dropped\n  CPU estimates LOD0/1/2: ${n(t.lod0)} / ${n(t.lod1)} / ${n(t.lod2)}; cone/far rejected ${n(t.rejectedCone)} / ${n(t.rejectedFar)}\n  ${n(t.draws)} main + ${n(t.shadowDraws)} shadow draws; variants ${n(t.readyVariants)}/${n(t.variants)}`,
    t.enabled ? `Tree startup: first published ${ms(t.startup?.firstPublicationMs == null ? null : t.startup.firstPublicationMs / 1000)}s; complete ${ms(t.startup?.totalMs == null ? null : t.startup.totalMs / 1000)}s\n  palette CPU ${ms(t.paletteMs)}ms; render warmup ${ms(t.compileMs / 1000)}s; compute warmup ${ms(t.computeCompileMs)}ms` : '',
    o && oa.available ? `Grass occlusion ${o.enabled ? 'ON' : 'OFF'} (${o.size}² depth, ${n(oa.roots)} roots): ${rate('renders')} renders/s, ${rate('skipped')} cached skips/s\n  last depth-render CPU submission ${ms(o.lastRenderCpuMs)}ms (not GPU time)\n  No tree depth occlusion. Use A/B below for observed blade-count impact.`
      : `Grass occlusion ${oa.requested ? 'requested but UNAVAILABLE' : 'OFF'}: ${oa.reason}.\n  Toggle is disabled until an occluder depth source exists; no tree depth occlusion.`,
    `GPU timestamps ${s.gpuRequested ? 'requested' : 'OFF'}; resolved ${n(s.gpuResolved)}. Counts do not establish GPU cost.`,
  ].filter(Boolean).join('\n');
}

export function createVegetationDebugHud({ document, host = document.body, sample, toggleOcclusion }) {
  const root = document.createElement('section');
  root.id = 'vegetation-debug-hud';
  root.style.cssText = 'max-height:20vh;overflow:auto;margin-top:4px;font:inherit;pointer-events:auto';
  const toggle = document.createElement('button'); toggle.textContent = 'Vegetation debug: hide';
  const body = document.createElement('div');
  const text = document.createElement('pre'); text.style.cssText = 'white-space:pre-wrap;margin:8px 0';
  const note = document.createElement('div'); note.textContent = 'Counts sampled about once/second. Hide stops HUD readbacks. Esc releases mouse for buttons.';
  const result = document.createElement('pre'); result.style.cssText = 'white-space:pre-wrap';
  result.textContent = compareVegetationSamples(null, null);
  let visible = true, previous = null, pinned = null;
  toggle.addEventListener('click', () => {
    visible = !visible; body.hidden = !visible; previous = null;
    toggle.textContent = `Vegetation debug: ${visible ? 'hide' : 'show'}`;
  });
  const button = (label, fn) => {
    const b = document.createElement('button'); b.textContent = label;
    b.addEventListener('click', fn); body.append(b);
    return b;
  };
  body.append(text, note);
  button('Pin counts / FPS', () => {
    const s = sample();
    const availability = vegetationOcclusionAvailability(s);
    if (!availability.available) { result.textContent = 'Cannot pin an occlusion A/B: ' + availability.reason + '.'; return; }
    if (!freshVegetationCount(s)) { result.textContent = 'Stand still and wait for a fresh grass count before pinning.'; return; }
    pinned = structuredClone(s); result.textContent = 'Pinned. Toggle occlusion, stand still, wait at least 2 seconds, then compare.';
  });
  let occlusionButton = null;
  const syncOcclusionButton = s => {
    const availability = vegetationOcclusionAvailability(s);
    occlusionButton.disabled = !availability.available;
    occlusionButton.textContent = !availability.available ? 'Grass occlusion unavailable'
      : s.occlusion?.enabled ? 'Turn grass occlusion off' : 'Turn grass occlusion on';
    occlusionButton.title = availability.available ? '' : availability.reason;
  };
  occlusionButton = button('Toggle grass occlusion', () => {
    const before = sample(), availability = vegetationOcclusionAvailability(before);
    if (!availability.available) { result.textContent = 'Cannot toggle grass occlusion: ' + availability.reason + '.'; return; }
    toggleOcclusion(); previous = null;
    const after = sample(); syncOcclusionButton(after);
    result.textContent = `Grass occlusion is now ${after.occlusion?.enabled ? 'ON' : 'OFF'}. Stand still for a fresh count before comparing.`;
  });
  button('Compare with pin', () => { result.textContent = compareVegetationSamples(pinned, sample()); });
  body.append(result); root.append(toggle, body); host.append(root);
  return {
    get visible() { return visible; },
    refresh() { if (!visible) return; const s = sample(); syncOcclusionButton(s); text.textContent = vegetationDebugLines(s, previous); previous = s; },
    dispose() { root.remove(); },
  };
}
