// Who lives where in the park, how they get about, and what they throw.

/** The eight ground types the park is painted with. Terrain splat layers use these keys. */
export const BIOMES = Object.freeze({
  meadow:   { label: 'Meadow',   blurb: 'Open lawn and wildflower, the middle of the park.' },
  forest:   { label: 'Forest',   blurb: 'Closed canopy, deep leaf litter, little sky.' },
  lake:     { label: 'Lake',     blurb: 'Open water and the reed line at its edge.' },
  shore:    { label: 'Shore',    blurb: 'Sand and shingle where the lake meets the land.' },
  wetland:  { label: 'Wetland',  blurb: 'Marsh, tall grass and standing water.' },
  mountain: { label: 'Mountain', blurb: 'Bare rock and scree above the treeline.' },
  cave:     { label: 'Cave',     blurb: 'The gorge mouth and the dark under the overhang.' },
  town:     { label: 'Town',     blurb: 'Paths, lamps and the park buildings.' },
});

/** How a body travels. `legged` styles drive `stadium-walker.js`; the rest are their own solvers. */
export const MOVEMENT = Object.freeze({
  quad:    { legged: true,  label: 'Quadruped',  blurb: 'Four legs, walk and trot.' },
  biped:   { legged: true,  label: 'Biped',      blurb: 'Two legs, upright stride.' },
  multi:   { legged: true,  label: 'Many-legged', blurb: 'Six or more legs, insect and crustacean.' },
  hover:   { legged: false, label: 'Hover',      blurb: 'Floats at a fixed height, bobs and drifts.' },
  fly:     { legged: false, label: 'Flier',      blurb: 'Cruises well above the ground, banks into turns.' },
  swim:    { legged: false, label: 'Swimmer',    blurb: 'Confined to water, rides the surface.' },
  slither: { legged: false, label: 'Slitherer',  blurb: 'Body follows the head along its own path.' },
  roll:    { legged: false, label: 'Roller',     blurb: 'Rolls on its own axis in the travel direction.' },
  hop:     { legged: false, label: 'Hopper',     blurb: 'Ballistic hops with a squash on landing.' },
  burrow:  { legged: false, label: 'Burrower',   blurb: 'Travels under the soil, surfaces to look around.' },
  static:  { legged: false, label: 'Sessile',    blurb: 'Stays put, twitches, topples and rights itself.' },
});

/** Placement hints inside a biome — a spawn point is scored by how well it satisfies these. */
export const FEATURES = Object.freeze({
  water:    'the edge of open water',
  trees:    'under or beside a tree',
  rocks:    'against rock or scree',
  building: 'near a structure',
  open:     'clear ground with nothing overhead',
  height:   'high ground',
  dark:     'shade, overhang or night',
});

