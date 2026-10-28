#!/usr/bin/env python3
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs

ready = Path(sys.argv[1])
log = Path(sys.argv[2])
message = {"type": "message", "user": "U11111111", "ts": "1700000000.000001", "text": "Hello *agent*"}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
        params = parse_qs(body)
        params.pop("token", None)
        if self.path == "/api/conversations.history" and params.get("channel") == ["D11111111"]:
            result = {"ok": True, "messages": [message], "has_more": False}
        else:
            result = {"ok": False, "error": "unsupported_fixture_request"}
        with log.open("a") as out:
            out.write(json.dumps({"path": self.path, "params": params, "response": result}) + "\n")
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
ready.write_text(str(server.server_port))
server.serve_forever()
