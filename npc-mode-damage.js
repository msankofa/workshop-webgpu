// npc-mode-damage.js
//
// Damage / hit-FX mode for the NPC design suite (docs/subsystems/npc-suite.md). Ported from
// damage-simulator.html — now a mode, not a page. It reuses the suite's persistent NPC and shared
// scene/camera/renderer/batch pool instead of owning any of them. Two things changed from the page:
//   - Variant switch goes through the shell chokepoint (ctx.applyWholeDesign) — a safe rebuild under
//     P1 — and the mode resets its per-body state (limb map, wound, bleed, effects) off the
//     'geometry' bus event, so it never manages the geometry cache or the batch pool itself.
//   - The frame is split to the shell's hooks: drivesMotion=true, so tick() paces the NPC (or poses
//     its ragdoll while dead) and flushes it between the shell's beginFrame/endFrame; afterFrame()
//     ages and syncs the effects and draws the projected stains, after the batch frame.
// Its tuning still autosaves to pcw:damageTuning (its own per-mode track), which a live bot-viewer-v3
// picks up — unchanged from the page.

import { createEffectRenderer, makeStainTexture, bloodIntensityForHealth } from './effect-renderer.js';
import { BLOOD_BASE, BLOOD_TUNING, sprayParams, stainParams, splatterParams, stumpParams } from './blood-tuning.js';
import { getDamageClass, shouldShowBlood, shouldShowSmoke } from './bot-damage-class.js';
import { buildLimbMap, limbForPart, partsOfLimb, SEVERABLE_LIMBS } from './bot-limb-map.js';
import { createWoundState, applyLimbDamage, getWoundConfig, weaponResponseFor, severedLimbs, limbThreshold, isDecapitated } from './bot-wound.js';
import {
  BLEED_DEFAULTS, SITE_WOUND, SITE_STUMP, createBleedState, openBleedSite, closeBleedSites,
  markBleedDead, stepBleed, dropsFor, bleedingSiteCount,
} from './bot-bleed.js';
import {
  HAYWIRE_DEFAULTS, HAYWIRE_DONE, haywireChance, rollHaywire, createHaywireState, stepHaywire,
  haywireImpulseDir,
} from './bot-haywire.js';
import { ragdollFromBody } from './ragdoll-body.js';
import { stepRagdoll, applyImpulseAll, jointPos } from './ragdoll.js';
import { WOUND_DEFAULTS } from './wound-mask.js';
import { EffectEntity } from './entity-types/effect.js';
import { createProjectedDecals } from './projected-decals.js';
import { resolveBodyHit, attachFromPoint, resolveAttachmentMatrix } from './bot-body-hit.js';
import { rayCapsuleHit } from './combat.js';
import { composeBot } from './bot-body-versions.js';
import { withPads, withCarrier, withPack } from './bot-human-body.js';

// Variants a hit test wants: the two shipped bots plus the clothed human. Same designs the page used.
const VARIANTS = {
  og:      { label: 'og bot (v1 blockout)', design: () => composeBot('v1', 'as authored') },
  armored: { label: 'armored bot (v5 current)', design: () => composeBot('current', 'as authored') },
  soldier: { label: 'human soldier', design: () => withPack(withCarrier(withPads(composeBot('human', 'human', { expression: 'determined' })))) },
};

