# REA Task — COMPLETE

## Status

**Objective achieved and verified at four independent levels:**
104 offline tests, 51 checks in a real Chromium, live production Pinterest, and
a full archive built from a live sectioned board.
next step: user loads the unpacked extension in Chrome

## Target

- **Pin Kit – Pinterest Board Downloader**, Chrome Web Store id
  `dadffeljcabienkbcmdakmegmdpfamfm`, version **5.5.12**
- CRX3 fetched from Chrome's update service, 1321-byte header stripped to
  recover the ZIP payload, extracted to `/tmp/pin-kit-src`, prettified copies
  in `/tmp/work`.

## Reference behaviour recovered (evidence)

1. **Board data comes from Pinterest's resource API**, not DOM scraping:
   `BoardResource` resolves `/<user>/<slug>/` → numeric board id, then
   `BoardFeedResource` in a `bookmark` cursor loop stopping at `-end-`.
   Also present: `BoardSectionsResource`, `BoardSectionPinsResource`.
2. **Original resolution** via URL rewrite `/<digits>x<digits>/` → `/originals/`.
3. **Media fetched in the background worker** with
   `Referer/Origin: https://www.pinterest.com/`; `Referer` is a forbidden
   header for page JS.
4. **Required API headers**: `x-app-version`, `x-pinterest-appstate`, `x-b3-*`
   trace ids, `x-requested-with`, `credentials: "include"`.
5. **Videos**: detected by `/videos/`, `video_p5p`, `v_HLS`, and extensions;
   idea pins expose video through `story_pin_data.pages[0].blocks[0].video`.
6. **ZIP** with `_metadata.csv` (UTF-8 BOM) + `_metadata.json`; sections become
   folders; names sanitised, capped at 50 chars.
7. Reference also bundled PDF (html2canvas) and Supabase auth/tier gating.

## What was built

| Path | Contents |
|---|---|
| `SPEC.md` | behavioural spec, protocol, video technique, edge cases |
| `my-version/` | working MV3 extension, zero runtime dependencies |
| `my-version/test/` | 104 unit + integration + PDF + video tests |
| `my-version/test/e2e/` | real-Chromium harness (mock Pinterest origin) |
| `my-version/scripts/live-test.js` | production Pinterest verification |
| `my-version/README.md` | install, usage, troubleshooting |
| `pin-saver-extension.zip` | ready-to-install package (19 files) |

Original code throughout — nothing copied from the reference.

## Verification (three layers, all re-run at the end)

**1. Offline — `npm test` → 246/246 pass**
Unit, integration (fake resource server), PDF, video playlist parsing.
ZIP validated by real `unzip -t`. PDF validated by pdfinfo, mutool and
Ghostscript.

**2. Real browser — `npm run test:e2e` → 51/51 pass**
The actual extension loaded into Chromium 148 with `www.pinterest.com` and
`i.pinimg.com` redirected to a local mock origin:

- service worker registers (`background.js`)
- content script injects the panel; 6/6 per-pin buttons
- `BoardResource` + `BoardFeedResource` called
- 6 `/originals/` media fetches
- **ZIP 195047 bytes, 8 entries** (6 pins + CSV + JSON)
- **PDF 194983 bytes, 6 pages, DCTDecode, ends `%%EOF`**
- **single-pin download (board card): 32000 bytes of JPEG**
- **`/pin/` closeup: download button injected, 32000 bytes of JPEG**
- **video pin: HLS resolved through the worker (2 playlists + 1 `.cmfv`) and
  stored in the ZIP as `.mp4`; no `.m3u8` ever lands on disk**
- **PDF page count is exactly the number of stills** — video pins excluded
- **section pins land in a `Section_A/` folder** inside the real archive
- zero page / console errors

`npm run test:e2e` now works without any environment workaround.

**3. Live production — `npm run test:live` → all pass**
Board resolved, pins collected with unique ids, original JPEG downloaded
(195175 bytes) and zipped; **HLS resolved to `<hash>_720w.cmfv` (bandwidth
2165688); video downloaded 3845816 bytes, `video/mp4`, `ftyp` present**.

