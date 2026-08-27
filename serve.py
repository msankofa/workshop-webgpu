import base64
import concurrent.futures
import hashlib
import http.server
import io
import json
import os
import re
import sys
import urllib.parse
import zipfile

from performance_capture_store import prepend_performance_capture


ROOT = os.path.dirname(os.path.abspath(__file__))
# path -> (mtime, size, text) for /api/code-corpus; keyed on mtime so an edited file is re-read.
_CORPUS_CACHE = {}
os.chdir(ROOT)
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

FAMILIES_DIR = os.path.join(ROOT, 'families')
PLANT_FAMILIES_DIR = os.path.join(ROOT, 'plant-families')
MAPS_DIR = os.path.join(ROOT, 'maps')
STATS_DIR = os.path.join(ROOT, 'research', 'stats')
BASE_GAME_PERFORMANCE_LOG_PATH = os.environ.get(
    'BASE_GAME_PERFORMANCE_LOG_PATH',
    os.path.join(STATS_DIR, 'base-game-performance-log.json'),
)
STATES_DIR = os.path.join(ROOT, 'states')
BOT_STATES_DIR = os.path.join(ROOT, 'bot-states')
NOTES_DIR = os.path.join(ROOT, 'notes')
MAZE_LAYOUTS_DIR = os.path.join(ROOT, 'maze layouts')
SLOT_SAVES_DIR = os.path.join(ROOT, 'bot-viewer-saves')
BODY_TUNING_DIR = os.path.join(ROOT, 'body-tuning')
STADIUM_SAVES_DIR = os.path.join(ROOT, 'stadium-saves')
PARK_SAVES_DIR = os.path.join(ROOT, 'park-saves')
MUSIC_DIR = os.path.join(ROOT, 'sfx', 'music')
TERRAIN_BAKES_DIR = os.path.join(ROOT, 'terrain-bakes')
_MUSIC_EXTENSIONS = {'.mp3', '.wav', '.ogg', '.m4a', '.flac', '.opus', '.webm'}
_SAFE_MAP_SEGMENT = re.compile(r'^[A-Za-z0-9 _-]+$')
# environment-viewer.html's perfLog auto-upload names files perf-<ISO>-<sanitized search>.csv
# (see perfLog.buildFilename); botStatsLog.buildFilename uses bots-<ISO>.csv. Both prefixes
# must stay in sync with their client-side pattern.
_SAFE_STATS_FILENAME = re.compile(r'^(?:perf|bots)-[A-Za-z0-9T:\-=&.]+\.csv$')
# bot-viewer-v2.html's state recorder names dumps bot-state-trace-<YYYYMMDD-HHMMSS>.tsv
# (see botStateFileStamp); keep in sync with that client-side pattern.
# Three siblings per take: the state trace, the diagnostic counters, and the combat event stream.
_SAFE_BOT_STATE_FILENAME = re.compile(
    r'^(bot-state-trace-\d{8}-\d{6}\.tsv'
    r'|bot-diag-\d{8}-\d{6}\.json'
    r'|bot-events-\d{8}-\d{6}\.tsv)$')
# bot-viewer-v2.html's "Export layout JSON" names files layout-<kind>-<YYYYMMDDHHMMSS>.json;
# keep in sync with that client-side pattern (kind is a maze/world generator id).
_SAFE_MAZE_LAYOUT_FILENAME = re.compile(r'^layout-[A-Za-z0-9 _.-]+\.json$')
# bot-trace-viewer.html's Notes panel names files notes-<slugified takeLabel>.html (see
# slugifyTakeLabel client-side); keep the charset in sync with that client-side slugify.
_SAFE_NOTES_FILENAME = re.compile(r'^notes-[a-z0-9_-]+\.html$')
# bot-viewer-v2.html mirrors every panel slot save to disk as
# bv2-<group>-slot<N>-<YYYYMMDD-HHMMSS>.json (see exportSlotToDisk client-side).
_SAFE_SLOT_FILENAME = re.compile(r'^bv2-(all|maze|bots|ui)-slot[1-9]\d?-\d{8}-\d{6}\.json$')
# body-preview.html's "Save tuning to disk" names files body-tuning-[<label>-]<YYYYMMDD-HHMMSS>.json
# (see buildTuningFilename client-side); keep the label charset in sync with its slugify.
_SAFE_BODY_TUNING_FILENAME = re.compile(r'^body-tuning-(?:[a-z0-9-]{1,40}-)?\d{8}-\d{6}\.json$')
# demos/stadium-walker.html and its v2 autosave to the three fixed names and snapshot to the timestamped
# ones (see createDiskStore + the "snapshot" button); keep in sync with those client-side names.
# stadium-stances.json is the authoritative neutral pose per species: the walker is its only editor and
# every other reader obeys it, so it is snapshotted like the tuning file rather than treated as scratch.
_SAFE_STADIUM_FILENAME = re.compile(
    r'^(stadium-tuning\.json|stadium-trials\.json|stadium-stances\.json'
    r'|stadium-(tuning|stances)-\d{8}-\d{6}\.json)$')
# demos/pokemon-park.html autosaves its world seed, tuning and sightings to the fixed name and snapshots
# to the timestamped one (see createDiskStore + the "snapshot" button); keep in sync with those.
_SAFE_PARK_FILENAME = re.compile(
    r'^(park-session\.json|park-session-\d{8}-\d{6}\.json)$')


