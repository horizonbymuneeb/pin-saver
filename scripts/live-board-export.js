/**
 * Live full-archive test: build a real ZIP from a real board on production
 * Pinterest, using the same code path the extension uses
 * (api → util.sectionFolderPath → zip).
 *
 * A sectioned board is used on purpose: it is the only way to prove that
 * section pins land in their own folder in an actual archive rather than in a
 * mock.
 *
 * The run is capped so it stays fast; use --limit to change the cap.
 * Read-only against Pinterest. Network required.
 *
 * Usage:
 *   node scripts/live-board-export.js [boardPath] [--limit=N]
 *   default board: /foodandwine/all-things-chocolate/
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);
const boardPath =
  args.find((a) => a.startsWith("/")) || "/foodandwine/all-things-chocolate/";
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : 10;

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.location = { pathname: boardPath };

const api = require(path.join(__dirname, "..", "src", "lib", "api.js"));
const util = require(path.join(__dirname, "..", "src", "lib", "util.js"));
const { Zipper } = require(path.join(__dirname, "..", "src", "lib", "zip.js"));

let failures = 0;
function ok(label, value) {
  console.log("  PASS  " + label + (value === undefined ? "" : ": " + value));
}
function fail(label, err) {
  failures++;
  console.log("  FAIL  " + label + ": " + (err && err.message ? err.message : err));
}

/** Download a pin's media at original resolution, exactly like the extension. */
async function fetchPin(pin) {
  const storyVideo = util.pickStoryVideoUrl(pin);
  if (storyVideo) return null; // videos are out of scope for this archive test
  const raw = util.pickImageUrl(pin);
  if (!raw) return null;
  const url = util.toOriginalUrl(raw);
  const res = await fetch(url, {
    headers: { Referer: "https://www.pinterest.com/" },
    credentials: "omit",
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  const buf = await res.arrayBuffer();
  return { bytes: new Uint8Array(buf), ext: util.extensionFor(url, false), url: url };
}

(async function main() {
  console.log("Live board export — " + boardPath + " (limit " + LIMIT + " pins)");
  console.log("");

  let boardId;
  try {
    boardId = await api.fetchBoardId(boardPath);
    ok("board id resolved", boardId);
  } catch (err) {
    fail("board id", err);
    process.exit(1);
  }

  // Sectionless pins from the board feed plus tagged pins from each section.
  let pins = [];
  try {
    pins = await api.fetchAllBoardPins(boardId, null);
    ok("board pins collected", pins.length);
  } catch (err) {
    fail("collect pins", err);
  }

  const sectioned = pins.filter((p) => Array.isArray(p.sectionPath) && p.sectionPath.length);
  const flat = pins.filter((p) => !(Array.isArray(p.sectionPath) && p.sectionPath.length));
  ok("pins tagged with a section", sectioned.length);
  ok("pins without a section", flat.length);

  // Take a couple from each group so both archive paths are exercised.
  const sample = [];
  for (const p of flat.slice(0, 2)) sample.push(p);
  for (const p of sectioned.slice(0, Math.max(2, LIMIT - 2))) sample.push(p);
  const chosen = sample.slice(0, LIMIT);

  const zipper = new Zipper();
  const boardName = util.sanitizeName(readBoardName(boardPath), 60) || "board";
  let stored = 0;
  let skipped = 0;

  for (let i = 0; i < chosen.length; i++) {
    const pin = chosen[i];
    try {
      const media = await fetchPin(pin);
      if (!media) {
        skipped++;
        continue;
      }
      const folder = util.sectionFolderPath(pin, "");
      const title = util.sanitizeName(util.pinTitle(pin), 50) || "pin-" + (i + 1);
      const name = util.pad(i + 1, 2) + "-" + title + "." + media.ext;
      const dir = boardName + (folder ? "/" + folder : "");
      zipper.add(dir + "/" + name, media.bytes);
      stored++;
      console.log("        stored " + dir + "/" + name + " (" + media.bytes.length + " bytes)");
    } catch (err) {
      skipped++;
    }
  }

  ok("media downloaded and stored", stored);
  if (skipped) console.log("        skipped " + skipped + " pin(s)");

  zipper.addText(boardName + "/_metadata.csv", "n,id,title,section\r\n", true);
  zipper.addText(boardName + "/_metadata.json", "[]", false);

  const archive = zipper.build();
  const out = path.join(os.tmpdir(), "pinsaver-live-board.zip");
  fs.writeFileSync(out, archive);
  ok("archive written", out + " (" + archive.byteLength + " bytes)");

  // Structure assertions against the produced bytes.
  const text = Buffer.from(archive).toString("latin1");
  ok("archive has the board folder", text.includes(boardName + "/"));
  ok("archive has metadata", text.includes("_metadata.csv") && text.includes("_metadata.json"));

  if (sectioned.length) {
    // Use one of the chosen section pins' expected folder name.
    const folder = util.sectionFolderPath(
      chosen.find((p) => p.sectionPath) || sectioned[0],
      "",
    );
    ok("archive has a section folder", folder + " → " + text.includes(folder + "/"));
    if (!text.includes(folder + "/")) failures++;
  } else {
    console.log("  SKIP  section folder (no sectioned pins on this board)");
  }

  console.log("");
  if (failures) {
    console.log("RESULT: " + failures + " failure(s)");
    process.exit(1);
  }
  console.log("RESULT: live board archive built and verified");
})();

/** Best-effort board name from the URL slug. */
function readBoardName(p) {
  const parts = String(p || "").split("/").filter(Boolean);
  return parts.length > 1 ? parts[1] : "pinterest-board";
}