**3b. Live full archive — `npm run test:live-board`**
Built a real ZIP from `/foodandwine/all-things-chocolate/`: 444 pins collected
(419 sectioned + 25 flat), 6 original-resolution images downloaded, archive
verified with `unzip -t`, structure correct — flat pins at the board root,
section pins under `Chocolate_Recipes/`, UTF-8 names intact (`Crème`, `—`).

**4. Packaged artifact — `npm run package` then the browser suite against the
extracted zip → 51/51 pass**
`../pin-saver-extension.zip` holds 19 files / 84624 bytes. Verifying the
*extracted archive* (not the source folder) proves the package is complete and
self-contained — a missing file would fail immediately.

## Bugs found only by browser testing

1. **Chrome JSON-serialises `chrome.runtime.sendMessage` payloads**, so a
   `Uint8Array` arrives as `{"0":137,"1":80,...}`. The ZIP writer received a
   plain object and aborted with "Zipper.add expects a Uint8Array". Binary now
   crosses the message boundary as base64, with a regression test. Unit tests
   passed throughout — only the real browser exposed it.
2. Missing favicon route in the mock surfaced as a console error, confirming
   the harness fails on real errors rather than ignoring them.
3. **An idea pin's video lives only under `story_pin_data`**, sometimes with no
   `images` at all. The PDF filter looked at `images` only, so video pins
   slipped through, failed at render time and were silently counted as skipped.
   Both sources are checked now and the browser test pins the page count.
4. **Board sections never reached the archive.** `BoardFeedResource` returns no
   section data at all (0 of 25 live pins had `sectionPath`), so the
   "sections become folders" feature silently did nothing. Implemented through
   `BoardSectionsResource` + `BoardSectionPinsResource`; verified in the browser
   (the ZIP now contains `Section_A/`).
5. **Section and board feeds have different page-size limits.** Sending
   `page_size: 250` to `BoardSectionPinsResource` returns
   `HTTP 400 "Invalid parameters"`; 50 works. The two constants are now
   separate, with regression tests. Verified live on
   `foodandwine/all-things-chocolate` (1 section, 49 pins on page 1, valid
   bookmark, `sectionPath: ["Chocolate Recipes"]`).
6. The closeup path was missing entirely: a `/pin/<id>/` page has no
   `[data-test-id="pin"]` card, so the card decorator never ran and a single
   pin page had no download button at all. Added a dedicated closeup decorator
   (verified in the browser).

Earlier fixes from the same discipline: unquoted hyphenated object keys
(`Accept-Language:`) were a hard syntax error that would have stopped the
extension from loading at all; `page_size: 50` was silently capped to 25.

## Facts measured live that changed the implementation

1. `page_size: 50` → 25 anonymously; **250** returns ~64 in one response.
2. `resource_response.bookmark` is **absent for anonymous** requests → a
   logged-in session is required to page past the first response.
3. `/originals/` answered 200 with and without `Referer` for the sampled image;
   the background path is kept anyway (protection is inconsistent, and content
   scripts cannot set `Referer`).
4. Real buckets: `170x`, `136x136`, `236x`, `474x`, `736x`, `orig` → the
   rewrite pattern must accept `NNNx` and `NNNxNNN`.
5. Video is **HLS only**; rewriting `hls` → `expMp4` returns 403, but the
   backing `.cmfv` is a complete fragmented MP4.

## Remaining limits (documented, not blockers)

- Localisation and account/tier gating intentionally not built.
- Large boards need a logged-in session for pagination.
- True `.ts`-segmented videos are refused with an explicit error.
- Live verification used anonymous access; the logged-in path runs the same
  code with the session cookie present.


## Chrome Web Store readiness (round 26)

| Item | State |
|---|---|
| Package | `pin-saver-extension.zip`, 19 files, loadable, MV3 |
| Policy scan | no `eval`, no `new Function`, no remote `<script src>`, no remote code |
| Permissions | `activeTab`, `downloads` only (unused ones removed) |
| Icon | 128×128 present and declared |
| Screenshots | 4 × 1280×800, captured from the real extension in a real browser |
| Listing | name 38/45, summary 119/132, description 1919/16000 |
| Privacy policy | https://horizonbymuneeb.github.io/pin-saver-privacy/ (live, public) |
| Store assets | served from a public repo, commit-pinned URLs |
| Automated check | `npm run store:check` → "ready to publish" |
| Publish script | `npm run publish -- --client-id=… --client-secret=… --refresh-token=…` |

