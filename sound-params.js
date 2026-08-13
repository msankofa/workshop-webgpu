// sound-params.js -- every authored number the procedural audio depends on, in one editable place.
//
// This module imports NOTHING. It is pulled in by the synth modules, by both viewers, by
// sound-studio.html and by Node tests, so a dependency here would become a cycle or a file read
// somewhere that cannot do file reads.
//
// Shape:
//   SOUND_PARAM_SCHEMA  the authored definition -- default, range, label, unit for every scalar
//   SOUND_PARAMS        the LIVE values, mutated in place by applyParamOverrides()
//   sound-params.json   an override document written by the studio and fetched at boot by viewers
//
// Modules must read SOUND_PARAMS at *build* time, never destructure it at module scope -- an
// override applied after import has to reach code that already loaded. Mutating in place (rather
// than replacing section objects) is what keeps a held reference valid.
//
// Node tests import this and get the defaults with zero I/O. test-sound-params.mjs reads the JSON
// with fs and asserts every key is known and in range, so the two cannot drift silently.

// A scalar entry is {default, min, max, step, label}; `unit` and `note` are for the studio only.
// An array entry adds `itemLabels`, and its default's length fixes its arity.
export const SOUND_PARAM_SCHEMA = Object.freeze({

  voice: {
    label: 'Bot voice',
    note: 'Formant bank, glottal carrier and radio channel for the squad callouts.',
    params: {
      formantQ: {
        default: [5, 6, 7], min: 0.5, max: 20, step: 0.1, label: 'Formant Q',
        itemLabels: ['F1', 'F2', 'F3'],
        note: 'Higher Q is more vowel character and less level. Q=[9,11,12] measured -15.8 dB and was inaudible over gunfire.',
      },
      formantGain: {
        default: [1.0, 0.62, 0.3], min: 0, max: 2, step: 0.01, label: 'Formant gain',
        itemLabels: ['F1', 'F2', 'F3'], note: 'Spectral tilt of a voiced vowel.',
      },
      makeup: {
        default: 2.5, min: 0.25, max: 8, step: 0.05, label: 'Makeup gain',
        note: 'Recovers the filter bank insertion loss. Measured: at makeup 1 a line peaks near -9 dBFS, which is why the callouts were inaudible.',
      },
      sampleMakeup: {
        default: 1.0, min: 0.1, max: 6, step: 0.05, label: 'Baked-take makeup',
        note: 'Separate from `makeup` because TTS output is already normalised and the synth is '
            + 'not. Measured: an ElevenLabs take arrives at -23 dBFS RMS / -5 dB peak where the '
            + 'synth lands near -38, so reusing `makeup` drove every peak into the limiter.',
      },
      outputDrive: {
        default: 1.6, min: 0.1, max: 8, step: 0.05, label: 'Output soft clip',
        note: 'tanh limiter AFTER the makeup gain. Without it the makeup pushes peaks to 0 dBFS '
            + 'against an RMS of -30, so the loudest lines clip alone. 0.1 is effectively bypass.',
      },
      attackFraction: { default: 0.28, min: 0.02, max: 0.9, step: 0.01, label: 'Syllable attack', unit: 'of syllable' },
      attackMaxS: { default: 0.035, min: 0.002, max: 0.2, step: 0.001, label: 'Attack ceiling', unit: 's' },
      // Both floors are above zero on purpose: a zero-length burst would schedule its decay before
      // its attack, which is a thrown RangeError in real WebAudio rather than a quiet sound.
      squelchMs: { default: 45, min: 6, max: 200, step: 1, label: 'Squelch click', unit: 'ms' },
      radioTailMs: { default: 110, min: 10, max: 600, step: 5, label: 'Radio tail', unit: 'ms' },
      f0Min: { default: 90, min: 40, max: 300, step: 1, label: 'Fundamental floor', unit: 'Hz' },
      f0Span: { default: 70, min: 0, max: 300, step: 1, label: 'Fundamental spread', unit: 'Hz' },
      teamF0Spread: { default: 0.14, min: 0, max: 0.6, step: 0.01, label: 'Per-team pitch tilt' },
      teamFormantSpread: { default: 0.09, min: 0, max: 0.6, step: 0.01, label: 'Per-team tract tilt' },
      formantScaleMin: { default: 0.94, min: 0.5, max: 1.5, step: 0.01, label: 'Tract scale floor' },
      formantScaleSpan: { default: 0.12, min: 0, max: 1, step: 0.01, label: 'Tract scale spread' },
      rateMin: { default: 0.92, min: 0.4, max: 2, step: 0.01, label: 'Speaking rate floor' },
      rateSpan: { default: 0.16, min: 0, max: 1.5, step: 0.01, label: 'Speaking rate spread' },
      buzzMin: { default: 0.35, min: 0, max: 1, step: 0.01, label: 'Square mix floor', note: 'How mechanical the timbre is.' },
      buzzSpan: { default: 0.35, min: 0, max: 1, step: 0.01, label: 'Square mix spread' },
      clampHzMin: { default: 150, min: 20, max: 1000, step: 5, label: 'Formant clamp low', unit: 'Hz' },
      clampHzMax: { default: 4000, min: 1000, max: 16000, step: 50, label: 'Formant clamp high', unit: 'Hz' },
      radioHighpassHz: { default: 300, min: 20, max: 2000, step: 10, label: 'Radio highpass', unit: 'Hz' },
      radioLowpassHz: { default: 3000, min: 500, max: 16000, step: 50, label: 'Radio lowpass', unit: 'Hz' },
      radioTightHz: { default: 1450, min: 200, max: 6000, step: 10, label: 'Radio resonance', unit: 'Hz' },
      radioTightQ: { default: 2.2, min: 0.1, max: 12, step: 0.1, label: 'Radio resonance Q' },
      radioOutGain: { default: 0.9, min: 0, max: 2, step: 0.01, label: 'Radio output' },
      squelchInPeak: { default: 0.28, min: 0, max: 1, step: 0.01, label: 'Key-down click' },
      squelchOutPeak: { default: 0.22, min: 0, max: 1, step: 0.01, label: 'Key-up click' },
      tailPeak: { default: 0.09, min: 0, max: 1, step: 0.01, label: 'Hiss tail level' },
      tailBandHz: { default: 2200, min: 200, max: 8000, step: 50, label: 'Hiss tail band', unit: 'Hz' },
    },
  },

  siren: {
    label: 'Death beacon',
    note: 'A downed bot reporting a fault. Deliberately not a wail: discrete beeps, stepped pitch, '
        + 'real silence between them. A continuous glide plus detune is literally air-raid synthesis.',
    params: {
      baseHz: { default: 1150, min: 200, max: 4000, step: 10, label: 'Base pitch', unit: 'Hz' },
      seedSpread: { default: 0.12, min: 0, max: 1, step: 0.01, label: 'Per-bot pitch spread' },
      beepS: { default: 0.085, min: 0.01, max: 1, step: 0.005, label: 'Beep length', unit: 's' },
      gapS: { default: 0.075, min: 0, max: 1, step: 0.005, label: 'Gap within pair', unit: 's' },
      restBaseS: { default: 0.45, min: 0, max: 4, step: 0.05, label: 'Rest between chirps', unit: 's' },
      restGrowthS: { default: 0.85, min: 0, max: 6, step: 0.05, label: 'Rest growth by end', unit: 's' },
      steps: { default: 4, min: 1, max: 12, step: 1, label: 'Power-down stages' },
      stepRatio: { default: 0.84, min: 0.3, max: 1, step: 0.01, label: 'Pitch drop per stage' },
      pairRatio: { default: 0.75, min: 0.3, max: 1.5, step: 0.01, label: 'Second beep ratio' },
      onLevel: { default: 0.5, min: 0, max: 1, step: 0.01, label: 'Beep level' },
      levelDecay: { default: 0.55, min: 0, max: 1, step: 0.01, label: 'Level lost by end' },
      lowpassHz: { default: 3200, min: 500, max: 16000, step: 50, label: 'Tone lowpass', unit: 'Hz' },
      outPeak: { default: 0.9, min: 0, max: 1, step: 0.01, label: 'Output peak' },
      edgeS: { default: 0.003, min: 0.0005, max: 0.05, step: 0.0005, label: 'Gate edge', unit: 's', note: '0 ms clicks; ~3 ms reads as a clean digital edge.' },
    },
  },

  vocoder: {
    label: 'Robot vocoder',
    note: 'Turns a baked human take into a machine voice by gating a glottal carrier with the '
        + 'take\'s own spectral envelope. Real speech timing survives, which is what pure formant '
        + 'synthesis cannot fake -- and the carrier is where per-bot identity lives, so a machine '
        + 'bot and a human bot can share one file.',
    params: {
      bands: { default: 14, min: 4, max: 32, step: 1, label: 'Band count', note: 'Under about 8 the vowels blur together; over 20 costs nodes for detail the radio band then throws away.' },
      loHz: { default: 180, min: 60, max: 1000, step: 10, label: 'Lowest band', unit: 'Hz' },
      hiHz: { default: 5200, min: 2000, max: 16000, step: 100, label: 'Highest band', unit: 'Hz' },
      bandQ: { default: 4, min: 0.5, max: 20, step: 0.1, label: 'Band Q' },
      followHz: { default: 18, min: 2, max: 80, step: 1, label: 'Envelope follower', unit: 'Hz', note: 'Too high and the carrier pitch leaks into the envelope as buzz; too low and consonants smear.' },
      followGain: { default: 11, min: 1, max: 60, step: 0.5, label: 'Follower makeup', note: 'A rectified band averages far below its peak, so without makeup the VCAs barely open.' },
      carrierGain: { default: 0.9, min: 0, max: 4, step: 0.05, label: 'Carrier level' },
      sibilanceLevel: { default: 0.14, min: 0, max: 1, step: 0.01, label: 'Sibilance noise', note: 'A purely tonal carrier cannot render an "s" at all. This is the noise that gives it one.' },
      sibilanceHz: { default: 2400, min: 500, max: 9000, step: 50, label: 'Sibilance highpass', unit: 'Hz' },
      outGain: { default: 2.2, min: 0, max: 8, step: 0.05, label: 'Output makeup', note: 'The band split discards ~3 dB the way the formant bank does. 2.2 brings a vocoded take back level with the same take played dry.' },
    },
  },

  damageLoop: {
    label: 'Damage bed',
    note: 'Sustained arcing short over a failing servo, for the few closest badly-hurt bots.',
    params: {
      outBase: { default: 0.55, min: 0, max: 1, step: 0.01, label: 'Base level' },
      outSev: { default: 0.35, min: 0, max: 1, step: 0.01, label: 'Severity level' },
      bandHz: { default: 1500, min: 100, max: 8000, step: 25, label: 'Arc band', unit: 'Hz' },
      bandSpan: { default: 900, min: 0, max: 4000, step: 25, label: 'Arc band spread', unit: 'Hz' },
      bandQ: { default: 5.5, min: 0.1, max: 20, step: 0.1, label: 'Arc band Q' },
      buzzHz: { default: 64, min: 20, max: 400, step: 1, label: 'Servo buzz', unit: 'Hz' },
      buzzSpan: { default: 22, min: 0, max: 200, step: 1, label: 'Servo buzz spread', unit: 'Hz' },
      buzzLevel: { default: 0.16, min: 0, max: 1, step: 0.01, label: 'Buzz base level' },
      buzzSevLevel: { default: 0.2, min: 0, max: 1, step: 0.01, label: 'Buzz severity level' },
      buzzLowpassHz: { default: 260, min: 50, max: 2000, step: 10, label: 'Buzz lowpass', unit: 'Hz' },
      flickerStepS: { default: 0.14, min: 0.01, max: 1, step: 0.01, label: 'Flicker step', unit: 's' },
      flickerStepSpan: { default: 0.05, min: 0, max: 1, step: 0.01, label: 'Flicker step spread', unit: 's' },
      flickerOpenBase: { default: 0.55, min: 0, max: 1, step: 0.01, label: 'Flicker gate threshold' },
      flickerOpenSev: { default: 0.3, min: 0, max: 1, step: 0.01, label: 'Threshold drop by severity' },
      sustainTailS: { default: 0.06, min: 0.005, max: 1, step: 0.005, label: 'Stop fade', unit: 's' },
    },
  },

  damage: {
    label: 'Damage tiers',
    note: 'Which hit voice a given amount of damage earns, and how many sustained voices may run.',
    params: {
      ricochetMax01: { default: 0.10, min: 0, max: 1, step: 0.01, label: 'Ricochet ceiling', unit: 'of max HP' },
      criticalAmount01: { default: 0.50, min: 0, max: 1, step: 0.01, label: 'Critical amount', unit: 'of max HP' },
      criticalHpScale: { default: 0.5, min: 0, max: 1, step: 0.01, label: 'Critical HP band' },
      sparkFastMs: { default: 900, min: 100, max: 10000, step: 50, label: 'Spark cadence at 0 HP', unit: 'ms' },
      sparkSlowMs: { default: 3600, min: 100, max: 20000, step: 50, label: 'Spark cadence at threshold', unit: 'ms' },
      sparkJitter: { default: 0.35, min: 0, max: 1, step: 0.01, label: 'Spark cadence jitter' },
      loopHpScale: { default: 0.5, min: 0, max: 1, step: 0.01, label: 'Bed HP band' },
      maxDamageLoops: { default: 2, min: 0, max: 8, step: 1, label: 'Concurrent beds' },
      maxSirens: { default: 3, min: 0, max: 8, step: 1, label: 'Concurrent sirens', note: 'Keep below budget.loopCap so mass death cannot fill the ceiling.' },
      scanIntervalMs: { default: 250, min: 30, max: 2000, step: 10, label: 'Controller poll', unit: 'ms' },
      sirenBaseVolume: { default: 0.75, min: 0, max: 1, step: 0.01, label: 'Siren volume' },
      loopBaseVolume: { default: 0.5, min: 0, max: 1, step: 0.01, label: 'Bed volume' },
    },
  },

  ballistic: {
    label: 'Incoming rounds',
    note: 'Whizz geometry and ricochet probability. A whizz is only built for a round that passes close.',
    params: {
      whizzMaxDist: { default: 6, min: 0.5, max: 40, step: 0.5, label: 'Whizz radius', unit: 'm' },
      whizzMaxDelayS: { default: 0.6, min: 0, max: 3, step: 0.05, label: 'Whizz delay ceiling', unit: 's' },
      bulletSpeed: { default: 750, min: 100, max: 1500, step: 10, label: 'Default bullet speed', unit: 'm/s' },
      projectileWhizzRadius: { default: 7, min: 0.5, max: 40, step: 0.5, label: 'Projectile whizz radius', unit: 'm' },
      ricochetGrazeExp: { default: 3, min: 0.5, max: 8, step: 0.1, label: 'Graze exponent', note: 'A near-perpendicular hit essentially never ricochets.' },
      // Keys match ballistic-audio.js surfaceClass(): hardness is inferred from hit.kind plus the
      // obstacle id prefix, because no material tag exists anywhere in the codebase.
      ricochetWorld: { default: 0.55, min: 0, max: 1, step: 0.01, label: 'Ricochet: world', note: 'Map BVH -- concrete and metal shoot-house geometry.' },
      ricochetRock: { default: 0.50, min: 0, max: 1, step: 0.01, label: 'Ricochet: rock' },
      ricochetObstacle: { default: 0.22, min: 0, max: 1, step: 0.01, label: 'Ricochet: obstacle', note: 'Unprefixed column, hardness unknown.' },
      ricochetWood: { default: 0.08, min: 0, max: 1, step: 0.01, label: 'Ricochet: wood' },
      ricochetTerrain: { default: 0.05, min: 0, max: 1, step: 0.01, label: 'Ricochet: terrain', note: 'Dirt absorbs.' },
    },
  },

  director: {
    label: 'Voice director',
    note: 'Decides WHICH bot speaks and whether it may. Every rejection carries a reason the studio can plot.',
    params: {
      speakerCap: { default: 3, min: 0, max: 12, step: 1, label: 'Concurrent speakers' },
      botCooldownMs: { default: 4000, min: 0, max: 30000, step: 100, label: 'Per-bot cooldown', unit: 'ms' },
      dedupMs: { default: 2500, min: 0, max: 30000, step: 100, label: 'Event dedup window', unit: 'ms' },
      // Matches ranges.voiceMax. Both viewers pin this from their voice panner profile anyway, so
      // the old 45 was a default nothing read -- and it made the studio's simulation drop lines
      // the shipping game plays.
      maxDistance: { default: 95, min: 5, max: 300, step: 1, label: 'Director cutoff', unit: 'm', note: 'A line beyond this is dropped before any node graph is built.' },
      globalRateWindowMs: { default: 2000, min: 100, max: 20000, step: 100, label: 'Global rate window', unit: 'ms' },
      globalRateMax: { default: 6, min: 0, max: 40, step: 1, label: 'Global lines per window' },
      squadRateWindowMs: { default: 2500, min: 100, max: 20000, step: 100, label: 'Squad rate window', unit: 'ms' },
      squadRateMax: { default: 2, min: 0, max: 20, step: 1, label: 'Squad lines per window' },
      chattiness: { default: 1, min: 0, max: 2, step: 0.05, label: 'Chattiness', note: '0 silences everything; ambient lines drop out first.' },
      ambientMinChattiness: { default: 0.35, min: 0, max: 2, step: 0.05, label: 'Ambient cutoff' },
      alertRank: { default: 70, min: 0, max: 100, step: 1, label: 'Alert rank', note: 'Lines at or above this compete as alerts and can displace barks.' },
    },
  },

  budget: {
    label: 'Voice budget',
    note: 'Shared across every track. One instance serves ballistics, voices and damage, so a '
        + 'firefight cannot starve a death siren.',
    params: {
      globalCap: { default: 32, min: 1, max: 128, step: 1, label: 'Global voices' },
      ballisticCap: { default: 20, min: 0, max: 128, step: 1, label: 'Ballistic voices' },
      // No voiceCap here on purpose. The voice category's ceiling is director.speakerCap -- there
      // used to be a second number, and the director overwrote it at construction, so tuning the
      // budget's copy did nothing at all.
      damageCap: { default: 10, min: 0, max: 64, step: 1, label: 'Damage voices' },
      loopCap: { default: 8, min: 1, max: 32, step: 1, label: 'Sustained voices' },
    },
  },

  voiceIntensity: {
    label: 'Voice intensity',
    note: 'Maps a bot\'s alert tier to a 0..1 delivery-intensity target, used to pick which line '
        + 'variant (calm vs. urgent wording/tone) best fits the moment. Anchors are evenly spaced '
        + 'by default -- a starting point to retune once variants are baked and actually heard, not '
        + 'a measured curve. The alert-line floor (grenade_warn, man_down, contact, ...) is the '
        + 'defensive anchor itself, not a separately-chosen number, so a genuinely urgent line can '
        + 'never resolve to a calm-tagged variant.',
    params: {
      anchorCalm: { default: 0.0, min: 0, max: 1, step: 0.01, label: 'Calm / no report' },
      anchorWary: { default: 0.33, min: 0, max: 1, step: 0.01, label: 'Wary' },
      anchorDefensive: { default: 0.67, min: 0, max: 1, step: 0.01, label: 'Defensive (also the alert-line floor)' },
      anchorPush: { default: 1.0, min: 0, max: 1, step: 0.01, label: 'Push' },
      tieEpsilon: { default: 0.05, min: 0, max: 0.5, step: 0.01, label: 'Variant tie tolerance', note: 'Variants within this distance of the closest match are treated as equally good and rotated between.' },
    },
  },

  ranges: {
    label: 'Positional ranges',
    note: 'The one table both viewers read. Voices at 55 m while gunfire carried 90 m is exactly '
        + 'why the callouts were inaudible -- seeing these side by side is the point.',
    params: {
      gunshotRef: { default: 8, min: 0.5, max: 100, step: 0.5, label: 'Gunshot ref', unit: 'm' },
      gunshotMax: { default: 90, min: 1, max: 400, step: 1, label: 'Gunshot max', unit: 'm' },
      gunshotRolloff: { default: 0.9, min: 0.1, max: 4, step: 0.05, label: 'Gunshot rolloff' },
      launchRef: { default: 9, min: 0.5, max: 100, step: 0.5, label: 'Launch ref', unit: 'm' },
      launchMax: { default: 90, min: 1, max: 400, step: 1, label: 'Launch max', unit: 'm' },
      launchRolloff: { default: 0.85, min: 0.1, max: 4, step: 0.05, label: 'Launch rolloff' },
      explosionRef: { default: 12, min: 0.5, max: 100, step: 0.5, label: 'Explosion ref', unit: 'm' },
      explosionMax: { default: 130, min: 1, max: 400, step: 1, label: 'Explosion max', unit: 'm' },
      explosionRolloff: { default: 0.7, min: 0.1, max: 4, step: 0.05, label: 'Explosion rolloff' },
      stepRef: { default: 2.5, min: 0.5, max: 100, step: 0.5, label: 'Footstep ref', unit: 'm' },
      stepMax: { default: 26, min: 1, max: 400, step: 1, label: 'Footstep max', unit: 'm' },
      stepRolloff: { default: 1.5, min: 0.1, max: 4, step: 0.05, label: 'Footstep rolloff' },
      whizzRef: { default: 2, min: 0.5, max: 100, step: 0.5, label: 'Whizz ref', unit: 'm' },
      whizzMax: { default: 24, min: 1, max: 400, step: 1, label: 'Whizz max', unit: 'm' },
      whizzRolloff: { default: 1.6, min: 0.1, max: 4, step: 0.05, label: 'Whizz rolloff' },
      distressRef: { default: 14, min: 0.5, max: 100, step: 0.5, label: 'Distress ref', unit: 'm' },
      distressMax: { default: 120, min: 1, max: 400, step: 1, label: 'Distress max', unit: 'm' },
      distressRolloff: { default: 0.6, min: 0.1, max: 4, step: 0.05, label: 'Distress rolloff' },
      voiceRef: { default: 14, min: 0.5, max: 100, step: 0.5, label: 'Voice ref', unit: 'm' },
      voiceMax: { default: 95, min: 1, max: 400, step: 1, label: 'Voice max', unit: 'm' },
      voiceRolloff: { default: 0.6, min: 0.1, max: 4, step: 0.05, label: 'Voice rolloff' },
      voiceOutdoorRef: { default: 14, min: 0.5, max: 100, step: 0.5, label: 'Voice ref (outdoor)', unit: 'm' },
      voiceOutdoorMax: { default: 110, min: 1, max: 400, step: 1, label: 'Voice max (outdoor)', unit: 'm' },
      voiceOutdoorRolloff: { default: 0.8, min: 0.1, max: 4, step: 0.05, label: 'Voice rolloff (outdoor)' },
      distressOutdoorRef: { default: 26, min: 0.5, max: 100, step: 0.5, label: 'Distress ref (outdoor)', unit: 'm' },
      distressOutdoorMax: { default: 200, min: 1, max: 400, step: 1, label: 'Distress max (outdoor)', unit: 'm' },
      distressOutdoorRolloff: { default: 0.45, min: 0.1, max: 4, step: 0.05, label: 'Distress rolloff (outdoor)' },
    },
  },
});

