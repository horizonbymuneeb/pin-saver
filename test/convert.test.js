/**
 * Tests for the image format converter.
 *
 * The converter is the only place where the extension re-encodes pixels, so
 * the two properties that matter are pinned here: a JPEG is never re-encoded
 * for nothing, and every other conversion goes through the canvas with the
 * right MIME type and quality.
 *
 * Node has neither `createImageBitmap` nor `OffscreenCanvas`, so the browser
 * canvas stack is replaced by a recording stub that remembers every call.
 *
 * Run: node --test test/convert.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const convert = require(path.join(__dirname, "..", "src", "lib", "convert.js"));

/** Canned bytes the fake encoder answers with. */
const CONVERTED_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x01, 0x02]);
const CONVERTED_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Install a fake `createImageBitmap` / `OffscreenCanvas` pair.
 *
 * Every call is recorded so the tests can assert what the converter asked the
 * browser to do. `options.withoutBitmap` / `options.withoutCanvas` leave the
 * corresponding API absent, which is how the "not supported here" paths are
 * exercised. `options.decodeError` makes the fake decoder fail, which stands in
 * for bytes that are not a decodable image.
 */
function installCanvas(options) {
  const opts = options || {};
  const originalBitmap = globalThis.createImageBitmap;
  const originalCanvas = globalThis.OffscreenCanvas;
  const state = {
    bitmapCalls: [],
    canvasCalls: [],
    contextKinds: [],
    fills: [],
    draws: [],
    encodeCalls: [],
    closedBitmaps: 0,
  };

  if (!opts.withoutBitmap) {
    globalThis.createImageBitmap = async function (blob, bitmapOptions) {
      state.bitmapCalls.push({ blob: blob, options: bitmapOptions });
      if (opts.decodeError) throw opts.decodeError;
      return {
        width: opts.width || 4,
        height: opts.height || 3,
        close() {
          state.closedBitmaps += 1;
        },
      };
    };
  }

  if (!opts.withoutCanvas) {
    globalThis.OffscreenCanvas = class FakeCanvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        state.canvasCalls.push({ width: width, height: height });
      }
      getContext(kind) {
        state.contextKinds.push(kind);
        return {
          fillStyle: "",
          fillRect(x, y, w, h) {
            state.fills.push({ x: x, y: y, w: w, h: h, style: this.fillStyle });
          },
          drawImage(bitmap, dx, dy) {
            state.draws.push({ bitmap: bitmap, dx: dx, dy: dy });
          },
        };
      }
      async convertToBlob(encodeOptions) {
        state.encodeCalls.push(encodeOptions);
        const bytes =
          encodeOptions.type === "image/png" ? CONVERTED_PNG : CONVERTED_JPEG;
        return {
          type: encodeOptions.type,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }
    };
  }

  return {
    state: state,
    restore() {
      if (originalBitmap === undefined) delete globalThis.createImageBitmap;
      else globalThis.createImageBitmap = originalBitmap;
      if (originalCanvas === undefined) delete globalThis.OffscreenCanvas;
      else globalThis.OffscreenCanvas = originalCanvas;
    },
  };
}

/** Run a body with the fake canvas installed, then put the globals back. */
async function withCanvas(options, body) {
  const fake = installCanvas(options);
  try {
    return await body(fake.state);
  } finally {
    fake.restore();
  }
}

/** A JPEG with a valid SOI marker. */
function jpegBytes() {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
}

