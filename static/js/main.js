// Bootstrap: routing between the library picker and the player, lifecycle.

import { setupLibrary, renderLibrary, renderFolders, showNotice } from "./library.js";
import { Player } from "./player.js";
import { Chat } from "./chat.js";
import { sortVods, lsGet, lsSet } from "./util.js";
import { setThumbsPaused } from "./thumbs.js";

const state = {
  vods: [],    // server order (mtime desc) — findVod's domain
  sorted: [],  // current display order — what the library renders and autoplay walks
  folderCount: 1,
  player: null,
  chat: null,
  current: null,
  pushedFromLibrary: false,
};

const currentSort = () => (lsGet("ts.sort") === "old" ? "old" : "new");

const libraryView = document.getElementById("library-view");
const playerView = document.getElementById("player-view");

async function fetchAll() {
  const [vods, folders] = await Promise.all([
    fetch("/api/videos").then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch("/api/folders").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  state.vods = vods;
  state.sorted = sortVods(state.vods, currentSort());
  state.folderCount = folders && folders.folders ? folders.folders.length : 1;
  return folders;
}

async function refreshLibrary() {
  const folders = await fetchAll();
  if (folders) renderFolders(folders);
  renderLibrary(state.sorted, state.folderCount > 1);
}

function findVod(id) {
  // Bookmarks made before multi-folder support carried the bare stem.
  return state.vods.find((v) => v.id === id) || state.vods.find((v) => v.stem === id) || null;
}

function showLibrary(notice) {
  playerView.hidden = true;
  libraryView.hidden = false;
  document.title = "TwitchSync";
  showNotice(notice);
  setThumbsPaused(false);
  renderLibrary(state.sorted, state.folderCount > 1);
}

function openVod(vod, { push = false, replace = false } = {}) {
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

  state.player = new Player(vod, { onEnded: () => playNext(vod) });
  state.chat = new Chat(vod, state.player.video, {
    onHistogram: (buckets) => state.player && state.player.drawHistogram(buckets),
  });
  state.player.start();
  state.chat.load();
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
}

async function backToLibrary({ refetch = true } = {}) {
  closePlayer();
  if (refetch) await refreshLibrary();
  showLibrary();
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

document.getElementById("back-btn").addEventListener("click", () => {
  if (state.pushedFromLibrary) {
    history.back(); // popstate handler does the teardown
  } else {
    history.replaceState({}, "", location.pathname);
    backToLibrary();
  }
});

setupLibrary({
  onOpen: (vod) => openVod(vod, { push: true }),
  onRefresh: refreshLibrary,
  onSortChange: (dir) => {
    lsSet("ts.sort", dir);
    state.sorted = sortVods(state.vods, dir);
    renderLibrary(state.sorted, state.folderCount > 1);
  },
});

route();
