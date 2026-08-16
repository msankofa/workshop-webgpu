#!/usr/bin/env python3
"""Generate a self-contained three.js viewer HTML for any extracted Stadium model.

Usage: gen_viewer.py <species>   (dex number like 6/025, or name like charizard)

Reads /home/claude/stadium_all (full pipeline output) and writes
/home/claude/viewers/<slug>.html — a single file with three.js, the patched
GLTFLoader (no fetch, no blob URLs), and the model embedded.

The three hardening fixes carried from the Pikachu viewer:
  - camera framed from skeleton joints (geometry bounds are authored 10x)
  - all materials double-sided (the mod renders with culling off)
  - frustumCulled = false per mesh (bounding spheres are wrong for the same
    10x reason, so three.js wrongly culls visible meshes)
"""
import base64
import json
import sys
import os

BUILD = '/home/claude/viewer_build'
OUT_DIR = '/home/claude/viewers'
DATA = '/home/claude/stadium_all'

# Gen 1 move names by id, for labeling attack animations. This table is from
# general knowledge of the Gen 1 move list, not extracted from the ROM.
MOVES = {
    1:'Pound',2:'Karate Chop',3:'Double Slap',4:'Comet Punch',5:'Mega Punch',6:'Pay Day',
    7:'Fire Punch',8:'Ice Punch',9:'Thunder Punch',10:'Scratch',11:'Vise Grip',12:'Guillotine',
    13:'Razor Wind',14:'Swords Dance',15:'Cut',16:'Gust',17:'Wing Attack',18:'Whirlwind',
    19:'Fly',20:'Bind',21:'Slam',22:'Vine Whip',23:'Stomp',24:'Double Kick',25:'Mega Kick',
    26:'Jump Kick',27:'Rolling Kick',28:'Sand Attack',29:'Headbutt',30:'Horn Attack',
    31:'Fury Attack',32:'Horn Drill',33:'Tackle',34:'Body Slam',35:'Wrap',36:'Take Down',
    37:'Thrash',38:'Double-Edge',39:'Tail Whip',40:'Poison Sting',41:'Twineedle',
    42:'Pin Missile',43:'Leer',44:'Bite',45:'Growl',46:'Roar',47:'Sing',48:'Supersonic',
    49:'Sonic Boom',50:'Disable',51:'Acid',52:'Ember',53:'Flamethrower',54:'Mist',
    55:'Water Gun',56:'Hydro Pump',57:'Surf',58:'Ice Beam',59:'Blizzard',60:'Psybeam',
    61:'Bubble Beam',62:'Aurora Beam',63:'Hyper Beam',64:'Peck',65:'Drill Peck',
    66:'Submission',67:'Low Kick',68:'Counter',69:'Seismic Toss',70:'Strength',
    71:'Absorb',72:'Mega Drain',73:'Leech Seed',74:'Growth',75:'Razor Leaf',
    76:'Solar Beam',77:'Poison Powder',78:'Stun Spore',79:'Sleep Powder',80:'Petal Dance',
    81:'String Shot',82:'Dragon Rage',83:'Fire Spin',84:'Thunder Shock',85:'Thunderbolt',
    86:'Thunder Wave',87:'Thunder',88:'Rock Throw',89:'Earthquake',90:'Fissure',
    91:'Dig',92:'Toxic',93:'Confusion',94:'Psychic',95:'Hypnosis',96:'Meditate',
    97:'Agility',98:'Quick Attack',99:'Rage',100:'Teleport',101:'Night Shade',
    102:'Mimic',103:'Screech',104:'Double Team',105:'Recover',106:'Harden',
    107:'Minimize',108:'Smokescreen',109:'Confuse Ray',110:'Withdraw',111:'Defense Curl',
    112:'Barrier',113:'Light Screen',114:'Haze',115:'Reflect',116:'Focus Energy',
    117:'Bide',118:'Metronome',119:'Mirror Move',120:'Self-Destruct',121:'Egg Bomb',
    122:'Lick',123:'Smog',124:'Sludge',125:'Bone Club',126:'Fire Blast',127:'Waterfall',
    128:'Clamp',129:'Swift',130:'Skull Bash',131:'Spike Cannon',132:'Constrict',
    133:'Amnesia',134:'Kinesis',135:'Soft-Boiled',136:'High Jump Kick',137:'Glare',
    138:'Dream Eater',139:'Poison Gas',140:'Barrage',141:'Leech Life',142:'Lovely Kiss',
    143:'Sky Attack',144:'Transform',145:'Bubble',146:'Dizzy Punch',147:'Spore',
    148:'Flash',149:'Psywave',150:'Splash',151:'Acid Armor',152:'Crabhammer',
    153:'Explosion',154:'Fury Swipes',155:'Bonemerang',156:'Rest',157:'Rock Slide',
    158:'Hyper Fang',159:'Sharpen',160:'Conversion',161:'Tri Attack',162:'Super Fang',
    163:'Slash',164:'Substitute',165:'Struggle',
}

