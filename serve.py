import http.server
import os
import sys


os.chdir(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
http.server.test(
    HandlerClass=http.server.SimpleHTTPRequestHandler,
    port=port,
    bind="127.0.0.1",
)
