// Baseline and future acceptance test for Pokémon Lab part suggestions.
//
// Phase 0 deliberately scores the legacy mapper before `pokemon-suggest.js` exists. Only authored,
// non-empty fields are reference data: a blank field is unknown, not evidence that the mapper should
// have returned nothing.

import fs from 'node:fs';
import { parseGLB } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import { auditMapping } from './rig-audit.js';
import { readRig } from './pokemon-rig.js';
import { emptyAnnotation, suggestSide, validateAnnotation } from './pokemon-annotation.js';
import { suggestPokemonParts } from './pokemon-suggest.js';

const MODEL_DIR = 'models/stadium';
const LAB_FILE = 'stadium-saves/pokemon-lab.json';
const files = fs.readdirSync(MODEL_DIR).filter(f => /^\d{3}_.+\.glb$/.test(f)).sort();
const lab = JSON.parse(fs.readFileSync(LAB_FILE, 'utf8'));

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (error) { failures++; results.push(`  FAIL ${name}\n       ${error.message}`); }
}
function assert(value, message) { if (!value) throw new Error(message); }

const uniq = values => [...new Set((values || []).filter(Boolean))];
const overlap = (a, b) => {
  const B = new Set(b || []);
  return uniq(a).filter(value => B.has(value)).length;
};
const pct = value => `${(value * 100).toFixed(1)}%`;
const ratio = (n, d) => d ? n / d : null;
const f1 = (p, r) => p == null || r == null || p + r === 0 ? null : 2 * p * r / (p + r);
const show = value => value == null ? '—' : pct(value);

function loadSpecies(file) {
  const species = file.replace(/\.glb$/, '');
  const bytes = fs.readFileSync(`${MODEL_DIR}/${file}`);
  const { json, bin } = parseGLB(bytes);
  const rig = readRig(json, bin, { source: species });
  const map = mapStadiumRig(json, bin, { source: species });
  return { species, json, bin, rig, map };
}

/** Convert the legacy movement map into the annotation-shaped draft it would have supplied. */
function legacyParts(map, rig) {
  const key = node => rig.keyOf(node);
  const appendages = map.legs.map((leg, index) => {
    const chain = uniq(leg.bones.map(key));
    return {
      id: `legacy-leg-${index}`,
      type: 'leg',
      // Do not copy the legacy numeric sign. The Lab's convention is geometry-derived and already has a
      // tested helper; using it here exposes semantic disagreement instead of baking it into the scorer.
      side: suggestSide(rig, chain),
      row: leg.row,
      chain,
      mirror: null,
      author: 'suggested',
      contacts: uniq(leg.footBones.map(key)),
    };
  });
  for (const ap of appendages) {
    const mate = appendages.find(other => other !== ap && other.row === ap.row && other.side !== ap.side);
    ap.mirror = mate?.id ?? null;
  }
  return {
    root: key(map.body),
    spine: uniq(map.spine.map(key)),
    head: uniq(map.head?.bones?.map(key)),
    appendages,
    contacts: uniq(appendages.flatMap(ap => ap.contacts)),
  };
}

function emptySetScore() { return { fields: 0, proposed: 0, reference: 0, correct: 0 }; }
function addSetScore(score, proposed, reference) {
  if (!reference?.length) return;
  const P = uniq(proposed), R = uniq(reference);
  score.fields++;
  score.proposed += P.length;
  score.reference += R.length;
  score.correct += overlap(P, R);
}

function emptyBaseline() {
  return {
    comparedSpecies: new Set(),
    root: { fields: 0, correct: 0 },
    spine: emptySetScore(), head: emptySetScore(), contacts: emptySetScore(),
    limbs: {
      species: 0, proposed: 0, reference: 0,
      boneProposed: 0, boneReference: 0, boneCorrect: 0,
      matched: 0, sideCorrect: 0, rowCorrect: 0,
    },
  };
}

