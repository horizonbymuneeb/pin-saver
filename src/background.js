/**
 * Background service worker.
 *
 * Its whole job is to be the one place that (a) talks to chrome.downloads and
 * (b) fetches media bytes with the headers a content script is not allowed to
 * set. `Referer` is a forbidden header for page JS, so without this hop the
 * CDN answers 403 for a large share of pins.
 */

const MEDIA_HOSTS = ["i.pinimg.com", "v.pinimg.com", "i1.pinimg.com", "s.pinimg.com"];

/** Referer/Origin that Pinterest's CDN expects for its own media. */
const PINTEREST_ORIGIN = "https://www.pinterest.com/";

/** Message passing is JSON-based, so binary must travel as base64. */
function bytesToBase64(bytes) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function isAllowedMediaUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "data:") return false;
  if (url.protocol === "data:") return true;
  return MEDIA_HOSTS.some(
    (h) => url.hostname === h || url.hostname.endsWith(".pinimg.com"),
  );
}

/**
 * Fetch media with a Pinterest referer so the CDN treats it as an in-site
 * request. Returns the raw bytes.
 *
 * `signal` is optional and is only used to abort an in-flight request.
 */
async function fetchMedia(url, isVideo, signal) {
  const headers = isVideo
    ? {
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        Origin: PINTEREST_ORIGIN.slice(0, -1),
        Referer: PINTEREST_ORIGIN,
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
      }
    : {
        Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: PINTEREST_ORIGIN.slice(0, -1),
        Referer: PINTEREST_ORIGIN,
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      };

  const res = await fetch(url, {
    method: "GET",
    headers: headers,
    credentials: "omit",
    mode: "cors",
    signal: signal,
  });
  if (!res.ok) {
    throw new Error("Media HTTP " + res.status + " for " + url);
  }
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error("Empty media response");
  }

  // Pinterest sometimes answers a blocked request with an HTML/XML error page
  // and HTTP 200. Reject that by content type rather than by size: a size gate
  // also throws away genuinely small images, which do exist.
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (/^text\//.test(type) || /xml|html/.test(type)) {
    throw new Error("Unexpected media content type: " + type);
  }
  return new Uint8Array(buffer);
}

/**
 * Fetch media with bounded retries.
 *
 * A board of several hundred pins makes a one-shot fetch fragile: a single
 * transient CDN error silently drops that pin from the archive. The reference
 * implementation retried, and so does this one, with a short exponential
 * backoff. HTTP 404 is not retried because it will not become available.
 */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

/**
 * Wait for `ms`, but wake up early if the request is cancelled.
 *
 * `signal` is optional, so a plain `sleep(ms)` still works. When a signal is
 * given and it aborts, the wait rejects with an AbortError instead of
 * running out the rest of the backoff.
 */
