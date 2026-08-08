// Bootstrap: routing between the library picker and the player, lifecycle.

import { setupLibrary, renderLibrary, renderFolders, showNotice } from "./library.js";
import { Player } from "./player.js";
import { Chat } from "./chat.js";

const state = {
  vods: [],
  folderCount: 1,
  player: null,
  chat: null,
  current: null,
  pushedFromLibrary: false,
};

const libraryView = document.getElementById("library-view");
const playerView = document.getElementById("player-view");

async function fetchAll() {
  const [vods, folders] = await Promise.all([
    fetch("/api/videos").then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch("/api/folders").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  state.vods = vods;
  state.folderCount = folders && folders.folders ? folders.folders.length : 1;
  return folders;
}

async function refreshLibrary() {
  const folders = await fetchAll();
  if (folders) renderFolders(folders);
  renderLibrary(state.vods, state.folderCount > 1);
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
  renderLibrary(state.vods, state.folderCount > 1);
}

function openVod(vod, { push }) {
  closePlayer();
  if (push) {
    history.pushState({ v: vod.id }, "", "?v=" + encodeURIComponent(vod.id));
    state.pushedFromLibrary = true;
  }
  state.current = vod;
  libraryView.hidden = true;
  playerView.hidden = false;
  document.title = vod.title + " — TwitchSync";

  state.player = new Player(vod);
  state.chat = new Chat(vod, state.player.video, {
    onHistogram: (buckets) => state.player && state.player.drawHistogram(buckets),
  });
  state.player.start();
  state.chat.load();
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
});

route();
