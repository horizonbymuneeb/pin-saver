/**
 * Pinterest internal "resource" API client.
 *
 * Pinterest's own React front-end talks to `/resource/<Name>/get/` with a
 * JSON `data` query parameter. The same endpoints are what this extension
 * uses, so a board can be read completely without scrolling the page and
 * without depending on fragile DOM structure.
 *
 * The request must carry Pinterest's own browser headers, otherwise the API
 * answers 400/403. `x-app-version` in particular is checked server-side.
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});
  const util = PK.util;

  const ORIGIN = "https://www.pinterest.com";

  /**
   * Pluggable transport for API requests.
   *
   * A content script fetching `https://www.pinterest.com/...` from a page on
   * another Pinterest host is a cross-origin request: the browser sends a CORS
   * preflight, Pinterest answers it with 400 and no `Access-Control-Allow-Origin`,
   * and the fetch fails with the bare message "Failed to fetch". The same
   * happens on the bare apex `pinterest.com`, whose API redirects to `www`.
   *
   * The background worker has host permissions, so it performs the request
   * with no CORS involved, from any Pinterest host. The content script
   * installs that transport; unit tests keep using a direct fetch.
   */
  let transport = null;

  /** Install the transport used for API requests. */
  function setTransport(fn) {
    transport = typeof fn === "function" ? fn : null;
  }

  /**
   * Direct fetch, used when no transport is installed (unit tests, Node).
   * Resolves with the parsed response body.
   */
  async function directTransport(url, headers, signal) {
    const res = await fetch(url, {
      method: "GET",
      headers: headers,
      credentials: "include",
      mode: "cors",
      signal: signal,
    });
    if (!res.ok) {
      const err = new Error("Pinterest API HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /**
   * Pins requested per feed page.
   *
   * Measured against production: `page_size: 50` is silently capped to 25
   * results for an anonymous visitor, while `page_size: 250` returns the
   * whole small board in one response. 250 is the largest value we observed
   * being honoured, so it minimises round trips; the bookmark loop still
   * handles boards bigger than that.
   */
  const PAGE_SIZE = 250;

  /**
   * Page size for section pin requests.
   *
   * Measured against production: `BoardSectionPinsResource` answers HTTP 400
   * "Invalid parameters" for `page_size: 250`, while 50 works. The board feed
   * and the section feed do not share the same limit, so they do not share the
   * same constant.
   */
  const SECTION_PAGE_SIZE = 50;

  /** 16 lowercase hex characters, matching the trace ids Pinterest emits. */
  function traceId() {
    let out = "";
    for (let i = 0; i < 16; i++) {
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
  }

  /**
   * The app version is published in a meta tag on most builds. Older builds
   * embed it in a script; as a last resort a hard-coded recent version is
   * used, which Pinterest accepts for read-only resource calls.
   */
  const FALLBACK_APP_VERSION = "b1f2c3d4e";

  function appVersion(doc) {
    const d = doc || document;
    const meta = d.querySelector('meta[name="pinterest-app-version"]');
    if (meta) {
      const content = meta.getAttribute("content");
      if (content) return content;
    }
    const scripts = Array.from(d.querySelectorAll("script"));
    for (const s of scripts) {
      const text = s.textContent || "";
      const m = text.match(/"appVersion"\s*:\s*"([0-9a-f]{7,})"/);
      if (m) return m[1];
    }
    for (const link of Array.from(d.querySelectorAll("link[href*='webapp']"))) {
      const m = (link.getAttribute("href") || "").match(/\/([a-f0-9]{7,})\//);
      if (m) return m[1];
    }
    return FALLBACK_APP_VERSION;
  }

  /**
   * Required headers. `sourceUrl` must be the path the site believes it is
   * on, e.g. `/username/board-slug/`.
   */
  function buildHeaders(sourceUrl, doc) {
    const parentSpan = traceId();
    return {
      accept: "application/json, text/javascript, */*, q=0.01",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
      "x-app-version": appVersion(doc),
      "x-b3-flags": "0",
      "x-b3-parentspanid": parentSpan,
      "x-b3-spanid": traceId(),
      "x-b3-traceid": parentSpan,
      "x-pinterest-appstate": "active",
      "x-pinterest-pws-handler": "www/[username]/[slug].js",
      "x-pinterest-source-url": sourceUrl,
      "x-requested-with": "XMLHttpRequest",
    };
  }

  /** Build `/resource/<name>/get/` with encoded options + cache buster. */
  function resourceUrl(base, resource, sourceUrl, options) {
    const data = encodeURIComponent(
      JSON.stringify({ options: options, context: {} }),
    );
    return (
      base +
      "/resource/" +
      resource +
      "/get/?source_url=" +
      encodeURIComponent(sourceUrl) +
      "&data=" +
      data +
      "&_=" +
      Date.now()
    );
  }

  /** One resource call. Throws on HTTP errors and in-body API errors. */
  /**
   * Retry policy for resource calls.
   *
   * One transient 5xx or 429 on a single page would otherwise abort an entire
   * board download. Network errors and 5xx/429 are retried; a 4xx or an
   * in-body API error is not, because it will not change on a retry.
   */
  const API_RETRY_ATTEMPTS = 3;
  const API_RETRY_BASE_MS = 300;

  function retryDelay(attempt) {
    return new Promise(function (resolve) {
      setTimeout(resolve, API_RETRY_BASE_MS * Math.pow(2, attempt - 1));
    });
  }

  async function callResource(resource, sourceUrl, options, opts) {
    const settings = opts || {};
    const base = settings.origin || ORIGIN;
    const url = resourceUrl(base, resource, sourceUrl, options);

    let lastError = null;
    for (let attempt = 1; attempt <= API_RETRY_ATTEMPTS; attempt++) {
      try {
        const send = transport || directTransport;
        const body = await send(url, buildHeaders(sourceUrl), settings.signal);
        const rr = body && body.resource_response;
        if (rr && rr.error) {
          const err = new Error(
            "Pinterest API error: " + (rr.error.message || "unknown") +
              (rr.error.code ? " [" + rr.error.code + "]" : ""),
          );
          // An in-body error is a definitive answer, not a transport failure.
          err.retryable = false;
          throw err;
        }
        return body;
      } catch (err) {
        lastError = err;
        const status = err && err.status;
        const retryable =
          err && err.retryable !== false &&
          (status === undefined || status >= 500 || status === 429);
        if (!retryable || attempt === API_RETRY_ATTEMPTS) break;
        await retryDelay(attempt);
      }
    }
    throw lastError;
  }

  /** Split `/username/board-slug/` into its two parts (decoded). */
  function parseBoardPath(pathname) {
    const parts = String(pathname || "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return null;
    const username = parts[0];
    const slug = parts[1];
    // Board URLs may arrive percent-encoded (non-ASCII board names).
    let decoded = slug;
    try {
      decoded = decodeURIComponent(slug);
    } catch (_) {
      decoded = slug;
    }
    return { username: username, slug: slug, decodedSlug: decoded };
  }

  /**
   * Resolve a numeric board id. The feed endpoints want `board_id`, but the
   * page URL only has username + slug, so one BoardResource lookup is needed.
   */
  async function fetchBoardId(pathname, signal) {
    const parsed = parseBoardPath(pathname);
    if (!parsed) {
      throw new Error("Not a board page URL: " + pathname);
    }
    const candidates = Array.from(
      new Set([parsed.slug, parsed.decodedSlug]),
    );
    let lastError = null;
    for (const slug of candidates) {
      const sourceUrl = "/" + parsed.username + "/" + slug + "/";
      try {
        const body = await callResource(
          "BoardResource",
          sourceUrl,
          { username: parsed.username, slug: slug, field_set_key: "detailed" },
          { signal: signal },
        );
        const data = body.resource_response && body.resource_response.data;
        if (data && data.id != null) return String(data.id);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error("Could not resolve board id");
  }

  /** Read one page of board pins. Returns { pins, bookmark }. */
  async function fetchBoardPinPage(boardId, bookmark, signal) {
    const pathname = location.pathname.split("?")[0];
    const boardUrl = pathname.endsWith("/") ? pathname : pathname + "/";
    const options = {
      board_id: boardId,
      board_url: boardUrl,
      currentFilter: -1,
      field_set_key: "react_grid_pin",
      filter_section_pins: false,
      sort: "default",
      layout: "default",
      page_size: PAGE_SIZE,
      redux_normalize_feed: true,
    };
    if (bookmark) options.bookmarks = [bookmark];

    const body = await callResource("BoardFeedResource", boardUrl, options, {
      signal: signal,
    });
    const rr = body.resource_response;
    const pins = normalizeFeed(rr && rr.data);
    let next = rr && rr.bookmark;
    if (next == null && rr && rr.data && typeof rr.data === "object") {
      next = rr.data.bookmark;
    }
    return {
      pins: pins,
      bookmark: next && next !== "-end-" ? String(next) : null,
    };
  }

  /**
   * The feed may be a plain array or a normalized object keyed by id.
   * Flatten either shape into an array of pin objects.
   */
  function normalizeFeed(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data.filter(isPinLike);
    if (typeof data === "object") {
      const values = Object.values(data);
      const pins = values.filter(isPinLike);
      if (pins.length) return pins;
      if (data.data) return normalizeFeed(data.data);
    }
    return [];
  }

  function isPinLike(value) {
    if (!value || typeof value !== "object") return false;
    if (value.id == null) return false;
    return Boolean(
      value.images || value.image_large_url || value.story_pin_data || value.videos,
    );
  }

  /**
   * Walk every page of a board until Pinterest reports the end.
   * `onProgress` is called after each page so the UI can update.
   */
  /** Normalise a feed that may be an array or an id-keyed object. */
  function feedList(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (typeof data === "object") return Object.values(data);
    return [];
  }

  /** Current board URL with a trailing slash, based on the page path. */
  function boardUrlFromLocation() {
    const pathname = location.pathname.split("?")[0];
    return pathname.endsWith("/") ? pathname : pathname + "/";
  }

  /**
   * List a board's sections.
   *
   * This endpoint answers `data: []` with `status: "success"` for a board with
   * no sections, so an empty result is a normal outcome, not an error.
   */
  async function fetchBoardSections(boardId, signal) {
    const boardUrl = boardUrlFromLocation();
    const sections = [];
    let bookmark = null;
    for (;;) {
      const options = { board_id: boardId, redux_normalize_feed: true, page_size: 250 };
      if (bookmark) options.bookmarks = [bookmark];
      const body = await callResource("BoardSectionsResource", boardUrl, options, {
        signal: signal,
      });
      const rr = body.resource_response;
      for (const section of feedList(rr && rr.data)) {
        if (section && section.id != null) sections.push(section);
      }
      const next = rr && rr.bookmark;
      if (!next || next === "-end-") break;
      bookmark = String(next);
    }
    return sections;
  }

  /** One page of pins inside a specific section. */
  async function fetchSectionPinPage(boardId, section, bookmark, signal) {
    const boardUrl = boardUrlFromLocation();
    const slug = section.slug || String(section.id);
    const sourceUrl = boardUrl + slug + "/";
    const options = {
      board_id: boardId,
      section_id: section.id,
      currentFilter: -1,
      field_set_key: "react_grid_pin",
      is_own_profile_pins: true,
      page_size: SECTION_PAGE_SIZE,
      redux_normalize_feed: true,
    };
    if (bookmark) options.bookmarks = [bookmark];

    const body = await callResource("BoardSectionPinsResource", sourceUrl, options, {
      signal: signal,
    });
    const rr = body.resource_response;
    const pins = normalizeFeed(rr && rr.data);
    let next = rr && rr.bookmark;
    if (next == null && rr && rr.data && typeof rr.data === "object") {
      next = rr.data.bookmark;
    }
    return { pins: pins, bookmark: next && next !== "-end-" ? String(next) : null };
  }

  /** Every pin of one section, with `sectionPath` attached for folder naming. */
  async function fetchSectionPins(boardId, section, signal) {
    const out = [];
    const seen = new Set();
    let bookmark = null;
    for (;;) {
      const res = await fetchSectionPinPage(boardId, section, bookmark, signal);
      for (const pin of res.pins) {
        const key = String(pin.id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(withSection(pin, section));
      }
      if (!res.bookmark) break;
      bookmark = res.bookmark;
      await new Promise(function (r) {
        setTimeout(r, 120);
      });
    }
    return out;
  }

  /**
   * Attach the section path used to build folders inside the archive.
   * A shallow copy keeps the API payload untouched.
   */
  function withSection(pin, section) {
    const title = (section && (section.name || section.title)) || "section";
    const copy = Object.assign({}, pin);
    copy.sectionPath = [String(title)];
    return copy;
  }

  /**
   * Walk every page of a board until Pinterest reports the end.
   *
   * Pins returned by the plain board feed carry no section information, so
   * boards that have sections are read section by section; that is the only
   * way a pin can be attributed to the folder it belongs in.
   */
  async function fetchAllBoardPins(boardId, onProgress, signal) {
    const all = [];
    const seen = new Set();

    function add(pin) {
      const key = String(pin.id);
      if (seen.has(key)) return false;
      seen.add(key);
      all.push(pin);
      return true;
    }

    // 1. Section-less pins straight from the board feed.
    let bookmark = null;
    let page = 0;
    for (;;) {
      const res = await fetchBoardPinPage(boardId, bookmark, signal);
      page++;
      for (const pin of res.pins) add(pin);
      if (onProgress) onProgress(all.length, page);
      if (!res.bookmark) break;
      bookmark = res.bookmark;
      // Small pause keeps Pinterest from rate-limiting long boards.
      await new Promise(function (r) {
        setTimeout(r, 120);
      });
    }

    // 2. Sectioned pins, tagged with the folder they belong to.
    let sections = [];
    try {
      sections = await fetchBoardSections(boardId, signal);
    } catch (_) {
      sections = []; // sections are an enhancement, never a hard failure
    }

    for (const section of sections) {
      try {
        const pins = await fetchSectionPins(boardId, section, signal);
        for (const pin of pins) add(pin);
      } catch (_) {
        // A single unreadable section must not abort the whole board.
      }
      if (onProgress) onProgress(all.length, page + 1);
    }

    return all;
  }

  PK.api = {
    setTransport: setTransport,
    ORIGIN: ORIGIN,
    traceId: traceId,
    appVersion: appVersion,
    buildHeaders: buildHeaders,
    resourceUrl: resourceUrl,
    callResource: callResource,
    parseBoardPath: parseBoardPath,
    fetchBoardId: fetchBoardId,
    fetchBoardPinPage: fetchBoardPinPage,
    fetchAllBoardPins: fetchAllBoardPins,
    fetchBoardSections: fetchBoardSections,
    PAGE_SIZE: PAGE_SIZE,
    SECTION_PAGE_SIZE: SECTION_PAGE_SIZE,
    fetchSectionPins: fetchSectionPins,
    fetchSectionPinPage: fetchSectionPinPage,
    withSection: withSection,
    feedList: feedList,
    normalizeFeed: normalizeFeed,
    isPinLike: isPinLike,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = PK.api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
