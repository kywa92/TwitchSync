// Chat replay engine: loads the TwitchDownloader chat JSON, builds emote/badge
// blob URLs, renders messages as DOM, and keeps the column in sync with the
// video clock (append on timeupdate, binary-search rebuild on seek).

import { el, fmtTime, colorHash, readableColor, upperBound, sniffImageMime } from "./util.js";

const PIN_CAP = 200;      // max messages in DOM while pinned to bottom
const UNPIN_CAP = 500;    // hard bound while the user reads scrollback
const BACKFILL = 50;      // messages rendered above the seek point for context

const $ = (id) => document.getElementById(id);

export class Chat {
  constructor(vod, video, { onHistogram } = {}) {
    this.vod = vod;
    this.video = video;
    this.onHistogram = onHistogram;

    this.scroller = $("chat-scroll");
    this.box = $("chat-messages");
    this.loadBox = $("chat-load");
    this.loadLabel = $("chat-load-label");
    this.loadFill = $("chat-load-fill");
    this.errBox = $("chat-error");
    this.pill = $("chat-paused-pill");

    this._listeners = [];
    this._urls = [];
    this._destroyed = false;
    this._prog = false;

    this.comments = null;
    this.times = null;
    this.firstParty = null;
    this.thirdParty = null;
    this.badges = null;
    this.cursor = 0;
    this.pinned = true;
  }

