// claudecraft-render/manifest.js
// Hand-ported (types stripped, scoped to the MOB roster) from ClaudeCraft
// src/render/characters/manifest.ts. Pure data + dispatch: the ClipMap factories,
// the VISUALS table for every key a MOB entity can resolve to, and visualKeyFor(e).
// No three.js, no loading (that lives in visual.js).
//
// Scope note: players/npcs/forms/weapon-attach/show-lists/skins/tints/emotes from the
// source manifest are intentionally omitted here. This second creature system renders
// MOBS only; the workshop's own players use the workshop capsule/ghost path. VisualDef
// is reduced to { url, height, clips, hover? } - enough to load + normalize + animate.
//
// Asset base repointed from ClaudeCraft `models/...` to the workshop copy under
// `claudecraft-assets/models/...`.
import { MOBS } from '../claudecraft-sim.bundle.js';

const BASE = 'claudecraft-assets/models';
const PLAYERS = `${BASE}/chars/players`;
const ENEMIES = `${BASE}/chars/enemies`;
const CREATURES = `${BASE}/creatures`;

const HUMANOID_H = 2.6;

// --- ClipMap factories (verbatim clip names from the source rigs) ----------------
const kaykit = (attack, idle = 'Idle') => ({
  idle, walk: 'Walking_A', run: 'Running_A', walkBack: 'Walking_Backwards',
  attack, hit: ['Hit_A'], death: 'Death_A', cast: 'Spellcasting',
  sitDown: 'Sit_Floor_Down', sitIdle: 'Sit_Floor_Idle', swim: 'Lie_Idle', jump: 'Jump_Idle',
});
const skeletonClips = (attack, flourish = 'Skeletons_Awaken_Standing') => ({
  ...kaykit(attack, 'Idle_Combat'), flourish,
});
const skeletonLargeClips = (attack) => ({
  idle: 'Idle', walk: 'Walking_A', run: 'Running_A', attack, hit: ['Hit_A'], death: 'Death_A',
});
const animal = (attack) => ({
  idle: 'Idle', walk: 'Walk', run: 'Gallop', attack,
  hit: ['Idle_HitReact_Left', 'Idle_HitReact_Right'], death: 'Death',
});
const WILD_BOAR = {
  idle: 'Idle1', walk: 'Move2 (shuffle)', run: 'Move1 (jump)',
  attack: ['Attack1 (marracca)', 'Attack2 (tusks)'], hit: ['Hurt'], death: 'Dying',
};
const BIPED14 = { idle: 'Idle', walk: 'Walk', run: 'Run', attack: ['Punch', 'Weapon'], hit: ['HitReact'], death: 'Death' };
const ENEMY7 = { idle: 'Idle', walk: 'Walk', run: 'Run', attack: ['Attack'], hit: ['HitRecieve'], death: 'Death' };
const FLOATING = { idle: 'Flying_Idle', walk: 'Fast_Flying', run: 'Fast_Flying', attack: ['Headbutt', 'Punch'], hit: ['HitReact'], death: 'Death' };
const SPIDER = { idle: 'Spider_Idle', walk: 'Spider_Walk', run: 'Spider_Walk', attack: ['Spider_Attack'], death: 'Spider_Death' };
const RAID_CASTER = { idle: 'Idle', walk: 'Walk', run: 'Walk', attack: ['Cast'], cast: 'Cast', hit: ['Hit'], death: 'Death' };
const TOLLING_BELL = { idle: 'Idle', walk: 'Roll', run: 'Roll', attack: [], death: 'Idle' };
const VELOCIRAPTOR = {
  idle: 'Velociraptor_Idle', walk: 'Velociraptor_Walk', run: 'Velociraptor_Run',
  attack: ['Velociraptor_Attack'], death: 'Velociraptor_Death', jump: 'Velociraptor_Jump',
};
const EGG_SAC = { idle: 'Idle', walk: 'Idle', run: 'Idle', attack: ['Idle'], death: 'Idle' };

