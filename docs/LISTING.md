# Chrome Web Store listing — Pin Saver

## Name (max 45 chars)

```
Pin Saver — Pinterest Board Downloader
```

## Short description (max 132 chars)

```
Download a whole Pinterest board as ZIP or PDF. Images and videos, original resolution, board sections kept as folders.
```

Count: 126 characters. ✔

## Category

`Productivity` (also acceptable: `Social & Communication`)

## Language

`English (United States)`

## Detailed description (max 16,000 chars)

```
Save an entire Pinterest board to your computer in one click.

Pin Saver reads the board you are currently viewing through Pinterest's own
API, then downloads every pin at its original resolution and packs it into a
ZIP archive — or lays it out as a PDF.

WHAT IT DOWNLOADS

• Images at full "originals" resolution, not the small thumbnails Pinterest
  shows in the grid.
• Videos as real, playable MP4 files. Pinterest only exposes an HLS
  playlist; Pin Saver resolves the underlying fragmented MP4 for you, so the
  file opens in any video player.
• Board sections are preserved as folders, so the structure of the board is
  kept inside the archive.
• A metadata sidecar (_metadata.csv and _metadata.json) listing each pin's
  title, link, section and type.

WHERE IT WORKS

• On a board page: a small panel gives you "Download board as ZIP",
  "Download board as PDF" and "Select pins".
• On every pin in the grid: a small download button saves that one pin.
• On a single-pin page: a "Download pin" button.
• From the toolbar popup: one click to export the board you are on.

SELECTING SPECIFIC PINS

Tap "Select pins", tap the pins you want, then "ZIP selected" — the archive
contains only the pins you picked.

ROBUSTNESS

• Transient network failures are retried, so a single hiccup does not abort a
  large download.
• A pin that cannot be downloaded is skipped and counted instead of ruining
  the whole archive.
• Works on any Pinterest regional domain, and uses the sign-in you already
  have in your browser — no separate login inside the extension.

PRIVACY

Pin Saver has no server, no analytics and no telemetry. It collects nothing,
stores nothing and sends nothing anywhere except to Pinterest itself. See the
privacy policy in this listing for details.

PERMISSIONS

• activeTab — to show the download panel on the page you opened.
• downloads — to save the ZIP / PDF into your own Downloads folder.
```

## Data usage disclosure (store form)

| Question | Answer |
|---|---|
| Does your extension collect or share user data? | **No** |
| Is all user data encrypted in transit? | N/A — no data collected |
| Do you sell or transfer user data? | **No** |
| Does your extension collect: PII, health, financial, authentication, personal communications, location, web history, user activity, website content? | **No** |
| Purpose of the data collection | N/A |

## Single purpose description (store form)

```
Pin Saver lets the user download the images and videos of a Pinterest board
they are already viewing, as a ZIP archive or a PDF, directly to their own
computer.
```

## Store assets

| Asset | File | Requirement |
|---|---|---|
| Small icon | `my-version/icons/icon128.png` | 128×128 PNG ✔ (already in the package) |
| Screenshot 1 | `store/01-board-panel.png` | 1280×800 ✔ (board + panel + per-pin buttons) |
| Screenshot 2 | `store/02-selection.png` | 1280×800 ✔ (multi-select) |
| Screenshot 3 | `store/03-single-pin.png` | 1280×800 ✔ (single-pin page) |
| Screenshot 4 | `store/04-export-done.png` | 1280×800 ✔ (export finished) |
| Privacy policy URL | `https://horizonbymuneeb.github.io/pin-saver-privacy/` | public HTTPS page ✔ |
| Source repository | `https://github.com/horizonbymuneeb/pin-saver` | public, MIT |

## Review notes (what the reviewer should look at)

```
Pin Saver is a local-only downloader. There is no server component and no
remote code: every file it runs ships inside the extension package.

How to test:
1. Open https://www.pinterest.com/ and open any board.
2. A small "Pin Saver" panel appears at the bottom right of the page.
3. Click "Download board as ZIP" or "Download board as PDF".
4. The archive appears in your Downloads folder.

The extension makes two kinds of network request, both to Pinterest:
• GET https://www.pinterest.com/resource/<Name>/get/...  — reads the pin list
  of the board you are viewing, using the sign-in already present in your
  browser (credentials: include, same as the Pinterest website itself).
• GET https://*.pinimg.com/...                       — downloads the image and
  video files of those pins.

It writes the result with chrome.downloads.download() into your Downloads
folder. Nothing is sent anywhere else.

The panel does not appear on Pinterest's logged-out login wall, because there
are no pins to download in that case.
```
