#!/usr/bin/env python3
"""TwitchSync — local web app for watching downloaded Twitch VODs with synced chat replay.

Zero dependencies (Python stdlib only). Serves the frontend from ./static and
streams VOD files from one or more library folders with HTTP Range support
(required: these MP4s have their moov atom at the end of the file).

The project folder is always a library folder; more can be added from the app
(e.g. a NAS share mounted at /Volumes/...) and are remembered in folders.json.

Usage:  python3 server.py [--dir PATH] [--port 8710] [--no-open]
"""

import argparse
import hashlib
import json
import os
import queue
import re
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
CONFIG_PATH = os.path.join(APP_DIR, "folders.json")
CHUNK = 1024 * 1024  # 1 MiB streaming chunk

MAX_DEPTH = 4  # how far to recurse into a library folder
# NAS/system directories that never hold VODs and are slow or wrong to walk.
SKIP_DIRS = {"@eaDir", "#recycle", "#snapshot", "node_modules", "__pycache__"}
MAX_BODY = 64 * 1024

STATIC_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)(?:$|,)")


def read_head_meta(json_path):
    """Extract streamer/video metadata from the first 64 KB of a TwitchDownloader
    chat JSON without loading the whole (potentially 90 MB) file."""
    try:
        with open(json_path, "rb") as f:
            head = f.read(65536).decode("utf-8", errors="replace")
    except OSError:
        return {}
    dec = json.JSONDecoder()
    out = {}
    for key in ("streamer", "video"):
        m = re.search(r'"%s"\s*:\s*' % key, head)
        if not m:
            continue
        try:
            obj, _ = dec.raw_decode(head, m.end())
        except ValueError:
            continue  # object extends past the head read — skip, fall back to stem
        if isinstance(obj, dict):
            out[key] = obj
    return out


def root_id(path):
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:8]


# Log lines are written by a background thread so that a stderr pipe nobody is
# draining can never block a request thread (that freezes the whole app).
_log_q = queue.Queue(maxsize=2000)


def _log_worker():
    while True:
        line = _log_q.get()
        try:
            sys.stderr.write(line)
            sys.stderr.flush()
        except Exception:
            pass


threading.Thread(target=_log_worker, daemon=True).start()


