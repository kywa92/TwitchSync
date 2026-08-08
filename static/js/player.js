// Video player: playback, custom control bar, seek bar with buffered ranges +
// chat-activity histogram, fullscreen, keyboard shortcuts, position memory.

import { fmtTime, el, lsGet, lsSet, lsDel } from "./util.js";

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const $ = (id) => document.getElementById(id);

// SVGElement has no `hidden` IDL property, so toggle the attribute (which the
// CSS [hidden] rule matches) for the inline SVG icons.
const show = (node, visible) => {
  if (visible) node.removeAttribute("hidden");
  else node.setAttribute("hidden", "");
};

export class Player {
  constructor(vod) {
    this.vod = vod;
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
    this.btnMute = $("btn-mute");
    this.iconVol = $("icon-vol");
    this.iconVolOff = $("icon-vol-off");
    this.volumeSlider = $("volume");
    this.btnFs = $("btn-fs");
    this.bigPlay = $("big-play");
    this.spinner = $("spinner");
    this.errorBox = $("video-error");
    this.toast = $("toast");

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

    this._buildSpeedMenu();
    this._bind();
    this._onVolumeChange();

    v.src = "/media?v=" + encodeURIComponent(this.vod.id);
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
    for (const [t, type, fn, opts] of this._listeners) t.removeEventListener(type, fn, opts);
    this._listeners = [];
    const v = this.video;
    v.pause();
    v.removeAttribute("src");
    v.load(); // abort in-flight range requests
    // reset UI for the next open
    this.seekFill.style.width = "0%";
    this.seekHandle.style.left = "0%";
    for (const d of this._bufDivs) d.remove();
    this._bufDivs = [];
    const ctx = this.histCanvas.getContext("2d");
    ctx && ctx.clearRect(0, 0, this.histCanvas.width, this.histCanvas.height);
    this.bigPlay.hidden = true;
    this.spinner.hidden = true;
    this.errorBox.hidden = true;
    this.toast.hidden = true;
    this.toast.classList.remove("show");
    this.speedMenu.hidden = true;
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
    this._on(v, "seeked", () => { this._renderBuffered(); this._updateSeekUI(); });
    this._on(v, "play", () => this._onPlayState());
    this._on(v, "pause", () => { this._onPlayState(); this._savePos(); });
    this._on(v, "ended", () => { lsDel("ts.pos." + this.vod.stem); this._onPlayState(); });
    this._on(v, "volumechange", () => this._onVolumeChange());
    this._on(v, "ratechange", () => this._onRateChange());
    this._on(v, "waiting", () => this._onWaiting());
    this._on(v, "playing", () => this._onPlaying());
    this._on(v, "canplay", () => this._onPlaying());
    this._on(v, "error", () => this._onError());

    this._on(this.btnPlay, "click", () => this.togglePlay());
    this._on(this.bigPlay, "click", () => { this.bigPlay.hidden = true; v.play().catch(() => {}); });
    this._on(this.stage, "click", (e) => {
      if (e.target === v) this.togglePlay();
    });
    this._on(this.stage, "dblclick", (e) => {
      if (e.target === v) this.toggleFullscreen();
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
    this._on(document, "click", () => { this.speedMenu.hidden = true; });
    this._on(this.btnFs, "click", () => this.toggleFullscreen());
    this._on(document, "fullscreenchange", () => this._onFsChange());
    this._on(document, "keydown", (e) => this._onKey(e));
    this._on(this.view, "pointermove", () => this._wake());
    this._on(window, "resize", () => this._drawHist());
    this._on(window, "pagehide", () => this._savePos());

    this._bindSeek();
  }

  // ---- playback state ----------------------------------------------------

  togglePlay() {
    const v = this.video;
    if (v.paused) {
      this.bigPlay.hidden = true;
      v.play().catch(() => {});
    } else {
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
    this._updateSeekUI();
  }

  _onTimeUpdate() {
    if (this._destroyed) return;
    if (!this._scrubbing) {
      this.timeCur.textContent = fmtTime(this.video.currentTime, this.dur >= 3600);
      this._updateSeekUI();
      this._renderBuffered();
    }
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
    this.tooltip.style.left = (e.clientX - rect.left) + "px";
    this.tooltip.hidden = false;
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
      default:
        if (/^[0-9]$/.test(e.key) && Number.isFinite(this.dur)) {
          this._seekTo(this.dur * Number(e.key) / 10);
        } else {
          return;
        }
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
    const msgs = {
      1: "Playback aborted.",
      2: "Network error while loading the video.",
      3: "The video could not be decoded.",
      4: "This video format is not supported by the browser.",
    };
    this.spinner.hidden = true;
    this.errorBox.textContent = msgs[this.video.error.code] || "Playback error.";
    this.errorBox.hidden = false;
  }

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
