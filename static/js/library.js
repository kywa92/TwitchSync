// Library picker view: the VOD list plus the library-folder manager.

import { el, fmtTime, fmtBytes, fmtDate, stemDatePrefix, sortVods,
         SORT_DEFAULT_DIR, currentSortBy, currentSortDir, readFilter,
         lsGet, lsSet, lsDel, lsKeys } from "./util.js";
import { resetThumbs, registerThumbImg, queueThumb } from "./thumbs.js";

const $ = (id) => document.getElementById(id);

let handlers = { onOpen: () => {}, onRefresh: () => {}, onSortChange: () => {}, onRerender: () => {} };
let bound = false;

// Chat/VOD check results from the server, refreshed by main.js while the
// startup pass is still running.
let chatCheck = { checking: false, done: 0, total: 0, flagged: {} };

export function setChatCheck(d) {
  chatCheck = d && typeof d === "object" ? d : { flagged: {} };
}

export function setupLibrary(h) {
  handlers = h;
  if (bound) return;
  bound = true;

  $("folders-toggle").addEventListener("click", () => {
    const panel = $("folders-panel");
    panel.hidden = !panel.hidden;
    $("folders-toggle").classList.toggle("open", !panel.hidden);
    if (!panel.hidden) $("folder-path").focus();
  });
  $("folder-add").addEventListener("click", addFolder);
  $("folder-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addFolder();
  });

  $("chat-check-status").addEventListener("click", () => {
    const row = document.querySelector("#vod-list li.flagged");
    if (!row) return;
    // Chrome suspends smooth-scroll animations while the document is hidden
    // (it always is inside an embedded preview pane), so jump instantly there
    // rather than silently doing nothing.
    row.scrollIntoView({ behavior: document.hidden ? "auto" : "smooth", block: "center" });
  });

  // Switching keys resets to that key's natural direction; the arrow flips it.
  $("sort-by").addEventListener("change", (e) => {
    handlers.onSortChange({ by: e.target.value, dir: SORT_DEFAULT_DIR[e.target.value] || "desc" });
  });
  $("sort-dir").addEventListener("click", () => {
    handlers.onSortChange({
      by: currentSortBy(),
      dir: currentSortDir() === "asc" ? "desc" : "asc",
    });
  });
  setupFilterButton("streamers");
  setupFilterButton("games");
  // One outside-click/Escape closer for both popovers.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".filter-wrap")) closeFilterPops();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFilterPops();
  });
  $("filter-clear").addEventListener("click", () => handlers.onFilterClear());
  $("autoplay-next").addEventListener("change", (e) => {
    lsSet("ts.autoplayNext", e.target.checked ? "1" : "0");
  });
  // Wiping every saved position is one stray toolbar click away, so commit
  // only after an explicit confirmation. Prefs (sort, volume, autoplay, speed)
  // are deliberately untouched — this is play history only.
  $("reset-history").addEventListener("click", async () => {
    if (!(await confirmDialog("Are you sure? This clears the watched position for every video."))) return;
    const keys = lsKeys("ts.pos.");
    for (const k of keys) lsDel(k);
    lsDel("ts.lastPlayed");
    handlers.onRerender();
    showNotice(keys.length
      ? "Cleared play history for " + keys.length + " video" + (keys.length === 1 ? "" : "s") + "."
      : "Cleared play history.");
  });
}

// ---- filter popovers ----------------------------------------------------
// Contents are rebuilt from live library data every time a popover opens, so
// they never go stale and the (static) toolbar DOM survives list re-renders —
// an open popover stays open while the filtered list repaints behind it.

function setupFilterButton(kind) {
  const btn = $("filter-" + kind + "-btn");
  const pop = $("filter-" + kind + "-pop");
  btn.addEventListener("click", () => {
    const wasOpen = !pop.hidden;
    closeFilterPops();
    if (!wasOpen) {
      buildFilterPop(kind);
      pop.hidden = false;
      btn.classList.add("open");
    }
  });
}

function closeFilterPops() {
  for (const pop of document.querySelectorAll(".filter-pop")) pop.hidden = true;
  for (const btn of document.querySelectorAll(".filter-btn")) btn.classList.remove("open");
}

