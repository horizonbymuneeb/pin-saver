/**
 * Minimal ZIP writer (store method, no compression).
 *
 * Why not a library: a Manifest V3 extension cannot pull code from a CDN
 * (the page CSP is `script-src 'self'`), so bundling a zip library would mean
 * adding a build step. JPEG/PNG/MP4 are already compressed, so "store" costs
 * almost nothing in size and keeps this dependency-free and auditable.
 *
 * Only the two pieces of the ZIP spec we need are implemented:
 *   - local file header  (0x04034b50)
 *   - central directory  (0x02014b50) + end-of-central-directory (0x06054b50)
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});

  // ---- CRC-32 (IEEE 802.3), computed once into a lookup table ----
  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  /** Build a DOS date/time pair from a JS Date. */
  function dosDateTime(date) {
    const d = date || new Date();
    const year = Math.max(1980, d.getFullYear());
    const dosTime =
      (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dosDate =
      ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff };
  }

  /**
   * Zipper accumulates entries, then `build()` emits one Uint8Array.
   *
   * @param {Date} [now] fixed timestamp — pass one in tests for determinism.
   */
  function Zipper(now) {
    this.entries = [];
    this.now = now || new Date();
    this.offset = 0;
  }

  /**
   * @param {string} path   forward-slash path inside the archive
   * @param {Uint8Array} data raw bytes (already compressed formats)
   */
  Zipper.prototype.add = function (path, data) {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError("Zipper.add expects a Uint8Array");
    }
    const nameBytes = utf8(path);
    const crc = crc32(data);
    const { dosTime, dosDate } = dosDateTime(this.now);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 file names
    lv.setUint16(8, 0, true); // compression method: stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);

    this.entries.push({
      path: path,
      nameBytes: nameBytes,
      data: data,
      crc: crc,
      dosTime: dosTime,
      dosDate: dosDate,
      offset: this.offset,
    });
    this.offset += local.length + data.length;
    return this;
  };

  /** Convenience: add a UTF-8 text file (adds BOM when `bom` is true). */
  Zipper.prototype.addText = function (path, text, bom) {
    const body = utf8(text);
    if (!bom) return this.add(path, body);
    const withBom = new Uint8Array(body.length + 3);
    withBom[0] = 0xef;
    withBom[1] = 0xbb;
    withBom[2] = 0xbf;
    withBom.set(body, 3);
    return this.add(path, withBom);
  };

  Zipper.prototype.build = function () {
    const chunks = [];
    let total = 0;

    // Local headers + payloads.
    for (const e of this.entries) {
      const local = new Uint8Array(30 + e.nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, e.dosTime, true);
      lv.setUint16(12, e.dosDate, true);
      lv.setUint32(14, e.crc, true);
      lv.setUint32(18, e.data.length, true);
      lv.setUint32(22, e.data.length, true);
      lv.setUint16(26, e.nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(e.nameBytes, 30);
      chunks.push(local, e.data);
      total += local.length + e.data.length;
    }

    const centralStart = total;

    // Central directory.
    for (const e of this.entries) {
      const cd = new Uint8Array(46 + e.nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true); // central directory signature
      cv.setUint16(4, 20, true); // version made by
      cv.setUint16(6, 20, true); // version needed
      cv.setUint16(8, 0x0800, true); // flags: UTF-8
      cv.setUint16(10, 0, true); // stored
      cv.setUint16(12, e.dosTime, true);
      cv.setUint16(14, e.dosDate, true);
      cv.setUint32(16, e.crc, true);
      cv.setUint32(20, e.data.length, true);
      cv.setUint32(24, e.data.length, true);
      cv.setUint16(28, e.nameBytes.length, true);
      cv.setUint16(30, 0, true); // extra length
      cv.setUint16(32, 0, true); // comment length
      cv.setUint16(34, 0, true); // disk number start
      cv.setUint16(36, 0, true); // internal attributes
      cv.setUint32(38, 0, true); // external attributes
      cv.setUint32(42, e.offset, true); // offset of local header
      cd.set(e.nameBytes, 46);
      chunks.push(cd);
      total += cd.length;
    }

    const centralSize = total - centralStart;

    // End of central directory.
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true); // disk number
    ev.setUint16(6, 0, true); // disk with central directory
    ev.setUint16(8, this.entries.length, true);
    ev.setUint16(10, this.entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    ev.setUint16(20, 0, true); // comment length
    chunks.push(eocd);
    total += eocd.length;

    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  };

  PK.Zipper = Zipper;
  PK.crc32 = crc32;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { Zipper: Zipper, crc32: crc32 };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
