Design a detailed implementation plan for a new greenfield project. Do NOT write any code to disk — return the plan as your final message.

# Project
"TwitchSync" — a locally hosted web app for watching downloaded Twitch VODs with synchronized chat replay. Directory: /Users/kylanwalters/Documents/GitHub/TwitchSync (brand new, no code yet, not a git repo, macOS).

The user downloads Twitch VODs with TwitchDownloader, producing per VOD: a main gameplay MP4, a chat-render MP4 (which we will NOT use), and a chat JSON. The app plays the main video with a chat column on the right rendered in HTML from the JSON, driven by the video clock — so scrubbing the video always shows chat from that moment. Layout per the user's reference screenshot: main video fills the left area (letterboxed on black), chat column ~380px on the right full height, single control bar at the bottom spanning the full width (play/pause, elapsed/total time like "3:00:15 / 13:01:18", seek bar, volume, fullscreen).

# Confirmed decisions (do not revisit)
- Chat rendered from JSON in HTML. The CHAT.mp4 files are ignored (but must not confuse file pairing).
- Library picker: server scans its folder for VODs, auto-pairs files, shows a picker; clicking one opens the player. Future VODs dropped in the folder just appear.
- Backend: Python 3.14 stdlib ONLY (no Node on machine, zero pip deps). Frontend: vanilla HTML/CSS/JS, no build step. Dark theme.

# Verified facts about the data
Example files in folder:
- `[1-27-26] summit1g - grinding to max level slowly @summit1g !starforge @StarforgeSystems.mp4` — 23.9 GB, H.264 High 1920x1080@60 + AAC, duration 24446s (~6h47m). moov atom at END of file (not faststart) — server MUST support HTTP Range requests or seeking/playback won't work.
- `[1-27-26] summit1g - ... @StarforgeSystems. - CHAT.mp4` — chat render, ignore (note the ". - CHAT.mp4" suffix; robust rule: exclude any .mp4 whose name contains " - CHAT").
- `[1-27-26] summit1g - ... @StarforgeSystems.json` — 90 MB TwitchDownloader chat JSON.
- `example.png` — reference screenshot.

Chat JSON structure (verified):
- Top-level: FileInfo, streamer{name,login,id}, clipper, video{title,id,length:24446,game,chapters[{startMilliseconds,lengthMilliseconds,description,gameDisplayName,...}]}, comments[20514], embeddedData.
- comments sorted by content_offset_seconds (33 → 24459, can slightly exceed video duration; clamp). Each: {_id, created_at, commenter{display_name, name}, message{body, bits_spent, fragments[{text, emoticon:null|{emoticon_id}}], user_badges[{_id, version}], user_color ("#FF0000" or absent/null for some users), emoticons[{_id, begin, end}]}}.
- embeddedData.firstParty[364]: {id, imageScale:2, data: base64 PNG, name: null, width, height} — matched by emoticon_id from fragments.
- embeddedData.thirdParty[479]: {id, imageScale:2, data: base64 PNG, name: ":tf:" etc, width, height, isZeroWidth: bool} — BTTV/FFZ/7TV emotes matched by NAME against whitespace-split words in text fragments; isZeroWidth emotes overlay on top of the previous emote.
- embeddedData.twitchBadges[102]: {name, versions: {version → object with image data}} — matched from user_badges by name+version.
- embeddedData.twitchBits[1]: {prefix:"Cheer", tierList} — only 1 comment in this VOD has bits_spent>0, so cheermote rendering is a low-priority fallback (plain text acceptable).
- Emote base64 decodes to PNG (magic verified). Should be turned into Blob URLs once at load.