// --- VISUALS (mob-reachable keys only) -------------------------------------------
export const VISUALS = {
  // beasts
  mob_wolf: { url: `${CREATURES}/wolf.glb`, height: 1.6, clips: animal(['Attack']) },
  mob_boar: { url: `${CREATURES}/wild_boar.glb`, height: 1.45, clips: WILD_BOAR },
  mob_fox: { url: `${CREATURES}/fox.glb`, height: 1.0, clips: animal(['Attack']) },
  mob_critter: { url: `${CREATURES}/fox.glb`, height: 0.7, clips: animal(['Attack']) },
  mob_stag: { url: `${CREATURES}/stag.glb`, height: 1.9, clips: animal(['Attack_Headbutt', 'Attack']) },
  mob_spearjaw: { url: `${CREATURES}/velociraptor.glb`, height: 1.8, clips: VELOCIRAPTOR },
  mob_bear: { url: `${CREATURES}/yetialt.glb`, height: 2.2, clips: BIPED14 },
  // families
  mob_spider: { url: `${CREATURES}/spider.glb`, height: 1.4, clips: SPIDER },
  mob_murloc: { url: `${CREATURES}/frog.glb`, height: 1.7, clips: BIPED14 },
  mob_kobold: { url: `${CREATURES}/goblin.glb`, height: 2.1, clips: ENEMY7 },
  mob_troll: { url: `${CREATURES}/orc.glb`, height: 2.4, clips: BIPED14 },
  mob_ogre: { url: `${CREATURES}/giant.glb`, height: 2.8, clips: ENEMY7 },
  mob_elemental: { url: `${CREATURES}/golelingevolved.glb`, height: 2.2, hover: 0.3, clips: FLOATING },
  mob_dragonkin: { url: `${CREATURES}/dragonevolved.glb`, height: 2.4, hover: 0.25, clips: FLOATING },
  mob_choir_thrall: { url: `${CREATURES}/ghost.glb`, height: 1.6, hover: 0.3, clips: FLOATING },
  mob_tolling_bell: { url: `${CREATURES}/tolling_bell.glb`, height: 3.4, clips: TOLLING_BELL },
  mob_demon: { url: `${CREATURES}/demonalt.glb`, height: 1.8, clips: BIPED14 },
  mob_demon_flying: { url: `${CREATURES}/demon.glb`, height: 1.7, hover: 0.35, clips: FLOATING },
  mob_demonalt: { url: `${CREATURES}/demonalt.glb`, height: 2.1, clips: BIPED14 },
  mob_reedbound_acolyte: { url: `${CREATURES}/stone_cantor.glb`, height: HUMANOID_H, clips: RAID_CASTER },
  mob_spider_egg_sac: { url: `${CREATURES}/spider_egg_sac.glb`, height: 1.8, clips: EGG_SAC },
  // humanoid mobs (KayKit adventurer rigs; weapons/show-lists omitted here)
  mob_bandit: { url: `${PLAYERS}/rogue_hooded.glb`, height: HUMANOID_H, clips: kaykit(['1H_Melee_Attack_Chop', 'Dualwield_Melee_Attack_Chop']) },
  mob_dark_caster: { url: `${PLAYERS}/mage.glb`, height: HUMANOID_H, clips: kaykit(['2H_Melee_Attack_Chop']) },
  mob_bruiser: { url: `${PLAYERS}/barbarian.glb`, height: HUMANOID_H, clips: kaykit(['2H_Melee_Attack_Chop']) },
  delve_mob_acolyte: { url: `${PLAYERS}/mage.glb`, height: HUMANOID_H, clips: kaykit(['2H_Melee_Attack_Chop']) },
  // undead (KayKit skeletons)
  delve_skel_wraith: { url: `${ENEMIES}/skeleton_minion.glb`, height: 2.5, clips: skeletonClips(['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal']) },
  delve_skel_ringer: { url: `${ENEMIES}/skeleton_rogue.glb`, height: 2.5, clips: skeletonClips(['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal']) },
  delve_skel_effigy: { url: `${ENEMIES}/skeleton_warrior.glb`, height: 2.5, clips: skeletonClips(['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal']) },
  delve_skel_varric: { url: `${ENEMIES}/skeleton_mage.glb`, height: 2.5, clips: skeletonClips(['2H_Melee_Attack_Chop'], 'Taunt') },
  skel_minion: { url: `${ENEMIES}/skeleton_minion.glb`, height: 2.5, clips: skeletonClips(['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal']) },
  skel_warrior: { url: `${ENEMIES}/skeleton_warrior.glb`, height: 2.5, clips: skeletonClips(['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal']) },
  skel_rogue: { url: `${ENEMIES}/skeleton_rogue.glb`, height: 2.5, clips: skeletonClips(['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal']) },
  skel_mage: { url: `${ENEMIES}/skeleton_mage.glb`, height: 2.5, clips: skeletonClips(['2H_Melee_Attack_Chop']) },
  skel_boss: { url: `${ENEMIES}/skeleton_mage.glb`, height: 2.5, clips: skeletonClips(['2H_Melee_Attack_Chop'], 'Taunt') },
  skel_necromancer: { url: `${ENEMIES}/necromancer.glb`, height: 2.5, clips: skeletonClips(['2H_Melee_Attack_Chop']) },
  skel_golem: { url: `${ENEMIES}/skeleton_golem.glb`, height: 3.4, clips: skeletonLargeClips(['2H_Melee_Attack_Chop', '1H_Melee_Attack_Chop']) },
  // player-rig delve "vision" mobs fall back to bandit rather than porting the full player set
};

