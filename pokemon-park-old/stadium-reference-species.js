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
