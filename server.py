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
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request  # only used by the explicit --sync-emotes CLI mode
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
CONFIG_PATH = os.path.join(APP_DIR, "folders.json")
CHUNK = 1024 * 1024  # 1 MiB streaming chunk

APP_VERSION = "1.1"  # bump by hand when features land


def _build_mtime():
    """Newest mtime across server.py and static/ — the 'build date' shown in
    the UI. Computed once at startup, so it describes the running server."""
    paths = [os.path.abspath(__file__)]
    for dirpath, dirnames, filenames in os.walk(STATIC_DIR):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        paths += [os.path.join(dirpath, n) for n in filenames if not n.startswith(".")]
    stamps = []
    for p in paths:
        try:
            stamps.append(os.stat(p).st_mtime)
        except OSError:
            pass
    return max(stamps, default=time.time())


BUILD_MTIME = _build_mtime()

MAX_DEPTH = 4  # how far to recurse into a library folder
# NAS/system directories that never hold VODs and are slow or wrong to walk.
SKIP_DIRS = {"@eaDir", "#recycle", "#snapshot", "node_modules", "__pycache__"}
# VOD filenames start with a bracketed stream date — "[M-D-YY] streamer - title",
# optionally "[..]-N" for the Nth stream that day. Mirrors STEM_DATE_RE in
# static/js/util.js. Used to tell genuinely orphaned VOD halves apart from
# stray non-VOD files (folders.json, chat-check.json, random downloads...).
STEM_DATE_RE = re.compile(r"^\[(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})\](?:-(\d{1,3}))?")
MAX_BODY = 64 * 1024
THUMB_MAX_BODY = 512 * 1024  # a 320x180 JPEG is ~20 KB; generous headroom

THUMB_DIR = os.path.join(APP_DIR, "thumb-cache")
EMOTE_DIR = os.path.join(APP_DIR, "emote-cache")
THUMB_TIMEOUT = 30  # ffmpeg wall-clock cap per thumbnail (seconds)
THUMB_GEN_CONCURRENCY = 2  # concurrent ffmpeg runs; the NAS is the bottleneck

CHAT_CHECK_PATH = os.path.join(APP_DIR, "chat-check.json")
CHAT_CHECK_CONCURRENCY = 2  # same reasoning as THUMB_GEN_CONCURRENCY
# Primary signal: the chat JSON's own declared video length vs the mp4's real
# duration. Measured over the whole library, correct pairs land within
# -1.6..+1.0 s (`length` is just the real duration truncated to whole seconds),
# so 30 s is ~30x headroom and flags only genuinely wrong/partial pairings.
CHAT_LENGTH_TOLERANCE = 30.0
# Secondary signal: video running on past the last chat message. ONE-SIDED on
# purpose — chat routinely keeps talking after the stream ends (measured up to
# 79 s past), which is why the symmetric version of this test misfires. The
# worst legitimate overrun in the other direction is +21 s, so 120 s is ~5.7x
# headroom and catches only a genuinely truncated comment list.
CHAT_TRUNCATED_TOLERANCE = 120.0
CHAT_SCAN_WINDOW = 128 * 1024  # probe window; ~19x the measured 6,885-byte max key gap
CHAT_SCAN_WALK_LIMIT = 8  # forward-confirmation windows before giving up on the marker

MUTE_SCAN_PATH = os.path.join(APP_DIR, "mute-scan.json")
# Twitch mutes copyrighted-audio stretches to digital silence, so a strict
# noise floor separates them cleanly from merely-quiet audio (mic hiss sits
# well above -70 dB).
MUTE_NOISE = "-70dB"
MUTE_MIN_SILENCE = 120  # seconds — only mark muted stretches longer than 2 min
# The scan reads the whole file once (audio-only decode; NAS I/O is the
# bottleneck). Timeout scales with size, assuming at least ~8 MB/s off the share.
MUTE_TIMEOUT_FLOOR = 900.0
MUTE_TIMEOUT_PER_BYTE = 1.0 / (8 * 1024 * 1024)

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

CHAT_KEY = b'"content_offset_seconds":'
CHAT_EMB = b'"embeddedData"'
CHAT_VAL_RE = re.compile(re.escape(CHAT_KEY) + rb"\s*(-?[0-9]+(?:\.[0-9]+)?)")


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


