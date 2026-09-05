# TwitchSync
A browser based web app (naturally cross platform) that allows rich playback of Twitch VODs and JSON chat logs that are downloaded using the open source [TwitchDownloader](https://github.com/lay295/TwitchDownloader) tool (CLI or GUI).

**📖 Full documentation:** open [USER_GUIDE.html](USER_GUIDE.html) in a browser — a detailed
guide to setup, the library, every player control, and troubleshooting.

On first run, point TwitchSync at your library of [TwitchDownloader](https://github.com/lay295/TwitchDownloader) VOD mp4 files and associated json chat files. TwitchSync serves a small local site listing every VOD it finds, and a player with the VOD video on the left, a Twitch style chat column on the right, and one set of controls at the bottom. Chat is rendered in HTML straight from the chat JSON and tied to the video clock, so scrubbing anywhere instantly shows the chat from that moment. TwitchSync can read both local and remote (NAS/network storage) libraries. 


<img width="754" height="724" alt="Screenshot 2026-08-23 at 12 06 30 PM" src="https://github.com/user-attachments/assets/ff2b3cfb-ef44-47b6-8fca-0745a4b3ddb3" />


## Run

```bash
python3 server.py
```

Then open http://127.0.0.1:8710/ (it opens automatically unless `--no-open`).

Options: `--dir PATH` to serve a different VOD folder (default: this folder),
`--port N` (default 8710), `--no-open`.

There are also three one-shot maintenance commands that do their work and exit:
`--sync-emotes`, `--sync-thumbs`, and `--check-chat` (each described below).

Requires Python 3 only. No dependencies. No build needed. ffmpeg is optional but
worth having — thumbnails, chat-file checking, and muted-audio detection all use
it, and each is simply skipped without it.

## Library folders

The project folder is always scanned. To watch VODs stored elsewhere like a NAS
share, an external drive etc, mount it (Finder → *Connect to Server*), then click
**Folders** on the library page and add its path, e.g. `/Volumes/MyNAS/VODs`.
Added folders are remembered in `folders.json`, scanned up to four levels deep,
and everything appears in one combined library. Removing a folder never touches
the files.

## Adding VODs

Drop the TwitchDownloader files into the project folder (or any added folder),
keeping the shared name stem:

```
My Stream Title.mp4     ← main video (H.264/AAC plays natively in browsers)
My Stream Title.json    ← chat JSON (with embedded emotes/badges)
```

A VOD appears in the library when both files exist. Anything with `" - CHAT"`
in the filename is ignored.

Files missing their other half are no longer skipped silently. Any `.mp4` or
`.json` whose name starts with a `[M-D-YY]` date stamp but has no partner is
listed under **Unpaired files** at the bottom of the library (and printed on
startup). Unpaired videos still play — with the chat column hidden — so a
download whose chat JSON never arrived is still watchable.

## Browsing the library

- **Sort by** date, file size, duration, streamer, or game, in either
  direction. Dates come from the `[M-D-YY]` stamp in the filename rather than
  the file's timestamp, so a re-download keeps its place in the list.
- **Filter** by streamer and by game. Both are multi-select, so
  "Counter-Strike *or* Escape from Tarkov" is one click each, and the game list
  includes anything a VOD's chapters switched into, not just its main category.
- Rows show a thumbnail, streamer, game, duration, size, and a progress bar for
  anything part-watched. The ↺ on a row clears just that VOD's history;
  **Reset history** clears them all.
- Sort and filter choices are remembered. A selection that no longer matches
  anything — an unmounted NAS, say — falls back to showing everything instead
  of an empty page.
- Leaving a VOD (back button or `esc`) returns you to the same scroll position
  with the same sorting you left.

## Player

- Click/drag the seek bar (the purple graph above it is chat messages per
  minute — spikes are the hype moments). Hover for a timestamp; drags seek on
  release.
- Keyboard: `space`/`k` play-pause · `←`/`→` ±5 s · `j`/`l` ±10 s · `↑`/`↓`
  volume · `m` mute · `f` fullscreen · `esc` back to the library (in fullscreen
  the first `esc` leaves fullscreen).
- Playback position is remembered per VOD; volume, speed, and autoplay are
  remembered globally (localStorage). **Autoplay next** walks the library in
  whatever sort order is currently applied.
- **Zoom and pan** — the magnifier opens a zoom slider (100–400 %). Scroll on
  the video to zoom around the pointer, then drag to pan. **Fill screen** is a
  standing option that crops the black bars away by scaling the picture to
  cover the player; it is recalculated for each video's aspect ratio and
  whenever the window, fullscreen, or chat width changes.
- **Muted stretches** of the VOD are marked in red on the timeline — see
  [Muted audio](#muted-audio) below.
- A decode or network hiccup no longer ends playback. The player reloads and
  resumes where it stopped, skipping progressively further ahead (1 s, 2 s,
  5 s…) if the same spot keeps failing, and only falls back to an error message
  after several attempts.


<img width="1352" height="725" alt="Screenshot 2026-08-23 at 12 11 43 PM" src="https://github.com/user-attachments/assets/ad5a2c98-36c4-45bc-8f91-daeffb0c2e82" />


## Chat

The chat column replays the JSON against the video clock: messages appear at
the moment they were originally posted, and scrubbing anywhere rebuilds the
visible backlog instantly rather than replaying up to that point.

- **Faithful rendering** — subscriber/moderator/broadcaster badges, each
  chatter's own Twitch colour (colours too dark to read on the dark panel are
  lifted, as Twitch does in dark mode), and `@mentions` drawn in the colour of
  the person being mentioned rather than plain white, so replies to one person
  are easy to follow. Those colours are read out of the chat log itself;
  anyone who never typed during the stream falls back to Twitch's own default
  colour for that name. Text stays selectable for copying.
- **Emotes** — first-party Twitch plus BTTV/7TV emotes embedded in the VOD's
  own JSON, with anything missing filled in from `emote-cache/`. Animated
  GIF/WebP emotes animate, and zero-width emotes stack over the emote before
  them as they do on Twitch.
- **Auto-scroll** follows playback and pauses the moment you scroll up, showing
  a "Chat paused — click to resume" pill, so reading back never yanks you to
  the bottom.
- **Activity graph** — the messages-per-minute histogram above the seek bar is
  built from this chat log, so hype spikes are visible before you scrub to them.

### Chat settings

The gear at the top of the chat column opens:

- **Show message timestamps** — hide the per-message time.
- **Shorten names to first letter** — collapses every display name to its
  initial to reclaim width. Badges are kept, and hovering a message slides the
  rest of that name back into view.
- **Hide Chat Bot messages** — drops every message from anyone carrying the
  Chat Bot badge (Fossabot, StreamElements and friends), so the log is just the
  people watching.
- **Hide `!` commands** — drops messages that *start* with a bang — `!match`,
  `!followage`, `!uptime`. A `!` mid-sentence, or plain excitement like `!!!`,
  is left alone.
- **Hide messages containing…** — a box of your own phrases, one per line;
  any message containing one of them is hidden. Case-insensitive, matched
  anywhere in the message, and against the underlying text so emote names
  count too. This is what catches sub and resub announcements: Twitch posts
  those as ordinary messages from the subscriber, not from a badged bot, so
  `RESUB HYPE!` and `subscribed with Prime.` are the two lines most libraries
  want. It applies as you type, and blank or repeated lines are ignored.
- **Draw chat over the video** — removes the chat panel's background and lets
  the video widen to the full window, with chat drawn on top of it like a
  stream overlay. A **Chat opacity** slider (20–100 %) appears with it to fade
  the text and emotes back as far as you like; a soft dark outline keeps them
  readable over bright scenes.
- **Chat width** — sets the column as a percentage of the window (15–50 %),
  applied live as you drag. In overlay mode this is how much of the video the
  chat is drawn across.

All of them persist across VODs and restarts, and apply immediately to messages
already on screen.

## Emotes
`python3 server.py --sync-emotes` downloads the 7TV + BTTV channel sets for every streamer found in your library plus both global sets into emote-cache/, then writes a manifest. Chat playback now fills in any emote missing from a VOD's embedded data. Playback stays fully offline; the network is only touched by that explicit command, which you can re-run anytime (it skips files it already has).

## Thumbnails
Thumbnails are extracted server-side with ffmpeg (`brew install ffmpeg`) and cached in thumb-cache/, so a library only pays for them once. `python3 server.py --sync-thumbs` generates every missing one up front and prunes cache files whose VOD changed or vanished. Without ffmpeg the app falls back to capturing frames in the browser, which still works but is slower and makes macOS click its audio device once per thumbnail.

## Checking chat files
Same filename does not guarantee same stream: a partial or mis-filed download can leave an MP4 paired with a chat JSON from a different (usually shorter) stream. On every start the server checks each pair in the background — comparing the chat file's declared video length against the MP4's real duration, and flagging a chat log that stops long before the video ends — and marks anything suspect with an amber **CHECK** badge in the library plus a count in the toolbar. Results are cached in chat-check.json and keyed to both files, so only new or changed VODs are re-checked. `python3 server.py --check-chat` re-runs the whole thing from scratch and prints a per-VOD report. Needs ffprobe (same Homebrew package as ffmpeg); without it the check is skipped entirely.

## Muted audio

Twitch mutes stretches of a VOD when it detects copyrighted audio, and nothing
in the chat JSON records where they are — so TwitchSync finds them itself. A
background pass reads each VOD's audio once with ffmpeg and notes every stretch
of digital silence longer than two minutes. Those appear as light red bars on
the timeline, and while the playhead is inside one a small notice above the
controls reads *source audio muted until 0:42:15* — click the timestamp to skip
straight to where the audio returns. Results are cached permanently in
mute-scan.json keyed to each file, so a VOD is only ever read once; whichever
VOD you open jumps to the front of the queue while the rest of the library is
crawled one file at a time in the background. Needs ffmpeg — without it the
feature is simply absent.

## How it works

`server.py` (stdlib only) serves the frontend plus a handful of data routes:
`/media?v=<id>` streams the MP4 with HTTP Range support (required — these
MP4s keep their index at the end of the file), and `/chat?v=<id>` streams
the chat JSON. `/api/videos` lists VODs and unpaired files, reading only the
first 64 KB of each JSON for its metadata, while `/api/chat-check` and
`/api/muted` report the two background passes. The frontend (`static/`) is
vanilla ES modules: the chat engine indexes message timestamps into a typed
array, binary-searches it on every seek, and appends messages on `timeupdate`,
keeping the DOM capped to the most recent ~200 messages. Preferences — sort,
filters, chat settings, zoom fill, and resume positions — live in localStorage;
generated data lives beside the script in `folders.json`, `thumb-cache/`,
`emote-cache/`, `chat-check.json`, and `mute-scan.json`. The server binds to
127.0.0.1 only.
