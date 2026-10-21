/**
 * Tests for the dependency-free PDF writer.
 *
 * The writer embeds JPEG bytes with /DCTDecode, so the two things that must be
 * provably correct are (a) reading real JPEG dimensions out of the SOF marker
 * and (b) producing a byte-exact xref table. Everything else is layout math.
 *
 * Run: node --test test/pdf.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");

const pdf = require(path.join(__dirname, "..", "src", "lib", "pdf.js"));

/** A valid 1x1 baseline JPEG, enough to exercise SOF parsing. */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

function latin1(bytes) {
  return Buffer.from(bytes).toString("latin1");
}

// ---------------------------------------------------------------------------
// JPEG dimension parsing
// ---------------------------------------------------------------------------

test("jpegSize reads dimensions from a real JPEG", () => {
  const size = pdf.jpegSize(new Uint8Array(TINY_JPEG));
  assert.deepEqual(size, { width: 1, height: 1 });
});

test("jpegSize rejects non-JPEG input", () => {
  assert.equal(pdf.jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), null);
  assert.equal(pdf.jpegSize(new Uint8Array([1, 2])), null);
  assert.equal(pdf.jpegSize(null), null);
});

// ---------------------------------------------------------------------------
// Layout math
// ---------------------------------------------------------------------------

test("fitBox preserves aspect ratio", () => {
  const box = pdf.fitBox(1206, 1608, 595.28, 841.89, 24);
  const originalRatio = 1206 / 1608;
  const boxRatio = box.width / box.height;
  assert.ok(Math.abs(originalRatio - boxRatio) < 0.001, "ratio must be preserved");
});

test("fitBox never overflows the printable area", () => {
  const box = pdf.fitBox(4000, 6000, 595.28, 841.89, 24);
  assert.ok(box.width <= 595.28 - 48 + 0.01);
  assert.ok(box.height <= 841.89 - 48 + 0.01);
});

test("fitBox centres the image on the page", () => {
  const page = { w: 595.28, h: 841.89 };
  const box = pdf.fitBox(1000, 1000, page.w, page.h, 24);
  const leftGap = box.x;
  const rightGap = page.w - (box.x + box.width);
  assert.ok(Math.abs(leftGap - rightGap) < 0.02, "horizontally centred");
});

// ---------------------------------------------------------------------------
// Document structure
// ---------------------------------------------------------------------------

test("buildPdf emits a valid PDF header and EOF", () => {
  const doc = pdf.buildPdf([
    { jpeg: new Uint8Array(TINY_JPEG), width: 1, height: 1 },
  ]);
  const text = latin1(doc);
  assert.ok(text.startsWith("%PDF-1.4"), "must start with the version header");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "must end with %%EOF");
});

test("buildPdf includes catalog, page tree and trailer", () => {
  const doc = latin1(
    pdf.buildPdf([{ jpeg: new Uint8Array(TINY_JPEG), width: 1, height: 1 }]),
  );
  assert.match(doc, /\/Type\s*\/Catalog/);
  assert.match(doc, /\/Type\s*\/Pages/);
  assert.match(doc, /\/Type\s*\/Page[^s]/);
  assert.match(doc, /trailer/);
  assert.match(doc, /\/Root\s+1\s+0\s+R/);
});

test("buildPdf embeds the JPEG untouched with DCTDecode", () => {
  const jpeg = new Uint8Array(TINY_JPEG);
  const doc = pdf.buildPdf([{ jpeg, width: 1, height: 1 }]);
  const text = latin1(doc);
  assert.match(text, /\/Filter\s*\/DCTDecode/);
  assert.match(text, /\/ColorSpace\s*\/DeviceRGB/);
  // The exact JPEG bytes must appear in the output.
  const haystack = latin1(doc);
  const needle = latin1(jpeg);
  assert.ok(haystack.includes(needle), "JPEG payload must be present verbatim");
});

test("buildPdf writes one page per image", () => {
  const images = [
    { jpeg: new Uint8Array(TINY_JPEG), width: 1, height: 1 },
    { jpeg: new Uint8Array(TINY_JPEG), width: 1, height: 1 },
    { jpeg: new Uint8Array(TINY_JPEG), width: 1, height: 1 },
  ];
  const text = latin1(pdf.buildPdf(images));
  assert.match(text, /\/Count\s+3/);
});

