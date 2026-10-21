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
    selected: new Set(),
    selecting: false,
    busy: false,
    boardName: "",
  };

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
  async function downloadSingle(media, title) {
    let url = media.isVideo
      ? media.url
      : util.toOriginalUrl(util.preferFallback(media.url, media.fallbackUrl));

    // An HLS playlist is not a video file; resolve it before saving.
    if (media.isVideo && /\.m3u8(\?|$)/i.test(url)) {
      const resolved = await resolveVideoToMp4(url);
      url = resolved.url;
    }

    const ext = util.extensionFor(url, media.isVideo);
    const safeTitle = util.sanitizeName(title || "", 40) || "pin";
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

  async function fetchPinBytes(pin) {
    const media = await pickMediaUrl(pin);
    if (!media) return null;

    const res = await sendBackground({
      action: "fetchMedia",
      url: media.url,
      isVideo: media.isVideo,
    });
    if (!res.ok) return null;
    return {
      bytes: util.base64ToBytes(res.data),
      ext: media.ext,
      isVideo: media.isVideo,
      url: media.url,
    };
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
    const panel = ensurePanel();
    setPanelStatus(panel, "Reading board info...");

    try {
      const pathname = location.pathname.split("?")[0];
      const boardId = await api.fetchBoardId(pathname);
      const boardName =
        util.sanitizeName(state.boardName || readBoardName(), 60) || "board";

      setPanelStatus(panel, "Fetching pin list...");
      const allPins = await api.fetchAllBoardPins(boardId, function (count, page) {
        setPanelStatus(panel, "Fetched " + count + " pins (page " + page + ")");
      });

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
      let done = 0;
      let failed = 0;
      const width = String(pins.length).length;

      for (let i = 0; i < pins.length; i++) {
        const pin = pins[i];
        const folder = sectionFolder(pin, "");
        sections.push(folder);

        // One un-downloadable pin (a video whose playlist cannot be resolved,
        // for instance) must be skipped and counted, never abort the archive.
        let fetched = null;
        try {
          fetched = await fetchPinBytes(pin);
        } catch (_) {
          fetched = null;
        }
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

        done++;
        if (done % 5 === 0 || done === pins.length) {
          setPanelStatus(
            panel,
            "Archiving " + done + "/" + pins.length +
              (failed ? " (" + failed + " failed)" : ""),
          );
        }
      }

      const meta = buildMetadata(pins, sections);
      zipper.addText(boardName + "/_metadata.csv", meta.csv, true);
      zipper.addText(boardName + "/_metadata.json", meta.json, false);

      setPanelStatus(panel, "Building ZIP...");
      const zipped = zipper.build();
      const res = await sendBackground({
        action: "downloadBytes",
        data: util.bytesToBase64(zipped),
        mime: "application/zip",
        filename: "PinSaver/" + boardName + "-" + Date.now() + ".zip",
      });
      if (!res.ok) throw new Error(res.error || "ZIP download failed");
      setPanelStatus(
        panel,
        "Saved " + pins.length + " pins" + (failed ? ", " + failed + " skipped" : ""),
      );
    } catch (err) {
      setPanelStatus(panel, String(err.message || err), true);
    } finally {
      state.busy = false;
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

      const pages = [];
      let skipped = 0;
      for (let i = 0; i < pins.length; i++) {
        setPanelStatus(panel, "Rendering page " + (i + 1) + "/" + pins.length);
        let fetched = null;
        try {
          fetched = await fetchPinBytes(pins[i]);
        } catch (_) {
          fetched = null;
        }
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
      const res = await sendBackground({
        action: "downloadBytes",
        data: util.bytesToBase64(doc),
        mime: "application/pdf",
        filename: "PinSaver/" + boardName + "-" + Date.now() + ".pdf",
      });
      if (!res.ok) throw new Error(res.error || "PDF download failed");
      setPanelStatus(
        panel,
        "Saved PDF with " + pages.length + " pages" +
          (skipped ? ", " + skipped + " skipped" : ""),
      );
    } catch (err) {
      setPanelStatus(panel, String(err.message || err), true);
    } finally {
      state.busy = false;
    }
  }

  // -------------------------------------------------------------------- UI

  const PANEL_ID = "pinsaver-panel";

  /**
   * Clear every visual trace of a selection.
   *
   * Cancelling used to drop `state.selected` and the outline while leaving the
   * per-pin ticks in place, so pins still looked selected but the archive came
   * out empty.
   */
  function resetSelectionVisuals() {
    document.querySelectorAll("[data-pinsaver-picked]").forEach(function (node) {
      node.removeAttribute("data-pinsaver-picked");
    });
    document.querySelectorAll(".pinsaver-pin-btn").forEach(function (btn) {
      // Leave a button alone while it is mid-download.
      if (!btn.disabled) setPinButtonIcon(btn, "download");
    });
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "pinsaver-panel";

    const title = document.createElement("div");
    title.className = "pinsaver-panel__title";
    title.textContent = "Pin Saver";
    panel.appendChild(title);

    // Tell the user why an export looks short: Pinterest limits board data for
    // signed-out visitors, and nothing in the UI otherwise explains it.
    if (isGatedPage()) {
      const notice = document.createElement("div");
      notice.className = "pinsaver-notice";
      notice.textContent =
        "Sign in to Pinterest for the full board — signed out you get only the first page.";
      panel.appendChild(notice);
    }

    const zipBtn = document.createElement("button");
    zipBtn.className = "pinsaver-btn";
    zipBtn.textContent = MSG.BOARD_ZIP;
    zipBtn.addEventListener("click", function () {
      downloadBoardZip(false);
    });
    panel.appendChild(zipBtn);

    const pdfBtn = document.createElement("button");
    pdfBtn.className = "pinsaver-btn pinsaver-btn--ghost";
    pdfBtn.textContent = MSG.BOARD_PDF;
    pdfBtn.addEventListener("click", function () {
      downloadBoardPdf(false);
    });
    panel.appendChild(pdfBtn);

    const selBtn = document.createElement("button");
    selBtn.className = "pinsaver-btn pinsaver-btn--ghost";
    selBtn.textContent = MSG.SELECT;
    selBtn.addEventListener("click", function () {
      state.selecting = !state.selecting;
      state.selected.clear();
      selBtn.textContent = state.selecting ? "Cancel selection" : MSG.SELECT;
      const selZip = panel.querySelector(".pinsaver-btn--selected-zip");
      if (selZip) selZip.disabled = !state.selecting;
      resetSelectionVisuals();
      if (!state.selecting) {
        // Drop any status left over from a previous run so the panel is clean.
        const status = panel.querySelector(".pinsaver-status");
        if (status) {
          delete status.dataset.sticky;
          status.classList.remove("pinsaver-status--error");
        }
      }
      updateSelectionCount(panel);
    });
    panel.appendChild(selBtn);

    const selZipBtn = document.createElement("button");
    // Secondary action: only the board export is the primary (red) one.
    selZipBtn.className = "pinsaver-btn pinsaver-btn--ghost pinsaver-btn--selected-zip";
    // It only makes sense while selecting, so it stays disabled until then.
    selZipBtn.disabled = !state.selecting;
    selZipBtn.textContent = "ZIP selected";
    selZipBtn.addEventListener("click", function () {
      if (!state.selected.size) {
        setPanelStatus(panel, "Nothing selected yet", true);
        return;
      }
      downloadBoardZip(true);
    });
    panel.appendChild(selZipBtn);

    const status = document.createElement("div");
    status.className = "pinsaver-status";
    panel.appendChild(status);

    document.body.appendChild(panel);
    return panel;
  }

  function updateSelectionCount(panel) {
    const node = panel && panel.querySelector(".pinsaver-status");
    if (!node) return;
    if (state.selecting) {
      node.textContent = state.selected.size + " pin(s) selected";
    } else if (!node.dataset.sticky) {
      node.textContent = "";
    }
  }

  function setPanelStatus(panel, text, isError) {
    const node = panel && panel.querySelector(".pinsaver-status");
    if (!node) return;
    node.textContent = text;
    node.dataset.sticky = "1";
    node.classList.toggle("pinsaver-status--error", !!isError);
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
      if (state.selecting) {
        togglePinSelection(node, media, btn);
        return;
      }
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

  function togglePinSelection(node, media, btn) {
    const container = pinContainerFor(node) || node;

    // Prefer the real pin id so the API result can be matched back. When the
    // page does not expose it, key on the canonical media URL instead — never
    // on a timestamp, which could never match an API pin.
    const pinId = readPinIdFromNode(container) || readPinIdFromNode(node);
    const key = pinId
      ? util.pinIdKey(pinId)
      : util.mediaKey(media && media.url);
    if (!key) {
      btn.title = "Cannot identify this pin";
      return;
    }

    if (state.selected.has(key)) {
      state.selected.delete(key);
      node.removeAttribute("data-pinsaver-picked");
      setPinButtonIcon(btn, "download");
    } else {
      state.selected.add(key);
      node.setAttribute("data-pinsaver-picked", "1");
      setPinButtonIcon(btn, "done");
    }
    const panel = document.getElementById(PANEL_ID);
    updateSelectionCount(panel);
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

  function syncPanel() {
    if (isBoardPage()) {
      state.boardName = state.boardName || readBoardName();
      ensurePanel();
    }
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
        if (m.addedNodes && m.addedNodes.length) {
          shouldScan = true;
          break;
        }
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
        scanPins();
        syncPanel();
      }
    }, 800);
  }

  // The popup cannot touch the page directly, so it pokes us over messaging.
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message && message.action === "downloadBoard") {
      if (!isBoardPage()) {
        sendResponse({ ok: false, error: "Not a board page" });
        return false;
      }
      downloadBoardZip(false);
      sendResponse({ ok: true });
      return false;
    }
    if (message && message.action === "getStatus") {
      sendResponse({
        ok: true,
        isBoard: isBoardPage(),
        busy: state.busy,
        selected: state.selected.size,
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