def _safe_under_maps(*segments):
    # Mirrors terrain-v3's map_bundle.py _safe_under_maps: reject empty/unsafe segments
    # and any path that resolves outside MAPS_DIR (defense against folder='../../etc').
    for seg in segments:
        if not seg or not _SAFE_MAP_SEGMENT.match(seg):
            raise ValueError(f'unsafe path segment: {seg!r}')
    base = os.path.abspath(MAPS_DIR)
    target = os.path.abspath(os.path.join(base, *segments))
    if target != base and not target.startswith(base + os.sep):
        raise ValueError('path escapes maps/')
    return target


# Terrain Generator v5 sends its project as canonical JSON text plus the sha256 of
# those exact bytes (terrain-project-v5.js hashProject). Verify before writing so a
# stored -project.json always matches its hash; returns (bytes, hash) or (None, None).
def validate_project_artifact(project_json, project_hash):
    if project_json is None:
        return None, None
    if not isinstance(project_json, str) or not isinstance(project_hash, str):
        raise ValueError('projectJson and projectHash must be strings')
    data = project_json.encode('utf-8')
    if len(data) > 60_000_000:
        raise ValueError('project too large')
    parsed = json.loads(project_json)
    if not isinstance(parsed, dict) or parsed.get('app') != 'terrain-generator-v5':
        raise ValueError('projectJson is not a terrain-generator-v5 project')
    digest = hashlib.sha256(data).hexdigest()
    if digest != project_hash.lower():
        raise ValueError('projectHash does not match projectJson bytes')
    return data, digest


def slugify(name):
    slug = re.sub(r'[^a-z0-9]+', '-', (name or '').strip().lower()).strip('-')
    return slug or 'family'


def save_family_to(payload, dir_path):
    filename = f"{slugify(payload.get('name'))}.json"
    os.makedirs(dir_path, exist_ok=True)
    with open(os.path.join(dir_path, filename), 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)

    manifest_path = os.path.join(dir_path, 'manifest.json')
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            manifest = json.load(f)
        if not isinstance(manifest, list):
            manifest = []
    except (FileNotFoundError, json.JSONDecodeError):
        manifest = []
    if filename not in manifest:
        manifest.append(filename)
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, indent=2)
    return filename


def save_stats_csv(raw_name, body_bytes, append=False):
    # raw_name is untrusted client input: reduce to a basename and validate before any fs use.
    basename = os.path.basename((raw_name or '').replace('\\', '/'))
    if not _SAFE_STATS_FILENAME.match(basename) or '..' in basename:
        raise ValueError(f'unsafe stats filename: {raw_name!r}')
    os.makedirs(STATS_DIR, exist_ok=True)
    if append:
        # no collision suffix here — appends must all land in the same session file
        target = os.path.join(STATS_DIR, basename)
        with open(target, 'ab') as f:
            f.write(body_bytes)
        return os.path.relpath(target, ROOT).replace(os.sep, '/')
    stem, ext = os.path.splitext(basename)
    candidate = basename
    n = 2
    while os.path.exists(os.path.join(STATS_DIR, candidate)):
        candidate = f'{stem}-{n}{ext}'
        n += 1
    target = os.path.join(STATS_DIR, candidate)
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return os.path.relpath(target, ROOT).replace(os.sep, '/')


def save_base_game_performance_capture(body_bytes):
    entry = json.loads(body_bytes.decode('utf-8'))
    entry_count = prepend_performance_capture(BASE_GAME_PERFORMANCE_LOG_PATH, entry)
    rel_path = os.path.relpath(BASE_GAME_PERFORMANCE_LOG_PATH, ROOT).replace(os.sep, '/')
    return rel_path, entry_count


def save_maze_layout(raw_name, body_bytes):
    # raw_name is untrusted client input: reduce to a basename and validate before any fs use.
    basename = os.path.basename((raw_name or '').replace('\\', '/'))
    if not _SAFE_MAZE_LAYOUT_FILENAME.match(basename) or '..' in basename:
        raise ValueError(f'unsafe layout filename: {raw_name!r}')
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    os.makedirs(MAZE_LAYOUTS_DIR, exist_ok=True)
    stem, ext = os.path.splitext(basename)
    candidate = basename
    n = 2
    while os.path.exists(os.path.join(MAZE_LAYOUTS_DIR, candidate)):
        candidate = f'{stem}-{n}{ext}'
        n += 1
    target = os.path.join(MAZE_LAYOUTS_DIR, candidate)
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return os.path.relpath(target, ROOT).replace(os.sep, '/')


def save_notes(raw_name, body_bytes):
    # raw_name is untrusted client input: reduce to a basename and validate before any fs use.
    # Unlike every other save_* helper here, this always overwrites the same file in place --
    # the same note is resaved repeatedly as the user types, not a new artifact each time -- so
    # there is deliberately no collision-suffix logic.
    basename = os.path.basename((raw_name or '').replace('\\', '/'))
    if not _SAFE_NOTES_FILENAME.match(basename) or '..' in basename:
        raise ValueError(f'unsafe notes filename: {raw_name!r}')
    os.makedirs(NOTES_DIR, exist_ok=True)
    target = os.path.join(NOTES_DIR, basename)
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return os.path.relpath(target, ROOT).replace(os.sep, '/')


def save_slot_export(raw_name, body_bytes):
    # Every panel slot save is mirrored here, so a save survives the browser's localStorage being
    # cleared and lands somewhere backed up. Each save is its own timestamped file rather than an
    # overwrite: the point is a history you can go back through, not a single current state.
    basename = os.path.basename((raw_name or '').replace('\\', '/'))
    if not _SAFE_SLOT_FILENAME.match(basename) or '..' in basename:
        raise ValueError(f'unsafe slot filename: {raw_name!r}')
    os.makedirs(SLOT_SAVES_DIR, exist_ok=True)
    target = os.path.join(SLOT_SAVES_DIR, basename)
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return os.path.relpath(target, ROOT).replace(os.sep, '/')


