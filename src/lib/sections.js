/**
 * Single-section export helper.
 *
 * The API client can already read a board's sections and the pins inside one
 * section; this module turns that into the two calls the panel needs: a list
 * of sections to offer the user, and the pins of the one section that was
 * picked.
 *
 * Loaded as a plain content script (classic script), so it attaches to the
 * single `PK` namespace like every other library in this extension. Nothing
 * here touches the DOM or the window, so it also runs in Node for the tests.
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});

  /**
   * The API client.
   *
   * It is resolved when a call is made rather than when this file is loaded,
   * so the load order of the content scripts does not matter.
   */
  function apiClient() {
    const api = PK.api;
    if (!api) throw new Error("The Pinterest API client is not loaded");
    return api;
  }

  /** The canonical abort error, shaped like the API client's own. */
  function abortError(signal) {
    const reason = signal && signal.reason;
    if (reason && typeof reason === "object" && reason.name === "AbortError") {
      return reason;
    }
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    err.code = "ABORT_ERR";
    return err;
  }

  /**
   * Stop before the request is sent when the caller already cancelled.
   */
  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError(signal);
  }

  /**
   * Reject as soon as the signal aborts.
   *
   * The API client hands the signal to fetch, so the browser cancels the
   * request itself; a transport that ignores the signal would leave the call
   * waiting for an answer that never comes, so the abort is watched here too.
   */
  function withAbort(promise, signal) {
    if (!signal || typeof signal.addEventListener !== "function") return promise;
    return new Promise(function (resolve, reject) {
      let settled = false;
      function cleanup() {
        if (typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort);
        }
      }
      function onAbort() {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortError(signal));
      }
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        function (value) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        function (err) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        },
      );
    });
  }

  /**
   * The display name of a section.
   *
   * A section without a usable name still has to be shown in a menu, so the
   * id is used instead; "Section" is the last resort. The name is never
   * empty, because the archive builds a folder out of it.
   */
  function sectionName(section, id) {
    const raw = section && (section.name || section.title);
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (id) return id;
    return "Section";
  }

  /**
   * The pin count a section reports, or null when the API sends none.
   *
   * The count-like fields Pinterest may use are accepted; a count that is
   * not there is never guessed, because only the board feed knows the real
   * number of pins.
   */
  function sectionPinCount(section) {
    if (!section || typeof section !== "object") return null;
    const candidates = [
      section.pin_count,
      section.pinCount,
      section.num_pins,
      section.count,
    ];
    for (const value of candidates) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return null;
  }

  /**
   * The section as the API client wants it: an id and a usable name.
   *
   * Everything else the caller passed is kept, because the section endpoint
   * is addressed by the section's slug when one is known.
   */
  function normalizeSection(section) {
    const source = section && typeof section === "object" ? section : {};
    const id = source.id != null ? String(source.id) : "";
    if (!id) throw new Error("A section id is required");
    const out = Object.assign({}, source);
    out.id = source.id;
    out.name = sectionName(source, id);
    return out;
  }

  /**
   * List the sections of a board, ready to show in a menu.
   *
   * A board without sections is a normal board, so an empty list is a normal
   * answer and not an error. A failing API call rejects with the error the
   * API client produced; it is never swallowed.
   *
   * @param {string} boardId
   * @param {object} [options] { signal, onProgress }
   * @returns {Promise<Array<{id: string, name: string, pinCount: number|null}>>}
   */
  async function list(boardId, options) {
    const settings = options || {};
    const signal = settings.signal;
    throwIfAborted(signal);

    const api = apiClient();
    const raw = await withAbort(
      api.fetchBoardSections(boardId, signal),
      signal,
    );
    const found = Array.isArray(raw) ? raw : [];
    const out = found.map(function (section) {
      const id = section && section.id != null ? String(section.id) : "";
      return {
        id: id,
        name: sectionName(section, id),
        pinCount: sectionPinCount(section),
      };
    });
    // The section list is read in one go, so progress is reported once.
    if (typeof settings.onProgress === "function") settings.onProgress(out.length);
    return out;
  }

  /**
   * Every pin of one section, tagged with its folder path.
   *
   * The pins are read by the API client, which walks the pages and attaches
   * the section path used to build the folder inside the archive. A page
   * that cannot be read ends the section early: the pins collected so far
   * are kept and the failure is reported through `onProgress(count, error)`.
   * Without a progress callback there is nowhere to report the failure to,
   * so the error is thrown instead of being dropped.
   *
   * @param {string} boardId
   * @param {{id: string, name: string}} section
   * @param {object} [options] { signal, onProgress }
   * @returns {Promise<Array>} the pin objects
   */
  async function pins(boardId, section, options) {
    const settings = options || {};
    const signal = settings.signal;
    throwIfAborted(signal);

    const api = apiClient();
    const target = normalizeSection(section);
    let failure = null;
    const collected = await withAbort(
      api.fetchSectionPins(boardId, target, signal, function (err) {
        failure = err;
      }),
      signal,
    );
    const found = Array.isArray(collected) ? collected : [];
    // The API client tags every pin with the section path; a pin that lost
    // it gets it back, so the archive can always build the folder.
    const out = found.map(function (pin) {
      return pin && pin.sectionPath ? pin : api.withSection(pin, target);
    });
    if (failure) {
      if (typeof settings.onProgress === "function") {
        settings.onProgress(out.length, failure);
        return out;
      }
      throw failure;
    }
    if (typeof settings.onProgress === "function") settings.onProgress(out.length);
    return out;
  }

  PK.sections = {
    list: list,
    pins: pins,
  };

  // Node test harness import.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PK.sections;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
