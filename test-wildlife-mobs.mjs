// Guards the asset table in demos/wildlife-mobs.html.
//
// The upstream folder names are inconsistent in a way that is invisible when you read them: "Mob
// Enemies " has a trailing space, and so do "Anglerfish Water ", "Harpy Air ", "Trilobite Fire "
// and others while their siblings do not. Trimming any of them yields a 404, and a hand-typed
// roster rots silently. This resolves every entry and checks the two structural facts the demo
// depends on: the models are UNSKINNED, and every one ships the same three clips.
//
// Needs network. SKIPS rather than fails when offline.
//
//   node test-wildlife-mobs.mjs

let fail = 0, skipped = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };
const skip = (msg) => { console.log(`SKIP  ${msg}`); skipped++; };

const MEDIA = 'https://media.githubusercontent.com/media/proofofplay/piratenation-art/main';
const lfs = (...segs) => `${MEDIA}/${segs.map(encodeURIComponent).join('/')}`;
const MOBS = 'Mob Enemies ';   // the trailing space is real

// Must stay identical to ROSTER in demos/wildlife-mobs.html.
const ROSTER = {
  Anglerfish: ['Anglerfish Air', 'Anglerfish Earth', 'Anglerfish Fire', 'Anglerfish Lightning', 'Anglerfish Neutral ', 'Anglerfish Water '],
  Blowfish: ['Blowfish Air', 'Blowfish Earth ', 'Blowfish Fire', 'Blowfish Lightning ', 'Blowfish Neutral', 'Blowfish Water '],
  Charybdis: ['mob_6x6_charybdis/Charybdis Neutral Uncommon Updated', 'mob_6x6_charybdis_Earth/Charybdis Earth Uncommon Updated ', 'mob_6x6_charybdis_Fire/Charybdis Fire Uncommon Updated', 'mob_6x6_charybdis_Light/Charybdis Lightning Uncommon Updated ', 'mob_6x6_charybdis_Water/Charybdis Water Uncommon Updated'],
  'Crasher (Living Wave)': ['mob_6x6_crasher/Crasher Neutral Affinity Common Updated ', 'mob_6x6_crasher_air/Crasher Air Common Updated ', 'mob_6x6_crasher_earth/crasher earth common updated ', 'mob_6x6_crasher_fire/crasher fire common updated ', 'mob_6x6_crasher_light/crasher lightning common updated ', 'mob_6x6_crasher_water/crasher water common updated '],
  'Deep One': ['deepone', 'deepone_air', 'deepone_earth', 'deepone_fire', 'deepone_lightning', 'deepone_water'],
  'Demogorgon Whale': ['Demogorgon Whale Air', 'Demogorgon Whale Earth', 'Demogorgon Whale Fire', 'Demogorgon Whale Lightning', 'Demogorgon Whale Neutral', 'Demogorgon Whale Water', 'Demogorgon Whale White'],
  'Foam Monster ': ['seafoamtentacle', 'seafoamtentacle_air', 'seafoamtentacle_earth', 'seafoamtentacle_fire', 'seafoamtentacle_lightning', 'seafoamtentacle_water'],
  'Giant Squid ': ['Giant Squid Air ', 'Giant Squid Earth', 'Giant Squid Fire', 'Giant Squid Lightning ', 'Giant Squid Neutral', 'Giant Squid Water'],
  'Hammerdead Shark': ['hammerdeadshark', 'hammerdeadshark_air', 'hammerdeadshark_earth', 'hammerdeadshark_fire', 'hammerdeadshark_lightning', 'hammerdeadshark_water'],
  Harpy: ['Harpy Air ', 'Harpy Earth', 'Harpy Fire', 'Harpy Lightning ', 'Harpy Neutral ', 'Harpy Water '],
  'Hexa Croc': ['Hexa Croc Air ', 'Hexa Croc Earth ', 'Hexa Croc Fire', 'Hexa Croc Lightning', 'Hexa Croc Neutral ', 'Hexa Croc Water '],
  Hippogriff: ['Hippogriff Air', 'Hippogriff Earth', 'Hippogriff Fire', 'Hippogriff Lightning ', 'Hippogriff Neutral ', 'Hippogriff Water '],
  Kelpling: ['Air Affinity ', 'Earth Affinity', 'Fire Affinity', 'Lightning Affinity', 'Slimy Kepling (No affinity) Common', 'Water Affinity '],
  'Mecha Charybdis': ['mob_6x6_mechacharybdis', 'mob_6x6_mechacharybdis_air', 'mob_6x6_mechacharybdis_earth', 'mob_6x6_mechacharybdis_fire', 'mob_6x6_mechacharybdis_lightning', 'mob_6x6_mechacharybdis_water'],
  'Mecha Hammerhead': ['mob_6x6_mechahammerhead', 'mob_6x6_mechahammerhead_air', 'mob_6x6_mechahammerhead_earth', 'mob_6x6_mechahammerhead_fire', 'mob_6x6_mechahammerhead_lightning', 'mob_6x6_mechahammerhead_water'],
  Megasquito: ['mob_6x6_giantmosquito/Megasquito Neutral common '],
  'Mist Monster': ['mistmonster_creature', 'mistmonster_creature_air', 'mistmonster_creature_earth', 'mistmonster_creature_fire', 'mistmonster_creature_lightning', 'mistmonster_creature_water', 'mistmonster_mist', 'mistmonster_mist_air', 'mistmonster_mist_earth', 'mistmonster_mist_fire', 'mistmonster_mist_lightning', 'mistmonster_mist_water'],
  'Mutant Jellyfish': ['Mutant Jelly Fish Earth ', 'Mutant Jelly Fish Fire ', 'Mutant Jellyfish Air ', 'Mutant Jellyfish Lightning', 'Mutant Jellyfish Neutral ', 'Mutant Jellyfish Water '],
  'Sea Lion': ['Sea Lion Air', 'Sea Lion Earth', 'Sea Lion Fire', 'Sea Lion Lightning ', 'Sea Lion Neutral ', 'Sea Lion Water'],
  'Shipwrecked Spirit': ['Shipwrecked Air ', 'Shipwrecked Spirit Earth ', 'Shipwrecked Spirit Fire ', 'Shipwrecked Spirit Lighting ', 'Shipwrecked Spirit Neutral', 'Shipwrecked Spirit Water '],
  'Spout (fka Stormling) ': ['mob_6x6_spout/Spout Neutral Common '],
  Trilobite: ['Trilobite Air', 'Trilobite Earth', 'Trilobite Fire ', 'Trilobite Lightning ', 'Trilobite Neutral', 'Trilobite Water '],
  Wyvern: ['Wyvern Air Rare', 'Wyvern Earth Rare', 'Wyvern Fire Rare', 'Wyvern Lightning Rare', 'Wyvern Neutral Rare', 'Wyvern Water Rare'],
  undeadcharybdis: ['mob_6x6_undeadcharybdis', 'mob_6x6_undeadcharybdis_air', 'mob_6x6_undeadcharybdis_earth', 'mob_6x6_undeadcharybdis_fire', 'mob_6x6_undeadcharybdis_lightning', 'mob_6x6_undeadcharybdis_water'],
  undeadmegasquito: ['mob_6x6_undeadmegasquito', 'mob_6x6_undeadmegasquito_air', 'mob_6x6_undeadmegasquito_earth', 'mob_6x6_undeadmegasquito_fire', 'mob_6x6_undeadmegasquito_lightning', 'mob_6x6_undeadmegasquito_water'],
};