function buildFilterPop(kind) {
  const pop = $("filter-" + kind + "-pop");
  pop.textContent = "";
  const data = (handlers.getFilterData ? handlers.getFilterData() : {})[kind] || [];
  if (!data.length) {
    pop.append(el("div", "filter-none", "Nothing to filter by yet."));
    return;
  }
  const selected = new Set(readFilter(kind).map((s) => s.toLowerCase()));
  const clear = el("button", "filter-clear-row", "Clear selection");
  clear.hidden = selected.size === 0;
  clear.addEventListener("click", () => {
    handlers.onFilterChange(kind, []);
    buildFilterPop(kind); // stay open with the boxes visibly unchecked
  });
  pop.append(clear);
  for (const { name, count } of data) {
    const label = el("label", "filter-opt");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(name.toLowerCase());
    cb.dataset.name = name;
    cb.addEventListener("change", () => {
      const values = [...pop.querySelectorAll("input:checked")].map((c) => c.dataset.name);
      handlers.onFilterChange(kind, values);
      clear.hidden = values.length === 0;
    });
    label.append(cb, el("span", "filter-name", name), el("span", "filter-n", String(count)));
    pop.append(label);
  }
}

// Promise-based confirm modal (#confirm-overlay in index.html). Cancel is the
// safe default: it takes focus, and Escape or a backdrop click also cancel.
// No focus trap — fine for a local single-user tool.
let confirmBound = false;
let confirmResolve = null;
let confirmReturnFocus = null;

function settleConfirm(result) {
  if (!confirmResolve) return;
  $("confirm-overlay").hidden = true;
  const resolve = confirmResolve;
  confirmResolve = null;
  if (confirmReturnFocus && confirmReturnFocus.isConnected) confirmReturnFocus.focus();
  confirmReturnFocus = null;
  resolve(result);
}

function confirmDialog(message, yesLabel = "Yes") {
  if (!confirmBound) {
    confirmBound = true;
    $("confirm-yes").addEventListener("click", () => settleConfirm(true));
    $("confirm-cancel").addEventListener("click", () => settleConfirm(false));
    $("confirm-overlay").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) settleConfirm(false); // backdrop, not the panel
    });
    document.addEventListener("keydown", (e) => {
      if ($("confirm-overlay").hidden) return;
      if (e.key === "Escape") { e.preventDefault(); settleConfirm(false); }
    });
  }
  confirmReturnFocus = document.activeElement;
  $("confirm-msg").textContent = message;
  $("confirm-yes").textContent = yesLabel;
  $("confirm-overlay").hidden = false;
  $("confirm-cancel").focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}

// The player's autoplay button writes the same localStorage keys, so re-read
// them on every render to keep the toolbar honest.
function syncToolbar() {
  $("sort-by").value = currentSortBy();
  const dir = currentSortDir();
  const dirBtn = $("sort-dir");
  dirBtn.textContent = dir === "asc" ? "↑" : "↓";
  dirBtn.title = dir === "asc"
    ? "Ascending — click for descending" : "Descending — click for ascending";
  // Badge shows the *effective* selection count (values that exist in the
  // current library), matching what the list actually filters by.
  const avail = handlers.getFilterData ? handlers.getFilterData() : null;
  for (const kind of ["streamers", "games"]) {
    const btn = $("filter-" + kind + "-btn");
    const have = avail ? new Set(avail[kind].map((r) => r.name.toLowerCase())) : null;
    const n = readFilter(kind).filter((s) => !have || have.has(s.toLowerCase())).length;
    const badge = btn.querySelector(".filter-count");
    badge.textContent = String(n);
    badge.hidden = n === 0;
    btn.classList.toggle("active", n > 0);
  }
  $("autoplay-next").checked = lsGet("ts.autoplayNext") === "1";
  $("reset-history").hidden = lsKeys("ts.pos.").length === 0 && !lsGet("ts.lastPlayed");
  renderCheckChip();
}

// Instantly center a VOD's row (used when returning from the player, so the
// list picks up where the viewer left off instead of at the top).
export function scrollToVod(id) {
  if (!id) return;
  // CSS.escape is load-bearing: real ids contain ":", spaces, brackets, "@".
  // Not scoped to #vod-list — orphan rows live in #orphan-list.
  const row = document.querySelector('li[data-vod-id="' + CSS.escape(id) + '"]');
  if (row) row.scrollIntoView({ behavior: "auto", block: "center" });
}

// Split out from the render so the check poll can update just this control
// without rebuilding the list (which would re-drive thumbnail generation).
export function renderCheckChip() {
  const btn = $("chat-check-status");
  const n = Object.keys(chatCheck.flagged || {}).length;
  if (n > 0) {
    btn.hidden = false;
    btn.classList.remove("busy");
    btn.textContent = n === 1 ? "1 VOD needs checking" : n + " VODs need checking";
    btn.title = "Jump to the first VOD whose chat file may not match";
  } else if (chatCheck.checking) {
    btn.hidden = false;
    btn.classList.add("busy");
    btn.textContent = "Checking chat files…";
    btn.title = "Verifying that each chat JSON matches its video";
  } else {
    btn.hidden = true;
  }
}

