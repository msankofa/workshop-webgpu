import os
os.chdir(os.path.join(os.path.dirname(__file__), '..', '..'))

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:60])
        s = s.replace(old, new, 1)
    open(path, 'w', encoding='utf-8').write(s)

patch('terrain-project-v5.js', [
("""export const MATERIAL_SLOTS = Object.freeze(['sand', 'grass', 'dirt', 'rock', 'snow']);""",
 """export const MATERIAL_SLOTS = Object.freeze(['sand', 'grass', 'dirt', 'rock', 'snow']);
// Where each slot appears: the splat's own uniform names (terrain-splat-streamed.js). Heights are
// world metres, slopes are normal.y. Unset means derived from cfg (splatConfigFromProject).
export const MATERIAL_RULES = Object.freeze(['shoreTop', 'grassTop', 'dirtTop', 'snowBottom', 'snowTop', 'rockSlope', 'rockFull']);"""),
("""  for (const k of Object.keys(raw)) if (k !== 'version' && k !== 'slots') fail(`unknown material field ${k}`, `material.${k}`);""",
 """  for (const k of Object.keys(raw)) if (k !== 'version' && k !== 'slots' && k !== 'rules') fail(`unknown material field ${k}`, `material.${k}`);"""),
("""    slots[k] = v;
  }
  return { version: 1, slots };""",
 """    slots[k] = v;
  }
  const rules = {};
  const rsrc = raw.rules ?? {};
  if (typeof rsrc !== 'object' || Array.isArray(rsrc)) fail('material.rules must be an object', 'material.rules');
  for (const [k, v] of Object.entries(rsrc)) {
    if (!MATERIAL_RULES.includes(k)) fail(`unknown material rule ${k}`, `material.rules.${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`material.rules.${k} must be a finite number`, `material.rules.${k}`);
    rules[k] = v;
  }
  const out = { version: 1, slots };
  if (Object.keys(rules).length) out.rules = rules;
  return out;"""),
])

patch('terrain-splat-streamed.js', [
("""// Swap the pictures behind an already-bound texture set in place""",
 """// The splat thresholds a project implies: its cfg's beach, rock and snow rules converted into the
// splat's frame (rock slope is a gradient magnitude there, normal.y here), then material.rules on
// top. Pure; the result is an updateStreamedSplat patch. Missing cfg fields keep the defaults.
export function splatConfigFromProject(project, defaults = STREAMED_SPLAT_DEFAULTS) {
  const cfg = project?.cfg ?? {};
  const out = {};
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const normalY = g => 1 / Math.sqrt(1 + g * g);
  if (num(cfg.sea_level) && num(cfg.beach_width)) out.shoreTop = cfg.sea_level + 1 + Math.max(0, cfg.beach_width - 1) * 0.5;
  else if (num(cfg.sea_level)) out.shoreTop = cfg.sea_level + defaults.shoreTop;
  if (num(cfg.rock_slope_start)) out.rockSlope = normalY(cfg.rock_slope_start);
  if (num(cfg.rock_slope_full)) out.rockFull = normalY(cfg.rock_slope_full);
  if (num(cfg.snow_height_start)) out.snowBottom = cfg.snow_height_start;
  if (num(cfg.snow_height_full)) out.snowTop = cfg.snow_height_full;
  for (const [k, v] of Object.entries(project?.material?.rules ?? {})) if (num(v) && k in defaults) out[k] = v;
  if (out.rockFull !== undefined && out.rockSlope !== undefined && out.rockFull > out.rockSlope) [out.rockFull, out.rockSlope] = [out.rockSlope, out.rockFull];
  return out;
}

// Swap the pictures behind an already-bound texture set in place"""),
])

patch('base-game.html', [
("""import { loadStreamedSplatTextures, createStreamedSplatMaterial, updateStreamedSplat, splatSlotFolders, STREAMED_SPLAT_LAYERS } from './terrain-splat-streamed.js';""",
 """import { loadStreamedSplatTextures, createStreamedSplatMaterial, updateStreamedSplat, splatSlotFolders, splatConfigFromProject, STREAMED_SPLAT_LAYERS } from './terrain-splat-streamed.js';"""),
("""  terrain.setSplatMaterial(createStreamedSplatMaterial(tex, { tileMeters: settings.terrainTextureTile, fadeFar: settings.terrainTextureFade }), tex);
  return tex;""",
 """  terrain.setSplatMaterial(createStreamedSplatMaterial(tex, { tileMeters: settings.terrainTextureTile, fadeFar: settings.terrainTextureFade }), tex);
  if (terrainStore.activeProject) terrain.updateSplat(splatConfigFromProject(terrainStore.activeProject));
  return tex;"""),
("""  applyGroundTextureSlots(project.material?.slots ?? null).catch(err => console.warn(`ground texture slots not applied: ${err.message}`));""",
 """  applyGroundTextureSlots(project.material?.slots ?? null).catch(err => console.warn(`ground texture slots not applied: ${err.message}`));
  terrain.updateSplat(splatConfigFromProject(project));"""),
])