// dex, name, biome, rarity
const T = [
  [  1, 'Bulbasaur',  'forest',   0.35, ['meadow'],            ['trees'],            'quad',    0.7,  4, ['Vine Whip?Absorb', 'Growth', 'Sleep Powder']],
  [  2, 'Ivysaur',    'forest',   0.18, ['meadow'],            ['trees'],            'quad',    1.0,  4, ['Mega Drain', 'Growth', 'Sweet Scent']],
  [  3, 'Venusaur',   'forest',   0.06, [],                    ['trees'],            'quad',    2.0,  4, ['Giga Drain', 'Petal Blizzard', 'Sleep Powder', 'Grassy Terrain']],
  [  4, 'Charmander', 'mountain', 0.30, ['cave'],              ['rocks'],            'biped',   0.6,  2, ['Flamethrower', 'Fire Spin', 'Focus Energy']],
  [  5, 'Charmeleon', 'mountain', 0.15, ['cave'],              ['rocks'],            'biped',   1.1,  2, ['Flamethrower', 'Fire Spin', 'Slash']],
  [  6, 'Charizard',  'mountain', 0.05, [],                    ['height', 'rocks'],  'fly',     1.7,  2, ['Flamethrower', 'Heat Wave', 'Air Slash', 'Sunny Day']],
  [  7, 'Squirtle',   'shore',    0.30, ['lake'],              ['water'],            'biped',   0.5,  2, ['Water Gun', 'Withdraw', 'Bubble']],
  [  8, 'Wartortle',  'shore',    0.15, ['lake'],              ['water'],            'biped',   1.0,  2, ['Water Gun', 'Withdraw', 'Aqua Ring']],
  [  9, 'Blastoise',  'lake',     0.05, ['shore'],             ['water'],            'biped',   1.6,  2, ['Surf', 'Muddy Water', 'Withdraw', 'Rain Dance']],
  [ 10, 'Caterpie',   'forest',   0.90, ['meadow'],            ['trees'],            'multi',   0.3,  8, ['Sticky Web', 'Harden']],
  [ 11, 'Metapod',    'forest',   0.55, [],                    ['trees'],            'static',  0.7,  6, ['Harden', 'Iron Defense']],
  [ 12, 'Butterfree', 'meadow',   0.40, ['forest'],            ['open'],             'fly',     1.1,  6, ['Sleep Powder', 'Stun Spore', 'Air Slash', 'Sweet Scent']],
  [ 13, 'Weedle',     'forest',   0.90, ['meadow'],            ['trees'],            'multi',   0.3,  8, ['Poison Powder', 'Harden']],
  [ 14, 'Kakuna',     'forest',   0.55, [],                    ['trees'],            'static',  0.6,  6, ['Harden', 'Iron Defense']],
  [ 15, 'Beedrill',   'forest',   0.35, ['meadow'],            ['trees'],            'fly',     1.0,  6, ['Cross Poison', 'X-Scissor', 'Agility']],
  [ 16, 'Pidgey',     'meadow',   0.95, ['forest', 'town'],    ['open'],             'fly',     0.3,  2, ['Sand Attack', 'Air Slash', 'Hurricane']],
  [ 17, 'Pidgeotto',  'meadow',   0.40, ['forest'],            ['open'],             'fly',     1.1,  2, ['Air Slash', 'Aerial Ace', 'Twister']],
  [ 18, 'Pidgeot',    'mountain', 0.12, ['meadow'],            ['height'],           'fly',     1.5,  2, ['Hurricane', 'Aerial Ace', 'Agility']],
  [ 19, 'Rattata',    'town',     1.00, ['meadow', 'forest'],  ['building'],         'quad',    0.3,  4, ['Screech', 'Sand Attack']],
  [ 20, 'Raticate',   'town',     0.45, ['meadow'],            ['building'],         'quad',    0.7,  4, ['Screech', 'Slash', 'Focus Energy']],
  [ 21, 'Spearow',    'meadow',   0.85, ['mountain'],          ['open'],             'fly',     0.3,  2, ['Sand Attack', 'Aerial Ace']],
  [ 22, 'Fearow',     'mountain', 0.30, ['meadow'],            ['height'],           'fly',     1.2,  2, ['Aerial Ace', 'Air Slash', 'Agility']],
  [ 23, 'Ekans',      'meadow',   0.50, ['wetland'],           ['open'],             'slither', 2.0,  0, ['Poison Gas', 'Wrap', 'Bind']],
  [ 24, 'Arbok',      'meadow',   0.20, ['cave'],              ['dark'],             'slither', 3.5,  0, ['Poison Gas', 'Bind', 'Screech', 'Sludge Bomb']],
  [ 25, 'Pikachu',    'forest',   0.55, ['meadow', 'town'],    ['trees'],            'biped',   0.4,  2, ['Thunderbolt', 'Thunder Wave', 'Agility', 'Electro Ball']],
  [ 26, 'Raichu',     'forest',   0.14, ['town'],              ['trees'],            'biped',   0.8,  2, ['Thunderbolt', 'Discharge', 'Electric Terrain']],
  [ 27, 'Sandshrew',  'shore',    0.50, ['mountain'],          ['rocks'],            'biped',   0.6,  2, ['Sand Attack', 'Sand Tomb', 'Harden']],
  [ 28, 'Sandslash',  'mountain', 0.22, ['shore'],             ['rocks'],            'biped',   1.0,  2, ['Sandstorm', 'Slash', 'Sand Tomb']],
  [ 29, 'Nidoran-F',  'meadow',   0.60, ['forest'],            ['open'],             'quad',    0.4,  4, ['Poison Powder', 'Sand Attack']],
  [ 30, 'Nidorina',   'meadow',   0.28, ['forest'],            ['open'],             'quad',    0.8,  4, ['Poison Gas', 'Toxic Spikes', 'Bulk Up']],
  [ 31, 'Nidoqueen',  'cave',     0.09, ['mountain'],          ['rocks', 'dark'],    'biped',   1.3,  2, ['Earthquake', 'Sludge Bomb', 'Bulk Up']],
  [ 32, 'Nidoran-M',  'meadow',   0.60, ['forest'],            ['open'],             'quad',    0.5,  4, ['Poison Powder', 'Focus Energy']],
  [ 33, 'Nidorino',   'meadow',   0.28, ['forest'],            ['open'],             'quad',    0.9,  4, ['Poison Gas', 'Toxic Spikes', 'Focus Energy']],
  [ 34, 'Nidoking',   'cave',     0.09, ['mountain'],          ['rocks', 'dark'],    'biped',   1.4,  2, ['Earthquake', 'Sludge Bomb', 'Stone Edge']],
  [ 35, 'Clefairy',   'mountain', 0.30, ['meadow'],            ['height', 'rocks'],  'biped',   0.6,  2, ['Dazzling Gleam', 'Misty Terrain', 'Cosmic Power']],
  [ 36, 'Clefable',   'mountain', 0.10, ['meadow'],            ['height'],           'biped',   1.3,  2, ['Dazzling Gleam', 'Misty Terrain', 'Light Screen']],
  [ 37, 'Vulpix',     'meadow',   0.40, ['mountain'],          ['open'],             'quad',    0.6,  4, ['Flamethrower', 'Will-O-Wisp', 'Sunny Day']],
  [ 38, 'Ninetales',  'meadow',   0.12, ['mountain'],          ['open'],             'quad',    1.1,  4, ['Flamethrower', 'Will-O-Wisp', 'Heat Wave', 'Calm Mind']],
  [ 39, 'Jigglypuff', 'meadow',   0.55, ['town'],              ['open'],             'hop',     0.5,  2, ['Round', 'Dazzling Gleam', 'Sweet Scent']],
  [ 40, 'Wigglytuff', 'meadow',   0.18, ['town'],              ['open'],             'hop',     1.0,  2, ['Hyper Voice', 'Dazzling Gleam', 'Cotton Guard']],
  [ 41, 'Zubat',      'cave',     0.95, [],                    ['dark'],             'fly',     0.8,  2, ['Leech Life', 'Smokescreen', 'Air Slash']],
  [ 42, 'Golbat',     'cave',     0.40, [],                    ['dark'],             'fly',     1.6,  2, ['Leech Life', 'Air Slash', 'Screech']],
  [ 43, 'Oddish',     'forest',   0.70, ['wetland'],           ['trees'],            'hop',     0.5,  4, ['Absorb', 'Sleep Powder', 'Sweet Scent']],
  [ 44, 'Gloom',      'forest',   0.30, ['wetland'],           ['trees'],            'biped',   0.8,  2, ['Mega Drain', 'Stun Spore', 'Poison Powder']],
  [ 45, 'Vileplume',  'forest',   0.10, ['wetland'],           ['trees'],            'biped',   1.2,  2, ['Giga Drain', 'Petal Blizzard', 'Sleep Powder']],
  [ 46, 'Paras',      'forest',   0.65, ['cave'],              ['dark', 'trees'],    'multi',   0.3,  6, ['Absorb', 'Stun Spore', 'Sleep Powder']],
  [ 47, 'Parasect',   'forest',   0.25, ['cave'],              ['dark', 'trees'],    'multi',   1.0,  6, ['Giga Drain', 'Spore?Sleep Powder', 'X-Scissor']],
  [ 48, 'Venonat',    'forest',   0.50, ['meadow'],            ['trees'],            'multi',   1.0,  6, ['Sleep Powder', 'Poison Powder', 'Leech Life']],
  [ 49, 'Venomoth',   'forest',   0.20, ['meadow'],            ['open'],             'fly',     1.5,  6, ['Sleep Powder', 'Stun Spore', 'Air Slash']],
  [ 50, 'Diglett',    'cave',     0.70, ['meadow'],            ['open'],             'burrow',  0.2,  0, ['Magnitude', 'Sand Attack', 'Bulldoze']],
  [ 51, 'Dugtrio',    'cave',     0.25, ['meadow'],            ['open'],             'burrow',  0.7,  0, ['Earthquake', 'Sandstorm', 'Bulldoze']],
  [ 52, 'Meowth',     'town',     0.70, ['meadow'],            ['building'],         'quad',    0.4,  2, ['Slash', 'Screech', 'Sand Attack']],
  [ 53, 'Persian',    'town',     0.25, ['meadow'],            ['building'],         'quad',    1.0,  4, ['Slash', 'Screech', 'Agility']],
  [ 54, 'Psyduck',    'shore',    0.55, ['lake', 'wetland'],   ['water'],            'biped',   0.8,  2, ['Water Gun', 'Psyshock', 'Confusion?Psyshock']],
  [ 55, 'Golduck',    'lake',     0.20, ['shore'],             ['water'],            'biped',   1.7,  2, ['Surf', 'Psyshock', 'Calm Mind']],
  [ 56, 'Mankey',     'mountain', 0.50, ['forest'],            ['rocks'],            'biped',   0.5,  2, ['Focus Energy', 'Bulk Up', 'Focus Blast']],
  [ 57, 'Primeape',   'mountain', 0.20, ['forest'],            ['rocks'],            'biped',   1.0,  2, ['Focus Blast', 'Bulk Up', 'Screech']],
  [ 58, 'Growlithe',  'town',     0.45, ['meadow'],            ['building'],         'quad',    0.7,  4, ['Flamethrower', 'Will-O-Wisp', 'Sunny Day']],
  [ 59, 'Arcanine',   'meadow',   0.10, ['mountain'],          ['open'],             'quad',    1.9,  4, ['Flamethrower', 'Heat Wave', 'Agility', 'Sunny Day']],
  [ 60, 'Poliwag',    'wetland',  0.70, ['lake', 'shore'],     ['water'],            'biped',   0.6,  2, ['Bubble', 'Water Gun', 'Rain Dance']],
  [ 61, 'Poliwhirl',  'wetland',  0.30, ['lake'],              ['water'],            'biped',   1.0,  2, ['Water Gun', 'Muddy Water', 'Rain Dance']],
  [ 62, 'Poliwrath',  'lake',     0.10, ['wetland'],           ['water'],            'biped',   1.3,  2, ['Surf', 'Focus Blast', 'Bulk Up']],
  [ 63, 'Abra',       'meadow',   0.45, ['town'],              ['open'],             'biped',   0.9,  2, ['Psyshock', 'Barrier', 'Psychic Terrain']],
  [ 64, 'Kadabra',    'meadow',   0.20, ['town'],              ['open'],             'biped',   1.3,  2, ['Psyshock', 'Psycho Cut', 'Calm Mind', 'Reflect']],
  [ 65, 'Alakazam',   'town',     0.07, ['meadow'],            ['building'],         'biped',   1.5,  2, ['Psyshock', 'Psycho Cut', 'Trick Room', 'Reflect']],
  [ 66, 'Machop',     'mountain', 0.50, ['town'],              ['rocks'],            'biped',   0.8,  2, ['Bulk Up', 'Focus Energy', 'Rock Throw']],
  [ 67, 'Machoke',    'mountain', 0.22, ['town'],              ['rocks'],            'biped',   1.5,  2, ['Bulk Up', 'Focus Blast', 'Rock Slide']],
  [ 68, 'Machamp',    'mountain', 0.08, ['town'],              ['rocks'],            'biped',   1.6,  2, ['Focus Blast', 'Bulk Up', 'Stone Edge', 'Wide Guard']],
  [ 69, 'Bellsprout', 'wetland',  0.65, ['forest'],            ['water', 'trees'],   'hop',     0.7,  2, ['Absorb', 'Sleep Powder', 'Growth']],
  [ 70, 'Weepinbell', 'wetland',  0.28, ['forest'],            ['trees'],            'hover',   1.0,  2, ['Mega Drain', 'Stun Spore', 'Growth']],
  [ 71, 'Victreebel', 'wetland',  0.09, ['forest'],            ['trees'],            'hover',   1.7,  2, ['Giga Drain', 'Sleep Powder', 'Leaf Tornado']],
  [ 72, 'Tentacool',  'lake',     0.70, [],                    ['water'],            'swim',    0.9,  0, ['Poison Gas', 'Bubble', 'Wrap']],
  [ 73, 'Tentacruel', 'lake',     0.22, [],                    ['water'],            'swim',    1.6,  0, ['Sludge Bomb', 'Whirlpool', 'Bind']],
  [ 74, 'Geodude',    'mountain', 0.80, ['cave'],              ['rocks'],            'hover',   0.4,  0, ['Rock Throw', 'Harden', 'Magnitude']],
  [ 75, 'Graveler',   'mountain', 0.35, ['cave'],              ['rocks'],            'hover',   1.0,  2, ['Rock Slide', 'Magnitude', 'Self-Destruct']],
  [ 76, 'Golem',      'mountain', 0.12, ['cave'],              ['rocks'],            'biped',   1.4,  2, ['Earthquake', 'Rock Slide', 'Explosion', 'Stealth Rock']],
  [ 77, 'Ponyta',     'meadow',   0.45, ['mountain'],          ['open'],             'quad',    1.0,  4, ['Flamethrower', 'Agility', 'Sunny Day']],
  [ 78, 'Rapidash',   'meadow',   0.15, ['mountain'],          ['open'],             'quad',    1.7,  4, ['Flamethrower', 'Fire Spin', 'Agility']],
  [ 79, 'Slowpoke',   'shore',    0.55, ['lake', 'wetland'],   ['water'],            'quad',    1.2,  4, ['Water Gun', 'Psyshock', 'Curse']],
  [ 80, 'Slowbro',    'shore',    0.20, ['lake'],              ['water'],            'biped',   1.6,  2, ['Surf', 'Psyshock', 'Calm Mind', 'Withdraw']],
  [ 81, 'Magnemite',  'town',     0.60, ['mountain'],          ['building'],         'hover',   0.3,  0, ['Thunder Wave', 'Charge', 'Electro Ball']],
  [ 82, 'Magneton',   'town',     0.25, ['mountain'],          ['building'],         'hover',   1.0,  0, ['Discharge', 'Zap Cannon', 'Electric Terrain']],
  [ 83, "Farfetch'd", 'wetland',  0.30, ['meadow'],            ['water'],            'biped',   0.8,  2, ['Slash', 'Air Slash', 'Swords Dance']],
  [ 84, 'Doduo',      'meadow',   0.55, ['shore'],             ['open'],             'biped',   1.4,  2, ['Sand Attack', 'Agility', 'Aerial Ace']],
  [ 85, 'Dodrio',     'meadow',   0.22, ['shore'],             ['open'],             'biped',   1.8,  4, ['Aerial Ace', 'Agility', 'Sand Attack']],
  [ 86, 'Seel',       'shore',    0.45, ['lake'],              ['water'],            'quad',    1.1,  4, ['Icy Wind', 'Aqua Ring', 'Ice Shard']],
  [ 87, 'Dewgong',    'lake',     0.18, ['shore'],             ['water'],            'swim',    1.7,  0, ['Ice Beam', 'Icy Wind', 'Aurora Veil']],
  [ 88, 'Grimer',     'town',     0.50, ['wetland'],           ['building'],         'slither', 0.9,  4, ['Poison Gas', 'Sludge Bomb', 'Harden']],
  [ 89, 'Muk',        'town',     0.18, ['wetland'],           ['building'],         'slither', 1.2, 10, ['Sludge Bomb', 'Poison Gas', 'Toxic Spikes']],
  [ 90, 'Shellder',   'shore',    0.60, ['lake'],              ['water'],            'hop',     0.3,  0, ['Withdraw', 'Ice Shard', 'Bubble']],
  [ 91, 'Cloyster',   'lake',     0.20, ['shore'],             ['water'],            'static',  1.5,  2, ['Ice Beam', 'Icicle Crash', 'Withdraw', 'Iron Defense']],
  [ 92, 'Gastly',     'cave',     0.60, ['town'],              ['dark'],             'hover',   1.3,  0, ['Shadow Ball', 'Ominous Wind', 'Mean Look']],
  [ 93, 'Haunter',    'cave',     0.28, ['town'],              ['dark'],             'hover',   1.6,  0, ['Shadow Ball', 'Dream Eater', 'Night Shade?Dark Pulse']],
  [ 94, 'Gengar',     'town',     0.10, ['cave'],              ['dark', 'building'], 'biped',   1.5,  2, ['Shadow Ball', 'Dark Pulse', 'Dream Eater', 'Nasty Plot']],
  [ 95, 'Onix',       'cave',     0.20, ['mountain'],          ['rocks'],            'slither', 8.8,  0, ['Rock Slide', 'Stone Edge', 'Earthquake', 'Harden']],
  [ 96, 'Drowzee',    'town',     0.45, ['meadow'],            ['building'],         'biped',   1.0,  2, ['Sleep Powder?Psyshock', 'Dream Eater', 'Psyshock']],
  [ 97, 'Hypno',      'town',     0.18, ['meadow'],            ['building'],         'biped',   1.6,  2, ['Psyshock', 'Dream Eater', 'Calm Mind', 'Trick Room']],
  [ 98, 'Krabby',     'shore',    0.70, ['lake'],              ['water'],            'multi',   0.4,  4, ['Bubble', 'Vise Grip?Bind', 'Harden']],
  [ 99, 'Kingler',    'shore',    0.28, ['lake'],              ['water'],            'multi',   1.3,  4, ['Muddy Water', 'Bind', 'Iron Defense']],
  [100, 'Voltorb',    'town',     0.50, ['mountain'],          ['building'],         'roll',    0.5,  0, ['Charge', 'Self-Destruct', 'Discharge']],
  [101, 'Electrode',  'town',     0.20, ['mountain'],          ['building'],         'roll',    1.2,  0, ['Explosion', 'Discharge', 'Agility']],
  [102, 'Exeggcute',  'forest',   0.45, ['meadow'],            ['trees'],            'hop',     0.4,  2, ['Barrage?Rock Throw', 'Sleep Powder', 'Harden']],
  [103, 'Exeggutor',  'forest',   0.15, ['meadow'],            ['trees'],            'biped',   2.0,  2, ['Giga Drain', 'Psyshock', 'Sleep Powder', 'Grassy Terrain']],
  [104, 'Cubone',     'cave',     0.45, ['mountain'],          ['dark', 'rocks'],    'biped',   0.4,  2, ['Rock Throw', 'Bulldoze', 'Focus Energy']],
  [105, 'Marowak',    'cave',     0.18, ['mountain'],          ['dark', 'rocks'],    'biped',   1.0,  2, ['Rock Slide', 'Bulldoze', 'Swords Dance']],
  [106, 'Hitmonlee',  'town',     0.12, ['mountain'],          ['building'],         'biped',   1.5,  2, ['Focus Blast', 'Agility', 'Bulk Up']],
  [107, 'Hitmonchan', 'town',     0.12, ['mountain'],          ['building'],         'biped',   1.4,  0, ['Focus Blast', 'Bulk Up', 'Focus Energy']],
  [108, 'Lickitung',  'forest',   0.30, ['wetland'],           ['trees'],            'biped',   1.2,  2, ['Wrap', 'Screech', 'Curse']],
  [109, 'Koffing',    'town',     0.50, ['cave'],              ['building', 'dark'], 'hover',   0.6,  4, ['Poison Gas', 'Smokescreen', 'Self-Destruct']],
  [110, 'Weezing',    'town',     0.20, ['cave'],              ['building', 'dark'], 'hover',   1.2,  2, ['Sludge Bomb', 'Poison Gas', 'Explosion', 'Smokescreen']],
  [111, 'Rhyhorn',    'mountain', 0.40, ['cave'],              ['rocks'],            'quad',    1.0,  4, ['Rock Throw', 'Bulldoze', 'Stealth Rock']],
  [112, 'Rhydon',     'mountain', 0.15, ['cave'],              ['rocks'],            'biped',   1.9,  2, ['Earthquake', 'Stone Edge', 'Rock Slide', 'Bulk Up']],
  [113, 'Chansey',    'meadow',   0.10, ['town'],              ['open'],             'biped',   1.1,  2, ['Light Screen', 'Safeguard', 'Dazzling Gleam']],
  [114, 'Tangela',    'forest',   0.35, ['wetland'],           ['trees'],            'hop',     1.0,  2, ['Giga Drain', 'Sticky Web', 'Growth']],
  [115, 'Kangaskhan', 'meadow',   0.10, ['forest'],            ['open'],             'biped',   2.2,  4, ['Bulk Up', 'Focus Blast', 'Bulldoze']],
  [116, 'Horsea',     'lake',     0.60, [],                    ['water'],            'swim',    0.3,  0, ['Bubble', 'Water Gun', 'Smokescreen']],
  [117, 'Seadra',     'lake',     0.25, [],                    ['water'],            'swim',    1.2,  0, ['Water Gun', 'Twister', 'Whirlpool']],
  [118, 'Goldeen',    'lake',     0.70, ['wetland'],           ['water'],            'swim',    0.6,  4, ['Water Gun', 'Aqua Ring', 'Horn Attack?Aerial Ace']],
  [119, 'Seaking',    'lake',     0.28, ['wetland'],           ['water'],            'swim',    1.3,  4, ['Surf', 'Water Gun', 'Aqua Ring']],
  [120, 'Staryu',     'lake',     0.55, ['shore'],             ['water'],            'hover',   0.8,  2, ['Water Gun', 'Dazzling Gleam', 'Rain Dance']],
  [121, 'Starmie',    'lake',     0.20, ['shore'],             ['water'],            'hover',   1.1,  2, ['Surf', 'Psyshock', 'Ice Beam', 'Rain Dance']],
  [122, 'Mr. Mime',   'town',     0.20, ['meadow'],            ['building'],         'biped',   1.3,  2, ['Barrier', 'Light Screen', 'Psyshock', 'Reflect']],
  [123, 'Scyther',    'forest',   0.15, ['meadow'],            ['trees'],            'fly',     1.5,  0, ['X-Scissor', 'Slash', 'Swords Dance', 'Agility']],
  [124, 'Jynx',       'mountain', 0.15, ['cave'],              ['height'],           'biped',   1.4,  6, ['Ice Beam', 'Powder Snow', 'Calm Mind', 'Aurora Veil']],
  [125, 'Electabuzz', 'mountain', 0.15, ['town'],              ['height'],           'biped',   1.1,  6, ['Thunderbolt', 'Discharge', 'Charge']],
  [126, 'Magmar',     'mountain', 0.15, ['cave'],              ['rocks'],            'biped',   1.3,  6, ['Flamethrower', 'Fire Spin', 'Heat Wave']],
  [127, 'Pinsir',     'forest',   0.20, ['meadow'],            ['trees'],            'multi',   1.5, 10, ['X-Scissor', 'Bind', 'Swords Dance']],
  [128, 'Tauros',     'meadow',   0.25, [],                    ['open'],             'quad',    1.4,  4, ['Bulldoze', 'Focus Energy', 'Bulk Up']],
  [129, 'Magikarp',   'lake',     1.00, ['wetland'],           ['water'],            'swim',    0.9,  0, ['Splash?Bubble', 'Bubble']],
  [130, 'Gyarados',   'lake',     0.06, [],                    ['water'],            'swim',    6.5,  0, ['Surf', 'Hyper Voice', 'Twister', 'Rain Dance']],
  [131, 'Lapras',     'lake',     0.08, [],                    ['water'],            'swim',    2.5,  4, ['Surf', 'Ice Beam', 'Rain Dance', 'Mist']],
  [132, 'Ditto',      'town',     0.15, ['meadow'],            ['building'],         'hop',     0.3,  6, ['Harden', 'Barrier']],
  [133, 'Eevee',      'town',     0.35, ['meadow', 'forest'],  ['building'],         'quad',    0.3,  2, ['Sand Attack', 'Focus Energy', 'Curse']],
  [134, 'Vaporeon',   'lake',     0.12, ['shore'],             ['water'],            'quad',    1.0,  2, ['Surf', 'Aqua Ring', 'Rain Dance']],
  [135, 'Jolteon',    'meadow',   0.12, ['town'],              ['open'],             'quad',    0.8,  2, ['Thunderbolt', 'Agility', 'Electric Terrain']],
  [136, 'Flareon',    'meadow',   0.12, ['mountain'],          ['open'],             'quad',    0.9,  2, ['Flamethrower', 'Fire Spin', 'Sunny Day']],
  [137, 'Porygon',    'town',     0.12, [],                    ['building'],         'hover',   0.8,  0, ['Lock-On', 'Zap Cannon', 'Magic Coat', 'Trick Room']],
  [138, 'Omanyte',    'shore',    0.25, ['lake'],              ['water', 'rocks'],   'multi',   0.4,  8, ['Water Gun', 'Withdraw', 'Rock Throw']],
  [139, 'Omastar',    'shore',    0.10, ['lake'],              ['water', 'rocks'],   'multi',   1.0,  4, ['Surf', 'Rock Slide', 'Withdraw']],
  [140, 'Kabuto',     'shore',    0.25, ['lake'],              ['water', 'rocks'],   'multi',   0.5,  4, ['Absorb', 'Harden', 'Water Gun']],
  [141, 'Kabutops',   'shore',    0.10, ['lake'],              ['water', 'rocks'],   'biped',   1.3,  6, ['Slash', 'X-Scissor', 'Swords Dance']],
  [142, 'Aerodactyl', 'mountain', 0.06, ['cave'],              ['height', 'rocks'],  'fly',     1.8,  4, ['Rock Slide', 'Aerial Ace', 'Stone Edge', 'Agility']],
  [143, 'Snorlax',    'meadow',   0.07, ['forest'],            ['open'],             'biped',   2.1,  2, ['Bulldoze', 'Hyper Voice', 'Curse', 'Harden']],
  [144, 'Articuno',   'mountain', 0.02, [],                    ['height'],           'fly',     1.7,  2, ['Ice Beam', 'Icicle Crash', 'Hail', 'Aurora Veil']],
  [145, 'Zapdos',     'mountain', 0.02, [],                    ['height'],           'fly',     1.6,  0, ['Thunderbolt', 'Discharge', 'Zap Cannon', 'Rain Dance']],
  [146, 'Moltres',    'mountain', 0.02, [],                    ['height'],           'fly',     2.0,  2, ['Flamethrower', 'Heat Wave', 'Fire Spin', 'Sunny Day']],
  [147, 'Dratini',    'lake',     0.20, ['wetland'],           ['water'],            'swim',    1.8,  0, ['Dragon Breath', 'Wrap', 'Twister']],
  [148, 'Dragonair',  'lake',     0.08, ['wetland'],           ['water'],            'swim',    4.0,  0, ['Dragon Breath', 'Twister', 'Dragon Dance', 'Mist']],
  [149, 'Dragonite',  'lake',     0.03, ['mountain'],          ['water', 'height'],  'fly',     2.2,  2, ['Dragon Breath', 'Hurricane', 'Draco Meteor', 'Dragon Dance']],
  [150, 'Mewtwo',     'cave',     0.01, [],                    ['dark'],             'hover',   2.0,  0, ['Psyshock', 'Aura Sphere', 'Barrier', 'Psychic Terrain']],
  [151, 'Mew',        'meadow',   0.01, ['forest'],            ['open'],             'fly',     0.4,  0, ['Aura Sphere', 'Psyshock', 'Dazzling Gleam', 'Cosmic Power']],
];

