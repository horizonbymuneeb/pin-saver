/**
 * Unit tests for the parts of Pin Saver that can be verified without a browser.
 *
 * Every assertion here encodes a behavior observed in the reference extension
 * during analysis, so a regression in the "why it works" details fails loudly.
 *
 * Run: node --test test/
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const util = require(path.join(__dirname, "..", "src", "lib", "util.js"));
const { Zipper, crc32 } = require(path.join(__dirname, "..", "src", "lib", "zip.js"));

// ---------------------------------------------------------------------------
// URL handling — the single most important detail for full-quality downloads
// ---------------------------------------------------------------------------

test("toOriginalUrl swaps the 564x width bucket for originals", () => {
  const input = "https://i.pinimg.com/564x/ab/cd/ef/abcdef123456.jpg";
  const expected = "https://i.pinimg.com/originals/ab/cd/ef/abcdef123456.jpg";
  assert.equal(util.toOriginalUrl(input), expected);
});

test("toOriginalUrl swaps every width bucket form", () => {
  for (const bucket of ["236x", "474x", "736x", "1200x", "564x", "75x75"]) {
    const input = `https://i.pinimg.com/${bucket}/aa/bb/cc/pin.jpg`;
    assert.match(
      util.toOriginalUrl(input),
      /^https:\/\/i\.pinimg\.com\/originals\/aa\/bb\/cc\/pin\.jpg$/,
      `bucket ${bucket} should map to originals`,
    );
  }
});

test("toOriginalUrl leaves hex directory segments untouched", () => {
  // The three path segments after the bucket are hex, not widths.
  const input = "https://i.pinimg.com/236x/12ab/cd34/ef56/pin.jpg";
  assert.equal(
    util.toOriginalUrl(input),
    "https://i.pinimg.com/originals/12ab/cd34/ef56/pin.jpg",
  );
});

test("toOriginalUrl is idempotent for an already-original URL", () => {
  const url = "https://i.pinimg.com/originals/aa/bb/cc/pin.jpg";
  assert.equal(util.toOriginalUrl(url), url);
});

test("toOriginalUrl survives empty and non-string input", () => {
  assert.equal(util.toOriginalUrl(""), "");
  assert.equal(util.toOriginalUrl(null), null);
  assert.equal(util.toOriginalUrl(undefined), undefined);
});

// ---------------------------------------------------------------------------
// Video detection
// ---------------------------------------------------------------------------

test("isVideoUrl detects mp4/webm/m3u8 and the /videos/ path", () => {
  const positives = [
    "https://v1.pinimg.com/videos/iht/expMp4/ab/cd/pin.mp4",
    "https://i.pinimg.com/abcd/pin.webm",
    "https://v1.pinimg.com/videos/mc/hls/1.m3u8",
    "https://i.pinimg.com/ab/pin.cmfv",
    "https://v1.pinimg.com/video_p5p/pin",
    "https://v1.pinimg.com/v_HLS/pin",
  ];
  for (const url of positives) {
    assert.equal(util.isVideoUrl(url), true, `expected video: ${url}`);
  }
});

test("isVideoUrl rejects ordinary image URLs", () => {
  const negatives = [
    "https://i.pinimg.com/originals/aa/bb/pin.jpg",
    "https://i.pinimg.com/736x/aa/bb/pin.png",
    "https://i.pinimg.com/736x/aa/bb/pin.webp",
  ];
  for (const url of negatives) {
    assert.equal(util.isVideoUrl(url), false, `expected image: ${url}`);
  }
});

// ---------------------------------------------------------------------------
// HEIF fallback preference
// ---------------------------------------------------------------------------

test("preferFallback swaps a heic URL for the supplied JPEG fallback", () => {
  const heic = "https://i.pinimg.com/736x/aa/pin.heic";
  const jpg = "https://i.pinimg.com/736x/aa/pin.jpg";
  assert.equal(util.preferFallback(heic, jpg), jpg);
});

test("preferFallback keeps a normal URL even when a fallback exists", () => {
  const jpg = "https://i.pinimg.com/736x/aa/pin.jpg";
  const other = "https://i.pinimg.com/736x/aa/pin2.jpg";
  assert.equal(util.preferFallback(jpg, other), jpg);
});

// ---------------------------------------------------------------------------
// File naming
// ---------------------------------------------------------------------------

test("extensionFor maps jpeg to jpg and defaults to jpg", () => {
  assert.equal(util.extensionFor("https://x/y/pin.jpeg", false), "jpg");
  assert.equal(util.extensionFor("https://x/y/pin.PNG", false), "png");
  assert.equal(util.extensionFor("https://x/y/pin", false), "jpg");
  assert.equal(util.extensionFor("https://x/y/pin.jpg", true), "mp4");
});

test("sanitizeName strips reserved characters and collapses spaces", () => {
  assert.equal(util.sanitizeName('a<b>c:d"e/f\\g|h?i*j'), "abcdefghij");
  assert.equal(util.sanitizeName("  two   words  "), "_two_words_");
});

test("sanitizeName enforces the length cap", () => {
  const long = "x".repeat(200);
  assert.equal(util.sanitizeName(long, 50).length, 50);
});

test("sanitizeName removes control characters", () => {
  assert.equal(util.sanitizeName("a\u0000b\u001fc"), "abc");
});

test("pad left-pads with zeros", () => {
  assert.equal(util.pad(7, 3), "007");
  assert.equal(util.pad(42, 3), "042");
  assert.equal(util.pad(1234, 3), "1234");
});

// ---------------------------------------------------------------------------
// Pin shape parsing
// ---------------------------------------------------------------------------

test("pickImageUrl prefers orig, then 736x, then 564x", () => {
  assert.equal(
    util.pickImageUrl({ images: { orig: { url: "o" }, "736x": { url: "m" } } }),
    "o",
  );
  assert.equal(util.pickImageUrl({ images: { "736x": { url: "m" } } }), "m");
  assert.equal(util.pickImageUrl({ images: { "564x": { url: "s" } } }), "s");
  assert.equal(util.pickImageUrl({ image_large_url: "L" }), "L");
  assert.equal(util.pickImageUrl({}), null);
});

test("pinTitle falls through title, grid_title, story metadata, description", () => {
  assert.equal(util.pinTitle({ title: "T" }), "T");
  assert.equal(util.pinTitle({ grid_title: "G" }), "G");
  assert.equal(
    util.pinTitle({ story_pin_data: { metadata: { title: "S" } } }),
    "S",
  );
  assert.equal(util.pinTitle({ description: "D" }), "D");
  assert.equal(util.pinTitle({}), "");
});

// ---------------------------------------------------------------------------
// Binary transport across chrome.runtime.sendMessage
//
// Regression guard: Chrome JSON-serialises message payloads, so a Uint8Array
// becomes {"0":137,"1":80,...}. The end-to-end browser test caught a ZIP build
// failing on exactly this, so binary must always cross as base64 text.
// ---------------------------------------------------------------------------

test("bytesToBase64 / base64ToBytes round-trip arbitrary bytes", () => {
  const bytes = new Uint8Array(1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 256;
  const encoded = util.bytesToBase64(bytes);
  assert.equal(typeof encoded, "string", "must be a string for JSON transport");
  const decoded = util.base64ToBytes(encoded);
  assert.deepEqual(Array.from(decoded), Array.from(bytes));
});

test("base64 transport survives bytes that JSON would corrupt", () => {
  // Simulate what JSON.stringify does to a Uint8Array.
  const original = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const jsonCorrupted = JSON.parse(JSON.stringify(original));
  assert.equal(jsonCorrupted instanceof Uint8Array, false, "JSON loses the type");

  const encoded = util.bytesToBase64(original);
  const decoded = util.base64ToBytes(encoded);
  assert.equal(decoded instanceof Uint8Array, true);
  assert.deepEqual(Array.from(decoded), Array.from(original));
});

test("base64 transport handles a large payload across chunk boundaries", () => {
  const size = 200000;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  const decoded = util.base64ToBytes(util.bytesToBase64(bytes));
  assert.equal(decoded.length, size);
  assert.deepEqual(Array.from(decoded.slice(32760, 32780)), Array.from(bytes.slice(32760, 32780)));
});

test("base64 round-trip preserves JPEG magic bytes", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const back = util.base64ToBytes(util.bytesToBase64(jpeg));
  assert.equal(back[0], 0xff);
  assert.equal(back[1], 0xd8);
});

// ---------------------------------------------------------------------------
// ZIP writer
// ---------------------------------------------------------------------------

test("crc32 matches the known check value for '123456789'", () => {
  const bytes = new TextEncoder().encode("123456789");
  assert.equal(crc32(bytes), 0xcbf43926);
});

test("Zipper emits a structurally valid archive", () => {
  const z = new Zipper(new Date(2024, 0, 1, 12, 0, 0));
  z.add("board/one.txt", new TextEncoder().encode("hello"));
  z.add("board/two.txt", new TextEncoder().encode("world"));
  const out = z.build();

  // Local file header signature at offset 0.
  assert.deepEqual(Array.from(out.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  // End-of-central-directory signature in the last 22 bytes.
  const tail = out.slice(out.length - 22);
  assert.deepEqual(Array.from(tail.slice(0, 4)), [0x50, 0x4b, 0x05, 0x06]);

  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  assert.equal(dv.getUint16(8, true), 2, "entry count on this disk");
  assert.equal(dv.getUint16(10, true), 2, "total entry count");
});

test("Zipper stores UTF-8 names and content faithfully", () => {
  const z = new Zipper(new Date(2024, 0, 1));
  const body = new TextEncoder().encode("pins");
  z.add("بورڈ/ایک.txt", body);
  const out = z.build();
  const nameLen = new DataView(out.buffer).getUint16(26, true);
  const name = new TextDecoder().decode(out.slice(30, 30 + nameLen));
  assert.equal(name, "بورڈ/ایک.txt");
  // Content must land immediately after the name and be byte-identical.
  const payload = out.slice(30 + nameLen, 30 + nameLen + body.length);
  assert.deepEqual(Array.from(payload), Array.from(body));
});

test("Zipper.addText with bom prefixes the UTF-8 byte order mark", () => {
  const z = new Zipper(new Date(2024, 0, 1));
  z.addText("m.csv", "a,b", true);
  const out = z.build();
  // Name length sits at offset 26 of the local header; payload follows it.
  const nameLen = new DataView(out.buffer).getUint16(26, true);
  const payload = out.slice(30 + nameLen, 30 + nameLen + 3);
  assert.deepEqual(Array.from(payload), [0xef, 0xbb, 0xbf]);
});

test("Zipper rejects non-byte payloads", () => {
  const z = new Zipper();
  assert.throws(() => z.add("x", "a string"), TypeError);
});

// ---------------------------------------------------------------------------
// API request shape
// ---------------------------------------------------------------------------

test("parseBoardPath splits username and slug and decodes unicode slugs", () => {
  const p = api_module().parseBoardPath("/alice/my-board/");
  assert.equal(p.username, "alice");
  assert.equal(p.slug, "my-board");
  const u = api_module().parseBoardPath("/bob/%D8%A8%D9%88%D8%B1%DA%88/");
  assert.equal(u.decodedSlug, "بورڈ");
});

test("parseBoardPath returns null for a single-segment path", () => {
  assert.equal(api_module().parseBoardPath("/alice/"), null);
});

test("resourceUrl encodes options into the data parameter", () => {
  const url = api_module().resourceUrl(
    "https://www.pinterest.com",
    "BoardFeedResource",
    "/alice/board/",
    { board_id: "123" },
  );
  assert.match(url, /^https:\/\/www\.pinterest\.com\/resource\/BoardFeedResource\/get\//);
  assert.match(url, /source_url=%2Falice%2Fboard%2F/);
  assert.match(url, /&_=\d+$/, "cache buster must be present");

  const dataParam = new URL(url).searchParams.get("data");
  const parsed = JSON.parse(dataParam);
  assert.equal(parsed.options.board_id, "123");
  assert.deepEqual(parsed.context, {});
});

test("buildHeaders includes every header Pinterest validates", () => {
  const h = api_module().buildHeaders("/alice/board/", null);
  for (const key of [
    "x-app-version",
    "x-pinterest-appstate",
    "x-pinterest-source-url",
    "x-requested-with",
    "x-b3-traceid",
    "x-b3-spanid",
    "accept",
  ]) {
    assert.ok(h[key], `missing required header ${key}`);
  }
  assert.equal(h["x-pinterest-appstate"], "active");
  assert.equal(h["x-requested-with"], "XMLHttpRequest");
  assert.match(h["x-b3-traceid"], /^[0-9a-f]{16}$/);
  assert.equal(h["x-pinterest-source-url"], "/alice/board/");
});

test("normalizeFeed accepts an array, a keyed object and a nested data envelope", () => {
  const pin = { id: "1", images: { orig: { url: "u" } } };
  assert.equal(api_module().normalizeFeed([pin]).length, 1);
  assert.equal(api_module().normalizeFeed({ a: pin }).length, 1);
  assert.equal(api_module().normalizeFeed({ data: [pin] }).length, 1);
  assert.equal(api_module().normalizeFeed(null).length, 0);
});

test("isPinLike rejects objects without an id or media", () => {
  const api = api_module();
  assert.equal(api.isPinLike({ id: "1", images: {} }), true);
  assert.equal(api.isPinLike({ images: {} }), false);
  assert.equal(api.isPinLike({ id: "1" }), false);
  assert.equal(api.isPinLike(null), false);
});

// ---------------------------------------------------------------------------
// Helper: api.js uses `document` at call time only, so a stub is enough.
// ---------------------------------------------------------------------------
function api_module() {
  if (globalThis.document) return require(path.join(__dirname, "..", "src", "lib", "api.js"));
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
  globalThis.location = { pathname: "/alice/board/" };
  return require(path.join(__dirname, "..", "src", "lib", "api.js"));
}

// ---------------------------------------------------------------------------
// Archive folder naming
// ---------------------------------------------------------------------------

test("sectionFolderPath builds a folder from the section path", () => {
  assert.equal(util.sectionFolderPath({ sectionPath: ["Ideas"] }), "Ideas");
});

test("sectionFolderPath sanitises each path segment", () => {
  assert.equal(
    util.sectionFolderPath({ sectionPath: ["Best Recipes", "Quick & Easy"] }),
    "Best_Recipes/Quick_&_Easy",
  );
});

test("sectionFolderPath falls back when a pin has no section", () => {
  assert.equal(util.sectionFolderPath({ id: "1" }, ""), "");
  assert.equal(util.sectionFolderPath({ id: "1" }, "Root"), "Root");
  assert.equal(util.sectionFolderPath(null, "Root"), "Root");
});

test("sectionFolderPath ignores an empty section array", () => {
  assert.equal(util.sectionFolderPath({ sectionPath: [] }, ""), "");
});

test("sectionFolderPath never yields an empty segment", () => {
  // A section name made only of reserved characters sanitises to "".
  assert.equal(util.sectionFolderPath({ sectionPath: ['///'] }), "section");
});

test("sectionFolderPath caps a long section name", () => {
  const folder = util.sectionFolderPath({ sectionPath: ["x".repeat(200)] });
  assert.equal(folder.length, 50);
});

// ---------------------------------------------------------------------------
// UTF-8 filename flag
//
// Names with non-ASCII characters must set the UTF-8 flag (0x0800) in both the
// local header and the central directory, otherwise extraction tools guess an
// encoding and mangle titles like "Crème" or "—".
// ---------------------------------------------------------------------------

test("non-ASCII names set the UTF-8 flag in local and central headers", () => {
  const z = new Zipper(new Date(2024, 0, 1));
  z.add("Crème/—.txt", new Uint8Array([1, 2, 3]));
  const out = z.build();
  const dv = new DataView(out.buffer);

  // Local file header: general purpose flags at offset 6.
  assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800, "local header UTF-8 flag");

  // Central directory entry starts right after the single payload.
  const nameLen = dv.getUint16(26, true);
  const centralStart = 30 + nameLen + 3;
  assert.equal(
    dv.getUint32(centralStart, true),
    0x02014b50,
    "central directory signature",
  );
  assert.equal(
    dv.getUint16(centralStart + 8, true) & 0x0800,
    0x0800,
    "central directory UTF-8 flag",
  );
});

// ---------------------------------------------------------------------------
// Selection keys
//
// Regression guard: selection used to store a Date.now() timestamp while the
// export filter compared Pinterest pin ids, so they could never match and
// "ZIP selected" always produced an empty archive.
// ---------------------------------------------------------------------------

test("pinIdKey is stable and string-based", () => {
  assert.equal(util.pinIdKey("9001"), "id:9001");
  assert.equal(util.pinIdKey(9001), "id:9001", "numbers and strings agree");
  assert.equal(util.pinIdKey(null), null);
});

test("mediaKey canonicalises the thumbnail bucket", () => {
  const thumb = "https://i.pinimg.com/236x/aa/bb/cc/pin1.jpg";
  const orig = "https://i.pinimg.com/originals/aa/bb/cc/pin1.jpg";
  assert.equal(util.mediaKey(thumb), util.mediaKey(orig));
});

test("pinSelectionKeys exposes both id and media keys", () => {
  const pin = {
    id: "9001",
    images: { orig: { url: "https://i.pinimg.com/originals/aa/bb/cc/pin1.jpg" } },
  };
  const keys = util.pinSelectionKeys(pin);
  assert.ok(keys.indexOf("id:9001") !== -1);
  assert.ok(keys.some((k) => k.startsWith("url:")));
});

test("isPinSelected matches on the pin id", () => {
  const selected = new Set(["id:9001"]);
  assert.equal(util.isPinSelected({ id: "9001", images: { orig: { url: "u" } } }, selected), true);
  assert.equal(util.isPinSelected({ id: "9002", images: { orig: { url: "u" } } }, selected), false);
});

test("isPinSelected matches on the canonical media URL alone", () => {
  const selected = new Set([util.mediaKey("https://i.pinimg.com/236x/aa/pin1.jpg")]);
  const pin = { id: "123", images: { orig: { url: "https://i.pinimg.com/originals/aa/pin1.jpg" } } };
  assert.equal(util.isPinSelected(pin, selected), true);
});

test("isPinSelected is false for a timestamp-style key", () => {
  // The old bug: timestamps never matched anything.
  const selected = new Set(["1761001234567"]);
  assert.equal(util.isPinSelected({ id: "9001" }, selected), false);
});

test("isPinSelected handles a missing selection set", () => {
  assert.equal(util.isPinSelected({ id: "1" }, null), false);
});

// ---------------------------------------------------------------------------
// Metadata sidecar (CSV)
//
// Pin titles come from other users, so the writer treats them as untrusted:
// spreadsheet formula injection must be neutralised and quoting must be exact.
// ---------------------------------------------------------------------------

test("csvCell leaves a plain value untouched", () => {
  assert.equal(util.csvCell("hello"), "hello");
  assert.equal(util.csvCell(42), "42");
  assert.equal(util.csvCell(null), "");
});

test("csvCell quotes embedded commas, quotes and newlines", () => {
  assert.equal(util.csvCell("a,b"), '"a,b"');
  assert.equal(util.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(util.csvCell("line1\nline2"), '"line1\nline2"');
});

test("csvCell neutralises spreadsheet formula injection", () => {
  // A title beginning with these characters is executed as a formula by
  // Excel/LibreOffice unless prefixed.
  for (const payload of ['=1+1', '+1', '-1', '@SUM(A1)', "=HYPERLINK(\"http://x\",\"c\")"]) {
    const cell = util.csvCell(payload);
    assert.ok(
      cell.indexOf("'") === 0 || cell.indexOf("\"'") === 0,
      "must neutralise: " + payload + " → " + cell,
    );
  }
});

test("csvCell neutralises a formula that also contains a comma", () => {
  const cell = util.csvCell('=HYPERLINK("http://x","c")');
  assert.ok(cell.indexOf("'=") === 1, "apostrophe inside the quotes");
  assert.ok(cell[0] === '"' && cell[cell.length - 1] === '"');
});

test("buildMetadata emits a header plus one row per pin", () => {
  const pins = [
    { id: "1", title: "One", images: { orig: { url: "u" } } },
    { id: "2", title: "Two", images: { orig: { url: "u" } } },
  ];
  const meta = util.buildMetadata(pins, ["", "Ideas"]);
  const lines = meta.csv.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "n,id,title,description,link,section,type,url");
  assert.ok(lines[1].indexOf("1,1,One") === 0);
  assert.ok(lines[2].indexOf("2,2,Two") === 0);
  assert.ok(lines[2].indexOf("Ideas") !== -1, "section folder recorded");
});

test("buildMetadata JSON mirrors the CSV rows", () => {
  const meta = util.buildMetadata([{ id: "7", title: "X" }], [""]);
  const rows = JSON.parse(meta.json);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "7");
  assert.equal(rows[0].title, "X");
  assert.equal(rows[0].url, "https://www.pinterest.com/pin/7/");
});

test("buildMetadata handles an empty pin list", () => {
  const meta = util.buildMetadata([], []);
  assert.equal(meta.csv, "n,id,title,description,link,section,type,url\r\n");
  assert.deepEqual(JSON.parse(meta.json), []);
});

test("buildMetadata survives a pin title with a comma and a quote", () => {
  const meta = util.buildMetadata([{ id: "1", title: 'a, "b"' }], [""]);
  const row = meta.csv.split("\r\n")[1];
  assert.ok(row.indexOf('"a, ""b"""') !== -1, "quoted correctly: " + row);
});

test("buildMetadata marks idea pins distinctly", () => {
  const meta = util.buildMetadata([{ id: "1", story_pin_data: { pages: [] } }], [""]);
  assert.ok(meta.csv.indexOf("idea") !== -1);
});

// ---------------------------------------------------------------------------
// Board-route classification
//
// The popup and the content script must agree on what a board is; they used to
// carry two slightly different copies of this rule.
// ---------------------------------------------------------------------------

test("isBoardPath accepts real board shapes", () => {
  for (const p of [
    "/pinterest/girls-night-in/",
    "/alice/my-board/",
    "/alice/my-board", // no trailing slash
    "/alice/board/section-slug/", // a section page is still inside a board
  ]) {
    assert.equal(util.isBoardPath(p), true, "expected board: " + p);
  }
});

test("isBoardPath rejects every app route", () => {
  for (const p of [
    "/pin/123456/",
    "/pin/123456/sent/",
    "/search/pins/",
    "/ideas/",
    "/ideas/123/",
    "/settings/",
    "/notifications/",
    "/messages/",
    "/explore/",
    "/today/",
    "/home/",
    "/business/",
  ]) {
    assert.equal(util.isBoardPath(p), false, "expected non-board: " + p);
  }
});

test("isBoardPath rejects a profile with a single segment", () => {
  assert.equal(util.isBoardPath("/alice/"), false);
  assert.equal(util.isBoardPath("/"), false);
  assert.equal(util.isBoardPath(""), false);
});

test("isBoardPath ignores a query string", () => {
  assert.equal(util.isBoardPath("/alice/my-board/?invite=1"), true);
  assert.equal(util.isBoardPath("/search/pins/?q=cats"), false);
});

test("isBoardPath is case-insensitive on the route", () => {
  assert.equal(util.isBoardPath("/Search/pins/"), false);
});

test("isBoardUrl parses a full URL", () => {
  assert.equal(util.isBoardUrl("https://www.pinterest.com/alice/my-board/"), true);
  assert.equal(util.isBoardUrl("https://www.pinterest.com/pin/123/"), false);
  assert.equal(util.isBoardUrl("not a url"), false);
  assert.equal(util.isBoardUrl(""), false);
});
