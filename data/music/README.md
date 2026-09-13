# Local background music library

This app never downloads or generates background music — it only mixes in
real audio files placed here by you.

To add a track:

1. Put a royalty-free/licensed audio file you have the rights to use in
   this folder (e.g. `chill-loop.mp3`).
2. Add an entry to `manifest.json`:

   ```json
   [
     { "value": "chill-loop", "label": "Chill Loop", "file": "chill-loop.mp3" }
   ]
   ```

`value` is the id used by `job.musicTrack`; `label` is what's shown to the
user; `file` is the filename in this folder. The library is empty by
default — no bundled audio ships with the app.

A one-off track that isn't worth adding here can instead be set directly
on a job via `musicCustomUrl` (a local file path or a `data:` URI).
