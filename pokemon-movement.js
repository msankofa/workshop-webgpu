// Class-aware movement entry point. The Lab uses this name; individual controllers keep narrower names.

import { createStadiumWalker } from './stadium-walker.js';

export const MOVEMENT_LABELS = Object.freeze({
  walker: 'Walking',
  flyer: 'Flying',
  swimmer: 'Swimming',
  hopper: 'Hopping',
  serpent: 'Slithering',
  worm: 'Crawling',
  roller: 'Rolling',
  floater: 'Floating',
  burrower: 'Burrowing',
  static: 'Stationary',
});

export function movementLabel(locomotion) {
  return MOVEMENT_LABELS[locomotion] ?? 'Unclassified';
}

export function createPokemonMovement({ locomotion, scene, map, ...options } = {}) {
  const label = movementLabel(locomotion);
  if (!Object.hasOwn(MOVEMENT_LABELS, locomotion)) {
    return {
      supported: false, label, controller: null,
      findings: [{ severity: 'error', code: 'missing-movement-class', message: 'Choose how this species moves.' }],
    };
  }
  if (locomotion !== 'walker') {
    return {
      supported: false, label, controller: null,
      findings: [{
        severity: 'info', code: 'movement-not-implemented',
        message: `${label} preview is not implemented yet.`,
      }],
    };
  }
  if (!map) {
    return {
      supported: false, label, controller: null,
      findings: [{ severity: 'error', code: 'missing-ground-map', message: 'The Lab annotation is not ready for ground movement.' }],
    };
  }
  try {
    return {
      supported: true,
      label,
      controller: createStadiumWalker({ scene, map, ...options }),
      findings: [],
    };
  } catch (error) {
    return {
      supported: false, label, controller: null,
      findings: [{ severity: 'error', code: 'movement-controller-failed', message: error.message }],
    };
  }
}