function scoreAuthored(baseline, annotation, proposed) {
  const reference = annotation?.parts;
  if (!reference) return;
  let compared = false;
  if (reference.root) {
    baseline.root.fields++;
    baseline.root.correct += Number(proposed.root === reference.root);
    compared = true;
  }
  for (const [name, score] of [['spine', baseline.spine], ['head', baseline.head], ['contacts', baseline.contacts]]) {
    if (reference[name]?.length) { addSetScore(score, proposed[name], reference[name]); compared = true; }
  }

  // The initial engine suggests legs only. Antennae do not prove that Butterfree has no legs, and a
  // missing appendage type is outside this baseline rather than a false positive or false negative.
  const wanted = (reference.appendages || []).filter(ap => ap.type === 'leg');
  if (wanted.length) {
    const got = proposed.appendages.filter(ap => ap.type === 'leg');
    const s = baseline.limbs;
    s.species++;
    s.proposed += got.length;
    s.reference += wanted.length;
    s.boneProposed += got.reduce((sum, ap) => sum + uniq(ap.chain).length, 0);
    s.boneReference += wanted.reduce((sum, ap) => sum + uniq(ap.chain).length, 0);

    // Greedy maximum-overlap matching. The sets are tiny (normally two or four limbs), and sorting all
    // candidate pairs makes the matching rule inspectable rather than hiding it in an assignment solver.
    const pairs = [];
    wanted.forEach((ref, ri) => got.forEach((candidate, pi) => {
      pairs.push({ ri, pi, common: overlap(ref.chain, candidate.chain) });
    }));
    pairs.sort((a, b) => b.common - a.common || a.ri - b.ri || a.pi - b.pi);
    const usedR = new Set(), usedP = new Set();
    for (const pair of pairs) {
      if (!pair.common || usedR.has(pair.ri) || usedP.has(pair.pi)) continue;
      usedR.add(pair.ri); usedP.add(pair.pi);
      const ref = wanted[pair.ri], candidate = got[pair.pi];
      s.matched++;
      s.boneCorrect += pair.common;
      s.sideCorrect += Number(ref.side === candidate.side);
      s.rowCorrect += Number(ref.row === candidate.row);
    }
    compared = true;
  }
  if (compared) baseline.comparedSpecies.add(annotation.species);
}

function validMapNodes(map, rig) {
  const nodes = [map.root, map.body, ...(map.spine || []), ...(map.head?.bones || []),
    ...(map.tail?.bones || []), ...map.legs.flatMap(leg => [leg.attach, ...leg.bones, ...leg.footBones])]
    .filter(node => node != null);
  return nodes.every(node => !!rig.keyOf(node));
}

function suggestionProblems(suggestion, rig) {
  const problems = [];
  const keys = [suggestion.parts.root, ...suggestion.parts.spine, ...suggestion.parts.head,
    ...suggestion.parts.contacts, ...suggestion.parts.appendages.flatMap(ap => ap.chain)].filter(Boolean);
  for (const key of keys) if (!rig.byKey.has(key)) problems.push(`unknown bone ${key}`);
  const claimed = new Set();
  for (const ap of suggestion.parts.appendages) {
    for (const key of ap.chain) {
      if (claimed.has(key)) problems.push(`limbs share ${key}`);
      claimed.add(key);
    }
    if (ap.mirror) {
      const mate = suggestion.parts.appendages.find(other => other.id === ap.mirror);
      if (!mate || mate.mirror !== ap.id) problems.push(`one-way mirror ${ap.id} -> ${ap.mirror}`);
    }
  }
  const draft = { ...emptyAnnotation(suggestion.source, rig), parts: structuredClone(suggestion.parts) };
  const validation = validateAnnotation(draft, rig);
  for (const finding of validation.findings.filter(f => f.level === 'error')) problems.push(finding.text);
  return problems;
}

const baseline = emptyBaseline();
const suggestedBaseline = emptyBaseline();
const loaded = new Map();
const legacyAudit = { clean: 0, errors: 0, noLegs: 0, threw: 0 };
const invariantFailures = [];
const suggestionFailures = [];

check('the model corpus still contains all 151 species', () => {
  assert(files.length === 151, `found ${files.length} Stadium models`);
});

