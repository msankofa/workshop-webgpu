// Make bot-viewer-visuals.js import the concrete graph and noise helpers from concrete-material.js
// instead of carrying its own copies. Run from the repo root.
const fs = require('fs');
let s = fs.readFileSync('bot-viewer-visuals.js', 'utf8');
const start = s.indexOf('const hash13 = /*@__PURE__*/');
const endMarker = 'function dirFromAngles(THREE, azimuthDeg, elevationDeg) {';
const end = s.indexOf(endMarker);
if (start < 0 || end < 0 || end < start) throw new Error('markers not found');
// Keep the section headers readable: one import line replaces the noise, the concrete albedo and
// applyConcrete definitions.
const replacement = `// Shared TSL noise and the procedural cast-concrete graph live in concrete-material.js since
// 2026-09-03, so Base Game can build the same surface without this look system.
import { hash13, noise3, fbm2, makeConcreteUniforms, concreteAlbedo, applyConcrete } from './concrete-material.js';

`;
s = s.slice(0, start) + replacement + s.slice(end);
// concreteFor is now only used by concrete-material.js; drop it from this file's style import.
s = s.replace(`  REACTIVE_TARGETS, REACTIVE_KEYS, defaultReactiveTargets, reactiveGain, advanceAudioMix,
  concreteFor,
} from './bot-viewer-visuals-style.js';`, `  REACTIVE_TARGETS, REACTIVE_KEYS, defaultReactiveTargets, reactiveGain, advanceAudioMix,
} from './bot-viewer-visuals-style.js';`);
fs.writeFileSync('bot-viewer-visuals.js', s);
console.log('visuals now import concrete-material.js; removed', end - start, 'chars of local copies');
