# SPEC — Pinterest board downloader

Behavioural specification, derived by observing the reference extension
**Pin Kit – Pinterest Board Downloader** (Chrome Web Store id
`dadffeljcabienkbcmdakmegmdpfamfm`, version 5.5.12) and its published feature
description. The implementation in `my-version/` is an independent clean-room
build against this spec; no source code was copied.

---

## 1. Purpose

Let a signed-in Pinterest user archive the pins of a board — or a single pin —
at **full resolution**, including videos, without scrolling the whole board
manually.

## 2. Observed feature set of the reference

Extracted from the extension package and its store description:

| # | Feature | Evidence |
|---|---------|----------|
| 1 | Download an entire board as a ZIP | store description; ZIP builder in bundle |
| 2 | Download a board as a PDF | store description; `html2canvas` + DOM sanitizer bundled |
| 3 | Save a single pin from hover / closeup | injected button + per-pin click handler (`my-version` covers both board cards and the `/pin/` closeup) |
| 4 | Original (not thumbnail) resolution | URL bucket rewritten to `originals` |
| 5 | Images **and** videos, with audio | video URL detection + HLS handling (`my-version` resolves HLS to the backing `.cmfv` MP4) |
| 6 | Board sections become folders | `BoardSectionsResource` + `BoardSectionPinsResource`; feed pins carry no section data |
| 7 | Metadata sidecar (`CSV` + `JSON`) | `_metadata.csv` / `_metadata.json` writers |
| 8 | Pin multi-select then export | selection state + "ZIP selected" |
| 9 | Multi-language UI | 7 `_locales` bundles |
| 10| Account / plan tier gating | Supabase auth + tier check before export |

`my-version` implements **1–8**. Localisation (9) and account gating (10) are
deliberately out of scope — see §8.

## 3. Why naive implementations fail

These are the four details that decide whether a clone works.

### 3.1 Thumbnail URLs

Pinterest serves each image through a width bucket in the path:

```
https://i.pinimg.com/564x/ab/cd/ef/abcdef.jpg
                     ^^^^^ width bucket
```

Replace **only the first** bucket segment with `originals` to get the
untouched upload:

```
https://i.pinimg.com/originals/ab/cd/ef/abcdef.jpg
```

The hex directory segments that follow are not widths and must be preserved.
Buckets appear in two forms — width-only (`564x`, `236x`, `736x`) and square
(`75x75`) — so the pattern is `/<digits>x<optional digits>/`.

### 3.2 Hotlink protection on the media CDN

`Referer` is a forbidden header for page JavaScript, so a content script
cannot fetch `i.pinimg.com` with the referer Pinterest expects. Requests
without it are frequently rejected with 403 or served an error page.

The fix is architectural: media bytes are fetched from the **background
service worker**, which is not subject to the page's forbidden-header rules
and holds `host_permissions` for `*.pinimg.com`. Requests carry:

```
Referer: https://www.pinterest.com/
Origin:  https://www.pinterest.com
```

Requested headers must also be set by hand, because `Referer` is stripped
from content-script `fetch` calls specifically.

### 3.3 Getting the *whole* board, not just the visible pins

The DOM only contains the pins currently rendered. Scrolling to harvest is
slow, breaks on long boards, and misses pins behind lazy loading.

The reference instead calls Pinterest's own internal resource API, the same
one the React front-end uses. Requests must carry the site's browser headers
(`x-app-version`, `x-pinterest-appstate`, `x-b3-*` trace ids,
`x-requested-with`) and `credentials: "include"` so the session cookie
applies.

### 3.4 Video is not an `<img>`

Videos live on a different host and need a different Accept header. Idea pins
(story pins) additionally expose their video through a nested
`story_pin_data → pages → blocks → video` structure rather than `images`.

## 4. Protocol

### 4.1 Resolve the board id

The feed endpoints take a numeric `board_id`; the URL only has
`/<username>/<slug>/`.

```
GET https://www.pinterest.com/resource/BoardResource/get/
    ?source_url=<url-encoded "/user/slug/">
    &data=<url-encoded JSON>
    &_=<timestamp>

data = {
  "options": { "username": "<user>", "slug": "<slug>", "field_set_key": "detailed" },
  "context": {}
}
```

Response: `resource_response.data.id` → board id.

Board URLs may be percent-encoded for non-ASCII names; if the encoded slug
fails, retry with the decoded form.

### 4.2 Page through the pins

