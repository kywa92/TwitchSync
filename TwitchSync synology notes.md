Yes — and it's working with your Synology right now. Your NAS was already mounted at /Volumes/SHARE1821, so I built it, pointed it at /Volumes/SHARE1821/VODs, and verified it end to end: 37 VODs now show in one combined library — 36 from the NAS plus the one in the project folder.

How it works
Click Folders in the library header. You get a panel listing every library folder with its full path and live VOD count, plus a text box to add another. Any mounted volume shows up as a clickable chip (yours shows SHARE1821) so you don't have to type the tricky part of the path. Added folders are remembered in folders.json, so they persist across restarts.

The project folder is permanent and has no remove button — dropping files next to server.py works exactly as before. Everything from every folder is listed together, sorted by date, and once you have more than one folder each card carries a tag showing where that VOD lives. Removing a folder only un-lists it; your files are never touched, and the message says so.

Performance is a non-issue on your link. I played a 43.7 GB Counter-Strike VOD straight off the NAS and seeked to the 10-hour mark: 142 ms, with chat rebuilding to exactly 9:58:58–10:00:17. Playback only pulls the byte ranges it needs (~1 MB/s for 1080p60), so 2.5GbE is enormous overkill — which is a good problem.

Two bugs your NAS exposed
Pointing at real data immediately surfaced problems the single-folder version had:

31 of your chat files use .Json with a capital J, and the old pairing was case-sensitive — more than half your NAS library would have silently gone missing. Extensions are now matched case-insensitively.

Your VODs live in subfolders too (VODs/snowboard day/), so the scan now recurses up to four levels, skipping hidden folders and NAS housekeeping dirs (@eaDir, #recycle, #snapshot) — notably so VODs sitting in your NAS recycle bin don't pollute the library.

I also fixed a latent freeze I tripped over while testing: the server logs on the request thread, so if its output pipe ever filled with nobody reading it, every logged request would block and the app would appear hung. Logging now happens on a background thread that drops lines rather than stall. You'd likely never hit it in Terminal, but it cost me a confusing ten minutes, so it's worth not leaving in.

Validation is covered: nonexistent paths get "mount it in Finder first", duplicates, files-instead-of-folders, and re-adding the project folder are all rejected with clear messages, and a folder that's unmounted shows as not mounted and is skipped rather than breaking the library. Cross-origin POSTs are rejected (415) since the endpoint requires a JSON body, so a random web page can't reconfigure your library.

Docs are updated: the guide has a new Library folders section with NAS setup steps and two new troubleshooting entries, and the README has a short version.

One note — I left /Volumes/SHARE1821/VODs configured since that's clearly what you wanted. You have VODs joined and VODs WIDE on the share too; I tested with VODs WIDE and it found 0 pairs, so if those hold VODs you care about, they're probably missing chat JSONs.