def last_comment_offset(json_path):
    """Offset (seconds) of the last chat message, or None.

    Reading the tail is useless here: TwitchDownloader writes
    `... comments, embeddedData`, and the base64 emote blob is 54-92% of the
    file, so the last message can sit 90+ MB from EOF. Instead binary-search
    the comments/embeddedData boundary. `"content_offset_seconds":` is dense
    inside comments (measured max gap 6,885 bytes, avg ~755) and appears zero
    times inside embeddedData, so "does the window at p contain the key" is a
    monotone predicate — true up to the last message, false after it. ~11
    probes of 128 KB instead of reading tens of MB per file, which matters on
    a NAS that is simultaneously receiving downloads."""
    try:
        with open(json_path, "rb") as f:
            size = os.fstat(f.fileno()).st_size

            def read(p):
                f.seek(p)
                # The pad keeps a numeric literal whole when its key lands at
                # the very end of a window.
                return f.read(CHAT_SCAN_WINDOW + 64)

            def hit(p):
                return p < size and CHAT_KEY in read(p)

            # A header with a huge video.chapters array can push the first
            # comment past the opening window, so probe a few before giving up.
            lo = None
            for i in range(4):
                p = i * CHAT_SCAN_WINDOW
                if hit(p):
                    lo = p
                    break
            if lo is None:
                return None  # no comments we can find — never a flag, just unknown

            # Invariant: hit(lo) is true, hit(hi) is false (hi == size reads empty).
            hi = size
            while hi - lo > CHAT_SCAN_WINDOW:
                mid = (lo + hi) // 2
                if hit(mid):
                    lo = mid
                else:
                    hi = mid

            buf = read(lo)
            matches = list(CHAT_VAL_RE.finditer(buf))
            if not matches:
                return None
            value = float(matches[-1].group(1))

            # Confirm the comments array really ended here rather than trusting
            # the gap bound: embeddedData after the last match is proof. If it
            # isn't in this window, walk forward a bounded distance — this caps
            # any gap-assumption failure at ~1 MB instead of silently reporting
            # an early message as the last one.
            if buf.find(CHAT_EMB, matches[-1].end()) >= 0:
                return value
            p = lo + len(buf)
            for _ in range(CHAT_SCAN_WALK_LIMIT):
                if p >= size:
                    break
                chunk = read(p)
                if not chunk:
                    break
                more = list(CHAT_VAL_RE.finditer(chunk))
                if more:
                    value = float(more[-1].group(1))
                    if chunk.find(CHAT_EMB, more[-1].end()) >= 0:
                        break
                elif CHAT_EMB in chunk:
                    break
                p += len(chunk)
            return value
    except (OSError, ValueError):
        return None


