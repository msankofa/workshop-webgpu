// index.js -- the demo registry material-viewer.html loads from.
//
// Entries carry just enough to render the picker before anything is imported; the module itself
// is fetched on demand, matching how environment-viewer.html gates its subsystems behind lazy
// import(). The summary fields are duplicated from each module's `meta` on purpose, and
// test-materials.mjs fails if the two ever drift.

export const DEMOS = [
  {
    id: 'dissolve',
    name: 'Dissolve / Materialize',
    blurb: 'Fractal-noise threshold with a glowing burn edge. One scalar drives spawn-in and death.',
    targets: 'Bot shell, props, pickups',
    cost: 'low',
    load: () => import('./dissolve.js'),
  },
  {
    id: 'hologram-visor',
    name: 'Holographic Visor',
    blurb: 'Fresnel rim, object-space scanlines and flicker. Reads as an active sensor at range.',
    targets: 'Bot visor, scopes, arena screens',
    cost: 'low',
    load: () => import('./hologram-visor.js'),
  },
  {
    id: 'damage-overheat',
    name: 'Damage / Overheat',
    blurb: 'Scorch spread and glowing cracks driven by health. Readable at range with no HUD.',
    targets: 'Bot shell, destructible props',
    cost: 'low',
    load: () => import('./damage-overheat.js'),
  },
  {
    id: 'foliage-sss',
    name: 'Foliage Backlight (fake SSS)',
    blurb: 'Wrapped translucency lobe. Leaves glow when lit from behind, for one dot and a pow.',
    targets: 'Trees, grass, understory plants',
    cost: 'low',
    load: () => import('./foliage-sss.js'),
  },
];

export function demoEntry(id) {
  return DEMOS.find(d => d.id === id) ?? null;
}

// Loads a demo module and instantiates it. Returns the handle described in material-demo-api.js.
export async function loadDemo(id, opts = {}) {
  const entry = demoEntry(id);
  if (!entry) throw new Error(`unknown material demo: ${id}`);
  const mod = await entry.load();
  return mod.create(opts);
}
