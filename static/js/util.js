// Shared helpers.

export function fmtTime(sec, forceHours = false) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 || forceHours ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + " " + units[i];
}

export function fmtDate(epochSec) {
  if (!Number.isFinite(epochSec)) return "";
  return new Date(epochSec * 1000).toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric",
  });
}

// Twitch's default username palette and hash (first + last char code mod 15),
// so users who never picked a color are stable across sessions and match Twitch.
const TWITCH_COLORS = [
  "#FF0000", "#0000FF", "#00FF00", "#B22222", "#FF7F50",
  "#9ACD32", "#FF4500", "#2E8B57", "#DAA520", "#D2691E",
  "#5F9EA0", "#1E90FF", "#FF69B4", "#8A2BE2", "#00FF7F",
];
export function colorHash(login) {
  if (!login) return TWITCH_COLORS[0];
  const n = login.charCodeAt(0) + login.charCodeAt(login.length - 1);
  return TWITCH_COLORS[n % TWITCH_COLORS.length];
}

// Lift colors that are unreadably dark on the dark chat panel (Twitch does the
// same in dark mode). Blends toward white proportionally to how dark they are.
export function readableColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex;
  let r = parseInt(m[1].slice(0, 2), 16);
  let g = parseInt(m[1].slice(2, 4), 16);
  let b = parseInt(m[1].slice(4, 6), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b; // 0..255
  const MIN = 90;
  if (lum >= MIN) return "#" + m[1];
  const t = (MIN - lum) / MIN;
  const lift = (c) => Math.min(255, Math.round(c + (255 - c) * 0.55 * t));
  const hx = (c) => c.toString(16).padStart(2, "0");
  return "#" + hx(lift(r)) + hx(lift(g)) + hx(lift(b));
}

// VOD stems start with a bracketed stream date: "[M-D-YY] streamer - title",
// month first, not zero-padded, optionally "[..]-N" for the Nth stream that day.
const STEM_DATE_RE = /^\[(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})\](?:-(\d{1,3}))?/;

export function parseStemDate(stem) {
  const m = STEM_DATE_RE.exec(stem || "");
  if (!m) return null;
  let mo = parseInt(m[1], 10);
  let day = parseInt(m[2], 10);
  if (mo > 12 && day <= 12) [mo, day] = [day, mo]; // tolerate day-first names
  const year = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
  const dt = new Date(year, mo - 1, day);
  // Reject rollover ("[2-30-26]" must not become Mar 2 — fall back to mtime).
  if (dt.getFullYear() !== year || dt.getMonth() !== mo - 1 || dt.getDate() !== day) return null;
  return { t: dt.getTime(), seq: m[4] ? parseInt(m[4], 10) : 0 };
}

// The raw "[M-D-YY]" / "[M-D-YY]-N" prefix of a stem, or "" if it has none.
export function stemDatePrefix(stem) {
  const m = STEM_DATE_RE.exec(stem || "");
  return m ? m[0] : "";
}

// Stream date from the filename (mtime is only a download timestamp), falling
// back to mtime for stems without a parseable date prefix. Shared tiebreaker
// for every sort key.
function dateKey(v) {
  const p = parseStemDate(v.stem);
  return { t: p ? p.t : v.mtime * 1000, seq: p ? p.seq : 0 };
}

export const SORT_KEYS = ["date", "size", "duration", "streamer", "game"];
// Natural direction per key: newest/largest/longest first, names A→Z.
export const SORT_DEFAULT_DIR = {
  date: "desc", size: "desc", duration: "desc", streamer: "asc", game: "asc",
};

export function currentSortBy() {
  const v = lsGet("ts.sortBy");
  return SORT_KEYS.includes(v) ? v : "date";
}

// "asc" | "desc"; tolerates the legacy "new"/"old" values and falls back to
// the active key's natural direction when nothing is stored.
export function currentSortDir() {
  const v = lsGet("ts.sort");
  if (v === "old" || v === "asc") return "asc";
  if (v === "new" || v === "desc") return "desc";
  return SORT_DEFAULT_DIR[currentSortBy()];
}