/** A PNG with a valid signature. */
function pngBytes() {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

// ---------------------------------------------------------------------------
// JPEG to JPEG — the pass-through that must never re-encode
// ---------------------------------------------------------------------------

test("convert returns the original bytes for a JPEG to JPEG request", async () => {
  const original = jpegBytes();
  await withCanvas({}, async (state) => {
    const result = await convert.convert(original, "jpg", "jpeg");
    assert.equal(result.bytes, original, "the very same bytes come back");
    assert.equal(result.ext, "jpeg");
    assert.equal(state.bitmapCalls.length, 0, "no decoding happened");
    assert.equal(state.canvasCalls.length, 0, "the canvas was never touched");
  });
});

test("convert treats jpeg and jpg as the same format", async () => {
  await withCanvas({}, async (state) => {
    const result = await convert.convert(jpegBytes(), "jpeg", "jpg");
    assert.equal(result.ext, "jpeg");
    assert.equal(state.canvasCalls.length, 0, "still a pass-through");
  });
});

test("convert rejects a JPEG to JPEG request whose bytes are not a JPEG", async () => {
  await withCanvas({}, async (state) => {
    await assert.rejects(
      () => convert.convert(new Uint8Array([1, 2, 3, 4]), "jpg", "jpeg"),
      /not a JPEG/,
    );
    assert.equal(state.canvasCalls.length, 0, "nothing was rasterised");
  });
});

// ---------------------------------------------------------------------------
// Canvas conversions
// ---------------------------------------------------------------------------

test("convert encodes a PNG source into JPEG through the canvas", async () => {
  await withCanvas({}, async (state) => {
    const result = await convert.convert(pngBytes(), "png", "jpeg");
    assert.equal(state.encodeCalls.length, 1);
    assert.equal(state.encodeCalls[0].type, "image/jpeg");
    assert.deepEqual(Array.from(result.bytes), Array.from(CONVERTED_JPEG));
    assert.equal(result.ext, "jpeg");
  });
});

test("convert sizes the canvas from the decoded image", async () => {
  await withCanvas({ width: 800, height: 600 }, async (state) => {
    await convert.convert(pngBytes(), "png", "jpeg");
    assert.equal(state.canvasCalls.length, 1);
    assert.equal(state.canvasCalls[0].width, 800);
    assert.equal(state.canvasCalls[0].height, 600);
    assert.equal(state.contextKinds[0], "2d");
  });
});

test("convert fills the canvas with white before drawing the image", async () => {
  await withCanvas({}, async (state) => {
    await convert.convert(pngBytes(), "png", "jpeg");
    assert.equal(state.fills.length, 1, "one background fill");
    assert.equal(state.fills[0].style, "#ffffff");
    assert.equal(state.fills[0].w, 4);
    assert.equal(state.fills[0].h, 3);
    assert.equal(state.draws.length, 1, "the image is drawn once");
    assert.equal(state.draws[0].dx, 0);
    assert.equal(state.draws[0].dy, 0);
  });
});

test("convert encodes to webp with the image/webp MIME type", async () => {
  await withCanvas({}, async (state) => {
    const result = await convert.convert(pngBytes(), "png", "webp");
    assert.equal(state.encodeCalls[0].type, "image/webp");
    assert.equal(result.ext, "webp");
  });
});

test("convert accepts jpg as an alias of the jpeg target", async () => {
  await withCanvas({}, async (state) => {
    const result = await convert.convert(pngBytes(), "png", "jpg");
    assert.equal(state.encodeCalls[0].type, "image/jpeg");
    assert.equal(result.ext, "jpeg");
  });
});

test("convert releases the decoded bitmap when it is done", async () => {
  await withCanvas({}, async (state) => {
    await convert.convert(pngBytes(), "png", "jpeg");
    assert.equal(state.closedBitmaps, 1);
  });
});

// ---------------------------------------------------------------------------
// Quality handling
// ---------------------------------------------------------------------------

test("convert passes quality through for lossy targets", async () => {
  await withCanvas({}, async (state) => {
    await convert.convert(pngBytes(), "png", "jpeg", 0.5);
    assert.equal(state.encodeCalls[0].quality, 0.5);
  });
});

test("convert uses the default quality when none is given", async () => {
  await withCanvas({}, async (state) => {
    await convert.convert(pngBytes(), "png", "jpeg");
    assert.equal(state.encodeCalls[0].quality, 0.92);
  });
});

test("convert clamps a quality outside the 0..1 range", async () => {
  await withCanvas({}, async (state) => {
    await convert.convert(pngBytes(), "png", "jpeg", 5);
    assert.equal(state.encodeCalls[0].quality, 1);
    await convert.convert(pngBytes(), "png", "jpeg", -1);
    assert.equal(state.encodeCalls[1].quality, 0);
  });
});

test("convert ignores quality for PNG targets", async () => {
  await withCanvas({}, async (state) => {
    await convert.convert(pngBytes(), "png", "png", 0.5);
    assert.equal(state.encodeCalls[0].type, "image/png");
    assert.equal(
      "quality" in state.encodeCalls[0],
      false,
      "PNG has no quality setting",
    );
  });
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

test("convert rejects an unknown source extension", async () => {
  await withCanvas({}, async (state) => {
    await assert.rejects(
      () => convert.convert(new Uint8Array([1, 2, 3]), "mp4", "png"),
      /unsupported source format/,
    );
    assert.equal(state.canvasCalls.length, 0, "nothing was rasterised");
  });
});

test("convert rejects a target that is neither jpeg, png nor webp", async () => {
  await withCanvas({}, async (state) => {
    await assert.rejects(
      () => convert.convert(new Uint8Array([1, 2, 3]), "png", "gif"),
      /unsupported target format/,
    );
    assert.equal(state.canvasCalls.length, 0, "nothing was rasterised");
  });
});

test("convert rejects source bytes that cannot be decoded", async () => {
  await withCanvas(
    { decodeError: new Error("The source image could not be decoded") },
    async () => {
      await assert.rejects(
        () => convert.convert(new Uint8Array([1, 2, 3, 4]), "png", "jpeg"),
        /cannot decode png image data/,
      );
    },
  );
});

test("convert rejects empty source bytes", async () => {
  await withCanvas({}, async () => {
    await assert.rejects(
      () => convert.convert(new Uint8Array([]), "png", "jpeg"),
      /empty/,
    );
  });
});

test("convert rejects a missing createImageBitmap", async () => {
  await withCanvas({ withoutBitmap: true }, async () => {
    await assert.rejects(
      () => convert.convert(pngBytes(), "png", "jpeg"),
      /createImageBitmap is not available/,
    );
  });
});

test("convert rejects a missing OffscreenCanvas", async () => {
  await withCanvas({ withoutCanvas: true }, async () => {
    await assert.rejects(
      () => convert.convert(pngBytes(), "png", "jpeg"),
      /OffscreenCanvas is not available/,
    );
  });
});

// ---------------------------------------------------------------------------
// canConvert
// ---------------------------------------------------------------------------

test("canConvert is false for an unknown source", () => {
  assert.equal(convert.canConvert("mp4", "png"), false);
  assert.equal(convert.canConvert("heic", "png"), false);
  assert.equal(convert.canConvert("", "png"), false);
});

test("canConvert is false for an unsupported target", () => {
  assert.equal(convert.canConvert("png", "gif"), false);
  assert.equal(convert.canConvert("png", "bmp"), false);
  assert.equal(convert.canConvert("png", ""), false);
});

test("canConvert is false for empty input and never throws", () => {
  assert.equal(convert.canConvert(null, null), false);
  assert.equal(convert.canConvert(undefined, undefined), false);
  assert.equal(convert.canConvert(42, {}), false);
});

test("canConvert is true for every supported combination", () => {
  assert.equal(convert.canConvert("jpg", "jpeg"), true);
  assert.equal(convert.canConvert("jpeg", "jpg"), true);
  assert.equal(convert.canConvert("png", "png"), true);
  assert.equal(convert.canConvert("png", "jpeg"), true);
  assert.equal(convert.canConvert("webp", "png"), true);
  assert.equal(convert.canConvert("gif", "jpeg"), true);
  assert.equal(convert.canConvert("bmp", "webp"), true);
  assert.equal(convert.canConvert("avif", "jpeg"), true);
});