CORRUPT = {103: 'Exeggutor', 114: 'Tangela', 126: 'Magmar'}  # dex numbers with
# corrupt standby loops at source (the mod falls back to sprites for these)


def slurp(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def clip_label(a):
    name = a['name']
    if name == 'idle':
        return 'idle (standby loop)'
    if name == 'anim1':
        return 'anim1 (unreferenced second idle)'
    if name == 'attack_default':
        return 'attack_default (also the hit/flinch reaction)'
    if name == 'faint':
        return 'faint'
    if name == 'entrance':
        return 'entrance (out of the ball)'
    moves = []
    for m in a.get('moves', []):
        try:
            mid = int(str(m).split()[-1])
        except ValueError:
            continue
        if mid in MOVES:
            moves.append(MOVES[mid])
    if moves:
        shown = ', '.join(moves[:3])
        more = f' +{len(moves)-3}' if len(moves) > 3 else ''
        return f'{name} ({shown}{more})'
    return name


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    want = sys.argv[1].strip().lower().lstrip('0') or '0'

    manifest = json.load(open(os.path.join(DATA, 'manifest.json')))
    pk = None
    for p in manifest['pokemon']:
        if str(p['species']) == want or p['name'].lower() == want or p['slug'].lower().endswith(want):
            pk = p
            break
    if pk is None:
        sys.exit(f'species not found: {sys.argv[1]!r} (use a dex number 1-151 or an exact name)')

    glb_path = os.path.join(DATA, 'glb', os.path.basename(pk['glb']))
    glb64 = base64.b64encode(open(glb_path, 'rb').read()).decode()
    clips = [{'label': clip_label(a), 'frames': a['frames'], 'seconds': a['seconds'],
              'loop': a['endBehavior'] == 'wrap'} for a in pk['animations']]

    html = slurp(os.path.join(BUILD, 'template2.html'))
    html = html.replace(
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>',
        '<script>/*THREE_JS*/</script>')
    html = html.replace(
        'three.js did not load from cdnjs — the viewer may be offline or the CDN blocked',
        'three.js failed to initialize')

    title = f"{pk['name']} — Pokémon Stadium model"
    html = html.replace('<title>Pikachu — Pokémon Stadium model</title>', f'<title>{title}</title>')
    note = (f"#{pk['species']:03d} {pk['name']} · Pokémon Stadium (US 1.0) battle model, extracted "
            f"from your own ROM by DramaticShapeVoxelMod's pipeline · {pk['triangles']} triangles, "
            f"{pk['bones']} bones, 30 fps · drag to orbit, pinch or wheel to zoom")
    if pk['species'] in CORRUPT:
        note += ' · NOTE: this species has a corrupt standby loop at source (the mod uses its sprite instead)'
    html = html.replace(
        "Pokémon Stadium (US 1.0) battle model, extracted from your own ROM by DramaticShapeVoxelMod's pipeline · 723 triangles, 37 bones, 30 fps · drag to orbit, pinch or wheel to zoom",
        note)

    def safe(s):
        return s.replace('</script>', '<\\/script>')

    html = html.replace('<script>/*THREE_JS*/</script>',
                        '<script>' + safe(slurp(os.path.join(BUILD, 'node_modules/three/build/three.min.js'))) + '</script>')
    html = html.replace('/*GLTF_LOADER*/', safe(slurp(os.path.join(BUILD, 'GLTFLoader.patched.js'))))
    html = html.replace('/*ORBIT_CONTROLS*/', safe(slurp(os.path.join(BUILD, 'node_modules/three/examples/js/controls/OrbitControls.js'))))
    html = html.replace('"/*GLB_BASE64*/"', json.dumps(glb64))
    html = html.replace('/*CLIP_META*/', json.dumps(clips))

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"{pk['species']:03d}_{pk['name'].lower()}.html")
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    print(out, f'{len(html)//1024} KB, {len(clips)} clips')


if __name__ == '__main__':
    main()