// --- Dispatch (mob subset of visualKeyFor) ---------------------------------------
const MOB_KEYS = {
  emberkin: 'mob_demon', gloomshade: 'mob_demon', duskborn: 'mob_demon',
  warlock_imp: 'mob_demon_flying', warlock_voidwalker: 'mob_demonalt',
  wild_boar: 'mob_boar', old_cragmaw: 'mob_bear', bog_bloat: 'mob_murloc',
  mirefen_widowling: 'mob_spider', spider_egg_sac: 'mob_spider_egg_sac',
  sump_troll_devourer: 'mob_troll', grave_silt_bulwark: 'mob_ogre',
  drowned_cantor: 'delve_mob_acolyte', deepfen_spearjaw: 'mob_spearjaw',
  choir_thrall: 'mob_choir_thrall', tolling_bell: 'mob_tolling_bell',
  reedbound_acolyte: 'mob_reedbound_acolyte',
  gravecaller_cultist: 'mob_dark_caster', gravecaller_summoner: 'mob_dark_caster',
  sister_nhalia: 'mob_dark_caster', sister_nhalia_drowned_canticle: 'mob_dark_caster',
  deacon_voss: 'mob_dark_caster', wyrmcult_necromancer: 'mob_dark_caster',
  vael_the_mistcaller: 'mob_dark_caster', grand_necromancer_velkhar: 'mob_dark_caster',
  gorrak: 'mob_bruiser', mogger: 'mob_bruiser',
  boneclad_revenant: 'skel_warrior', marrowlord_varkas: 'skel_warrior',
  bastion_revenant: 'skel_warrior', knight_commander_olen: 'skel_warrior',
  sanctum_boneguard: 'skel_warrior', nythraxis_scourge_of_thornpeak: 'skel_golem',
  nythraxis_skeleton_warrior: 'skel_warrior',
  hollow_acolyte: 'skel_mage', sexton_marrow: 'skel_mage', morthen: 'skel_boss',
  crypt_shambler: 'skel_rogue',
  reliquary_ledger_wraith: 'delve_skel_wraith', reliquary_funeral_ringer: 'delve_skel_ringer',
  reliquary_gravecall_acolyte: 'delve_mob_acolyte', reliquary_saintless_effigy: 'delve_skel_effigy',
  deacon_varric: 'delve_skel_varric', fallen_captain_aldren: 'skel_warrior',
  corrupted_priest_malric: 'skel_necromancer', deathstalker_voss: 'skel_rogue',
};

const FAMILY_KEYS = {
  beast: 'mob_wolf', humanoid: 'mob_bandit', mudfin: 'mob_murloc', spider: 'mob_spider',
  burrower: 'mob_kobold', undead: 'skel_minion', troll: 'mob_troll', ogre: 'mob_ogre',
  elemental: 'mob_elemental', dragonkin: 'mob_dragonkin', demon: 'mob_demonalt',
};

/** Resolve a mob templateId (`tid` in the wire snapshot) to a VISUALS key. */
export function visualKeyForMob(templateId) {
  const override = MOB_KEYS[templateId];
  if (override && VISUALS[override]) return override;
  const family = MOBS[templateId]?.family;
  const famKey = family && FAMILY_KEYS[family];
  return (famKey && VISUALS[famKey]) ? famKey : 'mob_bandit';
}

/** Whether a resolved visual has a walkBack clip (drives desiredBaseState). */
export function hasWalkBack(key) {
  return !!VISUALS[key]?.clips?.walkBack;
}