patch('terrain-generator-v5.html', [
("""  import { normalizeProject, hashProject, canonicalProjectJson, classifyProject, PROJECT_ALGORITHM_VERSION, PROJECT_ALGORITHM_UNBOUNDED, MATERIAL_SLOTS } from './terrain-project-v5.js';""",
 """  import { normalizeProject, hashProject, canonicalProjectJson, classifyProject, PROJECT_ALGORITHM_VERSION, PROJECT_ALGORITHM_UNBOUNDED, MATERIAL_SLOTS, MATERIAL_RULES } from './terrain-project-v5.js';
  import { splatConfigFromProject, STREAMED_SPLAT_DEFAULTS } from './terrain-splat-streamed.js';"""),
("""  const materialSlots = {};
  const materialBlock = () => Object.keys(materialSlots).length ? { version: 1, slots: { ...materialSlots } } : null;
  function setMaterialSlots(next) { for (const k of Object.keys(materialSlots)) delete materialSlots[k]; Object.assign(materialSlots, next?.slots ?? {}); }""",
 """  const materialSlots = {};
  const materialRules = {};       // splat threshold overrides; unset ones derive from cfg in the game
  const materialBlock = () => {
    if (!Object.keys(materialSlots).length && !Object.keys(materialRules).length) return null;
    const block = { version: 1, slots: { ...materialSlots } };
    if (Object.keys(materialRules).length) block.rules = { ...materialRules };
    return block;
  };
  function setMaterialSlots(next) {
    for (const k of Object.keys(materialSlots)) delete materialSlots[k]; Object.assign(materialSlots, next?.slots ?? {});
    for (const k of Object.keys(materialRules)) delete materialRules[k]; Object.assign(materialRules, next?.rules ?? {});
  }"""),
("""      <div class="controls" id="material-slots"><p class="lede">Ground texture slots</p><div id="material-slot-rows"></div><p id="material-slot-status" class="lede"></p></div>""",
 """      <div class="controls" id="material-slots"><p class="lede">Ground texture slots</p><div id="material-slot-rows"></div><p id="material-slot-status" class="lede"></p></div>
      <div class="controls" id="material-rules"><p class="lede">Where each slot appears in the game. Heights are world metres, slopes are the surface normal's Y (1 is flat). Unchecked rules follow the World group's beach, rock and snow settings.</p><div id="material-rule-rows"></div></div>"""),
("""  renderMaterialSlots();
  fetch('/api/list-ground-textures')""",
 """  renderMaterialSlots();
  // ---- splat rules: each row is a checkbox (override on) plus a slider; off means derived from cfg ----
  const RULE_META = {
    shoreTop: ['shore top (m)', -40, 240, 0.5], grassTop: ['grass top (m)', -40, 400, 1], dirtTop: ['dirt top (m)', -40, 400, 1],
    snowBottom: ['snow bottom (m)', -40, 400, 1], snowTop: ['snow top (m)', -40, 400, 1],
    rockSlope: ['rock starts (normal y)', 0, 1, 0.01], rockFull: ['rock full (normal y)', 0, 1, 0.01],
  };
  function renderMaterialRules() {
    const host = document.getElementById('material-rule-rows'); host.innerHTML = '';
    const derived = { ...STREAMED_SPLAT_DEFAULTS, ...splatConfigFromProject({ cfg: genConfig }) };
    for (const rule of MATERIAL_RULES) {
      const [label, min, max, step] = RULE_META[rule];
      const on = rule in materialRules;
      const row = document.createElement('div'); row.className = 'control-row';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = on; check.title = 'Override this rule';
      const lab = document.createElement('label'); const span = document.createElement('span');
      const value = on ? materialRules[rule] : derived[rule];
      span.textContent = Number(value).toFixed(step < 1 ? 2 : 1); lab.textContent = label + ' '; lab.appendChild(span);
      const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value; input.disabled = !on;
      input.addEventListener('input', () => { materialRules[rule] = Number(input.value); span.textContent = Number(input.value).toFixed(step < 1 ? 2 : 1); });
      input.addEventListener('change', () => history.record(`rule ${rule}`));
      check.addEventListener('change', () => { if (check.checked) materialRules[rule] = Number(input.value); else delete materialRules[rule]; history.record(`rule ${rule}`); renderMaterialRules(); });
      row.append(check, lab, input); host.appendChild(row);
    }
  }
  renderMaterialRules();
  REDRAW_CALLBACKS.push(() => renderMaterialRules());
  fetch('/api/list-ground-textures')"""),
("""    setMaterialSlots(project.material); renderMaterialSlots();
    if (project.name)""",
 """    setMaterialSlots(project.material); renderMaterialSlots(); renderMaterialRules();
    if (project.name)"""),
("""      setMaterialSlots(s.material); renderMaterialSlots();""",
 """      setMaterialSlots(s.material); renderMaterialSlots(); renderMaterialRules();"""),
])
print('patched')
