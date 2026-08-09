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
import urllib.error
import urllib.parse
import urllib.request  # only used by the explicit --sync-emotes CLI mode
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
THUMB_MAX_BODY = 512 * 1024  # a 320x180 JPEG is ~20 KB; generous headroom

THUMB_DIR = os.path.join(APP_DIR, "thumb-cache")
EMOTE_DIR = os.path.join(APP_DIR, "emote-cache")

STATIC_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
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


def thumb_path(mp4_path):
    """Cache location of a VOD's thumbnail. The name is derived server-side from
    the resolved mp4 path + size (never from anything the client sent), so path
    traversal is impossible by construction and a re-downloaded file's stale
    thumb self-invalidates."""
    try:
        size = os.stat(mp4_path).st_size
    except OSError:
        return None
    key = hashlib.sha1(("%s:%d" % (mp4_path, size)).encode("utf-8")).hexdigest()[:16]
    return os.path.join(THUMB_DIR, key + ".jpg")


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
        if path == "/thumb":
            return self._serve_thumb(query)
        if path.startswith("/emotes/"):
            return self._serve_emote(path[len("/emotes/"):])
        return self._json_error(404, "not found")

    def _route_post(self):
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path
        if path == "/api/folders":
            return self._post_folders()
        if path == "/thumb":
            return self._post_thumb(urllib.parse.parse_qs(parts.query))
        return self._json_error(404, "not found")

    def _reject_body(self, code, msg):
        # Rejecting a POST without draining its body leaves the unread bytes on
        # the keep-alive connection and desyncs the next request — close instead.
        self.close_connection = True
        self._json_error(code, msg)

    def _post_folders(self):
        # Requiring a JSON body means a cross-origin POST would need a CORS
        # preflight, which this server never answers — so only this app can call it.
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self._reject_body(415, "expected application/json")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._reject_body(400, "bad content-length")
        if length <= 0 or length > MAX_BODY:
            return self._reject_body(400, "bad request body")
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

    def _post_thumb(self, query):
        # image/jpeg is not a CORS-safelisted content type, so a cross-origin
        # POST would need a preflight this server never answers — same
        # protection as the JSON requirement on /api/folders.
        ids = query.get("v")
        if not ids:
            return self._reject_body(400, "missing v parameter")
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "image/jpeg":
            return self._reject_body(415, "expected image/jpeg")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._reject_body(400, "bad content-length")
        if length <= 0 or length > THUMB_MAX_BODY:
            return self._reject_body(413, "bad request body")
        mp4 = self.server.library.resolve(ids[0], "mp4")
        if mp4 is None:
            return self._reject_body(404, "unknown video")
        body = b""
        while len(body) < length:
            chunk = self.rfile.read(length - len(body))
            if not chunk:
                break
            body += chunk
        if len(body) != length:
            return self._reject_body(400, "truncated body")
        if body[:3] != b"\xff\xd8\xff":
            return self._json_error(400, "not a JPEG")
        dest = thumb_path(mp4)
        if dest is None:
            return self._json_error(404, "unknown video")
        tmp = "%s.%d.%d.tmp" % (dest, os.getpid(), threading.get_ident())
        try:
            os.makedirs(THUMB_DIR, exist_ok=True)
            with open(tmp, "wb") as f:
                f.write(body)
            os.replace(tmp, dest)  # concurrent writers: last replace wins, atomically
        except OSError as e:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            return self._json_error(500, "could not store thumbnail (%s)" % (e.strerror or e))
        self._send_json({"ok": True})

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

    def _serve_thumb(self, query):
        ids = query.get("v")
        if not ids:
            return self._json_error(400, "missing v parameter")
        mp4 = self.server.library.resolve(ids[0], "mp4")
        if mp4 is None:
            return self._json_error(404, "unknown video")
        path = thumb_path(mp4)
        if path is None or not os.path.isfile(path):
            return self._json_error(404, "no thumbnail")
        self._send_file(path, "image/jpeg")

    def _serve_emote(self, rel):
        # emote-cache/ is flat: after decoding, anything that isn't a plain
        # filename is out (stricter than realpath containment, and sufficient).
        rel = urllib.parse.unquote(rel)
        if not rel or "/" in rel or "\\" in rel or rel.startswith("."):
            return self._json_error(403, "forbidden")
        full = os.path.join(EMOTE_DIR, rel)
        if not os.path.isfile(full):
            return self._json_error(404, "not found")
        ctype = STATIC_MIME.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        # Chat re-creates <img> nodes constantly; no-store would refetch every
        # emote per message. The manifest stays no-store so a re-sync is picked
        # up on the next chat load.
        cache = "no-store" if rel == "manifest.json" else "public, max-age=86400"
        self._send_file(full, ctype, cache_control=cache)

    # --- plumbing -----------------------------------------------------------

    def _send_file(self, path, ctype, cache_control="no-store"):
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
            self.send_header("Cache-Control", cache_control)
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