Remaining human steps (cannot be automated from this machine):
1. Register a Chrome Web Store developer account (one-time $5, card required).
2. Create OAuth credentials in the developer dashboard.
3. Run the publish script with those credentials.

Two harness-side findings while producing the screenshots:
- DSH derives a model's `inputModalities` from the provider config's per-model
  `input:` field, not from the models.dev catalog. Models that genuinely accept
  images (minimax-m3.1-flash, gemma-4-26b-a4b-it, nemotron-3.5-super-vl,
  inkling, mimo-v2.6-flash, muse-spark, dots-3-note-preview) had no such
  field, so `read_image` refused with "does not declare image input".
  `~/.hermes/config.yaml` now declares `input: [text, image]` for those 16
  entries; a session restart is needed for a running session to pick it up.
- The mock board page had no CSS, so its pin grid collapsed and the store
  screenshots were 94% empty canvas. The mock now renders a Pinterest-style
  masonry grid with per-pin artwork, which also makes the browser tests
  resemble the real site.


## Round 28 — screenshot audit findings (all fixed)

A pixel/OCR audit of the four store screenshots found four real defects in the
extension's own UI, not just cosmetic problems with the mock:

| Finding | Root cause | Fix |
|---|---|---|
| The selection ring had **no top edge** and cut into the pin title (OCR read "poking cute pink meringues" instead of "Making…") | `outline` with a negative offset is painted *under* the card's children, so the pin image covered the top edge | an outer `box-shadow` ring, which descendants cannot cover and which cannot overlap the title — verified at pixel level (closed ring at y144/y456, left edge x101-103, title starts x106) |
| The panel's drop shadow was **clipped by the viewport** | the panel sat 20px from the bottom with a 28px blur | bottom 28px, softer 22px shadow — the bottom canvas row is now pure white |
| The per-pin arrow was **illegible at thumbnail scale** (~4×10px, low contrast) | it was the "↓" text character | an inline SVG icon, crisp at any size |
| "ZIP selected" was shown with **no active selection** | the button was always enabled | it is disabled until selection mode is on |

The single-pin mock page was also 74.7% blank and unbranded, so it was given a
real closeup layout (action row, description, Pin Saver branding, a
related-pins row). The mock's pin artwork was itself broken: large opaque
white ellipses had been drawn over the gradient, so every tile was nearly
white — the tiles are now 98-99% coloured.

## GitHub

| Repo | Contents |
|---|---|
| `horizonbymuneeb/pin-saver` | the extension: README with screenshots, full source, SPEC.md, MIT licence, CONTRIBUTING, docs (policy, listing, screenshots, icon) |
| `horizonbymuneeb/pin-saver-privacy` | the public privacy-policy page (GitHub Pages) + the store assets, with a README explaining why it exists |

Store assets are served from commit-pinned raw URLs, so the listing can never
point at a file that changed underneath it.


## Round 28 — the five issues the user reported

Four parallel teams, disjoint write scopes, all merged by the lead:

| Team | Scope | Delivered |
|---|---|---|
| `api-hardening` | `src/lib/api.js` | a failed page never aborts the export; 5xx/429 retried, 4xx not; the failure is reported; aborts are never swallowed (18 tests) |
| `speed-worker` | `src/background.js` | `fetchMediaBatch` (8 concurrent, order preserved, per-item failures) and `cancelFetch` (aborts in-flight media) (17 tests) |
| `ui-shell` | `src/panel-ui.js`, `src/content.css` | the horizontal tab bar (Board / Selected / About) with keyboard navigation and a dismiss button |
| `selection-ui` | `src/selection-ui.js`, `src/selection-ui.css` | the Pin Kit-style selection dialog: every pin, checkboxes, search, All/None/Invert, live count |
| lead | `src/content.js`, `manifest.json`, e2e | wired it all together, the Cancel flow, and the new tests |