class Library:
    """Scans one or more library folders and pairs each main MP4 with its chat JSON.

    Pairing rule: every *.mp4 whose name does not contain " - CHAT", with a
    sibling file of the same stem plus a .json extension. Extensions are matched
    case-insensitively (TwitchDownloader has emitted both ".json" and ".Json").

    A VOD's public id is "<rootId>:<relative path without extension>" — it is
    only ever used as a dictionary key, never as a filesystem path.
    """

    def __init__(self, default_root, config_path=CONFIG_PATH):
        self.default_root = os.path.realpath(default_root)
        self.config_path = config_path
        self._lock = threading.Lock()
        self._extra = self._load_config()
        self._vods = {}
        self._meta_cache = {}  # json path -> ((size, mtime), meta)

    # --- roots --------------------------------------------------------------

    def _load_config(self):
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return []
        folders = data.get("folders") if isinstance(data, dict) else None
        out = []
        for p in folders or []:
            if isinstance(p, str) and p not in out:
                out.append(p)
        return out

    def _save_config(self):
        tmp = self.config_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"folders": self._extra}, f, indent=2)
        os.replace(tmp, self.config_path)

    def _root_records(self):
        records = [self._root_record(self.default_root, False)]
        seen = {self.default_root}
        for path in self._extra:
            real = os.path.realpath(os.path.expanduser(path))
            if real in seen:
                continue
            seen.add(real)
            records.append(self._root_record(real, True))
        return records

    @staticmethod
    def _root_record(path, removable):
        return {
            "id": root_id(path),
            "path": path,
            "label": os.path.basename(path.rstrip(os.sep)) or path,
            "removable": removable,
            "online": os.path.isdir(path),
        }

    def folders(self):
        """Root list with a VOD count for each (used by the folder manager UI)."""
        with self._lock:
            self._rescan()
            roots = self._root_records()
            counts = {}
            for v in self._vods.values():
                counts[v["rootId"]] = counts.get(v["rootId"], 0) + 1
        for r in roots:
            r["videoCount"] = counts.get(r["id"], 0)
        return roots

    def add_folder(self, raw_path):
        """Validate and remember a new library folder. Returns (ok, message)."""
        if not isinstance(raw_path, str) or not raw_path.strip():
            return False, "Enter a folder path."
        path = os.path.realpath(os.path.expanduser(raw_path.strip()))
        if not os.path.exists(path):
            return False, "That path doesn't exist. If it's a network share, mount it in Finder first."
        if not os.path.isdir(path):
            return False, "That path is a file, not a folder."
        if not os.access(path, os.R_OK | os.X_OK):
            return False, "That folder isn't readable by this user."
        with self._lock:
            if path == self.default_root:
                return False, "That's already the project folder."
            for existing in self._extra:
                if os.path.realpath(os.path.expanduser(existing)) == path:
                    return False, "That folder is already in the library."
            self._extra.append(path)
            try:
                self._save_config()
            except OSError as e:
                self._extra.pop()
                return False, "Couldn't save the folder list (%s)." % e.strerror
            self._rescan()
            count = sum(1 for v in self._vods.values() if v["rootId"] == root_id(path))
        if count == 0:
            return True, "Added, but no VODs were found there yet."
        return True, "Added %d VOD%s." % (count, "" if count == 1 else "s")

    def remove_folder(self, rid):
        with self._lock:
            for existing in list(self._extra):
                real = os.path.realpath(os.path.expanduser(existing))
                if root_id(real) == rid:
                    self._extra.remove(existing)
                    try:
                        self._save_config()
                    except OSError as e:
                        self._extra.append(existing)
                        return False, "Couldn't save the folder list (%s)." % e.strerror
                    self._rescan()
                    return True, "Folder removed."
        return False, "That folder isn't in the library."

    # --- scanning -----------------------------------------------------------

    def list(self):
        with self._lock:
            self._rescan()
            entries = [self._entry(vid) for vid in self._vods]
        entries.sort(key=lambda v: v["mtime"], reverse=True)
        return entries

    def resolve(self, vid, kind):
        """Return the on-disk path for a VOD id's 'mp4' or 'json', or None."""
        with self._lock:
            vod = self._vods.get(vid)
            if vod is None:
                self._rescan()
                vod = self._vods.get(vid)
            if vod is None:
                # Bookmarks made before multi-folder support used the bare stem.
                for v in self._vods.values():
                    if v["stem"] == vid:
                        vod = v
                        break
            if vod is None:
                return None
            roots = [r["path"] for r in self._root_records()]
        real = os.path.realpath(vod[kind])
        if not any(real == r or real.startswith(r + os.sep) for r in roots):
            return None
        if not os.path.isfile(real):
            return None
        return real

    def _rescan(self):
        vods = {}
        for root in self._root_records():
            if not root["online"]:
                continue
            for rec in self._scan_root(root):
                vods[rec["id"]] = rec
        self._vods = vods

    def _scan_root(self, root):
        base = root["path"]
        found = []
        for dirpath, dirnames, filenames in os.walk(base, onerror=lambda e: None):
            rel_dir = os.path.relpath(dirpath, base)
            depth = 0 if rel_dir == "." else rel_dir.count(os.sep) + 1
            if depth >= MAX_DEPTH:
                dirnames[:] = []
            else:
                dirnames[:] = [d for d in dirnames
                               if d not in SKIP_DIRS and not d.startswith(".")]
            by_lower = {n.lower(): n for n in filenames}
            for name in filenames:
                low = name.lower()
                if not low.endswith(".mp4") or " - chat" in low:
                    continue
                stem = name[:-4]
                jname = by_lower.get((stem + ".json").lower())
                if jname is None:
                    continue
                mp4_path = os.path.join(dirpath, name)
                json_path = os.path.join(dirpath, jname)
                try:
                    st, jst = os.stat(mp4_path), os.stat(json_path)
                except OSError:
                    continue
                rel_stem = os.path.relpath(mp4_path, base)[:-4].replace(os.sep, "/")
                found.append({
                    "id": root["id"] + ":" + rel_stem,
                    "stem": stem,
                    "mp4": mp4_path,
                    "json": json_path,
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "jsize": jst.st_size,
                    "jmtime": jst.st_mtime,
                    "rootId": root["id"],
                    "rootLabel": root["label"],
                    "folder": "" if rel_dir == "." else rel_dir.replace(os.sep, "/"),
                })
        return found

    def _entry(self, vid):
        vod = self._vods[vid]
        stamp = (vod["jsize"], vod["jmtime"])
        cached = self._meta_cache.get(vod["json"])
        if cached and cached[0] == stamp:
            meta = cached[1]
        else:
            meta = read_head_meta(vod["json"])
            self._meta_cache[vod["json"]] = (stamp, meta)
        video = meta.get("video") or {}
        streamer = meta.get("streamer") or {}
        length = video.get("length")
        chapters = video.get("chapters")
        return {
            "id": vod["id"],
            "stem": vod["stem"],
            "title": video.get("title") or vod["stem"],
            "streamer": streamer.get("name") or "",
            "game": video.get("game") or "",
            "durationSec": length if isinstance(length, (int, float)) else None,
            "sizeBytes": vod["size"],
            "mtime": vod["mtime"],
            "chapters": chapters if isinstance(chapters, list) else [],
            "rootId": vod["rootId"],
            "rootLabel": vod["rootLabel"],
            "folder": vod["folder"],
        }