# ---- emote sync (explicit CLI mode) -----------------------------------------
# `python3 server.py --sync-emotes` downloads each library streamer's BTTV/7TV
# channel emotes plus both global sets into emote-cache/ and writes
# manifest.json for the chat renderer, then exits. The serving path never
# touches the network — playback stays fully offline.

EMOTE_HEADERS = {"User-Agent": "TwitchSync/1.0"}

_ssl_ctx = None


def _ssl_context():
    """python.org macOS builds ship OpenSSL with no CA certs wired up; fall back
    to the system bundle (or certifi if installed) so HTTPS stays verified."""
    global _ssl_ctx
    if _ssl_ctx is not None:
        return _ssl_ctx
    import ssl
    ctx = ssl.create_default_context()
    if ctx.cert_store_stats().get("x509_ca", 0) == 0:
        cafile = next((p for p in ("/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem")
                       if os.path.isfile(p)), None)
        if cafile is None:
            try:
                import certifi
                cafile = certifi.where()
            except ImportError:
                pass
        if cafile:
            ctx = ssl.create_default_context(cafile=cafile)
    _ssl_ctx = ctx
    return ctx


def _http_json(url):
    req = urllib.request.Request(url, headers=EMOTE_HEADERS)
    with urllib.request.urlopen(req, timeout=15, context=_ssl_context()) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_bytes(url):
    req = urllib.request.Request(url, headers=EMOTE_HEADERS)
    with urllib.request.urlopen(req, timeout=15, context=_ssl_context()) as resp:
        return resp.read()


def _emote_filename(name, ext):
    """Sanitized filename for an emote; the hash suffix keeps names like ':tf:'
    and '_tf_' from colliding after sanitization."""
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", name)[:40]
    tag = hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    return "%s-%s%s" % (safe, tag, ext)


def _seventv_records(emotes):
    """(name, record) pairs from a 7TV emote list (user emote_set or global set)."""
    out = []
    for e in emotes or []:
        try:
            name = e.get("name") or ""
            host = (e.get("data") or {}).get("host") or {}
            base = host.get("url") or ""
            files = host.get("files") or []
            if not name or not base:
                continue
            pick = next((f for f in files if f.get("name") == "2x.webp"), None)
            scale = 2
            if pick is None:
                pick = next((f for f in files if f.get("name") == "1x.webp"), None)
                scale = 1
            if pick is None:
                continue
            url = ("https:" + base if base.startswith("//") else base) + "/" + pick["name"]
            out.append((name, {
                "urls": [(url, ".webp")],
                "w": int(pick.get("width") or 0),
                "h": int(pick.get("height") or 0),
                "scale": scale,
                # zero-width lives on the set-level active-emote flags, bit 0
                "zw": bool(e.get("flags", 0) & 1),
            }))
        except (TypeError, ValueError, KeyError):
            continue
    return out


