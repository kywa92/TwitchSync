// Bootstrap: routing between the library picker and the player, lifecycle.

import { setupLibrary, renderLibrary, renderOrphans, renderFolders, showNotice,
         setChatCheck, renderCheckChip, scrollToVod } from "./library.js";
import { Player } from "./player.js";
import { Chat, setupChatSettings } from "./chat.js";
import { sortVods, currentSortBy, currentSortDir, distinctFilterValues,
         vodMatchesFilters, readFilter, fmtDate, lsGet, lsSet } from "./util.js";
import { setThumbsPaused, setThumbsServerGen } from "./thumbs.js";

const state = {
  vods: [],    // server order (mtime desc) — findVod's domain
  sorted: [],  // current display order — what the library renders and autoplay walks
  orphans: [], // date-stamped mp4/json files missing their other half
  folderCount: 1,
  player: null,
  chat: null,
  current: null,
  pushedFromLibrary: false,
  returnScrollY: null,  // library scroll position captured when a video was opened
  checkKey: "",         // identity of the flag set we last received
  renderedCheckKey: "", // ...and the one currently painted into the list
};

let checkTimer = null;

const libraryView = document.getElementById("library-view");
const playerView = document.getElementById("player-view");

// Effective filter selections: stored values intersected with what actually
// exists in the current library, so a selection referencing only an offline
// NAS's streamers degrades to "show all" instead of an empty page.
function currentFilters() {
  const avail = distinctFilterValues(state.vods);
  const eff = (kind) => {
    const have = new Set(avail[kind].map((r) => r.name.toLowerCase()));
    return new Set(readFilter(kind).map((s) => s.toLowerCase()).filter((s) => have.has(s)));
  };
  return { streamers: eff("streamers"), games: eff("games") };
}

function filterVods(vods) {
  const sel = currentFilters();
  if (!sel.streamers.size && !sel.games.size) return vods;
  return vods.filter((v) => vodMatchesFilters(v, sel));
}

function resort() {
  state.sorted = sortVods(filterVods(state.vods), currentSortDir(), currentSortBy());
}

async function fetchAll() {
  const [raw, folders] = await Promise.all([
    fetch("/api/videos").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("/api/folders").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  // {videos, thumbGen, chatCheck} envelope; tolerate the pre-envelope bare array.
  setThumbsServerGen(!!(raw && raw.thumbGen));
  applyCheck(raw && raw.chatCheck, 1500);
  setVersionTag(raw);
  state.vods = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.videos) ? raw.videos : []);
  state.orphans = raw && Array.isArray(raw.orphans) ? raw.orphans : [];
  resort();
  state.folderCount = folders && folders.folders ? folders.folders.length : 1;
  return folders;
}

// "v1.1 · Aug 12, 2026" at the page's top right; the server derives the date
// from its source files' mtimes at startup.
function setVersionTag(raw) {
  if (!raw || !raw.version) return; // older server — leave the tag hidden
  const tag = document.getElementById("version-tag");
  tag.textContent = "v" + raw.version +
    (raw.buildMtime ? " · " + fmtDate(raw.buildMtime) : "");
  tag.hidden = false;
}

// Every render records which flag set it painted, so the check poll can tell
// whether a re-render is actually needed.
function render() {
  state.renderedCheckKey = state.checkKey;
  renderLibrary(state.sorted, state.folderCount > 1, state.vods.length);
  renderOrphans(state.orphans, state.folderCount > 1,
                (o) => openVod(orphanToVod(o), { push: true }));
}

// A playable orphan mp4 dressed as a vod: title from the filename, duration
// left to the video element, and isOrphan drives the chat-less player mode.
function orphanToVod(o) {
  return {
    id: o.id, stem: o.stem, title: o.stem, streamer: "", game: "",
    durationSec: null, sizeBytes: o.sizeBytes, mtime: o.mtime, chapters: [],
    rootId: o.rootId, rootLabel: o.rootLabel, folder: o.folder,
    isOrphan: true,
  };
}

async function refreshLibrary() {
  const folders = await fetchAll();
  if (folders) renderFolders(folders);
  render();
}

// The chat/VOD check runs in a background thread on the server and finishes
// well after the first page load, so poll until it's done. Deliberately does
// NOT re-render on every poll: renderLibrary rebuilds every <img>, which would
// re-drive thumbnail generation each time. Only the toolbar chip updates until
// the flag set actually changes.
function applyCheck(d, delay) {
  if (!d || typeof d !== "object") return; // older server — leave the UI alone
  state.checkKey = JSON.stringify(d.flagged || {});
  setChatCheck(d);
  clearTimeout(checkTimer);
  checkTimer = d.checking ? setTimeout(pollCheck, delay) : null;
}

async function pollCheck() {
  checkTimer = null;
  const d = await fetch("/api/chat-check")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!d) return; // server gone — stop quietly rather than retrying forever
  applyCheck(d, 3000);
  if (!d.checking && state.checkKey !== state.renderedCheckKey) render();
  else renderCheckChip();
}

function findVod(id) {
  // Bookmarks made before multi-folder support carried the bare stem.
  const vod = state.vods.find((v) => v.id === id) || state.vods.find((v) => v.stem === id);
  if (vod) return vod;
  // Deep links / reloads on ?v=orphan:… — only mp4 orphans are playable.
  const o = state.orphans.find((x) => x.id === id && x.kind === "mp4");
  return o ? orphanToVod(o) : null;
}

