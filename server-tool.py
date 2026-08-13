import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
DEFAULT_TOOL_PORT = 8099
MAX_LOG_LINES = 2000


SERVERS = {
    "static": {
        "label": "Static HTTP",
        "description": "Serves this workspace for browser entry points.",
        "defaultPort": 8080,
        "urlPath": "/environment-viewer.html",
    },
    "relay": {
        "label": "Multiplayer relay",
        "description": "Runs the WebSocket relay used by Host/Join.",
        "defaultPort": 8080,
        "urlPath": "",
    },
    "compress": {
        "label": "GLB compression",
        "description": "Runs glb-shrink-server for the weapon-viewer-v2 Compress panel.",
        "defaultPort": 3847,
        "urlPath": "",
    },
}


def now_stamp():
    return time.strftime("%H:%M:%S")


def port_open(port):
    try:
        with socket.create_connection((HOST, int(port)), timeout=0.15):
            return True
    except OSError:
        return False


class ManagedProcess:
    def __init__(self, server_id, port):
        self.server_id = server_id
        self.port = int(port)
        self.process = None
        self.logs = []
        self.next_seq = 1
        self.lock = threading.Lock()
        self.started_at = None
        self.last_exit = None

    def is_running(self):
        return self.process is not None and self.process.poll() is None

    def add_log(self, line, source="process"):
        text = str(line).rstrip("\r\n")
        with self.lock:
            self.logs.append({
                "seq": self.next_seq,
                "time": now_stamp(),
                "source": source,
                "line": text,
            })
            self.next_seq += 1
            if len(self.logs) > MAX_LOG_LINES:
                self.logs = self.logs[-MAX_LOG_LINES:]

    def start(self):
        if self.is_running():
            raise RuntimeError("already running")

        if self.server_id == "static":
            command = [sys.executable, "serve.py", str(self.port)]
            cwd = ROOT
            env = os.environ.copy()
        elif self.server_id == "relay":
            command = ["node", "server.js"]
            cwd = ROOT / "server"
            env = os.environ.copy()
            env["PORT"] = str(self.port)
        elif self.server_id == "compress":
            command = ["node", "index.mjs"]
            cwd = ROOT / "glb-shrink-server"
            env = os.environ.copy()
            env["PORT"] = str(self.port)
        else:
            raise RuntimeError(f"unknown server id: {self.server_id}")

        flags = 0
        if os.name == "nt":
            flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

        self.add_log(f"starting: {' '.join(command)}", "tool")
        self.process = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            creationflags=flags,
        )
        self.started_at = time.time()
        self.last_exit = None
        self.add_log(f"pid {self.process.pid}, port {self.port}", "tool")
        threading.Thread(target=self._read_output, daemon=True).start()
        threading.Thread(target=self._watch_exit, daemon=True).start()

    def stop(self):
        if not self.is_running():
            self.add_log("stop requested, but process is not running", "tool")
            return
        self.add_log("stopping process", "tool")
        self.process.terminate()
        try:
            self.process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            self.add_log("terminate timed out; killing process", "tool")
            self.process.kill()
            self.process.wait(timeout=4)

    def _read_output(self):
        proc = self.process
        if not proc or not proc.stdout:
            return
        for line in proc.stdout:
            self.add_log(line, "process")

    def _watch_exit(self):
        proc = self.process
        if not proc:
            return
        code = proc.wait()
        self.last_exit = code
        self.add_log(f"process exited with code {code}", "tool")

    def clear_logs(self):
        with self.lock:
            self.logs = []

    def logs_since(self, cursor):
        with self.lock:
            return [entry for entry in self.logs if entry["seq"] > cursor]

    def status(self):
        running = self.is_running()
        uptime = 0
        if running and self.started_at:
            uptime = max(0, int(time.time() - self.started_at))
        return {
            "id": self.server_id,
            "running": running,
            "pid": self.process.pid if running else None,
            "port": self.port,
            "uptime": uptime,
            "lastExit": self.last_exit,
            "portOpen": port_open(self.port),
            "nextSeq": self.next_seq,
        }


processes = {server_id: ManagedProcess(server_id, cfg["defaultPort"]) for server_id, cfg in SERVERS.items()}


class Handler(BaseHTTPRequestHandler):
    server_version = "WorkshopServerTool/1.0"

    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/server-tool.html"):
            self._send_file(ROOT / "server-tool.html", "text/html; charset=utf-8")
        elif parsed.path == "/api/config":
            self._send_json({"servers": SERVERS, "host": HOST})
        elif parsed.path == "/api/status":
            self._send_json({
                "servers": {sid: proc.status() for sid, proc in processes.items()}
            })
        elif parsed.path == "/api/logs":
            qs = parse_qs(parsed.query)
            server_id = qs.get("id", [""])[0]
            cursor = int(qs.get("cursor", ["0"])[0] or 0)
            proc = self._process_or_404(server_id)
            if proc:
                self._send_json({"logs": proc.logs_since(cursor), "nextSeq": proc.next_seq})
        else:
            self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)
        body = self._read_json()
        if parsed.path == "/api/shutdown":
            self._send_json({"ok": True})
            threading.Thread(target=self._shutdown_server, daemon=True).start()
            return
        server_id = body.get("id", "")
        proc = self._process_or_404(server_id)
        if not proc:
            return

        try:
            if parsed.path == "/api/start":
                port = int(body.get("port", proc.port))
                if port < 1 or port > 65535:
                    raise ValueError("port must be 1-65535")
                proc.port = port
                proc.start()
                self._send_json({"ok": True, "status": proc.status()})
            elif parsed.path == "/api/stop":
                proc.stop()
                self._send_json({"ok": True, "status": proc.status()})
            elif parsed.path == "/api/restart":
                port = int(body.get("port", proc.port))
                if port < 1 or port > 65535:
                    raise ValueError("port must be 1-65535")
                proc.stop()
                proc.port = port
                proc.start()
                self._send_json({"ok": True, "status": proc.status()})
            elif parsed.path == "/api/clear-logs":
                proc.clear_logs()
                self._send_json({"ok": True})
            else:
                self.send_error(404)
        except Exception as exc:
            proc.add_log(f"error: {exc}", "tool")
            self._send_json({"ok": False, "error": str(exc)}, status=400)

    def _process_or_404(self, server_id):
        proc = processes.get(server_id)
        if not proc:
            self.send_error(404, "unknown server id")
            return None
        return proc

    def _read_json(self):
        length = int(self.headers.get("content-length", "0") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def _send_file(self, path, content_type):
        if not path.exists():
            self.send_error(404)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, payload, status=200):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _shutdown_server(self):
        for proc in processes.values():
            proc.stop()
        self.server.shutdown()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TOOL_PORT
    httpd = ThreadingHTTPServer((HOST, port), Handler)
    print(f"server tool listening at http://{HOST}:{port}/server-tool.html")
    print("press Ctrl+C to stop the tool; use the dashboard to stop managed servers first")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping managed servers")
    finally:
        for proc in processes.values():
            proc.stop()
        httpd.server_close()


if __name__ == "__main__":
    main()