  async load() {
    this.loadBox.hidden = false;
    this.errBox.hidden = true;
    this._setProgress("Downloading chat…", 0);
    try {
      const res = await fetch("/chat?v=" + encodeURIComponent(this.vod.id));
      if (!res.ok) throw new Error("HTTP " + res.status);
      const total = Number(res.headers.get("Content-Length")) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this._destroyed) { reader.cancel().catch(() => {}); return; }
        chunks.push(value);
        received += value.length;
        if (total) this._setProgress("Downloading chat…", received / total);
      }
      this._setProgress("Preparing emotes…", 1);
      await new Promise((r) => setTimeout(r, 30)); // let the label paint before the sync parse
      const text = await new Blob(chunks).text();
      chunks.length = 0;
      const data = JSON.parse(text);
      if (this._destroyed) return;
      this._build(data);
      this.loadBox.hidden = true;
      this._bind();
      this._syncToTime(); // covers an already-applied resume seek
    } catch (err) {
      if (this._destroyed) return;
      console.error("chat load failed:", err);
      this.loadBox.hidden = true;
      this.errBox.hidden = false;
    }
  }

  destroy() {
    this._destroyed = true;
    for (const [t, type, fn] of this._listeners) t.removeEventListener(type, fn);
    this._listeners = [];
    for (const u of this._urls) URL.revokeObjectURL(u);
    this._urls = [];
    this.box.textContent = "";
    this.loadBox.hidden = true;
    this.errBox.hidden = true;
    this.pill.hidden = true;
    this.comments = this.times = null;
    this.firstParty = this.thirdParty = this.badges = null;
  }

  // ---- loading -----------------------------------------------------------

  _setProgress(label, frac) {
    this.loadLabel.textContent = label + (frac > 0 && frac < 1 ? " " + Math.round(frac * 100) + "%" : "");
    this.loadFill.style.width = (frac * 100).toFixed(1) + "%";
  }

  _blobUrl(b64) {
    try {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([u8], { type: sniffImageMime(u8) }));
      this._urls.push(url);
      return url;
    } catch {
      return "";
    }
  }

  _build(data) {
    const comments = Array.isArray(data.comments) ? data.comments : [];
    this.comments = comments;
    const n = comments.length;
    this.times = new Float64Array(n);
    for (let i = 0; i < n; i++) this.times[i] = comments[i].content_offset_seconds || 0;

    const ed = data.embeddedData || {};

    this.firstParty = new Map();
    for (const e of ed.firstParty || []) {
      if (!e || !e.data || e.id == null) continue;
      const url = this._blobUrl(e.data);
      if (url) this.firstParty.set(String(e.id), { url, w: e.width || 28, h: e.height || 28 });
    }

    this.thirdParty = new Map();
    for (const e of ed.thirdParty || []) {
      if (!e || !e.data || !e.name) continue;
      const url = this._blobUrl(e.data);
      if (url) this.thirdParty.set(e.name, { url, w: e.width || 28, h: e.height || 28, zw: !!e.isZeroWidth });
    }

    this.badges = new Map();
    for (const b of ed.twitchBadges || []) {
      if (!b || !b.name || !b.versions) continue;
      for (const [ver, obj] of Object.entries(b.versions)) {
        const b64 = obj && (obj.bytes || obj.data);
        if (!b64) continue;
        const url = this._blobUrl(b64);
        if (url) this.badges.set(b.name + "/" + ver, { url, title: (obj && obj.title) || b.name });
      }
    }

    // Messages-per-minute histogram for the seek bar.
    const dur = Math.max(this.video.duration || 0, this.vod.durationSec || 0, n ? this.times[n - 1] : 0);
    const buckets = new Uint32Array(Math.max(1, Math.ceil(dur / 60)));
    for (let i = 0; i < n; i++) {
      let m = Math.floor(this.times[i] / 60);
      if (m < 0) m = 0;
      if (m >= buckets.length) m = buckets.length - 1;
      buckets[m]++;
    }
    if (n && this.onHistogram) this.onHistogram(buckets);

    this._showHours = dur >= 3600;
    if (!n) {
      this.errBox.textContent = "No chat messages";
      this.errBox.hidden = false;
    }
  }

  // ---- message rendering -------------------------------------------------

  _renderMsg(c) {
    const msg = el("div", "msg");
    msg.append(el("span", "ts", fmtTime(c.content_offset_seconds || 0, this._showHours)));

    const m = c.message || {};
    for (const b of m.user_badges || []) {
      const info = this.badges.get(b._id + "/" + b.version);
      if (!info) continue;
      const img = new Image(18, 18);
      img.className = "badge";
      img.src = info.url;
      img.alt = info.title;
      img.title = info.title;
      msg.append(img);
    }

    const commenter = c.commenter || {};
    const name = el("span", "name", commenter.display_name || commenter.name || "?");
    name.style.color = readableColor(m.user_color || colorHash(commenter.name || commenter.display_name));
    msg.append(name, document.createTextNode(": "));

    const body = el("span", "body");
    this._renderBody(body, m);
    msg.append(body);
    return msg;
  }

  _renderBody(body, m) {
    let pendingText = "";
    let lastEmoteWrap = null;
    let sinceEmote = ""; // non-space text seen since the last emote (zero-width eligibility)

    const flush = () => {
      if (pendingText) {
        body.append(document.createTextNode(pendingText));
        pendingText = "";
      }
    };
    const makeImg = (info, name, cls) => {
      const img = new Image(info.w, info.h);
      img.className = cls;
      img.src = info.url;
      img.alt = name;
      img.title = name;
      return img;
    };
    const emitEmote = (info, name) => {
      flush();
      const wrap = el("span", "emote-stack");
      wrap.append(makeImg(info, name, "emote"));
      body.append(wrap);
      lastEmoteWrap = wrap;
      sinceEmote = "";
    };

    const fragments = Array.isArray(m.fragments) && m.fragments.length
      ? m.fragments
      : [{ text: m.body || "" }];

    for (const frag of fragments) {
      if (frag && frag.emoticon && frag.emoticon.emoticon_id != null) {
        const info = this.firstParty.get(String(frag.emoticon.emoticon_id));
        if (info) { emitEmote(info, frag.text || ""); continue; }
        // unknown first-party emote: fall through and treat its text as words
      }
      const words = ((frag && frag.text) || "").split(" ");
      for (let wi = 0; wi < words.length; wi++) {
        const word = words[wi];
        const sep = wi > 0 ? " " : "";
        const tp = word ? this.thirdParty.get(word) : undefined;
        if (tp) {
          if (tp.zw && lastEmoteWrap && sinceEmote.trim() === "" ) {
            lastEmoteWrap.append(makeImg(tp, word, "emote emote-zw"));
            continue; // word (and its separator) absorbed by the overlay
          }
          pendingText += sep;
          emitEmote(tp, word);
          continue;
        }
        if (word.length > 1 && word[0] === "@") {
          pendingText += sep;
          flush();
          body.append(el("span", "mention", word));
          sinceEmote += word;
          continue;
        }
        pendingText += sep + word;
        sinceEmote += word;
      }
    }
    flush();
  }

  // ---- sync engine -------------------------------------------------------

  _bind() {
    this._on(this.video, "timeupdate", () => this._tick());
    this._on(this.video, "seeked", () => this._syncToTime());
    this._on(this.scroller, "scroll", () => this._onScroll());
    this._on(this.pill, "click", () => this._repin());
  }

  _on(target, type, fn) {
    target.addEventListener(type, fn);
    this._listeners.push([target, type, fn]);
  }

  _tick() {
    if (!this.times || this._destroyed) return;
    const t = this.video.currentTime;
    const n = this.times.length;
    if (this.cursor >= n || this.times[this.cursor] > t) return;
    const frag = document.createDocumentFragment();
    let appended = 0;
    while (this.cursor < n && this.times[this.cursor] <= t && appended < 400) {
      frag.append(this._renderMsg(this.comments[this.cursor]));
      this.cursor++;
      appended++;
    }
    this.box.append(frag);
    this._trim();
    if (this.pinned) this._scrollBottom();
  }

  _syncToTime() {
    if (!this.times || this._destroyed) return;
    const idx = upperBound(this.times, this.video.currentTime);
    if (idx < this.cursor || idx - this.cursor > PIN_CAP) {
      this._rebuild(idx);
    }
    // small forward gap: _tick catches up on the next timeupdate
  }

  _rebuild(idx) {
    this.box.textContent = "";
    const start = Math.max(0, idx - BACKFILL);
    const frag = document.createDocumentFragment();
    for (let i = start; i < idx; i++) frag.append(this._renderMsg(this.comments[i]));
    this.box.append(frag);
    this.cursor = idx;
    this._repin();
  }

  _trim() {
    const cap = this.pinned ? PIN_CAP : UNPIN_CAP;
    if (this.box.childElementCount <= cap) return;
    if (this.pinned) {
      while (this.box.childElementCount > cap) this.box.firstElementChild.remove();
    } else {
      // Removing from the top shifts content; compensate so scrollback never yanks.
      const before = this.scroller.scrollHeight;
      while (this.box.childElementCount > cap) this.box.firstElementChild.remove();
      const removed = before - this.scroller.scrollHeight;
      if (removed > 0) {
        this._prog = true;
        this.scroller.scrollTop = Math.max(0, this.scroller.scrollTop - removed);
        requestAnimationFrame(() => { this._prog = false; });
      }
    }
  }

  _scrollBottom() {
    this._prog = true;
    this.scroller.scrollTop = this.scroller.scrollHeight;
    requestAnimationFrame(() => { this._prog = false; });
  }

  _onScroll() {
    if (this._prog || this._destroyed) return;
    const sc = this.scroller;
    const dist = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    if (this.pinned && dist > 40) {
      this.pinned = false;
      this.pill.hidden = false;
    } else if (!this.pinned && dist < 10) {
      this._repin();
    }
  }

  _repin() {
    this.pinned = true;
    this.pill.hidden = true;
    this._trim();
    this._scrollBottom();
  }
}