export function renderLibrary(vods, multipleFolders, totalCount = vods.length) {
  const list = $("vod-list");
  list.textContent = "";
  $("lib-empty").hidden = totalCount > 0;
  $("filter-empty").hidden = !(totalCount > 0 && vods.length === 0);
  syncToolbar();
  resetThumbs();

  const lastPlayed = lsGet("ts.lastPlayed");
  for (const vod of vods) {
    const pos = parseFloat(lsGet("ts.pos." + vod.stem));
    const isLast = lastPlayed === vod.id;
    const btn = el("button", "vod-btn");

    const thumbBox = el("div", "vod-thumb-box");
    const img = new Image();
    img.className = "vod-thumb";
    img.alt = "";
    // Eager on purpose: lazy-loading stalls entirely in hidden/background tabs
    // (Chrome defers lazy images while document.hidden), which would freeze
    // thumbnail generation. The queue's concurrency cap is the real throttle.
    img.decoding = "async";
    img.addEventListener("load", () => img.classList.add("ready"));
    img.addEventListener("error", () => queueThumb(vod));
    registerThumbImg(vod, img);
    // &s versions the URL by file size: cached thumbs stay in the browser's
    // HTTP cache across loads, and a re-downloaded file busts it naturally.
    img.src = "/thumb?v=" + encodeURIComponent(vod.id) + "&s=" + vod.sizeBytes;
    thumbBox.append(img);
    btn.append(thumbBox);

    const body = el("div", "vod-body");
    // Lead with the stream date from the filename — the JSON metadata title
    // omits it. Skip when the title already is the stem (no-metadata fallback).
    const prefix = stemDatePrefix(vod.stem);
    const displayTitle = prefix && !vod.title.startsWith(prefix)
      ? prefix + " " + vod.title : vod.title;
    const title = el("div", "vod-title", displayTitle);
    if (isLast) title.append(el("span", "vod-chip", "Last played"));
    // A <span>, never a button: the whole card is a <button> and nesting one
    // inside it is invalid HTML.
    const flag = (chatCheck.flagged || {})[vod.id];
    if (flag) {
      const warn = el("span", "vod-chip warn", "Check");
      warn.title = flag.message || "This chat file may not match this video.";
      title.append(warn);
    }
    body.append(title);
    const meta = [
      vod.streamer,
      vod.game,
      vod.durationSec != null ? fmtTime(vod.durationSec) : null,
      fmtBytes(vod.sizeBytes),
      fmtDate(vod.mtime),
    ].filter(Boolean).join(" • ");
    body.append(el("div", "vod-meta", meta));
    // Only worth showing where a VOD lives once there's more than one folder.
    if (multipleFolders) {
      const where = vod.folder ? `${vod.rootLabel} / ${vod.folder}` : vod.rootLabel;
      body.append(el("div", "vod-where", where));
    }
    btn.append(body);

    if (Number.isFinite(pos) && vod.durationSec > 0) {
      const bar = el("div", "vod-progress");
      const fill = el("div", "vod-progress-fill");
      fill.style.width = Math.min(100, (pos / vod.durationSec) * 100) + "%";
      bar.append(fill);
      btn.append(bar);
    }

    btn.addEventListener("click", () => handlers.onOpen(vod));

    const li = el("li");
    li.dataset.vodId = vod.id; // scroll target for scrollToVod
    if (flag) li.classList.add("flagged"); // scroll target for the toolbar button
    li.append(btn);
    // Rows with any play history get a reset control — a sibling of the card
    // (the card is itself a <button>, so it can't nest one), overlaid at the
    // li's right edge.
    if (Number.isFinite(pos) || isLast) {
      li.classList.add("has-reset");
      const reset = el("button", "vod-reset", "↺");
      reset.title = "Reset play history";
      reset.setAttribute("aria-label", "Reset play history for " + vod.title);
      reset.addEventListener("click", () => {
        lsDel("ts.pos." + vod.stem);
        if (lsGet("ts.lastPlayed") === vod.id) lsDel("ts.lastPlayed");
        handlers.onRerender();
      });
      li.append(reset);
    }
    list.append(li);
  }
}

