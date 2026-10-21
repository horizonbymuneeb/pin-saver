# Pin Saver — Pinterest board downloader

A working Pinterest board/pin downloader for Chrome (Manifest V3).
Independent clean-room implementation; see [`../SPEC.md`](../SPEC.md) for the
behavioural specification and the reasoning behind each design choice.

## What it does

- **Whole board → ZIP.** Reads the entire board through Pinterest's resource
  API (no scrolling), fetches every pin, packs one archive.
- **Whole board → PDF.** The same pins as a multi-page A4 album, with each
  JPEG embedded untouched (no re-encoding, no quality loss).
- **Full resolution.** Thumbnail URLs are rewritten to `originals`, so you get
  the uploaded image, not the 564px preview.
- **Single pin.** A red download button appears on every pin card, and a
  "Download pin" button on a single pin page (`/pin/...`).
- **Videos included, and actually playable.** Pinterest hands out an HLS
  playlist, not a video. The extension follows it to the real media file and
  saves a normal `.mp4` (verified: h264, 720x1280, opens everywhere).
- **Sections → folders.** Board sections become sub-folders inside the archive
  (read from Pinterest's section endpoints — the pin feed does not carry them).
- **Metadata.** `_metadata.csv` (UTF-8 BOM, Excel-safe) and `_metadata.json`.
- **No dependencies.** ZIP and PDF writers are implemented in-repo, so nothing
  is loaded from a CDN (which MV3 forbids anyway).
- **Multi-select.** Pick specific pins and export only those.

No account, no sign-in, no limits.

## Install (30 seconds)

### From the packaged archive (recommended)

```bash
npm run package          # builds ../pin-saver-extension.zip (19 files)
```

1. Unzip `pin-saver-extension.zip` anywhere.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped folder.
5. Open a Pinterest board — a panel appears bottom-right.

The packaged copy is verified: the browser test suite passes against the
*extracted* archive, not just the source folder.

### From source

Same steps, but select this `my-version` folder directly. Everything under
`test/`, `scripts/` and `node_modules/` is ignored by Chrome.

If the panel does not appear, reload the Pinterest tab once — content scripts
only attach on page load.

Works in Chrome, Edge, Brave and other Chromium browsers (116+).

## Usage

### Whole board

```
Open board → panel (bottom-right) → "Download whole board as ZIP" → wait
```

Progress is shown in the panel: pin count per page, then per-item archiving.
The archive lands in your Downloads folder as
`PinSaver/<board name>-<timestamp>.zip`.

### Only some pins

```
panel → "Select pins" → click the red button on each pin → "ZIP selected"
```

### One pin

```
Hover a pin → click the red ↓ button
```

## Archive layout

```
My Board/
  _metadata.csv
  _metadata.json
  Section A/
    01-cute-cat.jpg
    02-sunset-beach.png
  03-a-pin-with-no-section.mp4
```

## Development

```bash
npm test              # 139 unit + integration + PDF + video + API + batch tests
npm run test:unit
npm run test:integration
npm run test:pdf
npm run check         # validates manifest, file references, syntax, icons
npm run package       # check + build ../pin-saver-extension.zip
npm run test:live     # real API against production Pinterest (network)
npm run test:live-board  # builds a real ZIP from a live sectioned board
npm run test:e2e      # 52 checks: loads the extension in real Chromium
```

### Layout

```
manifest.json          MV3 manifest
src/background.js      service worker: media fetch with Referer + chrome.downloads
src/content.js         page UI, board pagination, ZIP assembly
src/content.css        injected styles
src/lib/api.js         Pinterest resource API client (board id, pins, headers)
src/lib/zip.js         dependency-free ZIP writer (store method, CRC-32)
src/lib/pdf.js         dependency-free PDF writer (embeds JPEG via DCTDecode)
src/lib/video.js       HLS playlist parser → direct MP4 resolver
src/lib/util.js        URL/thumbnail transforms, sanitisation, pin parsing
popup/                 toolbar popup
test/                  node:test suites
test/e2e/              real-browser test: loads the extension in Chromium
scripts/check.js       pre-flight validation
```

## How it works, in one paragraph

Pinterest's own React front-end talks to `/resource/<Name>/get/` endpoints.
This extension calls those same endpoints from a content script: first
`BoardResource` to turn `/<user>/<slug>/` into a numeric board id, then
`BoardFeedResource` in a cursor loop until the bookmark reports `-end-`. Each
pin's best media URL is picked, its width bucket rewritten to `originals`, and
the bytes are fetched by the **background worker** — the only place that can
send the `Referer` the media CDN requires. Everything is packed with a local
ZIP writer and handed to `chrome.downloads`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No panel on a board | content script not attached | reload the Pinterest tab |
| `playwright-core` missing for e2e | dev dependency not installed | `npm i -D playwright-core` |
| "Pinterest API HTTP 403" | session or headers rejected | make sure you are logged in; reload |
| Some pins skipped | media URL missing or blocked | expected; the summary counts them |
| Empty ZIP | not a board page, or board is empty | check the URL looks like `/user/board/` |
| "Video is segmented and cannot be saved" | a `.ts`-segment stream, not `.cmfv` | rare; report the pin |
| PDF shorter than the board | video pins are excluded from PDF | use ZIP for videos |
| Only ~25-65 pins downloaded | anonymous session has no pagination cursor | log in to Pinterest, then retry |

## Notes

- Pinterest's resource API is undocumented and can change without notice.
- Only `*.pinimg.com` media is fetched; the background worker refuses any
  other host.
- This is a personal archiving tool. Respect Pinterest's terms and the rights
  of the people who created the images you download.