def list_volumes():
    """Mounted volumes, offered as suggestions when adding a NAS folder."""
    out = []
    for base in ("/Volumes",):
        try:
            entries = sorted(os.scandir(base), key=lambda e: e.name.lower())
        except OSError:
            continue
        for e in entries:
            if e.name.startswith("."):
                continue
            try:
                if not e.is_dir():
                    continue
                # "Macintosh HD" is a symlink to / — not a useful suggestion.
                if os.path.realpath(e.path) == os.sep:
                    continue
            except OSError:
                continue
            out.append({"name": e.name, "path": e.path})
    return out


def parse_range(header, size):
    """Parse a Range header. Returns (start, end) inclusive, 'unsatisfiable',
    or None (malformed / absent — serve the full file with 200, per spec).
    Multi-range requests are served as their first part only."""
    m = RANGE_RE.match(header.strip())
    if not m:
        return None
    s, e = m.group(1), m.group(2)
    if s == "" and e == "":
        return None
    if size == 0:
        return "unsatisfiable"
    if s == "":  # suffix form: last N bytes
        n = int(e)
        if n == 0:
            return "unsatisfiable"
        return (max(0, size - n), size - 1)
    start = int(s)
    if start >= size:
        return "unsatisfiable"
    end = min(int(e), size - 1) if e != "" else size - 1
    if end < start:
        return None
    return (start, end)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "TwitchSync/1.0"

    def do_GET(self):
        try:
            self._route()
        except (BrokenPipeError, ConnectionResetError):
            # Scrubbing a 24 GB file constantly aborts in-flight range requests;
            # a dead client socket is business as usual, not an error.
            self.close_connection = True

    do_HEAD = do_GET

    def do_POST(self):
        try:
            self._route_post()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _route(self):
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path
        query = urllib.parse.parse_qs(parts.query)
        if path == "/":
            return self._serve_static("index.html")
        if path == "/favicon.ico":
            return self._empty(204)
        if path == "/icon.png":
            # App logo, kept beside server.py rather than in a library folder.
            return self._send_file(os.path.join(APP_DIR, "icon.png"), "image/png")
        if path.startswith("/static/"):
            return self._serve_static(path[len("/static/"):])
        if path == "/api/videos":
            return self._send_json(self.server.library.list())
        if path == "/api/folders":
            return self._send_json({
                "folders": self.server.library.folders(),
                "volumes": list_volumes(),
            })
        if path == "/chat":
            return self._serve_vod(query, "json", "application/json; charset=utf-8")
        if path == "/media":
            return self._serve_vod(query, "mp4", "video/mp4")
        return self._json_error(404, "not found")

    def _route_post(self):
        path = urllib.parse.urlsplit(self.path).path
        if path != "/api/folders":
            return self._json_error(404, "not found")
        # Requiring a JSON body means a cross-origin POST would need a CORS
        # preflight, which this server never answers — so only this app can call it.
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self._json_error(415, "expected application/json")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json_error(400, "bad content-length")
        if length <= 0 or length > MAX_BODY:
            return self._json_error(400, "bad request body")
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._json_error(400, "malformed JSON")
        if not isinstance(body, dict):
            return self._json_error(400, "malformed JSON")
        action = body.get("action")
        lib = self.server.library
        if action == "add":
            ok, message = lib.add_folder(body.get("path"))
        elif action == "remove":
            ok, message = lib.remove_folder(body.get("id"))
        else:
            return self._json_error(400, "unknown action")
        self._send_json({"ok": ok, "message": message}, status=200 if ok else 400)

    # --- endpoints ----------------------------------------------------------

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_vod(self, query, kind, ctype):
        ids = query.get("v")
        if not ids:
            return self._json_error(400, "missing v parameter")
        path = self.server.library.resolve(ids[0], kind)
        if path is None:
            return self._json_error(404, "unknown video")
        self._send_file(path, ctype)

    def _serve_static(self, rel):
        base = os.path.realpath(STATIC_DIR)
        full = os.path.realpath(os.path.join(base, rel))
        if full != base and not full.startswith(base + os.sep):
            return self._json_error(403, "forbidden")
        if not os.path.isfile(full):
            return self._json_error(404, "not found")
        ctype = STATIC_MIME.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        self._send_file(full, ctype)

    # --- plumbing -----------------------------------------------------------

    def _send_file(self, path, ctype):
        try:
            f = open(path, "rb")
        except OSError:
            return self._json_error(404, "not found")
        with f:
            size = os.fstat(f.fileno()).st_size
            start, end, status = 0, size - 1, 200
            range_header = self.headers.get("Range")
            if range_header:
                parsed = parse_range(range_header, size)
                if parsed == "unsatisfiable":
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.send_header("Content-Length", "0")
                    self.send_header("Accept-Ranges", "bytes")
                    self.end_headers()
                    return
                if parsed is not None:
                    start, end = parsed
                    status = 206
            length = max(0, end - start + 1)
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command == "HEAD":
                return
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(CHUNK, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _json_error(self, code, msg):
        self._send_json({"error": msg}, status=code)

    def _empty(self, code):
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def handle(self):
        # A reset while a keep-alive connection waits for its next request is
        # routine (browsers churn media connections constantly while scrubbing).
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def finish(self):
        # Base finish() flushes wfile; on a socket the client already tore down
        # (routine while scrubbing) that raises and spams tracebacks.
        try:
            super().finish()
        except OSError:
            pass

    def log_message(self, fmt, *args):
        try:
            _log_q.put_nowait("%s - - [%s] %s\n" % (
                self.address_string(), self.log_date_time_string(), fmt % args))
        except Exception:
            pass  # dropping a log line beats stalling a request

    def log_request(self, code="-", size="-"):
        # Media/static requests are hundreds of lines of noise; log API + errors.
        try:
            code_i = int(code)
        except (TypeError, ValueError):
            code_i = 0
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api/") or code_i >= 400:
            self.log_message('"%s" %s', self.requestline, str(code))


def main():
    ap = argparse.ArgumentParser(description="TwitchSync — local Twitch VOD player with synced chat")
    ap.add_argument("--dir", default=None,
                    help="the always-present library folder (default: this script's folder)")
    ap.add_argument("--port", type=int, default=8710)
    ap.add_argument("--no-open", action="store_true", help="don't open the browser automatically")
    args = ap.parse_args()

    root = os.path.realpath(args.dir or APP_DIR)
    if not os.path.isdir(root):
        sys.exit("error: not a directory: %s" % root)

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as e:
        sys.exit("error: cannot bind 127.0.0.1:%d (%s) — already running? Try --port"
                 % (args.port, e.strerror))
    httpd.daemon_threads = True
    httpd.library = Library(root)

    url = "http://127.0.0.1:%d/" % args.port
    print("TwitchSync serving %s" % root, flush=True)
    for extra in httpd.library.folders()[1:]:
        print("  + %s%s" % (extra["path"], "" if extra["online"] else "  (offline)"), flush=True)
    print("  -> %s  (Ctrl-C to stop)" % url, flush=True)
    if not args.no_open:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