def _fmt_hms(sec):
    """H:MM:SS, matching fmtTime in static/js/util.js so CLI output and UI
    tooltips read the same way."""
    if not isinstance(sec, (int, float)) or sec < 0:
        sec = 0
    sec = int(sec)
    return "%d:%02d:%02d" % (sec // 3600, (sec % 3600) // 60, sec % 60)


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


# ---- server-side thumbnail generation ---------------------------------------
# Preferred over the in-browser capture: every <video> element the browser
# creates — even muted — opens a CoreAudio output stream on macOS, and that
# device toggle is an audible pop per thumbnail. ffmpeg reads the file directly
# and never touches an audio device. ffmpeg is optional: without it the client
# falls back to in-browser capture (POST /thumb).


def _find_tool(name):
    if os.environ.get("TWITCHSYNC_NO_FFMPEG"):  # force the fallback, for testing
        return None
    found = shutil.which(name)
    if found:
        return found
    # A server launched outside a login shell may not have Homebrew on PATH.
    cand = os.path.join("/opt/homebrew/bin", name)
    return cand if os.access(cand, os.X_OK) else None


FFMPEG = _find_tool("ffmpeg")
FFPROBE = _find_tool("ffprobe")

_thumb_sem = threading.BoundedSemaphore(THUMB_GEN_CONCURRENCY)
_thumb_inflight = {}  # dest path -> Event; concurrent requests share one run
_thumb_inflight_lock = threading.Lock()


def probe_duration(mp4_path):
    """Duration in seconds via ffprobe, for VODs whose chat JSON lacks one."""
    if FFPROBE is None:
        return None
    try:
        proc = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", mp4_path],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        if proc.returncode != 0:
            return None
        return float(proc.stdout.decode("ascii", errors="replace").strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def evaluate_pair(mp4_path, json_path, chat_length):
    """Does this chat JSON actually belong to this mp4? Returns
    (verdict, code, message, detail) with verdict in ok/flag/unknown.

    Two signals. The primary one compares the JSON's own declared video length
    against the mp4's real duration — that is the wrong/partial-pairing test,
    and it costs nothing extra because the length already comes from the head
    read. The secondary one catches a JSON whose metadata is right but whose
    comment list was cut short."""
    video_sec = probe_duration(mp4_path)
    if video_sec is None:
        # Mid-copy file (no moov atom yet) or unreadable — never a flag.
        return "unknown", "probe-failed", "Could not read the video's duration.", {}
    if not isinstance(chat_length, (int, float)):
        return "unknown", "no-length", "The chat JSON declares no video length.", {
            "videoSec": video_sec}

    detail = {"videoSec": video_sec, "chatSec": chat_length}
    if abs(video_sec - chat_length) > CHAT_LENGTH_TOLERANCE:
        return "flag", "pairing", (
            "Chat JSON covers %s but the video runs %s — this chat file probably "
            "belongs to a different or partial download."
            % (_fmt_hms(chat_length), _fmt_hms(video_sec))), detail

    last = last_comment_offset(json_path)
    if last is None:
        return "unknown", "no-comments", "Could not read any chat messages.", detail
    detail["lastCommentSec"] = last
    # One-sided: chat outliving the video is routine and must never flag.
    if video_sec - last > CHAT_TRUNCATED_TOLERANCE:
        return "flag", "truncated", (
            "Chat stops %s before the video ends (last message at %s of %s) — "
            "the comment list looks truncated."
            % (_fmt_hms(video_sec - last), _fmt_hms(last), _fmt_hms(video_sec))), detail

    return "ok", "", "", detail


def generate_thumb(mp4_path, dest, duration_sec):
    """Extract a midpoint frame, letterboxed to 320x180 like the in-browser
    capture. True iff dest exists afterwards. A file still copying to the NAS
    (moov atom missing) fails fast; once it finishes growing it gets a new
    cache key and with it a natural retry."""
    if not isinstance(duration_sec, (int, float)) or duration_sec <= 0:
        duration_sec = probe_duration(mp4_path)
    seek = max(0.1, duration_sec / 2) if duration_sec else 0.0
    tmp = "%s.%d.%d.tmp" % (dest, os.getpid(), threading.get_ident())
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin",
           "-ss", "%.3f" % seek, "-i", mp4_path, "-frames:v", "1",
           "-vf", "scale=320:180:force_original_aspect_ratio=decrease,"
                  "pad=320:180:(ow-iw)/2:(oh-ih)/2:black",
           "-q:v", "4", "-f", "mjpeg", "-y", tmp]
    try:
        os.makedirs(THUMB_DIR, exist_ok=True)
        proc = subprocess.run(cmd, stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=THUMB_TIMEOUT)
        ok = proc.returncode == 0
        if ok:
            with open(tmp, "rb") as f:
                ok = f.read(3) == b"\xff\xd8\xff"  # same sanity check as _post_thumb
        if ok:
            os.replace(tmp, dest)
            return True
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        os.unlink(tmp)
    except OSError:
        pass
    return False


def ensure_thumb(mp4_path, dest, duration_sec):
    """Generate dest if missing. Bounded concurrency; requests for the same
    file wait on the first one instead of spawning a second ffmpeg."""
    if os.path.isfile(dest):
        return True
    if FFMPEG is None:
        return False
    with _thumb_inflight_lock:
        waiter = _thumb_inflight.get(dest)
        if waiter is None:
            _thumb_inflight[dest] = done = threading.Event()
    if waiter is not None:
        waiter.wait(THUMB_TIMEOUT + 15)
        return os.path.isfile(dest)
    try:
        with _thumb_sem:
            if not os.path.isfile(dest):
                generate_thumb(mp4_path, dest, duration_sec)
    finally:
        with _thumb_inflight_lock:
            del _thumb_inflight[dest]
        done.set()
    return os.path.isfile(dest)


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
        self._orphans = {}  # date-stamped mp4/json files missing their other half
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
        return self.list_and_orphans()[0]

    def list_and_orphans(self):
        """VOD entries plus orphan entries from one scan/lock, so the two
        halves of /api/videos can never disagree about the same walk."""
        with self._lock:
            self._rescan()
            entries = [self._entry(vid) for vid in self._vods]
            orphans = [self._orphan_entry(rec) for rec in self._orphans.values()]
        entries.sort(key=lambda v: v["mtime"], reverse=True)
        orphans.sort(key=lambda v: v["mtime"], reverse=True)
        return entries, orphans

    def orphans(self):
        """Current orphan entries without forcing a rescan (banner use, right
        after folders() has already scanned)."""
        with self._lock:
            orphans = [self._orphan_entry(rec) for rec in self._orphans.values()]
        orphans.sort(key=lambda v: v["mtime"], reverse=True)
        return orphans

    @staticmethod
    def _orphan_entry(rec):
        # Public shape — like _entry, no absolute path ever leaves the server.
        return {
            "id": rec["id"],
            "kind": rec["kind"],
            "name": rec["name"],
            "stem": rec["stem"],
            "sizeBytes": rec["size"],
            "mtime": rec["mtime"],
            "rootId": rec["rootId"],
            "rootLabel": rec["rootLabel"],
            "folder": rec["folder"],
        }

    def _find(self, vid):
        """Look up a VOD id (caller holds the lock), rescanning once on a miss.
        Bookmarks made before multi-folder support carried the bare stem."""
        vod = self._vods.get(vid)
        if vod is None:
            self._rescan()
            vod = self._vods.get(vid)
        if vod is None:
            for v in self._vods.values():
                if v["stem"] == vid:
                    return v
        return vod

    @staticmethod
    def _checked_path(path, roots):
        """A path is served only while it still resolves inside a library root."""
        real = os.path.realpath(path)
        if not any(real == r or real.startswith(r + os.sep) for r in roots):
            return None
        if not os.path.isfile(real):
            return None
        return real

    def _lookup(self, vid):
        """(vod, orphan) for an id — caller holds the lock. Orphans are checked
        first because a hit there is a plain dict lookup, while _find rescans
        the whole library on a miss — orphan ids are never in _vods, so going
        through _find first would mean one full walk per range request while
        scrubbing an orphan mp4."""
        rec = self._orphans.get(vid)
        if rec is not None:
            return None, rec
        vod = self._find(vid)  # rescans once on a miss (refreshes orphans too)
        if vod is not None:
            return vod, None
        return None, self._orphans.get(vid)

    def resolve(self, vid, kind):
        """Return the on-disk path for a VOD id's 'mp4' or 'json', or None.
        Orphan ids resolve their one existing half (so /media and /thumb work
        for a playable orphan mp4); asking an orphan for its missing half is a
        kind mismatch and stays a 404."""
        with self._lock:
            vod, rec = self._lookup(vid)
            if vod is not None:
                path = vod[kind]
            elif rec is not None and rec["kind"] == kind:
                path = rec["path"]
            else:
                return None
            roots = [r["path"] for r in self._root_records()]
        return self._checked_path(path, roots)

    def thumb_source(self, vid):
        """Everything thumbnail generation needs for a VOD id in one locked
        lookup: (mp4 path, durationSec-or-None), or (None, None). Orphan mp4s
        (no metadata) resolve with an unknown duration — generate_thumb probes
        it itself."""
        with self._lock:
            vod, rec = self._lookup(vid)
            if vod is not None:
                path, meta = vod["mp4"], self._meta(vod)
            elif rec is not None and rec["kind"] == "mp4":
                path, meta = rec["path"], None
            else:
                return None, None
            roots = [r["path"] for r in self._root_records()]
        mp4 = self._checked_path(path, roots)
        if mp4 is None:
            return None, None
        length = (meta.get("video") or {}).get("length") if meta else None
        return mp4, length if isinstance(length, (int, float)) else None

    def _rescan(self):
        vods = {}
        orphans = {}
        for root in self._root_records():
            if not root["online"]:
                continue
            found, stray = self._scan_root(root)
            for rec in found:
                vods[rec["id"]] = rec
            for rec in stray:
                orphans[rec["id"]] = rec
        self._vods = vods
        self._orphans = orphans

    def _scan_root(self, root):
        base = root["path"]
        found = []
        orphans = []
        for dirpath, dirnames, filenames in os.walk(base, onerror=lambda e: None):
            rel_dir = os.path.relpath(dirpath, base)
            depth = 0 if rel_dir == "." else rel_dir.count(os.sep) + 1
            if depth >= MAX_DEPTH:
                dirnames[:] = []
            else:
                dirnames[:] = [d for d in dirnames
                               if d not in SKIP_DIRS and not d.startswith(".")]
            by_lower = {n.lower(): n for n in filenames}
            folder = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")

            def orphan_rec(name, stem, kind):
                # "orphan:" can't collide with real ids ("<rootId>:<relstem>"),
                # and keeping the extension in the id makes it self-describing.
                path = os.path.join(dirpath, name)
                try:
                    st = os.stat(path)
                except OSError:
                    return None
                rel = os.path.relpath(path, base).replace(os.sep, "/")
                return {
                    "id": "orphan:%s:%s" % (root["id"], rel),
                    "kind": kind,
                    "name": name,
                    "stem": stem,
                    "path": path,
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "rootId": root["id"],
                    "rootLabel": root["label"],
                    "folder": folder,
                }

            for name in filenames:
                low = name.lower()
                if " - chat" in low:
                    continue  # TwitchDownloader chat renders pair with nothing
                if low.endswith(".mp4"):
                    stem = name[:-4]
                    jname = by_lower.get((stem + ".json").lower())
                    if jname is None:
                        # No sibling chat JSON. A date-stamped stem is a real
                        # VOD missing its other half — surface it instead of
                        # silently skipping; anything else stays ignored.
                        if STEM_DATE_RE.match(stem):
                            rec = orphan_rec(name, stem, "mp4")
                            if rec is not None:
                                orphans.append(rec)
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
                        "folder": folder,
                    })
                elif low.endswith(".json"):
                    # Mirror of the pairing rule: a date-stamped chat JSON with
                    # no same-stem mp4 sibling is the other orphan case.
                    stem = name[:-5]
                    if not STEM_DATE_RE.match(stem):
                        continue  # folders.json, chat-check.json, stray configs
                    if by_lower.get((stem + ".mp4").lower()) is None:
                        rec = orphan_rec(name, stem, "json")
                        if rec is not None:
                            orphans.append(rec)
        return found, orphans

    def _meta(self, vod):
        """Chat-JSON head metadata (caller holds the lock), cached on the
        JSON's (size, mtime)."""
        stamp = (vod["jsize"], vod["jmtime"])
        cached = self._meta_cache.get(vod["json"])
        if cached and cached[0] == stamp:
            return cached[1]
        meta = read_head_meta(vod["json"])
        self._meta_cache[vod["json"]] = (stamp, meta)
        return meta

    def _entry(self, vid):
        vod = self._vods[vid]
        meta = self._meta(vod)
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


