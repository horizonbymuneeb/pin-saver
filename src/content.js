/**
 * Content script: injects the UI into Pinterest and drives every download.
 *
 * Layout:
 *   - a small download button is attached to every pin card / closeup
 *   - a floating panel appears on board pages with "Download board as ZIP"
 *   - single-pin downloads go straight through the background worker
 */
(function () {
  "use strict";

  const PK = window.PK;
  const util = PK.util;
  const api = PK.api;

  const MSG = {
    BOARD_ZIP: "Download board as ZIP",
    BOARD_PDF: "Download board as PDF",
    SELECT: "Select pins",
    DOWNLOAD: "Download",
    DOWNLOADING: "Saving...",
    PICK: "Select",
    PICKED: "Selected",
  };

  const state = {
    /** Pin ids the user picked in the selection dialog. */
    selected: new Set(),
    /** The pin objects behind those ids, so the export does not refetch them. */
    selectedPins: [],
    busy: false,
    boardName: "",
    /** Set while an export is running. */
    running: false,
    /** The user asked the running export to stop. */
    cancelRequested: false,
    /** Aborts the in-flight API and media work. */
    controller: null,
    /** The panel module's handle. */
    panelUi: null,
    /** "board" | "pin" — which view the panel is showing. */
    panelMode: null,
    /** The user closed the panel; do not bring it back until the route changes. */
    panelDismissed: false,
    /** The board the user was last on, so a pin page can name it. */
    lastBoardUrl: "",
    /** The last pin info pushed to the panel, so it is not pushed twice. */
    lastPinKey: "",
    /** "original" | "jpeg" | "png" — the format images are saved in. */
    imageFormat: "original",
  };

  /** How many media files are fetched at the same time. */
  const FETCH_CONCURRENCY = 8;

  // ---------------------------------------------------------------- helpers

  function sendBackground(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (response) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response" });
      });
    });
  }

  /**
   * Route API requests through the background worker.
   *
   * A content script on `pinterest.com` (or on a country domain such as
   * `in.pinterest.com`) fetching `https://www.pinterest.com/...` is
   * cross-origin. The browser sends a CORS preflight, Pinterest answers it
   * with HTTP 400 and no `Access-Control-Allow-Origin`, and the request dies
   * with the bare message "Failed to fetch" — which is what a user sees when
   * PDF export fails. The worker holds host permissions, so the same request
   * succeeds there with no CORS involved.
   */
  function installApiTransport() {
    if (!api || typeof api.setTransport !== "function") return;
    api.setTransport(async function (url, headers) {
      const res = await sendBackground({ action: "apiGet", url: url, headers: headers });
      if (!res || !res.ok) {
        const err = new Error(
          (res && res.error ? res.error : "API request failed") +
            (res && res.status ? " (HTTP " + res.status + ")" : ""),
        );
        err.network = !res || !res.status;
        throw err;
      }
      return JSON.parse(res.text);
    });
  }

  /** Read the board display name from the page heading. */
  function readBoardName() {
    const h1 = document.querySelector("h1#board-name, h1");
    const text = h1 && h1.textContent ? h1.textContent.trim() : "";
    return text || "pinterest-board";
  }

  /** Total pin count the page advertises (used for progress copy). */
  function readPinCount() {
    const node = document.querySelector('[data-test-id="pin-count"]');
    const text = node && node.textContent ? node.textContent : "";
    const m = text.match(/([\d,.]+)/);
    return m ? parseInt(m[1].replace(/[,.]/g, ""), 10) : null;
  }

  /**
   * Pull the best media URL out of a pin's DOM node.
   * Prefers the rendered <img>/<video>, then data attributes, then the
   * highest-resolution srcset entry we can see.
   */
  function readMediaFromNode(node) {
    if (!node) return null;
    const video = node.querySelector("video");
    if (video) {
      const src =
        video.currentSrc ||
        video.src ||
        (video.querySelector("source") && video.querySelector("source").src);
      if (src) return { url: src, isVideo: true };
    }

    const img = node.querySelector("img");
    if (img) {
      const url = img.currentSrc || img.src || img.getAttribute("src");
      if (url) {
        const srcset = img.getAttribute("srcset");
        if (srcset) {
          const best = pickLargestFromSrcset(srcset);
          if (best) return { url: best, isVideo: false };
        }
        return { url: url, isVideo: false };
      }
    }

    // Fall back to any element carrying a background image.
    const styled = node.querySelector('[style*="background-image"]');
    if (styled) {
      const m = (styled.getAttribute("style") || "").match(/url\(["']?([^"')]+)/);
      if (m) return { url: m[1], isVideo: false };
    }
    return null;
  }

  function pickLargestFromSrcset(srcset) {
    let best = null;
    let bestWidth = -1;
    const parts = srcset.split(",");
    for (const part of parts) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      const width = parseInt(bits[1] || "0", 10) || 0;
      if (width > bestWidth) {
        bestWidth = width;
        best = bits[0];
      }
    }
    return best;
  }

  /**
   * Draw the per-pin button's icon.
   *
   * The arrow used to be the "↓" text character, which rendered at roughly
   * 4x10 pixels inside the 30px circle and was illegible once the store
   * screenshot was scaled down. A small inline SVG stays crisp at any size.
   */
  function setPinButtonIcon(btn, kind) {
    const paths = {
      download: "M8 3v9M4.5 8.5L8 12l3.5-3.5M3.5 14h9",
      done: "M4 8.5l2.6 2.6L12 5.5",
      busy: "M3.5 8h9",
      error: "M5.5 5.5l5 5M10.5 5.5l-5 5",
    };
    const stroke = kind === "error" ? "#ffffff" : "#ffffff";
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" ' +
      'style="display:block;margin:auto">' +
      '<path d="' + (paths[kind] || paths.download) + '" fill="none" stroke="' + stroke +
      '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>' +
      "</svg>";
    btn.setAttribute("data-icon", kind);
  }

  /**
   * Read Pinterest's numeric pin id out of a DOM node when it is exposed.
   * Returns null when the page does not expose it, so callers fall back to a
   * media-URL key instead of inventing an id.
   */
  function readPinIdFromNode(node) {
    if (!node) return null;
    for (const attr of ["data-pin-id", "data-id"]) {
      const value = node.getAttribute && node.getAttribute(attr);
      if (value && /^\d+$/.test(value)) return value;
    }
    const link =
      (node.querySelector && node.querySelector('a[href*="/pin/"]')) || null;
    if (link) {
      const match = (link.getAttribute("href") || "").match(/\/pin\/(\d+)/);
      if (match) return match[1];
    }
    const selfLink =
      node.closest && node.closest('a[href*="/pin/"]');
    if (selfLink) {
      const match = (selfLink.getAttribute("href") || "").match(/\/pin\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  /** Container that represents "one pin" for button placement. */
  function pinContainerFor(el) {
    return el.closest('[data-test-id="pin"]') || el.closest("div[role='button']");
  }

  // -------------------------------------------------------------- downloads

  /** Download one media URL at full resolution. */
  async function downloadSingle(media, title, format) {
    let url = media.isVideo
      ? media.url
      : util.toOriginalUrl(util.preferFallback(media.url, media.fallbackUrl));

    // An HLS playlist is not a video file; resolve it before saving.
    if (media.isVideo && /\.m3u8(\?|$)/i.test(url)) {
      const resolved = await resolveVideoToMp4(url);
      url = resolved.url;
    }

    const sourceExt = util.extensionFor(url, media.isVideo);
    const safeTitle = util.sanitizeName(title || "", 40) || "pin";

    // A requested format other than the original needs the bytes, so they are
    // converted first. A video is always saved as it is.
    const target = media.isVideo ? null : normaliseFormat(format);
    if (target && target !== sourceExt && PK.convert) {
      const original = await fetchMediaBytes(url, media.isVideo);
      const converted = await PK.convert.convert(original, sourceExt, target);
      return sendBackground({
        action: "downloadBytes",
        data: util.bytesToBase64(converted.bytes),
        mime: "image/" + converted.ext,
        filename: "PinSaver/" + safeTitle + "-" + Date.now() + "." + converted.ext,
      });
    }

    const ext = sourceExt;
    const filename = "PinSaver/" + safeTitle + "-" + Date.now() + "." + ext;

    const res = await sendBackground({
      action: "downloadUrl",
      url: url,
      filename: filename,
    });
    if (res.ok) return res;

    // Direct URL download can 403; retry by pulling bytes through the worker.
    const bytesRes = await sendBackground({
      action: "fetchMedia",
      url: url,
      isVideo: media.isVideo,
    });
    if (!bytesRes.ok) throw new Error(bytesRes.error);
    const bytes = util.base64ToBytes(bytesRes.data);
    return sendBackground({
      action: "downloadBytes",
      data: util.bytesToBase64(bytes),
      mime: media.isVideo ? "video/mp4" : "image/" + ext,
      filename: filename,
    });
  }

  /** "original" | "jpeg" | "png" → a format name, or null for the original. */
  function normaliseFormat(format) {
    const f = String(format || "").toLowerCase();
    if (f === "jpg" || f === "jpeg") return "jpeg";
    if (f === "png") return "png";
    if (f === "webp") return "webp";
    return null;
  }

  /** Fetch the bytes of one media file, preferring a direct page fetch. */
  async function fetchMediaBytes(url, isVideo) {
    try {
      return await fetchMediaDirect(url);
    } catch (_) {
      const res = await sendBackground({
        action: "fetchMedia",
        url: url,
        isVideo: isVideo,
      });
      if (!res.ok) throw new Error(res.error || "media fetch failed");
      return util.base64ToBytes(res.data);
    }
  }

  /**
   * Fetch one pin's bytes for building a ZIP archive.
   * Returns null when the media could not be retrieved (so a single broken
   * pin never aborts a whole board).
   */
  /**
   * Resolve an HLS playlist URL to the direct MP4 behind it.
   *
   * Playlists must be read from the background worker: a content script cannot
   * add the `Referer` the CDN expects, and CORS blocks the raw fetch.
   */
  async function resolveVideoToMp4(url) {
    const fetchFn = async function (u) {
      const res = await sendBackground({ action: "fetchText", url: u });
      if (!res.ok) throw new Error(res.error || "playlist fetch failed");
      return { ok: true, status: 200, text: async () => res.text };
    };
    return PK.video.resolveVideoUrl(url, fetchFn);
  }

  /** Work out the media URL for a pin and its type. */
  async function pickMediaUrl(pin) {
    const storyVideo = util.pickStoryVideoUrl(pin);
    const imageUrl = util.pickImageUrl(pin);
    const isVideo =
      !!storyVideo || util.isVideoUrl(imageUrl || "");
    let url = isVideo ? storyVideo || imageUrl : imageUrl;
    if (!url) return null;

    if (!isVideo) {
      return { url: util.toOriginalUrl(url), isVideo: false, ext: util.extensionFor(url, false) };
    }

    // A video pin usually points at an .m3u8 playlist; resolve it to the real
    // media file so the saved result is a playable video, not a text playlist.
    if (/\.m3u8(\?|$)/i.test(url)) {
      try {
        const resolved = await resolveVideoToMp4(url);
        url = resolved.url;
      } catch (err) {
        throw new Error("Video not downloadable: " + (err.message || err));
      }
    }
    return { url: url, isVideo: true, ext: util.extensionFor(url, true) };
  }

  /** The abort signal of the running export, if there is one. */
  function signal() {
    return state.controller ? state.controller.signal : undefined;
  }

  /** True when the user asked the export to stop. */
  function isCancelled() {
    return state.cancelRequested;
  }

  /**
   * Ask the running export to stop.
   *
   * A long board download used to be unstoppable: once it started the only way
   * out was to reload the page, and even then the download kept running in the
   * background worker. Now the panel gets a Cancel button, the abort signal is
   * fired and the worker is told to drop the fetches in flight.
   */
  function cancelExport() {
    if (!state.running) return;
    state.cancelRequested = true;
    try {
      if (state.controller) state.controller.abort();
    } catch (_) {
      /* already aborted */
    }
    sendBackground({ action: "cancelFetch" });
    setPanelStatus(ensurePanel(), "Cancelling…");
  }

  /**
   * Hand a finished archive to the browser's download machinery.
   *
   * A single message may not exceed 64 MiB, and the archive of a large board
   * is easily bigger than that — the download used to fail with "Message
   * exceeded maximum allowed size of 64MiB". The archive therefore travels in
   * pieces and is joined inside the worker, which then hands the browser a
   * blob URL. No large payload ever crosses a message.
   *
   * @param {Uint8Array} bytes the finished archive
   * @param {string} filename the file name to save it under
   * @param {string} mime the archive's media type
   */
  async function downloadArchive(bytes, filename, mime) {
    // The archive is handed over as a blob URL.
    //
    // Two earlier attempts failed on a big board: sending the bytes as base64
    // inside a message broke at the 64 MiB message limit, and building one
    // huge base64 string in the worker broke at V8's maximum string length
    // ("Invalid string length"). A blob URL is a short string, the browser
    // streams the bytes to disk, and neither limit applies.
    const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    try {
      const res = await sendBackground({
        action: "downloadArchive",
        url: url,
        filename: filename,
      });
      if (!res || !res.ok) {
        throw new Error((res && res.error) || "archive download failed");
      }
      return res;
    } finally {
      // The blob has to stay alive while the download reads it.
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 10 * 60 * 1000);
    }
  }

  /**
   * Fetch one media file straight from Pinterest's CDN.
   *
   * The bytes used to travel back from the service worker as base64 inside a
   * message, and a single message may not exceed 64 MiB. A board of large
   * photos produced "Message exceeded maximum allowed size of 64MiB" and the
   * export stalled with no error. Pinterest's CDN answers with
   * `Access-Control-Allow-Origin` echoing the page's origin, so the content
   * script can fetch the file itself: no message, no base64, no size limit.
   *
   * @param {string} url the media URL
   * @returns {Promise<Uint8Array>} the raw bytes
   */
  async function fetchMediaDirect(url) {
    const res = await fetch(url, { credentials: "omit", mode: "cors" });
    if (!res.ok) throw new Error("Media HTTP " + res.status);
    const buffer = await res.arrayBuffer();
    if (!buffer.byteLength) throw new Error("Empty media response");
    return new Uint8Array(buffer);
  }

  /**
   * Fetch several media files, preferring a direct fetch from the page.
   *
   * Anything the page could not fetch on its own falls back to the worker, so
   * a CDN that does not send CORS headers still works.
   */
  async function fetchMediaItems(items) {
    const results = new Array(items.length).fill(null);
    const failed = [];

    await Promise.all(
      items.map(async function (item, i) {
        try {
          results[i] = { ok: true, bytes: await fetchMediaDirect(item.url) };
        } catch (_) {
          failed.push(i);
        }
      }),
    );

    if (!failed.length) return results;

    const batch = await fetchMediaBatch(
      failed.map(function (i) {
        return items[i];
      }),
    );
    failed.forEach(function (i, k) {
      const res = batch[k];
      if (res && res.ok) {
        results[i] = { ok: true, bytes: util.base64ToBytes(res.data) };
      } else {
        results[i] = { ok: false, error: (res && res.error) || "media fetch failed" };
      }
    });
    return results;
  }

  /**
   * Fetch a batch of media files through the worker.
   *
   * The worker fetches them concurrently; the results come back in the same
   * order as the items. A file that failed is reported, not thrown, so one bad
   * pin cannot stop the batch.
   */
  async function fetchMediaBatch(items) {
    if (!items.length) return [];
    const res = await sendBackground({ action: "fetchMediaBatch", items: items });
    if (!res || !res.ok || !Array.isArray(res.results)) {
      const message = (res && res.error) || "media batch failed";
      return items.map(function () {
        return { ok: false, error: message };
      });
    }
    return res.results;
  }

  /**
   * Download the media of many pins, a batch at a time.
   *
   * Doing this one pin at a time was the reason a 500-pin board took minutes:
   * every pin was a serial round trip to the worker. The bytes are now fetched
   * in parallel batches, while the result order is kept so the archive is
   * still written in board order.
   *
   * @param {Array} pins the pins to fetch
   * @param {function} onProgress called with (done, total)
   * @returns {Promise<Array>} per pin: {bytes, ext, isVideo, url} or null
   */
  async function collectMedia(pins, onProgress) {
    const out = new Array(pins.length).fill(null);
    let done = 0;

    for (let i = 0; i < pins.length; i += FETCH_CONCURRENCY) {
      if (isCancelled()) break;
      const chunk = pins.slice(i, i + FETCH_CONCURRENCY);

      // Resolve the media URL first. For a video this fetches the playlist,
      // so it is done in parallel too.
      const plans = await Promise.all(
        chunk.map(async function (pin) {
          try {
            const media = await pickMediaUrl(pin);
            return media ? { media: media } : null;
          } catch (_) {
            return null;
          }
        }),
      );

      const items = [];
      const slots = [];
      plans.forEach(function (plan, idx) {
        if (!plan) return;
        slots.push(idx);
        items.push({ url: plan.media.url, isVideo: plan.media.isVideo });
      });

      if (items.length) {
        const results = await fetchMediaItems(items);
        results.forEach(function (res, k) {
          const idx = slots[k];
          if (!res || !res.ok) return;
          const media = plans[idx].media;
          out[i + idx] = {
            bytes: res.bytes,
            ext: media.ext,
            isVideo: media.isVideo,
            url: media.url,
          };
        });

        // A chosen format other than the original is applied here, while the
        // bytes are still in hand. A file that cannot be converted keeps its
        // original bytes rather than failing the whole export.
        const wanted = normaliseFormat(state.imageFormat);
        if (wanted && PK.convert && PK.convert.convert) {
          await Promise.all(
            results.map(async function (res, k) {
              const idx = slots[k];
              if (!res || !res.ok) return;
              const entry = out[i + idx];
              if (!entry || entry.isVideo) return;
              if (entry.ext === wanted) return;
              try {
                const converted = await PK.convert.convert(
                  entry.bytes,
                  entry.ext,
                  wanted,
                );
                entry.bytes = converted.bytes;
                entry.ext = converted.ext;
              } catch (_) {
                /* keep the original bytes */
              }
            }),
          );
        }
      }

      done += chunk.length;
      if (onProgress) onProgress(done, pins.length);
    }
    return out;
  }

  /** Build `_metadata.csv` (+ JSON twin) describing the archived pins. */
  function buildMetadata(pins, sections) {
    return util.buildMetadata(pins, sections);
  }

  /** Convert a pin's section path into nested folder names. */
  function sectionFolder(pin, fallback) {
    return util.sectionFolderPath(pin, fallback);
  }

  // ------------------------------------------------------------ board export

  /**
   * Download every pin of the current board into a ZIP.
   * @param {boolean} onlySelected restrict to the user's current selection
   */
  async function downloadBoardZip(onlySelected) {
    if (state.busy) return;
    state.busy = true;
    state.running = true;
    state.cancelRequested = false;
    state.controller = typeof AbortController === "function" ? new AbortController() : null;
    const panel = ensurePanel();
    if (panel && panel.setBusy) panel.setBusy(true);
    setPanelStatus(panel, "Reading board info...");

    try {
      const pathname = location.pathname.split("?")[0];
      const boardId = await api.fetchBoardId(pathname, signal());
      const boardName =
        util.sanitizeName(state.boardName || readBoardName(), 60) || "board";

      setPanelStatus(panel, "Fetching pin list...");
      const allPins = await api.fetchAllBoardPins(
        boardId,
        function (count, page, error) {
          if (error) {
            setPanelStatus(
              panel,
              "Fetched " + count + " pins — a page failed (" + error + ")",
              true,
            );
            return;
          }
          setPanelStatus(panel, "Fetched " + count + " pins (page " + page + ")");
        },
        signal(),
      );

      let pins = allPins;
      if (onlySelected) {
        pins = allPins.filter(function (p) {
          return util.isPinSelected(p, state.selected);
        });
      }
      if (!pins.length) {
        setPanelStatus(panel, "No pins found", true);
        return;
      }

      setPanelStatus(panel, "Downloading " + pins.length + " items...");
      const zipper = new PK.Zipper();
      const sections = [];
      const width = String(pins.length).length;

      // The bytes are fetched in parallel batches; the archive is still
      // written in board order.
      const media = await collectMedia(pins, function (done, total) {
        setPanelStatus(panel, "Downloading " + done + "/" + total + "…");
      });

      if (isCancelled()) {
        setPanelStatus(panel, "Cancelled — nothing was saved.");
        return;
      }

      let failed = 0;
      for (let i = 0; i < pins.length; i++) {
        const pin = pins[i];
        const folder = sectionFolder(pin, "");
        sections.push(folder);

        // One un-downloadable pin (a video whose playlist cannot be resolved,
        // for instance) must be skipped and counted, never abort the archive.
        const fetched = media[i];
        if (!fetched) {
          failed++;
        } else {
          const title =
            util.sanitizeName(util.pinTitle(pin), 50) ||
            "pin-" + util.pad(i + 1, width);
          const name = util.pad(i + 1, width) + "-" + title + "." + fetched.ext;
          const dir = boardName + (folder ? "/" + folder : "");
          zipper.add(dir + "/" + name, fetched.bytes);
        }
      }

      const meta = buildMetadata(pins, sections);
      zipper.addText(boardName + "/_metadata.csv", meta.csv, true);
      zipper.addText(boardName + "/_metadata.json", meta.json, false);

      setPanelStatus(panel, "Building ZIP...");
      const zipped = zipper.build();
      const res = await downloadArchive(
        zipped,
        "PinSaver/" + boardName + "-" + Date.now() + ".zip",
        "application/zip",
      );
      if (!res.ok) throw new Error(res.error || "ZIP download failed");
      setPanelStatus(
        panel,
        "Saved " + pins.length + " pins" + (failed ? ", " + failed + " skipped" : ""),
      );
    } catch (err) {
      if (isCancelled()) {
        setPanelStatus(panel, "Cancelled.");
      } else {
        setPanelStatus(panel, String(err.message || err), true);
      }
    } finally {
      state.busy = false;
      state.running = false;
      state.cancelRequested = false;
      state.controller = null;
      if (panel && panel.setBusy) panel.setBusy(false);
    }
  }

  // ------------------------------------------------------------- PDF export

  /**
   * Convert arbitrary image bytes into JPEG, which is what the PDF writer
   * embeds. JPEG input passes through untouched (no re-encode, no quality
   * loss); anything else is drawn through a canvas once.
   */
  async function ensureJpeg(bytes, ext) {
    if (ext === "jpg" || ext === "jpeg") {
      return { jpeg: bytes, width: null, height: null };
    }
    const blob = new Blob([bytes]);
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    // JPEG has no alpha channel; flatten onto white so transparency does not
    // come out black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const jpegBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.92,
    });
    bitmap.close();
    return {
      jpeg: new Uint8Array(await jpegBlob.arrayBuffer()),
      width: bitmap.width,
      height: bitmap.height,
    };
  }

  /** Download the board (or the current selection) as a single PDF album. */
  async function downloadBoardPdf(onlySelected) {
    if (state.busy) return;
    state.busy = true;
    state.running = true;
    state.cancelRequested = false;
    state.controller = typeof AbortController === "function" ? new AbortController() : null;
    const panel = ensurePanel();
    setPanelStatus(panel, "Reading board info...");

    try {
      const pathname = location.pathname.split("?")[0];
      const boardId = await api.fetchBoardId(pathname);
      const boardName =
        util.sanitizeName(state.boardName || readBoardName(), 60) || "board";

      setPanelStatus(panel, "Fetching pin list...");
      let pins = await api.fetchAllBoardPins(boardId, function (count, page) {
        setPanelStatus(panel, "Fetched " + count + " pins (page " + page + ")");
      });

      if (onlySelected) {
        pins = pins.filter(function (p) {
          return util.isPinSelected(p, state.selected);
        });
      }
      if (!pins.length) {
        setPanelStatus(panel, "No pins found", true);
        return;
      }

      // Only stills belong in a PDF; videos have no page representation here.
      // An idea pin keeps its video under `story_pin_data` and may expose no
      // image at all, so both sources have to be checked or the pin slips
      // through and wastes a render attempt.
      pins = pins.filter(function (p) {
        if (util.pickStoryVideoUrl(p)) return false;
        return !util.isVideoUrl(util.pickImageUrl(p) || "");
      });
      if (!pins.length) {
        setPanelStatus(panel, "Every selected pin is a video — use ZIP", true);
        return;
      }

      // Fetch everything first, in parallel batches, then render the pages.
      const media = await collectMedia(pins, function (done, total) {
        setPanelStatus(panel, "Downloading " + done + "/" + total + "…");
      });

      if (isCancelled()) {
        setPanelStatus(panel, "Cancelled — nothing was saved.");
        return;
      }

      const pages = [];
      let skipped = 0;
      for (let i = 0; i < pins.length; i++) {
        if (isCancelled()) break;
        const fetched = media[i];
        if (!fetched) {
          skipped++;
          continue;
        }
        try {
          const converted = await ensureJpeg(fetched.bytes, fetched.ext);
          let width = converted.width;
          let height = converted.height;
          if (!width || !height) {
            const measured = PK.pdf.jpegSize(converted.jpeg);
            if (!measured) {
              skipped++;
              continue;
            }
            width = measured.width;
            height = measured.height;
          }
          pages.push({ jpeg: converted.jpeg, width: width, height: height });
        } catch (_) {
          skipped++;
        }
      }

      if (!pages.length) {
        setPanelStatus(panel, "Could not render any page", true);
        return;
      }

      setPanelStatus(panel, "Building PDF (" + pages.length + " pages)...");
      const doc = PK.pdf.buildPdf(pages);
      const res = await downloadArchive(
        doc,
        "PinSaver/" + boardName + "-" + Date.now() + ".pdf",
        "application/pdf",
      );
      if (!res.ok) throw new Error(res.error || "PDF download failed");
      setPanelStatus(
        panel,
        "Saved PDF with " + pages.length + " pages" +
          (skipped ? ", " + skipped + " skipped" : ""),
      );
    } catch (err) {
      if (isCancelled()) {
        setPanelStatus(panel, "Cancelled.");
      } else {
        setPanelStatus(panel, String(err.message || err), true);
      }
    } finally {
      state.busy = false;
      state.running = false;
      state.cancelRequested = false;
      state.controller = null;
      if (panel && panel.setBusy) panel.setBusy(false);
    }
  }

  // -------------------------------------------------------------------- UI

  const PANEL_ID = "pinsaver-panel";

  /**
   * Create the floating panel.
   *
   * The panel itself is built by `PK.PanelUI`, which draws the horizontal tab
   * bar (Board / Selected / About) across the top. This function only wires
   * the buttons to the actions and keeps a single instance alive.
   */
  function ensurePanel() {
    if (state.panelUi) return state.panelUi;

    const ui = PK.PanelUI.create({
      title: "Pin Saver",
      version: chrome.runtime.getManifest().version,
      onZip: function () {
        downloadBoardZip(false);
      },
      onPdf: function () {
        downloadBoardPdf(false);
      },
      onSelectPins: function () {
        openSelectionDialog();
      },
      onZipSelected: function () {
        downloadBoardZip(true);
      },
      onCancel: function () {
        cancelExport();
      },
      onDownloadPin: function (format) {
        downloadCurrentPin(format);
      },
      onDownloadSection: function (section) {
        downloadSection(section);
      },
      onBackToBoard: function () {
        goBackToBoard();
      },
      onDismiss: function () {
        // Closing the panel must not make it reappear on the next mutation.
        state.panelDismissed = true;
        state.panelUi = null;
      },
    });
    state.panelUi = ui;
    if (ui.element && !ui.element.parentNode) {
      document.body.appendChild(ui.element);
    }

    // Tell the user why an export looks short: Pinterest limits board data for
    // signed-out visitors, and nothing in the UI otherwise explains it.
    if (isGatedPage() && ui.element) {
      const notice = document.createElement("div");
      notice.className = "pinsaver-notice";
      notice.textContent =
        "Sign in to Pinterest for the full board — signed out you get only the first page.";
      ui.element.insertBefore(notice, ui.element.firstChild);
    }

    updateSelectionCount(ui);
    return ui;
  }

  /**
   * Open the manual pin selection dialog.
   *
   * The reference product opens a panel that lists every pin of the board with
   * a checkbox, so any pin can be picked — not only the ones currently
   * rendered on screen. The list comes from the API, which means it also
   * covers the pins further down a long board.
   */
  async function openSelectionDialog() {
    if (state.busy) return;
    const panel = ensurePanel();
    setPanelStatus(panel, "Loading the board's pins…");

    let dialog = null;
    try {
      const pathname = location.pathname.split("?")[0];
      const boardId = await api.fetchBoardId(pathname, signal());
      const pins = await api.fetchAllBoardPins(
        boardId,
        function (count) {
          if (dialog) dialog.setStatus("Loaded " + count + " pins…");
        },
        signal(),
      );

      dialog = PK.SelectionUI.open({
        pins: pins,
        onConfirm: function (chosen) {
          state.selectedPins = chosen;
          state.selected = new Set(
            chosen.map(function (pin) {
              return util.pinIdKey(pin.id);
            }),
          );
          updateSelectionCount(panel);
          markSelectedCards();
          if (panel && panel.setTab) panel.setTab("Selected");
          if (!chosen.length) {
            setPanelStatus(panel, "Nothing selected", true);
            return;
          }
          setPanelStatus(panel, chosen.length + " pin(s) selected — downloading…");
          downloadBoardZip(true);
        },
        onCancel: function () {
          setPanelStatus(panel, "");
        },
      });
    } catch (err) {
      setPanelStatus(panel, String(err.message || err), true);
    }
  }

  /**
   * Mark the cards of the picked pins on the page itself, so the user can see
   * what the dialog selection refers to.
   */
  function markSelectedCards() {
    document.querySelectorAll("[data-pinsaver-picked]").forEach(function (node) {
      node.removeAttribute("data-pinsaver-picked");
    });
    if (!state.selected.size) return;
    document
      .querySelectorAll('[data-test-id="pin"], a[href*="/pin/"]')
      .forEach(function (node) {
        const id = readPinIdFromNode(node);
        if (!id) return;
        if (state.selected.has(util.pinIdKey(id))) {
          node.setAttribute("data-pinsaver-picked", "1");
        }
      });
  }

  /**
   * Download the pin the user is looking at, optionally converted.
   *
   * @param {string} [format] "original", "jpeg" or "png"
   */
  async function downloadCurrentPin(format) {
    const ui = ensurePanel();
    const media = readCloseupMedia();
    if (!media) {
      setPanelStatus(ui, "No media found on this pin", true);
      return;
    }
    setPanelStatus(ui, "Downloading the pin…");
    try {
      const title = (readPinContext().title || "pin").slice(0, 60);
      await downloadSingle(media, title, format);
      setPanelStatus(ui, "Pin saved");
    } catch (err) {
      setPanelStatus(ui, String(err.message || err), true);
    }
  }

  /** Go back to the board the current pin belongs to. */
  function goBackToBoard() {
    if (history.length > 1) {
      history.back();
      return;
    }
    // No history to go back to: the board is the first path segment's page.
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      location.href = "/" + parts[0] + "/";
    }
  }

  /** Update the "Selected" tab's count. */
  function updateSelectionCount(panel) {
    const ui =
      panel && typeof panel.setSelectedCount === "function" ? panel : state.panelUi;
    if (ui) ui.setSelectedCount(state.selected.size);
  }

  /** Show a status line under the panel's content. */
  function setPanelStatus(panel, text, isError) {
    const ui = panel && typeof panel.setStatus === "function" ? panel : state.panelUi;
    if (ui) ui.setStatus(text, isError);
  }

  /** Attach a download affordance to a pin card. */
  function decoratePin(node) {
    if (!node || node.dataset.pinsaverDecorated === "1") return;
    const media = readMediaFromNode(node);
    if (!media) return;
    node.dataset.pinsaverDecorated = "1";
    node.style.position = node.style.position || "relative";

    const btn = document.createElement("button");
    btn.className = "pinsaver-pin-btn";
    btn.type = "button";
    btn.title = MSG.DOWNLOAD;
    setPinButtonIcon(btn, "download");
    btn.addEventListener("click", async function (event) {
      event.preventDefault();
      event.stopPropagation();
      btn.disabled = true;
      btn.textContent = "…";
      try {
        const container = pinContainerFor(node);
        const img = container && container.querySelector("img");
        const title = (img && img.alt) || readBoardName();
        await downloadSingle(media, title);
        setPinButtonIcon(btn, "done");
      } catch (err) {
        setPinButtonIcon(btn, "error");
        btn.title = String(err.message || err);
      }
      setTimeout(function () {
        btn.disabled = false;
        setPinButtonIcon(btn, "download");
      }, 1500);
    });

    node.appendChild(btn);
  }


  /**
   * Scan the page and decorate every pin currently rendered.
   *
   * Pinterest's markup is not a stable API. `[data-test-id="pin"]` is the
   * documented-looking card marker, but it has changed before and it is absent
   * from some surfaces. A `/pin/<id>/` anchor is the more durable signal, so
   * both are used and duplicates are suppressed.
   */
  function scanPins() {
    const handled = new Set();

    function claim(node) {
      if (!node || handled.has(node) || node.dataset.pinsaverDecorated === "1") return;
      handled.add(node);
      decoratePin(node);
    }

    // 1. The card marker, when present.
    document.querySelectorAll('[data-test-id="pin"]').forEach(function (card) {
      claim(card);
      // The pin link may wrap the card or sit inside it; mark both directions
      // so the anchor pass cannot decorate the same pin a second time.
      const outer = card.closest('a[href*="/pin/"]');
      if (outer) handled.add(outer);
      card.querySelectorAll('a[href*="/pin/"]').forEach(function (inner) {
        handled.add(inner);
      });
    });

    // 2. Pin links — present even when the card marker is not.
    document.querySelectorAll('a[href*="/pin/"]').forEach(function (link) {
      if (handled.has(link)) return;
      // Inside an already-decorated card: nothing to do.
      if (link.closest('[data-test-id="pin"]')) {
        handled.add(link);
        return;
      }
      // Only treat it as a pin when it actually wraps pin media.
      if (!link.querySelector('img[src*="pinimg"], video')) return;
      claim(link);
    });

    // 3. Last resort: large pin images that are not avatars.
    //
    // Never run this on a gated page: Pinterest serves a login wall whose
    // placeholders are ordinary images, and decorating them produces download
    // buttons that cannot work.
    if (!handled.size && !isGatedPage()) {
      document.querySelectorAll('img[src*="pinimg"]').forEach(function (img) {
        const src = img.currentSrc || img.src || "";
        if (/\/avatars?\//i.test(src)) return;
        const w = img.naturalWidth || img.width || 0;
        if (w < 150) return;
        const box = img.closest('[data-test-id="pin"]') || img.parentElement;
        if (box) claim(box);
      });
    }

    decorateCloseup();
  }

  // ---------------------------------------------------------- single-pin page

  const CLOSEUP_BTN_ID = "pinsaver-closeup-btn";

  /**
   * True when Pinterest is showing its logged-out / gated wall instead of real
   * content. Detected from markers the page itself ships.
   */
  function isGatedPage() {
    return Boolean(
      document.querySelector(
        '[data-test-id="gated-pin-image"], [data-test-id="gated-pin-rep"], [data-test-id="login-button"]',
      ),
    );
  }

  /** True when the current URL is a single pin page. */
  function isPinPage() {
    return /^\/pin\//.test(location.pathname);
  }

  /**
   * Find the media of the pin shown in a closeup.
   *
   * A pin page has no `[data-test-id="pin"]` card, so the card decorator never
   * runs there. The closeup lives in its own containers instead.
   */
  function readCloseupMedia() {
    const containers = [
      '[data-test-id="closeup-body"]',
      '[data-test-id="closeup-visual-container"]',
      '[data-test-id="closeup-body-image-container"]',
      '[data-test-id="visual-content-container"]',
    ];
    for (const selector of containers) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const media = readMediaFromNode(node);
      if (media) return media;
    }

    // Fallback: the biggest rendered image on the page.
    let best = null;
    let bestArea = 0;
    document.querySelectorAll("img").forEach(function (img) {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      const src = img.currentSrc || img.src;
      if (w * h > bestArea && src) {
        bestArea = w * h;
        best = { url: src, isVideo: false };
      }
    });
    return best;
  }

  /** Title of the open pin, used for the saved file name. */
  function readCloseupTitle() {
    const heading = document.querySelector(
      '[data-test-id="closeup-title"] h1, [data-test-id="closeup-body"] h1, h1',
    );
    const text = heading && heading.textContent ? heading.textContent.trim() : "";
    if (text) return text;
    const img = document.querySelector('[data-test-id="closeup-body"] img');
    return (img && img.alt) || "pin";
  }

  /**
   * Put a download button on the pin closeup. Prefers Pinterest's own action
   * bar so it sits with the other actions; falls back to a floating button so
   * a layout change cannot make the feature disappear entirely.
   */
  function decorateCloseup() {
    if (!isPinPage()) return;
    if (document.getElementById(CLOSEUP_BTN_ID)) return;

    const media = readCloseupMedia();
    if (!media) return;

    const btn = document.createElement("button");
    btn.id = CLOSEUP_BTN_ID;
    btn.type = "button";
    btn.className = "pinsaver-closeup-btn";
    btn.title = MSG.DOWNLOAD;
    btn.textContent = "↓ Download pin";

    btn.addEventListener("click", async function (event) {
      event.preventDefault();
      event.stopPropagation();
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Saving...";
      try {
        await downloadSingle(media, readCloseupTitle());
        btn.textContent = "✓ Saved";
      } catch (err) {
        btn.textContent = "Failed";
        btn.title = String(err.message || err);
      }
      setTimeout(function () {
        btn.disabled = false;
        btn.textContent = original;
      }, 2000);
    });

    const bar =
      document.querySelector('[data-test-id="closeup-action-bar"]') ||
      document.querySelector('[data-test-id="board-actions-container"]');
    if (bar && bar.parentElement) {
      bar.parentElement.insertBefore(btn, bar);
    } else {
      btn.classList.add("pinsaver-closeup-btn--floating");
      document.body.appendChild(btn);
    }
  }

  /** True when the current URL is a board page. */
  function isBoardPage() {
    return util.isBoardPath(location.pathname);
  }

  /**
   * Show, switch or hide the panel to match the page.
   *
   * Pinterest is a single-page app: clicking a pin moves to `/pin/<id>/`
   * without a reload, so the panel that was built for the board stayed on
   * screen and offered "Download board as ZIP" on a single pin. The panel now
   * follows the route — the board view on a board, the pin view on a pin, and
   * nothing at all on a page that is neither.
   */
  function syncPanel() {
    const mode = isBoardPage() ? "board" : isPinPage() ? "pin" : null;

    if (!mode) {
      if (state.panelUi && state.panelUi.hide) state.panelUi.hide();
      state.panelMode = null;
      return;
    }

    if (state.panelDismissed) return;
    if (mode === "board") {
      state.boardName = state.boardName || readBoardName();
      state.lastBoardUrl = location.pathname;
    }

    const ui = ensurePanel();
    if (ui.setMode && state.panelMode !== mode) {
      state.panelMode = mode;
      ui.setMode(mode);
      if (mode === "board") loadSections();
    }
    if (mode === "pin" && ui.setPinInfo) {
      const info = readPinContext();
      const key = info.id + "|" + info.title;
      if (key !== state.lastPinKey) {
        state.lastPinKey = key;
        ui.setPinInfo(info);
      }
    }
    if (ui.show) ui.show();
  }

  /**
   * The board the current pin belongs to, when the page reveals it.
   *
   * A pin URL (`/pin/<id>/`) carries neither the user nor the board, so the
   * board is read from the page — the breadcrumb or the board link — and
   * remembered from the last board the user was on.
   */
  function readBoardLink() {
    const link = document.querySelector(
      'a[href^="/"][href*="/"]:not([href*="/pin/"])',
    );
    if (link) {
      const href = link.getAttribute("href") || "";
      if (/^\/[a-z0-9_-]+\/[a-z0-9_-]+\/?$/i.test(href)) {
        return href;
      }
    }
    return state.lastBoardUrl || "";
  }

  /**
   * Load the board's sections into the panel's "Sections" tab.
   *
   * A board with sections is read section by section, so a user who only wants
   * one part of a board should not have to download all of it.
   */
  async function loadSections() {
    const ui = state.panelUi;
    if (!ui || !ui.setSections || !PK.sections) return;
    try {
      const boardId = await api.fetchBoardId(location.pathname.split("?")[0]);
      const list = await PK.sections.list(boardId);
      if (state.panelUi === ui) ui.setSections(list);
    } catch (_) {
      if (state.panelUi === ui) ui.setSections([]);
    }
  }

  /**
   * Download one section of the board as its own archive.
   *
   * @param {{id: string, name: string}} section
   */
  async function downloadSection(section) {
    if (state.busy || !section) return;
    state.busy = true;
    state.running = true;
    state.cancelRequested = false;
    state.controller = typeof AbortController === "function" ? new AbortController() : null;
    const ui = ensurePanel();
    if (ui.setBusy) ui.setBusy(true);
    if (ui.setTab) ui.setTab("sections");
    setPanelStatus(ui, "Fetching " + (section.name || "section") + "…");

    try {
      const boardId = await api.fetchBoardId(location.pathname.split("?")[0]);
      const pins = await PK.sections.pins(boardId, section, { signal: signal() });
      if (!pins.length) {
        setPanelStatus(ui, "That section has no pins", true);
        return;
      }
      if (isCancelled()) {
        setPanelStatus(ui, "Cancelled — nothing was saved.");
        return;
      }

      const boardName = util.sanitizeName(state.boardName || readBoardName(), 60) || "board";
      const sectionName = util.sanitizeName(section.name || "Section", 50) || "Section";
      const width = String(pins.length).length;
      const media = await collectMedia(pins, function (done, total) {
        setPanelStatus(ui, "Downloading " + done + "/" + total + "…");
      });
      if (isCancelled()) {
        setPanelStatus(ui, "Cancelled — nothing was saved.");
        return;
      }

      const zipper = new PK.Zipper();
      let failed = 0;
      for (let i = 0; i < pins.length; i++) {
        const fetched = media[i];
        if (!fetched) {
          failed++;
          continue;
        }
        const title =
          util.sanitizeName(util.pinTitle(pins[i]), 50) ||
          "pin-" + util.pad(i + 1, width);
        const name = util.pad(i + 1, width) + "-" + title + "." + fetched.ext;
        zipper.add(boardName + "/" + sectionName + "/" + name, fetched.bytes);
      }
      const meta = buildMetadata(pins, pins.map(function () { return sectionName; }));
      zipper.addText(boardName + "/" + sectionName + "/_metadata.csv", meta.csv, true);
      zipper.addText(boardName + "/" + sectionName + "/_metadata.json", meta.json, false);

      setPanelStatus(ui, "Building the section archive…");
      const zipped = zipper.build();
      const res = await downloadArchive(
        zipped,
        "PinSaver/" + boardName + "-" + sectionName + "-" + Date.now() + ".zip",
        "application/zip",
      );
      if (!res.ok) throw new Error(res.error || "ZIP download failed");
      setPanelStatus(
        ui,
        "Saved " + (pins.length - failed) + " pins from " + sectionName +
          (failed ? ", " + failed + " skipped" : ""),
      );
    } catch (err) {
      if (isCancelled()) {
        setPanelStatus(ui, "Cancelled.");
      } else {
        setPanelStatus(ui, String(err.message || err), true);
      }
    } finally {
      state.busy = false;
      state.running = false;
      state.cancelRequested = false;
      state.controller = null;
      if (ui.setBusy) ui.setBusy(false);
    }
  }

  /** What we know about the pin the user is looking at. */
  function readPinContext() {
    const info = { title: "", id: "", url: location.href };
    const match = location.pathname.match(/^\/pin\/(\d+)/);
    if (match) info.id = match[1];
    const heading = document.querySelector("h1");
    if (heading && heading.textContent) info.title = heading.textContent.trim();
    if (!info.title) {
      const img = document.querySelector("img[src*=\"pinimg\"]");
      if (img && img.alt) info.title = img.alt.trim();
    }
    return info;
  }

  // Pinterest is a single-page app: it swaps content without a reload, so a
  // mutation observer is the only reliable way to keep buttons attached.
  function start() {
    // Route API calls through the worker before anything uses the API.
    installApiTransport();
    syncPanel();
    scanPins();

    const observer = new MutationObserver(function (mutations) {
      let shouldScan = false;
      for (const m of mutations) {
        if (!m.addedNodes || !m.addedNodes.length) continue;
        // The panel is our own DOM. Re-scanning because of it would feed the
        // observer its own changes and lock the page in a loop: syncPanel()
        // updates the panel, the panel's change wakes the observer, and the
        // observer calls syncPanel() again.
        let ours = false;
        for (const node of m.addedNodes) {
          if (node && node.id === PANEL_ID) ours = true;
          if (node && node.closest && node.closest("#" + PANEL_ID)) ours = true;
        }
        if (ours) continue;
        shouldScan = true;
        break;
      }
      if (shouldScan) {
        scanPins();
        syncPanel();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    let lastPath = location.pathname;
    setInterval(function () {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        state.boardName = readBoardName();
        state.selected.clear();
        state.panelDismissed = false; // a new page gets a fresh panel
        state.panelMode = null;
        scanPins();
        syncPanel();
      }
    }, 800);
  }

  // The popup cannot touch the page directly, so it pokes us over messaging.
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message && message.action === "downloadBoard") {
      // `format` is additive: "zip" (the default) and "pdf".
      const format = message.format === "pdf" ? "pdf" : "zip";
      if (!isBoardPage()) {
        // A pin page still knows its board, so the board can be exported from
        // there too.
        const boardUrl = readBoardLink();
        if (!boardUrl) {
          sendResponse({ ok: false, error: "Not a board page" });
          return false;
        }
        sendResponse({ ok: true, boardUrl: boardUrl, note: "open the board to export it" });
        return false;
      }
      if (format === "pdf") {
        downloadBoardPdf(false);
      } else {
        downloadBoardZip(false);
      }
      sendResponse({ ok: true, format: format });
      return false;
    }
    if (message && message.action === "downloadPin") {
      if (!isPinPage()) {
        sendResponse({ ok: false, error: "Not a pin page" });
        return false;
      }
      downloadCurrentPin(message.format);
      sendResponse({ ok: true, format: message.format || "original" });
      return false;
    }
    if (message && message.action === "getStatus") {
      const pin = readPinContext();
      sendResponse({
        ok: true,
        isBoard: isBoardPage(),
        isPin: isPinPage(),
        busy: state.busy,
        selected: state.selected.size,
        boardName: state.boardName || readBoardName(),
        boardUrl: isBoardPage() ? location.pathname : readBoardLink(),
        pinId: pin.id,
        pinTitle: pin.title,
      });
      return false;
    }
    return false;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
