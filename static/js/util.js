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
