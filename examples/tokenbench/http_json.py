import json, os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

class Handler(BaseHTTPRequestHandler):
  def do_GET(self):
    url = urlparse(self.path)
    if url.path == "/health":
      return self.send_json(200, {"ok": True})
    if url.path == "/sum":
      n = int(parse_qs(url.query).get("n", ["0"])[0])
      return self.send_json(200, {"n": n, "sum": n * (n + 1) // 2 if n > 0 else 0})
    self.send_text(404, "not found")
  def send_json(self, status, body):
    self.send_text(status, json.dumps(body), "application/json")
  def send_text(self, status, body, ctype="text/plain"):
    raw = body.encode()
    self.send_response(status)
    self.send_header("content-type", ctype)
    self.send_header("content-length", str(len(raw)))
    self.end_headers()
    self.wfile.write(raw)
  def log_message(self, *args):
    pass

HTTPServer(("127.0.0.1", int(os.environ.get("PORT", "0"))), Handler).serve_forever()