// Sections the studio edits as keyed maps rather than as fixed scalars. They start EMPTY: an entry
// present here overrides the owning module's default for that key, and an absent one leaves the
// module's own table alone. That keeps each module the authority on its own defaults, so nothing
// here can silently become a stale second copy of the lexicon.
export const OVERRIDE_MAP_SECTIONS = Object.freeze({
  voiceLines: { label: 'Voice lexicon', note: 'Per-line syllables, contour and drive. Owned by bot-voice.js.' },
  linePriority: { label: 'Line priority', note: 'Higher speaks first. Owned by bot-voice-director.js.' },
  lineCooldownMs: { label: 'Line cooldown', note: 'Per line, scoped per team. Owned by bot-voice-director.js.' },
  // Per-ElevenLabs-voice text variants: { voiceId: { lineId: { variants: [{text, intensity}] } } },
  // voiceId is the manifest `set` string (e.g. "eleven/harry"). A voice with nothing authored for a
  // line falls back to the shared voiceLines lexicon -- see bot-voice.js's voiceLexiconVariants().
  // Deliberately a SEPARATE section from voiceLines, not a reshape of it: voiceLines already backs
  // the "add a line" feature and the knownLine() gate, and forcing it into a per-voice shape would
  // have broken both for no benefit -- Kokoro and the synth were never going to be per-voice anyway.
  voiceLexicon: { label: 'Per-voice lines', note: 'ElevenLabs-only text variants. Owned by bot-voice.js.' },
});

