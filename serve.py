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
_SAFE_MAP_SEGMENT = re.compile(r'^[A-Za-z0-9 _-]+$')
# environment-viewer.html's perfLog auto-upload names files perf-<ISO>-<sanitized search>.csv
# (see perfLog.buildFilename); this must stay in sync with that client-side pattern.
_SAFE_STATS_FILENAME = re.compile(r'^perf-[A-Za-z0-9T:\-=&.]+\.csv$')


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
    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == '/api/list-states':
            self._handle_list_states()
            return
        super().do_GET()

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

    def end_headers(self):
        # Live-tuning server: never let the browser cache anything it serves.
        self.send_header('Cache-Control', 'no-store')
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