// Orphan halves (mp4 without json, json without mp4) at the bottom of the
// page, so unpaired files are never silently invisible. Called right after
// renderLibrary — deliberately does NOT touch resetThumbs(), which
// renderLibrary already ran; a second reset would wipe the main list's
// thumbnail registrations mid-flight.
export function renderOrphans(orphans, multipleFolders, onOpenOrphan) {
  $("orphan-section").hidden = orphans.length === 0;
  const list = $("orphan-list");
  list.textContent = "";

  for (const o of sortVods(orphans, "desc", "date")) {
    const playable = o.kind === "mp4";
    const card = el(playable ? "button" : "div", "vod-btn orphan" + (playable ? "" : " inert"));

    const thumbBox = el("div", "vod-thumb-box");
    if (playable) {
      // Just enough of a vod shape for the thumbnail queue.
      const tv = { id: o.id, stem: o.stem, sizeBytes: o.sizeBytes, durationSec: null };
      const img = new Image();
      img.className = "vod-thumb";
      img.alt = "";
      img.decoding = "async";
      img.addEventListener("load", () => img.classList.add("ready"));
      img.addEventListener("error", () => queueThumb(tv));
      registerThumbImg(tv, img);
      img.src = "/thumb?v=" + encodeURIComponent(o.id) + "&s=" + o.sizeBytes;
      thumbBox.append(img);
    } else {
      thumbBox.classList.add("no-thumb");
    }
    card.append(thumbBox);

    const body = el("div", "vod-body");
    const title = el("div", "vod-title", o.stem);
    title.append(el("span", "vod-chip warn", playable ? "missing .json" : "missing .mp4"));
    body.append(title);
    const meta = [fmtBytes(o.sizeBytes), fmtDate(o.mtime)].filter(Boolean).join(" • ");
    body.append(el("div", "vod-meta", meta));
    if (multipleFolders) {
      const where = o.folder ? `${o.rootLabel} / ${o.folder}` : o.rootLabel;
      body.append(el("div", "vod-where", where));
    }
    card.append(body);

    if (playable) card.addEventListener("click", () => onOpenOrphan(o));

    const li = el("li");
    li.dataset.vodId = o.id; // scroll target for scrollToVod on return
    li.append(card);
    list.append(li);
  }
}

export function renderFolders(payload) {
  const { folders = [], volumes = [] } = payload || {};
  const list = $("folder-list");
  list.textContent = "";

  for (const f of folders) {
    const row = el("div", "folder-row");
    const main = el("div", "folder-main");

    const name = el("div", "folder-name");
    name.append(document.createTextNode(f.label));
    if (!f.removable) name.append(el("span", "folder-tag", "project folder"));
    main.append(name, el("div", "folder-path", f.path));
    row.append(main);

    const count = el("div", "folder-count",
      f.online ? `${f.videoCount} VOD${f.videoCount === 1 ? "" : "s"}` : "not mounted");
    if (!f.online) count.classList.add("offline");
    row.append(count);

    if (f.removable) {
      const rm = el("button", "folder-remove", "×");
      rm.title = "Remove this folder from the library";
      rm.setAttribute("aria-label", `Remove ${f.label}`);
      rm.addEventListener("click", () => removeFolder(f.id, f.label));
      row.append(rm);
    }

    const li = el("li");
    li.append(row);
    list.append(li);
  }

  const chips = $("volume-chips");
  chips.textContent = "";
  const known = new Set(folders.map((f) => f.path));
  for (const v of volumes) {
    if (known.has(v.path)) continue;
    const chip = el("button", "vol-chip", v.name);
    chip.title = v.path;
    chip.addEventListener("click", () => {
      const input = $("folder-path");
      input.value = v.path + "/";
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    chips.append(chip);
  }
}

// ---- mutations ----------------------------------------------------------

async function post(body) {
  const res = await fetch("/api/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* fall through to generic message */ }
  return { ok: res.ok && data.ok !== false, message: data.message || data.error || "Request failed." };
}

async function addFolder() {
  const input = $("folder-path");
  const path = input.value.trim();
  if (!path) { showMsg(false, "Enter a folder path."); return; }
  const btn = $("folder-add");
  btn.disabled = true;
  const { ok, message } = await post({ action: "add", path });
  btn.disabled = false;
  showMsg(ok, message);
  if (ok) input.value = "";
  await handlers.onRefresh();
}

async function removeFolder(id, label) {
  const { ok, message } = await post({ action: "remove", id });
  showMsg(ok, ok ? `Removed “${label}”. The files themselves were not touched.` : message);
  await handlers.onRefresh();
}

function showMsg(ok, text) {
  const p = $("folder-msg");
  p.textContent = text;
  p.className = ok ? "ok" : "err";
  p.hidden = false;
}

export function showNotice(text) {
  const box = $("lib-notice");
  box.textContent = text || "";
  box.hidden = !text;
}