def save_body_tuning(raw_name, body_bytes):
    # Gait / locomotion / pose tuning from body-preview.html. Each save is its own timestamped
    # file, not an overwrite: tuning is exploratory and the point is being able to go back to the
    # one that looked right, not to keep a single current state.
    basename = os.path.basename((raw_name or '').replace('\\', '/'))
    if not _SAFE_BODY_TUNING_FILENAME.match(basename) or '..' in basename:
        raise ValueError(f'unsafe tuning filename: {raw_name!r}')
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    os.makedirs(BODY_TUNING_DIR, exist_ok=True)
    stem, ext = os.path.splitext(basename)
    candidate = basename
    n = 2
    while os.path.exists(os.path.join(BODY_TUNING_DIR, candidate)):
        candidate = f'{stem}-{n}{ext}'
        n += 1
    target = os.path.join(BODY_TUNING_DIR, candidate)
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return os.path.relpath(target, ROOT).replace(os.sep, '/')


def save_stadium(raw_name, body_bytes):
    # Gait setpoints, poses, bone roles, panel state, the trial log and the per-species neutral stances
    # from demos/stadium-walker.html and its v2. The three fixed names are live documents and are
    # overwritten in place; a timestamped name is an explicit snapshot and gets a collision suffix so two
    # in the same second both survive.
    basename = os.path.basename((raw_name or '').replace('\\', '/'))
    if not _SAFE_STADIUM_FILENAME.match(basename) or '..' in basename:
        raise ValueError(f'unsafe stadium filename: {raw_name!r}')
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    os.makedirs(STADIUM_SAVES_DIR, exist_ok=True)
    candidate = basename
    if re.search(r'\d{8}-\d{6}\.json$', basename):
        stem, ext = os.path.splitext(basename)
        n = 2
        while os.path.exists(os.path.join(STADIUM_SAVES_DIR, candidate)):
            candidate = f'{stem}-{n}{ext}'
            n += 1
    target = os.path.join(STADIUM_SAVES_DIR, candidate)
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return os.path.relpath(target, ROOT).replace(os.sep, '/')


def save_park(raw_name, body_bytes):
    # World seed, panel tuning and the field-guide sightings from demos/pokemon-park.html. Same shape as
    # save_stadium: the fixed name is the live document and is overwritten in place; a timestamped name is
    # an explicit snapshot and gets a collision suffix so two in the same second both survive.
    basename = os.path.basename((raw_name or '').replace('\\', '/'))
    if not _SAFE_PARK_FILENAME.match(basename) or '..' in basename:
        raise ValueError(f'unsafe park filename: {raw_name!r}')
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    os.makedirs(PARK_SAVES_DIR, exist_ok=True)
    candidate = basename
    if re.search(r'\d{8}-\d{6}\.json$', basename):
        stem, ext = os.path.splitext(basename)
        n = 2
        while os.path.exists(os.path.join(PARK_SAVES_DIR, candidate)):
            candidate = f'{stem}-{n}{ext}'
            n += 1
    target = os.path.join(PARK_SAVES_DIR, candidate)
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return os.path.relpath(target, ROOT).replace(os.sep, '/')


def save_damage_tuning(body_bytes):
    # damage-simulator.html's "save to disk". One file, overwritten in place, so it can be committed
    # and read as the shared default by bot-viewer-v3 -- not a history like the other save_* helpers.
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    target = os.path.join(ROOT, 'damage-tuning.json')
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return 'damage-tuning.json'


def save_water_config(body_bytes):
    # water-demo.html's "Save to water-config.json". One file, overwritten in place, so the flight
    # sim can re-read it behind its refresh button -- not a history like the other save_* helpers.
    # Same arrangement as damage-tuning.json above.
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    target = os.path.join(ROOT, 'water-config.json')
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return 'water-config.json'


def save_ordination(body_bytes):
    # code-ordination.html's pipeline config plus the last sweep table. One file overwritten in
    # place, same arrangement as water-config.json above -- the page reloads it on next open so a
    # configuration that scored well is never trapped in browser storage.
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    target = os.path.join(ROOT, 'ordination-config.json')
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return 'ordination-config.json'


def save_ground_look(body_bytes):
    # demos/flight-sim.html's "Save to ground-look.json". One file overwritten in place, same
    # arrangement as water-config.json above: the page reloads it on next open.
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    target = os.path.join(ROOT, 'ground-look.json')
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return 'ground-look.json'


HYBRID_TUNING_DIR = os.path.join(ROOT, 'sabosugi-visuals', 'hybrid-tuning')
_SAFE_HYBRID_NAME = re.compile(r'^[a-z0-9-]{1,64}$')


def save_hybrid_tuning(raw_name, body_bytes):
    # One route for every sabosugi hybrid's GUI, rather than a bespoke route per page. The name is
    # client input, so it is pattern-checked before it is ever used as a filename.
    name = (raw_name or '').strip()
    if not _SAFE_HYBRID_NAME.match(name):
        raise ValueError('unsafe hybrid name: %r' % (raw_name,))
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    os.makedirs(HYBRID_TUNING_DIR, exist_ok=True)
    target = os.path.join(HYBRID_TUNING_DIR, name + '.json')
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return os.path.relpath(target, ROOT).replace(os.sep, '/')


