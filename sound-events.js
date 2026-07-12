// Sound event registry for THIS workspace (WebGPU environment viewer).
//
// Curated to the events environment-viewer.html actually fires — not the arena-shooter
// catalog this audio system was originally ported from. Every id below is triggered by a
// real `envAudio.play/playAt` call site (or, for the two music ids, the music system).
// Adding a new sound is a two-step job: add its id here, then fire it in
// environment-viewer.html. See docs/subsystems/audio.md for the fire sites.
//
// Both environment-audio.js (which only loads ids in this list) and sfx-browser.html (whose
// ASSIGN EVENT picker is built from this list) import it, so the assignable set and the
// loadable set can never drift.

export const SOUND_EVENT_DEFS = [
  // -- Weapons / combat --------------------------------------------------------
  { id: 'pistol_shoot',   label: 'Weapon - Pistol Shot' },      // m1911 + five_seven + default (weaponFireEvent)
  { id: 'sniper_shoot',   label: 'Weapon - Sniper Shot' },      // m24 (weaponFireEvent)
  { id: 'rifle_shoot',    label: 'Weapon - Rifle Shot' },       // cz_805_bren (weaponFireEvent)
  { id: 'rocket_launch',  label: 'Weapon - Rocket Launch' },    // rpg (weaponFireEvent)
  { id: 'grenade_throw',  label: 'Weapon - Grenade Throw' },    // grenade (weaponFireEvent)
  { id: 'knife_swing',    label: 'Weapon - Knife Swing' },      // knife (weaponFireEvent)
  { id: 'explosion',      label: 'Weapon - Explosion' },        // rocket/grenade detonation (applyExplosionBlast)
  { id: 'enemy_hit',      label: 'Weapon - Bullet Hit (flesh)' }, // bullet strikes a player/creature
  { id: 'bullet_impact',  label: 'Weapon - Bullet Impact (world)' }, // bullet strikes terrain/rock/tree
  { id: 'player_damage',  label: 'Player - Take Damage' },

  // -- Movement ----------------------------------------------------------------
  { id: 'footstep',       label: 'Footstep' },
  { id: 'jump',           label: 'Jump' },
  { id: 'landing',        label: 'Landing' },

  // -- UI / interaction --------------------------------------------------------
  { id: 'pause_open',     label: 'Pause - Open' },
  { id: 'pause_close',    label: 'Pause - Close' },
  { id: 'map_menu_open',  label: 'Map Menu - Open' },
  { id: 'map_menu_close', label: 'Map Menu - Close' },
  { id: 'beam_quick',     label: 'Light Tool - Beam' },

  // -- VR environment ----------------------------------------------------------
  { id: 'vr_drive_on',    label: 'VR - Drive Mode On' },
  { id: 'vr_drive_off',   label: 'VR - Drive Mode Off' },
  { id: 'vr_light_spawn', label: 'VR - Light Spawn' },
  { id: 'vr_model_snap',  label: 'VR - Model Snap to Ground' },

  // -- Music (handled by the music system, not play()) -------------------------
  { id: 'music_menu',     label: 'Music - Menu' },
  { id: 'music_game',     label: 'Music - In Game' },
];

export const SOUND_EVENTS = SOUND_EVENT_DEFS.map(event => event.id);
export const soundEventIds = new Set(SOUND_EVENTS);

export function soundEventById(id) {
  return SOUND_EVENT_DEFS.find(event => event.id === id) || null;
}
