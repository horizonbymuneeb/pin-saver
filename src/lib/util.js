/**
 * Shared pure helpers.
 *
 * Loaded as a plain content script (classic script), so it deliberately
 * attaches to a single global namespace instead of using ES modules.
 * Every function here is side-effect free and is unit-tested in Node.
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});

  /**
   * Pinterest serves every pin through a resized CDN path such as
   *   https://i.pinimg.com/564x/ab/cd/ef/abcdef.jpg
   * The numeric segment is the width bucket. Replacing it with `originals`
   * yields the untouched, full-resolution upload.
   *
   * Buckets come in two shapes: `564x` (width only) and `75x75` (square
   * thumbnails), so the optional second number is part of the pattern.
   *
   * Only the FIRST bucket segment is replaced: the hex directory segments
   * (ab/cd/ef) are not widths and must stay untouched.
   */
  function toOriginalUrl(url) {
    if (typeof url !== "string" || !url) return url;
    return url.replace(/\/\d+x\d*\//, "/originals/");
  }

  /** True when the URL points at a video rather than a still image. */
  function isVideoUrl(url) {
    if (typeof url !== "string" || !url) return false;
    return (
      url.includes("/videos/") ||
      /\.(mp4|mov|webm|m3u8|cmfv)(\?|$)/i.test(url) ||
      url.includes("video_p5p") ||
      url.includes("v_HLS")
    );
  }

  /**
   * `hei[cf]` is the HEIF/HEIC variant Pinterest sometimes hands out. Some
   * browsers refuse it, so prefer the JPEG fallback when one exists.
   */
  function preferFallback(url, fallbackUrl) {
    if (typeof url !== "string" || !url) return "";
    const isHeif = /\.hei[cf](\?|$)/i.test(url);
    if (isHeif && fallbackUrl) return fallbackUrl;
    return url;
  }

  /** File extension for a URL, defaulting to jpg for bare Pinterest images. */
  function extensionFor(url, video) {
    if (video) return "mp4";
    const m = String(url || "").match(
      /\.(jpe?g|png|gif|webp|avif|mp4|mov|webm)(\?|$)/i,
    );
    if (!m) return "jpg";
    const ext = m[1].toLowerCase();
    if (ext === "jpeg") return "jpg";
    return ext;
  }

  /**
   * Make a string safe as a file or folder name on Windows, macOS and Linux.
   * Strips reserved characters and control codes, collapses whitespace to
   * underscores and caps the length so paths stay under OS limits.
   */
  function sanitizeName(input, maxLength) {
    const limit = maxLength || 50;
    return String(input == null ? "" : input)
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, limit);
  }

  /** Two-digit zero padding used for ordered file names inside a ZIP. */
  function pad(n, width) {
    let s = String(n);
    while (s.length < width) s = "0" + s;
    return s;
  }

  /**
   * Pick the best still-image URL out of a pin object returned by the
   * Pinterest resource API. Mirrors the CDN buckets the site itself uses,
   * falling back through medium/original variants.
   */
  function pickImageUrl(pin) {
    if (!pin || typeof pin !== "object") return null;
    const images = pin.images || {};
    if (images.orig && images.orig.url) return images.orig.url;
    if (images["736x"] && images["736x"].url) return images["736x"].url;
    if (images["564x"] && images["564x"].url) return images["564x"].url;
    return (
      pin.image_large_url ||
      pin.image_medium_url ||
      pin.image_square_url ||
      null
    );
  }

  /** Best-effort video URL from a story/idea pin shape. */
  function pickStoryVideoUrl(pin) {
    const block =
      pin &&
      pin.story_pin_data &&
      pin.story_pin_data.pages &&
      pin.story_pin_data.pages[0] &&
      pin.story_pin_data.pages[0].blocks &&
      pin.story_pin_data.pages[0].blocks[0];
    const video = block && block.video;
    if (!video) return null;
    if (video.video_list) {
      const mobile = video.video_list.V_HLSV3_MOBILE;
      if (mobile && mobile.url) return mobile.url;
      const hls = video.video_list.V_HLSV3_WEB;
      if (hls && hls.url) return hls.url;
    }
    return video.video_url || null;
  }

  /** Short, human-readable title used in file names and the manifest. */
  function pinTitle(pin) {
    if (!pin || typeof pin !== "object") return "";
    const candidates = [
      pin.title,
      pin.grid_title,
      pin.story_pin_data &&
        pin.story_pin_data.metadata &&
        pin.story_pin_data.metadata.title,
      pin.description,
      pin.note,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
    return "";
  }

  /**
   * Chrome's extension messaging JSON-serialises payloads, which turns a
   * Uint8Array into a plain `{"0":137,"1":80,...}` object. Any binary value
   * crossing a message boundary must therefore be base64 text.
   */
  function bytesToBase64(bytes) {
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /** Inverse of bytesToBase64. */
  function base64ToBytes(text) {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  /**
   * Build the folder path a pin belongs to inside an archive.
   *
   * `sectionPath` is attached by the API client only for pins that came from a
   * section request; plain board-feed pins have no section at all, so they
   * fall back to the supplied default (usually "").
   */
  function sectionFolderPath(pin, fallback) {
    const path = pin && pin.sectionPath;
    if (Array.isArray(path) && path.length) {
      return path
        .map(function (part) {
          return sanitizeName(String(part || "").trim(), 50) || "section";
        })
        .join("/");
    }
    return fallback || "";
  }

  /**
   * Stable keys used to match a pin picked in the DOM against a pin returned by
   * the API.
   *
   * The DOM exposes the pin id only sometimes, and a picked video may be an mp4
   * in the page but an m3u8 in the API. So a pin is identified by BOTH its id
   * key and its canonical media-URL key, and a match on either one counts.
   */
  function pinIdKey(id) {
    if (id == null || id === "") return null;
    return "id:" + String(id);
  }

  function mediaKey(url) {
    if (typeof url !== "string" || !url) return null;
    return "url:" + toOriginalUrl(url);
  }

  /** All keys under which an API pin may have been selected. */
  function pinSelectionKeys(pin) {
    if (!pin || typeof pin !== "object") return [];
    const keys = [];
    const idKey = pinIdKey(pin.id);
    if (idKey) keys.push(idKey);
    const story = pickStoryVideoUrl(pin);
    if (story) keys.push(mediaKey(story));
    const image = pickImageUrl(pin);
    if (image) keys.push(mediaKey(image));
    return keys;
  }

  /** True when the pin was selected under any of its keys. */
  function isPinSelected(pin, selectedSet) {
    if (!selectedSet || typeof selectedSet.has !== "function") return false;
    return pinSelectionKeys(pin).some(function (key) {
      return selectedSet.has(key);
    });
  }

  /**
   * Encode one CSV cell.
   *
   * Pin titles and descriptions are written by other Pinterest users, so they
   * are untrusted input. A cell that begins with `=`, `+`, `-` or `@` is
   * evaluated as a formula by Excel and LibreOffice (CSV formula injection),
   * so such cells are neutralised with a leading apostrophe before quoting.
   */
  function csvCell(value) {
    let s = String(value == null ? "" : value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * Build the metadata sidecar for an archive.
   *
   * @param {Array} pins ordered exactly as the media files are named
   * @param {Array<string>} sections folder per pin, same order
   * @returns {{csv: string, json: string}}
   */
  function buildMetadata(pins, sections) {
    const list = Array.isArray(pins) ? pins : [];
    const folders = Array.isArray(sections) ? sections : [];

    const rows = list.map(function (pin, i) {
      const p = pin || {};
      const description = p.description || p.note || "";
      const storyTitle =
        p.story_pin_data &&
        p.story_pin_data.metadata &&
        p.story_pin_data.metadata.title;
      return {
        n: i + 1,
        id: String(p.id == null ? "" : p.id),
        title: pinTitle(p),
        description: description,
        link: p.link || p.source_url || "",
        section: folders[i] || "",
        type: p.story_pin_data ? "idea" : p.videos ? "video" : "image",
        url: p.id ? "https://www.pinterest.com/pin/" + p.id + "/" : "",
      };
    });

    const header = "n,id,title,description,link,section,type,url";
    const lines = [header];
    for (const r of rows) {
      lines.push(
        [
          r.n,
          csvCell(r.id),
          csvCell(r.title),
          csvCell(r.description),
          csvCell(r.link),
          csvCell(r.section),
          csvCell(r.type),
          csvCell(r.url),
        ].join(","),
      );
    }
    return { csv: lines.join("\r\n") + "\r\n", json: JSON.stringify(rows, null, 2) };
  }

  /**
   * Pinterest routes that are NOT boards.
   *
   * A board URL is `/<username>/<board-slug>/`, so the only reliable test is
   * "two or more segments and the first one is not an app route". This lived in
   * two places (popup and content script) with slightly different lists; one
   * edit to either would make the popup claim "board detected" while the panel
   * never appeared.
   */
  const RESERVED_ROUTES = [
    "pin",
    "search",
    "ideas",
    "settings",
    "notifications",
    "messages",
    "explore",
    "today",
    "home",
    "following",
    "business",
  ];

  /** True when a Pinterest pathname looks like a board. */
  function isBoardPath(pathname) {
    const parts = String(pathname || "")
      .split("?")[0]
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return false;
    return RESERVED_ROUTES.indexOf(parts[0].toLowerCase()) === -1;
  }

  /** True when a full URL points at a board. */
  function isBoardUrl(url) {
    let pathname;
    try {
      pathname = new URL(url).pathname;
    } catch (_) {
      return false;
    }
    return isBoardPath(pathname);
  }

  /** Convert a byte array to a base64 data URL without external libraries. */
  function bytesToDataUrl(bytes, mime) {
    const blob =
      bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || "application/octet-stream" });
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onloadend = function () {
        resolve(reader.result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /** Promise wrapper around a timeout, used for every network call. */
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error("Timed out after " + ms + "ms" + (label ? ": " + label : "")));
      }, ms);
      promise.then(
        function (v) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        function (e) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  PK.util = {
    toOriginalUrl: toOriginalUrl,
    isVideoUrl: isVideoUrl,
    preferFallback: preferFallback,
    extensionFor: extensionFor,
    sanitizeName: sanitizeName,
    pad: pad,
    pickImageUrl: pickImageUrl,
    pickStoryVideoUrl: pickStoryVideoUrl,
    pinTitle: pinTitle,
    bytesToDataUrl: bytesToDataUrl,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    withTimeout: withTimeout,
    sectionFolderPath: sectionFolderPath,
    pinIdKey: pinIdKey,
    mediaKey: mediaKey,
    pinSelectionKeys: pinSelectionKeys,
    isPinSelected: isPinSelected,
    csvCell: csvCell,
    buildMetadata: buildMetadata,
    isBoardPath: isBoardPath,
    isBoardUrl: isBoardUrl,
    RESERVED_ROUTES: RESERVED_ROUTES,
  };

  // Node test harness import.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PK.util;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