test("buildPdf rejects an empty document", () => {
  assert.throws(() => pdf.buildPdf([]), /at least one image/);
});

test("buildPdf rejects an image without bytes", () => {
  assert.throws(() => pdf.buildPdf([{ width: 1, height: 1 }]), /no JPEG bytes/);
});

test("buildPdf rejects an image without dimensions", () => {
  assert.throws(
    () => pdf.buildPdf([{ jpeg: new Uint8Array(TINY_JPEG) }]),
    /needs width and height/,
  );
});

// ---------------------------------------------------------------------------
// xref correctness — the part parsers reject the file over
// ---------------------------------------------------------------------------

test("every xref offset points at its object header", () => {
  const doc = pdf.buildPdf([
    { jpeg: new Uint8Array(TINY_JPEG), width: 1, height: 1 },
    { jpeg: new Uint8Array(TINY_JPEG), width: 1, height: 1 },
  ]);
  const text = latin1(doc);

  const startxrefMatch = text.match(/startxref\s+(\d+)/);
  assert.ok(startxrefMatch, "startxref offset present");
  const xrefStart = Number(startxrefMatch[1]);
  assert.ok(text.slice(xrefStart, xrefStart + 4) === "xref", "startxref points at xref");

  const xrefBody = text.slice(xrefStart);
  const headerMatch = xrefBody.match(/xref\s+0\s+(\d+)\s/);
  assert.ok(headerMatch, "xref header present");
  const count = Number(headerMatch[1]);

  // Entry 0 is the free entry; entries 1..count-1 must point at "<n> 0 obj".
  // Layout is: line 0 = "xref", line 1 = "0 <count>", line 2 = free entry,
  // so object n lives at index n + 2.
  const lines = xrefBody.split("\n");
  let checked = 0;
  for (let n = 1; n < count; n++) {
    const line = lines[n + 2];
    const m = line && line.match(/^(\d{10}) \d{5} n/);
    assert.ok(m, "xref entry " + n + " is well formed: " + line);
    const off = Number(m[1]);
    const at = text.slice(off, off + 20);
    assert.match(at, new RegExp("^" + n + " 0 obj"), "offset for object " + n);
    checked++;
  }
  assert.ok(checked >= 3, "checked a meaningful number of objects");
});

test("trailer Size matches the number of objects written", () => {
  const text = latin1(
    pdf.buildPdf([
      { jpeg: new Uint8Array(TINY_JPEG), width: 1, height: 1 },
      { jpeg: new Uint8Array(TINY_JPEG), width: 1, height: 1 },
    ]),
  );
  const sizeMatch = text.match(/\/Size\s+(\d+)/);
  const xrefCountMatch = text.match(/xref\s+0\s+(\d+)\s/);
  assert.ok(sizeMatch, "trailer has a /Size");
  assert.ok(xrefCountMatch, "xref has a subsection count");
  assert.equal(Number(sizeMatch[1]), Number(xrefCountMatch[1]));

  // 1 catalog + 1 pages tree + 3 objects per image (page, content, image).
  // /Size is one greater than the highest object number.
  assert.equal(Number(sizeMatch[1]), 1 + (2 + 3 * 2));
});

// ---------------------------------------------------------------------------
// External validation (skipped when no PDF tool is installed)
// ---------------------------------------------------------------------------

test("Ghostscript parses the generated PDF without errors", (t) => {
  let gs;
  try {
    gs = execFileSync("sh", ["-c", "command -v gs"], { encoding: "utf8" }).trim();
  } catch (_) {
    t.skip("ghostscript not installed");
    return;
  }
  const out = path.join(os.tmpdir(), "pinsaver-test-" + process.pid + ".pdf");
  const big = new Uint8Array(TINY_JPEG);
  fs.writeFileSync(
    out,
    pdf.buildPdf([
      { jpeg: big, width: 1, height: 1 },
      { jpeg: big, width: 1, height: 1 },
    ]),
  );
  try {
    const result = execFileSync(
      gs,
      ["-dNOPAUSE", "-dBATCH", "-dQUIET", "-sDEVICE=nullpage", out],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.trim(), "", "ghostscript should report nothing");
  } finally {
    fs.unlinkSync(out);
  }
});
