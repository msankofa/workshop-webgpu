// Pure checks for sparse walker authoring and its annotation migration.

import assert from 'node:assert/strict';
import {
  WALKER_TUNING_FIELDS, effectiveWalkerTuning, normaliseWalkerMovement, normaliseWalkerTuning,
} from './pokemon-movement-settings.js';
import {
  ANNOTATION_VERSION, annotationStamp, copyAnnotation, emptyAnnotation, isBlank, setWalkerMovement,
} from './pokemon-annotation.js';
import { migrateLibrary } from './pokemon-lab-io.js';

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };

const defaults = normaliseWalkerTuning({
  speedScale: 1,
  strideScale: 1,
  standExtension: 0.9,
  footContact: 'point',
});
check(Object.keys(defaults).length === 0, 'static defaults must not be persisted as overrides');

const cleaned = normaliseWalkerTuning({
  speedScale: 99,
  stepDurationScale: 0,
  strayRetries: 2.6,
  strayMode: 'nonsense',
  unknown: 4,
});
check(cleaned.speedScale === WALKER_TUNING_FIELDS.speedScale.max, 'speed was not clamped');
check(cleaned.stepDurationScale === WALKER_TUNING_FIELDS.stepDurationScale.min,
  'step duration was allowed to reach zero');
check(cleaned.strayRetries === 3, 'integer tuning was not rounded');
check(!Object.hasOwn(cleaned, 'strayMode') && !Object.hasOwn(cleaned, 'unknown'),
  'unknown values survived normalisation');

const reach = normaliseWalkerTuning({
  standExtension: 0.95,
  maxExtension: 0.8,
  reachMargin: 0.95,
  reachStress: 0.7,
});
check(reach.standExtension < reach.maxExtension, 'standing extension was not kept below maximum');
check(reach.reachMargin < reach.reachStress, 'reach margin was not kept below reach stress');

check(normaliseWalkerMovement({ gait: 'walk', tuning: {} }).gait === null,
  'the default gait should stay sparse');
check(normaliseWalkerMovement({ gait: 'gallop', tuning: {} }).gait === 'gallop',
  'a non-default gait was discarded');

const effective = effectiveWalkerTuning(
  { speedScale: 1.25, uprightSupport: 0.25 },
  { speedScale: 1, uprightSupport: 1 },
);
check(effective.speedScale === 1.25 && effective.uprightSupport === 0.25,
  'effective tuning did not put overrides over derived values');

const empty = emptyAnnotation('025_pikachu');
const moved = setWalkerMovement(empty, { gait: 'gallop', tuning: { speedScale: 1.25 } });
check(!isBlank(moved), 'movement settings did not make an annotation persistable');
check(annotationStamp(moved) !== annotationStamp(empty), 'movement settings did not change the annotation stamp');
const copied = copyAnnotation(moved);
copied.movement.walker.tuning.speedScale = 1.5;
check(moved.movement.walker.tuning.speedScale === 1.25, 'movement tuning was shared with its copy');

const legacy = migrateLibrary({
  version: 1,
  species: { '019_rattata': { species: '019_rattata', locomotion: 'walker' } },
}).library;
check(legacy.version === ANNOTATION_VERSION, 'the library version was not upgraded');
check(legacy.species['019_rattata'].movement.walker.gait === null
  && Object.keys(legacy.species['019_rattata'].movement.walker.tuning).length === 0,
  'a legacy annotation did not receive an empty walker record');

const roundTrip = migrateLibrary({
  version: ANNOTATION_VERSION,
  species: { '025_pikachu': moved },
}).library.species['025_pikachu'];
check(roundTrip.movement.walker.gait === 'gallop'
  && roundTrip.movement.walker.tuning.speedScale === 1.25,
  'saved walker settings did not survive migration');

console.log('pokemon movement settings: ' + checks + ' checks passed');
