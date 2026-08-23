// Video player: playback, custom control bar, seek bar with buffered ranges +
// chat-activity histogram, fullscreen, keyboard shortcuts, position memory.

import { fmtTime, el, lsGet, lsSet, lsDel } from "./util.js";

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const $ = (id) => document.getElementById(id);

// Automatic recovery from decode/network MediaErrors: reload the same src and
// resume, skipping progressively further past the failure point when the error
// keeps recurring in the same region. The delay ladder lets transient outages
// (server restart, NAS reconnect) come back instead of burning every attempt
// against a dead socket in the first second.
const RECOVER_SKIPS = [0, 1, 2, 5, 10, 30]; // seconds ahead of the failure point
const RECOVER_DELAYS = [300, 600, 1200, 2500, 4000, 6000]; // ms before each reload
const RECOVER_REGION = 5;  // errors within ±5 s count as "the same spot"
const RECOVER_STABLE = 30; // seconds of clean playback that reset the ladder

const ZOOM_MAX = 4;        // 400%
const ZOOM_STEP = 1.15;    // per wheel notch
const PAN_SLOP = 4;        // px of drag that still counts as a click, not a pan

// SVGElement has no `hidden` IDL property, so toggle the attribute (which the
// CSS [hidden] rule matches) for the inline SVG icons.
const show = (node, visible) => {
  if (visible) node.removeAttribute("hidden");
  else node.setAttribute("hidden", "");
};

export class Player {
  constructor(vod, { onEnded, onBack } = {}) {
    this.vod = vod;
    this.onEnded = onEnded;
    this.onBack = onBack;
    this.video = $("video");
    this.view = $("player-view");
    this.stage = $("stage");
    this.btnPlay = $("btn-play");
    this.iconPlay = $("icon-play");
    this.iconPause = $("icon-pause");
    this.timeCur = $("time-cur");
    this.timeDur = $("time-dur");
    this.seekZone = $("seek-zone");
    this.seekTrack = $("seek-track");
    this.seekFill = $("seek-fill");
    this.seekHandle = $("seek-handle");
    this.bufferedLayer = $("seek-buffered-layer");
    this.tooltip = $("seek-tooltip");
    this.histCanvas = $("histogram");
    this.btnSpeed = $("btn-speed");
    this.speedMenu = $("speed-menu");
    this.btnLoop = $("btn-loop");
    this.btnAutoplay = $("btn-autoplay");
    this.btnMute = $("btn-mute");
    this.iconVol = $("icon-vol");
    this.iconVolOff = $("icon-vol-off");
    this.volumeSlider = $("volume");
    this.btnFs = $("btn-fs");
    this.bigPlay = $("big-play");
    this.spinner = $("spinner");
    this.errorBox = $("video-error");
    this.toast = $("toast");
    this.muteLayer = $("seek-muted-layer");
    this.muteNotice = $("mute-notice");
    this.muteLink = $("mute-skip");
    this.btnZoom = $("btn-zoom");
    this.zoomMenu = $("zoom-menu");
    this.zoomRange = $("zoom-range");
    this.zoomVal = $("zoom-val");
    this.zoomReset = $("zoom-reset");
    this.zoomFill = $("zoom-fill");

    this._listeners = [];
    this._bufDivs = [];
    this._scrubbing = false;
    this._scrubRatio = 0;
    this._destroyed = false;
    this._resumeTo = null;
    this._histBuckets = null;
    this._lastSave = 0;
    this._idleTimer = null;
    this._spinTimer = null;
    this._toastTimer = null;
    // zoom + pan. The slider is per-open (framing is specific to what you're
    // watching); "fill screen" is a standing preference, so it persists.
    this._fill = lsGet("ts.zoomFill") === "1";
    this._ro = null;
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this._panning = false;
    this._panFrom = null;
    this._panMoved = 0;
    this._panMax = { x: 0, y: 0 }; // room to pan, from the last apply
    this._suppressClick = false;
    // muted-audio segments (from /api/muted)
    this._muteDivs = [];
    this._muteSegs = null;
    this._muteIdx = -1;
    this._muteSkipTo = 0;
    this._mutePollTimer = null;
    // error-recovery state
    this._lastTime = 0;      // last real currentTime — the element reports 0 after a failed reload
    // Whether the USER wants playback running. Updated only at user-intent
    // boundaries (start/togglePlay/bigPlay), never from element events: the
    // browser pauses the element itself on fatal errors and during reloads,
    // and those synthetic pauses must not stop recovery from resuming.
    this._intentPlaying = false;
    this._recoverTo = null;  // seek target once the recovery reload has metadata
    this._recoverSkip = 0;
    this._recoverAttempts = 0;
    this._recoverRegion = null;
    this._recoverResetAt = null;
    this._recoverTimer = null;
  }

