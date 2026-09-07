"""Static server for this folder plus POST /shot, which writes a PNG (base64 data URL) to shots/.
Run: python shot-server.py [port]   (default 8090), then open http://127.0.0.1:8090/viewer.html"""
import base64, json, os, sys, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
# Serve from the repo root: viewer.html imports ../../flight-meshes.js.
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SHOTS = os.path.join(HERE, 'shots')
os.makedirs(SHOTS, exist_ok=True)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def do_POST(self):
        if self.path not in ('/shot', '/export'):
            self.send_error(404); return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/export':
            # A GLB the viewer exported, base64, written under export/ for Blender.
            out = os.path.join(HERE, 'export'); os.makedirs(out, exist_ok=True)
            name = body.get('name', 'model').replace('/', '_')
            path = os.path.join(out, f'{name}.glb')
            with open(path, 'wb') as f: f.write(base64.b64decode(body['glb']))
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'saved': os.path.relpath(path, HERE)}).encode()); return
        name = body.get('name', 'shot').replace('/', '_')
        stamp = time.strftime('%Y%m%d-%H%M%S')
        path = os.path.join(SHOTS, f'{name}-{stamp}.png')
        with open(path, 'wb') as f: f.write(base64.b64decode(body['png'].split(',', 1)[1]))
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'saved': os.path.relpath(path, HERE)}).encode())
    def log_message(self, fmt, *args): sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
print(f'http://127.0.0.1:{port}/scratchpads/sablynx-ugv/viewer.html')
ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