def _bttv_records(emotes):
    """(name, record) pairs from a BTTV emote list (channel+shared or global)."""
    out = []
    for e in emotes or []:
        try:
            name = e.get("code") or ""
            eid = e.get("id") or ""
            if not name or not eid:
                continue
            itype = (e.get("imageType") or "png").lower()
            out.append((name, {
                # BTTV transcodes to webp on the CDN; the native type is the fallback.
                "urls": [
                    ("https://cdn.betterttv.net/emote/%s/2x.webp" % eid, ".webp"),
                    ("https://cdn.betterttv.net/emote/%s/2x.%s" % (eid, itype), "." + itype),
                ],
                "w": 0,  # BTTV's API carries no dimensions; parsed from the file
                "h": 0,
                "scale": 2,
                "zw": False,
            }))
        except (TypeError, ValueError):
            continue
    return out


def _avif_dims(head):
    """Walk ISOBMFF boxes meta → iprp → ipco → ispe for (width, height)."""
    def boxes(start, end):
        pos = start
        while pos + 8 <= end:
            size = int.from_bytes(head[pos:pos + 4], "big")
            if size < 8:
                return
            yield head[pos + 4:pos + 8], pos + 8, min(pos + size, end)
            pos += size

    def find(start, end, name, fullbox=False):
        for typ, s, e in boxes(start, end):
            if typ == name:
                return (s + 4 if fullbox else s), e  # FullBox: skip version/flags
        return None

    span = find(0, len(head), b"meta", fullbox=True)
    if span:
        span = find(span[0], span[1], b"iprp")
    if span:
        span = find(span[0], span[1], b"ipco")
    if span:
        for typ, s, e in boxes(span[0], span[1]):
            if typ == b"ispe" and e - s >= 12:
                return (int.from_bytes(head[s + 4:s + 8], "big"),
                        int.from_bytes(head[s + 8:s + 12], "big"))
    return None