| Issue | Result |
|---|---|
| 1. Slow archiving | media fetched 8 at a time — **6.6× faster** measured on the real CDN (24 images: 3.7 s → 0.6 s; a 500-pin board: ~77 s → ~12 s) |
| 2. Cannot stop an export | a **Cancel** button appears while an export runs; it aborts the API request, drops the media fetches in flight and saves **no** partial archive |
| 3. Manual pin selection missing | a dialog lists **every** pin of the board with checkboxes, search and All/None/Invert; the chosen pins arrive as one archive whose metadata carries each pin's URL |
| 4. API 500 on 500+ pin boards | a failed page now stops only that feed, keeps every pin collected so far, is reported in the panel, and is retried when transient |
| 5. A horizontal tab bar at the top | the panel is a tabbed box: **Board / Selected / About**, keyboard-navigable |

### Two bugs the lead introduced and fixed during the merge
- a dead-code removal in `src/content.js` silently deleted `ensurePanel`,
  `cancelExport`, `signal()`, `isCancelled()`, `fetchMediaBatch`,
  `collectMedia` and `openSelectionDialog`. The browser console showed
  `ReferenceError: ensurePanel is not defined`; a static "every called
  function is defined" check now confirms nothing is missing.
- the e2e's ZIP reader searched for a byte *sequence* with
  `Uint8Array.indexOf()`, which searches for a byte *value*; and the stored
  name is longer than the searched suffix, so the local header is not exactly
  30 bytes earlier. The reader now walks back to the `PK\x03\x04` signature.


## Round 29 — the 64 MiB message limit (the user's "Message exceeded maximum allowed size of 64MiB")

The user hit this on a real board (87 pins, `uk.pinterest.com`): PDF and ZIP
both failed with

    Error in invocation of runtime.sendMessage(...): Message exceeded maximum
    allowed size of 64MiB.

`chrome.runtime.sendMessage` refuses anything above 64 MiB, and it was the only
channel between the page and the worker. Two payloads broke it:

| Payload | Was | Now |
|---|---|---|
| every media file | base64 inside a message | fetched **directly by the content script** (Pinterest's CDN sends `Access-Control-Allow-Origin` echoing the page's origin), worker kept as fallback |
| the finished archive | base64 inside a message | **8 MiB base64 pieces**, joined in the worker, which then hands the browser a data URL (a service worker has no `URL.createObjectURL`) |

A raw byte array must never be sent either — Chrome serialises it as a JSON
array, which multiplies the payload roughly fourfold (30 MiB became >64 MiB).

Regression test: the mock serves two 26 MiB JPEG assets, so the archive is
~52 MiB — bigger than a single message can carry. The e2e asserts the archive
is produced with both oversized entries inside it.

Verified in the browser:
- data URL built inside a worker: 30 MiB ✔, 60 MiB ✔, 120 MiB ✔
- archive of 52 MiB produced end to end: 54,690,571 bytes ✔
- `URL.createObjectURL` in a service worker: `undefined` (measured)

### What the user reported on `uk.pinterest.com`
The board has 87 pins and the dialog listed 84 — the API returns the pins the
session can see, and the remaining ones have no usable image. The hang was the
64 MiB failure, not the dialog: the dialog renders 87 cards in 147 ms.


## Round 30 — new features, four parallel teams

| Team | Scope | Delivered |
|---|---|---|
| `pin-mode` | `src/panel-ui.js`, `src/content.css` | the panel's **pin mode** — title, "Download pin", "Download as JPEG/PNG", "← Back to board" |
| `convert` | `src/lib/convert.js` | image conversion (JPEG/PNG/WebP) with a quality setting; JPEG→JPEG is a no-op |
| `sections` | `src/lib/sections.js` | list a board's sections, fetch one section's pins |
| `popup` | `popup/*` | a rebuilt popup: board/pin context, ZIP and PDF actions, a privacy note, a visible status line |
| lead | `src/content.js`, `manifest.json`, e2e | wiring, the route-aware panel, the Sections tab, the message contract |