```
GET .../resource/BoardFeedResource/get/?source_url=…&data=…&_=…

data = {
  "options": {
    "board_id": "<id>",
    "board_url": "/user/slug/",
    "currentFilter": -1,
    "field_set_key": "react_grid_pin",
    "filter_section_pins": false,
    "sort": "default",
    "layout": "default",
    "page_size": 50,
    "redux_normalize_feed": true,
    "bookmarks": ["<cursor>"]        // omit on the first page
  },
  "context": {}
}
```

Pagination is a cursor loop:

```text
bookmark = null
loop:
    page = fetch(board_id, bookmark)
    collect page.pins (de-duplicate by id)
    bookmark = page.bookmark
    if bookmark is null or "-end-": stop
```

`resource_response.bookmark` may also arrive as `resource_response.data.bookmark`
when the feed is a keyed object rather than an array.

### 4.3 Required request headers

| Header | Value |
|--------|-------|
| `accept` | `application/json, text/javascript, */*, q=0.01` |
| `x-app-version` | from `<meta name="pinterest-app-version">`, else a script-scraped value, else a fallback constant |
| `x-pinterest-appstate` | `active` |
| `x-pinterest-source-url` | the page path, e.g. `/alice/board/` |
| `x-pinterest-pws-handler` | `www/[username]/[slug].js` |
| `x-requested-with` | `XMLHttpRequest` |
| `x-b3-traceid` / `x-b3-spanid` / `x-b3-parentspanid` | 16 lowercase hex chars |
| `x-b3-flags` | `0` |
| `cache-control` / `pragma` | `no-cache` |

### 4.4 Pick the media URL for a pin

Priority order:

1. `images.orig.url`
2. `images["736x"].url`
3. `images["564x"].url`
4. `image_large_url` → `image_medium_url` → `image_square_url`
5. For idea pins: `story_pin_data.pages[0].blocks[0].video.video_list` →
   `V_HLSV3_MOBILE` (or `V_HLSV3_WEB`)

A URL is a video when it contains `/videos/`, `video_p5p`, `v_HLS`, or ends in
`.mp4 / .mov / .webm / .m3u8 / .cmfv`.

### 4.4a Attributing pins to board sections

`BoardFeedResource` returns **no section information at all** — no
`sectionPath`, no `section_id`. A clone that assumes otherwise silently puts
every pin in the board root. Sections must be read explicitly:

```
GET .../resource/BoardSectionsResource/get/   options: { board_id, page_size: 250 }
    → data: [{ id, name, slug }]        (empty list is a valid "no sections")

GET .../resource/BoardSectionPinsResource/get/  source_url: /user/board/<section-slug>/
    options: { board_id, section_id, field_set_key: "react_grid_pin",
               is_own_profile_pins: true, page_size: 50, redux_normalize_feed: true }
    → data: [pins], bookmark
```

**The two feeds have different limits.** `BoardFeedResource` accepts
`page_size: 250`, but `BoardSectionPinsResource` answers
`HTTP 400 "Invalid parameters"` for 250 and succeeds with 50. They therefore
keep separate constants; using the board constant for sections breaks every
sectioned board.

Pins from a section are tagged with that section's name so the archive writer
can build a folder per section. A sections call that fails must not lose the
board pins, and one unreadable section must not abort the whole download.

### 4.5 Turning a video into a playable file

The API almost always returns an **HLS master playlist** (`.m3u8`, under 1 KB),
never a direct MP4. Saving that is useless, so the real media file has to be
located:

```
master.m3u8
  └─ #EXT-X-STREAM-INF:BANDWIDTH=…  →  <hash>_720w.m3u8   (pick highest)
       └─ #EXT-X-MAP:URI="<hash>_720w.cmfv",BYTERANGE="972@0"
          #EXT-X-BYTERANGE:411223@1132 → <hash>_720w.cmfv
          #EXT-X-BYTERANGE:406973@412355 → <hash>_720w.cmfv
```

Every segment is a **contiguous byte range of one `.cmfv` file**, preceded by
that file's own init segment. The single `.cmfv` is therefore already the
complete fragmented MP4 — downloading it whole and naming it `.mp4` yields a
normal playable video, with no ffmpeg and no segment concatenation.

Verified live: a 720w `.cmfv` returned `video/mp4`, `ftyp iso6`, and ffprobe
reported h264 720x1280. Guessing MP4 URLs by rewriting `hls` → `expMp4` does
**not** work (403); only the `.cmfv` path is valid.

True segmented `.ts` streams are rejected with an explicit error rather than
saved as a playlist.

## 5. Download mechanism

