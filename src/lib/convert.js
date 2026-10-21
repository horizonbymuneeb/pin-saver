/**
 * Image format conversion.
 *
 * Pinterest hands the extension the exact bytes it wants to keep. When a user
 * asks for another format — a PNG for a wallpaper, a smaller JPEG for a
 * preview — those bytes have to be re-encoded, and the only encoder available
 * without dependencies is the browser's own canvas.
 *
 * The pipeline is the standard one:
 *   createImageBitmap(blob) -> OffscreenCanvas -> convertToBlob()
 * Both APIs exist in a service worker and in a content script, so the module
 * works in either place and needs no DOM, no `Image` element and no object
 * URL (`URL.createObjectURL` does not exist in a service worker).
 *
 * Two deliberate rules:
 *   - JPEG -> JPEG is a pass-through. Re-encoding would only lose quality.
 *   - The canvas is filled with white before drawing, because JPEG has no
 *     alpha channel and transparency would otherwise be encoded as black.
 *     PNG output is flattened onto the same white background.
 *
 * Animated GIFs lose their animation: a canvas rasterises the first frame.
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});

  /**
   * Source formats this module can decode, mapped to their canonical name.
   * "jpg" is an alias of "jpeg" everywhere.
   */
  const SOURCE_TYPES = {
    jpg: "jpeg",
    jpeg: "jpeg",
    png: "png",
    webp: "webp",
    gif: "gif",
    bmp: "bmp",
    avif: "avif",
  };

  /** Target formats this module can encode, mapped to their canonical name. */
  const TARGET_TYPES = {
    jpg: "jpeg",
    jpeg: "jpeg",
    png: "png",
    webp: "webp",
  };

  /** MIME type per canonical format, used for the source blob and the output. */
  const MIME_TYPES = {
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    avif: "image/avif",
  };

  /** Targets whose encoder honours a quality setting. */
  const LOSSY_TARGETS = ["jpeg", "webp"];

  /** Default encoder quality for lossy targets. */
  const DEFAULT_QUALITY = 0.92;

  /**
   * Normalise an extension or MIME type to a bare lowercase extension.
   * "JPG", ".jpg" and "image/jpeg" all become "jpg".
   */
  function normalizeExt(ext) {
    if (typeof ext !== "string") return "";
    let s = ext.trim().toLowerCase();
    if (s.indexOf(".") === 0) s = s.slice(1);
    const slash = s.lastIndexOf("/");
    if (slash !== -1) s = s.slice(slash + 1);
    return s;
  }

  /** Canonical source format, or "" when the format is not supported. */
  function sourceType(ext) {
    const key = normalizeExt(ext);
    if (!Object.prototype.hasOwnProperty.call(SOURCE_TYPES, key)) return "";
    return SOURCE_TYPES[key];
  }

  /** Canonical target format, or "" when the format is not supported. */
  function targetType(ext) {
    const key = normalizeExt(ext);
    if (!Object.prototype.hasOwnProperty.call(TARGET_TYPES, key)) return "";
    return TARGET_TYPES[key];
  }

  /** Clamp a quality value into the 0..1 range the encoder expects. */
  function clampQuality(quality) {
    if (quality === undefined || quality === null) return DEFAULT_QUALITY;
    const q = Number(quality);
    if (!isFinite(q)) return DEFAULT_QUALITY;
    if (q < 0) return 0;
    if (q > 1) return 1;
    return q;
  }

  /** Suffix for an underlying failure, so the cause is not swallowed. */
  function reason(err) {
    if (!err) return "";
    const text = err && err.message ? err.message : String(err);
    return text ? " (" + text + ")" : "";
  }

  /**
   * Convert image bytes into another format.
   *
   * @param {Uint8Array} bytes   the source image
   * @param {string} sourceExt   "jpg" | "jpeg" | "png" | "webp" | "gif" | ...
   * @param {string} targetExt   "jpeg" | "png" | "webp"  (use "jpg" as an alias of "jpeg")
   * @param {number} [quality]   0..1, only meaningful for lossy targets (default 0.92)
   * @returns {Promise<{bytes: Uint8Array, ext: string}>} the new bytes and the
   *   canonical target extension ("jpeg" | "png" | "webp")
   */
  async function convert(bytes, sourceExt, targetExt, quality) {
    const source = sourceType(sourceExt);
    if (!source) {
      throw new Error(
        "convert: unsupported source format \"" + String(sourceExt) + "\"",
      );
    }
    const target = targetType(targetExt);
    if (!target) {
      throw new Error(
        "convert: unsupported target format \"" + String(targetExt) + "\"",
      );
    }

    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("convert: source bytes must be a Uint8Array");
    }
    if (!bytes.length) {
      throw new Error("convert: source bytes are empty");
    }

    // JPEG -> JPEG is a pass-through: re-encoding would only lose quality.
    if (source === "jpeg" && target === "jpeg") {
      // Cheap sanity check so mislabelled bytes are not silently passed on.
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        throw new Error("convert: source bytes are not a JPEG (bad SOI marker)");
      }
      return { bytes: bytes, ext: target };
    }

    if (typeof createImageBitmap !== "function") {
      throw new Error("convert: createImageBitmap is not available in this context");
    }
    if (typeof OffscreenCanvas === "undefined") {
      throw new Error("convert: OffscreenCanvas is not available in this context");
    }

    const sourceMime = MIME_TYPES[source] || "application/octet-stream";
    const blob = new Blob([bytes], { type: sourceMime });

    let bitmap;
    try {
      // "from-image" applies the EXIF orientation, so a rotated photo is not
      // saved sideways.
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch (err) {
      throw new Error(
        "convert: cannot decode " + source + " image data" + reason(err),
      );
    }
    if (!bitmap || !bitmap.width || !bitmap.height) {
      throw new Error("convert: decoded image has no dimensions");
    }

    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("convert: OffscreenCanvas has no 2d context");
      }

      // White background first: JPEG has no alpha channel, so transparency
      // would otherwise be encoded as black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);

      const options = { type: MIME_TYPES[target] };
      if (LOSSY_TARGETS.indexOf(target) !== -1) {
        options.quality = clampQuality(quality);
      }
      const encoded = await canvas.convertToBlob(options);
      const out = new Uint8Array(await encoded.arrayBuffer());
      return { bytes: out, ext: target };
    } finally {
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
    }
  }

  /**
   * True when this module can convert that source format.
   *
   * Never throws: an unknown source or an unsupported target is simply false.
   */
  function canConvert(sourceExt, targetExt) {
    return sourceType(sourceExt) !== "" && targetType(targetExt) !== "";
  }

  PK.convert = {
    convert: convert,
    canConvert: canConvert,
  };

  // Node test harness import.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PK.convert;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
