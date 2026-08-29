// Ambience registry: the slots a looping sound bed can be assigned to, as opposed to the one-shot
// game events in `sound-events.js`. Same contract as that file -- this is the single source of
// truth, imported by `sfx-browser.html` (which builds its assignment UI from it) and by whatever
// runtime ends up playing the beds, so the assignable set and the loadable set cannot drift.
//
// Two kinds, because they are chosen differently at runtime:
//   `ambience` -- a bed selected by world condition (time of day, terrain, weather).
//   `location` -- an emitter anchored to a point in the world, heard positionally.
//
// One of these slots holds several sounds, not one: a forest is wind plus birds plus distant
// water, each at its own volume. That is the main difference from `sound-events.js`.
//
// Nothing plays these yet. The editor writes them; wiring the runtime is a separate job.

export const MAX_ENVIRONMENT_LAYERS = 4;

export const SOUND_ENVIRONMENT_DEFS = [
  // -- Ambience beds: open ground, by time of day ------------------------------
  { id: 'amb_open_day',      label: 'Open ground - day',      kind: 'ambience', hint: 'Outdoors in daylight.' },
  { id: 'amb_open_night',    label: 'Open ground - night',    kind: 'ambience', hint: 'Outdoors after dark: insects, distant calls.' },
  { id: 'amb_open_dawn',     label: 'Open ground - dawn',     kind: 'ambience', hint: 'Around sunrise, when the birds start.' },
  { id: 'amb_open_dusk',     label: 'Open ground - dusk',     kind: 'ambience', hint: 'Around sunset.' },

  // -- Ambience beds: terrain character ----------------------------------------
  { id: 'amb_forest_day',    label: 'Forest - day',           kind: 'ambience', hint: 'Under trees, daylight.' },
  { id: 'amb_forest_night',  label: 'Forest - night',         kind: 'ambience', hint: 'Under trees, after dark.' },
  { id: 'amb_highland_wind', label: 'Highland - exposed wind', kind: 'ambience', hint: 'Up high, nothing blocking the wind.' },
  { id: 'amb_shore',         label: 'Shore - near water',     kind: 'ambience', hint: 'Next to the sea.' },
  { id: 'amb_interior',      label: 'Interior - enclosed',    kind: 'ambience', hint: 'Inside a building.' },

  // -- Ambience beds: weather --------------------------------------------------
  { id: 'amb_rain',          label: 'Weather - rain',         kind: 'ambience', hint: 'Rain, played on top of the normal sound.' },
  { id: 'amb_wind_strong',   label: 'Weather - strong wind',  kind: 'ambience', hint: 'Strong wind.' },
  { id: 'amb_thunder',       label: 'Weather - thunder',      kind: 'ambience', hint: 'Thunder in the distance.' },

  // -- Located emitters: heard positionally from a point ------------------------
  { id: 'loc_river',         label: 'Location - river',       kind: 'location', hint: 'Running water.' },
  { id: 'loc_waterfall',     label: 'Location - waterfall',   kind: 'location', hint: 'Falling water. Louder, heard from further away.' },
  { id: 'loc_campfire',      label: 'Location - campfire',    kind: 'location', hint: 'A small fire crackling.' },
  { id: 'loc_birds_roost',   label: 'Location - bird roost',  kind: 'location', hint: 'Lots of birds in one tree or cliff.' },
  { id: 'loc_machinery',     label: 'Location - machinery',   kind: 'location', hint: 'Machines humming.' },
];

export const SOUND_ENVIRONMENTS = SOUND_ENVIRONMENT_DEFS.map(env => env.id);
export const soundEnvironmentIds = new Set(SOUND_ENVIRONMENTS);

export function soundEnvironmentById(id) {
  return SOUND_ENVIRONMENT_DEFS.find(env => env.id === id) || null;
}

export function environmentsOfKind(kind) {
  return SOUND_ENVIRONMENT_DEFS.filter(env => env.kind === kind);
}

// Assets live under assets/env/ so they never collide with the `<eventId><ext>` files the
// one-shot events write into assets/. The layer file is named after its SOURCE, not its index,
// so removing one layer never renumbers (and so never has to rename) the others.
export function environmentLayerPath(envId, fileName) {
  const safe = String(fileName || 'layer').replace(/[^A-Za-z0-9._-]+/g, '_');
  return `assets/env/${envId}__${safe}`;
}

function cleanLayer(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || !raw.path) return null;
  const gain = Number(raw.gain);
  return {
    path: raw.path,
    source: typeof raw.source === 'string' ? raw.source : '',
    gain: Number.isFinite(gain) ? Math.max(0, Math.min(2, gain)) : 1,
    loop: raw.loop !== false,
  };
}

// Accepts whatever is in sound-map.json's `environments` and returns only well-formed slots for
// ids this registry knows, so a hand-edited or stale file cannot inject junk into the runtime.
export function normalizeEnvironmentMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!soundEnvironmentIds.has(id)) continue;
    const layers = Array.isArray(value?.layers) ? value.layers : Array.isArray(value) ? value : [];
    const clean = layers.map(cleanLayer).filter(Boolean).slice(0, MAX_ENVIRONMENT_LAYERS);
    if (clean.length) out[id] = { layers: clean };
  }
  return out;
}
