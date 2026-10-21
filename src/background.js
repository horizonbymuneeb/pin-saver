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
 */
async function fetchMedia(url, isVideo) {
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

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function fetchMediaWithRetry(url, isVideo) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetchMedia(url, isVideo);
    } catch (err) {
      lastError = err;
      const message = String(err && err.message ? err.message : err);
      const permanent = /HTTP 404|Refusing non-Pinterest/.test(message);
      if (permanent || attempt === RETRY_ATTEMPTS) break;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
    }
  }
  throw lastError;
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
    fetchMediaWithRetry(url, !!message.isVideo)
      .then((bytes) => {
        if (bytes.byteLength < 4 * 1024 * 1024) cachePut(key, bytes);
        sendResponse({ ok: true, data: bytesToBase64(bytes), size: bytes.byteLength });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    return true; // async response
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