check('the legacy mapper baseline is deterministic, total, and uses real bones', () => {
  for (const file of files) {
    const species = file.replace(/\.glb$/, '');
    try {
      const row = loadSpecies(file);
      loaded.set(species, row);
      if (!validMapNodes(row.map, row.rig)) invariantFailures.push(`${species}: map names a node outside its rig`);
      const again = mapStadiumRig(row.json, row.bin, { source: species });
      if (JSON.stringify(row.map) !== JSON.stringify(again)) invariantFailures.push(`${species}: repeated mapping changed output`);
      const audit = auditMapping(row.map, row.json);
      if (!row.map.legs.length) legacyAudit.noLegs++;
      else if (audit.findings.some(f => f.level === 'error')) legacyAudit.errors++;
      else legacyAudit.clean++;
      scoreAuthored(baseline, lab.species?.[species], legacyParts(row.map, row.rig));
      const suggestion = suggestPokemonParts(row.rig, { locomotion: lab.species?.[species]?.locomotion ?? null });
      row.suggestion = suggestion;
      const repeated = suggestPokemonParts(row.rig, { locomotion: lab.species?.[species]?.locomotion ?? null });
      if (JSON.stringify(suggestion) !== JSON.stringify(repeated)) suggestionFailures.push(`${species}: suggestion changed on repeat`);
      for (const problem of suggestionProblems(suggestion, row.rig)) suggestionFailures.push(`${species}: ${problem}`);
      scoreAuthored(suggestedBaseline, lab.species?.[species], suggestion.parts);
    } catch (error) {
      legacyAudit.threw++;
      invariantFailures.push(`${species}: ${error.message}`);
    }
  }
  assert(!invariantFailures.length, invariantFailures.slice(0, 8).join('; '));
  assert(JSON.stringify(legacyAudit) === JSON.stringify({ clean: 81, errors: 35, noLegs: 35, threw: 0 }),
    `legacy audit moved: ${JSON.stringify(legacyAudit)}`);
});

check('the pure suggestion contract is deterministic and annotation-safe across all 151 rigs', () => {
  assert(!suggestionFailures.length, suggestionFailures.slice(0, 8).join('; '));
});

check('the named difficult species pin the legacy behavior Phase 1 must improve', () => {
  const legs = species => loaded.get(species)?.map.legs || [];
  assert(legs('019_rattata').length === 4, 'Rattata is not the conventional four-leg baseline');
  assert(legs('001_bulbasaur').length === 4, 'Bulbasaur no longer maps as four legs');
  assert(legs('025_pikachu').length === 2
    && new Set(legs('025_pikachu').map(leg => leg.bones.length)).size === 2,
  'Pikachu no longer exposes asymmetric legacy chains');
  const sand = legs('028_sandslash');
  assert(sand.length === 4 && sand.some((leg, i) => sand.slice(i + 1).some(other => overlap(leg.bones, other.bones) > 0)),
    'Sandslash no longer exposes the shared-limb legacy defect');
  assert(legs('067_machoke').length === 0 && lab.species['067_machoke'].parts.appendages.length === 2,
    'Machoke no longer demonstrates missed authored legs');
  assert(legs('095_onix').length === 0, 'Onix acquired invented walking legs');
  assert(legs('100_voltorb').length === 0, 'Voltorb acquired invented walking legs');
  assert(legs('012_butterfree').length === 2, 'Butterfree no longer records the airborne/floor ambiguity');
});

check('the first pure rules fix the named structural mapper defects', () => {
  const suggestion = species => loaded.get(species).suggestion;
  const bulb = suggestion('001_bulbasaur').parts;
  assert(bulb.root === 'bone29', `Bulbasaur root was ${bulb.root}`);
  assert(JSON.stringify(bulb.head) === JSON.stringify(['bone14', 'bone13', 'bone12', 'bone11']),
    `Bulbasaur head was ${bulb.head.join(', ')}`);
  assert(bulb.appendages.length === 4, `Bulbasaur has ${bulb.appendages.length} suggested legs`);

  const machoke = suggestion('067_machoke').parts;
  assert(machoke.appendages.length === 2, `Machoke has ${machoke.appendages.length} suggested legs`);
  assert(machoke.appendages.every(ap => ap.chain.length === 3), 'Machoke leg chain did not keep three driven bones');
  assert(JSON.stringify([...machoke.contacts].sort())
    === JSON.stringify(['bone00', 'bone01', 'bone28', 'bone29']),
  `Machoke contacts were ${machoke.contacts.join(', ')}`);

  const sand = suggestion('028_sandslash').parts.appendages;
  assert(sand.length === 2, `Sandslash toe branches became ${sand.length} legs`);
  assert(!sand.some((leg, i) => sand.slice(i + 1).some(other => overlap(leg.chain, other.chain))),
    'Sandslash suggested legs overlap');
  assert(suggestion('095_onix').parts.appendages.length === 0, 'Onix acquired suggested walking legs');
  assert(suggestion('100_voltorb').parts.appendages.length === 0, 'Voltorb acquired suggested walking legs');
});

