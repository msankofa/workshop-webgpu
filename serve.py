import base64
import http.server
import json
import os
import re
import sys
import urllib.parse


ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

FAMILIES_DIR = os.path.join(ROOT, 'families')
PLANT_FAMILIES_DIR = os.path.join(ROOT, 'plant-families')
MAPS_DIR = os.path.join(ROOT, 'maps')
STATS_DIR = os.path.join(ROOT, 'research', 'stats')
STATES_DIR = os.path.join(ROOT, 'states')
BOT_STATES_DIR = os.path.join(ROOT, 'bot-states')
NOTES_DIR = os.path.join(ROOT, 'notes')
MAZE_LAYOUTS_DIR = os.path.join(ROOT, 'maze layouts')
SLOT_SAVES_DIR = os.path.join(ROOT, 'bot-viewer-saves')
BODY_TUNING_DIR = os.path.join(ROOT, 'body-tuning')
MUSIC_DIR = os.path.join(ROOT, 'sfx', 'music')
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


def save_damage_tuning(body_bytes):
    # damage-simulator.html's "save to disk". One file, overwritten in place, so it can be committed
    # and read as the shared default by bot-viewer-v3 -- not a history like the other save_* helpers.
    json.loads(body_bytes.decode('utf-8'))  # reject non-JSON bodies before writing
    target = os.path.join(ROOT, 'damage-tuning.json')
    with open(target, 'wb') as f:
        f.write(body_bytes)
    return 'damage-tuning.json'


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
        super().do_GET()

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

    def do_POST(self):
        if self.path == '/api/save-map':
            self._handle_save_map()
            return
        if self.path.startswith('/api/save-stats'):
            self._handle_save_stats()
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
        if self.path.startswith('/api/save-damage-tuning'):
            self._handle_save_damage_tuning()
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

            os.makedirs(folder_path, exist_ok=True)
            with open(os.path.join(folder_path, f'{name}.glb'), 'wb') as f:
                f.write(glb_bytes)
            with open(os.path.join(folder_path, f'{name}-data.json'), 'w', encoding='utf-8') as f:
                json.dump(map_data, f, indent=2)

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
