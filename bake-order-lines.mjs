// One-pass bulk bake for the three player-command lines added 2026-08-07 (order_ack,
// order_ack_squad, order_follow): appends the wording drafted in chat to every combat voice's
// lexicon, bakes each as real ElevenLabs audio, and updates the manifest -- same pattern as
// bake-reaction-lines.mjs (validated single-pass design: write lexicon + bake audio in one loop per
// (voice, line, variant), one writeManifest() call at the end, no browser/relay involvement).
//
//   node bake-order-lines.mjs           run for real (real, paid ElevenLabs calls)
//   node bake-order-lines.mjs --dry-run  print the plan, bake nothing, spend nothing
//
// Like the six reaction lines, these three lineIds are brand new -- no voice has ever customized
// them, so no dedup skips are expected; every planned line should actually bake.
import { readFile, writeFile } from 'node:fs/promises';
import { SOUND_PARAMS, applyParamOverrides, setMapOverride, exportParams } from './sound-params.js';
import { elevenKey, elevenCatalog, bakeOneEleven, writeManifest } from './bake-voices.mjs';

const VOICES = ['harry', 'adam', 'daniel', 'river', 'callum', 'bill', 'brian', 'charlie', 'sarah', 'alice'];

const A = SOUND_PARAMS.voiceIntensity;
// Three named bands, not five slots: low -> calm, mid -> wary, high -> push. These lines have no
// real urgency dimension of their own (an acknowledgment is an acknowledgment) -- the bands exist
// so a bot commanded mid-firefight reads as clipped/shouted rather than replying in the same calm
// tone it would use on a quiet patrol, same mapping bake-reaction-lines.mjs uses.
const BAND = { low: A.anchorCalm, mid: A.anchorWary, high: A.anchorPush };

// { text, band } per line, drafted and reviewed in the 2026-08-07 chat session.
const NEW_LINES = {
  // Solo bot (or a non-leader squad member) confirming a direct move order.
  order_ack: [
    { text: 'affirmative', band: 'low' },
    { text: 'got it', band: 'low' },
    { text: 'right', band: 'low' },
    { text: 'on the move', band: 'mid' },
    { text: 'on my way', band: 'mid' },
    { text: 'moving out', band: 'high' },
    { text: 'oscar mike', band: 'high' },
    { text: 'going', band: 'high' },
  ],
  // Squad LEADER confirming for the whole squad -- plural framing, plus a couple of the same
  // plurality-neutral phrases order_ack already uses (they read fine either way).
  order_ack_squad: [
    { text: "we're on the move", band: 'low' },
    { text: 'on the move', band: 'low' },
    { text: "we're moving out", band: 'mid' },
    { text: "squad's oscar mike", band: 'mid' },
    { text: '[shouts] WE\'RE OSCAR MIKE, MOVE!', band: 'high' },
    { text: "[shouts] SQUAD'S MOVING, GO!", band: 'high' },
  ],
  // A squadmate's brief call-and-response reply to the leader's order_ack_squad.
  order_follow: [
    { text: 'roger', band: 'low' },
    { text: 'yes ma\'am', band: 'mid' },
    { text: '[shouts] HOOAH!', band: 'high' },
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
        console.log(`${slug.padEnd(8)} ${lineId.padEnd(16)} #${variantIndex}  (${band})  ${text}`);
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