function sleep(ms, signal) {
  return new Promise(function (resolve, reject) {
    if (signal && signal.aborted) {
      reject(makeAbortError());
      return;
    }
    const onAbort = function () {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    const timer = setTimeout(function () {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** An error shaped like the DOMException a real `AbortController` produces. */
function makeAbortError() {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/** True when an error is an abort (as opposed to a genuine fetch failure). */
function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  // DOMException exposes ABORT_ERR as the legacy numeric code 20.
  return err.code === 20 || err.code === "ABORT_ERR";
}

async function fetchMediaWithRetry(url, isVideo, signal) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    // A cancelled request is never started and never retried.
    if (signal && signal.aborted) throw makeAbortError();
    try {
      return await fetchMedia(url, isVideo, signal);
    } catch (err) {
      lastError = err;
      const message = String(err && err.message ? err.message : err);
      const permanent = /HTTP 404|Refusing non-Pinterest/.test(message);
      // An abort is the user asking to stop: retrying it would be wrong.
      if (
        permanent ||
        isAbortError(err) ||
        (signal && signal.aborted) ||
        attempt === RETRY_ATTEMPTS
      ) {
        break;
      }
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1), signal);
    }
  }
  throw lastError;
}

/**
 * The file extension a media URL implies.
 *
 * Mirrors `util.extensionFor` in the content-script bundle; the worker cannot
 * import that file, so the rule is duplicated here on purpose.
 */
function mediaExtensionFor(url, isVideo) {
  if (isVideo) return "mp4";
  const m = String(url || "").match(
    /\.(jpe?g|png|gif|webp|avif|mp4|mov|webm)(\?|$)/i,
  );
  if (!m) return "jpg";
  const ext = m[1].toLowerCase();
  if (ext === "jpeg") return "jpg";
  return ext;
}

// ---------------------------------------------------------------------------
// Batched media fetching
//
// The "Slow Archiving" bug was a shape problem, not a network problem: the
// content script asked the worker for one pin at a time and waited for the
// bytes before starting the next one, so a 500-pin board cost 500 strictly
// serial round trips.
//
// `fetchMediaBatch` answers several pins per message and runs them
// concurrently inside the worker, with a bounded number of requests in flight
// so a big board cannot flood the CDN (and so no single reply carries
// hundreds of megabytes of base64).
// ---------------------------------------------------------------------------

/** How many media requests may be in flight at the same time. */
const BATCH_CONCURRENCY = 8;

/**
 * The largest batch a single message may carry.
 *
 * A caller should aim for `BATCH_CONCURRENCY` items per message, which maps
 * one-to-one onto the concurrency window. The hard limit exists so a caller
 * cannot accidentally ask for a whole 500-pin board in one reply and blow up
 * the message size.
 */
const MAX_BATCH_ITEMS = 32;

/** Every media request that is currently in flight, so it can be aborted. */
const inFlightControllers = new Set();


/**
 * Cancellation generation.
 *
 * `cancelFetch` bumps this counter, so a batch that was already running can
 * tell that it must not start any further requests, even the ones still
 * queued behind the concurrency window.
 */
let cancelEpoch = 0;

function registerInFlight(controller) {
  inFlightControllers.add(controller);
}

function unregisterInFlight(controller) {
  inFlightControllers.delete(controller);
}

/**
 * Abort every in-flight media request.
 *
 * Returns how many requests were aborted. Aborted items surface as a
 * per-item `{ ok: false, error: "cancelled" }` rather than as a hung promise.
 */
function cancelInFlightFetches() {
  cancelEpoch += 1;
  let count = 0;
  inFlightControllers.forEach(function (controller) {
    if (controller.signal.aborted) return;
    try {
      controller.abort();
      count += 1;
    } catch (_) {
      // A controller that refuses to abort is simply left alone.
    }
  });
  return count;
}

/**
 * Fetch one item of a batch.
 *
 * Never rejects: a failing item becomes `{ ok: false, error }` in place, so a
 * single broken pin can never abort a whole board.
 */
async function fetchBatchItem(item, epoch) {
  const url = item && typeof item.url === "string" ? item.url : "";
  const isVideo = !!(item && item.isVideo);

  if (!isAllowedMediaUrl(url)) {
    return { ok: false, error: "Refusing non-Pinterest media URL" };
  }

  const key = url;
  if (blobCache.has(key)) {
    const cached = blobCache.get(key);
    return {
      ok: true,
      data: bytesToBase64(cached),
      size: cached.byteLength,
      ext: mediaExtensionFor(url, isVideo),
    };
  }

  const controller = new AbortController();
  registerInFlight(controller);
  try {
    // The batch was cancelled before this item got its turn: do not start it.
    if (epoch !== cancelEpoch || controller.signal.aborted) {
      return { ok: false, error: "cancelled" };
    }
    const bytes = await fetchMediaWithRetry(url, isVideo, controller.signal);
    if (bytes.byteLength < 4 * 1024 * 1024) cachePut(key, bytes);
    return {
      ok: true,
      data: bytesToBase64(bytes),
      size: bytes.byteLength,
      ext: mediaExtensionFor(url, isVideo),
    };
  } catch (err) {
    if (controller.signal.aborted || isAbortError(err)) {
      return { ok: false, error: "cancelled" };
    }
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    unregisterInFlight(controller);
  }
}

/**
 * Run a batch with a bounded number of workers.
 *
 * The returned array has the same length and the same order as `items`, no
 * matter in which order the individual requests finish.
 */
async function runBatch(items, epoch) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fetchBatchItem(items[index], epoch);
    }
  }

  const workers = [];
  const count = Math.min(BATCH_CONCURRENCY, items.length);
  for (let i = 0; i < count; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/** Start a download from an already-built data URL. */
function downloadDataUrl(dataUrl, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url: dataUrl, filename: filename, saveAs: false, conflictAction: "uniquify" },
      (downloadId) => {
        const err = chrome.runtime.lastError;
        // The content script checks `ok`; replying with `success` here made a
        // successful download look like a failure in the panel.
        if (err) resolve({ ok: false, error: err.message });
        else resolve({ ok: true, downloadId: downloadId });
      },
    );
  });
}

/** A tiny TTL cache so repeated hovers do not re-hit the CDN. */
const blobCache = new Map();
const BLOB_CACHE_LIMIT = 24;

function cachePut(key, value) {
  if (blobCache.size >= BLOB_CACHE_LIMIT) {
    const oldest = blobCache.keys().next().value;
    blobCache.delete(oldest);
  }
  blobCache.set(key, value);
}

/**
 * Only Pinterest's own API may be fetched on behalf of a page.
 */
function isAllowedApiUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host !== "pinterest.com" && !host.endsWith(".pinterest.com")) return false;
    return u.pathname.indexOf("/resource/") === 0;
  } catch (_) {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message && message.action;

  if (action === "ping") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  if (action === "apiGet") {
    const url = message.url;
    if (!isAllowedApiUrl(url)) {
      sendResponse({ ok: false, error: "Refusing non-Pinterest API URL" });
      return false;
    }
    // The worker holds host permissions, so this request is not subject to
    // CORS and works from any Pinterest host the user is browsing.
    fetch(url, {
      method: "GET",
      headers: message.headers || {},
      credentials: "include",
    })
      .then(async (res) => {
        const text = await res.text();
        sendResponse({ ok: res.ok, status: res.status, text: text });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      });
    return true;
  }

  if (action === "fetchMedia") {
    const url = message.url;
    if (!isAllowedMediaUrl(url)) {
      sendResponse({ ok: false, error: "Refusing non-Pinterest media URL" });
      return false;
    }
    const key = url;
    if (blobCache.has(key)) {
      sendResponse({ ok: true, data: bytesToBase64(blobCache.get(key)), cached: true });
      return false;
    }
    // Registered so `cancelFetch` can abort this request too.
    const controller = new AbortController();
    registerInFlight(controller);
    fetchMediaWithRetry(url, !!message.isVideo, controller.signal)
      .then((bytes) => {
        if (bytes.byteLength < 4 * 1024 * 1024) cachePut(key, bytes);
        sendResponse({ ok: true, data: bytesToBase64(bytes), size: bytes.byteLength });
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbortError(err)) {
          sendResponse({ ok: false, error: "cancelled" });
          return;
        }
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      })
      .finally(() => {
        unregisterInFlight(controller);
      });
    return true; // async response
  }

  if (action === "fetchMediaBatch") {
    const items = message.items;
    if (!Array.isArray(items)) {
      sendResponse({ ok: false, error: "fetchMediaBatch requires an items array" });
      return false;
    }
    if (items.length > MAX_BATCH_ITEMS) {
      sendResponse({
        ok: false,
        error:
          "Batch too large: " +
          items.length +
          " items (max " +
          MAX_BATCH_ITEMS +
          " per message, " +
          BATCH_CONCURRENCY +
          " recommended)",
      });
      return false;
    }
    const epoch = cancelEpoch;
    runBatch(items, epoch)
      .then((results) => {
        // `results` is the same length and in the same order as `items`.
        sendResponse({ ok: true, results: results });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    return true; // async response
  }

  if (action === "cancelFetch") {
    const aborted = cancelInFlightFetches();
    sendResponse({ ok: true, aborted: aborted });
    return false;
  }

  if (action === "fetchText") {
    const url = message.url;
    if (!isAllowedMediaUrl(url)) {
      sendResponse({ ok: false, error: "Refusing non-Pinterest URL" });
      return false;
    }
    fetch(url, {
      method: "GET",
      headers: { Referer: PINTEREST_ORIGIN, Origin: PINTEREST_ORIGIN.slice(0, -1) },
      credentials: "omit",
    })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then((text) => sendResponse({ ok: true, text: text }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (action === "downloadArchive") {
    // The finished archive is handed over as a blob URL.
    //
    // It used to travel as base64 inside a message, which has two hard
    // limits: a message may not exceed 64 MiB, and building the base64 of a
    // large archive in JavaScript runs into V8's maximum string length
    // ("Invalid string length"). A blob URL is a short string and the browser
    // streams the bytes to disk, so neither limit applies.
    const url = message.url;
    if (typeof url !== "string" || !/^blob:/.test(url)) {
      sendResponse({ ok: false, error: "Refusing non-blob archive URL" });
      return false;
    }
    chrome.downloads.download(
      { url: url, filename: message.filename, saveAs: false, conflictAction: "uniquify" },
      (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) sendResponse({ ok: false, error: err.message });
        else sendResponse({ ok: true, downloadId: downloadId });
      },
    );
    return true;
  }

  if (action === "downloadUrl") {
    const url = message.url;
    if (!isAllowedMediaUrl(url)) {
      sendResponse({ ok: false, error: "Refusing non-Pinterest URL" });
      return false;
    }
    chrome.downloads.download(
      { url: url, filename: message.filename, saveAs: false, conflictAction: "uniquify" },
      (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) sendResponse({ ok: false, error: err.message });
        else sendResponse({ ok: true, downloadId: downloadId });
      },
    );
    return true;
  }

  if (action === "downloadBytes") {
    const data = message.data;
    const mime = message.mime || "application/octet-stream";
    if (typeof data !== "string" || !data) {
      sendResponse({ ok: false, error: "No data to download" });
      return false;
    }
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length === 0) {
      sendResponse({ ok: false, error: "Empty payload" });
      return false;
    }
    const blob = new Blob([bytes], { type: mime });
    const reader = new FileReader();
    reader.onloadend = () => {
      downloadDataUrl(reader.result, message.filename).then(sendResponse);
    };
    reader.onerror = () => sendResponse({ ok: false, error: "Blob read failed" });
    reader.readAsDataURL(blob);
    return true;
  }

  if (action === "setBadge") {
    chrome.action.setBadgeText({ text: message.text || "" });
    if (message.color) chrome.action.setBadgeBackgroundColor({ color: message.color });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

/** Clear cached bytes when the user navigates, to bound memory. */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") blobCache.clear();
});
