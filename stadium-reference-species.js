// The fourteen Stadium species the rig work was developed and tuned against.

/** The species `demos/stadium-walker.html` offers, grouped as its dropdown groups them. */
export const STADIUM_REFERENCE_GROUPS = Object.freeze({
  'four legs': Object.freeze([
    '019_rattata', '058_growlithe', '077_ponyta', '128_tauros', '033_nidorino',
    '079_slowpoke', '002_ivysaur', '028_sandslash', '086_seel',
  ]),
  'two legs': Object.freeze(['025_pikachu', '006_charizard', '066_machop', '027_sandshrew']),
  'six legs': Object.freeze(['046_paras']),
});

/** All fourteen, flat. */
export const STADIUM_REFERENCE_SPECIES = Object.freeze(
  Object.values(STADIUM_REFERENCE_GROUPS).flat(),
);

/** The four quadrupeds every gait sweep in `sweep-gait.mjs` was run against. */
export const GAIT_SWEEP_SPECIES = Object.freeze(['019_rattata', '058_growlithe', '077_ponyta', '128_tauros']);

// The species the auto-mapper finds no legs on, out of all 151. Mostly correct — snakes, Voltorb, Gastly
// and Onix have none to find — but some are heuristic misses that hand-assigned bone roles can fix.
// Generated from the mapper; `test-stadium-rig.mjs` asserts it still matches, so it cannot go stale.
export const STADIUM_NO_LEG_SPECIES = Object.freeze([
  '010_caterpie', '011_metapod', '014_kakuna', '022_fearow',
  '023_ekans', '024_arbok', '026_raichu', '031_nidoqueen',
  '039_jigglypuff', '049_venomoth', '050_diglett', '055_golduck',
  '056_mankey', '067_machoke', '070_weepinbell', '083_farfetchd',
  '087_dewgong', '090_shellder', '092_gastly', '093_haunter',
  '095_onix', '100_voltorb', '101_electrode', '107_hitmonchan',
  '116_horsea', '117_seadra', '123_scyther', '129_magikarp',
  '130_gyarados', '137_porygon', '145_zapdos', '147_dratini',
  '148_dragonair', '150_mewtwo', '151_mew',
]);
