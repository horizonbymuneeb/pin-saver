/**
 * End-to-end test: load the real unpacked extension into a real Chromium,
 * point pinterest.com at a local mock origin, and drive the UI.
 *
 * This is the only test that proves the manifest, the service worker, the
 * content script and the message passing all work together inside Chrome.
 * The unit tests cannot show that — and they did not catch the real bug this
 * harness found: Chrome JSON-serialises message payloads, so a Uint8Array
 * arrives as `{"0":137,"1":80,...}` and the ZIP writer receives garbage.
 *
 * Requirements: playwright-core and a Chromium build.
 *   npm i -D playwright-core
 *   npx playwright install chromium        # or set CHROME_PATH
 *
 * Run: node test/e2e/run-e2e.js
 * Env: CHROME_PATH=/path/to/chrome  EXT_DIR=/path/to/extension
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch (_) {
  console.error(
    "playwright-core is required for the end-to-end test:\n" +
      "  npm i -D playwright-core && npx playwright install chromium",
  );
  process.exit(2);
}

const EXT = process.env.EXT_DIR || path.join(__dirname, "..", "..");
const PORT = Number(process.env.MOCK_PORT || 8443);
const DOWNLOADS = path.join(os.tmpdir(), "pinsaver-e2e-downloads");
const PROFILE = path.join(os.tmpdir(), "pinsaver-e2e-profile");

/** Locate a Chromium build without hard-coding one machine's cache path. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache).sort().reverse()) {
      if (!dir.startsWith("chromium-")) continue;
      const candidate = path.join(cache, dir, "chrome-linux", "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error("No Chromium found; set CHROME_PATH");
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? ": " + detail : ""));
}

/** Poll the download directory for a file whose magic bytes match. */
async function waitForFile(magic, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let files = [];
    try {
      files = fs.readdirSync(DOWNLOADS).filter((f) => !f.endsWith(".crdownload"));
    } catch (_) {
      files = [];
    }
    for (const f of files) {
      let buf;
      try {
        buf = fs.readFileSync(path.join(DOWNLOADS, f));
      } catch (_) {
        continue;
      }
      if (buf.subarray(0, magic.length).equals(magic)) return { path: f, bytes: buf };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

(async function main() {
  const mock = require("./server.js");

  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const chromePath = findChrome();
  console.log("Chromium: " + chromePath);
  console.log("Extension: " + EXT);
  console.log("");

  const context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: chromePath,
    headless: true,
    acceptDownloads: true,
    downloadsPath: DOWNLOADS,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--ignore-certificate-errors",
      "--disable-extensions-except=" + EXT,
      "--load-extension=" + EXT,
      "--host-resolver-rules=MAP www.pinterest.com 127.0.0.1:" + PORT +
        ", MAP i.pinimg.com 127.0.0.1:" + PORT +
        ", MAP v1.pinimg.com 127.0.0.1:" + PORT +
        // A country domain, like the one a non-US user sees.
        ", MAP in.pinterest.com 127.0.0.1:" + PORT,
    ],
  });

  const pageErrors = [];
  const consoleErrors = [];

  let worker = context.serviceWorkers()[0];
  if (!worker) {
    try {
      worker = await context.waitForEvent("serviceworker", { timeout: 20000 });
    } catch (_) {
      worker = null;
    }
  }
  record(
    "extension service worker registered",
    Boolean(worker),
    worker ? worker.url().split("/").pop() : "not found",
  );

  // Pretend the user is already signed in to Pinterest. The extension must use
  // this session automatically; it has no login flow of its own.
  await context.addCookies([
    {
      name: "SESSIONID",
      value: "fake-logged-in-session",
      domain: ".pinterest.com",
      path: "/",
      secure: true,
      httpOnly: true,
    },
  ]);

  const page = await context.newPage();

  /** List the entry names inside a stored (uncompressed) ZIP archive. */
  function zipEntryNames(bytes) {
    const buf = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset || 0, bytes.length);
    const names = [];
    let at = 0;
    while (at < buf.length - 4) {
      if (buf.readUInt32LE(at) !== 0x04034b50) break;
      const nameLen = buf.readUInt16LE(at + 26);
      const extra = buf.readUInt16LE(at + 28);
      const size = buf.readUInt32LE(at + 18);
      names.push(buf.slice(at + 30, at + 30 + nameLen).toString("utf8"));
      at += 30 + nameLen + extra + size;
    }
    return names;
  }

  /**
   * Read one text entry out of a stored (uncompressed) ZIP archive.
   * The extension writes store-only archives, so the bytes are plain text.
   */
  function entryText(bytes, needle) {
    // Uint8Array.indexOf() searches for a byte VALUE, not a byte sequence, so
    // the buffer is made first.
    const buf = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset || 0, bytes.length);
    const name = Buffer.from(needle, "utf8");
    let at = buf.indexOf(name);
    while (at !== -1) {
      // The searched text is usually a SUFFIX of the stored file name, so the
      // local header is not exactly 30 bytes earlier: walk back to the nearest
      // "PK\x03\x04" signature instead.
      let header = at - 30;
      while (header >= 0 && buf.readUInt32LE(header) !== 0x04034b50) header--;
      if (header >= 0) {
        const nameLen = buf.readUInt16LE(header + 26);
        const extra = buf.readUInt16LE(header + 28);
        const size = buf.readUInt32LE(header + 18);
        const start = header + 30 + nameLen + extra;
        return buf.slice(start, start + size).toString("utf8");
      }
      at = buf.indexOf(name, at + 1);
    }
    return "";
  }

  /** Switch the panel to one of its horizontal tabs. */
  async function openTab(name) {
    const tab = page.locator('#pinsaver-panel [data-pinsaver-tab="' + name + '"]');
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(150);
      return true;
    }
    return false;
  }


  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await page.goto("https://www.pinterest.com/pinterest/girls-night-in/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  record("mock board page loaded", page.url().includes("girls-night-in"));

  // --- injection -----------------------------------------------------------
  let panelVisible = false;
  try {
    await page.waitForSelector("#pinsaver-panel", { timeout: 15000 });
    panelVisible = true;
  } catch (_) {}
  record("content script injected the panel", panelVisible);

  const pinButtons = await page.locator(".pinsaver-pin-btn").count();
  record("exactly one button per pin card", pinButtons === 6, pinButtons + " buttons (12 would mean duplicates)");

  const panelText = panelVisible
    ? await page.locator("#pinsaver-panel").innerText()
    : "";
  record("panel offers ZIP", panelText.includes("ZIP"));
  const signedInNotices = await page.locator("#pinsaver-panel .pinsaver-notice").count();
  record("normal board shows no signed-out notice", signedInNotices === 0, signedInNotices + " notices");
  record("panel offers PDF", panelText.includes("PDF"));

  // The panel now also carries the pin-mode section, so the board actions are
  // picked by their name rather than by position.
  const boardZipBtn = page.locator("#pinsaver-panel .pinsaver-btn", { hasText: /board as ZIP/i });
  const boardPdfBtn = page.locator("#pinsaver-panel .pinsaver-btn", { hasText: /board as PDF/i });

  // --- ZIP ---------------------------------------------------------------
  const beforeZip = mock.log.length;
  await boardZipBtn.first().click(); // "Download board as ZIP"

  const zip = await waitForFile(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 90000);
  record("ZIP produced and saved", Boolean(zip), zip ? zip.bytes.length + " bytes" : "none");

  // One video pin points at a playlist that 404s. It must be skipped and
  // counted, not abort the archive.
  record(
    "a broken video pin does not abort the archive",
    Boolean(zip),
    zip ? "archive still produced" : "archive aborted",
  );

  // A successful download must be reported as success, not as a failure.
  let zipStatus = "";
  for (let i = 0; i < 20; i++) {
    zipStatus = await page.locator("#pinsaver-panel .pinsaver-status").innerText();
    if (/Saved/i.test(zipStatus)) break;
    await page.waitForTimeout(250);
  }
  record("ZIP reports success in the panel", /Saved/i.test(zipStatus), JSON.stringify(zipStatus));

  const zipPaths = mock.log.slice(beforeZip).map((e) => e.path);
  record("called BoardResource", zipPaths.some((p) => p.includes("BoardResource")));
  record("called BoardFeedResource", zipPaths.some((p) => p.includes("BoardFeedResource")));
  // The first feed request answers 500; a retry must recover it.
  record(
    "a transient API 500 is retried, not fatal",
    Boolean(zip) && zipPaths.filter((p) => p.includes("BoardFeedResource")).length >= 2,
    zipPaths.filter((p) => p.includes("BoardFeedResource")).length + " feed attempts",
  );
  const originals = zipPaths.filter((p) => p.startsWith("/originals/"));
  record(
    "fetched original-resolution media",
    originals.length >= 6,
    originals.length + " originals",
  );

  if (zip) {
    const eocdAt = zip.bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocdAt >= 0) {
      const entries = zip.bytes.readUInt16LE(eocdAt + 10);
      // 6 image pins + 1 video pin + _metadata.csv + _metadata.json
      record("ZIP holds every pin plus metadata", entries >= 11, entries + " entries");

  // A message may not exceed 64 MiB. Two 40 MiB assets used to travel back
  // from the worker as base64 and killed the export with "Message exceeded
  // maximum allowed size of 64MiB". The bytes must never go through a
  // message at all.
  const names = zipEntryNames(zip.bytes);
  const bigEntries = names.filter(function (n) {
    return /pin[ _]4\b/.test(n) || /pin[ _]5\b/.test(n);
  });
  record(
    "media larger than a message can carry still downloads",
    bigEntries.length >= 2 && zip.bytes.length > 40 * 1024 * 1024,
    bigEntries.length + " oversized entries, archive " +
      Math.round(zip.bytes.length / 1048576) + " MiB",
  );
      // One image is served 503 twice before succeeding; a retry must recover it
      // instead of silently dropping the pin.
      record(
        "a flaky media request is retried, not dropped",
        entries === 11,
        entries + " entries (12 would mean a phantom, 10 a dropped pin)",
      );
    }

    // The video pin must arrive as a playable .mp4, not an .m3u8 playlist.
    const zipText = zip.bytes.toString("latin1");
    record("ZIP contains the video as .mp4", zipText.includes(".mp4"));
    record("ZIP puts section pins in a folder", zipText.includes("Section_A/"));
    record("ZIP does NOT contain an .m3u8 playlist", !zipText.includes(".m3u8"));
  }

  // The API calls must carry the signed-in session cookie.
  const apiCalls = mock.log.filter(function (e) {
    return e.path.indexOf("/resource/") === 0;
  });
  const withSession = apiCalls.filter(function (e) {
    return e.cookie.indexOf("SESSIONID=fake-logged-in-session") !== -1;
  });
  record(
    "the existing Pinterest session is forwarded to the API",
    apiCalls.length > 0 && withSession.length === apiCalls.length,
    withSession.length + "/" + apiCalls.length + " API calls carried the cookie",
  );

  // HLS resolution happens in the background worker via the fetchText action.
  const hlsRequests = zipPaths.filter((p) => p.endsWith(".m3u8"));
  const mediaRequests = zipPaths.filter((p) => p.endsWith(".cmfv"));
  record("HLS playlists fetched through the worker", hlsRequests.length >= 2, hlsRequests.length + " playlists");
  record("backing media file fetched", mediaRequests.length >= 1, mediaRequests.length + " files");

  // --- PDF ---------------------------------------------------------------
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  await boardPdfBtn.first().click(); // "Download board as PDF"

  const pdf = await waitForFile(Buffer.from("%PDF"), 90000);
  record("PDF produced and saved", Boolean(pdf), pdf ? pdf.bytes.length + " bytes" : "none");
  let pdfStatus = "";
  for (let i = 0; i < 20; i++) {
    pdfStatus = await page.locator("#pinsaver-panel .pinsaver-status").innerText();
    if (/Saved/i.test(pdfStatus)) break;
    await page.waitForTimeout(250);
  }
  record("PDF reports success in the panel", /Saved/i.test(pdfStatus), JSON.stringify(pdfStatus));
  if (pdf) {
    const text = pdf.bytes.toString("latin1");
    const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    // 6 image pins; the video pin must be excluded from a PDF.
    // 6 board stills + 2 section stills; the video pin is excluded.
    record("PDF has one page per image", pages === 8, pages + " pages");
    record("PDF embeds JPEG via DCTDecode", text.includes("/DCTDecode"));
    record("PDF ends with %%EOF", text.trimEnd().endsWith("%%EOF"));
  }

  // --- single pin --------------------------------------------------------
  // The per-pin button downloads straight through chrome.downloads.
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  await page.locator(".pinsaver-pin-btn").first().click();

  const jpeg = await waitForFile(Buffer.from([0xff, 0xd8, 0xff]), 60000);
  record("single-pin download works", Boolean(jpeg), jpeg ? jpeg.bytes.length + " bytes" : "none");

  // --- single pin page (closeup) -----------------------------------------
  // A /pin/ page has no [data-test-id="pin"] card, so it exercises the
  // dedicated closeup path.
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  await page.goto("https://www.pinterest.com/pin/123456/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  let closeupBtn = false;
  try {
    await page.waitForSelector("#pinsaver-closeup-btn", { timeout: 15000 });
    closeupBtn = true;
  } catch (_) {}
  record("closeup page gets a download button", closeupBtn);

  if (closeupBtn) {
    await page.locator("#pinsaver-closeup-btn").click();
    const closeupJpeg = await waitForFile(Buffer.from([0xff, 0xd8, 0xff]), 60000);
    record(
      "closeup download works",
      Boolean(closeupJpeg),
      closeupJpeg ? closeupJpeg.bytes.length + " bytes" : "none",
    );
  }

  // --- multi-select (Pin Kit style dialog) --------------------------------
  // The reference product opens a panel that lists every pin of the board with
  // a checkbox, so any pin can be picked — not only the ones on screen.
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });

  // The previous phase left us on a /pin/ page, which has no board panel.
  await page.goto("https://www.pinterest.com/pinterest/girls-night-in/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForSelector("#pinsaver-panel", { timeout: 20000 });

  await openTab("selected");
  const selectBtn = page.locator("#pinsaver-panel .pinsaver-btn", { hasText: /select/i });
  await selectBtn.first().click();

  await page.waitForSelector(".pinsaver-sel-overlay", { timeout: 30000 });
  const dialogCards = await page.locator(".pinsaver-sel-card").count();
  record("selection dialog lists the board's pins", dialogCards >= 6, dialogCards + " cards");

  const checks = page.locator(".pinsaver-sel-check");
  await checks.nth(0).check();
  await checks.nth(1).check();
  const countText = await page.locator(".pinsaver-sel-count").innerText();
  record("the dialog counts the selection", /2 of/.test(countText), countText.trim());

  const downloadLabel = await page.locator(".pinsaver-sel-btn--primary").innerText();
  record("the download button shows the count", /2/.test(downloadLabel), downloadLabel.trim());

  await page.locator(".pinsaver-sel-btn--primary").click();
  const selZip = await waitForFile(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 90000);
  record("the selected pins download as one archive", Boolean(selZip), selZip ? selZip.bytes.length + " bytes" : "none");

  if (selZip) {
    const eocd = selZip.bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const entries = eocd >= 0 ? selZip.bytes.readUInt16LE(eocd + 10) : 0;
    // 2 picked pins + _metadata.csv + _metadata.json — not the whole board.
    record("the archive holds only the picked pins", entries === 4, entries + " entries");
  }

  // The metadata must carry the pin URL, the way the reference product does.
  const metaText = selZip
    ? await entryText(selZip.bytes, "_metadata.csv")
    : "";
  record(
    "the metadata carries each pin's URL",
    /https:\/\/www\.pinterest\.com\/pin\//.test(metaText),
    metaText.slice(0, 70).replace(/\s+/g, " "),
  );

  // Opening the dialog again and pressing Escape must change nothing.
  await openTab("selected");
  await page.locator("#pinsaver-panel .pinsaver-btn", { hasText: /select/i }).first().click();
  await page.waitForSelector(".pinsaver-sel-overlay", { timeout: 30000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const stillOpen = await page.locator(".pinsaver-sel-overlay").count();
  record("Escape closes the selection dialog", stillOpen === 0, stillOpen + " dialogs left open");

  // --- cancel a running export ---------------------------------------------
  // A long export used to be unstoppable.
  // A board whose media answers slowly, so the export is still running when
  // the Cancel button is pressed.
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  await page.goto("https://www.pinterest.com/pinterest/slow-board/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForSelector("#pinsaver-panel", { timeout: 20000 });
  await openTab("board");
  await boardZipBtn.first().click(); // ZIP
  const cancelVisible = await page
    .waitForSelector(".pinsaver-cancel:not([hidden])", { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  record("a running export offers a Cancel button", cancelVisible);

  if (cancelVisible) {
    await page.locator(".pinsaver-cancel").click();
    let cancelStatus = "";
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(300);
      cancelStatus = await page.locator("#pinsaver-panel .pinsaver-status").innerText();
      if (/cancel/i.test(cancelStatus)) break;
    }
    record("the export stops when it is cancelled", /cancel/i.test(cancelStatus), JSON.stringify(cancelStatus.trim()));
    // A cancelled export must not leave a half-finished archive behind.
    const afterCancel = fs.readdirSync(DOWNLOADS).filter(function (f) {
      return !f.endsWith(".crdownload");
    });
    record("a cancelled export saves no file", afterCancel.length === 0, afterCancel.join(", ") || "none");
  }

  // --- sections ----------------------------------------------------------
  // A board with sections can export one section on its own.
  await page.goto("https://www.pinterest.com/pinterest/girls-night-in/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForSelector("#pinsaver-panel", { timeout: 20000 });
  await openTab("sections");
  await page.waitForTimeout(1500);

  const sectionRows = page.locator("#pinsaver-panel .pinsaver-sections__row");
  const sectionCount = await sectionRows.count();
  record("the panel lists the board's sections", sectionCount >= 1, sectionCount + " sections");

  if (sectionCount >= 1) {
    fs.rmSync(DOWNLOADS, { recursive: true, force: true });
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    await sectionRows.first().locator(".pinsaver-sections__btn").click();
    const secZip = await waitForFile(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 90000);
    const secStatus = await page.locator("#pinsaver-panel .pinsaver-status").innerText();
    record(
      "one section downloads as its own archive",
      Boolean(secZip),
      secZip ? secZip.bytes.length + " bytes" : "status: " + JSON.stringify(secStatus.trim()),
    );
    if (secZip) {
      const names = zipEntryNames(secZip.bytes);
      record(
        "the section archive keeps the section folder",
        names.some(function (n) { return /Section/.test(n); }),
        names.slice(0, 3).join(", "),
      );
    }
  }

  // --- alternate DOM -----------------------------------------------------
  // Pinterest has shipped grids without the card marker. The extension must
  // still attach buttons, otherwise per-pin download dies on a markup change.
  await page.goto("https://www.pinterest.com/pinterest/alt-dom/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(1200);
  const altCards = await page.locator('[data-test-id="pin"]').count();
  const altButtons = await page.locator(".pinsaver-pin-btn").count();
  record("alternate DOM has no card marker", altCards === 0, altCards + " cards");
  record("buttons still attach via /pin/ anchors", altButtons >= 4, altButtons + " buttons");

  // --- gated / logged-out wall -------------------------------------------
  // Pinterest serves image placeholders to signed-out visitors. Decorating them
  // would produce download buttons that cannot work.
  await page.goto("https://www.pinterest.com/pinterest/gated-board/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(1200);
  const gatedButtons = await page.locator(".pinsaver-pin-btn").count();
  record(
    "no buttons on a gated login wall",
    gatedButtons === 0,
    gatedButtons + " buttons injected",
  );

  const gatedNotice = await page.locator("#pinsaver-panel .pinsaver-notice").count();
  const gatedNoticeText = gatedNotice
    ? await page.locator("#pinsaver-panel .pinsaver-notice").innerText()
    : "";
  record(
    "signed-out board explains the limited result",
    gatedNotice === 1 && /sign in/i.test(gatedNoticeText),
    JSON.stringify(gatedNoticeText.slice(0, 60)),
  );

  // --- country domain (cross-origin host) --------------------------------
  // A user on in.pinterest.com makes an API call to www.pinterest.com, which
  // is cross-origin: the browser preflights, Pinterest answers 400 without
  // Access-Control-Allow-Origin, and the request dies with "Failed to fetch".
  // The background worker holds host permissions, so it must succeed there.
  await page.goto("https://in.pinterest.com/pinterest/girls-night-in/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForSelector("#pinsaver-panel", { timeout: 20000 });

  const countryBtns = await page.locator("#pinsaver-panel .pinsaver-btn").allInnerTexts();
  await page.locator("#pinsaver-panel .pinsaver-btn").nth(
    countryBtns.findIndex(function (t) { return /pdf/i.test(t); }),
  ).click();

  let countryStatus = "";
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(500);
    countryStatus = await page.locator("#pinsaver-panel .pinsaver-status").innerText();
    if (/Saved|failed|error/i.test(countryStatus) && !/^Fetching|Reading/.test(countryStatus)) break;
  }
  record(
    "export works from a country domain (no 'Failed to fetch')",
    /Saved/i.test(countryStatus) && !/Failed to fetch/i.test(countryStatus),
    JSON.stringify(countryStatus.trim().slice(0, 60)),
  );

  // --- the panel follows the route -----------------------------------------
  // Pinterest is an SPA: clicking a pin moves to /pin/<id>/ without a reload.
  // The panel used to keep offering "Download board as ZIP" there.
  await page.goto("https://www.pinterest.com/pinterest/girls-night-in/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForSelector("#pinsaver-panel", { timeout: 20000 });
  const boardZip = page.locator('#pinsaver-panel .pinsaver-btn', { hasText: /ZIP/i });
  record(
    "the board actions are offered on a board",
    (await boardZip.count()) > 0 && (await boardZip.first().isVisible()),
  );

  await page.goto("https://www.pinterest.com/pin/9003/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForTimeout(1200);
  const boardZipOnPin = page.locator('#pinsaver-panel .pinsaver-btn', { hasText: /board as ZIP/i });
  const pinAction = page.locator('#pinsaver-panel .pinsaver-btn', { hasText: /Download pin/i });
  const boardStillOffered =
    (await boardZipOnPin.count()) > 0 && (await boardZipOnPin.first().isVisible().catch(() => false));
  const pinOffered =
    (await pinAction.count()) > 0 && (await pinAction.first().isVisible().catch(() => false));
  record(
    "the pin page offers the pin download, not the board download",
    pinOffered && !boardStillOffered,
    "pin action: " + pinOffered + ", board action: " + boardStillOffered,
  );

  // --- popup contract ----------------------------------------------------
  // The toolbar popup cannot touch the page directly: it sends
  // {action:"downloadBoard"} to the content script. Neither the popup UI nor
  // that message path is covered by the panel tests above.
  const extId = new URL(worker.url()).host;

  await page.goto("https://www.pinterest.com/pinterest/girls-night-in/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForSelector("#pinsaver-panel", { timeout: 15000 });

  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });

  let sent;
  try {
    sent = await worker.evaluate(function () {
      return new Promise(function (resolve) {
        chrome.tabs.query({ url: "https://www.pinterest.com/*" }, function (tabs) {
          if (!tabs || !tabs.length) {
            resolve({ ok: false, error: "no pinterest tab" });
            return;
          }
          chrome.tabs.sendMessage(tabs[0].id, { action: "downloadBoard" }, function (resp) {
            const err = chrome.runtime.lastError;
            resolve(err ? { ok: false, error: err.message } : resp || { ok: false, error: "no response" });
          });
        });
      });
    });
  } catch (err) {
    sent = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  record("popup message reaches the content script", Boolean(sent && sent.ok), JSON.stringify(sent));

  const popupZip = await waitForFile(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 60000);
  record("popup-triggered export produces a ZIP", Boolean(popupZip), popupZip ? popupZip.bytes.length + " bytes" : "none");

  // --- popup UI ----------------------------------------------------------
  const popup = await context.newPage();
  const popupErrors = [];
  popup.on("pageerror", (e) => popupErrors.push(String(e)));
  popup.on("console", (m) => {
    if (m.type() === "error") popupErrors.push(m.text());
  });
  let popupText = "";
  try {
    await popup.goto("chrome-extension://" + extId + "/popup/popup.html", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await popup.waitForTimeout(600);
    popupText = await popup.locator("body").innerText();
  } catch (err) {
    popupErrors.push(String(err && err.message ? err.message : err));
  }
  record("popup renders its UI", popupText.indexOf("Pin Saver") !== -1);
  record("popup reports a status", popupText.length > 0, popupText.replace(/\s+/g, " ").slice(0, 60));
  record(
    "the popup states that nothing is collected",
    /collects nothing|no telemetry|collects no data/i.test(popupText),
    /collects nothing|no telemetry|collects no data/i.test(popupText)
      ? "privacy note present"
      : "missing",
  );
  record(
    "the popup offers a board export",
    /ZIP|PDF/i.test(popupText),
    (popupText.match(/Download[^\n]*/g) || []).join(" / ").slice(0, 60),
  );
  const popupBad = popupErrors.filter((t) => !/favicon|net::ERR/i.test(t));
  record("popup has no console errors", popupBad.length === 0, popupBad.slice(0, 2).join(" | ") || "none");
  await popup.close();

  // --- health ------------------------------------------------------------
  record("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ") || "none");
  // Chrome logs a failed fetch for each deliberately injected transient error;
  // allow exactly that many, and no more.
  let allowedTransient = mock.stats ? mock.stats.injectedFailures : 0;
  const badConsole = consoleErrors.filter(function (t) {
    if (/favicon|net::ERR/i.test(t)) return false;
    if (allowedTransient > 0 && /50[03] \((Internal Server Error|Service Unavailable)\)/.test(t)) {
      allowedTransient--;
      return false;
    }
    return true;
  });
  record(
    "no unexpected console errors",
    badConsole.length === 0,
    badConsole.slice(0, 2).join(" | ") || "none",
  );

  await context.close();
  mock.server.close();

  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length) {
    console.log("RESULT: " + failed.length + " of " + results.length + " checks failed");
    process.exit(1);
  }
  console.log("RESULT: all " + results.length + " end-to-end checks passed");
})().catch((err) => {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