export const SECTION_IDS = Object.freeze(Object.keys(SOUND_PARAM_SCHEMA));
export const MAP_SECTION_IDS = Object.freeze(Object.keys(OVERRIDE_MAP_SECTIONS));

function cloneDefault(spec) {
  return Array.isArray(spec.default) ? spec.default.slice() : spec.default;
}

function buildDefaults() {
  const out = {};
  for (const [sectionId, section] of Object.entries(SOUND_PARAM_SCHEMA)) {
    const values = {};
    for (const [key, spec] of Object.entries(section.params)) values[key] = cloneDefault(spec);
    out[sectionId] = values;
  }
  for (const id of MAP_SECTION_IDS) out[id] = {};
  return out;
}

// The live values. Mutated in place -- never reassign a section, or a module that grabbed a
// reference at import time would keep reading the old one.
export const SOUND_PARAMS = buildDefaults();

export function paramSpec(sectionId, key) {
  return SOUND_PARAM_SCHEMA[sectionId]?.params?.[key] ?? null;
}

function clampToSpec(spec, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  let v = Math.min(spec.max, Math.max(spec.min, n));
  if (spec.step >= 1 && Number.isInteger(spec.step)) v = Math.round(v);
  return v;
}

// Coerce one incoming value against its spec. Returns {value, note} where `note` is set whenever
// the input had to be changed, so the caller can surface it rather than silently accepting junk.
export function coerceParam(sectionId, key, raw) {
  const spec = paramSpec(sectionId, key);
  if (!spec) return { value: null, note: `unknown param ${sectionId}.${key}` };
  if (Array.isArray(spec.default)) {
    if (!Array.isArray(raw)) return { value: null, note: `${sectionId}.${key} expects an array of ${spec.default.length}` };
    if (raw.length !== spec.default.length) {
      return { value: null, note: `${sectionId}.${key} expects ${spec.default.length} entries, got ${raw.length}` };
    }
    const out = [];
    let clamped = false;
    for (const item of raw) {
      const v = clampToSpec(spec, item);
      if (v === null) return { value: null, note: `${sectionId}.${key} has a non-numeric entry` };
      if (v !== Number(item)) clamped = true;
      out.push(v);
    }
    return { value: out, note: clamped ? `${sectionId}.${key} clamped to ${spec.min}..${spec.max}` : null };
  }
  const v = clampToSpec(spec, raw);
  if (v === null) return { value: null, note: `${sectionId}.${key} is not a number` };
  return { value: v, note: v !== Number(raw) ? `${sectionId}.${key} clamped to ${spec.min}..${spec.max}` : null };
}

