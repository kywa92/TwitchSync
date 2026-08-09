// Library thumbnails: capture a frame from the middle of each VOD in a hidden
// <video>, cache it server-side (POST /thumb), and paint it into the row's
// <img>. Generation is queued (2 at a time, first paint is one-time per file),
// paused while the player is open so playback owns the NAS bandwidth, and not
// retried within a session once a VOD has genuinely failed.

const CONCURRENCY = 2;
const JOB_TIMEOUT = 45000; // moov-at-EOF over SMB: metadata alone can take a while
const THUMB_W = 320, THUMB_H = 180;
const ABORTED = Symbol("aborted");

const pending = [];       // vods waiting for a generation slot
const queued = new Set(); // vod ids pending or in flight
const failed = new Set(); // vod ids that failed this session — don't retry
const imgs = new Map();   // vod id -> the <img> currently in the DOM
const aborts = new Set(); // abort fns for in-flight captures
let active = 0;
let paused = false;

// Called at the top of every renderLibrary: the old DOM is gone, so drop
// queued-but-unstarted jobs and stale img references. In-flight jobs keep
// running and resolve against the fresh map (or drop silently).
export function resetThumbs() {
  for (const v of pending) queued.delete(v.id);
  pending.length = 0;
  imgs.clear();
}

export function registerThumbImg(vod, img) {
  imgs.set(vod.id, img);
}

export function queueThumb(vod) {
  if (queued.has(vod.id) || failed.has(vod.id)) return;
  queued.add(vod.id);
  pending.push(vod);
  pump();
}

export function setThumbsPaused(p) {
  paused = p;
  if (p) {
    for (const abort of [...aborts]) abort(); // free NAS bandwidth immediately
  } else {
    pump();
  }
}

function pump() {
  while (!paused && active < CONCURRENCY && pending.length) {
    const vod = pending.shift();
    active++;
    run(vod).finally(() => { active--; pump(); });
  }
}

async function run(vod) {
  let outcome = "failed";
  try {
    const blob = await capture(vod);
    if (blob === ABORTED) { outcome = "aborted"; return; }
    if (!blob) return;
    // Cache server-side; a failure here is non-fatal (the thumb still shows
    // now and simply regenerates next session).
    fetch("/thumb?v=" + encodeURIComponent(vod.id), {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    }).catch(() => {});
    const img = imgs.get(vod.id);
    if (img && img.isConnected) {
      const url = URL.createObjectURL(blob);
      img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
      img.src = url; // the row's own load listener flips it to .ready
    }
    outcome = "ok";
  } finally {
    queued.delete(vod.id);
    if (outcome === "failed") failed.add(vod.id);
    // aborted: neither failed nor queued — the next library render re-queues it
  }
}

function capture(vod) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      aborts.delete(abort);
      v.removeAttribute("src");
      v.load(); // abort in-flight range requests
      resolve(result);
    };
    const abort = () => finish(ABORTED);
    const timer = setTimeout(() => finish(null), JOB_TIMEOUT);
    aborts.add(abort);

    v.addEventListener("error", () => finish(null));
    v.addEventListener("loadedmetadata", () => {
      const d = Number.isFinite(v.duration) ? v.duration : vod.durationSec;
      if (!Number.isFinite(d) || d <= 0) return finish(null);
      v.currentTime = Math.max(0.1, d / 2);
    });
    v.addEventListener("seeked", () => {
      const draw = () => {
        if (done) return;
        try {
          if (!v.videoWidth || !v.videoHeight) return finish(null);
          const c = document.createElement("canvas");
          c.width = THUMB_W;
          c.height = THUMB_H;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, THUMB_W, THUMB_H);
          const s = Math.min(THUMB_W / v.videoWidth, THUMB_H / v.videoHeight);
          const w = v.videoWidth * s, h = v.videoHeight * s;
          ctx.drawImage(v, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
          c.toBlob((blob) => finish(blob || null), "image/jpeg", 0.75);
        } catch {
          finish(null);
        }
      };
      // Draw only once a frame is actually presented; right at `seeked` some
      // browsers still hand back a blank canvas. rVFC is the reliable signal —
      // but it never fires for a detached (non-composited) video, so a timed
      // fallback races it; draw() is once-only via the `done` guard.
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => draw());
      setTimeout(draw, 350);
    });
    v.src = "/media?v=" + encodeURIComponent(vod.id);
  });
}