def _image_dims(path):
    """Best-effort (width, height) from png/gif/webp/avif headers, else None."""
    try:
        with open(path, "rb") as f:
            head = f.read(4096)
    except OSError:
        return None
    try:
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return (int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big"))
        if head[:4] == b"GIF8":
            return (int.from_bytes(head[6:8], "little"), int.from_bytes(head[8:10], "little"))
        if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            chunk = head[12:16]
            if chunk == b"VP8X":
                return (int.from_bytes(head[24:27], "little") + 1,
                        int.from_bytes(head[27:30], "little") + 1)
            if chunk == b"VP8 ":
                return (int.from_bytes(head[26:28], "little") & 0x3FFF,
                        int.from_bytes(head[28:30], "little") & 0x3FFF)
            if chunk == b"VP8L":
                bits = int.from_bytes(head[21:25], "little")
                return ((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        if head[4:8] == b"ftyp":
            return _avif_dims(head)
    except (IndexError, ValueError):
        pass
    return None


def sync_emotes(library):
    with library._lock:
        library._rescan()
        jsons = sorted({v["json"] for v in library._vods.values()})
    ids = []
    for j in jsons:
        sid = (read_head_meta(j).get("streamer") or {}).get("id")
        if isinstance(sid, int) and sid not in ids:
            ids.append(sid)
    print("streamers found in library: %s" % (", ".join(str(i) for i in ids) or "none"))

    failures = 0

    def fetch(label, fn):
        nonlocal failures
        try:
            recs = fn()
        except urllib.error.HTTPError as e:
            if e.code == 404:  # streamer not on this service — normal, not an error
                print("  %-24s none (404)" % label)
                return []
            print("  %-24s FAILED (%s)" % (label, e))
            failures += 1
            return []
        except Exception as e:
            print("  %-24s FAILED (%s)" % (label, e))
            failures += 1
            return []
        print("  %-24s %d emotes" % (label, len(recs)))
        return recs

    # Precedence: channel over global, 7TV over BTTV — first name wins.
    tiers = []
    for sid in ids:
        tiers.append(fetch("7TV channel %d" % sid, lambda sid=sid: _seventv_records(
            ((_http_json("https://7tv.io/v3/users/twitch/%d" % sid) or {}).get("emote_set") or {}).get("emotes"))))
    for sid in ids:
        tiers.append(fetch("BTTV channel %d" % sid, lambda sid=sid: (lambda d: _bttv_records(
            (d.get("channelEmotes") or []) + (d.get("sharedEmotes") or [])))(
            _http_json("https://api.betterttv.net/3/cached/users/twitch/%d" % sid) or {})))
    tiers.append(fetch("7TV global", lambda: _seventv_records(
        (_http_json("https://7tv.io/v3/emote-sets/global") or {}).get("emotes"))))
    tiers.append(fetch("BTTV global", lambda: _bttv_records(
        _http_json("https://api.betterttv.net/3/cached/emotes/global"))))

    if failures >= len(tiers):
        print("error: every emote source failed — is the network up? Nothing was changed.")
        return 1

    chosen = {}
    for recs in tiers:
        for name, rec in recs:
            if name not in chosen:
                chosen[name] = rec

    os.makedirs(EMOTE_DIR, exist_ok=True)
    manifest = {}
    downloaded = cached = errors = 0
    for name in sorted(chosen):
        rec = chosen[name]
        fname = None
        for url, ext in rec["urls"]:
            cand = _emote_filename(name, ext)
            dest = os.path.join(EMOTE_DIR, cand)
            try:
                if os.path.isfile(dest) and os.path.getsize(dest) > 0:
                    cached += 1
                    fname = cand
                    break
            except OSError:
                pass
            try:
                data = _http_bytes(url)
            except Exception:
                continue  # try the next candidate URL
            tmp = "%s.%d.tmp" % (dest, os.getpid())
            try:
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, dest)
            except OSError:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                continue
            downloaded += 1
            fname = cand
            break
        if fname is None:
            errors += 1
            continue
        w, h = rec.get("w") or 0, rec.get("h") or 0
        if not (w and h):
            dims = _image_dims(os.path.join(EMOTE_DIR, fname))
            w, h = dims if dims else (56, 56)
        manifest[name] = {"file": fname, "w": w, "h": h,
                          "scale": rec.get("scale") or 2, "zw": bool(rec.get("zw"))}
        if (downloaded + cached) % 50 == 0:
            print("  … %d downloaded, %d already cached" % (downloaded, cached))

    # Hand-dropped files (e.g. a manually saved emote): stem = emote name,
    # downloads win on collision, scale guessed from pixel height.
    claimed = {m["file"] for m in manifest.values()}
    hand = 0
    for entry in sorted(os.scandir(EMOTE_DIR), key=lambda e: e.name):
        stem, ext = os.path.splitext(entry.name)
        if (not entry.is_file() or entry.name in claimed or not stem
                or stem in manifest or entry.name.startswith(".")
                or ext.lower() not in (".avif", ".webp", ".gif", ".png", ".jpg", ".jpeg")):
            continue
        w, h = _image_dims(entry.path) or (56, 56)
        manifest[stem] = {"file": entry.name, "w": w, "h": h,
                          "scale": 2 if h >= 56 else 1, "zw": False}
        hand += 1

    mpath = os.path.join(EMOTE_DIR, "manifest.json")
    tmp = "%s.%d.tmp" % (mpath, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "emotes": manifest}, f)
    os.replace(tmp, mpath)
    print("synced %d emotes (%d downloaded, %d already cached, %d hand-added, %d failed) -> %s"
          % (len(manifest), downloaded, cached, hand, errors, mpath))
    return 0


def main():
    ap = argparse.ArgumentParser(description="TwitchSync — local Twitch VOD player with synced chat")
    ap.add_argument("--dir", default=None,
                    help="the always-present library folder (default: this script's folder)")
    ap.add_argument("--port", type=int, default=8710)
    ap.add_argument("--no-open", action="store_true", help="don't open the browser automatically")
    ap.add_argument("--sync-emotes", action="store_true",
                    help="download BTTV/7TV emotes for the library's streamers into emote-cache/ and exit")
    args = ap.parse_args()

    root = os.path.realpath(args.dir or APP_DIR)
    if not os.path.isdir(root):
        sys.exit("error: not a directory: %s" % root)

    if args.sync_emotes:
        sys.exit(sync_emotes(Library(root)))

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