const setReport = score => {
  const precision = ratio(score.correct, score.proposed);
  const recall = ratio(score.correct, score.reference);
  return { fields: score.fields, correct: score.correct, proposed: score.proposed, reference: score.reference,
    precision, recall, f1: f1(precision, recall) };
};
const limbPrecision = ratio(baseline.limbs.boneCorrect, baseline.limbs.boneProposed);
const limbRecall = ratio(baseline.limbs.boneCorrect, baseline.limbs.boneReference);
const report = {
  comparedSpecies: baseline.comparedSpecies.size,
  root: { fields: baseline.root.fields, exact: baseline.root.correct, accuracy: ratio(baseline.root.correct, baseline.root.fields) },
  spine: setReport(baseline.spine),
  head: setReport(baseline.head),
  contacts: setReport(baseline.contacts),
  limbs: {
    species: baseline.limbs.species,
    proposed: baseline.limbs.proposed,
    reference: baseline.limbs.reference,
    matched: baseline.limbs.matched,
    boneCorrect: baseline.limbs.boneCorrect,
    boneProposed: baseline.limbs.boneProposed,
    boneReference: baseline.limbs.boneReference,
    precision: limbPrecision,
    recall: limbRecall,
    f1: f1(limbPrecision, limbRecall),
    sideAgreement: ratio(baseline.limbs.sideCorrect, baseline.limbs.matched),
    rowAgreement: ratio(baseline.limbs.rowCorrect, baseline.limbs.matched),
  },
  legacyAudit,
};

function reportFor(scored) {
  const limbPrecision = ratio(scored.limbs.boneCorrect, scored.limbs.boneProposed);
  const limbRecall = ratio(scored.limbs.boneCorrect, scored.limbs.boneReference);
  return {
    comparedSpecies: scored.comparedSpecies.size,
    root: { fields: scored.root.fields, exact: scored.root.correct,
      accuracy: ratio(scored.root.correct, scored.root.fields) },
    spine: setReport(scored.spine), head: setReport(scored.head), contacts: setReport(scored.contacts),
    limbs: {
      ...scored.limbs,
      precision: limbPrecision, recall: limbRecall, f1: f1(limbPrecision, limbRecall),
      sideAgreement: ratio(scored.limbs.sideCorrect, scored.limbs.matched),
      rowAgreement: ratio(scored.limbs.rowCorrect, scored.limbs.matched),
    },
  };
}
const suggestedReport = reportFor(suggestedBaseline);

console.log('pokemon annotation suggestion baseline');
for (const result of results) console.log(result);
console.log(`\n  comparable authored species  ${report.comparedSpecies}`);
console.log(`  root exact                   ${report.root.exact}/${report.root.fields} (${show(report.root.accuracy)})`);
for (const name of ['spine', 'head', 'contacts']) {
  const s = report[name];
  console.log(`  ${name.padEnd(28)}${s.correct}/${s.proposed} proposed, ${s.correct}/${s.reference} recovered, F1 ${show(s.f1)}`);
}
console.log(`  limb bones                   ${report.limbs.boneCorrect}/${report.limbs.boneProposed} proposed, `
  + `${report.limbs.boneCorrect}/${report.limbs.boneReference} recovered, F1 ${show(report.limbs.f1)}`);
console.log(`  limb side / row              ${show(report.limbs.sideAgreement)} / ${show(report.limbs.rowAgreement)}`);
console.log(`  legacy dex audit             ${legacyAudit.clean} clean, ${legacyAudit.errors} errors, `
  + `${legacyAudit.noLegs} no legs, ${legacyAudit.threw} threw`);
console.log('\nfirst pure suggestion pass');
console.log(`  root exact                   ${suggestedReport.root.exact}/${suggestedReport.root.fields} (${show(suggestedReport.root.accuracy)})`);
for (const name of ['spine', 'head', 'contacts']) {
  const s = suggestedReport[name];
  console.log(`  ${name.padEnd(28)}${s.correct}/${s.proposed} proposed, ${s.correct}/${s.reference} recovered, F1 ${show(s.f1)}`);
}
console.log(`  limb bones                   ${suggestedReport.limbs.boneCorrect}/${suggestedReport.limbs.boneProposed} proposed, `
  + `${suggestedReport.limbs.boneCorrect}/${suggestedReport.limbs.boneReference} recovered, F1 ${show(suggestedReport.limbs.f1)}`);
console.log(`  limb side / row              ${show(suggestedReport.limbs.sideAgreement)} / ${show(suggestedReport.limbs.rowAgreement)}`);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exitCode = 1; }
else console.log('\nall checks passed');