```
content script ──(message)──> background ──> pinimg.com (with Referer)
       │                          │
       │                          └──> chrome.downloads
       └── builds ZIP in memory, sends bytes to background for saving
```

Two save paths:

- **Single pin** — `chrome.downloads.download({ url })` directly; on failure
  fall back to fetching bytes in the background and saving from a data URL.
- **Board ZIP** — every pin's bytes are collected in the content script,
  packed by the local ZIP writer, then handed to the background as bytes.

`conflictAction: "uniquify"` prevents overwriting same-named files.

### 4.11 API calls must not be cross-origin

A content script that fetches `https://www.pinterest.com/resource/...` while
the user is on another Pinterest host (`pinterest.com` without `www`, or a
country domain such as `in.pinterest.com`) makes a **cross-origin** request.
Because the call carries Pinterest's own headers, the browser sends a CORS
preflight; Pinterest answers it with HTTP 400 and no
`Access-Control-Allow-Origin`, and the fetch fails with the bare message
**"Failed to fetch"**. The apex domain is worse: its API redirects to `www`,
which turns a same-origin request into a cross-origin redirect.

The fix is architectural: the **background worker** holds the host
permissions, so it performs the request with no CORS involved, from any
Pinterest host. The content script routes API calls through it.

Measured on the live site:

| Host | Before | After |
|---|---|---|
| `in.pinterest.com` | `Failed to fetch` | `Saved PDF with 48 pages` |
| `www.pinterest.com` | works | works |

### 5.0 Retries

Two different transports need retries for two different failure modes.

**Media bytes** — on a board of several hundred pins a single transient CDN
error would silently drop that pin from the archive. Media fetches retry up to
3 times with exponential backoff (250 ms, 500 ms). HTTP 404 is not retried
because it will not become available; 403 and 5xx can be transient and are.

**Resource API** — one transient 5xx or 429 on a single page would abort the
whole board download. Resource calls retry up to 3 times (300 ms, 600 ms).
Network errors and 5xx/429 are retried; a 4xx or an in-body API error is a
definitive answer and is not.

### 5.1 Archive layout

```text
<board name>/
  _metadata.csv          # UTF-8 with BOM, so Excel reads it correctly
  _metadata.json
  <section path>/        # one folder per board section, when present
    01-<title>.<ext>
    02-<title>.<ext>
```

- File names: zero-padded index + sanitized title, capped at 50 characters.
- Sanitisation strips `<>:"/\|?*` and control characters, collapses
  whitespace to `_`.
- A pin that fails to download is skipped and counted; it never aborts the
  archive.
- **Titles are untrusted input.** They are written by other Pinterest users,
  so a cell beginning with `=`, `+`, `-` or `@` is a spreadsheet formula to
  Excel and LibreOffice. Such cells are prefixed with an apostrophe before
  quoting (CSV formula injection), and embedded commas/quotes/newlines are
  escaped by the standard double-quote rule.

### 5.2 ZIP format

Method 0 (store), no compression — images and videos are already compressed,
and this keeps the extension dependency-free under the MV3 CSP
(`script-src 'self'` forbids loading a CDN copy of a zip library).
Required records: local file header, central directory, end-of-central-
directory; UTF-8 name flag `0x0800`; CRC-32 per entry.

## 6. UI surface

- A small **download button on every pin card**, re-attached by a
  `MutationObserver` because Pinterest is a SPA. Pin detection deliberately
  uses several signals, because the markup is not a stable API:
  `[data-test-id="pin"]` first, then `/pin/<id>/` anchors that wrap pin media,
  then (only if neither matched) large non-avatar `pinimg` images. Card and
  anchor matches are deduplicated so a pin never gets two buttons — that
  duplication silently cancels a selection on the second click.
- **Signed-out visitors get no buttons.** Pinterest serves image placeholders
  behind a login wall. The image fallback is skipped when the page carries
  `gated-pin-image` / `gated-pin-rep` / `login-button`, otherwise it decorates
  placeholders with downloads that cannot work. Verified on the live site:
  10 stray buttons before, 0 after.
- **A signed-out board says why it is short.** When the page is gated the panel
  shows a one-line notice ("Sign in to Pinterest for the full board"), because
  otherwise an export of ~25 pins looks like a bug rather than a limit.
- A **download button on a single pin page** (`/pin/<id>/`). That page has no
  pin card at all, so it is handled separately: media is read from
  `closeup-body` / `closeup-visual-container` / `closeup-body-image-container`,
  and the button is inserted beside `closeup-action-bar` (falling back to a
  floating button if the bar changes).
