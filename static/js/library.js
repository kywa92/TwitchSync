// Library picker view: the VOD list plus the library-folder manager.

import { el, fmtTime, fmtBytes, fmtDate } from "./util.js";

const $ = (id) => document.getElementById(id);

let handlers = { onOpen: () => {}, onRefresh: () => {} };
let bound = false;

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
}

export function renderLibrary(vods, multipleFolders) {
  const list = $("vod-list");
  list.textContent = "";
  $("lib-empty").hidden = vods.length > 0;

  for (const vod of vods) {
    const btn = el("button", "vod-btn");
    btn.append(el("div", "vod-title", vod.title));
    const meta = [
      vod.streamer,
      vod.game,
      vod.durationSec != null ? fmtTime(vod.durationSec) : null,
      fmtBytes(vod.sizeBytes),
      fmtDate(vod.mtime),
    ].filter(Boolean).join(" • ");
    btn.append(el("div", "vod-meta", meta));
    // Only worth showing where a VOD lives once there's more than one folder.
    if (multipleFolders) {
      const where = vod.folder ? `${vod.rootLabel} / ${vod.folder}` : vod.rootLabel;
      btn.append(el("div", "vod-where", where));
    }
    btn.addEventListener("click", () => handlers.onOpen(vod));

    const li = el("li");
    li.append(btn);
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