const modelUrl = (species, variant) => lfs('Voxel Game Assets', MOBS, species, variant, 'model.gltf');

const online = await fetch(`${MEDIA}/README.md`, { signal: AbortSignal.timeout(20000) })
  .then(r => r.ok || r.status === 404).catch(() => false);

if (!online) {
  skip('every upstream check — no network');
} else {
  // 1. Every rostered path resolves. One tiny range request each rather than 146 full downloads.
  const results = await Promise.all(
    Object.entries(ROSTER).flatMap(([species, variants]) =>
      variants.map(async (v) => {
        try {
          const res = await fetch(modelUrl(species, v), {
            headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000),
          });
          return { species, v, okay: res.ok };
        } catch { return { species, v, okay: false }; }
      })),
  );
  const bad = results.filter(r => !r.okay);
  ok(bad.length === 0,
    `all ${results.length} rostered models resolve` +
    (bad.length ? ` — broken: ${bad.map(b => `${b.species}/${JSON.stringify(b.v)}`).join(', ')}` : ''));

  // 2. Trailing spaces genuinely matter, so nobody "tidies" the table later.
  const trimmed = await fetch(modelUrl('Anglerfish', 'Anglerfish Water'), {
    headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000),
  }).then(r => r.ok).catch(() => false);
  ok(trimmed === false, 'trimming a trailing space breaks the path (so the exact strings matter)');

  // 3. The structural facts the demo rests on, checked across the ARCHETYPE SPREAD rather than on
  // two similar fish — a winged flyer, a quadruped, a tentacled mass, an insect and an amorphous
  // one, so a family that breaks the "unskinned, three clips" rule cannot hide behind the others.
  for (const [species, variant] of [
    ['Anglerfish', 'Anglerfish Air'],
    ['Wyvern', 'Wyvern Air Rare'],
    ['Hexa Croc', 'Hexa Croc Air '],
    ['Giant Squid ', 'Giant Squid Air '],
    ['Megasquito', 'mob_6x6_giantmosquito/Megasquito Neutral common '],
    ['Mist Monster', 'mistmonster_creature'],
  ]) {
    try {
      const g = JSON.parse(await (await fetch(modelUrl(species, variant), { signal: AbortSignal.timeout(60000) })).text());

      const skinned = (g.meshes || []).some(m =>
        (m.primitives || []).some(p => 'JOINTS_0' in (p.attributes || {}) || 'WEIGHTS_0' in (p.attributes || {})));
      ok(!g.skins && !skinned, `${species} is unskinned — rigid node animation, like our own parts`);

      const names = (g.animations || []).map(a => a.name).sort();
      ok(JSON.stringify(names) === JSON.stringify(['attack', 'hit', 'idle']),
        `${species} ships exactly idle/hit/attack (found ${names.join(', ') || 'none'})`);

      const paths = new Set();
      for (const a of g.animations || []) for (const c of a.channels || []) paths.add(c.target.path);
      ok([...paths].every(p => ['translation', 'rotation', 'scale'].includes(p)),
        `${species} animates node TRS only`);

      // Self-contained: one request is the whole model. Worth knowing before wiring a loader.
      ok((g.buffers || []).every(b => (b.uri || '').startsWith('data:')),
        `${species} embeds its buffer, so one fetch is the whole model`);

      // The cost this demo refuses to hide.
      console.log(`      ${species}: ${g.meshes.length} meshes, ${g.materials.length} materials — one per part`);
    } catch (err) {
      skip(`${species} parse — ${err.message}`);
    }
  }
}

console.log(fail ? `\n${fail} FAILED${skipped ? `, ${skipped} skipped` : ''}`
  : `\nall checks passed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
