// Chat replay engine: loads the TwitchDownloader chat JSON, builds emote/badge
// blob URLs, renders messages as DOM, and keeps the column in sync with the
// video clock (append on timeupdate, binary-search rebuild on seek).

import { el, fmtTime, colorHash, readableColor, upperBound, sniffImageMime,
         lsGet, lsSet, lsDel } from "./util.js";

// Twitch's bot badge, verified against a real TwitchDownloader log: the badge
// id is "bot-badge" and its title is "Chat Bot". The title is the friendlier
// check, the id is the fallback for logs downloaded without badge images.
const BOT_BADGE_ID = "bot-badge";
const BOT_BADGE_TITLE = "Chat Bot";
// "!match", "!followage" — a command needs a word character after the bang, so
// plain excitement ("!!!") is never mistaken for one.
const CMD_RE = /^\s*![a-z0-9]/i;

const PIN_CAP = 200;      // max messages in DOM while pinned to bottom
const UNPIN_CAP = 500;    // hard bound while the user reads scrollback
const BACKFILL = 50;      // messages rendered above the seek point for context

const $ = (id) => document.getElementById(id);

// ---- chat settings -------------------------------------------------------
// Timestamp visibility and column width are page-level preferences, not
// per-VOD state: a Chat instance is created and destroyed on every open, so
// the panel is bound once for the document and applied from localStorage.

const CHAT_W_MIN = 15;  // percent of the window; keep both ends usable
const CHAT_W_MAX = 50;
const CHAT_W_DEFAULT = 30; // ≈ the stylesheet's 380px at a typical window
const CHAT_OP_MIN = 20;    // percent; below this the text is unreadable over video
const CHAT_OP_MAX = 100;
const CHAT_OP_DEFAULT = 75;
let csBound = false;

// Non-finite input (a garbled stored value, or a measurement taken while the
// window reports zero width) falls back to the default instead of NaN.
const clampChatWidth = (w) =>
  Number.isFinite(w) ? Math.min(CHAT_W_MAX, Math.max(CHAT_W_MIN, Math.round(w))) : CHAT_W_DEFAULT;
const clampChatOpacity = (o) =>
  Number.isFinite(o) ? Math.min(CHAT_OP_MAX, Math.max(CHAT_OP_MIN, Math.round(o))) : CHAT_OP_DEFAULT;

export function applyChatSettings() {
  const col = $("chat-col");
  const view = $("player-view");
  if (!col || !view) return;
  col.classList.toggle("hide-ts", lsGet("ts.chatTimestamps") === "0");
  col.classList.toggle("short-names", lsGet("ts.chatShortNames") === "1");
  col.classList.toggle("hide-bots", lsGet("ts.chatHideBots") === "1");
  col.classList.toggle("hide-cmds", lsGet("ts.chatHideCmds") === "1");
  view.classList.toggle("chat-overlay", lsGet("ts.chatOverlay") === "1");
  view.style.setProperty("--chat-op",
    String(clampChatOpacity(parseFloat(lsGet("ts.chatOpacity"))) / 100));
  const w = parseFloat(lsGet("ts.chatWidth"));
  // No stored width: drop the override so the stylesheet's responsive default
  // (380px, 300px on narrow windows) takes over again.
  if (Number.isFinite(w)) view.style.setProperty("--chat-w", clampChatWidth(w) + "%");
  else view.style.removeProperty("--chat-w");
}

