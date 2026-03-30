"""
Chamber Test Log – Web App Launcher
Double-click this file to start the app. Opens in your default browser.
Requires Python 3 (no other dependencies).
"""

import http.server
import socketserver
import os
import sys
import webbrowser
import threading

PORT = 8742  # Uncommon port to avoid conflicts

# Serve files from the 'dist' folder next to this script
if getattr(sys, 'frozen', False):
    BASE = os.path.dirname(sys.executable)
else:
    BASE = os.path.dirname(os.path.abspath(__file__))

DIST_DIR = os.path.join(BASE, "dist")

if not os.path.isdir(DIST_DIR):
    print(f"ERROR: Could not find 'dist' folder at: {DIST_DIR}")
    print("Make sure the 'dist' folder is in the same directory as this script.")
    input("Press Enter to exit...")
    sys.exit(1)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Serve static files from dist/ with correct MIME types, suppress logs."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST_DIR, **kwargs)

    def log_message(self, format, *args):
        pass  # suppress console spam

    def end_headers(self):
        # Allow IndexedDB to work properly
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def open_browser():
    """Open the browser after a short delay to let the server start."""
    import time
    time.sleep(0.8)
    webbrowser.open(f"http://localhost:{PORT}")


if __name__ == "__main__":
    # Check if port is already in use (another instance running)
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    result = sock.connect_ex(('localhost', PORT))
    sock.close()
    if result == 0:
        print(f"App already running on port {PORT}. Opening browser...")
        webbrowser.open(f"http://localhost:{PORT}")
        sys.exit(0)

    print("=" * 50)
    print("  Chamber Test Log – Web App")
    print("=" * 50)
    print(f"\n  Serving on: http://localhost:{PORT}")
    print(f"  Files from: {DIST_DIR}")
    print("\n  Press Ctrl+C to stop the server.\n")

    # Open browser in background thread
    threading.Thread(target=open_browser, daemon=True).start()

    try:
        with socketserver.TCPServer(("", PORT), QuietHandler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    except OSError as e:
        print(f"\nError: {e}")
        input("Press Enter to exit...")
