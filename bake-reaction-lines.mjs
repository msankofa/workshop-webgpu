// One-pass bulk bake for the six reaction/reflex lines added 2026-08-05 (spawn, hit, grenade_hit,
// near_miss, ally_hit, death): appends the low/mid/high wording drafted in chat to every combat
// voice's lexicon, bakes each as real ElevenLabs audio, and updates the manifest -- same pattern as
// bake-intensity-variants.mjs (validated single-pass design: write lexicon + bake audio in one loop
// per (voice, line, variant), one writeManifest() call at the end, no browser/relay involvement).
//
//   node bake-reaction-lines.mjs           run for real (real, paid ElevenLabs calls)
//   node bake-reaction-lines.mjs --dry-run  print the plan, bake nothing, spend nothing
//
// Unlike bake-intensity-variants.mjs, these six lineIds are brand new -- no voice has ever
// customized them, so no dedup skips are expected; every planned line should actually bake.
import { readFile, writeFile } from 'node:fs/promises';
import { SOUND_PARAMS, applyParamOverrides, setMapOverride, exportParams } from './sound-params.js';
import { elevenKey, elevenCatalog, bakeOneEleven, writeManifest } from './bake-voices.mjs';

const VOICES = ['harry', 'adam', 'daniel', 'river', 'callum', 'bill', 'brian', 'charlie', 'sarah', 'alice'];

const A = SOUND_PARAMS.voiceIntensity;
// Three named bands, not five slots: low -> calm, mid -> wary, high -> push. Matches the mapping
// bake-intensity-variants.mjs used for its own low/mid/high texts (mid landed on wary there too),
// and leaves the gap around `defensive` (0.67) to the base variant's implicit neutral 0.5.
const BAND = { low: A.anchorCalm, mid: A.anchorWary, high: A.anchorPush };

// { text, band } per line, drafted and reviewed in the 2026-08-05 chat session. death is
// deliberately pure vocalization -- no phrasing -- since a death cry is a reflex, not
// communication; hit/grenade_hit mix wordless pain reactions with tactical follow-through rather
// than always narrating the wound.
const NEW_LINES = {
  spawn: [
    { text: '[whispers] loaded up, good to go', band: 'low' },
    { text: '[whispers] set and ready', band: 'low' },
    { text: 'ready to go', band: 'mid' },
    { text: 'locked in', band: 'mid' },
    { text: "[shouts] LOCKED AND LOADED, LET'S MOVE!", band: 'high' },
    { text: '[shouts] UP AND READY, GO GO!', band: 'high' },
  ],
  hit: [
    { text: '[hisses] tch--', band: 'low' },
    { text: '[whispers] ...ow--', band: 'low' },
    { text: '[whispers] grazed me', band: 'low' },
    { text: 'gah--', band: 'mid' },
    { text: 'unh, took one--', band: 'mid' },
    { text: "I'm hit", band: 'mid' },
    { text: '[shouts] AGH!', band: 'high' },
    { text: "[shouts] GAH-- I'M HIT!", band: 'high' },
    { text: "[shouts] TAKING FIRE, I'M HIT!", band: 'high' },
  ],
  grenade_hit: [
    { text: '[hisses] ...ngh--', band: 'low' },
    { text: '[whispers] ...that hurt--', band: 'low' },
    { text: '[whispers] caught some frag', band: 'low' },
    { text: 'guh--', band: 'mid' },
    { text: "agh, that's frag--", band: 'mid' },
    { text: 'frag got me!', band: 'mid' },
    { text: '[shouts] AAAGH!', band: 'high' },
    { text: '[shouts] GAH-- BLAST GOT ME!', band: 'high' },
    { text: '[shouts] TOOK A FRAG, HURT BAD!', band: 'high' },
  ],
  near_miss: [
    { text: '[whispers] shots close', band: 'low' },
    { text: '[whispers] missed me', band: 'low' },
    { text: 'taking fire!', band: 'mid' },
    { text: 'shots incoming!', band: 'mid' },
    { text: '[shouts] TAKING HEAVY FIRE, PINNED!', band: 'high' },
    { text: '[shouts] ROUNDS EVERYWHERE, GET DOWN!', band: 'high' },
  ],
  ally_hit: [
    { text: "[whispers] he's alright, still up", band: 'low' },
    { text: '[whispers] check on him', band: 'low' },
    { text: 'he\'s hit, keep an eye on him!', band: 'mid' },
    { text: "watch him, he's bleeding!", band: 'mid' },
    { text: "[shouts] MEDIC, HE'S HURT BAD!", band: 'high' },
    { text: "[shouts] EYES ON HIM, HE'S HURT!", band: 'high' },
  ],
  death: [
    { text: '[gasps] ...ah!', band: 'low' },
    { text: '[whispers] ...no--', band: 'low' },
    { text: 'unh--', band: 'mid' },
    { text: 'aagh--', band: 'mid' },
    { text: '[shouts] AAAAAAGH!', band: 'high' },
    { text: '[shouts] NOOOO!', band: 'high' },
  ],
};

const dryRun = process.argv.includes('--dry-run');

applyParamOverrides(JSON.parse(await readFile('./sound-params.json', 'utf8')));
const key = dryRun ? null : await elevenKey();
const cat = dryRun ? null : await elevenCatalog(key);

let planned = 0, skippedDupe = 0, failed = 0;

for (const slug of VOICES) {
  const voiceId = `eleven/${slug}`;
  const meta = cat?.get(slug);
  if (!dryRun && !meta) { console.error(`"${slug}" is not a voice on this ElevenLabs account -- skipping`); continue; }

  const voiceDoc = JSON.parse(JSON.stringify(SOUND_PARAMS.voiceLexicon?.[voiceId] || {}));
  for (const [lineId, entries] of Object.entries(NEW_LINES)) {
    const existing = voiceDoc[lineId]?.variants ?? [];
    const existingTexts = new Set(existing.map(v => v.text));
    const merged = [...existing];
    let nextIdx = existing.length;
    for (const { text, band } of entries) {
      if (existingTexts.has(text)) { skippedDupe++; continue; }
      merged.push({ text, intensity: BAND[band] });
      const variantIndex = nextIdx++;
      planned++;
      if (dryRun) {
        console.log(`${slug.padEnd(8)} ${lineId.padEnd(12)} #${variantIndex}  (${band})  ${text}`);
        continue;
      }
      try {
        await bakeOneEleven({ slug, elevenVoiceId: meta.id, key, lineId, variantIndex, text });
        process.stdout.write('.');
      } catch (err) {
        failed++;
        console.error(`\nFAILED ${slug}/${lineId}#${variantIndex}: ${err.message}`);
      }
    }
    voiceDoc[lineId] = { variants: merged };
  }
  if (!dryRun) {
    setMapOverride('voiceLexicon', voiceId, voiceDoc);
    // Checkpoint after every voice, not just at the end -- a crash on voice 8 of 10 must not lose
    // the lexicon writes (and the money already spent generating) for voices 1-7.
    await writeFile('./sound-params.json', JSON.stringify(exportParams(), null, 2));
    console.log(`\n${slug}: done`);
  }
}

console.log(`\nplanned ${planned}, skipped as duplicate ${skippedDupe}, failed ${failed}`);
if (!dryRun) {
  await writeManifest();
  console.log('manifest rewritten -- open voice-line-studio.html to see the new cards');
}