function showLibrary(notice) {
  // Every caller has already rendered the library (refreshLibrary or the
  // explicit render in backToLibrary) — rendering here too would double every
  // thumbnail fetch per page load.
  playerView.hidden = true;
  libraryView.hidden = false;
  document.title = "TwitchSync";
  showNotice(notice);
  setThumbsPaused(false);
}

function openVod(vod, { push = false, replace = false } = {}) {
  // Remember exactly where the list was scrolled when the viewer left it, so
  // Back / Escape returns them there. Only a push is a genuine open from the
  // (visible) library; autoplay (replace) and deep links keep the captured spot.
  if (push && !libraryView.hidden) state.returnScrollY = window.scrollY;
  closePlayer();
  if (push) {
    history.pushState({ v: vod.id }, "", "?v=" + encodeURIComponent(vod.id));
    state.pushedFromLibrary = true;
  } else if (replace) {
    // Autoplay chain: the whole run stays one history entry, so Back still
    // lands on the library once instead of replaying every VOD in reverse.
    history.replaceState({ v: vod.id }, "", "?v=" + encodeURIComponent(vod.id));
  }
  state.current = vod;
  lsSet("ts.lastPlayed", vod.id);
  setThumbsPaused(true); // playback owns the NAS bandwidth
  libraryView.hidden = true;
  playerView.hidden = false;
  document.title = vod.title + " — TwitchSync";

  // Orphan mp4s have no chat file: hide the chat column entirely (the chat
  // may already be burned into the video) and skip the Chat instance.
  playerView.classList.toggle("no-chat", !!vod.isOrphan);
  state.player = new Player(vod, { onEnded: () => playNext(vod), onBack: goBack });
  state.chat = vod.isOrphan ? null : new Chat(vod, state.player.video, {
    onHistogram: (buckets) => state.player && state.player.drawHistogram(buckets),
  });
  state.player.start();
  if (state.chat) state.chat.load();
}

function playNext(cur) {
  if (state.current && state.current.id !== cur.id) return; // stale player callback
  if (lsGet("ts.autoplayNext") !== "1") return;
  const list = state.sorted.length ? state.sorted : state.vods;
  let i = list.findIndex((v) => v.id === cur.id);
  if (i < 0) i = list.findIndex((v) => v.stem === cur.stem); // stale-bookmark tolerance
  const next = i >= 0 ? list[i + 1] : null;
  if (!next) return; // end of the list
  openVod(next, { replace: true });
  state.player.showToast("Playing next: " + next.title);
}

function closePlayer() {
  if (state.player) state.player.destroy();
  if (state.chat) state.chat.destroy();
  state.player = state.chat = state.current = null;
  playerView.classList.remove("no-chat"); // next open is a normal layout again
}

async function backToLibrary({ refetch = true } = {}) {
  const returnId = state.current && state.current.id; // capture before closePlayer nulls it
  closePlayer();
  if (refetch) await refreshLibrary();
  else render();
  showLibrary();
  // After showLibrary() un-hides the list (a hidden list has no geometry):
  // restore the exact scroll position from when the video was opened. The sort
  // order is unchanged (it lives in localStorage, untouched during playback),
  // so the same rows sit at the same offset. Deep-link returns have no captured
  // position — center the row that was playing instead.
  if (state.returnScrollY != null) {
    window.scrollTo(0, state.returnScrollY);
    state.returnScrollY = null;
  } else {
    scrollToVod(returnId);
  }
}

async function route() {
  const id = new URLSearchParams(location.search).get("v");
  await refreshLibrary();
  if (id) {
    let vod = findVod(id);
    if (!vod) {
      await refreshLibrary();
      vod = findVod(id);
    }
    if (vod) {
      openVod(vod, { push: false });
      return;
    }
    history.replaceState({}, "", location.pathname);
    showLibrary("Video not found — it may have been moved, renamed, or its folder unmounted.");
    return;
  }
  showLibrary();
}

window.addEventListener("popstate", () => {
  const id = new URLSearchParams(location.search).get("v");
  if (!id) {
    backToLibrary();
    return;
  }
  if (state.current && state.current.id === id) return;
  const vod = findVod(id);
  if (vod) openVod(vod, { push: false });
  else route();
});

function goBack() {
  if (state.pushedFromLibrary) {
    history.back(); // popstate handler does the teardown
  } else {
    history.replaceState({}, "", location.pathname);
    backToLibrary();
  }
}
// Two back buttons: the chat header's, and the controls-row one that appears
// in chat-less (orphan) playback where the chat column is hidden.
document.getElementById("back-btn").addEventListener("click", goBack);
document.getElementById("back-btn-ctl").addEventListener("click", goBack);

setupChatSettings();

setupLibrary({
  onOpen: (vod) => openVod(vod, { push: true }),
  onRefresh: refreshLibrary,
  onRerender: render,
  onSortChange: ({ by, dir }) => {
    lsSet("ts.sortBy", by);
    lsSet("ts.sort", dir);
    resort();
    render();
  },
  onFilterChange: (kind, values) => {
    lsSet("ts.filter." + kind, JSON.stringify(values));
    resort();
    render();
  },
  onFilterClear: () => {
    lsSet("ts.filter.streamers", "[]");
    lsSet("ts.filter.games", "[]");
    resort();
    render();
  },
  getFilterData: () => distinctFilterValues(state.vods),
});

route();
