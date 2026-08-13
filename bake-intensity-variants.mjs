// One-pass bulk bake: appends the low/mid/high intensity variant lines drafted in the
// 2026-08-03 voice-intensity authoring session to every combat voice's lexicon, bakes each as
// real ElevenLabs audio, and updates the manifest -- so voice-line-studio.html shows them as
// ordinary generated cards, exactly as if a human had clicked "+ ADD VARIANT" / "GENERATE" for
// each one by hand. No browser, no voice-bake-server.mjs relay: this is a one-time batch job, not
// an interactive authoring session, so it writes sound-params.json and calls bakeOneEleven
// directly rather than going through the UI's save-before-generate/confirm() dance, which exists
// only to protect in-browser edits from being lost -- irrelevant when a script owns the write.
//
//   node bake-intensity-variants.mjs           run for real (real, paid ElevenLabs calls)
//   node bake-intensity-variants.mjs --dry-run  print the plan, bake nothing, spend nothing
//
// Real cost: ~15k characters across ~640 calls (some skipped as exact-text duplicates of a
// voice's own already-customized lines) on the eleven_v3 model, estimated $3-6 depending on plan.
import { readFile, writeFile } from 'node:fs/promises';
import { SOUND_PARAMS, applyParamOverrides, setMapOverride, exportParams } from './sound-params.js';
import { elevenKey, elevenCatalog, bakeOneEleven, writeManifest } from './bake-voices.mjs';

const VOICES = ['harry', 'adam', 'daniel', 'river', 'callum', 'bill', 'brian', 'charlie', 'sarah', 'alice'];

// Order per event: [low-a, low-b, mid-alt, high-a, high-b], drafted in chat against the existing
// base/mid line already in bot-voice.js's VOICE_LINES. Intensities use the same four named anchors
// the studio's own tone dropdown offers (SOUND_PARAMS.voiceIntensity), so these sit on the same
// scale as every hand-authored variant already in the lexicon rather than inventing a fifth scale.
const A = SOUND_PARAMS.voiceIntensity;
const BAND = [A.anchorCalm, A.anchorCalm, A.anchorWary, A.anchorDefensive, A.anchorPush];

const NEW_LINES = {
  grenade_warn: ['[whispers] grenade, heads up', '[whispers] frag inbound', 'grenade out there!', '[shouts] GRENADE, INCOMING!', '[shouts] GRENADE, GET DOWN!'],
  grenade_out: ['[whispers] frag out', '[whispers] tossing a frag', 'grenade away', '[shouts] FRAG OUT!!!', '[shouts] GRENADE OUT, CLEAR!'],
  man_down: ['[whispers] man down', "[whispers] we've got a man down", "man's hit", '[shouts] MAN DOWN, MEDIC!', '[shouts] MAN DOWN, NEED A MEDIC NOW!'],
  firing: ['[whispers] engaging', '[whispers] opening up', 'engaging target', '[shouts] opening fire!', '[shouts] laying it down!'],
  sidearm: ['[whispers] going sidearm', '[whispers] pulling the pistol', 'switching sidearm', '[shouts] switching to sidearm!', '[shouts] pistol out, still in it!'],
  moving: ['[whispers] moving up', '[whispers] pushing forward', 'advancing', '[shouts] moving, moving!', '[shouts] pushing up, go go go!'],
  reloading: ['[whispers] reloading', '[whispers] swapping mags', 'changing mags', '[shouts] reloading, cover me!', '[shouts] reloading, watch my back!'],
  reviving: ['[whispers] reviving now', '[whispers] getting you up', 'picking you up', '[shouts] reviving, hang on!', '[shouts] stay with me, reviving!'],
  cover: ['[whispers] taking cover', '[whispers] getting down', 'get to cover', '[shouts] taking cover, contact!', '[shouts] cover, now!'],
  enemy_down: ['[whispers] enemy down', "[whispers] tango's down", 'target eliminated', '[shouts] enemy down, tango eliminated!', '[shouts] ENEMY DOWN, GOOD KILL!'],
  contact: ['[whispers] contact, hold', '[whispers] tango spotted', 'contact, front', '[shouts] CONTACT, CONTACT!', '[shouts] ENEMY IN SIGHT!'],
  no_ammo: ['[whispers] out of ammo', "[whispers] I'm dry", 'empty mag', "[shouts] I'm dry, out of ammo!", '[shouts] OUT OF AMMO, RELOADING!'],
  overwatch: ['[whispers] on overwatch', '[whispers] holding position', 'on overwatch', '[shouts] covering fire, go!', "[shouts] I'VE GOT OVERWATCH, MOVE!"],
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
  for (const [lineId, texts] of Object.entries(NEW_LINES)) {
    const existing = voiceDoc[lineId]?.variants ?? [];
    // Never re-bake text this voice already has, verbatim, from an earlier hand-authored
    // customization (e.g. river/grenade_out already has "[shouts] FRAG OUT!!!") -- appending it
    // again would spend a real call to produce a near-identical duplicate take.
    const existingTexts = new Set(existing.map(v => v.text));
    const startIdx = existing.length;
    const merged = [...existing];
    let nextIdx = startIdx;
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (existingTexts.has(text)) { skippedDupe++; continue; }
      merged.push({ text, intensity: BAND[i] });
      const variantIndex = nextIdx++;
      planned++;
      if (dryRun) {
        console.log(`${slug.padEnd(8)} ${lineId.padEnd(14)} #${variantIndex}  (${BAND[i]})  ${text}`);
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