export function setupChatSettings() {
  applyChatSettings();
  if (csBound) return;
  csBound = true;

  const btn = $("chat-settings-btn");
  const pop = $("chat-settings-pop");
  const tsBox = $("cs-timestamps");
  const shortBox = $("cs-shortnames");
  const botBox = $("cs-hidebots");
  const cmdBox = $("cs-hidecmds");
  const width = $("cs-width");
  const widthVal = $("cs-width-val");
  const overlayBox = $("cs-overlay");
  const opRange = $("cs-opacity");
  const opVal = $("cs-op-val");
  const opBlock = $("cs-op-block");

  const syncControls = () => {
    tsBox.checked = lsGet("ts.chatTimestamps") !== "0";
    shortBox.checked = lsGet("ts.chatShortNames") === "1";
    botBox.checked = lsGet("ts.chatHideBots") === "1";
    cmdBox.checked = lsGet("ts.chatHideCmds") === "1";
    overlayBox.checked = lsGet("ts.chatOverlay") === "1";
    // The opacity slider only means anything in overlay mode, so it appears
    // with it rather than sitting there inert.
    opBlock.hidden = !overlayBox.checked;
    const op = clampChatOpacity(parseFloat(lsGet("ts.chatOpacity")));
    opRange.value = String(op);
    opVal.textContent = op + "%";
    const stored = parseFloat(lsGet("ts.chatWidth"));
    // Unset: seed the slider from the column's real width so it starts under
    // the viewer's thumb instead of jumping on the first drag.
    const cur = Number.isFinite(stored)
      ? clampChatWidth(stored)
      : clampChatWidth(window.innerWidth > 0
        ? ($("chat-col").offsetWidth / window.innerWidth) * 100
        : NaN);
    width.value = String(cur);
    widthVal.textContent = cur + "%";
  };
  const open = () => { syncControls(); pop.hidden = false; btn.classList.add("open"); };
  const close = () => { pop.hidden = true; btn.classList.remove("open"); };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.hidden ? open() : close();
  });
  pop.addEventListener("click", (e) => e.stopPropagation()); // clicks inside stay inside
  document.addEventListener("click", () => { if (!pop.hidden) close(); });
  // Escape leaves the player, so an open panel has to claim the key first.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }, true);

  tsBox.addEventListener("change", () => {
    lsSet("ts.chatTimestamps", tsBox.checked ? "1" : "0");
    applyChatSettings();
  });
  shortBox.addEventListener("change", () => {
    lsSet("ts.chatShortNames", shortBox.checked ? "1" : "0");
    applyChatSettings();
  });
  botBox.addEventListener("change", () => {
    lsSet("ts.chatHideBots", botBox.checked ? "1" : "0");
    applyChatSettings();
  });
  cmdBox.addEventListener("change", () => {
    lsSet("ts.chatHideCmds", cmdBox.checked ? "1" : "0");
    applyChatSettings();
  });
  overlayBox.addEventListener("change", () => {
    lsSet("ts.chatOverlay", overlayBox.checked ? "1" : "0");
    opBlock.hidden = !overlayBox.checked;
    applyChatSettings();
  });
  opRange.addEventListener("input", () => {
    const v = clampChatOpacity(parseFloat(opRange.value));
    opVal.textContent = v + "%";
    lsSet("ts.chatOpacity", String(v));
    applyChatSettings();
  });
  width.addEventListener("input", () => {
    const v = clampChatWidth(parseFloat(width.value));
    widthVal.textContent = v + "%";
    lsSet("ts.chatWidth", String(v));
    applyChatSettings();
  });
  $("cs-reset").addEventListener("click", () => {
    lsDel("ts.chatWidth");
    lsDel("ts.chatTimestamps");
    lsDel("ts.chatShortNames");
    lsDel("ts.chatHideBots");
    lsDel("ts.chatHideCmds");
    lsDel("ts.chatOverlay");
    lsDel("ts.chatOpacity");
    applyChatSettings();
    syncControls(); // reflect the restored defaults without closing the panel
  });
}

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
    this.emoteTip = $("emote-tip");

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
    // Locally cached BTTV/7TV emotes (built by `server.py --sync-emotes`) fill
    // in emotes missing from this VOD's embedded set. Fetched in parallel with
    // the chat download; absent cache resolves to null and costs nothing.
    const manifestP = fetch("/emotes/manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
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
      const manifest = await manifestP;
      if (this._destroyed) return;
      if (manifest) this._mergeEmoteManifest(manifest);
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
    this.emoteTip.hidden = true;
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

  // Cached emotes only fill gaps: an emote embedded in the chat JSON is the
  // version that was live when the VOD was downloaded, so it always wins.
  // Manifest w/h are raw file pixels at `scale`; makeImg wants display px.
  _mergeEmoteManifest(manifest) {
    const emotes = manifest && manifest.emotes;
    if (!emotes || typeof emotes !== "object") return;
    if (!this.thirdParty) this.thirdParty = new Map();
    for (const [name, m] of Object.entries(emotes)) {
      if (!name || !m || !m.file || this.thirdParty.has(name)) continue;
      const scale = m.scale > 0 ? m.scale : 2;
      this.thirdParty.set(name, {
        url: "/emotes/" + encodeURIComponent(m.file),
        w: m.w > 0 ? Math.max(1, Math.round(m.w / scale)) : 28,
        h: m.h > 0 ? Math.max(1, Math.round(m.h / scale)) : 28,
        zw: !!m.zw,
      });
    }
  }

  // ---- message rendering -------------------------------------------------

  _renderMsg(c) {
    const msg = el("div", "msg");
    msg.append(el("span", "ts", fmtTime(c.content_offset_seconds || 0, this._showHours)));

    const m = c.message || {};
    let isBot = false;
    for (const b of m.user_badges || []) {
      const info = this.badges.get(b._id + "/" + b.version);
      if (b._id === BOT_BADGE_ID || (info && info.title === BOT_BADGE_TITLE)) isBot = true;
      if (!info) continue;
      const img = new Image(18, 18);
      img.className = "badge";
      img.src = info.url;
      img.alt = info.title;
      img.title = info.title;
      msg.append(img);
    }

    const commenter = c.commenter || {};
    const full = commenter.display_name || commenter.name || "?";
    const name = el("span", "name");
    name.style.color = readableColor(m.user_color || colorHash(commenter.name || commenter.display_name));
    // Always split off everything after the first character into its own span:
    // the "shorten names" setting then collapses it with CSS alone, so the
    // toggle applies instantly to messages already on screen and the full name
    // stays in the DOM for selection and copy. Array.from splits by code point,
    // so a display name starting with an emoji or a surrogate pair stays whole.
    const chars = Array.from(full);
    name.append(document.createTextNode(chars[0] || "?"));
    if (chars.length > 1) name.append(el("span", "nm-rest", chars.slice(1).join("")));
    msg.append(name, document.createTextNode(": "));

    const body = el("span", "body");
    this._renderBody(body, m);
    msg.append(body);

    // Tagged, not skipped: the filters are CSS, so toggling one takes effect on
    // messages already rendered instead of waiting for the next rebuild.
    if (isBot) msg.classList.add("is-bot");
    const text = typeof m.body === "string" && m.body
      ? m.body
      : (m.fragments || []).map((f) => (f && f.text) || "").join("");
    if (CMD_RE.test(text)) msg.classList.add("is-cmd");
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
      // No title attribute: the hover tooltip below shows the name instantly
      // instead of waiting out the browser's ~1s title delay.
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
    // Delegated: messages come and go constantly, so per-emote listeners would
    // be churned thousands of times over a stream.
    this._on(this.box, "mouseover", (e) => {
      const img = e.target.closest && e.target.closest("img.emote");
      if (img) this._showEmoteTip(img);
    });
    this._on(this.box, "mouseout", (e) => {
      if (e.target.closest && e.target.closest("img.emote")) this._hideEmoteTip();
    });
  }

  _showEmoteTip(img) {
    const name = img.alt;
    if (!name) return;
    const tip = this.emoteTip;
    tip.textContent = name;
    tip.hidden = false;
    // Measure after unhiding ([hidden] is display:none, so width reads 0), then
    // clamp so a long emote name never pokes off the side of the window.
    const r = img.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const x = Math.min(window.innerWidth - half - 4, Math.max(half + 4, r.left + r.width / 2));
    tip.style.left = x + "px";
    tip.style.top = Math.max(tip.offsetHeight + 4, r.top - 4) + "px";
  }

  _hideEmoteTip() {
    this.emoteTip.hidden = true;
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
    // Whether the scroll came from the viewer or from auto-scroll, whatever the
    // pointer was over has moved — drop the tooltip rather than strand it.
    this._hideEmoteTip();
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