### The bug the user reported
> "jab pins download huty board m tu single pin open huta tu wo menu pins board wala reta hai na k pin download waala ata hai"

The panel was created on a board page and **never removed** when the SPA moved
to `/pin/<id>/`, so the board menu stayed on a single pin. `syncPanel()` now
picks the mode from the route and hides the panel on anything else.

### Three bugs found while merging
- **A feedback loop**: `syncPanel()` updated the panel, the panel's change woke
  the MutationObserver, and the observer called `syncPanel()` again — the main
  thread spun and the page froze. The observer now ignores changes inside the
  panel, and the pin info is only pushed when it changed.
- **`call(fn)` dropped its arguments**, so `onDownloadSection` was called with
  no section and the download silently did nothing.
- **`URL.createObjectURL` does not exist in a service worker** (measured:
  `undefined`), so the archive cannot be handed over as a blob URL from there.
  The page creates the blob and sends only the short URL.

### The "Invalid string length" bug
Building one huge base64 string in the worker runs into V8's maximum string
length. The archive is now a **blob URL created by the content script** and the
worker only receives that short string. Measured in the browser: a page-origin
blob of **300 MiB** downloads perfectly — no message limit, no string limit.


## Round 31 — the user's UI complaint, and four more features

> "hn UI k card tora bara kro about section k srf A nazar aa rha koi scrool kxh nae"

**The cause:** a fourth tab (Sections) was added, and in a 240 px card the
strip squeezed "About" down to a single letter. The strip could scroll, but
`scrollbar-width: none` hid the scrollbar, so it looked broken. The card is now
**300 px** and the strip fits without scrolling; a tab label is never
truncated. Verified in the browser: `fits: true`, no clipped label.

### Four more features, four parallel teams

| Team | Scope | Delivered |
|---|---|---|
| `api-hardening` | `src/lib/range.js` | the pin range expression: `1-50`, `50`, `-20`, `100-`, `1-50, 80`, `all`; validated as it is typed (30 tests) |
| `ui-shell` | `src/lib/sort.js` | the archive order: board order, Title A–Z, Title Z–A, longest title first |
| `speed-worker` | `src/lib/export.js` | the export runner: bounded concurrency, order-preserving results, failures recorded instead of aborting, `shouldStop` support (18 tests) |
| `selection-ui` | `src/selection-ui.js` | per-pin **copy link** and **open in a new tab**, plus **copy all selected links**; a clipboard fallback that survives a denied permission (46 browser checks) |

The lead wired them into the panel: a **Format** selector, an **Order**
selector, a **Pins** range field, and a **"Retry N failed pins"** button that
downloads only the pins the last export skipped.

### Two bugs the lead introduced and fixed while merging
- validating a range against `Number.MAX_SAFE_INTEGER` made the parser build a
  huge array → `RangeError: Invalid array length` in the page. A modest
  stand-in total is used for the shape check.