export function createDamageMode(ctx) {
  const { THREE, scene, camera, renderer, batches, npc, panelRoot } = ctx;
  let body = npc.body;   // live handle; refreshed on the 'geometry' bus event after a rebuild

  // ---- panel helpers (ported; build into the mode's panel container) ----
  function el(tag, cls, parent) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }
  function section(title) {
    const h3 = el('h3', null, panelRoot); h3.textContent = title;
    const b = el('div', 'body', panelRoot);
    h3.addEventListener('click', () => h3.classList.toggle('collapsed'));
    return b;
  }
  function row(parent, labelText) {
    const r = el('div', 'row', parent);
    const l = el('label', null, r); l.textContent = labelText;
    return r;
  }
  function slider(parent, labelText, min, max, step, value, onInput) {
    const r = row(parent, labelText);
    const input = el('input', null, r);
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
    const out = el('input', null, r);
    out.type = 'number'; out.min = min; out.max = max; out.step = step; out.value = value;
    input.addEventListener('input', () => { out.value = input.value; onInput(parseFloat(input.value)); queueTuningSave(); });
    out.addEventListener('change', () => { input.value = out.value; onInput(parseFloat(out.value)); queueTuningSave(); });
    return { set(v) { input.value = v; out.value = v; onInput(parseFloat(v)); queueTuningSave(); } };
  }
  function toggle(parent, labelText, checked, onChange) {
    const r = row(parent, labelText);
    const btn = el('button', checked ? 'on' : '', r);
    btn.textContent = checked ? 'on' : 'off';
    btn.addEventListener('click', () => {
      checked = !checked;
      btn.classList.toggle('on', checked);
      btn.textContent = checked ? 'on' : 'off';
      onChange(checked);
      queueTuningSave();
    });
  }

  // ===================== settings (ported verbatim) =====================
  const settings = {
    fireMode: 'click',
    hitSource: 'parts',
    attach: true,
    motion: false,
    damageClass: 'off',
    health: 0.5,
    breached: false,
    bloodIntensity: true,
    limb: { on: false, damage: 24, armThreshold: 60, legThreshold: 75, headshotKill: true },
    bleed: {
      on: true, woundRate: BLEED_DEFAULTS.woundRate, stumpRate: BLEED_DEFAULTS.stumpRate,
      woundDrops: BLEED_DEFAULTS.woundDrops, stumpDrops: BLEED_DEFAULTS.stumpDrops,
      clotSeconds: BLEED_DEFAULTS.clotSeconds, poolGrowth: BLEED_DEFAULTS.poolGrowth,
      poolMax: BLEED_DEFAULTS.poolMax, bleedoutSeconds: BLEED_DEFAULTS.bleedoutSeconds,
      dripSpeed: 0.9, groundEvery: 3,
    },
    haywire: {
      on: true, force: false, headChance: HAYWIRE_DEFAULTS.headChance, baseChance: HAYWIRE_DEFAULTS.baseChance,
      thrashMs: HAYWIRE_DEFAULTS.thrashMs, twitchMs: HAYWIRE_DEFAULTS.twitchMs,
      thrashImpulse: HAYWIRE_DEFAULTS.thrashImpulse, fireChance: HAYWIRE_DEFAULTS.fireChance,
    },
    blood: { ...BLOOD_TUNING },
    base: { ...BLOOD_BASE },
    spray: { on: true },
    stain: { on: true, mode: 'fitted', projDebug: false },
    wound: { ...WOUND_DEFAULTS },
    splatter: { on: true },
    smoke: { on: true, size: 0.28 },
    sparks: { on: true },
  };

  // ---- tuning persistence (mode's own track; unchanged from the page) ----
  const TUNING_KEY = 'pcw:damageTuning';
  const TUNING_FILE = './damage-tuning.json';
  const TUNING_GROUPS = ['blood', 'base', 'bleed', 'haywire', 'limb', 'wound'];
  function captureTuning() { const out = {}; for (const g of TUNING_GROUPS) out[g] = { ...settings[g] }; return out; }
  function saveTuning() { try { localStorage.setItem(TUNING_KEY, JSON.stringify(captureTuning())); } catch { /* private mode */ } }
  let tuningSaveTimer = null;
  function queueTuningSave() {
    if (tuningSaveTimer != null) clearTimeout(tuningSaveTimer);
    tuningSaveTimer = setTimeout(() => { tuningSaveTimer = null; saveTuning(); }, 250);
  }
  function applyTuning(saved) {
    if (!saved || typeof saved !== 'object') return false;
    for (const g of TUNING_GROUPS) {
      if (!saved[g] || !settings[g]) continue;
      for (const k in settings[g]) if (k in saved[g] && typeof saved[g][k] === typeof settings[g][k]) settings[g][k] = saved[g][k];
    }
    return true;
  }
  function loadTuning() { try { return applyTuning(JSON.parse(localStorage.getItem(TUNING_KEY) || 'null')); } catch { return false; } }
  async function saveTuningToDisk() {
    const res = await fetch('/api/save-damage-tuning', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(captureTuning(), null, 2),
    });
    const text = await res.text();
    if (!text.trim().startsWith('{')) throw new Error(`endpoint missing (HTTP ${res.status}) — restart serve.py`);
    const out = JSON.parse(text);
    if (!out.ok) throw new Error(out.error || 'save failed');
    return out.path;
  }

  // ===================== effects =====================
  // fx and stainTex add meshes to the shared scene, so they are created in init() (not at factory
  // time) — a mode whose init never runs must not have left anything in the scene.
  let fx = null;
  let effects = [];
  let fxIdCounter = 0;
  function clearEffects() { effects = []; }

  let stainTex = null;
  let projected = null;
  function ensureProjected() {
    if (projected && projected.debugOn === settings.stain.projDebug) return projected;
    if (projected) projected.dispose();
    projected = createProjectedDecals({ THREE, scene, decalTexture: stainTex, cap: 256, debug: settings.stain.projDebug });
    projected.debugOn = settings.stain.projDebug;
    projected.setWoundStyle(settings.wound);
    return projected;
  }
  function applyWoundStyle() {
    fx.setWoundStyle(settings.wound);
    if (projected) projected.setWoundStyle(settings.wound);
  }
  const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const _pp = new THREE.Vector3(), _pn = new THREE.Vector3(), _pm = new THREE.Matrix3();

  function drawProjectedStains(includeStains = true) {
    const pool = ensureProjected();
    pool.begin();
    if (bleed.pool > 0) {
      _pp.set(deathPoint.x, 0, deathPoint.z);
      _pn.set(0, 1, 0);
      pool.push(_pp.x, _pp.y, _pp.z, _pn, bleed.pool, Math.max(0.25, bleed.pool), 0.28, 0.012, 0.02, 0.88, 0);
    }
    for (const e of includeStains ? effects : []) {
      const s = e.state;
      if (s.kind !== 'blood_stain') continue;
      const lt = e.sim.age / (s.life || 6);
      if (lt >= 1) continue;
      const a = smooth01(Math.min(1, lt * 12)) * (1 - smooth01(Math.max(0, (lt - 0.7) / 0.3))) * s.opacity;
      if (a <= 0.003) continue;
      _pp.set(e.transform.p[0], e.transform.p[1], e.transform.p[2]);
      _pn.set(s.normal[0], s.normal[1], s.normal[2]);
      const m = s.attach ? resolveAttachmentMatrix(body, s.attach) : null;
      if (m) {
        _pp.set(s.attach.lp[0], s.attach.lp[1], s.attach.lp[2]).applyMatrix4(m);
        _pm.getNormalMatrix(m);
        _pn.set(s.attach.ln[0], s.attach.ln[1], s.attach.ln[2]).applyMatrix3(_pm).normalize();
      }
      const spin = ((parseInt(e.id.replace(/\D/g, ''), 10) || 0) * 2.399963) % (Math.PI * 2);
      pool.push(_pp.x, _pp.y, _pp.z, _pn, s.size, settings.base.stainProjDepth, s.color[0], s.color[1], s.color[2], a, spin);
    }
    pool.end();
  }
  function spawnEffect(kind, params) {
    const entity = EffectEntity.create({ kind, ...params });
    entity.id = 'fx' + (fxIdCounter++);
    effects.push(entity);
  }

  // ===================== hit detection + firing =====================
  const raycaster = new THREE.Raycaster();
  const botState = {
    position: new THREE.Vector3(0, 0.9, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    yaw: 0, crouch: 0, prone: 0, alive: true, onFloor: true,
  };

  const _wb = new THREE.Box3(), _wbg = new THREE.Box3();
  function worldBounds(nodes) {
    _wb.makeEmpty();
    for (const n of nodes || []) {
      if (!n.geometry) continue;
      n.updateWorldMatrix(true, false);
      if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
      _wbg.copy(n.geometry.boundingBox).applyMatrix4(n.matrixWorld);
      _wb.union(_wbg);
    }
    return _wb;
  }
  function bodyPartAt(point) {
    if (!body) return 'torso';
    const _partBox = worldBounds(body.parts.all);
    if (_partBox.isEmpty()) return 'torso';
    const h = Math.max(0.01, _partBox.max.y - _partBox.min.y);
    const cx = (_partBox.min.x + _partBox.max.x) / 2, cz = (_partBox.min.z + _partBox.max.z) / 2;
    const halfW = Math.max(0.05, (_partBox.max.x - _partBox.min.x) / 2);
    const yFrac = (point.y - _partBox.min.y) / h;
    if (yFrac >= 0.85) return 'head';
    if (yFrac < 0.42) return 'leg';
    const lateral = Math.hypot(point.x - cx, point.z - cz);
    if (lateral > halfW * 0.55) return 'arm';
    return 'torso';
  }
  const PART_SCALE = { head: 1.5, torso: 1.15, arm: 0.85, leg: 0.85 };

  function resolveShot(origin, dir) {
    if (!body) return null;
    if (settings.hitSource === 'capsule') {
      const p = botState.position;
      const r = rayCapsuleHit([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], 200, { p: [p.x, 0.9, p.z], r: 0.3, h: 1.2 });
      if (!r.hit) return null;
      const point = new THREE.Vector3(r.point[0], r.point[1], r.point[2]);
      const nx = point.x - p.x, nz = point.z - p.z;
      const l = Math.hypot(nx, nz);
      const normal = l > 1e-4 ? new THREE.Vector3(nx / l, 0, nz / l) : new THREE.Vector3(0, 1, 0);
      return { point, normal, attach: null };
    }
    if (settings.hitSource === 'parts') return resolveBodyHit({ THREE, body, origin, dir });
    raycaster.set(origin, dir);
    const hit = batches.raycast(raycaster);
    if (!hit) return null;
    const normal = hit.normal || new THREE.Vector3(0, 1, 0);
    const att = attachFromPoint({ THREE, body, point: hit.point, normal });
    return { point: hit.point, normal, attach: att?.attach || null, crossSection: att?.crossSection || 0, part: att?.part || null };
  }

  // ===================== limb loss =====================
  let limbMap = null;
  let wound = createWoundState();
  let limbReadout = null, armThreshSlider = null, legThreshSlider = null;
  function limbMapNow() { if (!limbMap && body?.parts) limbMap = buildLimbMap(body); return limbMap; }
  function limbConfig() {
    const base = getWoundConfig(settings.damageClass === 'off' ? 'human' : settings.damageClass);
    return { ...base, armThreshold: settings.limb.armThreshold, legThreshold: settings.limb.legThreshold, headLethal: settings.limb.headshotKill };
  }
  const _stumpV = new THREE.Vector3();
  function severLimb(limb) {
    const map = limbMapNow();
    if (!map) return;
    const gone = partsOfLimb(map, limb);
    if (!gone.length) return;
    for (const p of gone) p.visible = false;
    body.setAmputated?.(limb, true);
    wound.severed[limb] = true;
    let anchor = null;
    const proximal = limb.endsWith('Arm') ? 'shoulder' : limb.endsWith('Leg') ? 'hip' : 'head';
    for (const [p, e] of map) if (e.limb === limb && e.segment === proximal) { anchor = p; break; }
    if (anchor) {
      anchor.updateWorldMatrix(true, false);
      _stumpV.setFromMatrixPosition(anchor.matrixWorld);
      const p = [_stumpV.x, _stumpV.y, _stumpV.z];
      const classOn = settings.damageClass !== 'off';
      const cls = getDamageClass(classOn ? settings.damageClass : 'human');
      if (!classOn || cls.sparks) spawnEffect('hit_spark', { p, normal: [0, 1, 0], surface: null });
      if (!classOn || cls.blood !== 'never') {
        const burst = stumpParams(settings.blood, settings.base);
        spawnEffect('blood_spray', { p, normal: [0, -0.2, 0], ...burst.spray });
        spawnEffect('blood_splatter', { p, normal: [0, -0.2, 0], ...burst.splatter });
      }
      const site = openBleedSite(bleed, { limb, segment: proximal, kind: SITE_STUMP }, performance.now(), bleedConfig());
      if (site) site.anchor = anchor;
    }
    updateLimbReadout();
    updateBleedReadout?.();
  }
  function restoreLimbs() {
    closeBleedSites(bleed);
    updateBleedReadout?.();
    const map = limbMapNow();
    if (map) {
      for (const limb of severedLimbs(wound)) {
        for (const p of partsOfLimb(map, limb)) p.visible = true;
        body.setAmputated?.(limb, false);
      }
    }
    wound = createWoundState();
    updateLimbReadout();
  }
  function accrueLimb(hitPart) {
    if (!settings.limb.on || !hitPart) return;
    const entry = limbForPart(limbMapNow(), hitPart);
    if (!entry) return;
    const res = applyLimbDamage(wound, entry.limb, settings.limb.damage, limbConfig());
    if (res.severed) severLimb(res.severed);
    updateLimbReadout();
  }

  // ===================== bleeding, death, haywire =====================
  let bleed = createBleedState();
  let bleedReadout = null;
  let dead = false, ragdoll = null, ragdollPose = null, haywire = null;
  let haywireShots = 0, haywireRolled = null;
  const deathPoint = new THREE.Vector3();
  const _bleedP = new THREE.Vector3();
  let dripSeq = 0;

  function bleedConfig() { return { ...BLEED_DEFAULTS, ...settings.bleed }; }
  function haywireConfig() { return { ...HAYWIRE_DEFAULTS, ...settings.haywire }; }
  function bleedSiteWorld(site, out) {
    if (site.anchor) { site.anchor.updateWorldMatrix(true, false); return out.setFromMatrixPosition(site.anchor.matrixWorld); }
    const m = site.attach ? resolveAttachmentMatrix(body, site.attach) : null;
    if (m && site.attach.lp) return out.set(site.attach.lp[0], site.attach.lp[1], site.attach.lp[2]).applyMatrix4(m);
    if (site.local) return out.set(site.local[0], site.local[1], site.local[2]);
    return null;
  }
  function openWound(hit, limb, kind = SITE_WOUND) {
    if (!settings.bleed.on) return;
    openBleedSite(bleed, {
      limb: limb ?? 'core', segment: hit?.segment ?? null, attach: hit?.attach ?? null,
      local: hit ? [hit.point.x, hit.point.y, hit.point.z] : null, kind,
    }, performance.now(), bleedConfig());
    updateBleedReadout?.();
  }
  function stepBleeding(dt) {
    if (!settings.bleed.on) return;
    const cfg = bleedConfig();
    const res = stepBleed(bleed, performance.now(), cfg);
    for (const site of res.drips) {
      const p = bleedSiteWorld(site, _bleedP);
      if (!p) continue;
      const stump = site.kind === SITE_STUMP;
      spawnEffect('blood_spray', {
        p: [p.x, p.y, p.z], normal: [0, -1, 0], count: Math.max(1, Math.round(dropsFor(site, cfg))),
        size: stump ? 0.032 : 0.024, speed: settings.bleed.dripSpeed * (stump ? 1.6 : 1),
        spread: stump ? 0.55 : 0.28, gravity: 9.8, life: 0.9,
      });
      if (settings.bleed.groundEvery > 0 && dripSeq++ % settings.bleed.groundEvery === 0) {
        spawnEffect('blood_splatter', {
          p: [p.x, p.y, p.z], normal: [0, -1, 0], count: stump ? 4 : 2,
          size: 0.09, opacity: 0.6, speed: settings.bleed.dripSpeed, spread: 0.3, gravity: 9.8,
        });
      }
    }
  }
  function killBot() {
    if (dead || !body) return;
    dead = true;
    markBleedDead(bleed, performance.now());
    deathPoint.set(botState.position.x, 0, botState.position.z);
    const seeded = ragdollFromBody(THREE, body, { origin: { x: botState.position.x, y: 0, z: botState.position.z }, yaw: botState.yaw });
    ragdoll = seeded.rd; ragdollPose = seeded.pose;
    haywireShots = 0;
    const cfg = haywireConfig();
    const cause = { headKill: isDecapitated(wound), severed: severedLimbs(wound).find((l) => l !== 'head') ?? null };
    haywireRolled = settings.haywire.on && (settings.haywire.force || rollHaywire(cause, Math.random, cfg));
    haywire = haywireRolled ? createHaywireState(performance.now(), cfg) : null;
    updateBleedReadout?.();
  }
  function reviveBot() {
    dead = false; ragdoll = null; ragdollPose = null; haywire = null; haywireRolled = null; haywireShots = 0;
    bleed = createBleedState();
    updateBleedReadout?.();
  }
  function stepCorpse(dt) {
    if (!dead || !ragdoll || !body) return;
    const cfg = haywireConfig();
    if (haywire) {
      const h = stepHaywire(haywire, performance.now(), Math.random, cfg);
      if (h.kick) { const d = haywireImpulseDir(); applyImpulseAll(ragdoll, { x: d.x * h.impulse, y: d.y * h.impulse, z: d.z * h.impulse }); }
      if (h.fire) {
        haywireShots++;
        const p = jointPos(ragdoll, 'head') || jointPos(ragdoll, 'chest');
        if (p) spawnEffect('hit_spark', { p: [p.x, p.y, p.z], normal: [0, 1, 0], surface: null });
        updateBleedReadout?.();
      }
      if (h.phase === HAYWIRE_DONE) { haywire = null; updateBleedReadout?.(); }
    }
    stepRagdoll(ragdoll, dt, { gravity: 25, groundHeight: () => 0 });
    body.setRagdollPose(ragdollPose);
  }

  function fireHit(hit) {
    if (!hit) return;
    accrueLimb(hit.part);
    openWound(hit, limbForPart(limbMapNow(), hit.part)?.limb ?? null);
    const part = bodyPartAt(hit.point);
    const scale = PART_SCALE[part] || 1;
    const p = [hit.point.x, hit.point.y, hit.point.z];
    const n = hit.normal ? [hit.normal.x, hit.normal.y, hit.normal.z] : [0, 1, 0];
    const classOn = settings.damageClass !== 'off';
    const cls = getDamageClass(classOn ? settings.damageClass : 'human');
    const blood = classOn ? shouldShowBlood(cls, settings.health, settings.breached).show : true;
    const sparks = classOn ? cls.sparks : true;
    const smoke = classOn ? shouldShowSmoke(cls, settings.health, settings.breached) : false;
    const I = settings.bloodIntensity ? bloodIntensityForHealth(settings.health) : bloodIntensityForHealth(0);
    if (settings.sparks.on && sparks) spawnEffect('hit_spark', { p, normal: n, surface: null });
    if (smoke) spawnEffect('smoke_puff', { p, color: [0.32, 0.31, 0.3], size: 0.1, growth: 0.35, rise: 0.5, opacity: 0.22, life: 0.7 });
    if (!blood) return;
    const spray = settings.spray.on ? sprayParams(I, settings.blood, settings.base) : null;
    if (spray) spawnEffect('blood_spray', { p, normal: n, bodyPart: part, count: spray.count, size: spray.size, speed: spray.speed, spread: spray.spread, gravity: spray.gravity, life: spray.life });
    if (settings.stain.on) {
      const fitted = settings.stain.mode === 'fitted' ? hit.crossSection : 0;
      const st = stainParams(fitted, settings.blood, settings.base);
      spawnEffect('blood_stain', { p, normal: n, bodyPart: part, size: fitted > 0 ? st.size : st.size * scale, opacity: st.opacity, life: st.life, attach: settings.attach ? (hit.attach || null) : null });
    }
    const sp = settings.splatter.on ? splatterParams(I, settings.blood, settings.base) : null;
    if (sp) spawnEffect('blood_splatter', { p, normal: n, bodyPart: part, count: sp.count, size: sp.size, opacity: sp.opacity, speed: sp.speed, spread: sp.spread, gravity: sp.gravity, life: sp.life });
    if (settings.smoke.on) spawnEffect('smoke_puff', { p, size: settings.smoke.size * scale, growth: 0.3, rise: 0.15, opacity: 0.22, life: 0.5, color: [0.45, 0.42, 0.4] });
  }

  function raycastFromCamera(clientX, clientY) {
    const ndc = new THREE.Vector2((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return resolveShot(raycaster.ray.origin.clone(), raycaster.ray.direction.clone());
  }
  function fireRandomShot() {
    if (!body) return;
    const partBox = worldBounds(body.parts.all);
    if (partBox.isEmpty()) return;
    const center = new THREE.Vector3(); partBox.getCenter(center);
    const size = new THREE.Vector3(); partBox.getSize(size);
    const aim = center.clone().add(new THREE.Vector3((Math.random() * 2 - 1) * size.x * 0.35, (Math.random() * 2 - 1) * size.y * 0.4, (Math.random() * 2 - 1) * size.z * 0.35));
    const theta = Math.random() * Math.PI * 2;
    const cosPhi = Math.random() * 2 - 1;
    const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
    const dirIn = new THREE.Vector3(sinPhi * Math.cos(theta), cosPhi, sinPhi * Math.sin(theta));
    const back = Math.max(4, size.length() * 2);
    const origin = aim.clone().addScaledVector(dirIn, back);
    const dir = aim.clone().sub(origin).normalize();
    fireHit(resolveShot(origin, dir));
  }

  // ===================== per-body reset (fires on a rebuild via the 'geometry' bus) =====================
  function resetForNewBody() {
    body = npc.body;             // the shell rebuilt it; re-point every closure's live handle
    limbMap = null;              // old map keyed objects that no longer exist
    wound = createWoundState();
    reviveBot();
    clearEffects();
    updateLimbReadout?.();
  }

  // ===================== motion =====================
  const PACE_HALF = 1.2, PACE_SPEED = 1.1;
  let paceDir = 1;
  function stepBotMotion(dt) {
    if (!settings.motion) { botState.velocity.set(0, 0, 0); return; }
    botState.position.x += paceDir * PACE_SPEED * dt;
    if (botState.position.x > PACE_HALF) { botState.position.x = PACE_HALF; paceDir = -1; }
    if (botState.position.x < -PACE_HALF) { botState.position.x = -PACE_HALF; paceDir = 1; }
    botState.velocity.set(paceDir * PACE_SPEED, 0, 0);
    botState.yaw = Math.atan2(botState.velocity.x, botState.velocity.z) + Math.PI;
  }

  // Forward-declared so buildBot-era callers (severLimb/killBot) resolve; assigned during buildPanel.
  let updateLimbReadout = () => {};
  let updateBleedReadout = () => {};
  let crosshairEl = null;
  let offGeo = null;

  // ===================== panel =====================
  function buildPanel() {
    const varBody = section('bot');
    const varRow = row(varBody, 'variant');
    const varSelect = el('select', null, varRow);
    const placeholder = el('option', null, varSelect); placeholder.value = ''; placeholder.textContent = '(suite npc)';
    for (const key in VARIANTS) { const opt = el('option', null, varSelect); opt.value = key; opt.textContent = VARIANTS[key].label; }
    varSelect.value = '';
    // Variant switch swaps the whole NPC design through the shell — a safe rebuild under P1. The
    // 'geometry' bus event (subscribed below) then resets this mode's per-body state.
    varSelect.addEventListener('change', () => { if (varSelect.value) ctx.applyWholeDesign(VARIANTS[varSelect.value].design()); });
    toggle(varBody, 'pace', settings.motion, (v) => { settings.motion = v; if (!v) { botState.position.x = 0; botState.yaw = 0; } });

    const hitBody = section('hit resolution');
    const srcRow = row(hitBody, 'source');
    const srcBtns = { capsule: null, parts: null, mesh: null };
    function setHitSource(mode) { settings.hitSource = mode; for (const k in srcBtns) srcBtns[k].classList.toggle('on', k === mode); }
    for (const k in srcBtns) { const b = el('button', null, srcRow); b.textContent = k; b.addEventListener('click', () => setHitSource(k)); srcBtns[k] = b; }
    setHitSource(settings.hitSource);
    toggle(hitBody, 'attach stains', settings.attach, (v) => settings.attach = v);
    el('div', 'note', hitBody).textContent = 'capsule = what combat gives the FX. parts = the fix. mesh = accurate reference.';

    const classBody = section('damage class');
    const clsRow = row(classBody, 'class');
    const clsBtns = { off: null, human: null, armouredHuman: null, robot: null };
    function setDamageClass(id) {
      settings.damageClass = id;
      for (const k in clsBtns) clsBtns[k].classList.toggle('on', k === id);
      const cfg = getWoundConfig(id === 'off' ? 'human' : id);
      armThreshSlider?.set(cfg.armThreshold);
      legThreshSlider?.set(cfg.legThreshold);
    }
    for (const k in clsBtns) { const b = el('button', null, clsRow); b.textContent = k === 'armouredHuman' ? 'armoured' : k; b.addEventListener('click', () => setDamageClass(k)); clsBtns[k] = b; }
    setDamageClass(settings.damageClass);
    slider(classBody, 'health after hit', 0, 1, 0.01, settings.health, (v) => settings.health = v);
    toggle(classBody, 'bleed by health', settings.bloodIntensity, (v) => settings.bloodIntensity = v);
    toggle(classBody, 'armour breached', settings.breached, (v) => settings.breached = v);
    el('div', 'note', classBody).textContent = 'armoured bleeds only below 35% health or once breached. robot never bleeds.';

    const limbBody = section('limb loss');
    toggle(limbBody, 'enabled', settings.limb.on, (v) => { settings.limb.on = v; updateLimbReadout(); });
    slider(limbBody, 'damage per hit', 1, 120, 1, settings.limb.damage, (v) => settings.limb.damage = v);
    armThreshSlider = slider(limbBody, 'arm threshold', 10, 200, 5, settings.limb.armThreshold, (v) => { settings.limb.armThreshold = v; updateLimbReadout(); });
    legThreshSlider = slider(limbBody, 'leg threshold', 10, 200, 5, settings.limb.legThreshold, (v) => { settings.limb.legThreshold = v; updateLimbReadout(); });
    toggle(limbBody, 'headshots kill', settings.limb.headshotKill, (v) => { settings.limb.headshotKill = v; updateLimbReadout(); });
    const limbBtnRow = el('div', 'btns', limbBody);
    for (const limb of [...SEVERABLE_LIMBS, 'head']) { const b = el('button', null, limbBtnRow); b.textContent = limb.replace('Arm', ' arm').replace('Leg', ' leg'); b.addEventListener('click', () => severLimb(limb)); }
    const limbRestoreRow = el('div', 'btns', limbBody);
    const restoreBtn = el('button', null, limbRestoreRow); restoreBtn.textContent = 'restore limbs';
    restoreBtn.addEventListener('click', restoreLimbs);
    limbReadout = el('div', 'note', limbBody);
    updateLimbReadout = function () {
      if (!limbReadout) return;
      const cfg = limbConfig();
      const rows = [];
      for (const limb of SEVERABLE_LIMBS) {
        const total = wound.damage[limb] || 0;
        const t = limbThreshold(limb, cfg);
        const label = limb.replace('Arm', ' arm').replace('Leg', ' leg');
        rows.push(wound.severed[limb] ? `${label}: SEVERED` : `${label}: ${Math.round(total)}/${t}`);
      }
      const headTaken = Math.round(wound.damage.head || 0);
      rows.push(isDecapitated(wound) ? 'head: KILLED' : `head: ${headTaken} taken${settings.limb.headshotKill ? ', next one is lethal' : ', not lethal'}`);
      const resp = weaponResponseFor(wound);
      rows.push(`weapon: ${resp === null ? 'both hands' : resp}`);
      if (settings.hitSource === 'capsule') rows.push('(capsule source resolves no part, so hits cannot accrue)');
      limbReadout.textContent = rows.join(' · ');
    };
    updateLimbReadout();

    const bleedBody = section('bleeding & death');
    toggle(bleedBody, 'bleeding', settings.bleed.on, (v) => { settings.bleed.on = v; updateBleedReadout(); });
    slider(bleedBody, 'wound rate /s', 0, 8, 0.1, settings.bleed.woundRate, (v) => settings.bleed.woundRate = v);
    slider(bleedBody, 'stump rate /s', 0, 20, 0.5, settings.bleed.stumpRate, (v) => settings.bleed.stumpRate = v);
    slider(bleedBody, 'wound drops', 1, 20, 1, settings.bleed.woundDrops, (v) => settings.bleed.woundDrops = v);
    slider(bleedBody, 'stump drops', 1, 40, 1, settings.bleed.stumpDrops, (v) => settings.bleed.stumpDrops = v);
    slider(bleedBody, 'drip speed', 0.1, 4, 0.1, settings.bleed.dripSpeed, (v) => settings.bleed.dripSpeed = v);
    slider(bleedBody, 'ground every', 0, 12, 1, settings.bleed.groundEvery, (v) => settings.bleed.groundEvery = v);
    slider(bleedBody, 'clot after s', 0, 60, 1, settings.bleed.clotSeconds, (v) => { settings.bleed.clotSeconds = v; updateBleedReadout(); });
    slider(bleedBody, 'pool growth', 0, 0.5, 0.01, settings.bleed.poolGrowth, (v) => settings.bleed.poolGrowth = v);
    slider(bleedBody, 'pool max r', 0.1, 2, 0.05, settings.bleed.poolMax, (v) => settings.bleed.poolMax = v);
    slider(bleedBody, 'bleedout s', 1, 120, 1, settings.bleed.bleedoutSeconds, (v) => settings.bleed.bleedoutSeconds = v);
    const deathBtnRow = el('div', 'btns', bleedBody);
    const killBtn = el('button', null, deathBtnRow); killBtn.textContent = 'kill bot'; killBtn.addEventListener('click', () => killBot());
    const reviveBtn = el('button', null, deathBtnRow); reviveBtn.textContent = 'revive'; reviveBtn.addEventListener('click', () => { reviveBot(); resetForNewBody(); });
    const healBtn = el('button', null, deathBtnRow); healBtn.textContent = 'heal (seal wounds)'; healBtn.addEventListener('click', () => { closeBleedSites(bleed); updateBleedReadout(); });
    toggle(bleedBody, 'haywire', settings.haywire.on, (v) => { settings.haywire.on = v; updateBleedReadout(); });
    toggle(bleedBody, 'force haywire', settings.haywire.force, (v) => { settings.haywire.force = v; updateBleedReadout(); });
    slider(bleedBody, 'headshot odds', 0, 1, 0.05, settings.haywire.headChance, (v) => { settings.haywire.headChance = v; updateBleedReadout(); });
    slider(bleedBody, 'base odds', 0, 1, 0.05, settings.haywire.baseChance, (v) => { settings.haywire.baseChance = v; updateBleedReadout(); });
    slider(bleedBody, 'thrash ms', 0, 5000, 100, settings.haywire.thrashMs, (v) => settings.haywire.thrashMs = v);
    slider(bleedBody, 'twitch ms', 0, 8000, 100, settings.haywire.twitchMs, (v) => settings.haywire.twitchMs = v);
    slider(bleedBody, 'thrash force', 0, 20, 0.5, settings.haywire.thrashImpulse, (v) => settings.haywire.thrashImpulse = v);
    slider(bleedBody, 'fire chance', 0, 1, 0.02, settings.haywire.fireChance, (v) => settings.haywire.fireChance = v);
    bleedReadout = el('div', 'note', bleedBody);
    updateBleedReadout = function () {
      if (!bleedReadout) return;
      const sites = bleed.sites.map((s) => `${s.limb}${s.kind === SITE_STUMP ? ' (stump)' : ''}`);
      const rows = [`bleeding from ${bleedingSiteCount(bleed)}: ${sites.join(', ') || 'nothing'}`];
      if (dead) {
        rows.push(`dead · pool r ${bleed.pool.toFixed(2)} m`);
        rows.push(haywireRolled ? `HAYWIRE${haywire ? ` (${haywire.phase})` : ' (over)'} · ${haywireShots} wild shots` : 'died normally');
      } else {
        const cause = { headKill: isDecapitated(wound), severed: severedLimbs(wound).find((l) => l !== 'head') ?? null };
        const pct = Math.round(haywireChance(cause, haywireConfig()) * 100);
        rows.push(`alive · haywire odds if it died now: ${settings.haywire.force ? 'forced' : `${pct}%`}`);
      }
      bleedReadout.textContent = rows.join(' · ');
    };
    updateBleedReadout();

    const tuneBody = section('tuning');
    const tuneBtnRow = el('div', 'btns', tuneBody);
    const tuneStatus = el('div', 'note', tuneBody);
    const saveTuneBtn = el('button', null, tuneBtnRow); saveTuneBtn.textContent = 'save';
    saveTuneBtn.addEventListener('click', () => { saveTuning(); tuneStatus.textContent = 'saved to localStorage'; });
    const diskTuneBtn = el('button', null, tuneBtnRow); diskTuneBtn.textContent = 'save to disk';
    diskTuneBtn.addEventListener('click', async () => { saveTuning(); try { tuneStatus.textContent = `wrote ${await saveTuningToDisk()}`; } catch (err) { tuneStatus.textContent = `disk save failed: ${err.message}`; } });
    const copyTuneBtn = el('button', null, tuneBtnRow); copyTuneBtn.textContent = 'copy JSON';
    copyTuneBtn.addEventListener('click', async () => { const text = JSON.stringify(captureTuning(), null, 2); saveTuning(); try { await navigator.clipboard.writeText(text); tuneStatus.textContent = 'copied'; } catch { console.log(text); tuneStatus.textContent = 'clipboard denied — dumped to console'; } });
    const resetTuneBtn = el('button', null, tuneBtnRow); resetTuneBtn.textContent = 'clear saved';
    resetTuneBtn.addEventListener('click', () => { try { localStorage.removeItem(TUNING_KEY); } catch { /* private */ } tuneStatus.textContent = 'cleared — reload for defaults'; });
    tuneStatus.textContent = `${TUNING_FILE} on load, then ${TUNING_KEY} · autosaves on every change, which an open bot-viewer-v3 picks up live`;

    const fireBody = section('fire');
    const modeRow = row(fireBody, 'mode');
    const clickBtn = el('button', 'on', modeRow); clickBtn.textContent = 'click';
    const randBtn = el('button', null, modeRow); randBtn.textContent = 'random target';
    function setFireMode(mode) { settings.fireMode = mode; clickBtn.classList.toggle('on', mode === 'click'); randBtn.classList.toggle('on', mode === 'random'); }
    clickBtn.addEventListener('click', () => setFireMode('click'));
    randBtn.addEventListener('click', () => setFireMode('random'));
    const fireBtnsRow = el('div', 'btns', fireBody);
    const randShotBtn = el('button', null, fireBtnsRow); randShotBtn.textContent = 'fire random shot'; randShotBtn.addEventListener('click', fireRandomShot);
    const clearBtn = el('button', null, fireBtnsRow); clearBtn.textContent = 'clear effects'; clearBtn.addEventListener('click', clearEffects);

    const bloodBody = section('blood (multipliers)');
    slider(bloodBody, 'blood amount ×', 0, 4, 0.1, settings.blood.amount, (v) => settings.blood.amount = v);
    slider(bloodBody, 'blood force ×', 0.1, 4, 0.1, settings.blood.force, (v) => settings.blood.force = v);
    slider(bloodBody, 'spray life', 0.1, 4, 0.1, settings.blood.sprayLife, (v) => settings.blood.sprayLife = v);
    slider(bloodBody, 'decal life', 1, 60, 1, settings.blood.decalLife, (v) => settings.blood.decalLife = v);
    slider(bloodBody, 'stain size ×', 0.25, 4, 0.05, settings.blood.stainSize, (v) => settings.blood.stainSize = v);

    const sprayBody = section('blood spray');
    toggle(sprayBody, 'enabled', settings.spray.on, (v) => settings.spray.on = v);
    slider(sprayBody, 'droplet size', 0.01, 0.2, 0.005, settings.base.spraySize, (v) => settings.base.spraySize = v);
    slider(sprayBody, 'gravity', 0, 20, 0.5, settings.base.gravity, (v) => settings.base.gravity = v);

    const stainBody = section('blood stain');
    toggle(stainBody, 'enabled', settings.stain.on, (v) => settings.stain.on = v);
    const stainModeRow = row(stainBody, 'size mode');
    const stainModeBtns = { fixed: null, fitted: null, projected: null };
    function setStainMode(mode) { settings.stain.mode = mode; for (const k in stainModeBtns) stainModeBtns[k].classList.toggle('on', k === mode); }
    for (const k in stainModeBtns) { const b = el('button', null, stainModeRow); b.textContent = k; b.addEventListener('click', () => setStainMode(k)); stainModeBtns[k] = b; }
    setStainMode(settings.stain.mode);
    slider(stainBody, 'size (fixed)', 0.02, 0.6, 0.01, settings.base.stainFixed, (v) => settings.base.stainFixed = v);
    slider(stainBody, 'fit × width', 0.1, 1.5, 0.05, settings.base.stainFit, (v) => settings.base.stainFit = v);
    slider(stainBody, 'fit min', 0.01, 0.2, 0.005, settings.base.stainFitMin, (v) => settings.base.stainFitMin = v);
    slider(stainBody, 'fit max', 0.04, 0.5, 0.01, settings.base.stainFitMax, (v) => settings.base.stainFitMax = v);
    slider(stainBody, 'opacity', 0.05, 1, 0.01, settings.base.stainOpacity, (v) => settings.base.stainOpacity = v);
    slider(stainBody, 'project depth', 0.005, 0.12, 0.005, settings.base.stainProjDepth, (v) => settings.base.stainProjDepth = v);
    toggle(stainBody, 'project debug', settings.stain.projDebug, (v) => settings.stain.projDebug = v);
    slider(stainBody, 'wound inner', 0, 0.4, 0.005, settings.wound.inner, (v) => { settings.wound.inner = v; applyWoundStyle(); });
    slider(stainBody, 'wound outer', 0.02, 0.7, 0.005, settings.wound.outer, (v) => { settings.wound.outer = v; applyWoundStyle(); });
    slider(stainBody, 'wound darken', 0.05, 1, 0.05, settings.wound.darken, (v) => { settings.wound.darken = v; applyWoundStyle(); });
    el('div', 'note', stainBody).textContent = 'fitted sizes to the part hit. projected wraps via the depth buffer; blank = unsupported.';

    const splatterBody = section('blood splatter (ground)');
    toggle(splatterBody, 'enabled', settings.splatter.on, (v) => settings.splatter.on = v);
    slider(splatterBody, 'size', 0.02, 0.5, 0.01, settings.base.splatterSize, (v) => settings.base.splatterSize = v);
    slider(splatterBody, 'life ×', 1, 3, 0.05, settings.base.splatterLifeScale, (v) => settings.base.splatterLifeScale = v);

    const smokeBody = section('smoke puff');
    toggle(smokeBody, 'enabled', settings.smoke.on, (v) => settings.smoke.on = v);
    slider(smokeBody, 'size', 0.05, 0.8, 0.01, settings.smoke.size, (v) => settings.smoke.size = v);

    const sparkBody = section('sparks');
    toggle(sparkBody, 'enabled', settings.sparks.on, (v) => settings.sparks.on = v);
  }

  // ===================== the mode contract =====================
  return {
    drivesMotion: true,
    async init() {
      // Create the scene-touching FX now (see the note where fx/stainTex are declared).
      fx = createEffectRenderer({ THREE, scene, terrainHeight: () => 0, resolveAttachment: (_ownerId, attach) => resolveAttachmentMatrix(body, attach) });
      stainTex = makeStainTexture(THREE);
      // Load shared tuning from disk (if serve.py is up), then this browser's scratch copy wins.
      try { const res = await fetch(TUNING_FILE, { cache: 'no-store' }); if (res.ok) applyTuning(await res.json()); } catch { /* no server/file */ }
      loadTuning();
      buildPanel();
      resetForNewBody();   // wire to the shell's existing NPC (no rebuild)

      // crosshair overlay (page had it in HTML; a mode owns its own DOM and removes it on dispose)
      crosshairEl = document.createElement('div');
      crosshairEl.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:14px;height:14px;z-index:4;pointer-events:none';
      const mk = (css) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;background:rgba(219,228,240,.45);' + css; crosshairEl.appendChild(d); };
      mk('left:6px;top:0;width:2px;height:14px'); mk('top:6px;left:0;height:2px;width:14px');
      document.body.appendChild(crosshairEl);

      // click-to-fire vs OrbitControls drag: only fire if pointerup lands within a few px of down.
      let downPos = null;
      ctx.addListener(renderer.domElement, 'pointerdown', (ev) => { if (ev.button === 0) downPos = { x: ev.clientX, y: ev.clientY }; });
      ctx.addListener(renderer.domElement, 'pointerup', (ev) => {
        const down = downPos; downPos = null;
        if (settings.fireMode !== 'click' || ev.button !== 0 || !down) return;
        if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4) return;
        fireHit(raycastFromCamera(ev.clientX, ev.clientY));
      });
      ctx.addListener(window, 'beforeunload', saveTuning);

      // Re-point and reset whenever the shell rebuilds the NPC (variant switch, or a future design edit).
      offGeo = ctx.on('geometry', () => resetForNewBody());
    },
    tick(dt) {
      if (!dead) stepBotMotion(dt);
      if (body && !dead) body.update(dt, botState);
      stepCorpse(dt);
      stepBleeding(dt);
      if (body) body.flush(batches);
    },
    afterFrame(dt) {
      effects = effects.filter((e) => !EffectEntity.update(e, dt));
      const projecting = settings.stain.mode === 'projected';
      const wire = effects.map((e) => EffectEntity.serialize(e));
      fx.sync(projecting ? wire.filter((w) => w.kind !== 'blood_stain') : wire, performance.now());
      if (projecting || bleed.pool > 0) drawProjectedStains(projecting);
      else if (projected) { projected.begin(); projected.end(); }
    },
    dispose() {
      saveTuning();
      offGeo?.();
      // Leave the NPC whole + alive for the next mode: death and amputation are damage-experiment
      // state, not persistent design, and a dismembered/ragdolled NPC breaks weapon IK and preview.
      restoreLimbs();
      reviveBot();
      clearEffects();
      fx?.sync([], performance.now());   // flush the rendered wire list (plan: effect-queue flush on dispose)
      fx?.dispose?.(); fx = null;
      projected?.dispose(); projected = null;
      stainTex?.dispose(); stainTex = null;
      crosshairEl?.remove(); crosshairEl = null;
      if (tuningSaveTimer != null) { clearTimeout(tuningSaveTimer); tuningSaveTimer = null; }
      // The NPC, batch pool and scene belong to the shell — left intact. Tracked listeners auto-release.
    },
  };
}
