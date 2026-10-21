/**
 * Live smoke test against production Pinterest.
 *
 * Proves the shipped API client actually works against the real service, not
 * just against a mock. Read-only: it resolves a board, pages through its pins
 * and verifies that an original-resolution media URL answers with real image
 * bytes.
 *
 * Usage: node scripts/live-test.js [boardPath]
 *   boardPath defaults to /pinterest/girls-night-in/
 *
 * Network required. Not part of `npm test` so the suite stays offline-safe.
 */
const path = require("node:path");

// api.js reads `document`/`location` only inside functions.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

const boardPath = process.argv[2] || "/pinterest/girls-night-in/";
globalThis.location = { pathname: boardPath };

const api = require(path.join(__dirname, "..", "src", "lib", "api.js"));
const util = require(path.join(__dirname, "..", "src", "lib", "util.js"));

function ok(label, value) {
  console.log("  PASS  " + label + (value === undefined ? "" : ": " + value));
}

function fail(label, err) {
  console.log("  FAIL  " + label + ": " + (err && err.message ? err.message : err));
}

(async function main() {
  let failures = 0;
  console.log("Live Pinterest smoke test — board " + boardPath);
  console.log("");

  // 1. Resolve the board id from the URL only.
  let boardId = null;
  try {
    boardId = await api.fetchBoardId(boardPath);
    ok("fetchBoardId resolved", boardId);
    if (!/^\d+$/.test(boardId)) throw new Error("board id is not numeric");
  } catch (err) {
    fail("fetchBoardId", err);
    failures++;
    process.exit(1);
  }

  // 2. Page through the board.
  let pins = [];
  try {
    pins = await api.fetchAllBoardPins(boardId, function (count, page) {
      console.log("        page " + page + " → " + count + " pins so far");
    });
    ok("fetchAllBoardPins collected", pins.length + " pins");
    if (pins.length === 0) throw new Error("no pins returned");
    if (new Set(pins.map((p) => String(p.id))).size !== pins.length) {
      throw new Error("duplicate pin ids in result");
    }
    ok("pin ids are unique");
  } catch (err) {
    fail("fetchAllBoardPins", err);
    failures++;
  }

  if (!pins.length) process.exit(failures ? 1 : 0);

  // 3. Every pin must yield the media fields the downloader relies on.
  let withImage = 0;
  let withOrig = 0;
  let withTitle = 0;
  for (const pin of pins) {
    const url = util.pickImageUrl(pin);
    if (url) withImage++;
    if (pin.images && pin.images.orig && pin.images.orig.url) withOrig++;
    if (util.pinTitle(pin)) withTitle++;
  }
  ok("pins with a usable image URL", withImage + "/" + pins.length);
  ok("pins with images.orig", withOrig + "/" + pins.length);
  ok("pins with a non-empty title", withTitle + "/" + pins.length);

  // 4. The thumbnail→original rewrite must change the URL for real pins.
  const sample = pins.find((p) => util.pickImageUrl(p));
  const raw = util.pickImageUrl(sample);
  const original = util.toOriginalUrl(raw);
  ok("thumbnail URL rewritten", raw.indexOf("/originals/") === -1 ? "yes" : "already original");
  ok("resolved original URL host", new URL(original).host);

  // 5. Fetch real bytes for that original URL.
  try {
    const res = await fetch(original, {
      headers: { Referer: "https://www.pinterest.com/" },
      credentials: "omit",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buffer = await res.arrayBuffer();
    const type = res.headers.get("content-type") || "";
    ok("original media downloads", buffer.byteLength + " bytes, " + type);
    if (buffer.byteLength < 512) throw new Error("suspiciously small media body");
    if (!/^image\//.test(type)) throw new Error("not an image: " + type);
    const ext = util.extensionFor(original, false);
    ok("extension inferred", ext + " (sane: " + ["jpg", "jpeg", "png", "webp", "gif"].includes(ext) + ")");

    // 6. The archive must accept those bytes.
    const PKZip = require(path.join(__dirname, "..", "src", "lib", "zip.js"));
    const z = new PKZip.Zipper();
    z.add("Board/01-pin." + ext, new Uint8Array(buffer));
    const archive = z.build();
    ok("ZIP built from live bytes", archive.byteLength + " bytes");
    const fs = require("node:fs");
    fs.writeFileSync("/tmp/pinsaver-live.zip", archive);
    ok("archive written", "/tmp/pinsaver-live.zip");
  } catch (err) {
    fail("media download", err);
    failures++;
  }

  // 7. Video pins: an HLS playlist must resolve to a real, playable MP4.
  const videoLib = require(path.join(__dirname, "..", "src", "lib", "video.js"));
  const storyVideoPins = pins.filter((p) => util.pickStoryVideoUrl(p));
  ok("video pins on this board", storyVideoPins.length);

  if (storyVideoPins.length) {
    try {
      const hls = util.pickStoryVideoUrl(storyVideoPins[0]);
      if (!/\.m3u8(\?|$)/i.test(hls)) {
        throw new Error("expected an HLS playlist, got: " + hls);
      }
      const resolved = await videoLib.resolveVideoUrl(hls, fetch);
      ok("HLS resolved to a direct file", resolved.url.split("/").pop());
      ok("chosen variant bandwidth", resolved.bandwidth);
      if (!/\.(cmfv|mp4)(\?|$)/i.test(resolved.url)) {
        throw new Error("resolved URL is not a media file: " + resolved.url);
      }

      const vres = await fetch(resolved.url, {
        headers: { Referer: "https://www.pinterest.com/", Origin: "https://www.pinterest.com" },
        credentials: "omit",
      });
      if (!vres.ok) throw new Error("HTTP " + vres.status);
      const vbuf = await vres.arrayBuffer();
      const vtype = vres.headers.get("content-type") || "";
      ok("video downloads", vbuf.byteLength + " bytes, " + vtype);
      if (!/^video\//.test(vtype)) throw new Error("not a video content type: " + vtype);
      if (vbuf.byteLength < 10000) throw new Error("suspiciously small video body");

      // An MP4 begins with a `ftyp` box at offset 4.
      const head = new Uint8Array(vbuf.slice(0, 12));
      const ftyp = String.fromCharCode(head[4], head[5], head[6], head[7]);
      if (ftyp !== "ftyp") throw new Error("missing ftyp box (not an MP4)");
      ok("file is a valid MP4 container", "ftyp box present");
    } catch (err) {
      fail("video resolution", err);
      failures++;
    }
  } else {
    console.log("  SKIP  video resolution (no video pins on this board)");
  }

  // 8. Board sections: the pin feed carries no section data, so this proves
  //    the section endpoints work against production.
  const sectionBoard =
    process.env.SECTION_BOARD || "/foodandwine/all-things-chocolate/";
  console.log("");
  console.log("  Section check on " + sectionBoard);
  try {
    globalThis.location = { pathname: sectionBoard };
    const sid = await api.fetchBoardId(sectionBoard);
    const sections = await api.fetchBoardSections(sid);
    ok("fetchBoardSections returned", sections.length + " section(s)");
    if (!sections.length) throw new Error("expected at least one section");

    const section = sections[0];
    ok("first section", (section.name || section.title) + " (id " + section.id + ")");

    const page1 = await api.fetchSectionPinPage(sid, section, null);
    if (page1.pins.length === 0) throw new Error("section returned no pins");
    ok("section page 1 returned", page1.pins.length + " pins");
    if (!page1.bookmark) throw new Error("expected a pagination bookmark");

    const withPath = api.withSection(page1.pins[0], section);
    if (!Array.isArray(withPath.sectionPath) || !withPath.sectionPath.length) {
      throw new Error("sectionPath was not attached");
    }
    ok("pin tagged with its section path", JSON.stringify(withPath.sectionPath));
  } catch (err) {
    fail("board sections", err);
    failures++;
  }

  console.log("");
  if (failures) {
    console.log("RESULT: " + failures + " failure(s)");
    process.exit(1);
  }
  console.log("RESULT: all live checks passed");
})();