def save_glass_plankton(body_bytes):
    # sabosugi-visuals/hybrids/glass-plankton.html autosaves its GUI here. Same one-file-overwritten
    # arrangement as ground-look.json above: the page reads it back on next open, so a tuning session
    # survives a cleared origin or a different port.
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    target = os.path.join(ROOT, 'glass-plankton.json')
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return 'glass-plankton.json'


def save_shot_spread(body_bytes):
    # base-game.html's "Save as default" in the Weapon spread section. Tuned once and committed,
    # so the file IS the default the page and the relay both read; shot-spread.js only holds the
    # fallback for a copy opened without it.
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    target = os.path.join(ROOT, 'shot-spread.json')
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return 'shot-spread.json'


def save_bot_state_trace(raw_name, body_bytes):
    # raw_name is untrusted client input: reduce to a basename and validate before any fs use.
    basename = os.path.basename((raw_name or '').replace('\\', '/'))
    if not _SAFE_BOT_STATE_FILENAME.match(basename) or '..' in basename:
        raise ValueError(f'unsafe trace filename: {raw_name!r}')
    os.makedirs(BOT_STATES_DIR, exist_ok=True)
    stem, ext = os.path.splitext(basename)
    candidate = basename
    n = 2
    while os.path.exists(os.path.join(BOT_STATES_DIR, candidate)):
        candidate = f'{stem}-{n}{ext}'
        n += 1
    target = os.path.join(BOT_STATES_DIR, candidate)
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return os.path.relpath(target, ROOT).replace(os.sep, '/')


SABOSUGI_DIR = os.path.join(ROOT, 'sabosugi-visuals')
SABOSUGI_MANIFEST = os.path.join(SABOSUGI_DIR, 'pens-manifest.json')
_SAFE_SABOSUGI_SLUG = re.compile(r'^[a-z0-9-]+$')
_SABOSUGI_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
}

# slug -> zip filename, rebuilt whenever build-manifest.py rewrites the manifest, so adding a pen does
# not need a server restart.
_sabosugi_index = {'mtime': None, 'slugs': {}}


def sabosugi_slug_map():
    try:
        mtime = os.path.getmtime(SABOSUGI_MANIFEST)
    except OSError:
        return {}
    if _sabosugi_index['mtime'] != mtime:
        with open(SABOSUGI_MANIFEST, encoding='utf-8') as f:
            manifest = json.load(f)
        _sabosugi_index['slugs'] = {
            pen['slug']: pen['file'] for pen in manifest.get('pens', [])
            if pen.get('packaging') == 'zip'
        }
        _sabosugi_index['mtime'] = mtime
    return _sabosugi_index['slugs']


def read_sabosugi_asset(slug, relpath):
    """One file out of a pen's dist/ directory, read from inside its zip rather than an unpacked copy.

    The zips are kept exactly as downloaded -- 80 of them, each already holding a complete self-contained
    dist/index.html -- so the gallery serves them in place instead of littering the folder with 80
    extracted directories that would then drift from the archives.
    """
    if not _SAFE_SABOSUGI_SLUG.match(slug or ''):
        raise ValueError('bad slug')
    zip_name = sabosugi_slug_map().get(slug)
    if not zip_name:
        raise KeyError(slug)

    # zip_name comes from our own generated manifest, but it still ends up in a filesystem path.
    zip_path = os.path.abspath(os.path.join(SABOSUGI_DIR, os.path.basename(zip_name)))
    if not zip_path.startswith(os.path.abspath(SABOSUGI_DIR) + os.sep):
        raise ValueError('escapes the pen directory')

    # A member name is matched against the archive's own listing, so nothing here can traverse out.
    wanted = os.path.normpath(relpath or 'index.html').replace(os.sep, '/')
    if wanted.startswith('..') or wanted.startswith('/'):
        raise ValueError('bad member path')

    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        entry = next((n for n in names if n.endswith('dist/index.html')), None)
        if not entry:
            raise KeyError('no dist/index.html in ' + zip_name)
        base = entry.rsplit('/', 1)[0]
        member = base + '/' + wanted
        if member not in names:
            raise KeyError(member)
        body = z.read(member)

    ext = os.path.splitext(wanted)[1].lower()
    return body, _SABOSUGI_TYPES.get(ext, 'application/octet-stream')


