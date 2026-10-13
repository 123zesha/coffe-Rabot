# Local background image library

A shared library of reusable Simple Story Video background images, parallel
to `data/music/`'s own library — this app never generates these images
itself for the library; it only uses real image files placed here by you.

To add a background:

1. Put an image file you have the rights to use in this folder (PNG, JPEG,
   or WEBP).
2. Add an entry to `manifest.json`:

   ```json
   [
     { "value": "warm-paper", "label": "Warm Paper", "file": "warm-paper.webp" }
   ]
   ```

`value` is the id used by `job.videoEditSettings.backgroundImageTrack`;
`label` is what's shown to the user; `file` is the filename in this folder.

A one-off image that isn't worth adding here can instead be set directly on
a job via `videoEditSettings.backgroundImage` (a local file path, a
`data:` URI, or a real uploaded/generated image URL) — see the "Upload
Image"/"Generate with AI" options in the Story-to-Video form, which both
use that field directly rather than this library.