const listeners = new Set();

// The studio re-renders on this; the viewers do not subscribe, they just read live values.
export function onParamsChanged(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(reason) {
  for (const fn of listeners) {
    try { fn(SOUND_PARAMS, reason); } catch (err) { console.warn('sound-params listener', err); }
  }
}

// Apply an override document in place. Unknown keys are reported, never thrown on: a JSON written
// by an older studio build must still load the parts it got right.
export function applyParamOverrides(doc, { notify: shouldNotify = true } = {}) {
  const warnings = [];
  let applied = 0;
  if (!doc || typeof doc !== 'object') return { applied, warnings: ['override document is not an object'] };

  for (const [sectionId, section] of Object.entries(doc)) {
    if (sectionId === 'meta') continue;
    if (!section || typeof section !== 'object') { warnings.push(`section ${sectionId} is not an object`); continue; }

    if (MAP_SECTION_IDS.includes(sectionId)) {
      for (const [key, value] of Object.entries(section)) {
        SOUND_PARAMS[sectionId][key] = value;
        applied++;
      }
      continue;
    }
    if (!SOUND_PARAM_SCHEMA[sectionId]) { warnings.push(`unknown section ${sectionId}`); continue; }

    for (const [key, raw] of Object.entries(section)) {
      const { value, note } = coerceParam(sectionId, key, raw);
      if (note) warnings.push(note);
      if (value === null) continue;
      SOUND_PARAMS[sectionId][key] = value;
      applied++;
    }
  }
  if (shouldNotify && applied) notify('override');
  return { applied, warnings };
}

// Set one scalar (or one array) and notify. This is the studio's slider path.
export function setParam(sectionId, key, raw) {
  const { value, note } = coerceParam(sectionId, key, raw);
  if (value === null) return { ok: false, note };
  SOUND_PARAMS[sectionId][key] = value;
  notify('set');
  return { ok: true, value, note };
}

export function setMapOverride(sectionId, key, value) {
  if (!MAP_SECTION_IDS.includes(sectionId)) return { ok: false, note: `unknown map section ${sectionId}` };
  if (value === undefined) delete SOUND_PARAMS[sectionId][key];
  else SOUND_PARAMS[sectionId][key] = value;
  notify('set');
  return { ok: true };
}

export function resetParams(sectionId = null) {
  const fresh = buildDefaults();
  const ids = sectionId ? [sectionId] : [...SECTION_IDS, ...MAP_SECTION_IDS];
  for (const id of ids) {
    if (!SOUND_PARAMS[id]) continue;
    for (const key of Object.keys(SOUND_PARAMS[id])) delete SOUND_PARAMS[id][key];
    Object.assign(SOUND_PARAMS[id], fresh[id]);
  }
  notify('reset');
}

// True when a section holds anything other than its schema default.
export function sectionIsDirty(sectionId) {
  const section = SOUND_PARAM_SCHEMA[sectionId];
  if (!section) return Object.keys(SOUND_PARAMS[sectionId] || {}).length > 0;
  for (const [key, spec] of Object.entries(section.params)) {
    const live = SOUND_PARAMS[sectionId][key];
    const def = spec.default;
    if (Array.isArray(def)) {
      if (!Array.isArray(live) || live.length !== def.length) return true;
      for (let i = 0; i < def.length; i++) if (live[i] !== def[i]) return true;
    } else if (live !== def) return true;
  }
  return false;
}

// The document the studio writes to sound-params.json. `diffOnly` keeps it to what actually
// differs from the schema defaults, so a hand-read of the file shows the authored decisions.
export function exportParams({ diffOnly = true } = {}) {
  const doc = {};
  for (const [sectionId, section] of Object.entries(SOUND_PARAM_SCHEMA)) {
    const out = {};
    for (const [key, spec] of Object.entries(section.params)) {
      const live = SOUND_PARAMS[sectionId][key];
      if (diffOnly) {
        const def = spec.default;
        const same = Array.isArray(def)
          ? Array.isArray(live) && live.length === def.length && def.every((d, i) => d === live[i])
          : live === def;
        if (same) continue;
      }
      out[key] = Array.isArray(live) ? live.slice() : live;
    }
    if (Object.keys(out).length || !diffOnly) doc[sectionId] = out;
  }
  for (const id of MAP_SECTION_IDS) {
    const live = SOUND_PARAMS[id];
    if (live && Object.keys(live).length) doc[id] = JSON.parse(JSON.stringify(live));
  }
  return doc;
}

// Structural check used by test-sound-params.mjs. Reports rather than repairs, so a bad JSON is a
// failing test instead of a silently half-applied document.
export function validateParamDoc(doc) {
  const errors = [];
  const warnings = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['document is not an object'], warnings };

  for (const [sectionId, section] of Object.entries(doc)) {
    if (sectionId === 'meta') continue;
    if (MAP_SECTION_IDS.includes(sectionId)) {
      if (!section || typeof section !== 'object') errors.push(`${sectionId} is not an object`);
      continue;
    }
    const schema = SOUND_PARAM_SCHEMA[sectionId];
    if (!schema) { errors.push(`unknown section "${sectionId}"`); continue; }
    if (!section || typeof section !== 'object') { errors.push(`${sectionId} is not an object`); continue; }

    for (const [key, raw] of Object.entries(section)) {
      const spec = schema.params[key];
      if (!spec) { errors.push(`unknown param "${sectionId}.${key}"`); continue; }
      const items = Array.isArray(spec.default) ? raw : [raw];
      if (Array.isArray(spec.default)) {
        if (!Array.isArray(raw)) { errors.push(`${sectionId}.${key} must be an array`); continue; }
        if (raw.length !== spec.default.length) {
          errors.push(`${sectionId}.${key} must have ${spec.default.length} entries, got ${raw.length}`);
          continue;
        }
      }
      for (const item of items) {
        const n = Number(item);
        if (!Number.isFinite(n)) { errors.push(`${sectionId}.${key} is not a number: ${JSON.stringify(item)}`); continue; }
        if (n < spec.min || n > spec.max) {
          errors.push(`${sectionId}.${key} = ${n} is outside ${spec.min}..${spec.max}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Cross-section sanity that no single range check can catch. These are the mistakes that actually
// shipped, so they are worth failing a test over.
export function auditParams(params = SOUND_PARAMS) {
  const issues = [];
  const r = params.ranges, d = params.damage, b = params.budget, v = params.voice;

  if (r.voiceMax < r.gunshotMax) {
    issues.push(`voice range ${r.voiceMax} m is shorter than gunshot ${r.gunshotMax} m: callouts will be masked by fire the listener can still hear`);
  }
  if (d.maxSirens > b.loopCap) {
    issues.push(`damage.maxSirens ${d.maxSirens} exceeds budget.loopCap ${b.loopCap}: sirens alone can fill the sustained ceiling`);
  }
  if (d.maxSirens + d.maxDamageLoops > b.loopCap) {
    issues.push(`damage.maxSirens + maxDamageLoops (${d.maxSirens + d.maxDamageLoops}) exceeds budget.loopCap ${b.loopCap}`);
  }
  if (d.sparkFastMs > d.sparkSlowMs) {
    issues.push(`damage.sparkFastMs ${d.sparkFastMs} exceeds sparkSlowMs ${d.sparkSlowMs}: the cadence gets slower as the bot gets closer to death`);
  }
  if (v.clampHzMin >= v.clampHzMax) {
    issues.push(`voice.clampHzMin ${v.clampHzMin} is not below clampHzMax ${v.clampHzMax}`);
  }
  if (v.radioHighpassHz >= v.radioLowpassHz) {
    issues.push(`voice.radioHighpassHz ${v.radioHighpassHz} is not below radioLowpassHz ${v.radioLowpassHz}: the radio chain passes nothing`);
  }
  const capSum = b.ballisticCap + params.director.speakerCap + b.damageCap;
  if (capSum < b.globalCap) {
    issues.push(`category caps sum to ${capSum}, below globalCap ${b.globalCap}: the global cap can never be the binding limit`);
  }
  if (params.director.speakerCap > b.globalCap) {
    issues.push(`director.speakerCap ${params.director.speakerCap} exceeds budget.globalCap ${b.globalCap}`);
  }
  // Both viewers pin the director cutoff to ranges.voiceMax, so a schema default below it is a
  // number nothing reads. Left unpinned it would silently drop lines the panner still plays.
  if (params.director.maxDistance < r.voiceMax) {
    issues.push(`director.maxDistance ${params.director.maxDistance} m is below the voice panner range ${r.voiceMax} m: an unpinned director drops callouts that would still have been audible`);
  }
  return issues;
}

// Fetch the override document. Browser-only by design -- Node callers import the defaults instead.
export async function loadSoundParams(url = './sound-params.json', { apply = true } = {}) {
  if (typeof fetch !== 'function') return { ok: false, reason: 'no fetch', doc: null };
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { ok: false, reason: `http ${res.status}`, doc: null };
    const doc = await res.json();
    const result = apply ? applyParamOverrides(doc) : { applied: 0, warnings: [] };
    return { ok: true, doc, ...result };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err), doc: null };
  }
}
