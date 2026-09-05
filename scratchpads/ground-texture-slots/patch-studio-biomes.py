import os
os.chdir(os.path.join(os.path.dirname(__file__), '..', '..'))

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:70])
        s = s.replace(old, new, 1)
    open(path, 'w', encoding='utf-8').write(s)

patch('terrain-generator-js.js', [
("""export function materialRgbaFromMasks(masks, colors = MATERIAL_COLORS, out = null) {
  const n = masks.water.length;
  const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
  const water = colors.water ?? MATERIAL_COLORS.water;
  for (let i = 0; i < n; i++) {
    let r = 0, g = 0, b = 0, total = 0;
    for (const key of ['grass', 'forest', 'dirt', 'sand', 'rock', 'snow']) {
      const wgt = masks[key][i];
      const [cr, cg, cb] = colors[key] ?? MATERIAL_COLORS[key];""",
 """// `perBiome`: optional { biomeIds: Uint8Array, tables: (colour table | null)[] } so a cell in a biome
// with its own textures takes that biome's table (the game's per-biome overrides).
export function materialRgbaFromMasks(masks, colors = MATERIAL_COLORS, out = null, perBiome = null) {
  const n = masks.water.length;
  const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
  const water = colors.water ?? MATERIAL_COLORS.water;
  const ids = perBiome?.biomeIds ?? null, tables = perBiome?.tables ?? null;
  for (let i = 0; i < n; i++) {
    let r = 0, g = 0, b = 0, total = 0;
    const own = ids && tables ? tables[ids[i]] : null;
    for (const key of ['grass', 'forest', 'dirt', 'sand', 'rock', 'snow']) {
      const wgt = masks[key][i];
      const [cr, cg, cb] = own?.[key] ?? colors[key] ?? MATERIAL_COLORS[key];"""),
])