class Handler(http.server.SimpleHTTPRequestHandler):
    # tree-viewer.html's "Export family JSON" POSTs to /api/save-family; plant-viewer.html's
    # equivalent POSTs to /api/save-plant-family. Both land straight in their own directory +
    # manifest.json without a manual download/move/edit round trip. Filename is derived
    # server-side via the same slug rule the client uses, so it can never escape the target dir.
    ROUTES = {
        '/api/save-family': FAMILIES_DIR,
        '/api/save-plant-family': PLANT_FAMILIES_DIR,
    }

    # GET /api/list-states — enumerate *.json files dropped in states/ so the viewer can
    # auto-populate its saved-states list on load. Filenames are read from disk (not client
    # input), so there's nothing to sanitize; the client fetches each via /states/<name>.
    #
    # GET /api/list-music — same idea for sfx/music/: start-screen.js builds its menu-music
    # dropdown from this instead of a hand-maintained manifest, so dropping a new track in the
    # folder makes it selectable with no sfx-browser step. Filenames are read from disk, so
    # there's nothing to sanitize; the client fetches each via /sfx/music/<name>.
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        # /sabosugi/<slug>/<file> -- sabosugi-visuals/gallery.html loads each pen in an iframe from
        # here. Every pen keeps its own document, so its own Three version (nine are in use across the
        # collection), its own lil-gui panel and its own render loop stay isolated, and swapping the
        # iframe disposes the WebGL context that almost none of these pens tear down themselves.
        if path.startswith('/sabosugi/'):
            self._handle_sabosugi(path)
            return
        if path == '/api/list-states':
            self._handle_list_states()
            return
        if path == '/api/list-music':
            self._handle_list_music()
            return
        if path == '/api/list-bot-states':
            self._handle_list_bot_states()
            return
        if path == '/api/list-maze-layouts':
            self._handle_list_maze_layouts()
            return
        if path == '/api/list-body-tuning':
            self._handle_list_body_tuning()
            return
        if path == '/api/list-maps':
            self._handle_list_maps()
            return
        if path == '/api/list-terrain-bakes':
            self._handle_list_terrain_bakes()
            return
        if path == '/api/fs-scan':
            self._handle_fs_scan()
            return
        if path == '/api/code-corpus':
            self._handle_code_corpus()
            return
        super().do_GET()

    # GET /api/code-corpus -- code-ordination.html embeds source text, so it needs the bytes and
    # not just the listing /api/fs-scan returns. One request instead of ~600, because the pipeline
    # re-reads the whole corpus every time the unit or capture target changes. Query params:
    # ext (comma-separated, default js,mjs), max_bytes per file, dirs (comma-separated prefixes).
    _CORPUS_SKIP_DIRS = {'node_modules', '__pycache__', 'versions', 'models', 'sfx', 'sabosugi-visuals'}

    def _handle_code_corpus(self):
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            exts = [e.strip().lstrip('.').lower() for e in (params.get('ext') or ['js,mjs'])[0].split(',') if e.strip()]
            max_bytes = int((params.get('max_bytes') or ['400000'])[0])
            dir_filter = [d.strip().strip('/') for d in (params.get('dirs') or [''])[0].split(',') if d.strip()]
            files = []
            skipped = []
            wanted = []
            for dirpath, dirnames, filenames in os.walk(ROOT):
                dirnames[:] = [
                    d for d in dirnames
                    if d not in self._CORPUS_SKIP_DIRS and not d.startswith('.')
                ]
                rel_dir = os.path.relpath(dirpath, ROOT).replace(os.sep, '/')
                if dir_filter and rel_dir != '.':
                    if not any(rel_dir == d or rel_dir.startswith(d + '/') for d in dir_filter):
                        continue
                elif dir_filter and rel_dir == '.':
                    if '.' not in dir_filter and '' not in dir_filter:
                        continue
                for name in filenames:
                    if name.startswith('.'):
                        continue
                    ext = name.rsplit('.', 1)[-1].lower() if '.' in name else ''
                    if ext not in exts:
                        continue
                    full = os.path.join(dirpath, name)
                    rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
                    try:
                        st = os.stat(full)
                        if st.st_size > max_bytes:
                            skipped.append({'path': rel, 'size': st.st_size, 'reason': 'over max_bytes'})
                            continue
                        wanted.append((full, rel, st.st_mtime, st.st_size))
                    except OSError as exc:
                        skipped.append({'path': rel, 'size': 0, 'reason': str(exc)})

            # This repo lives on a Google Drive virtual filesystem where each open costs ~24ms, so
            # a serial read of the whole corpus takes ~27s. Reads are I/O bound and release the GIL,
            # so a thread pool collapses that, and the mtime cache makes every later load instant.
            def read_one(item):
                full, rel, mtime, size = item
                hit = _CORPUS_CACHE.get(full)
                if hit and hit[0] == mtime and hit[1] == size:
                    return rel, hit[2], size, None
                try:
                    with io.open(full, 'r', encoding='utf-8', errors='replace') as fh:
                        text = fh.read()
                    _CORPUS_CACHE[full] = (mtime, size, text)
                    return rel, text, size, None
                except OSError as exc:
                    return rel, None, size, str(exc)

            cached_before = sum(1 for w in wanted if w[0] in _CORPUS_CACHE)
            with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                for rel, text, size, err in pool.map(read_one, wanted):
                    if err:
                        skipped.append({'path': rel, 'size': size, 'reason': err})
                    else:
                        files.append({'path': rel, 'text': text, 'size': size})
            files.sort(key=lambda f: f['path'])
            self._send_json({
                'ok': True, 'files': files, 'skipped': skipped,
                'count': len(files), 'cached': cached_before,
            })
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # GET /api/fs-scan -- tools/filesystem-map.html's 3D node map walks the whole repo through
    # this instead of a committed manifest, so it never goes stale. Returns every file and
    # directory as a flat list (client rebuilds the tree from '/'-joined relative paths); noise
    # dirs (vcs, caches, deps, dotfiles) are skipped server-side so the client never sees them.
    _FS_SCAN_SKIP_DIRS = {'node_modules', '__pycache__'}

    def _handle_fs_scan(self):
        try:
            entries = []
            base = ROOT
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = [
                    d for d in dirnames
                    if d not in self._FS_SCAN_SKIP_DIRS and not d.startswith('.')
                ]
                rel_dir = os.path.relpath(dirpath, base).replace(os.sep, '/')
                if rel_dir != '.':
                    st = os.stat(dirpath)
                    # st_ctime is creation time on Windows (this repo's dev platform) but metadata-
                    # change time on POSIX; tools/filesystem-map.html's growth timeline uses it as a
                    # best-effort "born at" stamp for the emergence animation, not an authoritative one.
                    entries.append({
                        'path': rel_dir, 'type': 'dir', 'size': 0, 'mtime': st.st_mtime, 'ctime': st.st_ctime,
                    })
                for name in filenames:
                    if name.startswith('.'):
                        continue
                    full = os.path.join(dirpath, name)
                    rel = os.path.relpath(full, base).replace(os.sep, '/')
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    entries.append({
                        'path': rel, 'type': 'file', 'size': st.st_size, 'mtime': st.st_mtime, 'ctime': st.st_ctime,
                    })
            self._send_json({'ok': True, 'root': os.path.basename(base), 'entries': entries})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=500)

    def _handle_sabosugi(self, path):
        parts = [p for p in path.split('/') if p]      # ['sabosugi', slug, *rest]
        if len(parts) < 2:
            self.send_error(404)
            return
        slug = parts[1]
        relpath = '/'.join(parts[2:]) or 'index.html'
        try:
            body, content_type = read_sabosugi_asset(slug, relpath)
        except KeyError:
            self.send_error(404)
            return
        except (ValueError, zipfile.BadZipFile, OSError):
            self.send_error(400)
            return
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    # GET /api/list-maps -- terrain-generator-v5.html's "real exported map" picker enumerates
    # every maps/**/<name>-data.json so it can see its own tool's newest exports.
    def _handle_list_maps(self):
        try:
            files = []
            base = os.path.abspath(MAPS_DIR)
            for dirpath, _dirs, names in os.walk(base):
                for entry in names:
                    if entry.lower().endswith('-data.json'):
                        rel = os.path.relpath(os.path.join(dirpath, entry), base).replace(os.sep, '/')
                        files.append(rel)
            files.sort()
            self._send_json({'ok': True, 'files': files})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=500)

    # GET /api/list-maze-layouts -- start-screen.js builds its Maze Layouts map card from this.
    # Filenames come off disk, so there is nothing to sanitize; the client fetches
    # "maze layouts/<name>" as a static file.
    def _handle_list_maze_layouts(self):
        try:
            files = []
            if os.path.isdir(MAZE_LAYOUTS_DIR):
                for entry in sorted(os.listdir(MAZE_LAYOUTS_DIR)):
                    if entry.lower().endswith('.json') and os.path.isfile(os.path.join(MAZE_LAYOUTS_DIR, entry)):
                        files.append(entry)
            self._send_json({'ok': True, 'files': files})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=500)

    # GET /api/list-body-tuning -- body-preview.html builds its Load dropdown from this, newest
    # first so the most recent session is the default pick. Filenames come off disk, so there is
    # nothing to sanitize; the client fetches body-tuning/<name> as a static file.
    def _handle_list_body_tuning(self):
        try:
            files = []
            if os.path.isdir(BODY_TUNING_DIR):
                for entry in sorted(os.listdir(BODY_TUNING_DIR), reverse=True):
                    if entry.lower().endswith('.json') and os.path.isfile(os.path.join(BODY_TUNING_DIR, entry)):
                        files.append(entry)
            self._send_json({'ok': True, 'files': files})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=500)

    # GET /api/list-bot-states -- bot-trace-viewer.html builds its saved-take dropdown from this.
    # Filenames come off disk, so there is nothing to sanitize; the client fetches bot-states/<name>.
    def _handle_list_bot_states(self):
        try:
            files = []
            if os.path.isdir(BOT_STATES_DIR):
                for entry in sorted(os.listdir(BOT_STATES_DIR)):
                    # State traces only. bot-events-*.tsv lives here too but is a different schema,
                    # and offering it in the take dropdown would just fail to parse.
                    if entry.startswith('bot-state-trace-') and entry.lower().endswith('.tsv') \
                            and os.path.isfile(os.path.join(BOT_STATES_DIR, entry)):
                        files.append(entry)
            self._send_json({'ok': True, 'files': files})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=500)

    def _handle_list_music(self):
        try:
            files = []
            if os.path.isdir(MUSIC_DIR):
                for entry in sorted(os.listdir(MUSIC_DIR)):
                    ext = os.path.splitext(entry)[1].lower()
                    if ext in _MUSIC_EXTENSIONS and os.path.isfile(os.path.join(MUSIC_DIR, entry)):
                        files.append(entry)
            self._send_json({'ok': True, 'files': files})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=500)

    def _handle_list_states(self):
        try:
            files = []
            if os.path.isdir(STATES_DIR):
                for entry in sorted(os.listdir(STATES_DIR)):
                    if entry.lower().endswith('.json') and os.path.isfile(os.path.join(STATES_DIR, entry)):
                        files.append(entry)
            self._send_json({'ok': True, 'files': files})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=500)

    # GET /api/list-terrain-bakes — what bake-terrain.mjs has written into terrain-bakes/, so
    # demos/flight-sim.html can offer them in a dropdown instead of the player guessing a name for
    # ?terrain=. Each .json is the bake's metadata; the matching .bin holds the heights. Returns the
    # metadata inline (it is a few hundred bytes) so the menu can show size and post spacing without
    # fetching every bake.
    def _handle_list_terrain_bakes(self):
        try:
            bakes = []
            if os.path.isdir(TERRAIN_BAKES_DIR):
                for entry in sorted(os.listdir(TERRAIN_BAKES_DIR)):
                    if not entry.lower().endswith('.json') or entry.lower().endswith('.project.json'):
                        continue    # the sidecar project is data for a stream entry, not an entry
                    name = entry[:-5]
                    try:
                        with open(os.path.join(TERRAIN_BAKES_DIR, entry), 'r', encoding='utf-8') as fh:
                            meta = json.load(fh)
                    except Exception:
                        continue
                    # Only offer a terrain whose data is actually on disk: a bake needs its heights,
                    # a stream needs its project. Metadata alone is a half-finished write.
                    needed = name + ('.project.json' if meta.get('mode') == 'stream' else '.bin')
                    if not os.path.isfile(os.path.join(TERRAIN_BAKES_DIR, needed)):
                        continue
                    bakes.append({'name': name, 'meta': meta})
            self._send_json({'ok': True, 'bakes': bakes})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=500)

    def do_POST(self):
        if self.path == '/api/save-map':
            self._handle_save_map()
            return
        if self.path.startswith('/api/save-stats'):
            self._handle_save_stats()
            return
        if self.path == '/api/base-game-performance-capture':
            self._handle_base_game_performance_capture()
            return
        if self.path.startswith('/api/save-bot-state'):
            self._handle_save_bot_state()
            return
        if self.path.startswith('/api/save-maze-layout'):
            self._handle_save_maze_layout()
            return
        if self.path.startswith('/api/save-notes'):
            self._handle_save_notes()
            return
        if self.path.startswith('/api/save-slot-export'):
            self._handle_save_slot_export()
            return
        if self.path.startswith('/api/save-body-tuning'):
            self._handle_save_body_tuning()
            return
        if self.path.startswith('/api/save-stadium'):
            self._handle_save_stadium()
            return
        if self.path.startswith('/api/save-park'):
            self._handle_save_park()
            return
        if self.path.startswith('/api/save-damage-tuning'):
            self._handle_save_damage_tuning()
            return
        if self.path.startswith('/api/save-water-config'):
            self._handle_save_water_config()
            return
        if self.path.startswith('/api/save-shot-spread'):
            return self._handle_save_shot_spread()
        if self.path.startswith('/api/save-ordination'):
            self._handle_save_ordination()
            return
        if self.path.startswith('/api/save-ground-look'):
            self._handle_save_ground_look()
            return
        if self.path.startswith('/api/save-glass-plankton'):
            self._handle_save_glass_plankton()
            return
        if self.path.startswith('/api/save-hybrid'):
            self._handle_save_hybrid()
            return
        dir_path = self.ROUTES.get(self.path)
        if dir_path is None:
            self.send_error(404)
            return
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 5_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
            filename = save_family_to(payload, dir_path)
            self._send_json({'ok': True, 'filename': filename})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # terrain-generator-v4.html's density panel "Export to maps/" button POSTs here so a
    # marching-cubes GLB + map-data.json land directly under maps/ (the same directory
    # terrain-v3's own /v3/export/map endpoint auto-detects and writes into), and
    # map-config.json gets an entry so the map shows up in the game's map picker.
    def _handle_save_map(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 60_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            body = json.loads(self.rfile.read(length).decode('utf-8'))
            folder = str(body.get('folder', '')).strip()
            name = str(body.get('name', '')).strip()
            glb_base64 = body.get('glbBase64', '')
            map_data = body.get('mapData', {})
            if not _SAFE_MAP_SEGMENT.match(name):
                raise ValueError(f'unsafe name: {name!r}')
            folder_path = _safe_under_maps(folder)
            glb_bytes = base64.b64decode(glb_base64)
            project_bytes, project_hash = validate_project_artifact(body.get('projectJson'), body.get('projectHash'))

            os.makedirs(folder_path, exist_ok=True)
            with open(os.path.join(folder_path, f'{name}.glb'), 'wb') as f:
                f.write(glb_bytes)
            with open(os.path.join(folder_path, f'{name}-data.json'), 'w', encoding='utf-8') as f:
                json.dump(map_data, f, indent=2)
            if project_bytes is not None:
                # Written byte-for-byte so sha256 of the file equals the published hash.
                with open(os.path.join(folder_path, f'{name}-project.json'), 'wb') as f:
                    f.write(project_bytes)

            map_key = f'{folder}/{name}.glb'
            config_path = os.path.join(MAPS_DIR, 'map-config.json')
            try:
                with open(config_path, 'r', encoding='utf-8') as f:
                    cfg = json.load(f)
                if not isinstance(cfg, dict):
                    cfg = {}
            except (FileNotFoundError, json.JSONDecodeError):
                cfg = {}
            maps = cfg.setdefault('maps', {})
            if not isinstance(maps, dict):
                cfg['maps'] = maps = {}
            if map_key not in maps:
                display = name.replace('_', ' ').replace('-', ' ').strip().title()
                maps[map_key] = {
                    'displayName': display, 'gameName': display, 'image': '',
                    'playable': True, 'mapScale': 1, 'snapStep': 0.5,
                }
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, indent=2)

            self._send_json({
                'ok': True, 'mapKey': map_key,
                'writtenTo': os.path.join(folder_path, f'{name}.glb'),
                'bytes': len(glb_bytes),
                'projectKey': f'{folder}/{name}-project.json' if project_bytes is not None else None,
                'projectHash': project_hash,
            })
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-stats?filename=perf-<...>.csv[&mode=append] — perfLog auto-upload.
    # mode=append streams incremental rows into one session file; otherwise -N suffix on collision.
    def _handle_save_stats(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 20_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            query = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(query)
            raw_name = (params.get('filename') or [''])[0]
            append = (params.get('mode') or [''])[0] == 'append'
            body_bytes = self.rfile.read(length)
            rel_path = save_stats_csv(raw_name, body_bytes, append=append)
            self._send_json({'ok': True, 'path': rel_path})
        except ValueError as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-bot-state?filename=bot-state-trace-<stamp>.tsv — the state recorder's
    # "Save state-code TSV" button, so a take lands in bot-states/ with no download dialog.
    # -N suffix on collision (two dumps inside the same second).
    def _handle_save_bot_state(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 20_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            raw_name = (params.get('filename') or [''])[0]
            rel_path = save_bot_state_trace(raw_name, self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-maze-layout?filename=layout-<kind>-<stamp>.json -- bot-viewer-v2's
    # "Export layout JSON" button, so a world lands in "maze layouts/" and appears in the
    # start screen's Maze Layouts card with no download/move step. -N suffix on collision.
    def _handle_save_maze_layout(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 20_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            raw_name = (params.get('filename') or [''])[0]
            rel_path = save_maze_layout(raw_name, self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-slot-export?filename=bv2-<group>-slot<N>-<stamp>.json -- bot-viewer-v2's
    # panel slots mirror themselves to bot-viewer-saves/ on every save, so settings survive a
    # cleared localStorage. Fire-and-forget from the client: a failure here is never surfaced.
    def _handle_save_slot_export(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 5_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            raw_name = (params.get('filename') or [''])[0]
            rel_path = save_slot_export(raw_name, self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-body-tuning?filename=body-tuning-[<label>-]<stamp>.json -- body-preview.html's
    # "Save tuning to disk" button, so a gait/locomotion session lands in body-tuning/ with no
    # download dialog and can be reloaded from the Load dropdown. -N suffix on collision.
    def _handle_save_body_tuning(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 5_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            raw_name = (params.get('filename') or [''])[0]
            rel_path = save_body_tuning(raw_name, self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-stadium?filename=stadium-tuning.json -- demos/stadium-walker.html autosaves its
    # setpoints, poses, roles and panel state here on every change, and its trial log alongside, so a
    # tuning session lives in stadium-saves/ and in git rather than in the browser.
    def _handle_save_stadium(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 20_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            raw_name = (params.get('filename') or [''])[0]
            rel_path = save_stadium(raw_name, self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-park?filename=park-session.json -- demos/pokemon-park.html autosaves its world seed,
    # panel tuning and field-guide sightings here on every change, so a session lives in park-saves/ and in
    # git rather than in the browser.
    def _handle_save_park(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 20_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            raw_name = (params.get('filename') or [''])[0]
            rel_path = save_park(raw_name, self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-damage-tuning -- damage-simulator.html's "save to disk". Overwrites
    # damage-tuning.json at the repo root, which bot-viewer-v3 reads as its blood FX defaults.
    def _handle_save_damage_tuning(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 1_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            rel_path = save_damage_tuning(self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/base-game-performance-capture -- prepend one completed Base Game measurement
    # to research/stats/base-game-performance-log.json. The browser sends one entry, never the
    # existing log, so an interrupted/stale tab cannot overwrite measurements already on disk.
    def _handle_base_game_performance_capture(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 1_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            rel_path, entry_count = save_base_game_performance_capture(self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path, 'entryCount': entry_count})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-water-config -- water-demo.html's "Save to water-config.json". Overwrites
    # water-config.json at the repo root, which demos/flight-sim.html re-reads behind its refresh
    # button so water tuned in the demo shows up in the sim without an edit or a rebuild.
    def _handle_save_water_config(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 1_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            rel_path = save_water_config(self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-ground-look -- demos/flight-sim.html's ground-look sliders. Terrain shading is
    # tuned by eye over many passes, so it belongs in a diffable file rather than in web storage,
    # which dies with a cleared origin or a different port.
    def _handle_save_ordination(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 4_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            rel_path = save_ordination(self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    def _handle_save_ground_look(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 1_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            rel_path = save_ground_look(self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-hybrid?name=<slug> -- any sabosugi hybrid's GUI, written to
    # sabosugi-visuals/hybrid-tuning/<slug>.json. Shared by every hybrid page so a new one needs a name,
    # not a new route.
    def _handle_save_hybrid(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 1_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            raw_name = (params.get('name') or [''])[0]
            rel_path = save_hybrid_tuning(raw_name, self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-glass-plankton -- the Glass Plankton hybrid's GUI. Overwrites glass-plankton.json
    # at the repo root, which the page loads on open so a look survives the browser.
    def _handle_save_glass_plankton(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 1_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            rel_path = save_glass_plankton(self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-shot-spread -- base-game.html's weapon-spread tuning. One file overwritten in
    # place; both the page and the relay read it on startup, so they fire the same cone.
    def _handle_save_shot_spread(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 1_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            rel_path = save_shot_spread(self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    # POST /api/save-notes?filename=notes-<slug>.html -- bot-trace-viewer.html's Notes panel
    # autosave (debounced while typing) and its beforeunload/pagehide sendBeacon flush both land
    # here; the same route handles either since a beacon is just a POST with a Blob body.
    def _handle_save_notes(self):
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 1_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            raw_name = (params.get('filename') or [''])[0]
            rel_path = save_notes(raw_name, self.rfile.read(length))
            self._send_json({'ok': True, 'path': rel_path})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

    def end_headers(self):
        # Live-tuning server: never let the browser cache anything it serves.
        self.send_header('Cache-Control', 'no-store')
        # Opt pages into the JS self-profiling API (new Profiler(...)) for perf work.
        self.send_header('Document-Policy', 'js-profiling')
        super().end_headers()

    def _send_json(self, payload, status=200):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


http.server.test(
    HandlerClass=Handler,
    port=port,
    bind="127.0.0.1",
)