# Constraints & known pitfalls to address in the design
- Python stdlib http.server has NO Range support (verified) — must implement: 206 Partial Content, Content-Range, Accept-Ranges, single-range parsing, chunked streaming (~1MB chunks), and graceful handling of BrokenPipeError/ConnectionResetError because scrubbing a 24GB file generates many aborted range requests (no traceback spam). Use ThreadingHTTPServer. Bind 127.0.0.1. Path-traversal protection on media paths (resolve and verify within root dir).
- 90MB JSON load in browser: fetch with progress (Content-Length known → streamed reader progress bar), then JSON.parse (~1-2s). Show a loading overlay. No preprocessing step, no IndexedDB caching in v1.
- Chat renderer: window into comments array via binary search on seek; sliding pointer on timeupdate; DOM capped at ~200 messages (drop oldest); auto-scroll pinned to bottom with "chat paused" pill when user scrolls up (click to resume). On backward seek, clear and rebuild window.
- Custom controls: play/pause, seek bar (click + drag scrub, buffered ranges shown, hover time tooltip), elapsed/total, volume slider + mute, playback speed menu, fullscreen (fullscreens the whole app layout including chat, not just the video element), auto-hiding controls in fullscreen, keyboard shortcuts (space/k play-pause, ←/→ ±5s, j/l ±10s, m mute, f fullscreen, ↑/↓ volume, 0-9 jump to %), remember playback position per VOD in localStorage and auto-resume.
- Seek bar extra: chat-activity histogram (messages per minute bucketed client-side, rendered as a subtle sparkline overlay on/above the seek track) to help find highlights.
- Library API: GET /api/videos returns VODs found: pairing rule = every *.mp4 whose name lacks " - CHAT" and that has a sibling same-stem .json; include title (stem), file sizes, duration if cheaply available (duration can come from the JSON's video.length — do NOT ffprobe server-side), game/streamer from JSON? (reading 90MB JSON server-side per listing is too slow — decide: either skip metadata or read it lazily/cache; simplest: picker shows filename-derived title only... but note the JSON video.title/game/length are nice. A cheap option: stream-parse only the head of the JSON file (video metadata appears before the comments array in TwitchDownloader output) — e.g. read first ~4KB and regex/partial-parse, with fallback to stem. Decide and specify.)
- Client routing: one page app — picker view at /, player at /?v=<encoded stem> (or similar). 

# Deliverable
Return a concrete implementation plan: exact file layout (e.g. server.py + static/index.html + static/app.js + static/style.css — or justify different), responsibilities per file, the server request-routing table, the chat rendering pipeline step by step (emote/badge map building, fragment→DOM algorithm including third-party name matching and zero-width overlays, message element structure), the playback/sync loop, seek-bar scrub interaction details (pointer events, scrub preview while dragging vs commit on release — pick one for a 24GB file: recommend commit-on-release with time tooltip while dragging, or live seek? justify briefly), fullscreen approach, error/edge handling (missing json, user with no color → deterministic color hash, emote id missing from embeds → fallback to text), and a manual verification checklist. Keep it executable by a competent engineer in one sitting, no external deps.

#######################################################-----------------____________________

# TwitchSync — Local VOD player with synced chat replay

## Context

The user downloads Twitch VODs with TwitchDownloader, which produces three files per VOD: a main gameplay MP4, a chat-render MP4, and a chat JSON. Today, watching gameplay with chat requires re-encoding both videos into one file. This project replaces that with a locally hosted web app: the main video plays on the left, a Twitch-style chat column renders on the right, and a single control bar at the bottom scrubs both — chat always shows messages from the current video time.

**Decisions confirmed with user:** chat is rendered in HTML from the JSON (the ` - CHAT.mp4` files are ignored — perfect sync by construction, crisp text); the app is a library: the server scans its folder, auto-pairs files, and shows a picker so future VOD downloads just appear.

**Stack (forced by environment):** Python 3.14 stdlib only (no Node installed, zero pip deps) + vanilla HTML/CSS/JS ES modules (no build step). Dark theme matching `example.png`.

## Verified facts the implementation must honor

- Main MP4: 23.9 GB, H.264+AAC 1080p60, 24446 s (~6h47m), **moov atom at EOF** → the server MUST support HTTP Range requests (stdlib `http.server` does not — verified) or playback/seeking fails.
- Chat JSON (90 MB, TwitchDownloader format): top-level order `FileInfo → streamer → clipper → video{title,length,game,chapters} → comments[20514] → embeddedData`. Comments sorted by `content_offset_seconds` (33→24459; can slightly exceed video duration — clamp). Each comment: `commenter{display_name,name}`, `message{body, bits_spent, fragments[{text, emoticon:null|{emoticon_id}}], user_badges[{_id,version}], user_color}`.
- `embeddedData`: `firstParty[364]` emotes matched by `emoticon_id`; `thirdParty[479]` matched by NAME against whitespace-split words in text fragments, with `isZeroWidth` overlay emotes (9 present); `twitchBadges[102]` — image is in `versions[ver].bytes`, keyed `name/version` (e.g. `subscriber/6`); `twitchBits[1]` (only 1 bits message in this VOD → plain-text fallback is fine).
- **Embedded images are mixed formats**: PNG + GIF + WebP (animated) — sniff magic bytes per asset for the Blob MIME (`\x89PNG` / `GIF8` / `RIFF…WEBP`). Declared `width`/`height` are the logical CSS size; stored bitmap is `width × imageScale` px — render at declared dims.
- 1,820 comments have no `user_color` → deterministic fallback color is mandatory: Twitch's own algorithm, `(first char code + last char code) % 15` into the standard 15-color palette.
- `streamer` + `video` metadata all appear within the first ~750 bytes of the JSON → library listing can head-parse 64 KB instead of loading 90 MB server-side.

## File layout (all new)

```
TwitchSync/
├── server.py                 # entire backend, stdlib only
└── static/
    ├── index.html            # single page: library view + player view, inline SVG icons
    ├── style.css             # dark theme, grid layout
    └── js/
        ├── main.js           # bootstrap, ?v= routing, open/close lifecycle, teardown
        ├── library.js        # picker rendering
        ├── player.js         # video, control bar, seek bar, fullscreen, keyboard, resume
        ├── chat.js           # chat fetch/parse, asset maps, fragment→DOM, sync engine
        └── util.js           # fmtTime, colorHash, upperBound, sniffImageMime, el()
```

VOD files stay in the project root next to `server.py`.

## server.py

Run: `python3 server.py [--dir PATH] [--port 8710] [--no-open]`. `ThreadingHTTPServer`, bound **127.0.0.1** only, `protocol_version = "HTTP/1.1"` (every response sets Content-Length), opens browser on start.

Routes:
| Path | Action |
|---|---|
| `/` | serve `static/index.html` (no-store) |
| `/static/<rel>` | static files; realpath must stay inside `static/` |
| `/api/videos` | rescan folder, pair, head-parse metadata → JSON list |
| `/chat?v=<stem>` | stream whole chat JSON, Content-Length set (browser progress bar needs it) |
| `/media?v=<stem>` | ranged MP4 streaming: 200 / 206 / 416 |

- **Pairing rule:** candidate = `*.mp4` whose name does NOT contain `" - CHAT"`, paired iff `stem + ".json"` exists. Response per VOD: `{stem, title, streamer, game, durationSec, sizeBytes, mtime, chapters}`, sorted by mtime desc.
- **Head metadata:** read first 64 KB, find `"streamer"` / `"video"` keys, parse each object with `json.JSONDecoder().raw_decode` (ignores truncated tail). Cache by `(path, size, mtime)`. Any failure → fallback `{title: stem}`.
- **Range support:** parse `bytes=start-end` / `start-` / `-suffix` (multi-range → serve first part; malformed → 200 full per spec). Clamp end to `size-1`; `start >= size` → 416 with `Content-Range: bytes */size`. 206 responses set `Content-Range`, `Content-Length`, `Accept-Ranges: bytes`. Stream in 1 MB chunks from `seek(start)`.
- **Traceback hygiene (critical — scrubbing a 24 GB file aborts many requests):** swallow `BrokenPipeError`/`ConnectionResetError` in the stream loop AND in an overridden `finish()` (base `finish()`'s flush on dead sockets is the classic ThreadingHTTPServer spam source). Override `log_message` to log only `/api/*` and errors.
- **Security:** stem is an opaque dict key into the scan map — never path math; belt-and-suspenders realpath containment check. Port-in-use → clear message suggesting `--port`.

## Frontend

### Layout (matches example.png)
```css
#player-view { display:grid; height:100dvh; background:#000;
  grid-template-columns: 1fr 380px; grid-template-rows: 1fr auto;
  grid-template-areas: "stage chat" "controls controls"; }
#stage video { width:100%; height:100%; object-fit:contain; }  /* letterbox */
```
Theme: `--bg:#0e0e10 --panel:#18181b --text:#efeff1 --accent:#9147ff`; chat text ~13.5px/20px. Controls bar spans full width below both panels: play/pause, `3:00:15 / 13:01:18` time display, seek bar, speed menu, mute+volume, fullscreen — inline SVG icons.

### Library view (library.js)
Fetch `/api/videos`; rows show title + dim meta (`summit1g • ARC Raiders • 6:47:26 • 23.9 GB`). Click → pushState `?v=<stem>` → player. Returning to library refetches (new files appear).

### Chat engine (chat.js)
1. **Load:** fetch `/chat?v=` with streamed reader → progress bar ("Downloading chat" %, then "Parsing…"); `JSON.parse`; build maps; drop transient buffers. Runs in parallel with video start; failure → "Chat unavailable" panel in the column, video unaffected.
2. **Asset maps:** base64 → sniff MIME → Blob URL (record all for teardown revocation). `firstParty: Map(id→{url,w,h})`, `thirdParty: Map(name→{url,w,h,zw})`, `badges: Map('name/version'→{url,title})`.
3. **Comment index:** `Float64Array` of offsets (binary search); histogram `Uint32Array` of messages/minute, scale ceiling = 95th percentile of non-zero buckets (spikes clamp).
4. **Message render** — `div.msg` = timestamp span, badge imgs (miss → skip), name span (user_color or colorHash), body. Body builder walks fragments: emoticon fragments → firstParty img (miss → fragment text); text fragments split on spaces → thirdParty name match; zero-width emote directly after an emote overlays it (absolute-centered img inside the previous emote's wrapper span, multiple stack); `@word` → mention span; consecutive plain words collapse into one Text node. Emote imgs get width/height = declared dims, `alt`/`title` = name.
5. **Sync engine:** `cursor` = next comment index. On `timeupdate` (~4 Hz): append all comments with `time <= currentTime` via one DocumentFragment; trim DOM to 200 messages (500 while user is reading scrollback so it never yanks); if pinned, scroll to bottom. On `seeked`: `idx = upperBound(times, t)`; backward or >200-forward jump → clear DOM, backfill last 50 messages before `idx`, reset cursor, repin. Scroll listener (ignoring programmatic scrolls via flag): >40 px from bottom → unpin + show "Chat paused — click to resume" pill; pill click or scroll back → repin.
6. **Teardown:** unbind listeners, revoke all blob URLs, clear DOM/maps.

### Player (player.js)
- `video.src = /media?v=…`; `play()` inside the click's user activation; blocked → big-play overlay. Duration display seeded from listing's `durationSec` until `loadedmetadata`.
- **Seek bar** (custom div): layers = buffered-range divs (from `video.buffered`), fill, handle; histogram canvas (~24 px, pointer-events none) above the track; hover tooltip shows time. **Commit-on-release scrubbing** via pointer capture: visuals + tooltip track the drag, `video.currentTime` set only on pointerup — live-seeking a 24 GB moov-at-EOF file would fire dozens of abort/reopen/keyframe-hunt cycles per drag. Keyboard seeks commit immediately.
- **fmtTime:** pads to `H:MM:SS` when total ≥ 1 h → `3:00:15 / 13:01:18` style.
- **Keyboard** (document-level, skipped when typing in inputs, preventDefault on space/arrows): space/k play-pause, ←/→ ∓5 s, j/l ∓10 s, m mute, f fullscreen, ↑/↓ volume, 0–9 jump to N×10 %. Clamp to `[0, duration−0.1]`, guard NaN pre-metadata.
- **Fullscreen:** `#player-view.requestFullscreen()` (whole grid incl. chat). Auto-hide controls: 3 s idle while playing → opacity fade + cursor:none (height retained, video never reflows); pointermove/keydown restores.
- **Resume:** `localStorage['ts.pos.'+stem]` saved every 5 s + on pause/pagehide/teardown; cleared within 60 s of end. On open, if `10 < saved < duration−60` → seek + "Resumed at …" toast (chat follows via normal seeked rebuild). Volume/speed/mute persisted too. All localStorage in try/catch.
- `waiting` → spinner overlay (long seeks into 24 GB show real feedback); `error` → human-readable overlay.

### Routing (main.js)
No `?v=` → library; `?v=<stem>` → look up in listing (miss → refetch once → library + notice). Open = pushState + `player.open()` + `chat.load()` in parallel. Close/popstate = `player.close()` (pause, `removeAttribute('src')` + `load()` to abort connections) + `chat.teardown()` + refetch listing.

## Edge cases

mp4 without sibling json → excluded • chat fetch/parse fails → error panel, video fine • unknown emote id → render text • zero-width with no base → render as normal emote • missing user_color → palette hash • offset > duration → clamp in histogram • malformed Range → 200 full; unsatisfiable → 416 • hostile `v=` → dict lookup + realpath check • aborted transfers → swallowed silently • blob/listener leaks → teardown revokes everything • autoplay blocked → big-play overlay.

## Build order

1. `server.py`; verify with curl before any frontend.
2. `index.html` + `style.css` shell (both views, grid).
3. `main.js` + `library.js` (list → click-through → back/forward).
4. `player.js` (playback, controls, seek bar, fullscreen, keyboard, resume).
5. `chat.js` (load → assets → render → sync → scroll pill).
6. Histogram, spinner, toasts, edge-case pass.

## Verification

Server (curl): HEAD `/media?v=` → 200 + `Accept-Ranges`; `Range: bytes=100-199` → `206`, 100 bytes; `bytes=999999999999-` → 416; `/api/videos` → 1 VOD (summit1g / ARC Raiders / 24446 s), no CHAT.mp4 entry.

App (browser, via mcp Claude Browser against `http://127.0.0.1:8710`):
- VOD opens and plays; seek to ~6 h lands within seconds (206s in network log); violent scrubbing produces zero server tracebacks.
- Chat: progress → messages matching current time with ~50-message backfill; backward seek rebuilds to that era (spot-check a message's offset); emotes render (static PNG, animated GIF, animated WebP, wide emote at declared dims, zero-width overlay), badges 18 px, colorless user's color stable across reloads.
- Autoscroll pinned; scroll up → pill + no yank; click pill → bottom.
- Time shows `H:MM:SS / 6:47:26`; keyboard shortcuts all work; space never scrolls page.
- Fullscreen includes chat; controls fade after 3 s and return on mouse move.
- Reload mid-watch → resumes ±5 s with toast; histogram spikes align with busy chat.
- Drop a second VOD pair in folder → appears in library; back/forward toggles views cleanly.