patch('terrain-generator-v5.html', [
# state
("""  const materialRules = {};       // splat threshold overrides; unset ones derive from cfg in the game
  const materialBlock = () => {
    if (!Object.keys(materialSlots).length && !Object.keys(materialRules).length) return null;
    const block = { version: 1, slots: { ...materialSlots } };
    if (Object.keys(materialRules).length) block.rules = { ...materialRules };
    return block;
  };
  function setMaterialSlots(next) {
    for (const k of Object.keys(materialSlots)) delete materialSlots[k]; Object.assign(materialSlots, next?.slots ?? {});
    for (const k of Object.keys(materialRules)) delete materialRules[k]; Object.assign(materialRules, next?.rules ?? {});
  }""",
 """  const materialRules = {};       // splat threshold overrides; unset ones derive from cfg in the game
  const materialBiomes = {};      // biomeName -> { slots: {}, rules: {} }: that biome's own textures and thresholds
  const materialBlock = () => {
    const biomes = {};
    for (const [name, b] of Object.entries(materialBiomes)) {
      const entry = {};
      if (Object.keys(b.slots).length) entry.slots = { ...b.slots };
      if (Object.keys(b.rules).length) entry.rules = { ...b.rules };
      if (Object.keys(entry).length) biomes[name] = entry;
    }
    if (!Object.keys(materialSlots).length && !Object.keys(materialRules).length && !Object.keys(biomes).length) return null;
    const block = { version: 1, slots: { ...materialSlots } };
    if (Object.keys(materialRules).length) block.rules = { ...materialRules };
    if (Object.keys(biomes).length) block.biomes = biomes;
    return block;
  };
  function setMaterialSlots(next) {
    for (const k of Object.keys(materialSlots)) delete materialSlots[k]; Object.assign(materialSlots, next?.slots ?? {});
    for (const k of Object.keys(materialRules)) delete materialRules[k]; Object.assign(materialRules, next?.rules ?? {});
    for (const k of Object.keys(materialBiomes)) delete materialBiomes[k];
    for (const [name, b] of Object.entries(next?.biomes ?? {})) materialBiomes[name] = { slots: { ...(b.slots ?? {}) }, rules: { ...(b.rules ?? {}) } };
  }"""),
# html
("""      <div class="controls" id="material-rules"><p class="lede">Where each slot appears in the game. Heights are world metres, slopes are the surface normal's Y (1 is flat). Unchecked rules follow the World group's beach, rock and snow settings.</p><div id="material-rule-rows"></div></div>""",
 """      <div class="controls" id="material-rules"><p class="lede">Where each slot appears in the game. Heights are world metres, slopes are the surface normal's Y (1 is flat). Unchecked rules follow the World group's beach, rock and snow settings.</p><div id="material-rule-rows"></div></div>
      <div class="controls" id="material-biomes" style="flex-basis:100%;"><p class="lede">Per-biome overrides. A biome listed here draws its own textures for the slots you set and follows its own rules for the ones you tick; everything else falls back to the project-wide choice above.</p><div class="control-row"><label for="material-biome-add">Add biome</label><select id="material-biome-add"></select></div><div id="material-biome-cards"></div></div>"""),
# colour table per biome + recolour
("""  function recolourMaterial(grid) {
    if (!grid?.materialMasks) return;
    materialRgbaFromMasks(grid.materialMasks, materialColorTable(), grid.materialRgba);
  }""",
 """  // One colour table per biome that has its own slots, else null: the preview then matches the game.
  function biomeColorTables() {
    const base = materialColorTable();
    let any = false;
    const tables = BIOMES.map(name => {
      const b = materialBiomes[name];
      if (!b || !Object.keys(b.slots).length) return null;
      const t = { ...base };
      for (const slot of MATERIAL_SLOTS) { const avg = b.slots[slot] ? textureAverages[b.slots[slot]] : null; if (avg) t[slot] = avg; }
      t.forest = t.grass.map(v => v * 0.62);
      any = true;
      return t;
    });
    return any ? tables : null;
  }
  function recolourMaterial(grid) {
    if (!grid?.materialMasks) return;
    const tables = biomeColorTables();
    materialRgbaFromMasks(grid.materialMasks, materialColorTable(), grid.materialRgba, tables ? { biomeIds: grid.biomeId, tables } : null);
  }"""),
# generalise rule rows and add biome cards
("""  function renderMaterialRules() {
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
  REDRAW_CALLBACKS.push(() => renderMaterialRules());""",
 """  // Rule rows for one rules object: `fallback` is what an unticked rule resolves to in the game.
  function renderRuleRows(host, rules, fallback, tag, rerender) {
    host.innerHTML = '';
    for (const rule of MATERIAL_RULES) {
      const [label, min, max, step] = RULE_META[rule];
      const on = rule in rules;
      const row = document.createElement('div'); row.className = 'control-row';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = on; check.title = 'Override this rule';
      const lab = document.createElement('label'); const span = document.createElement('span');
      const value = on ? rules[rule] : fallback[rule];
      span.textContent = Number(value).toFixed(step < 1 ? 2 : 1); lab.textContent = label + ' '; lab.appendChild(span);
      const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value; input.disabled = !on;
      input.addEventListener('input', () => { rules[rule] = Number(input.value); span.textContent = Number(input.value).toFixed(step < 1 ? 2 : 1); });
      input.addEventListener('change', () => history.record(`${tag} ${rule}`));
      check.addEventListener('change', () => { if (check.checked) rules[rule] = Number(input.value); else delete rules[rule]; history.record(`${tag} ${rule}`); rerender(); });
      row.append(check, lab, input); host.appendChild(row);
    }
  }
  function projectWideRules() { return { ...STREAMED_SPLAT_DEFAULTS, ...splatConfigFromProject({ cfg: genConfig, material: materialBlock() }) }; }
  function renderMaterialRules() {
    renderRuleRows(document.getElementById('material-rule-rows'), materialRules, { ...STREAMED_SPLAT_DEFAULTS, ...splatConfigFromProject({ cfg: genConfig }) }, 'rule', renderMaterialRules);
    renderMaterialBiomes();
  }
  function renderMaterialBiomes() {
    const add = document.getElementById('material-biome-add');
    const free = BIOMES.filter(name => !materialBiomes[name]);
    add.innerHTML = '<option value="">choose a biome</option>' + free.map(name => `<option value="${name}">${name}</option>`).join('');
    add.onchange = () => { if (!add.value) return; materialBiomes[add.value] = { slots: {}, rules: {} }; history.record(`biome ${add.value} added`); renderMaterialBiomes(); };
    const cards = document.getElementById('material-biome-cards'); cards.innerHTML = '';
    const fallback = projectWideRules();
    for (const name of BIOMES) {
      const b = materialBiomes[name]; if (!b) continue;
      const card = document.createElement('div'); card.className = 'panel'; card.style.margin = '8px 0'; card.style.padding = '10px 14px';
      const head = document.createElement('div'); head.className = 'control-row';
      const title = document.createElement('strong'); title.textContent = name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'small'; remove.textContent = 'Remove';
      remove.addEventListener('click', () => { delete materialBiomes[name]; history.record(`biome ${name} removed`); renderMaterialBiomes(); refreshMaterialLook(); });
      head.append(title, remove); card.appendChild(head);
      for (const slot of MATERIAL_SLOTS) {
        const row = document.createElement('div'); row.className = 'control-row';
        const label = document.createElement('label'); label.textContent = slot; row.appendChild(label);
        const chosen = b.slots[slot] ?? '';
        const options = [{ folder: '', title: `project-wide (${materialSlots[slot] ?? slot})` }];
        if (groundTextureFolders) options.push(...groundTextureFolders);
        else if (chosen) options.push({ folder: chosen, title: chosen });
        row.appendChild(dropDown(options, chosen, (value) => {
          if (value) b.slots[slot] = value; else delete b.slots[slot];
          history.record(`biome ${name} ${slot}`);
          renderMaterialBiomes(); refreshMaterialLook();
        }));
        if (chosen) loadTextureAverage(chosen);
        card.appendChild(row);
      }
      const rulesHost = document.createElement('div');
      renderRuleRows(rulesHost, b.rules, fallback, `biome ${name}`, renderMaterialBiomes);
      card.appendChild(rulesHost);
      cards.appendChild(card);
    }
  }
  renderMaterialRules();
  REDRAW_CALLBACKS.push(() => renderMaterialRules());"""),
])
print('patched')