- A **floating panel on board pages** with: download whole board, start
  selection, and ZIP the selection.
- The popup detects whether the current tab is a board and offers the same
  action.

## 7. Edge cases

| Case | Behaviour |
|------|-----------|
| Board URL uses percent-encoded slug | retry with decoded slug |
| Pin appears on two pages | de-duplicated by `id` |
| Feed ends | stop when bookmark is null or `-end-` |
| Pin has no media URL | skipped, counted in the summary |
| Media response is an HTML/XML error page | rejected by **content type**, not by size |
| HEIC/HEIF image | prefer the JPEG fallback when present |
| Pinterest switches content without reload | SPA path polling + mutation observer |
| Very long title | capped at 50 chars after sanitisation |
| API returns HTTP 403 | surface the status, do not silently produce an empty ZIP |
| Pin title starts with `=` / `+` / `-` / `@` | neutralised before writing CSV |
| Pin title contains a comma, quote or newline | quoted and escaped |
| Media body is an HTML/XML error page | rejected by content type |

## 8. Deliberately out of scope

- **Localisation** — English only.
- **Account / tier gating** — no server, no sign-in, no limits.
- **HLS transcoding** — an `.m3u8` playlist is downloaded as-is rather than
  being remuxed to a single file.

## 8a. PDF export

The reference reaches PDF through a bundled HTML-to-canvas renderer. That is
the wrong tool for a downloader that already holds the image bytes: a PDF can
carry a JPEG **untouched** using the `/DCTDecode` filter, so there is no
re-encoding and no quality loss.

The implementation writes the PDF itself — no dependency, no canvas capture:

- one page per still image (videos are excluded; ZIP is the right export),
- A4 page, image centred and aspect-ratio preserved,
- JPEG payload embedded verbatim; other formats are converted once through an
  offscreen canvas by the content script,
- real xref table + trailer so every PDF reader accepts the file.

## 9. Verification

### Offline (deterministic)

| Check | Command | Result |
|-------|---------|--------|
| Unit + integration + PDF + video + API-hardness + batch tests | `npm test` | **139 passing** |
| Structural validation | `npm run check` | loadable |
| ZIP opens in a real unzip tool | `unzip -t` | no errors |
| CRC-32 implementation | known vector `123456789` | `0xCBF43926` |
| PDF parsed by pdfinfo / mutool / Ghostscript | 1 page, A4, DCT 1206×1608, exit 0 | valid |

### In a real browser (Chromium, unpacked extension)

`npm run test:e2e` loads the actual extension into Chromium with
`www.pinterest.com` and `i.pinimg.com` redirected to a local mock origin:

| Check | Observed |
|-------|----------|
| Service worker registers | `background.js` |
| Content script injects the panel | panel visible on the board page |
| Per-pin buttons attached | 6 / 6 cards |
| Resource API reached | `BoardResource` + `BoardFeedResource` called |
| Media fetched at `/originals/` | 6 originals |
| ZIP written to disk | 195047 bytes, **8 entries** (6 pins + CSV + JSON) |
| PDF written to disk | 194983 bytes, **6 pages**, `/DCTDecode`, ends `%%EOF` |
| Single-pin download (board card) | 32000 bytes of JPEG |
| Single-pin download (`/pin/` closeup) | button injected, 32000 bytes of JPEG |
| ZIP contains the video as `.mp4` | yes |
| ZIP contains no `.m3u8` playlist | verified |
| HLS resolved through the worker | 2 playlists + 1 media file fetched |
| ZIP puts section pins in a folder | `Section_A/` present |
| PDF page count | exactly 8 — video pins excluded |
| Popup → content-script message (`downloadBoard`) | `{ok:true}`, archive produced |
| Popup UI renders | "Pin Saver" + status text, no console errors |
| Multi-select pick → archive | 2 picked → archive has **4 entries** (2 pins + metadata) |
| PDF converts a PNG pin to JPEG | 8 pages, `/DCTDecode` |
| Cancel selection | every tick cleared, status reset, re-selecting works |
| Successful ZIP reports success | panel shows `Saved 9 pins` |
| Successful PDF reports success | panel shows `Saved PDF with 8 pages` |
| A media request failing twice, then succeeding | recovered by retry — pin still archived |
| The board feed answering HTTP 500 once | retried (2 attempts), board still archived |
| Empty board | `No pins found` |
| Missing board | `Pinterest API error: Board not found. [40]`, styled as an error |
| Page / console errors | none |

`npm run test:e2e` → **52/52 checks**.

### Live against production Pinterest