export function sortVods(vods, dir = "desc", by = "date") {
  const d = dir === "new" ? "desc" : dir === "old" ? "asc" : dir;
  const sign = d === "asc" ? 1 : -1;
  const keyed = vods.map((v) => ({ v, k: dateKey(v) }));
  // Newest-first date order — the fixed tiebreaker for every non-date key, so
  // flipping e.g. the streamer direction never scrambles rows within a streamer.
  const newest = (a, b) =>
    (b.k.t - a.k.t) || (b.k.seq - a.k.seq) || (b.v.mtime - a.v.mtime) ||
    a.v.id.localeCompare(b.v.id);

  if (by === "size") {
    keyed.sort((a, b) => sign * (a.v.sizeBytes - b.v.sizeBytes) || newest(a, b));
  } else if (by === "duration") {
    // VODs with no known duration (unreadable metadata) go last in either
    // direction rather than masquerading as 0:00.
    const has = (x) => Number.isFinite(x.v.durationSec);
    keyed.sort((a, b) => {
      if (has(a) !== has(b)) return has(a) ? -1 : 1;
      return (has(a) ? sign * (a.v.durationSec - b.v.durationSec) : 0) || newest(a, b);
    });
  } else if (by === "streamer" || by === "game") {
    const name = (x) => (by === "streamer" ? x.v.streamer : x.v.game) || "";
    keyed.sort((a, b) => {
      const an = name(a), bn = name(b);
      if (!an !== !bn) return an ? -1 : 1; // unnamed always last
      return sign * an.toLowerCase().localeCompare(bn.toLowerCase()) || newest(a, b);
    });
  } else {
    // date: ascending (t, seq, mtime, id) fully reversed for newest-first —
    // byte-for-byte the pre-sort-keys behavior.
    keyed.sort((a, b) =>
      (a.k.t - b.k.t) || (a.k.seq - b.k.seq) || (a.v.mtime - b.v.mtime) ||
      a.v.id.localeCompare(b.v.id));
    if (d !== "asc") keyed.reverse();
  }
  return keyed.map((k) => k.v);
}

// Distinct streamer/game values across the library for the filter dropdowns,
// as [{name, count}] sorted by name. Games include every chapter's game, so a
// VOD that switches into a game mid-stream is findable under it even when it
// isn't the primary category.
export function distinctFilterValues(vods) {
  const streamers = new Map(), games = new Map(); // lowercase -> {name, count}
  const bump = (map, raw) => {
    if (typeof raw !== "string") return;
    const name = raw.trim();
    if (!name) return;
    const rec = map.get(name.toLowerCase());
    if (rec) rec.count++;
    else map.set(name.toLowerCase(), { name, count: 1 });
  };
  for (const v of vods) {
    bump(streamers, v.streamer);
    // A VOD counts once per game even when several chapters share it.
    const gset = new Map();
    const add = (raw) => {
      if (typeof raw === "string" && raw.trim()) gset.set(raw.trim().toLowerCase(), raw.trim());
    };
    add(v.game);
    for (const c of v.chapters || []) add(c && c.gameDisplayName);
    for (const name of gset.values()) bump(games, name);
  }
  const out = (m) => [...m.values()]
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { streamers: out(streamers), games: out(games) };
}

// sel = {streamers: Set, games: Set} of lowercased names; an empty set passes
// everything. A game selection matches the primary game or any chapter's game.
export function vodMatchesFilters(v, sel) {
  if (sel.streamers.size && !sel.streamers.has((v.streamer || "").toLowerCase())) return false;
  if (!sel.games.size) return true;
  if (sel.games.has((v.game || "").toLowerCase())) return true;
  return (v.chapters || []).some((c) =>
    c && typeof c.gameDisplayName === "string" && sel.games.has(c.gameDisplayName.trim().toLowerCase()));
}

// Stored filter selection for "streamers" | "games" (original casing).
export function readFilter(kind) {
  try {
    const arr = JSON.parse(lsGet("ts.filter." + kind) || "[]");
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// First index i with arr[i] > x (arr ascending).
export function upperBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function sniffImageMime(u8) {
  if (u8.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return "image/png";
  if (u8.length >= 4 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return "image/gif";
  if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return "image/webp";
  return "application/octet-stream";
}

export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// localStorage that never throws (private mode etc.).
export function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function lsSet(key, val) {
  try { localStorage.setItem(key, val); } catch { /* ignore */ }
}
export function lsDel(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
export function lsKeys(prefix) {
  try { return Object.keys(localStorage).filter((k) => k.startsWith(prefix)); } catch { return []; }
}
