#!/usr/bin/env python3
"""Local dev server for this site.

Serves this folder at http://localhost:5240 with browser caching turned off, so every
reload — in any browser — picks up the latest HTML, CSS and JS.

    python3 serve.py          # port 5240
    python3 serve.py 8080     # another port
"""
import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5240
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as server:
        print(f"Serving {ROOT} at http://localhost:{PORT} (caching disabled)")
        server.serve_forever()