  // Duration for display/seek math: real metadata once loaded, listing value before.
  get dur() {
    const d = this.video.duration;
    return Number.isFinite(d) ? d : (this.vod.durationSec ?? NaN);
  }

  start() {
    const v = this.video;
    this.timeDur.textContent = fmtTime(this.dur);
    this.timeCur.textContent = fmtTime(0, this.dur >= 3600);

    const vol = parseFloat(lsGet("ts.vol"));
    if (Number.isFinite(vol)) v.volume = Math.min(1, Math.max(0, vol));
    v.muted = lsGet("ts.muted") === "1";
    const rate = parseFloat(lsGet("ts.rate"));
    if (SPEEDS.includes(rate)) v.playbackRate = rate;

    const saved = parseFloat(lsGet("ts.pos." + this.vod.stem));
    this._resumeTo = Number.isFinite(saved) && saved > 10 ? saved : null;

    // Loop is per-open, never persisted; the <video> node outlives this Player.
    v.loop = false;
    this.btnLoop.classList.remove("active");
    this.btnAutoplay.classList.toggle("active", lsGet("ts.autoplayNext") === "1");

    this._buildSpeedMenu();
    this._bind();
    this._onVolumeChange();
    this._applyZoom(); // sync the zoom control to this open's fresh 100%
    this._loadMuted();

    v.src = "/media?v=" + encodeURIComponent(this.vod.id);
    this._intentPlaying = true;
    v.play().catch(() => {
      if (!this._destroyed) this.bigPlay.hidden = false;
    });
  }

