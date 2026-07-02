import http.server
import json
import os
import re
import sys


ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

FAMILIES_DIR = os.path.join(ROOT, 'families')
MANIFEST_PATH = os.path.join(FAMILIES_DIR, 'manifest.json')


def slugify(name):
    slug = re.sub(r'[^a-z0-9]+', '-', (name or '').strip().lower()).strip('-')
    return slug or 'family'


class Handler(http.server.SimpleHTTPRequestHandler):
    # tree-viewer.html's "Export family JSON" button POSTs here so a family
    # lands straight in families/ + families/manifest.json without a manual
    # download/move/edit round trip. Filename is derived server-side via the
    # same slug rule the client uses, so it can never escape FAMILIES_DIR.
    def do_POST(self):
        if self.path != '/api/save-family':
            self.send_error(404)
            return
        length = int(self.headers.get('content-length', '0') or 0)
        if length <= 0 or length > 5_000_000:
            self._send_json({'ok': False, 'error': 'bad content length'}, status=400)
            return
        try:
            family = json.loads(self.rfile.read(length).decode('utf-8'))
            filename = f"{slugify(family.get('name'))}.json"
            os.makedirs(FAMILIES_DIR, exist_ok=True)
            with open(os.path.join(FAMILIES_DIR, filename), 'w', encoding='utf-8') as f:
                json.dump(family, f, indent=2)

            try:
                with open(MANIFEST_PATH, 'r', encoding='utf-8') as f:
                    manifest = json.load(f)
                if not isinstance(manifest, list):
                    manifest = []
            except (FileNotFoundError, json.JSONDecodeError):
                manifest = []
            if filename not in manifest:
                manifest.append(filename)
                with open(MANIFEST_PATH, 'w', encoding='utf-8') as f:
                    json.dump(manifest, f, indent=2)

            self._send_json({'ok': True, 'filename': filename})
        except Exception as exc:
            self._send_json({'ok': False, 'error': str(exc)}, status=400)

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
