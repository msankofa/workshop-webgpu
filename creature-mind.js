// 3D "machine mind" overlay for creature-model.html. Renders the seven mind-map.js
// regions as glowing cores inside a glass head; driven by demo codes or a trace TSV.
import { REGIONS, EDGES, DEMO_STATES, mindActivations, attentionBearing, movementMeasured } from './mind-map.js';

const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let ui = null;

export async function openMind() {
  if (!ui) ui = buildMind(await import(THREE_URL));
  ui.show();
}

function buildMind(THREE) {
  injectStyle();
  const root = document.createElement('div');
  root.className = 'mind-overlay';
  root.innerHTML = `
    <div class="mind-stage"><div class="mind-labels"></div><div class="mind-fps"></div></div>
    <div class="mind-panel">
      <div class="mind-top"><h2>The machine mind</h2><button class="mind-close" title="Close">×</button></div>
      <p class="mind-note">The mind has seven regions. Each region's glow comes from one slot of the 9-character state code. No indicator is decorative.</p>
      <div class="mind-tabs"><button data-tab="demo" class="on">Demo</button><button data-tab="replay">Replay a trace</button><button data-tab="live">Live</button></div>
      <div class="mind-doing"></div>
      <div class="mind-code"></div>
      <div class="mind-bars"></div>
      <div class="mind-tab-demo"></div>
      <div class="mind-tab-replay" hidden>
        <label class="mind-file">Load a <code>bot-state-trace-*.tsv</code> file from <code>bot-states/</code>.
          <input type="file" accept=".tsv,.txt"></label>
        <div class="mind-replay-controls" hidden>
          <select class="mind-bot"></select>
          <button class="mind-play">Play</button>
          <select class="mind-speed"><option>1</option><option>2</option><option selected>4</option><option>8</option><option>16</option></select>
          <input class="mind-scrub" type="range" min="0" max="1000" value="0">
          <span class="mind-time"></span>
        </div>
      </div>
      <div class="mind-tab-live" hidden>
        <p class="mind-live-help">Open <code>bot-viewer-v2.html</code> in another tab and turn on its <b>Live</b> stream button. Keep both windows visible, because browsers pause hidden tabs.</p>
        <div class="mind-live-row">
          <button class="mind-live-btn">Connect</button>
          <select class="mind-live-bot" hidden></select>
        </div>
        <div class="mind-live-status">Not connected.</div>
      </div>
    </div>`;
  document.body.appendChild(root);

  const stage = root.querySelector('.mind-stage');
  const labelsEl = root.querySelector('.mind-labels');
  // no MSAA: every layer is soft-edged sprites/shaders, so antialias only taxes the additive fill rate
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070c);
  scene.fog = new THREE.Fog(0x05070c, 5, 11);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(0, 0.3, 4.6);
  const group = new THREE.Group();
  scene.add(group);

  // glass head: fresnel rim shell + faint inner lattice
  const headGeo = new THREE.SphereGeometry(1.45, 48, 32);
  headGeo.scale(0.85, 1.08, 0.95);
  const fresnelMat = (tint, power, gain, side) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side,
    uniforms: { tint: { value: new THREE.Color(tint) } },
    vertexShader: `varying vec3 vN, vV;
      void main(){ vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz;
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vN, vV; uniform vec3 tint;
      void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), ${power.toFixed(1)});
        gl_FragColor = vec4(tint * f, f * ${gain.toFixed(2)}); }`,
  });
  const shell = new THREE.Mesh(headGeo, fresnelMat(0x3a6ea8, 2.2, 0.75, THREE.FrontSide));
  shell.renderOrder = 4;
  // inner back-face rim: gives the glass a second, deeper surface
  const innerShell = new THREE.Mesh(headGeo, fresnelMat(0x1d4a72, 3.0, 0.5, THREE.BackSide));
  innerShell.scale.setScalar(0.985);
  innerShell.renderOrder = 4;
  group.add(shell, innerShell);
  const lattice = new THREE.Mesh(new THREE.IcosahedronGeometry(1.32, 1),
    new THREE.MeshBasicMaterial({ color: 0x1c3a5e, wireframe: true, transparent: true, opacity: 0.16 }));
  lattice.scale.set(0.85, 1.08, 0.95);
  lattice.renderOrder = 1;
  group.add(lattice);

  // drifting dust inside the head
  const dustPos = new Float32Array(140 * 3);
  for (let i = 0; i < 140; i++) {
    let x, y, z;
    do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; }
    while (x * x + y * y + z * z > 1);
    dustPos.set([x * 1.05, y * 1.3, z * 1.1], i * 3);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: 0x3f7ba8, size: 0.022, transparent: true, opacity: 0.45,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
  dust.renderOrder = 2;
  group.add(dust);

  const glowTex = makeGlowTexture(THREE);
  const nodes = new Map();
  for (const r of REGIONS) {
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 14),
      new THREE.MeshBasicMaterial({ color: r.color }));
    core.position.set(...r.pos);
    // two glow layers: a tight hot center and a soft wide halo
    const mkGlow = (order) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: r.color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.position.copy(core.position);
      s.renderOrder = order;
      group.add(s);
      return s;
    };
    const glow = mkGlow(5), hot = mkGlow(6);
    hot.material.color.lerp(new THREE.Color(0xffffff), 0.55);
    group.add(core);
    const label = document.createElement('div');
    label.className = 'mind-node-label';
    label.textContent = r.label;
    label.style.color = '#' + r.color.toString(16).padStart(6, '0');
    labelsEl.appendChild(label);
    nodes.set(r.id, { region: r, core, glow, hot, label, level: 0, target: 0, flash: 0,
      phase: Math.random() * 6.28, lx: -1e9, ly: -1e9, lop: -1 });
  }
  const edges = EDGES.map(([a, b], i) => {
    const A = nodes.get(a).core.position, B = nodes.get(b).core.position;
    const geo = new THREE.BufferGeometry().setFromPoints([A, B]);
    const mat = new THREE.LineBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 3;
    // one flow mote per edge, cycling A->B; visible only while both ends are active
    const flow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0x9fdcff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    flow.scale.set(0.11, 0.11, 1);
    flow.renderOrder = 7;
    group.add(line, flow);
    return { a, b, mat, flow, A, B, phase: i / EDGES.length };
  });

  // pulse sprites travel from a changed region to intent
  const intentPos = nodes.get('intent').core.position;
  const pulsePool = [], pulses = [];
  function spawnPulse(fromId) {
    if (fromId === 'intent') return;
    let sprite = pulsePool.pop();
    if (!sprite) {
      sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: 0xbfe9ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      sprite.scale.set(0.16, 0.16, 1);
      sprite.renderOrder = 7;
      group.add(sprite);
    }
    sprite.visible = true;
    pulses.push({ sprite, from: nodes.get(fromId).core.position, p: 0 });
  }

  // attention needle: points from perception toward the current target, in the bot's own frame
  const needle = new THREE.Group();
  needle.position.copy(nodes.get('perception').core.position);
  const needleTip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.45, 10),
    new THREE.MeshBasicMaterial({ color: 0x39c5ff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
  needleTip.geometry.rotateX(Math.PI / 2); // cone tip points +z, the head's front
  needleTip.position.z = 0.38;
  needleTip.renderOrder = 6;
  needle.add(needleTip);
  needle.visible = false;
  group.add(needle);
  function setAttention(relDeg) {
    needle.visible = Number.isFinite(relDeg);
    if (needle.visible) needle.rotation.y = relDeg * Math.PI / 180;
  }

  // panel widgets
  const doingEl = root.querySelector('.mind-doing');
  const codeEl = root.querySelector('.mind-code');
  const codeCells = Array.from({ length: 9 }, () => codeEl.appendChild(document.createElement('b')));
  const barsEl = root.querySelector('.mind-bars');
  const bars = new Map();
  for (const r of REGIONS) {
    const row = document.createElement('div');
    row.className = 'mind-bar-row';
    row.title = r.blurb;
    row.innerHTML = `<span class="dot" style="background:#${r.color.toString(16).padStart(6, '0')}"></span>
      <span class="lab">${r.label}</span><div class="meter"><i></i></div><span class="det"></span>`;
    barsEl.appendChild(row);
    bars.set(r.id, { row, fill: row.querySelector('i'), det: row.querySelector('.det') });
  }
  function flashBar(id, cls) {
    const row = bars.get(id).row;
    row.classList.remove('hit', 'mend', 'spend');
    requestAnimationFrame(() => row.classList.add(cls)); // restart without a forced reflow
  }
  const demoEl = root.querySelector('.mind-tab-demo');
  for (const d of DEMO_STATES) {
    const b = document.createElement('button');
    b.className = 'mind-demo-btn';
    b.innerHTML = `<code>${d.code}</code><span>${d.caption}</span>`;
    b.addEventListener('click', () => { selectDemo(b); resetBaseline(); setAttention(null); setState(d.code); });
    demoEl.appendChild(b);
  }
  function selectDemo(btn) { demoEl.querySelectorAll('.on').forEach((x) => x.classList.remove('on')); if (btn) btn.classList.add('on'); }

  let lastCode = null, lastDecoded = null;
  function resetBaseline() { lastDecoded = null; }
  function setState(code, ctx = null) {
    const a = mindActivations(code, ctx);
    if (!a) return;
    const codeChanged = code !== lastCode;
    if (codeChanged) {
      const d = a.decoded;
      // harm, recovery, and depletion read differently: red, green, amber
      if (lastDecoded) {
        if (d.health < lastDecoded.health) flashBar('body', 'hit');
        else if (d.health > lastDecoded.health) flashBar('body', 'mend');
        if (d.ammoChar !== lastDecoded.ammoChar && (d.ammoChar === 'R' || d.ammoChar === '0')) flashBar('weapon', 'spend');
        else if (d.ammoBand != null && lastDecoded.ammoBand != null && d.ammoBand < lastDecoded.ammoBand) flashBar('weapon', 'spend');
      }
      lastDecoded = d;
      doingEl.textContent = a.doing;
      const titles = [
        `state: ${d.state}`, `alert tier: ${d.tier}`, `escalation: ${d.score} of 9`,
        `role: ${d.role}`, `push element: ${d.element}`, `ammo: ${d.ammo}`,
        `health: ${d.healthRange}`, `packs: ${d.packs}${d.hasKit ? ' plus a revive kit' : ''}`,
        `latches: ${d.latches.join(', ') || 'none'}`,
      ];
      const changedCells = [];
      for (let i = 0; i < 9; i++) {
        const cell = codeCells[i];
        cell.title = titles[i];
        if (cell.textContent !== code[i]) {
          cell.textContent = code[i];
          if (lastCode) { cell.classList.remove('chg'); changedCells.push(cell); }
        }
      }
      if (changedCells.length) requestAnimationFrame(() => { for (const c of changedCells) c.classList.add('chg'); });
      lastCode = code;
    }
    for (const [id, n] of nodes) {
      const { level, detail } = a.regions[id];
      if (!codeChanged && id !== 'movement') continue;
      if (Math.abs(level - n.target) > 0.1) { n.flash = 1; if (codeChanged) spawnPulse(id); }
      n.target = level;
      bars.get(id).fill.style.transform = `scaleX(${level})`;
      bars.get(id).det.textContent = detail;
      if (id === 'movement') { lastMoveLevel = level; lastMoveDetail = detail; }
    }
  }
  // replay fast path: between rows only the interpolated speed changes, so skip the full
  // decode/describe pipeline and touch just the movement region
  let lastMoveDetail = '', lastMoveLevel = -1;
  function setMovement(speed, path) {
    const m = movementMeasured(speed, path);
    if (m.level !== lastMoveLevel) {
      lastMoveLevel = m.level;
      nodes.get('movement').target = m.level;
      bars.get('movement').fill.style.transform = `scaleX(${m.level})`;
    }
    if (m.detail !== lastMoveDetail) {
      lastMoveDetail = m.detail;
      bars.get('movement').det.textContent = m.detail;
    }
  }

  // tabs
  let activeTab = 'demo';
  const tabs = root.querySelectorAll('.mind-tabs button');
  tabs.forEach((t) => t.addEventListener('click', () => {
    activeTab = t.dataset.tab;
    tabs.forEach((x) => x.classList.toggle('on', x === t));
    for (const name of ['demo', 'replay', 'live']) {
      root.querySelector(`.mind-tab-${name}`).hidden = name !== activeTab;
    }
    stopPlayback();
    if (activeTab === 'live') liveApplySelected();
  }));

  // replay
  const replay = { bots: [], bot: null, t: 0, t0: 0, t1: 1, playing: false, cursor: 0 };
  let lastRowKey = '';
  const botSel = root.querySelector('.mind-bot');
  const playBtn = root.querySelector('.mind-play');
  const speedSel = root.querySelector('.mind-speed');
  const scrub = root.querySelector('.mind-scrub');
  const timeEl = root.querySelector('.mind-time');
  root.querySelector('.mind-file input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    replay.bots = parseTrace(await f.text());
    replay.byId = new Map(replay.bots.map((b) => [b.id, b]));
    e.target.value = ''; // allow reloading the same file
    botSel.innerHTML = replay.bots.map((b, i) => `<option value="${i}">${b.id} (${b.team})</option>`).join('');
    root.querySelector('.mind-replay-controls').hidden = !replay.bots.length;
    pickBot(0);
  });
  botSel.addEventListener('change', () => pickBot(+botSel.value));
  function stopPlayback(label = 'Play') { replay.playing = false; playBtn.textContent = label; }
  function pickBot(i) {
    replay.bot = replay.bots[i];
    if (!replay.bot) return;
    replay.t0 = replay.bot.rows[0].t;
    replay.t1 = replay.bot.rows[replay.bot.rows.length - 1].t;
    replay.t = replay.t0; replay.cursor = 0;
    lastRowKey = '';
    stopPlayback();
    resetBaseline();
    applyRow();
  }
  playBtn.addEventListener('click', () => {
    if (!replay.bot) return;
    if (!replay.playing && replay.t >= replay.t1) { replay.t = replay.t0; replay.cursor = 0; } // replay from the start
    replay.playing = !replay.playing;
    playBtn.textContent = replay.playing ? 'Pause' : 'Play';
  });
  scrub.addEventListener('input', () => {
    replay.t = replay.t0 + (replay.t1 - replay.t0) * (scrub.value / 1000);
    replay.cursor = 0;
    if (!replay.playing) playBtn.textContent = 'Play';
    applyRow();
  });
  function applyRow() {
    const rows = replay.bot?.rows;
    if (!rows?.length) return;
    while (replay.cursor + 1 < rows.length && rows[replay.cursor + 1].t <= replay.t) replay.cursor++;
    while (replay.cursor > 0 && rows[replay.cursor].t > replay.t) replay.cursor--;
    const row = rows[replay.cursor], next = rows[replay.cursor + 1];
    const f = next ? clamp((replay.t - row.t) / Math.max(1, next.t - row.t), 0, 1) : 0;
    const speed = next ? row.speed + (next.speed - row.speed) * f : row.speed;
    const rowKey = `${replay.bot.id}:${replay.cursor}`;
    if (rowKey !== lastRowKey || row.code !== lastCode) {
      lastRowKey = rowKey;
      setState(row.code, { ...row, speed });
      const targetBot = row.targetId ? replay.byId?.get(row.targetId) : null;
      setAttention(targetBot ? attentionBearing(row, rowAt(targetBot, replay.t)) : null);
      selectDemo(null);
    } else if (row.code[0] !== 'D') {
      setMovement(speed, row.pathMode ? `, ${row.pathMode} path, ${row.pathLen ?? 0} nodes` : '');
    }
    const sv = Math.round(((replay.t - replay.t0) / Math.max(1, replay.t1 - replay.t0)) * 1000);
    if (+scrub.value !== sv) scrub.value = sv;
    const ts = `${((replay.t - replay.t0) / 1000).toFixed(1)}s / ${((replay.t1 - replay.t0) / 1000).toFixed(0)}s`;
    if (timeEl.textContent !== ts) timeEl.textContent = ts;
  }

  // live: watch a running bot-viewer-v2 over its BroadcastChannel. The protocol is owned by the
  // game (bot-viewer-v2.html botLiveOpen/botLiveSendSnapshot): hello -> snapshot -> rows batches.
  // The mind keeps only the newest row per bot; history is the trace viewer's job.
  const live = { channel: null, latest: new Map(), selected: null, ackAt: 0, lastRowAt: 0, gameHidden: false };
  const liveBtn = root.querySelector('.mind-live-btn');
  const liveSel = root.querySelector('.mind-live-bot');
  const liveStatus = root.querySelector('.mind-live-status');
  liveBtn.addEventListener('click', () => (live.channel ? liveDisconnect() : liveConnect()));
  liveSel.addEventListener('change', () => { live.selected = liveSel.value; resetBaseline(); liveApplySelected(); });
  function liveConnect() {
    live.channel = new BroadcastChannel('bot-trace-live');
    live.channel.onmessage = (e) => liveIngest(e.data);
    live.latest.clear();
    live.selected = null; live.ackAt = 0; live.lastRowAt = 0; live.gameHidden = false;
    live.channel.postMessage({ type: 'hello' }); // the game answers with a snapshot
    liveBtn.textContent = 'Disconnect';
    resetBaseline();
    liveUpdateStatus();
  }
  function liveDisconnect() {
    live.channel?.close();
    live.channel = null;
    liveSel.hidden = true;
    liveBtn.textContent = 'Connect';
    liveUpdateStatus();
  }
  function liveIngest(msg) {
    if (!live.channel || !msg) return;
    if (msg.type === 'vis') { live.gameHidden = !!msg.hidden; return liveUpdateStatus(); }
    if (msg.type !== 'snapshot' && msg.type !== 'rows') return;
    if (msg.type === 'snapshot') { live.latest.clear(); live.gameHidden = !!msg.hidden; }
    live.ackAt ||= performance.now();
    live.lastRowAt = performance.now();
    const before = live.latest.size;
    let selectedTouched = false;
    for (const r of msg.rows || []) {
      if (!r?.id || !r.code) continue;
      live.latest.set(r.id, r);
      if (r.id === live.selected) selectedTouched = true;
    }
    if (msg.type === 'snapshot' || live.latest.size !== before) liveRebuildRoster();
    if (!live.selected && live.latest.size) {
      live.selected = liveSel.value = liveDefaultBot();
      selectedTouched = true;
    }
    if (selectedTouched) liveApplySelected();
    liveUpdateStatus();
  }
  function liveDefaultBot() {
    for (const [id, r] of live.latest) if (r.code[0] !== 'D') return id;
    return live.latest.keys().next().value;
  }
  function liveRebuildRoster() {
    const ids = [...live.latest.keys()].sort();
    liveSel.innerHTML = ids.map((id) => `<option value="${id}">${id} (${live.latest.get(id).team ?? '?'})</option>`).join('');
    if (live.selected) liveSel.value = live.selected;
    liveSel.hidden = !ids.length;
  }
  function liveApplySelected() {
    const r = live.latest.get(live.selected);
    if (!r || activeTab !== 'live') return;
    setState(r.code, { ...r, speed: Number(r.speed) || 0 });
    const targetRow = r.targetId ? live.latest.get(r.targetId) : null;
    setAttention(targetRow ? attentionBearing(r, targetRow) : null);
    selectDemo(null);
  }
  function liveUpdateStatus() {
    if (!live.channel) { liveStatus.textContent = 'Not connected.'; liveStatus.classList.remove('warn'); return; }
    let note = '';
    if (live.gameHidden) note = 'The game tab is hidden, so the simulation is paused. Keep both windows visible.';
    else if (!live.ackAt) note = 'Waiting for the game. Turn on Live in bot-viewer-v2.';
    else if (performance.now() - live.lastRowAt > 2500) note = `Stalled. No rows have arrived for ${((performance.now() - live.lastRowAt) / 1000).toFixed(0)}s.`;
    liveStatus.textContent = note || `Live with ${live.latest.size} bots. Watching ${live.selected}.`;
    liveStatus.classList.toggle('warn', !!note);
  }

  // orbit: drag to rotate (pointer capture keeps listeners off window), wheel to zoom;
  // slow spin resumes after 4s idle
  let dragging = false, px = 0, py = 0, yaw = 0, pitch = 0, lastTouch = -1e9;
  stage.addEventListener('pointerdown', (e) => {
    dragging = true; lastTouch = performance.now(); px = e.clientX; py = e.clientY;
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointerup', () => { dragging = false; lastTouch = performance.now(); });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw += (e.clientX - px) * 0.006; pitch = clamp(pitch + (e.clientY - py) * 0.004, -0.6, 0.6);
    px = e.clientX; py = e.clientY;
    lastTouch = performance.now();
  });
  stage.addEventListener('wheel', (e) => { e.preventDefault(); camera.position.z = clamp(camera.position.z + e.deltaY * 0.002, 2.6, 7); }, { passive: false });

  let stageW = 1, stageH = 1;
  const resize = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    stageW = w; stageH = h;
    // cap the backing store: additive overdraw cost scales with monitor size otherwise
    renderer.setPixelRatio(Math.max(0.75, Math.min(1.5, devicePixelRatio, 1600 / w)));
    renderer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(stage);

  const v = new THREE.Vector3();
  const fpsEl = root.querySelector('.mind-fps');
  let raf = 0, last = 0, liveStatusAt = 0, fpsFrames = 0, fpsAt = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now;
    if (!dragging && now - lastTouch > 4000) yaw += dt * 0.15;
    group.rotation.set(pitch, yaw, 0);
    dust.rotation.y -= dt * 0.04;
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.p += dt * 2;
      if (p.p >= 1) { p.sprite.visible = false; pulsePool.push(p.sprite); pulses.splice(i, 1); continue; }
      p.sprite.position.lerpVectors(p.from, intentPos, p.p);
      p.sprite.material.opacity = Math.sin(p.p * Math.PI) * 0.9;
    }
    if (replay.playing && replay.bot) {
      replay.t = Math.min(replay.t1, replay.t + dt * 1000 * +speedSel.value);
      applyRow();
      if (replay.t >= replay.t1) stopPlayback('Replay');
    }
    if (live.channel && now - liveStatusAt > 500) { liveStatusAt = now; liveUpdateStatus(); }
    fpsFrames++;
    if (now - fpsAt > 500) {
      if (fpsAt) fpsEl.textContent = `${Math.round(fpsFrames / ((now - fpsAt) / 1000))} fps · ${((now - fpsAt) / fpsFrames).toFixed(1)} ms`;
      fpsAt = now; fpsFrames = 0;
    }
    const t = now / 1000;
    for (const n of nodes.values()) {
      n.level += (n.target - n.level) * Math.min(1, dt * 8);
      n.flash = Math.max(0, n.flash - dt * 2);
      const pulse = 1 + 0.1 * Math.sin(t * (1.5 + n.level * 3) + n.phase) * n.level;
      // scale clamped: brightness comes from the hot layer, not from growing overdraw area
      const s = Math.min(0.95, 0.22 + n.level * 0.65 + n.flash * 0.25) * pulse;
      n.glow.scale.set(s, s, 1);
      n.glow.material.opacity = 0.12 + n.level * 0.75;
      const hs = s * 0.38;
      n.hot.scale.set(hs, hs, 1);
      n.hot.material.opacity = Math.min(1, 0.2 + n.level * 0.8 + n.flash * 0.4);
      n.core.material.color.set(n.region.color).multiplyScalar(0.25 + n.level * 0.95 + n.flash * 0.5);
      v.copy(n.core.position).applyMatrix4(group.matrixWorld).project(camera);
      const behind = v.z > 1 || Math.abs(v.x) > 1.2;
      const lx = ((v.x + 1) / 2) * stageW + 10, ly = ((1 - v.y) / 2) * stageH - 8;
      const lop = behind ? 0 : 0.35 + n.level * 0.65;
      if (Math.abs(lx - n.lx) > 0.4 || Math.abs(ly - n.ly) > 0.4) {
        n.lx = lx; n.ly = ly;
        n.label.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`;
      }
      if (Math.abs(lop - n.lop) > 0.015) { n.lop = lop; n.label.style.opacity = lop.toFixed(2); }
    }
    for (const e of edges) {
      const a = nodes.get(e.a), b = nodes.get(e.b);
      const eff = Math.min(a.level, b.level);
      e.mat.opacity = 0.04 + eff * 0.45 + Math.max(a.flash, b.flash) * 0.4;
      if (eff > 0.12) {
        const p = (t * (0.18 + eff * 0.35) + e.phase) % 1;
        e.flow.position.lerpVectors(e.A, e.B, p);
        e.flow.material.opacity = Math.sin(p * Math.PI) * eff * 0.9;
      } else if (e.flow.material.opacity) {
        e.flow.material.opacity = 0;
      }
    }
    renderer.render(scene, camera);
  }

  const onKey = (e) => { if (e.key === 'Escape') api.hide(); };
  root.querySelector('.mind-close').addEventListener('click', () => api.hide());
  const api = {
    show() {
      root.classList.add('open');
      document.body.classList.add('mind-open');
      addEventListener('keydown', onKey);
      resize();
      last = performance.now();
      if (!raf) raf = requestAnimationFrame(frame);
      if (!api.started) { api.started = true; demoEl.querySelector('button').click(); }
    },
    hide() {
      root.classList.remove('open');
      document.body.classList.remove('mind-open');
      removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf); raf = 0;
      liveDisconnect();
    },
  };
  return api;
}

function parseTrace(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const ix = Object.fromEntries(lines[0].split('\t').map((h, i) => [h, i]));
  if (ix.bot_id == null || ix.code == null) return [];
  const num = (v) => (v == null || v === '' ? null : +v);
  const bots = new Map();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    const id = c[ix.bot_id];
    if (!id || !c[ix.code]) continue;
    if (!bots.has(id)) bots.set(id, { id, team: c[ix.team] ?? '?', rows: [] });
    bots.get(id).rows.push({
      t: +c[ix.t_ms], code: c[ix.code], speed: +c[ix.speed] || 0,
      x: num(c[ix.x]), z: num(c[ix.z]), yaw: num(c[ix.yaw_deg]),
      goalDist: num(c[ix.goal_dist]), pathLen: num(c[ix.path_len]), pathMode: c[ix.path_mode] ?? '',
      squadId: c[ix.squad_id] ?? '', squadRank: num(c[ix.squad_rank]), leaderId: c[ix.leader_id] ?? '',
      targetId: c[ix.target_id] ?? '', targetDist: num(c[ix.target_dist]), visGate: c[ix.vis_gate] ?? '-',
    });
  }
  const out = [...bots.values()];
  for (const b of out) b.rows.sort((x, y) => x.t - y.t);
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

// newest row at or before t (first row if t precedes them all)
function rowAt(bot, t) {
  const rows = bot.rows;
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return rows[lo];
}

function makeGlowTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function injectStyle() {
  if (document.getElementById('mind-style')) return;
  const s = document.createElement('style');
  s.id = 'mind-style';
  s.textContent = `
  .mind-overlay { position: fixed; inset: 0; z-index: 50; display: none; background: #05070c;
    color: #cfe3f5; font-family: Georgia, serif; }
  body.mind-open .figure svg { visibility: hidden; } /* drop the feTurbulence layer while covered */
  .mind-overlay.open { display: flex; }
  .mind-stage { flex: 1; position: relative; cursor: grab; min-width: 0; }
  .mind-stage canvas { display: block; }
  .mind-stage::after { content: ''; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.5)); }
  .mind-labels { position: absolute; inset: 0; pointer-events: none; }
  .mind-node-label { position: absolute; top: 0; left: 0; font-size: 13px; font-style: italic;
    text-shadow: 0 0 6px #000; white-space: nowrap; will-change: transform, opacity; }
  .mind-fps { position: absolute; top: 10px; left: 12px; font-family: Consolas, monospace;
    font-size: 12px; color: #5f7c96; pointer-events: none; }
  .mind-panel { width: 380px; max-width: 45vw; overflow-y: auto; padding: 20px 22px;
    border-left: 1px solid #1b2c40; background: #080c13; }
  .mind-top { display: flex; justify-content: space-between; align-items: center; }
  .mind-top h2 { font-weight: normal; font-size: 1.2rem; letter-spacing: .12em; color: #7fd8ff; }
  .mind-close { background: none; border: 1px solid #2a4058; color: #cfe3f5; font-size: 20px;
    width: 34px; height: 34px; border-radius: 6px; cursor: pointer; }
  .mind-note { font-size: .82rem; color: #7d94ab; font-style: italic; margin: 8px 0 12px; }
  .mind-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
  .mind-tabs button, .mind-play, .mind-live-btn { background: #0d1622; border: 1px solid #2a4058; color: #cfe3f5;
    padding: 6px 14px; border-radius: 6px; cursor: pointer; font-family: inherit; }
  .mind-tabs button.on { border-color: #7fd8ff; color: #7fd8ff; }
  .mind-doing { min-height: 1.4em; font-style: italic; color: #ffd23f; margin-bottom: 8px; }
  .mind-code { display: flex; gap: 4px; margin-bottom: 14px; }
  .mind-code b { font-family: Consolas, monospace; font-weight: normal; background: #0d1622;
    border: 1px solid #2a4058; border-radius: 4px; padding: 3px 7px; cursor: help; }
  .mind-code b.chg { animation: mindchg 0.9s ease-out; }
  @keyframes mindchg { 0% { background: #7fd8ff; color: #04121e; } 100% { background: #0d1622; } }
  .mind-bar-row { display: grid; grid-template-columns: 12px 92px 1fr; gap: 8px; align-items: center;
    margin-bottom: 7px; font-size: .85rem; }
  .mind-bar-row .dot { width: 9px; height: 9px; border-radius: 50%; }
  .mind-bar-row .meter { height: 7px; background: #0d1622; border-radius: 4px; overflow: hidden; }
  .mind-bar-row .meter i { display: block; height: 100%; width: 100%; background: linear-gradient(90deg, #2a6ea8, #7fd8ff);
    transform: scaleX(0); transform-origin: left; transition: transform .3s; }
  .mind-bar-row .det { grid-column: 2 / 4; color: #7d94ab; font-size: .78rem; margin-top: -3px; }
  .mind-bar-row.hit { animation: mindhit .8s ease-out; }
  .mind-bar-row.mend { animation: mindmend .8s ease-out; }
  .mind-bar-row.spend { animation: mindspend .8s ease-out; }
  @keyframes mindhit { 0% { background: rgba(255,92,92,.4); } 100% { background: transparent; } }
  @keyframes mindmend { 0% { background: rgba(77,255,136,.35); } 100% { background: transparent; } }
  @keyframes mindspend { 0% { background: rgba(255,159,69,.35); } 100% { background: transparent; } }
  .mind-tab-demo { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
  .mind-demo-btn { display: flex; gap: 10px; align-items: baseline; text-align: left; background: #0d1622;
    border: 1px solid #22364c; color: #cfe3f5; padding: 7px 10px; border-radius: 6px; cursor: pointer; font-family: inherit; }
  .mind-demo-btn.on { border-color: #7fd8ff; }
  .mind-demo-btn code { font-family: Consolas, monospace; color: #7fd8ff; font-size: .8rem; }
  .mind-demo-btn span { font-size: .8rem; color: #9fb4c8; }
  .mind-tab-replay { margin-top: 14px; font-size: .85rem; }
  .mind-file { display: block; color: #9fb4c8; margin-bottom: 10px; }
  .mind-file input { display: block; margin-top: 6px; color: #7d94ab; }
  .mind-replay-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .mind-replay-controls select { background: #0d1622; border: 1px solid #2a4058; color: #cfe3f5;
    padding: 5px 8px; border-radius: 6px; font-family: inherit; }
  .mind-scrub { flex: 1 1 100%; }
  .mind-time { color: #7d94ab; font-size: .8rem; }
  .mind-tab-live { margin-top: 14px; font-size: .85rem; }
  .mind-live-help { color: #9fb4c8; margin-bottom: 10px; }
  .mind-live-row { display: flex; gap: 8px; align-items: center; }
  .mind-live-row select { background: #0d1622; border: 1px solid #2a4058; color: #cfe3f5;
    padding: 5px 8px; border-radius: 6px; font-family: inherit; flex: 1; min-width: 0; }
  .mind-live-status { margin-top: 10px; color: #7d94ab; font-size: .8rem; }
  .mind-live-status.warn { color: #ffb74d; }`;
  document.head.appendChild(s);
}