`node scripts/live-test.js /pinterest/girls-night-in/` — real board, real API,
no mocks:

| Check | Observed |
|-------|----------|
| `fetchBoardId` resolved from the URL alone | `424605139808122051` |
| `fetchAllBoardPins` collected | 64 pins, all ids unique |
| Pins exposing a usable image URL | 64 / 64 |
| Pins exposing `images.orig` | 64 / 64 |
| Original media actually downloaded | `195175` bytes, `image/jpeg` |
| Live bytes packed into a ZIP | valid archive, opens in `unzip` |
| Sections on a real sectioned board | `Chocolate Recipes`, 1 section |
| Section page fetches | 49 pins + valid pagination bookmark |
| Pin tagged with section path | `["Chocolate Recipes"]` |
| Full archive from a live sectioned board | 444 pins collected (419 sectioned + 25 flat) |
| Real media downloaded and stored | 6 originals, valid `image/jpeg` |
| Archive structure | flat pins at board root, section pins under `Chocolate_Recipes/` |
| Archive integrity | `unzip -t` → no errors |
| Filename encoding | UTF-8 flag set, `Crème` / `—` survive a round-trip |
| HLS playlist resolved to a direct file | `<hash>_720w.cmfv`, bandwidth 2165688 |
| Video downloaded | `3845816` bytes, `video/mp4`, `ftyp` box present |

### Facts measured live that changed the implementation

1. **`page_size: 50` is silently capped to 25** for an anonymous visitor,
   while `page_size: 250` returns ~64 pins in one response. The shipped
   constant is therefore 250.
2. **`resource_response.bookmark` is absent for anonymous requests.** The
   cursor loop still works, but a logged-in session is required to page past
   the first response on a large board.
3. **`/originals/` answered 200 with the same bytes with and without a
   `Referer`** for the sampled image. The background-fetch path is kept
   because hotlink protection is applied inconsistently per asset, and the
   content script cannot set `Referer` at all.
4. **Real image buckets observed**: `170x`, `136x136`, `236x`, `474x`, `736x`,
   `orig`. This is why the rewrite pattern must accept both `NNNx` and
   `NNNxNNN`.
5. **Chrome JSON-serialises message payloads.** A `Uint8Array` sent through
   `chrome.runtime.sendMessage` arrives as `{"0":137,"1":80,...}`, so the ZIP
   writer received a plain object and aborted. All binary now crosses the
   message boundary as base64 text. This was found only by the browser test —
   the unit tests passed the whole time.
6. **Video pins return only an HLS playlist** (5 of the sampled pins had one).
   The actual media is a single `.cmfv` file referenced through
   `#EXT-X-MAP` plus byte-range segments; rewriting the path to `expMp4`
   returns 403. See §4.5.
7. **Feed pins carry no section data.** On a live board, 0 of 25 sampled pins
   had `sectionPath` or any section-ish key, so the folder feature does
   nothing unless `BoardSectionsResource` is called. Implemented and now
   verified end-to-end (the archive grows a `Section_A/` folder).
8. **Section and board feeds use different page-size limits.** 250 works for
   the board feed and returns `HTTP 400 "Invalid parameters"` for the section
   feed; 50 works for both. Verified on a live board with 4 sections.
9. **UTF-8 file-name flag matters.** Titles can contain `è` or an em dash.
   Without the ZIP UTF-8 flag (0x0800) in both the local header and the central
   directory, extractors guess an encoding and mangle the names. The flag is
   set on every entry and asserted by a test.
10. **An idea pin's video lives only under `story_pin_data`**, sometimes with no
   `images` at all. Filtering a PDF by `images` alone let video pins through;
   they then failed at render time and were silently counted as skipped. Both
   sources are checked now, and the browser test asserts the PDF page count is
   exactly the number of stills.

## 10. Known limitations

- The resource API is undocumented and may change; the `x-app-version`
  fallback constant will eventually need updating. The version is read from
  the page at runtime, so a real visit usually avoids the constant entirely.
- **A logged-in session is required to page past the first response** on a
  board larger than one feed page — the bookmark cursor is not issued to
  anonymous requests.
- Pinterest rate-limits aggressive pagination; the implementation pauses
  ~120 ms between pages.
- ZIP and PDF archives are built in memory, so an extremely large board
  (thousands of high-resolution videos) could exhaust tab memory.
- The media host list is pinned to `*.pinimg.com`; a new CDN host would need
  to be added.
- PDF export excludes video pins by design.
- Video is resolved to the best HLS variant only; the audio track is not
  separately handled, and true segmented `.ts` streams are refused.
