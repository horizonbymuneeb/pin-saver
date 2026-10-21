/**
 * Minimal PDF writer that embeds JPEG images directly.
 *
 * Rationale: the reference extension bundles a full HTML-to-canvas renderer
 * just to produce a PDF. For a downloader that already has the image bytes,
 * that is enormous overkill. A PDF can carry a JPEG untouched using the
 * /DCTDecode filter, so this module writes a valid multi-page PDF with no
 * dependencies and no re-encoding (no quality loss).
 *
 * Structure produced:
 *   catalog → pages → one page per image → image XObject (DCTDecode)
 *
 * Non-JPEG input must be converted to JPEG by the caller (the content script
 * uses an offscreen canvas) because this writer deliberately supports a
 * single, universally supported image filter.
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});

  /** A4 at 72 dpi, in points. */
  const A4 = { width: 595.28, height: 841.89 };
  /** Margin kept around each image, in points. */
  const MARGIN = 24;

  function ascii(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  /**
   * Read width/height from a JPEG's SOFn marker.
   * Returns null when the bytes are not a parseable JPEG.
   */
  function jpegSize(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // SOI
    let i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the dimensions.
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        const height = (bytes[i + 5] << 8) | bytes[i + 6];
        const width = (bytes[i + 7] << 8) | bytes[i + 8];
        if (width > 0 && height > 0) return { width: width, height: height };
        return null;
      }
      // Markers without a payload.
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = (bytes[i + 2] << 8) | bytes[i + 3];
      if (length < 2) return null;
      i += 2 + length;
    }
    return null;
  }

  /** Fit an image into the page while preserving aspect ratio. */
  function fitBox(imgW, imgH, pageW, pageH, margin) {
    const availW = pageW - margin * 2;
    const availH = pageH - margin * 2;
    const scale = Math.min(availW / imgW, availH / imgH, 1);
    const w = imgW * scale;
    const h = imgH * scale;
    return {
      x: (pageW - w) / 2,
      y: (pageH - h) / 2,
      width: w,
      height: h,
    };
  }

  /**
   * Build a PDF.
   *
   * @param {Array<{jpeg: Uint8Array, width: number, height: number, title?: string}>} images
   * @returns {Uint8Array}
   */
  function buildPdf(images) {
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error("buildPdf needs at least one image");
    }

    const chunks = []; // {bytes} in output order
    let offset = 0;
    const offsets = {}; // object number -> byte offset

    function push(bytes) {
      chunks.push(bytes);
      offset += bytes.length;
    }

    function startObject(num) {
      offsets[num] = offset;
      push(ascii(num + " 0 obj\n"));
    }

    function endObject() {
      push(ascii("\nendobj\n"));
    }

    // Header. The binary comment tells tools the file contains binary data.
    push(ascii("%PDF-1.4\n"));
    push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    // Object numbering plan:
    //   1 = catalog, 2 = pages tree
    //   then for each image: page object, content stream object, image object
    const CATALOG = 1;
    const PAGES = 2;
    const firstImageObject = 3;

    const pageNumbers = [];
    let next = firstImageObject;
    for (let i = 0; i < images.length; i++) {
      pageNumbers.push(next);
      next += 3;
    }

    // 1. Catalog
    startObject(CATALOG);
    push(ascii("<< /Type /Catalog /Pages " + PAGES + " 0 R >>"));
    endObject();

    // 2. Pages tree
    startObject(PAGES);
    const kids = pageNumbers.map((n) => n + " 0 R").join(" ");
    push(
      ascii(
        "<< /Type /Pages /Count " + images.length + " /Kids [" + kids + "] >>",
      ),
    );
    endObject();

    // 3..: one page, one content stream and one image object per image
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img || !(img.jpeg instanceof Uint8Array) || img.jpeg.length === 0) {
        throw new Error("buildPdf: image " + i + " has no JPEG bytes");
      }
      const width = img.width || 0;
      const height = img.height || 0;
      if (!width || !height) {
        throw new Error("buildPdf: image " + i + " needs width and height");
      }

      const pageNum = pageNumbers[i];
      const contentNum = pageNum + 1;
      const imageNum = pageNum + 2;
      const box = fitBox(width, height, A4.width, A4.height, MARGIN);

      // Page
      startObject(pageNum);
      push(
        ascii(
          "<< /Type /Page /Parent " + PAGES + " 0 R" +
            " /MediaBox [0 0 " + fmt(A4.width) + " " + fmt(A4.height) + "]" +
            " /Resources << /XObject << /Im" + i + " " + imageNum + " 0 R >> >>" +
            " /Contents " + contentNum + " 0 R >>",
        ),
      );
      endObject();

      // Content stream: place the image with a cm transform + Do operator.
      const content =
        "q\n" +
        fmt(box.width) + " 0 0 " + fmt(box.height) + " " +
        fmt(box.x) + " " + fmt(box.y) + " cm\n" +
        "/Im" + i + " Do\n" +
        "Q\n";
      const contentBytes = ascii(content);
      startObject(contentNum);
      push(ascii("<< /Length " + contentBytes.length + " >>\nstream\n"));
      push(contentBytes);
      push(ascii("endstream"));
      endObject();

      // Image XObject — JPEG bytes go through untouched with DCTDecode.
      startObject(imageNum);
      push(
        ascii(
          "<< /Type /XObject /Subtype /Image" +
            " /Width " + width + " /Height " + height +
            " /ColorSpace /DeviceRGB /BitsPerComponent 8" +
            " /Filter /DCTDecode /Length " + img.jpeg.length + " >>\nstream\n",
        ),
      );
      push(img.jpeg);
      push(ascii("\nendstream"));
      endObject();
    }

    // Cross-reference table.
    const totalObjects = next; // objects are 1..next-1
    const xrefStart = offset;
    let xref = "xref\n0 " + totalObjects + "\n";
    xref += "0000000000 65535 f \n";
    for (let n = 1; n < totalObjects; n++) {
      xref += String(offsets[n] || 0).padStart(10, "0") + " 00000 n \n";
    }
    push(ascii(xref));

    // Trailer
    push(
      ascii(
        "trailer\n<< /Size " + totalObjects + " /Root " + CATALOG + " 0 R >>\n" +
          "startxref\n" + xrefStart + "\n%%EOF\n",
      ),
    );

    // Concatenate.
    const out = new Uint8Array(offset);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  /** PDF number formatting: trim float noise, always use a dot. */
  function fmt(n) {
    const rounded = Math.round(n * 100) / 100;
    return String(rounded);
  }

  PK.pdf = {
    A4: A4,
    MARGIN: MARGIN,
    jpegSize: jpegSize,
    fitBox: fitBox,
    buildPdf: buildPdf,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = PK.pdf;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