class ChatCheck:
    """Verifies that each VOD's chat JSON actually belongs to its mp4.

    Same filename does not mean same stream: a partial or mis-filed download
    leaves an mp4 paired with a chat file covering a different (usually
    shorter) stream, and nothing else in the app would ever notice.

    A cold pass costs ~45 s for a full library, so it runs in a background
    thread and caches verdicts on disk keyed to both files' (size, mtime).
    Subsequent runs only re-check what actually changed."""

    def __init__(self, path=CHAT_CHECK_PATH):
        self._lock = threading.Lock()
        self._path = path
        # Keyed on the absolute mp4 path (like thumb_path/_meta_cache), so a
        # folder removed and re-added under a new root record keeps its results.
        self._cache = self._load()
        self._flagged = {}  # vod id -> record; what the client joins against
        self._checking = False
        self._done = 0
        self._total = 0

    # --- persistence --------------------------------------------------------

    def _load(self):
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return {}  # missing or corrupt — degrade to "nothing checked yet"
        if not isinstance(data, dict) or data.get("version") != 1:
            return {}
        results = data.get("results")
        return results if isinstance(results, dict) else {}

    def _save(self):
        # A concurrent `--check-chat` run writes the same file; both writes are
        # atomic so it can never tear, and the loser's results are simply
        # re-derived from the stamps next run. Not worth a lock file.
        tmp = self._path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"version": 1, "results": self._cache}, f)
            os.replace(tmp, self._path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    @staticmethod
    def _stamp(vod):
        # json.load gives lists back, so the cached stamp must be compared as
        # one or the cache silently never hits.
        return [vod["size"], vod["mtime"], vod["jsize"], vod["jmtime"]]

    @staticmethod
    def _stamp_now(mp4_path, json_path):
        try:
            st, jst = os.stat(mp4_path), os.stat(json_path)
        except OSError:
            return None
        return [st.st_size, st.st_mtime, jst.st_size, jst.st_mtime]

    # --- the pass -----------------------------------------------------------

    def run_pass(self, library, refresh=False, log=None):
        """Check every VOD. Returns (checked, flagged, unknown, cached)."""
        with library._lock:
            library._rescan()
            vods = sorted(library._vods.values(), key=lambda v: v["mp4"])
            # Pull the declared length from the existing head-meta cache while
            # we hold the lock; no extra NAS reads.
            lengths = {v["mp4"]: (library._meta(v).get("video") or {}).get("length")
                       for v in vods}
            online = [r["path"] for r in library._root_records() if r["online"]]

        work, flagged, unknown, cached = [], {}, 0, 0
        for vod in vods:
            rec = None if refresh else self._cache.get(vod["mp4"])
            if rec and rec.get("stamp") == self._stamp(vod):
                cached += 1
                if rec.get("verdict") == "flag":
                    flagged[vod["id"]] = rec
                if log:
                    log("  %-7s %s" % (rec.get("verdict", "?"), vod["stem"]))
            else:
                work.append(vod)

        with self._lock:
            self._checking = True
            self._done = len(vods) - len(work)
            self._total = len(vods)

        jobs = queue.Queue()
        for vod in work:
            jobs.put(vod)
        results = {}
        results_lock = threading.Lock()

        def worker():
            while True:
                try:
                    vod = jobs.get_nowait()
                except queue.Empty:
                    return
                try:
                    verdict, code, message, detail = evaluate_pair(
                        vod["mp4"], vod["json"], lengths.get(vod["mp4"]))
                    # The verdict was computed tens of seconds after the
                    # snapshot on a share that is actively downloading — if
                    # either file moved under us, don't trust or cache it.
                    if self._stamp_now(vod["mp4"], vod["json"]) != self._stamp(vod):
                        verdict, code, message = "unknown", "changed", \
                            "The files changed while being checked."
                    with results_lock:
                        results[vod["mp4"]] = (vod, verdict, code, message, detail)
                except Exception:
                    with results_lock:
                        results[vod["mp4"]] = (vod, "unknown", "error",
                                               "The check failed unexpectedly.", {})
                finally:
                    with self._lock:
                        self._done += 1

        threads = [threading.Thread(target=worker, daemon=True)
                   for _ in range(min(CHAT_CHECK_CONCURRENCY, max(1, len(work))))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        for vod in work:
            got = results.get(vod["mp4"])
            if got is None:
                continue
            _, verdict, code, message, detail = got
            if verdict == "unknown":
                # Never persisted: a stamp that happens to repeat would
                # otherwise pin "unknown" forever with no way to retry.
                unknown += 1
                self._cache.pop(vod["mp4"], None)
                if log:
                    log("  unknown %s (%s)" % (vod["stem"], code))
                continue
            rec = {"stamp": self._stamp(vod), "verdict": verdict, "code": code,
                   "message": message}
            rec.update(detail)
            self._cache[vod["mp4"]] = rec
            if verdict == "flag":
                flagged[vod["id"]] = rec
                if log:
                    log("  CHECK   %s — %s" % (vod["stem"], message))
            elif log:
                log("  ok      %s" % vod["stem"])

        # Prune only under roots that are actually mounted: an unmounted NAS
        # scans to nothing, and an unguarded prune would discard every verdict.
        live = {v["mp4"] for v in vods}
        for path in list(self._cache):
            if path in live:
                continue
            if any(path == r or path.startswith(r + os.sep) for r in online):
                del self._cache[path]

        self._save()
        with self._lock:
            self._flagged = flagged
            self._checking = False
        return len(vods), len(flagged), unknown, cached

    def snapshot(self):
        """One consistent read for both endpoints, so a page load landing
        mid-pass can't see a half-updated state."""
        with self._lock:
            return {"checking": self._checking, "done": self._done,
                    "total": self._total, "flagged": dict(self._flagged)}


# ---- muted-audio detection ---------------------------------------------------
# Twitch replaces copyright-muted stretches with digital silence, but nothing
# in the TwitchDownloader chat JSON records where — the only offline source is
# the audio itself.

_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?[0-9.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*(-?[0-9.]+)")
_FFMPEG_TIME_RE = re.compile(r"\btime=(\d+):(\d\d):(\d\d(?:\.\d+)?)")


def detect_muted_segments(mp4_path, size_bytes, duration_hint=None):
    """Muted stretches (>= MUTE_MIN_SILENCE s of digital silence) in an mp4's
    audio, via one sequential ffmpeg silencedetect read. Returns
    ([[start, end], ...] in seconds, ok). ok=False means the scan failed and
    nothing may be cached."""
    if FFMPEG is None:
        return [], False
    cmd = [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "info",
           "-i", mp4_path, "-vn", "-sn", "-dn",
           "-af", "silencedetect=noise=%s:d=%d" % (MUTE_NOISE, MUTE_MIN_SILENCE),
           "-f", "null", "-"]
    try:
        proc = subprocess.run(
            cmd, stdin=subprocess.DEVNULL, capture_output=True,
            timeout=MUTE_TIMEOUT_FLOOR + size_bytes * MUTE_TIMEOUT_PER_BYTE)
    except (OSError, subprocess.SubprocessError):
        return [], False
    if proc.returncode != 0:
        return [], False
    segments = []
    open_start = None
    processed = 0.0  # last progress "time=" seen — how far ffmpeg actually got
    # Progress lines are \r-separated, detection lines \n-separated.
    for line in re.split(r"[\r\n]", proc.stderr.decode("utf-8", errors="replace")):
        m = _SILENCE_START_RE.search(line)
        if m:
            open_start = max(0.0, float(m.group(1)))
            continue
        m = _SILENCE_END_RE.search(line)
        if m:
            if open_start is not None:
                end = float(m.group(1))
                if end > open_start:
                    segments.append([round(open_start, 2), round(end, 2)])
                open_start = None
            continue
        m = _FFMPEG_TIME_RE.search(line)
        if m:
            t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
            processed = max(processed, t)
    if open_start is not None:
        # File ends while muted, so silencedetect never printed the end. The
        # stretch is already >= MUTE_MIN_SILENCE by construction; close it at
        # the best known duration.
        end = max(processed, duration_hint or 0.0)
        if end > open_start:
            segments.append([round(open_start, 2), round(end, 2)])
    return segments, True


class MuteScan:
    """Finds the muted stretches of every VOD so the player can mark them.

    A scan is one full sequential read of the mp4 (minutes over SMB for a
    20 GB file), so results are cached permanently on the file's (size, mtime),
    a single background worker crawls the library one file at a time, and the
    VOD the user actually opens jumps the queue via /api/muted. The bulk crawl
    additionally waits for the (fast, moov-only) chat check to finish first so
    the two never compete for the NAS. Modeled on ChatCheck."""

    def __init__(self, path=MUTE_SCAN_PATH):
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._path = path
        self._cache = self._load()  # abs mp4 path -> {"stamp": [size, mtime], "segments": [...]}
        self._front = []      # bumped work items, served before the crawl
        self._crawl = []      # background sweep, newest VODs first
        self._inflight = None  # path being scanned right now
        self._failed = set()  # failed this run; the crawl won't retry, a bump will
        self._live = set()    # every mp4 seen by the seed scan (prune guard)
        self._gate = threading.Event()  # opened once the chat check is done

    def gate(self):
        """Open the crawl gate (chat check finished / never ran) and wake the
        worker promptly instead of on its next 5 s poll."""
        self._gate.set()
        with self._cond:
            self._cond.notify()

    def _load(self):
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict) or data.get("version") != 1:
            return {}
        results = data.get("results")
        return results if isinstance(results, dict) else {}

    def _save(self):
        tmp = self._path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"version": 1, "results": self._cache}, f)
            os.replace(tmp, self._path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    def query(self, library, vid):
        """Endpoint payload for one VOD id. A cache miss enqueues a priority
        scan, so requesting a pending VOD is what bumps it up the queue.
        Resolves orphan mp4 ids too — they have audio like any other VOD."""
        if FFMPEG is None:
            return {"status": "unavailable"}
        path = library.resolve(vid, "mp4")
        if path is None:
            return {"status": "unavailable"}
        try:
            st = os.stat(path)
        except OSError:
            return {"status": "unavailable"}
        stamp = [st.st_size, st.st_mtime]
        with self._cond:
            rec = self._cache.get(path)
            if rec and rec.get("stamp") == stamp:
                segs = rec.get("segments")
                return {"status": "ok", "segments": segs if isinstance(segs, list) else []}
            if path != self._inflight and not any(it["mp4"] == path for it in self._front):
                self._failed.discard(path)  # user asked again — retry a failure once
                self._front.append({"mp4": path, "stamp": stamp, "hint": None})
                self._cond.notify()
            return {"status": "pending"}

    def run(self, library):
        """Worker thread body. Bumps are served immediately at any time; the
        bulk crawl seeds and runs only after _gate opens, then prunes once."""
        seeded = pruned = False
        while True:
            item = None
            with self._cond:
                while item is None:
                    if self._front:
                        item = self._front.pop(0)
                    elif self._gate.is_set() and not seeded:
                        break  # seed the crawl outside the lock
                    elif self._crawl:
                        item = self._crawl.pop(0)
                    elif seeded and not pruned:
                        break  # crawl drained — prune once, outside the lock
                    else:
                        self._cond.wait(5.0)
                if item is not None:
                    self._inflight = item["mp4"]
            if item is None:
                if not seeded:
                    self._seed(library)
                    seeded = True
                else:
                    self._prune(library)
                    pruned = True
                continue
            try:
                self._scan_one(item)
            finally:
                with self._cond:
                    self._inflight = None

    def _seed(self, library):
        with library._lock:
            library._rescan()
            vods = sorted(library._vods.values(), key=lambda v: v["mtime"], reverse=True)
            # Declared lengths from the head-meta cache while we hold the lock;
            # they close a trailing-silence segment without an extra probe.
            lengths = {v["mp4"]: (library._meta(v).get("video") or {}).get("length")
                       for v in vods}
        items, live = [], set()
        with self._cond:
            for v in vods:
                path = v["mp4"]
                live.add(path)
                rec = self._cache.get(path)
                stamp = [v["size"], v["mtime"]]
                if rec and rec.get("stamp") == stamp:
                    continue
                if path == self._inflight or any(it["mp4"] == path for it in self._front):
                    continue
                length = lengths.get(path)
                items.append({"mp4": path, "stamp": stamp,
                              "hint": length if isinstance(length, (int, float)) else None})
            self._crawl = items
            self._live = live
        if items:
            print("mute scan: %d VOD(s) to scan in the background" % len(items), flush=True)

    def _scan_one(self, item):
        path = item["mp4"]
        with self._cond:
            rec = self._cache.get(path)
            if path in self._failed:
                return  # crawl copy of a bump that already failed this run
        try:
            st = os.stat(path)
        except OSError:
            return
        stamp = [st.st_size, st.st_mtime]
        if rec and rec.get("stamp") == stamp:
            return  # already scanned (a bump got to it ahead of its crawl slot)
        if stamp != item["stamp"]:
            return  # changed since snapshot (mid-copy) — a later query re-queues
        t0 = time.time()
        segments, ok = detect_muted_segments(path, st.st_size, item.get("hint"))
        try:
            st2 = os.stat(path)
            changed = [st2.st_size, st2.st_mtime] != stamp
        except OSError:
            changed = True
        if not ok or changed:
            # Never persisted (ChatCheck's rule): a failure must stay retriable.
            with self._cond:
                self._failed.add(path)
            print("mute scan: failed  %s" % os.path.basename(path), flush=True)
            return
        with self._cond:
            self._cache[path] = {"stamp": stamp, "segments": segments}
            # Saved per file, not per pass: each scan is minutes of NAS reads
            # and a crash must not throw completed ones away.
            self._save()
        print("mute scan: %s — %d muted stretch%s (%.1fs)"
              % (os.path.basename(path), len(segments),
                 "" if len(segments) == 1 else "es", time.time() - t0), flush=True)

    def _prune(self, library):
        """Drop cached results for files that no longer exist — but only under
        roots that are actually mounted, so an unmounted NAS keeps its results
        (same guard as ChatCheck)."""
        with library._lock:
            online = [r["path"] for r in library._root_records() if r["online"]]
        with self._cond:
            removed = False
            for path in list(self._cache):
                if path in self._live:
                    continue
                if any(path == r or path.startswith(r + os.sep) for r in online):
                    del self._cache[path]
                    removed = True
            if removed:
                self._save()


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
    server_version = "TwitchSync/" + APP_VERSION

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
            # thumbGen tells the client whether /thumb?gen=1 works or it must
            # fall back to in-browser capture.
            videos, orphans = self.server.library.list_and_orphans()
            return self._send_json({
                "videos": videos,
                "orphans": orphans,
                "thumbGen": FFMPEG is not None,
                "chatCheck": self.server.chatcheck.snapshot(),
                "version": APP_VERSION,
                "buildMtime": BUILD_MTIME,
            })
        if path == "/api/folders":
            return self._send_json({
                "folders": self.server.library.folders(),
                "volumes": list_volumes(),
            })
        if path == "/api/chat-check":
            # Polled while the startup pass is still running, so late results
            # reach a page that loaded before the pass finished.
            return self._send_json(self.server.chatcheck.snapshot())
        if path == "/api/muted":
            ids = query.get("v")
            if not ids:
                return self._json_error(400, "missing v parameter")
            return self._send_json(self.server.mutescan.query(self.server.library, ids[0]))
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
        # Two modes. Plain GET (the <img> src, versioned client-side with
        # &s=<size>): cache-only, answers instantly, long browser caching.
        # &gen=1 (driven by the client's 2-at-a-time queue): generate on miss —
        # may block this handler thread for the ffmpeg run — and answer
        # no-store, because that URL never varies and a browser-cached "hit"
        # would mask a wiped thumb-cache forever.
        ids = query.get("v")
        if not ids:
            return self._json_error(400, "missing v parameter")
        gen = (query.get("gen") or ["0"])[0] == "1"
        mp4, duration = self.server.library.thumb_source(ids[0])
        dest = thumb_path(mp4) if mp4 else None
        if dest is None:
            return self._json_error(404, "unknown video")
        if gen and not os.path.isfile(dest):
            ensure_thumb(mp4, dest, duration)
        if not os.path.isfile(dest):
            return self._json_error(404, "no thumbnail")
        cache = "no-store" if gen else "public, max-age=86400"
        self._send_file(dest, "image/jpeg", cache_control=cache)

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

EMOTE_HEADERS = {"User-Agent": "TwitchSync/" + APP_VERSION}

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


# ---- thumbnail sync (explicit CLI mode) -------------------------------------
# `python3 server.py --sync-thumbs` pre-generates every missing thumbnail with
# ffmpeg and prunes cache files whose VOD changed or vanished (the key embeds
# path+size, so a re-downloaded file strands its old thumb). The server also
# generates on demand — this just does the whole library up front.


def sync_thumbs(library):
    if FFMPEG is None:
        print("error: ffmpeg not found (brew install ffmpeg) — without it the "
              "app falls back to in-browser capture.")
        return 1
    with library._lock:
        library._rescan()
        vods = sorted(library._vods.values(), key=lambda v: v["mp4"])
        durations = {}
        for v in vods:
            length = (library._meta(v).get("video") or {}).get("length")
            durations[v["mp4"]] = length if isinstance(length, (int, float)) else None

    generated = cached = failed = 0
    valid = set()
    for v in vods:
        name = os.path.basename(v["mp4"])
        dest = thumb_path(v["mp4"])
        if dest is None:
            failed += 1
            print("  FAILED  %s (unreadable)" % name)
            continue
        valid.add(os.path.basename(dest))
        if os.path.isfile(dest):
            cached += 1
        elif generate_thumb(v["mp4"], dest, durations[v["mp4"]]):
            generated += 1
            print("  ok      %s" % name)
        else:
            failed += 1
            print("  FAILED  %s (still copying, or unreadable)" % name)

    pruned = 0
    now = time.time()
    try:
        entries = list(os.scandir(THUMB_DIR))
    except OSError:
        entries = []
    for e in entries:
        try:
            stale_jpg = e.name.endswith(".jpg") and e.name not in valid
            # Leftover .tmp from a crashed writer; live ones are seconds old.
            stale_tmp = e.name.endswith(".tmp") and now - e.stat().st_mtime > 3600
            if e.is_file() and (stale_jpg or stale_tmp):
                os.unlink(e.path)
                pruned += 1
        except OSError:
            pass
    print("synced %d thumbnails (%d generated, %d already cached, %d failed, %d pruned)"
          % (len(vods), generated, cached, failed, pruned))
    return 0


# ---- chat/VOD check (explicit CLI mode) --------------------------------------
# `python3 server.py --check-chat` re-verifies every pair from scratch and
# rewrites chat-check.json. The server runs the same pass in the background on
# every start; this is the "ignore the cache and tell me about all of them" mode.


def check_chat(library):
    if FFPROBE is None:
        print("error: ffprobe not found (brew install ffmpeg) — the chat check needs it.")
        return 1
    checked, flagged, unknown, _ = ChatCheck().run_pass(
        library, refresh=True, log=lambda line: print(line, flush=True))
    print("checked %d VODs (%d ok, %d need checking, %d unknown) -> %s"
          % (checked, checked - flagged - unknown, flagged, unknown, CHAT_CHECK_PATH))
    return 0  # flags are findings, not errors — only a missing ffprobe exits non-zero


def _chat_check_worker(httpd):
    start = time.time()
    try:
        checked, flagged, unknown, cached = httpd.chatcheck.run_pass(httpd.library)
    except Exception as e:  # a background crash must never take the server down
        print("chat check: failed (%s)" % e, flush=True)
        return
    finally:
        # However the pass ends, release the mute-scan crawl. (Bumped VODs —
        # the one the user is watching — never waited on this gate.)
        httpd.mutescan.gate()
    print("chat check: %d VODs, %d need checking, %d unknown (%d cached, %.1fs)"
          % (checked, flagged, unknown, cached, time.time() - start), flush=True)


def _mute_scan_worker(httpd):
    try:
        httpd.mutescan.run(httpd.library)
    except Exception as e:  # a background crash must never take the server down
        print("mute scan: worker crashed (%s)" % e, flush=True)


def main():
    ap = argparse.ArgumentParser(description="TwitchSync — local Twitch VOD player with synced chat")
    ap.add_argument("--dir", default=None,
                    help="the always-present library folder (default: this script's folder)")
    ap.add_argument("--port", type=int, default=8710)
    ap.add_argument("--no-open", action="store_true", help="don't open the browser automatically")
    ap.add_argument("--sync-emotes", action="store_true",
                    help="download BTTV/7TV emotes for the library's streamers into emote-cache/ and exit")
    ap.add_argument("--sync-thumbs", action="store_true",
                    help="generate any missing thumbnails into thumb-cache/ with ffmpeg and exit")
    ap.add_argument("--check-chat", action="store_true",
                    help="verify every VOD's chat JSON matches its mp4 and exit")
    args = ap.parse_args()

    root = os.path.realpath(args.dir or APP_DIR)
    if not os.path.isdir(root):
        sys.exit("error: not a directory: %s" % root)

    if args.sync_emotes:
        sys.exit(sync_emotes(Library(root)))
    if args.sync_thumbs:
        sys.exit(sync_thumbs(Library(root)))
    if args.check_chat:
        sys.exit(check_chat(Library(root)))

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as e:
        sys.exit("error: cannot bind 127.0.0.1:%d (%s) — already running? Try --port"
                 % (args.port, e.strerror))
    httpd.daemon_threads = True
    httpd.library = Library(root)
    httpd.chatcheck = ChatCheck()
    httpd.mutescan = MuteScan()

    url = "http://127.0.0.1:%d/" % args.port
    print("TwitchSync serving %s" % root, flush=True)
    for extra in httpd.library.folders()[1:]:
        print("  + %s%s" % (extra["path"], "" if extra["online"] else "  (offline)"), flush=True)
    # folders() above just scanned, so this is current. Orphans also appear at
    # the bottom of the library page — this is the "ran at startup" record.
    orphs = httpd.library.orphans()
    if orphs:
        print("  orphans: %d date-stamped file(s) missing their other half:" % len(orphs), flush=True)
        for o in orphs[:10]:
            where = " — %s%s" % (o["rootLabel"], "/" + o["folder"] if o["folder"] else "")
            print("    missing %-5s  %s%s"
                  % (".json" if o["kind"] == "mp4" else ".mp4", o["name"], where), flush=True)
        if len(orphs) > 10:
            print("    … and %d more" % (len(orphs) - 10), flush=True)
    print("  thumbnails: %s" % ("server-side via ffmpeg" if FFMPEG
                                else "in-browser capture (ffmpeg not found)"), flush=True)
    print("  chat check: %s" % ("running in the background" if FFPROBE
                                else "disabled (ffprobe not found)"), flush=True)
    print("  mute scan: %s" % ("running in the background" if FFMPEG
                               else "disabled (ffmpeg not found)"), flush=True)
    print("  -> %s  (Ctrl-C to stop)" % url, flush=True)
    if not args.no_open:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    # Without ffprobe there is no usable signal at all, so don't spend a pass
    # producing nothing but "unknown".
    if FFPROBE is not None:
        threading.Thread(target=_chat_check_worker, args=(httpd,), daemon=True).start()
    else:
        httpd.mutescan.gate()  # no chat check to wait for
    if FFMPEG is not None:
        threading.Thread(target=_mute_scan_worker, args=(httpd,), daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
