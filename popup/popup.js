/**
 * Pin Saver — toolbar popup.
 *
 * The popup is a thin front end: it describes the tab the user is on and
 * asks the content script (which owns the Pinterest API client) to do the
 * work. Nothing is fetched from the popup itself.
 *
 * Message contract with src/content.js (see the handler at the bottom of
 * src/content.js):
 *
 *   → { action: "getStatus" }
 *     ← { ok, isBoard, isPin, busy, selected, boardName, boardUrl, pinId, pinTitle }
 *   → { action: "downloadBoard", format: "zip" | "pdf" }
 *     ← { ok: true, format }                     (on a board page)
 *     ← { ok: true, boardUrl, note }             (on a pin page: the board link)
 *     ← { ok: false, error }
 *   → { action: "downloadPin", format: "original" }
 *     ← { ok: true, format } | { ok: false, error }
 *
 * Everything here is defensive on purpose: the popup can be opened on a
 * chrome:// page, on a tab with no content script, or while a tab is closing.
 * None of that may throw — the popup has to show a readable message instead.
 */
(function () {
  "use strict";

  /** Message actions understood by the content script. */
  var ACTION = {
    STATUS: "getStatus",
    DOWNLOAD_BOARD: "downloadBoard",
    DOWNLOAD_PIN: "downloadPin",
  };

  /** Pinterest's home page, used when there is no board to link to. */
  var PINTEREST_HOME = "https://www.pinterest.com/";

  /**
   * Pinterest's app routes. A board URL is /<user>/<board-slug>/, so the
   * first segment must not be one of these. Mirrors RESERVED_ROUTES in
   * src/lib/util.js — the popup cannot load that file, so the list is
   * duplicated here on purpose.
   */
  var RESERVED_ROUTES = [
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

  var el = {
    kicker: document.getElementById("pinsaver-kicker"),
    title: document.getElementById("pinsaver-title"),
    detail: document.getElementById("pinsaver-detail"),
    link: document.getElementById("pinsaver-board-link"),
    zip: document.getElementById("pinsaver-btn-zip"),
    pdf: document.getElementById("pinsaver-btn-pdf"),
    pin: document.getElementById("pinsaver-btn-pin"),
    open: document.getElementById("pinsaver-btn-open"),
    status: document.getElementById("pinsaver-status"),
    version: document.getElementById("pinsaver-version"),
  };

  /** The tab the popup was opened for. */
  var activeTab = null;
  /** Poll timer used to follow a running export. */
  var pollTimer = null;

  // ------------------------------------------------------------------ chrome

  /**
   * Wrap a chrome API that may be callback- or promise-based.
   *
   * `chrome.runtime.lastError` has to be read inside the callback, and a
   * missing content script rejects the promise instead, so both shapes are
   * handled and neither can leave the popup hanging.
   */
  function callChrome(invoke) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        var lastError =
          typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError;
        resolve(lastError ? { ok: false, error: lastError.message } : value);
      }
      try {
        var maybe = invoke(finish);
        if (maybe && typeof maybe.then === "function") {
          maybe.then(
            function (value) {
              finish(value);
            },
            function (err) {
              if (settled) return;
              settled = true;
              resolve({ ok: false, error: (err && err.message) || "Failed to fetch" });
            },
          );
        }
      } catch (err) {
        finish(null);
      }
    });
  }

  /** The active tab of the current window, or null. */
  function queryActiveTab() {
    return callChrome(function (done) {
      return chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        done(tabs && tabs[0] ? tabs[0] : null);
      });
    }).then(function (tab) {
      // On lastError callChrome resolves to { ok: false, error }, which has no
      // id — treat that as "no active tab" rather than as a tab.
      if (tab && typeof tab.id !== "undefined" && tab.id !== null) return tab;
      return null;
    });
  }

  /** Send a message to the content script of a tab. Never rejects. */
  function sendToTab(tabId, message) {
    if (tabId === undefined || tabId === null) {
      return Promise.resolve({ ok: false, error: "No tab" });
    }
    return callChrome(function (done) {
      return chrome.tabs.sendMessage(tabId, message, function (response) {
        done(response === undefined ? null : response);
      });
    }).then(function (response) {
      return response || null;
    });
  }

  // -------------------------------------------------------------------- url

  /**
   * Classify a tab URL.
   *
   * @returns {{kind: string, isPinterest: boolean, pathname: string,
   *   origin: string, boardPath: string, boardSlug: string, user: string,
   *   pinId: string}}
   */
  function parseTabUrl(url) {
    var out = {
      kind: "other",
      isPinterest: false,
      url: url || "",
      origin: "",
      pathname: "",
      boardPath: "",
      boardSlug: "",
      user: "",
      pinId: "",
    };
    var parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return out;
    }
    out.origin = parsed.origin;
    out.pathname = parsed.pathname || "";
    if (!/^https:\/\/([a-z0-9-]+\.)?pinterest\.com$/i.test(parsed.hostname)) {
      return out;
    }
    out.isPinterest = true;

    var parts = out.pathname.split("?")[0].split("/").filter(Boolean);
    if (!parts.length) return out;

    var first = String(parts[0]).toLowerCase();
    if (first === "pin" && parts.length >= 2) {
      out.kind = "pin";
      out.pinId = parts[1];
      return out;
    }
    if (parts.length >= 2 && RESERVED_ROUTES.indexOf(first) === -1) {
      out.kind = "board";
      out.user = parts[0];
      out.boardSlug = parts[1];
      out.boardPath = "/" + parts[0] + "/" + parts[1] + "/";
      return out;
    }
    return out;
  }

  /** Turn a board slug into something readable: "my-board" → "My board". */
  function humanizeSlug(slug) {
    var text = String(slug || "")
      .replace(/[-_+]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** Make a board path absolute: "/alice/travel/" → "https://www.pinterest.com/alice/travel/". */
  function absoluteBoardUrl(value, origin) {
    if (!value) return "";
    if (/^https?:\/\//i.test(value)) return value;
    if (value.charAt(0) === "/") return origin + value;
    return "";
  }

  /** Upper-case the first letter of a message. */
  function capitalize(text) {
    var value = String(text || "");
    if (!value) return "";
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  // ----------------------------------------------------------------- status

  /** Show a message on the status line. Errors are always visible. */
  function setStatus(text, isError) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("pinsaver-status--error", Boolean(isError));
  }

  /**
   * Turn a content-script reply into a status line.
   *
   * The reply shapes are the ones src/content.js sends: an error object, a
   * board export acknowledgement, a pin acknowledgement, or the note that a
   * pin page only knows the URL of its board.
   */
  function describeResult(response) {
    if (!response) {
      return { text: "No response from the page", error: true };
    }
    if (response.ok === false) {
      return { text: response.error || "Failed to fetch", error: true };
    }
    var message = response.message || response.status;
    if (typeof message === "string" && message) {
      return { text: message, error: Boolean(response.error) };
    }
    if (typeof response.note === "string" && response.note) {
      return {
        text: capitalize(response.note),
        error: false,
        boardUrl: response.boardUrl || "",
      };
    }
    if (response.format === "zip" || response.format === "pdf") {
      return {
        text:
          "Saving the board as " +
          response.format.toUpperCase() +
          " — watch the panel on the page",
        error: false,
      };
    }
    if (response.format) {
      // downloadPin: { ok: true, format: "original" | "jpeg" | "png" }
      return { text: "Saving the pin — watch the panel on the page", error: false };
    }
    if (typeof response.saved === "number") {
      return { text: "Saved " + response.saved + " pins", error: false };
    }
    if (typeof response.count === "number") {
      return { text: "Saved " + response.count + " pins", error: false };
    }
    return { text: "Started — watch the panel on the page", error: false };
  }

  // ---------------------------------------------------------------- context

  /** Show only one action button group at a time. */
  function showButtons(kind) {
    el.zip.hidden = kind !== "board" && kind !== "pin";
    el.pdf.hidden = kind !== "board";
    el.pin.hidden = kind !== "pin";
    el.open.hidden = kind !== "other";

    // On a board page the ZIP button is the primary one; on a pin page the
    // pin download is.
    el.zip.classList.toggle("pinsaver-btn--primary", kind === "board");
    el.zip.classList.toggle("pinsaver-btn--secondary", kind !== "board");
    el.pin.classList.toggle("pinsaver-btn--primary", kind === "pin");
    el.pin.classList.toggle("pinsaver-btn--secondary", kind !== "pin");
  }

  /** Fill the context block. */
  function setContext(kicker, title, detail) {
    el.kicker.textContent = kicker;
    el.title.textContent = title;
    el.detail.textContent = detail;
  }

  /** Show (or hide) the "open the board" link. */
  function setLink(href, label) {
    if (!href) {
      el.link.hidden = true;
      return;
    }
    el.link.hidden = false;
    el.link.href = href;
    el.link.textContent = label || "Open board in a new tab";
  }

  /** The generic "nothing to do here" state. */
  function showNothing(detail) {
    setContext("Nothing to download", "Open a Pinterest board to use Pin Saver", detail);
    showButtons("other");
    setLink(PINTEREST_HOME, "Open Pinterest");
  }

  // ----------------------------------------------------------------- export

  /** Ask the content script to run an export and report what came back. */
  function trigger(message, busyLabel) {
    if (!activeTab) {
      setStatus("No active tab", true);
      return Promise.resolve();
    }
    setStatus(busyLabel || "Working…", false);
    return sendToTab(activeTab.id, message).then(function (response) {
      var result = describeResult(response);
      if (result.boardUrl) {
        // A pin page knows the URL of its board but cannot export it from
        // there — point the user at it.
        var href = absoluteBoardUrl(result.boardUrl, parseTabUrl(activeTab.url || "").origin);
        if (href) setLink(href, "Open the board to export it");
      }
      setStatus(result.text, result.error);
      if (!result.error) startPolling();
      return result;
    });
  }

  /** Follow a running export so the status line shows progress. */
  function startPolling() {
    stopPolling();
    var wasBusy = false;
    pollTimer = setInterval(function () {
      if (!activeTab) {
        stopPolling();
        return;
      }
      sendToTab(activeTab.id, { action: ACTION.STATUS }).then(function (response) {
        if (!response || response.ok === false) {
          stopPolling();
          return;
        }
        if (response.busy) {
          wasBusy = true;
          setStatus(
            response.message || response.status || "Export running — watch the panel on the page",
            false,
          );
          return;
        }
        if (wasBusy) {
          var text =
            response.message ||
            response.status ||
            "Export finished — see the panel on the page";
          setStatus(text, Boolean(response.error));
        }
        stopPolling();
      });
    }, 1500);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ------------------------------------------------------------------- init

  /** Read the extension version for the footer. */
  function showVersion() {
    try {
      var manifest = chrome.runtime.getManifest();
      if (manifest && manifest.version) {
        el.version.textContent = "Version " + manifest.version;
      }
    } catch (_) {
      el.version.textContent = "";
    }
  }

  /** Wire the action buttons once the tab context is known. */
  function wireActions() {
    el.zip.addEventListener("click", function () {
      trigger(
        { action: ACTION.DOWNLOAD_BOARD, format: "zip" },
        "Starting the ZIP export…",
      );
    });
    el.pdf.addEventListener("click", function () {
      trigger(
        { action: ACTION.DOWNLOAD_BOARD, format: "pdf" },
        "Starting the PDF export…",
      );
    });
    el.pin.addEventListener("click", function () {
      trigger(
        { action: ACTION.DOWNLOAD_PIN, format: "original" },
        "Saving the pin…",
      );
    });
    el.open.addEventListener("click", function () {
      try {
        chrome.tabs.create({ url: PINTEREST_HOME });
      } catch (_) {
        window.open(PINTEREST_HOME, "_blank");
      }
    });
  }

  /** Render a board page. */
  function renderBoard(parsed, status) {
    var name =
      (status && status.boardName) || humanizeSlug(parsed.boardSlug) || "Pinterest board";
    var bits = [];
    if (parsed.user) bits.push(parsed.user + "/" + parsed.boardSlug);
    if (status && typeof status.selected === "number" && status.selected > 0) {
      bits.push(status.selected + " pin" + (status.selected === 1 ? "" : "s") + " selected");
    }
    if (status && status.busy) bits.push("an export is already running");

    setContext("Pinterest board", name, bits.join(" · "));
    showButtons("board");

    var boardUrl = absoluteBoardUrl(
      (status && status.boardUrl) || parsed.boardPath,
      parsed.origin,
    );
    setLink(boardUrl, "Open board in a new tab");
    setStatus(
      status && status.busy
        ? "Export in progress — watch the panel on the page"
        : "Board detected",
      false,
    );
  }

  /** Render a single-pin page. */
  function renderPin(parsed, status) {
    var pinId = (status && status.pinId) || parsed.pinId || "";
    var name = (status && status.pinTitle) || (pinId ? "Pin " + pinId : "Pinterest pin");
    var bits = [];
    if (pinId) bits.push("Pin " + pinId);
    if (status && status.boardName) bits.push("from " + status.boardName);

    setContext("Pinterest pin", name, bits.join(" · "));
    showButtons("pin");

    var boardUrl = absoluteBoardUrl((status && status.boardUrl) || "", parsed.origin);
    if (boardUrl) {
      setLink(boardUrl, "Open the pin's board in a new tab");
    } else {
      setLink(PINTEREST_HOME, "Open Pinterest");
    }
    setStatus("Pin detected", false);
  }

  /** Ask the content script what it knows about the page. */
  function readStatus(tabId) {
    return sendToTab(tabId, { action: ACTION.STATUS }).then(function (response) {
      if (!response || response.ok === false) return null;
      return response;
    });
  }

  function init() {
    showVersion();
    wireActions();
    setStatus("Checking this tab…", false);

    queryActiveTab()
      .then(function (tab) {
        if (!tab) {
          showNothing("There is no active tab to work with.");
          setStatus("No active tab", true);
          return null;
        }
        activeTab = tab;
        var parsed = parseTabUrl(tab.url || "");

        if (!parsed.isPinterest) {
          showNothing("This tab is not on Pinterest.");
          setStatus("Not on Pinterest", false);
          return null;
        }
        if (parsed.kind !== "board" && parsed.kind !== "pin") {
          showNothing("Open a board or a pin on Pinterest to use Pin Saver.");
          setStatus("Not on Pinterest", false);
          return null;
        }

        return readStatus(tab.id).then(function (status) {
          if (!status) {
            // No content script (or it did not answer): fall back to the URL
            // so the context is still correct, and say plainly that the page
            // is not ready.
            if (parsed.kind === "board") {
              renderBoard(parsed, null);
            } else {
              renderPin(parsed, null);
            }
            setStatus("This page did not respond — reload the Pinterest tab and try again", true);
            return;
          }
          if (parsed.kind === "board") {
            renderBoard(parsed, status);
          } else {
            renderPin(parsed, status);
          }
          if (status.isBoard === false && parsed.kind === "board") {
            setStatus("This page is not a board page — reload it and try again", true);
          }
        });
      })
      .catch(function (err) {
        showNothing("Something went wrong while reading this tab.");
        setStatus(String((err && err.message) || err), true);
      });
  }

  init();
})();