  destroy() {
    this._destroyed = true;
    this._savePos();
    clearTimeout(this._idleTimer);
    clearTimeout(this._spinTimer);
    clearTimeout(this._toastTimer);
    // Shared <video> node: a pending recovery reload must never fire after
    // the next Player has attached.
    clearTimeout(this._recoverTimer);
    clearTimeout(this._mutePollTimer);
    for (const [t, type, fn, opts] of this._listeners) t.removeEventListener(type, fn, opts);
    this._listeners = [];
    const v = this.video;
    v.pause();
    v.loop = false; // shared <video> node — never leak loop into the next open
    this.btnLoop.classList.remove("active");
    v.removeAttribute("src");
    v.load(); // abort in-flight range requests
    // reset UI for the next open
    this.seekFill.style.width = "0%";
    this.seekHandle.style.left = "0%";
    for (const d of this._bufDivs) d.remove();
    this._bufDivs = [];
    for (const d of this._muteDivs) d.remove();
    this._muteDivs = [];
    this._muteSegs = null;
    this._muteIdx = -1;
    this.muteNotice.hidden = true;
    const ctx = this.histCanvas.getContext("2d");
    ctx && ctx.clearRect(0, 0, this.histCanvas.width, this.histCanvas.height);
    this.bigPlay.hidden = true;
    this.spinner.hidden = true;
    this.errorBox.hidden = true;
    this.tooltip.hidden = true;
    this.toast.hidden = true;
    this.toast.classList.remove("show");
    this.speedMenu.hidden = true;
    // Shared <video> node: the zoom transform must not survive into the next open.
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    this.zoomMenu.hidden = true;
    this.video.style.transform = "";
    this._zoom = 1;
    this._panX = this._panY = 0;
    this._panning = false;
    this._suppressClick = false;
    this.stage.classList.remove("zoomed");
    this.btnZoom.classList.remove("active");
    this.view.classList.remove("hide-controls", "scrubbing", "is-fs");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  // ---- wiring ------------------------------------------------------------

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _bind() {
    const v = this.video;
    this._on(v, "loadedmetadata", () => this._onLoadedMetadata());
    this._on(v, "timeupdate", () => this._onTimeUpdate());
    this._on(v, "progress", () => this._renderBuffered());
    this._on(v, "seeked", () => { this._renderBuffered(); this._updateSeekUI(); this._checkMuted(); });
    this._on(v, "play", () => this._onPlayState());
    this._on(v, "pause", () => { this._onPlayState(); this._savePos(); });
    this._on(v, "ended", () => {
      // The <video> node is shared across opens, and a stray late 'ended' from
      // the previous media can be delivered after this player attached its
      // listeners (seen on huge NAS files near EOF). Only honor it when the
      // clock really sits at the end of *this* player's media — otherwise it
      // would wrongly clear the resume position and double-advance autoplay.
      const d = this.dur;
      if (!Number.isFinite(d) || v.currentTime < Math.max(0, d - 10)) return;
      lsDel("ts.pos." + this.vod.stem);
      this._onPlayState();
      // A looping video never fires `ended`; the guard is pure defense.
      if (!v.loop && this.onEnded) this.onEnded();
    });
    this._on(v, "volumechange", () => this._onVolumeChange());
    this._on(v, "ratechange", () => this._onRateChange());
    this._on(v, "waiting", () => this._onWaiting());
    this._on(v, "playing", () => this._onPlaying());
    this._on(v, "canplay", () => this._onPlaying());
    this._on(v, "error", () => this._onError());

    this._on(this.btnPlay, "click", () => this.togglePlay());
    this._on(this.bigPlay, "click", () => {
      this.bigPlay.hidden = true;
      this._intentPlaying = true;
      v.play().catch(() => {});
    });
    this._on(this.stage, "click", (e) => {
      if (this._suppressClick) { this._suppressClick = false; return; } // end of a pan drag
      if (e.target === v) this.togglePlay();
    });
    this._on(this.stage, "dblclick", (e) => {
      if (e.target === v) this.toggleFullscreen();
    });
    this._on(this.btnLoop, "click", () => {
      v.loop = !v.loop;
      this.btnLoop.classList.toggle("active", v.loop);
      this._showToast(v.loop ? "Loop on" : "Loop off");
    });
    this._on(this.btnAutoplay, "click", () => {
      const on = lsGet("ts.autoplayNext") !== "1";
      lsSet("ts.autoplayNext", on ? "1" : "0");
      this.btnAutoplay.classList.toggle("active", on);
      this._showToast(on ? "Autoplay next on" : "Autoplay next off");
    });
    this._on(this.muteLink, "click", (e) => {
      e.preventDefault();
      this._seekTo(this._muteSkipTo); // jump to where the audio comes back
    });
    this._on(this.btnMute, "click", () => this.toggleMute());
    this._on(this.volumeSlider, "input", () => {
      v.muted = false;
      v.volume = parseFloat(this.volumeSlider.value);
    });
    this._on(this.btnSpeed, "click", (e) => {
      e.stopPropagation();
      this.speedMenu.hidden = !this.speedMenu.hidden;
    });
    this._on(document, "click", () => { this.speedMenu.hidden = true; this.zoomMenu.hidden = true; });
    this._on(this.btnFs, "click", () => this.toggleFullscreen());
    this._on(document, "fullscreenchange", () => this._onFsChange());
    this._on(document, "keydown", (e) => this._onKey(e));
    this._on(this.view, "pointermove", () => this._wake());
    this._on(window, "resize", () => { this._drawHist(); this._applyZoom(); });
    this._on(window, "pagehide", () => this._savePos());

    this._bindSeek();
    this._bindZoom();
  }

  // ---- playback state ----------------------------------------------------

  togglePlay() {
    const v = this.video;
    if (v.paused) {
      this.bigPlay.hidden = true;
      this._intentPlaying = true;
      v.play().catch(() => {});
    } else {
      this._intentPlaying = false;
      v.pause();
    }
  }

  toggleMute() { this.video.muted = !this.video.muted; }

  _onPlayState() {
    if (this._destroyed) return;
    const paused = this.video.paused;
    show(this.iconPlay, paused);
    show(this.iconPause, !paused);
    if (!paused) this.bigPlay.hidden = true;
    this._wake();
  }

  _onLoadedMetadata() {
    if (this._destroyed) return;
    this.timeDur.textContent = fmtTime(this.dur);
    if (this._resumeTo != null && this._resumeTo < this.dur - 60) {
      this.video.currentTime = this._resumeTo;
      this._showToast("Resumed at " + fmtTime(this._resumeTo, this.dur >= 3600));
    }
    this._resumeTo = null;
    // A recovery reload just got its metadata back: jump to where playback
    // died (plus any skip) and resume if it was playing.
    if (this._recoverTo != null) {
      const d = this.dur;
      const t = Number.isFinite(d) ? Math.min(this._recoverTo, Math.max(0, d - 0.5)) : this._recoverTo;
      this.video.currentTime = Math.max(0, t);
      this._showToast(this._recoverSkip > 0
        ? "Recovered playback — skipped " + this._recoverSkip + "s"
        : "Recovered playback");
      this._recoverTo = null;
      if (this._intentPlaying) {
        this.video.play().catch(() => {
          if (!this._destroyed) this.bigPlay.hidden = false;
        });
      }
    }
    this._renderMuted(); // segments may have arrived before the metadata did
    this._applyZoom();   // videoWidth/Height are known now — re-clamp the pan bounds
    this._updateSeekUI();
  }

  _onTimeUpdate() {
    if (this._destroyed) return;
    const t = this.video.currentTime;
    if (Number.isFinite(t) && t > 0) this._lastTime = t;
    // Clean playback past the trouble spot re-arms the full recovery ladder.
    if (this._recoverAttempts && this._recoverResetAt != null && t > this._recoverResetAt) {
      this._recoverAttempts = 0;
      this._recoverRegion = null;
      this._recoverResetAt = null;
    }
    if (!this._scrubbing) {
      this.timeCur.textContent = fmtTime(this.video.currentTime, this.dur >= 3600);
      this._updateSeekUI();
      this._renderBuffered();
    }
    this._checkMuted();
    const now = performance.now();
    if (now - this._lastSave > 5000) {
      this._savePos();
      this._lastSave = now;
    }
  }

  _savePos() {
    const t = this.video.currentTime;
    const d = this.dur;
    if (!Number.isFinite(t) || t < 10) return;
    if (Number.isFinite(d) && t > d - 60) { lsDel("ts.pos." + this.vod.stem); return; }
    lsSet("ts.pos." + this.vod.stem, String(Math.floor(t)));
  }

  _onVolumeChange() {
    if (this._destroyed) return;
    const v = this.video;
    const silent = v.muted || v.volume === 0;
    show(this.iconVol, !silent);
    show(this.iconVolOff, silent);
    this.volumeSlider.value = v.muted ? 0 : v.volume;
    lsSet("ts.vol", String(v.volume));
    lsSet("ts.muted", v.muted ? "1" : "0");
  }

  setVolume(x) {
    const v = this.video;
    v.volume = Math.min(1, Math.max(0, x));
    if (v.volume > 0) v.muted = false;
  }

  _buildSpeedMenu() {
    this.speedMenu.textContent = "";
    for (const s of SPEEDS) {
      const b = el("button", null, s === 1 ? "Normal" : s + "×");
      b.dataset.speed = s;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.video.playbackRate = s;
        lsSet("ts.rate", String(s));
        this.speedMenu.hidden = true;
      });
      this.speedMenu.append(b);
    }
    this._onRateChange();
  }

  _onRateChange() {
    const r = this.video.playbackRate;
    this.btnSpeed.textContent = r + "×";
    for (const b of this.speedMenu.children) {
      b.classList.toggle("active", parseFloat(b.dataset.speed) === r);
    }
  }

  // ---- seek bar ----------------------------------------------------------

  _seekTo(t) {
    const d = this.dur;
    if (!Number.isFinite(d) || this.video.readyState === 0) return;
    this.video.currentTime = Math.min(Math.max(0, t), Math.max(0, d - 0.1));
    this._updateSeekUI();
  }

  _updateSeekUI() {
    const d = this.dur;
    if (!Number.isFinite(d) || d <= 0) return;
    const ratio = this._scrubbing ? this._scrubRatio : this.video.currentTime / d;
    const pct = (Math.min(1, Math.max(0, ratio)) * 100).toFixed(3) + "%";
    this.seekFill.style.width = pct;
    this.seekHandle.style.left = pct;
  }

  _renderBuffered() {
    if (this._destroyed) return;
    const b = this.video.buffered;
    const d = this.dur;
    if (!Number.isFinite(d) || d <= 0) return;
    while (this._bufDivs.length < b.length) {
      const div = el("div", "seek-buffered");
      this.bufferedLayer.append(div);
      this._bufDivs.push(div);
    }
    for (let i = 0; i < this._bufDivs.length; i++) {
      const div = this._bufDivs[i];
      if (i < b.length) {
        div.style.left = (b.start(i) / d * 100) + "%";
        div.style.width = ((b.end(i) - b.start(i)) / d * 100) + "%";
        div.hidden = false;
      } else {
        div.hidden = true;
      }
    }
  }

  // ---- zoom + pan --------------------------------------------------------
  // A CSS transform on the <video> element: scale to zoom, translate to pan.
  // The stage clips it, so the picture never spills into chat or the controls.

  // cx/cy: cursor offset from the element's untransformed centre, so the point
  // under the pointer stays put while the wheel zooms. Omit to zoom on centre.
  _setZoom(z, cx, cy) {
    const next = Math.min(ZOOM_MAX, Math.max(1, z));
    if (next === this._zoom) return;
    const k = next / this._zoom;
    if (cx != null) {
      this._panX = cx - k * (cx - this._panX);
      this._panY = cy - k * (cy - this._panY);
    } else {
      this._panX *= k; // slider: hold the centre of the current view
      this._panY *= k;
    }
    this._zoom = next;
    this._applyZoom();
  }

  _resetZoom() {
    this._zoom = 1;
    this._panX = this._panY = 0;
    this._applyZoom();
  }

  // The picture as object-fit: contain lays it out — i.e. letterboxed inside
  // the element box. Everything else measures against this, not the box.
  _picture() {
    const v = this.video;
    const bw = v.clientWidth, bh = v.clientHeight;
    if (!(bw > 0 && bh > 0 && v.videoWidth > 0 && v.videoHeight > 0)) {
      return { bw, bh, pw: bw, ph: bh };
    }
    const s = Math.min(bw / v.videoWidth, bh / v.videoHeight);
    return { bw, bh, pw: v.videoWidth * s, ph: v.videoHeight * s };
  }

  // Extra scale needed to cover the stage, cropping the letterbox/pillarbox
  // bars away. 1 when fill is off or the geometry isn't known yet. Recomputed
  // on every apply, so it tracks the video's aspect, window size, fullscreen
  // and the chat-width setting without any stored state.
  _fitScale() {
    if (!this._fill) return 1;
    const { bw, bh, pw, ph } = this._picture();
    if (!(pw > 0 && ph > 0)) return 1;
    return Math.max(1, Math.max(bw / pw, bh / ph));
  }

  // What the video is actually scaled by: the fill baseline times the slider.
  _scale() { return this._fitScale() * this._zoom; }

  // Keep the panned picture covering the stage — never drag past its edges
  // into empty space. Returns the bounds so the caller can tell whether
  // panning is possible at all.
  _clampPan() {
    const { bw, bh, pw, ph } = this._picture();
    const s = this._scale();
    const maxX = Math.max(0, (pw * s - bw) / 2);
    const maxY = Math.max(0, (ph * s - bh) / 2);
    this._panX = Math.min(maxX, Math.max(-maxX, this._panX));
    this._panY = Math.min(maxY, Math.max(-maxY, this._panY));
    return { maxX, maxY };
  }

  _applyZoom() {
    if (this._destroyed) return;
    const { maxX, maxY } = this._clampPan();
    this._panMax = { x: maxX, y: maxY };
    const s = this._scale();
    this.video.style.transform = s === 1 && !this._panX && !this._panY
      ? ""
      : "translate(" + this._panX + "px, " + this._panY + "px) scale(" + s + ")";
    // Grab cursor whenever there is somewhere to pan to — in fill mode that is
    // true even at 100%, since the cropped axis extends past the stage.
    this.stage.classList.toggle("zoomed", maxX > 0.5 || maxY > 0.5);
    this.btnZoom.classList.toggle("active", this._fill || this._zoom > 1);
    this.zoomFill.checked = this._fill;
    const pct = Math.round(this._zoom * 100);
    this.zoomRange.value = String(pct);
    this.zoomVal.textContent = pct + "%";
  }

  _bindZoom() {
    const v = this.video;
    this._on(this.btnZoom, "click", (e) => {
      e.stopPropagation();
      this.speedMenu.hidden = true;
      this.zoomMenu.hidden = !this.zoomMenu.hidden;
    });
    this._on(this.zoomMenu, "click", (e) => e.stopPropagation()); // dragging the slider must not close it
    this._on(this.zoomRange, "input", () => this._setZoom(parseFloat(this.zoomRange.value) / 100));
    this._on(this.zoomReset, "click", () => this._resetZoom());
    this._on(this.zoomFill, "change", () => {
      this._fill = this.zoomFill.checked;
      lsSet("ts.zoomFill", this._fill ? "1" : "0");
      this._panX = this._panY = 0; // re-centre: the framing just changed under them
      this._applyZoom();
    });

    // The stage resizes for reasons no window "resize" event covers — entering
    // fullscreen, and the chat-width setting — and the fill scale depends on it.
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this._applyZoom());
      this._ro.observe(this.stage);
    }

    this._on(this.stage, "wheel", (e) => {
      if (e.target !== v) return; // let the big-play button keep its own scroll
      e.preventDefault();
      const rect = v.getBoundingClientRect();
      // rect is the *transformed* box; back out the pan to find the original centre.
      const cx = e.clientX - (rect.left + rect.width / 2 - this._panX);
      const cy = e.clientY - (rect.top + rect.height / 2 - this._panY);
      this._setZoom(this._zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), cx, cy);
    }, { passive: false });

    this._on(v, "pointerdown", (e) => {
      // Gate on real room to pan, not the slider: fill mode overflows the
      // stage at 100% too, and a fully-fitted picture has nowhere to go.
      if (e.button !== 0) return;
      if (this._panMax.x <= 0.5 && this._panMax.y <= 0.5) return;
      e.preventDefault();
      v.setPointerCapture(e.pointerId);
      this._panning = true;
      this._panMoved = 0;
      this._panFrom = { x: e.clientX, y: e.clientY, px: this._panX, py: this._panY };
    });
    this._on(v, "pointermove", (e) => {
      if (!this._panning) return;
      const dx = e.clientX - this._panFrom.x;
      const dy = e.clientY - this._panFrom.y;
      this._panMoved = Math.max(this._panMoved, Math.abs(dx) + Math.abs(dy));
      this._panX = this._panFrom.px + dx;
      this._panY = this._panFrom.py + dy;
      this._applyZoom();
    });
    const endPan = () => {
      if (!this._panning) return;
      this._panning = false;
      // A real drag must not also toggle play/pause on the click that follows.
      if (this._panMoved > PAN_SLOP) this._suppressClick = true;
    };
    this._on(v, "pointerup", endPan);
    this._on(v, "pointercancel", endPan);
  }

  // ---- muted-audio segments ----------------------------------------------
  // Twitch mutes copyrighted stretches; the server detects them with ffmpeg
  // and caches per file (/api/muted). Marked light red on the seek track, and
  // while the playhead is inside one a notice above the controls links to
  // where the audio returns.

  async _loadMuted() {
    let data = null;
    try {
      const res = await fetch("/api/muted?v=" + encodeURIComponent(this.vod.id));
      if (res.ok) data = await res.json();
    } catch { /* server unreachable — same as unavailable */ }
    if (this._destroyed || !data) return;
    if (data.status === "ok" && Array.isArray(data.segments)) {
      this._muteSegs = data.segments
        .filter((s) => Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > s[0])
        .sort((a, b) => a[0] - b[0]);
      this._renderMuted();
      this._checkMuted();
    } else if (data.status === "pending") {
      // The scan is queued — this request just bumped it to the front of the
      // server's queue, and each re-poll keeps it there.
      this._mutePollTimer = setTimeout(() => this._loadMuted(), 30000);
    }
    // "unavailable" (no ffmpeg / pre-mute-scan server): nothing to show
  }

  _renderMuted() {
    if (this._destroyed || !this._muteSegs) return;
    const d = this.dur;
    if (!Number.isFinite(d) || d <= 0) return;
    while (this._muteDivs.length < this._muteSegs.length) {
      const div = el("div", "seek-muted-seg");
      this.muteLayer.append(div);
      this._muteDivs.push(div);
    }
    for (let i = 0; i < this._muteDivs.length; i++) {
      const div = this._muteDivs[i];
      const seg = this._muteSegs[i];
      if (seg) {
        div.style.left = (seg[0] / d * 100) + "%";
        div.style.width = ((seg[1] - seg[0]) / d * 100) + "%";
        div.hidden = false;
      } else {
        div.hidden = true;
      }
    }
  }

  _checkMuted() {
    if (this._destroyed || !this._muteSegs || !this._muteSegs.length) return;
    const t = this.video.currentTime;
    let idx = -1;
    for (let i = 0; i < this._muteSegs.length; i++) {
      if (t >= this._muteSegs[i][0] && t < this._muteSegs[i][1]) { idx = i; break; }
    }
    if (idx === this._muteIdx) return;
    this._muteIdx = idx;
    if (idx < 0) {
      this.muteNotice.hidden = true;
      return;
    }
    const end = this._muteSegs[idx][1];
    this._muteSkipTo = end + 0.5;
    this.muteLink.textContent = fmtTime(end, true);
    this.muteNotice.hidden = false;
  }

  _ratioFromEvent(e) {
    const rect = this.seekTrack.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  _bindSeek() {
    const zone = this.seekZone;
    // Commit-on-release scrubbing: live-seeking a 24 GB moov-at-EOF file would
    // fire an abort/reopen/keyframe-hunt cycle for every pixel of drag.
    this._on(zone, "pointerdown", (e) => {
      if (!Number.isFinite(this.dur)) return;
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      this._scrubbing = true;
      this.view.classList.add("scrubbing");
      this._scrubRatio = this._ratioFromEvent(e);
      this._updateScrubUI(e);
    });
    this._on(zone, "pointermove", (e) => {
      if (this._scrubbing) {
        this._scrubRatio = this._ratioFromEvent(e);
        this._updateScrubUI(e);
      } else if (Number.isFinite(this.dur)) {
        this._moveTooltip(e);
      }
    });
    const endScrub = (e, commit) => {
      if (!this._scrubbing) return;
      this._scrubbing = false;
      this.view.classList.remove("scrubbing");
      this.tooltip.hidden = true;
      if (commit) this._seekTo(this._ratioFromEvent(e) * this.dur);
      else this._updateSeekUI();
    };
    this._on(zone, "pointerup", (e) => endScrub(e, true));
    this._on(zone, "pointercancel", (e) => endScrub(e, false));
    this._on(zone, "pointerleave", () => { if (!this._scrubbing) this.tooltip.hidden = true; });
  }

  _moveTooltip(e) {
    const rect = this.seekZone.getBoundingClientRect();
    const ratio = this._ratioFromEvent(e);
    this.tooltip.textContent = fmtTime(ratio * this.dur, this.dur >= 3600);
    // Unhide before measuring ([hidden] is display:none, so offsetWidth reads 0),
    // then clamp so the tooltip never pokes past the seek zone — during a captured
    // drag e.clientX can be far outside the window, which used to grow the page
    // and spawn scrollbars.
    this.tooltip.hidden = false;
    const half = this.tooltip.offsetWidth / 2;
    const x = Math.max(half, Math.min(e.clientX - rect.left, rect.width - half));
    this.tooltip.style.left = x + "px";
  }

  _updateScrubUI(e) {
    this._moveTooltip(e);
    this._updateSeekUI();
    this.timeCur.textContent = fmtTime(this._scrubRatio * this.dur, this.dur >= 3600);
  }

  // ---- histogram ---------------------------------------------------------

  drawHistogram(buckets) {
    this._histBuckets = buckets;
    this._drawHist();
  }

  _drawHist() {
    const c = this.histCanvas;
    const buckets = this._histBuckets;
    if (!buckets || !buckets.length) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (w <= 0 || h <= 0) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    // 95th-percentile ceiling so one hype spike doesn't flatten everything.
    const nz = Array.from(buckets).filter((x) => x > 0).sort((a, b) => a - b);
    if (!nz.length) return;
    const ceil = Math.max(1, nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.95))]);
    ctx.fillStyle = "rgba(145, 71, 255, 0.45)";
    const bw = w / buckets.length;
    for (let i = 0; i < buckets.length; i++) {
      const v = Math.min(1, buckets[i] / ceil);
      if (v <= 0) continue;
      const bh = Math.max(1, v * (h - 2));
      ctx.fillRect(i * bw, h - bh, Math.max(bw - 0.5, 0.75), bh);
    }
  }

  // ---- keyboard ----------------------------------------------------------

  _onKey(e) {
    const t = e.target;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const v = this.video;
    // Some key-injection paths deliver space with an empty e.key; e.code is stable.
    const key = e.code === "Space" ? " " : e.key;
    switch (key) {
      case " ": case "k": e.preventDefault(); this.togglePlay(); break;
      case "ArrowLeft": e.preventDefault(); this._seekTo(v.currentTime - 5); break;
      case "ArrowRight": e.preventDefault(); this._seekTo(v.currentTime + 5); break;
      case "j": this._seekTo(v.currentTime - 10); break;
      case "l": this._seekTo(v.currentTime + 10); break;
      case "m": this.toggleMute(); break;
      case "f": this.toggleFullscreen(); break;
      case "ArrowUp": e.preventDefault(); this.setVolume(v.volume + 0.05); break;
      case "ArrowDown": e.preventDefault(); this.setVolume(v.volume - 0.05); break;
      case "Escape":
        // Escape leaves the player, like the Back button. In fullscreen it
        // exits fullscreen first (a second Escape then leaves) — the standard
        // player convention, and it avoids fighting the browser's own
        // Escape-exits-fullscreen behavior.
        e.preventDefault();
        if (document.fullscreenElement) this.toggleFullscreen();
        else if (this.onBack) this.onBack();
        break;
      default:
        return;
    }
    this._wake();
  }

  // ---- fullscreen + auto-hide -------------------------------------------

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      const req = this.view.requestFullscreen || this.view.webkitRequestFullscreen;
      req && req.call(this.view);
    }
  }

  _onFsChange() {
    if (this._destroyed) return;
    const fs = !!document.fullscreenElement;
    this.view.classList.toggle("is-fs", fs);
    show($("icon-fs"), !fs);
    show($("icon-fs-exit"), fs);
    this._wake();
    this._drawHist();
    this._applyZoom(); // the stage just changed size — pan bounds move with it
  }

  _wake() {
    if (this._destroyed) return;
    this.view.classList.remove("hide-controls");
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (document.fullscreenElement && !this.video.paused && !this._scrubbing) {
        this.view.classList.add("hide-controls");
      }
    }, 3000);
  }

  // ---- overlays ----------------------------------------------------------

  _onWaiting() {
    if (this._destroyed) return;
    clearTimeout(this._spinTimer);
    this._spinTimer = setTimeout(() => {
      if (!this._destroyed && !this.video.paused) this.spinner.hidden = false;
    }, 200);
  }

  _onPlaying() {
    if (this._destroyed) return;
    clearTimeout(this._spinTimer);
    this.spinner.hidden = true;
  }

  _onError() {
    if (this._destroyed || !this.video.error) return;
    const code = this.video.error.code;
    const msgs = {
      1: "Playback aborted.",
      2: "Network error while loading the video.",
      3: "The video could not be decoded.",
      4: "This video format is not supported by the browser.",
    };
    // Decode (3) and network (2) errors are usually transient — one corrupt
    // packet, a dropped NAS/server connection — so recover instead of
    // dead-ending playback. Code 4 is only retried once the file has provably
    // played (browsers report a refused connection as "not supported"); a
    // fresh code 4 really is an unsupported file. Code 1 stays fatal.
    const retriable = code === 2 || code === 3 || (code === 4 && this._lastTime > 0);
    if (retriable && this._beginRecovery()) return;
    this.spinner.hidden = true;
    this.errorBox.textContent = msgs[code] || "Playback error.";
    this.errorBox.hidden = false;
  }

  // One rung of the recovery ladder. False = attempts exhausted (caller shows
  // the plain error box).
  _beginRecovery() {
    const v = this.video;
    const cur = v.currentTime;
    const pos = Number.isFinite(cur) && cur > 0 ? cur : this._lastTime;
    if (this._recoverRegion != null && Math.abs(pos - this._recoverRegion) <= RECOVER_REGION) {
      this._recoverAttempts++;
    } else {
      this._recoverRegion = pos;
      this._recoverAttempts = 1;
    }
    if (this._recoverAttempts > RECOVER_SKIPS.length) return false;
    const skip = RECOVER_SKIPS[this._recoverAttempts - 1];
    this._recoverSkip = skip;
    this._recoverTo = pos + skip;
    this._recoverResetAt = pos + skip + RECOVER_STABLE;
    // Directly — _onWaiting's delayed spinner refuses to show while the
    // element reports paused, which an errored element may.
    this.spinner.hidden = false;
    this.errorBox.hidden = true;
    clearTimeout(this._recoverTimer);
    this._recoverTimer = setTimeout(() => {
      if (this._destroyed) return;
      // Same URL; re-setting src resets the element's error state and
      // restarts resource selection from scratch.
      this.video.src = "/media?v=" + encodeURIComponent(this.vod.id);
      this.video.load();
    }, RECOVER_DELAYS[this._recoverAttempts - 1]);
    return true;
  }

  showToast(text) { this._showToast(text); }

  _showToast(text) {
    this.toast.textContent = text;
    this.toast.hidden = false;
    requestAnimationFrame(() => this.toast.classList.add("show"));
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.toast.classList.remove("show");
      this._toastTimer = setTimeout(() => { this.toast.hidden = true; }, 300);
    }, 3500);
  }
}