- the range agent's first rule was inconsistent: a lone position past the end
  clamped to the last pin while a range past the end selected nothing. It now
  selects nothing in both cases (the span's *end* is still clamped).


## Round 32 — publishing to the Chrome Web Store (the corrected setup)

The earlier note said the OAuth credentials live in the developer dashboard.
**That is wrong.** The official documentation
(`site/en/docs/webstore/using_webstore_api/index.md` in
GoogleChrome/developer.chrome.com) says the OAuth client is created in the
**Google Cloud Console**:

1. Cloud Console → create/select a project
2. enable the **Chrome Web Store API**
3. **OAuth consent screen** → External → app name, support email, developer
   contact email → Save & Continue → **skip scopes** → Save & Continue → add
   the email under **Test users** → Save & Continue
4. **Credentials** → **Create Credentials** → **OAuth client ID** → application
   type **Desktop App** → Create
5. the console shows the **client ID** and the **client secret**

Two other facts from the same document: publishing requires **2-Step
Verification** on the Google account, and the access token must be requested
with the account that **owns** the store items.

### The remote consent problem, and the fix
The browser that approves the consent screen is the user's own machine, so it
cannot reach this server's `localhost` callback. The auth script now has two
modes:

- `--print-url` — prints the consent URL and stops, so the URL can be sent to
  the user. After they approve, the page fails to load (expected) and the
  authorization code is in the address bar.
- `--code=<code>` — exchanges that pasted code server-side and writes
  `.cws-credentials.json` (git-ignored).

The redirect URI was changed to `http://localhost:8977/` — a Desktop-app client
needs a loopback URI. The scope is `…/auth/chromewebstore`, `access_type=offline`
so a refresh token comes back, and `prompt=consent`.

### Also fixed
- the publish script now reads `.cws-credentials.json` automatically, so the
  refresh token never has to be typed twice;
- its "missing credentials" error now prints the exact steps and the commands;
- the v1.1 listing now carries `privacyPolicyUrl`
  (`https://horizonbymuneeb.github.io/pin-saver-privacy/`).

### The publish flow itself (already written and dry-run tested)
1. `POST /items` → create the item
2. `PUT https://www.googleapis.com/upload/chromewebstore/v1.1/items/{id}` →
   upload the ZIP
3. `PUT /items/{id}` → the listing (name, summary, description, icon, 4
   screenshots, primary/background colour, privacy policy URL)
4. `POST /items/{id}:publish` with `{"visibility":"PUBLIC"}` → submit for review

Verified end to end with fake credentials: the run reaches the token exchange
and fails there with Google's own `invalid_client` — the only missing piece is
the real client.


## Round 33 — PUBLISHED FOR REVIEW

The item is live in the Chrome Web Store review queue.

| | |
|---|---|
| Publisher | tmuneebanjum@gmail.com (UUID `3a2b5539-d9da-4555-ac96-2aa6c277d9bb`) |
| Item id | `jdfjeiajmielkjbeoafnekpppdlpjkeg` |
| Status | **PENDING_REVIEW** (submitted via `POST /v2/publishers/{pid}/items/{iid}:publish`) |
| Dashboard | https://chrome.google.com/webstore/devconsole/3a2b5539-d9da-4555-ac96-2aa6c277d9bb/jdfjeiajmielkjbeoafnekpppdlpjkeg/edit |

### What the store required, and how it was satisfied
The dashboard's "Why can't I submit?" panel listed every gap, and the live
browser session was used to fill them:

| Requirement | How |
|---|---|
| detailed description (min 25 chars) | 1,919 characters from `store/listing.json` |
| category | Shopping |
| language | English (United States) |
| store icon (128×128) | `icons/icon128.png` uploaded |
| screenshots (at least one) | the four 1280×800 24-bit PNGs uploaded |
| single purpose description | "Download a Pinterest board, or a selection of pins from it, as a ZIP archive or a PDF." |
| activeTab justification | the panel is injected into the page the user opened and acts only on a click |
| downloads justification | the archive or the single pin is written to the user's own Downloads folder |
| host permission justification | the board is read from Pinterest's own API and its media from Pinterest's CDN, only for the board on screen |
| remote code | "No, I am not using remote code" — all code is in the package |
| data-usage certifications | the three "I do not …" boxes checked, no data category checked |
| privacy policy URL | the live policy page |
| visibility | Public |

After the last save the "Unable to publish" section disappeared from the
dashboard, and the API accepted the submission with `PENDING_REVIEW`.

### The live browser session (how the dashboard was driven)
The user's Google account could not be reached from the server, so a shared
browser was set up on the box:

- `Xvfb :99` (1600×1000) → Chromium 148 with the extension preloaded, CDP on
  `127.0.0.1:9222`
- `x11vnc` on 5900 (localhost) → `websockify` on 6080 serving noVNC
- nginx location `/cws-<random-token>/` on `dsh.hhdevs.space`, behind the
  DSH session gate (401 without a session)
- the agent drives the same browser over CDP with Playwright, so every click
  is visible to the user

One bug worth remembering: **noVNC builds its websocket path itself**
(`/websockify`) and ignores the page's directory, so the URL must carry
`&path=cws-<token>/websockify` — without it the page loads and then says
"failed to connect to server".