// Some flavour-correct move names are not in `moves/move-registry.js`.
function resolveMove(entry) {
  const i = entry.indexOf('?');
  return i < 0 ? { name: entry, wanted: null } : { name: entry.slice(i + 1), wanted: entry.slice(0, i) };
}

/** Zero-padded three-digit dex number — the key everything else is filed under. */
export const dexKey = (dex) => String(dex).padStart(3, '0');

const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Every species, keyed by `'001'`…`'151'`. */
export const SPECIES = Object.freeze(Object.fromEntries(T.map(([dex, name, biome, rarity, also, near, move, heightM, rigLegs, moves]) => {
  const key = dexKey(dex);
  const resolved = moves.map(resolveMove);
  return [key, Object.freeze({
    key, dex, name,
    slug: slugOf(name),
    file: `${key}_${slugOf(name)}.glb`,
    biome, rarity, also: Object.freeze(also), near: Object.freeze(near),
    move, heightM, rigLegs,
    moves: Object.freeze(resolved.map(m => m.name)),
    moveIntent: Object.freeze(resolved),
  })];
})));

// Sorted, never `Object.values` order.
export const SPECIES_LIST = Object.freeze(Object.values(SPECIES).sort((a, b) => a.dex - b.dex));

/** Is this entry complete enough to put in the world? */
export function spawnable(s) {
  const missing = [];
  if (!s || !BIOMES[s.biome]) missing.push('biome');
  if (!s || !MOVEMENT[s.move]) missing.push('movement style');
  if (!s || !s.moves || !s.moves.length) missing.push('moveset');
  return missing;
}

