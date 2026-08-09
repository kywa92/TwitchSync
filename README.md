<img width="370" height="71" align="center" alt="title" src="https://github.com/user-attachments/assets/3e291afb-e9af-4b16-b4d5-f15b6ba10358" />


# TwitchSync
A browser based web app that allows rich playback of Twitch VODs and JSON chat logs

**📖 Full documentation:** open [USER_GUIDE.html](USER_GUIDE.html) in a browser — a detailed
guide to setup, the library, every player control, and troubleshooting.

Point it at a folder of [TwitchDownloader](https://github.com/lay295/TwitchDownloader)
output and it serves a small local site: a library page listing every VOD it
finds, and a player with the gameplay video on the left, a Twitch-style chat
column on the right, and one set of controls at the bottom. Chat is rendered in
HTML straight from the chat JSON and driven by the video clock, so scrubbing
anywhere instantly shows the chat from that moment — no re-encoding, and the
`" - CHAT"` video renders are not needed.

<img width="500" height="" alt="screenshot4" src="https://github.com/user-attachments/assets/edb2f19f-7f37-4d63-b419-7c2ba3bf0c9a" />


## Run

```bash
python3 server.py
```

Then open http://127.0.0.1:8710/ (it opens automatically unless `--no-open`).

Options: `--dir PATH` to serve a different VOD folder (default: this folder),
`--port N` (default 8710), `--no-open`.

Requires Python 3 only — no dependencies, no build step.

## Library folders

The project folder is always scanned. To watch VODs stored elsewhere — a NAS
share, an external drive — mount it (Finder → *Connect to Server*), then click
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

## Player

- Click/drag the seek bar (the purple graph above it is chat messages per
  minute — spikes are the hype moments). Hover for a timestamp; drags seek on
  release.
- Keyboard: `space`/`k` play-pause · `←`/`→` ±5 s · `j`/`l` ±10 s · `↑`/`↓`
  volume · `m` mute · `f` fullscreen · `0`–`9` jump to 0–90 %.
- Playback position, volume, and speed are remembered per VOD (localStorage).
- Scrolling up in chat pauses auto-scroll ("Chat paused — click to resume").
- Chat text is selectable; animated emotes (GIF/WebP) animate; zero-width
  emotes overlay their base emote as on Twitch.

## Emotes
`python3 server.py --sync-emotes` downloads the 7TV + BTTV channel sets for every streamer found in your library plus both global sets into emote-cache/, then writes a manifest. Chat playback now fills in any emote missing from a VOD's embedded data. Playback stays fully offline; the network is only touched by that explicit command, which you can re-run anytime (it skips files it already has).

## How it works

`server.py` (stdlib only) serves the frontend plus two data routes:
`/media?v=<stem>` streams the MP4 with HTTP Range support (required — these
MP4s keep their index at the end of the file), and `/chat?v=<stem>` streams
the chat JSON. `/api/videos` lists VODs, reading only the first 64 KB of each
JSON for its metadata. The frontend (`static/`) is vanilla ES modules: the
chat engine indexes message timestamps into a typed array, binary-searches it
on every seek, and appends messages on `timeupdate`, keeping the DOM capped to
the most recent ~200 messages. The server binds to 127.0.0.1 only.
