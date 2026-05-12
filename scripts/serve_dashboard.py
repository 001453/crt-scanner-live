"""Robust static HTTP server for crt-scanner dashboard.

Why: bare `py -m http.server 9090` keeps crashing with exit_code=1 every
10-30 minutes on this machine (likely Windows process eviction or a hung
client). This wrapper restarts the server on crash, logs every event, and
shields long-lived TCP connections from breaking the main thread.
"""
import sys
import os
import time
import socket
import threading
import logging
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn

PORT = 9090
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("dashboard")


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 50


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log.info("req %s - %s", self.address_string(), fmt % args)

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError) as e:
            log.warning("client conn dropped: %s", e)
        except Exception as e:
            log.exception("handler error: %s", e)


def serve_once():
    os.chdir(ROOT)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), QuietHandler)
    srv.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    log.info("listening on http://127.0.0.1:%d (root=%s)", PORT, ROOT)
    try:
        srv.serve_forever()
    finally:
        try:
            srv.server_close()
        except Exception:
            pass


def main():
    backoff = 1
    while True:
        try:
            serve_once()
            log.warning("server returned without exception, restarting...")
        except KeyboardInterrupt:
            log.info("KeyboardInterrupt, exiting")
            return 0
        except OSError as e:
            log.error("OSError: %s (errno=%s)", e, getattr(e, "errno", "?"))
        except Exception as e:
            log.exception("fatal: %s", e)
        sleep_s = min(backoff, 30)
        log.info("restarting in %ds", sleep_s)
        time.sleep(sleep_s)
        backoff = min(backoff * 2, 30)


if __name__ == "__main__":
    sys.exit(main() or 0)