/** May this species stand on this ground at all? */
export function canOccupy(species, biome) {
  if (biome === 'lake') return species.move === 'swim' || species.move === 'fly' || species.move === 'hover';
  // The converse: a swimmer is confined to water, so it may not be planted on dry land either.
  if (species.move === 'swim') return biome === 'wetland';
  return true;
}

/** Everyone who can appear in `biome`, with the weight they appear at. */
export function rosterFor(biome, list = SPECIES_LIST) {
  const out = [];
  for (const s of list) {
    if (spawnable(s).length) continue;
    if (!canOccupy(s, biome)) continue;
    if (s.biome === biome) out.push({ species: s, weight: s.rarity });
    else if (s.also.includes(biome)) out.push({ species: s, weight: s.rarity * 0.5 });
  }
  return out;
}

/** Pick one of a weighted roster. */
export function pickWeighted(roster, rand = Math.random) {
  let total = 0;
  for (const r of roster) total += r.weight;
  if (!(total > 0)) return null;
  let t = rand() * total;
  for (const r of roster) {
    t -= r.weight;
    if (t <= 0) return r.species;
  }
  return roster[roster.length - 1].species;
}

/** Species grouped by movement style — what the walker/solver dispatch is built from. */
export function byMovement(list = SPECIES_LIST) {
  const out = {};
  for (const k of Object.keys(MOVEMENT)) out[k] = [];
  for (const s of list) out[s.move].push(s);
  return out;
}
