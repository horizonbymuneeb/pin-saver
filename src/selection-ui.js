/**
 * Manual pin selection dialog.
 *
 * The reference product (Pin Kit) opened a popup in which the user ticked
 * individual pins of a board and downloaded the ticked ones as a single
 * archive. This module is that popup: a centred modal over the page, a
 * scrollable grid of the board's pins, a live search box and the
 * All / None / Invert bulk actions.
 *
 * The dialog deliberately owns no state on disk. It only knows which pins are
 * ticked right now; what "download" means (ZIP, PDF, one file per pin) is the
 * caller's business and is driven from `onConfirm`.
 *
 * Loaded as a plain content script (classic script), so it attaches to the
 * shared `PK` global namespace exactly like the modules in `src/lib`.
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});
  const util = PK.util || {};

  /**
   * Stacking order of the overlay.
   *
   * The injected panel uses 2147483000, so the dialog has to sit above it or
   * the panel would float on top of the modal. It stays below the browser's
   * own UI, which lives in a different layer anyway.
   */
  const Z_INDEX = "2147483400";

  /** The dialog that is currently on screen, if any. */
  let current = null;

  // ---------------------------------------------------------------- helpers

  /** Create an element with an optional class name and text content. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * Best still-image URL of a pin.
   *
   * `PK.util.pickImageUrl` already knows the Pinterest CDN buckets, so it is
   * used when it is available. The local fallback keeps the dialog usable if
   * the module is loaded without `src/lib/util.js`.
   */
  function imageUrlFor(pin) {
    if (!pin || typeof pin !== "object") return "";
    if (typeof util.pickImageUrl === "function") {
      const url = util.pickImageUrl(pin);
      if (url) return url;
    }
    const images = pin.images || {};
    if (images.orig && images.orig.url) return images.orig.url;
    if (images["736x"] && images["736x"].url) return images["736x"].url;
    if (images["564x"] && images["564x"].url) return images["564x"].url;
    return (
      pin.image_large_url || pin.image_medium_url || pin.image_square_url || ""
    );
  }

  /** Human readable pin title, used by the card label and by the search box. */
  function titleFor(pin) {
    if (!pin || typeof pin !== "object") return "";
    if (typeof util.pinTitle === "function") {
      const title = util.pinTitle(pin);
      if (title) return title;
    }
    if (typeof pin.title === "string") return pin.title.trim();
    if (typeof pin.grid_title === "string") return pin.grid_title.trim();
    if (typeof pin.description === "string") return pin.description.trim();
    return "";
  }

  /**
   * Stable identity of a pin inside the selection.
   *
   * The board's pin list streams in, so a pin has to be recognised again
   * after `setPins` replaced the grid. The Pinterest id is the only really
   * stable key, the CDN image URL is the fallback and the list position is
   * the last resort for pins that carry neither.
   */
  function keyFor(pin, index) {
    if (pin && pin.id != null && pin.id !== "") return "id:" + String(pin.id);
    const url = imageUrlFor(pin);
    if (url) return "url:" + url;
    return "idx:" + index;
  }

  /**
   * Public Pinterest permalink of a pin.
   *
   * A pin without an id has no permalink, so the quick actions of its card
   * are disabled.
   */
  function pinUrlFor(pin) {
    if (!pin || typeof pin !== "object") return "";
    const id = pin.id;
    if (id == null || id === "") return "";
    return "https://www.pinterest.com/pin/" + String(id) + "/";
  }

  /**
   * Copy text to the clipboard.
   *
   * `navigator.clipboard.writeText` is the modern path, but a content script
   * on somebody else's page is regularly denied the clipboard permission and
   * the promise then rejects. A hidden textarea plus the legacy
   * `document.execCommand("copy")` still works in that case, so it is the
   * fallback. Neither path may throw: the caller only wants to know whether
   * the text made it to the clipboard.
   *
   * @param {string} text
   * @returns {Promise<boolean>} whether the text was copied
   */
  function copyText(text) {
    const value = String(text == null ? "" : text);
    if (!value) return Promise.resolve(false);

    const fallback = function () {
      let field = null;
      try {
        field = document.createElement("textarea");
        field.value = value;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.top = "0";
        field.style.left = "0";
        field.style.width = "1px";
        field.style.height = "1px";
        field.style.padding = "0";
        field.style.border = "none";
        field.style.outline = "none";
        field.style.opacity = "0";
        field.style.pointerEvents = "none";
        document.body.appendChild(field);
        field.focus();
        field.select();
        field.setSelectionRange(0, value.length);
        return typeof document.execCommand === "function"
          ? !!document.execCommand("copy")
          : false;
      } catch (_) {
        return false;
      } finally {
        if (field && field.parentNode) field.parentNode.removeChild(field);
      }
    };

    try {
      if (
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        const written = navigator.clipboard.writeText(value);
        if (written && typeof written.then === "function") {
          return written.then(
            function () {
              return true;
            },
            function () {
              return fallback();
            },
          );
        }
        return Promise.resolve(true);
      }
    } catch (_) {
      /* the clipboard API is unusable here, use the textarea path */
    }
    return Promise.resolve(fallback());
  }

  /**
   * Open a pin in a new browser tab.
   *
   * `window.open` returns null when the popup was blocked. That is not an
   * error the user can do anything about, so it is only reported.
   *
   * @returns {boolean} whether a tab was opened
   */
  function openInNewTab(url) {
    if (!url) return false;
    try {
      return !!window.open(url, "_blank", "noopener");
    } catch (_) {
      return false;
    }
  }

  /**
   * Icons for the per-card quick actions.
   *
   * They are inline SVG instead of image files so the dialog needs no extra
   * request and cannot be blocked by the page's own image policy.
   */
  const COPY_ICON =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="12" height="12" rx="2"></rect>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

  const OPEN_ICON =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>' +
    '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg>';

  // ---------------------------------------------------------------- dialog

  /**
   * Build one dialog instance.
   *
   * @param {Object} options
   * @param {Array}  [options.pins]   pins to list right away
   * @param {function} [options.onConfirm] receives the selected pin objects
   * @param {function} [options.onCancel] called when the user backs out
   * @returns {Object} internal state of the dialog
   */
  function createDialog(options) {
    const opts = options || {};
    const state = { closed: false, api: null };

    /** Pins currently listed, in the order the caller supplied them. */
    let pins = Array.isArray(opts.pins) ? opts.pins.slice() : [];
    /** Keys of the ticked pins. */
    const selected = new Set();
    /** Rendered cards, keyed by the pin key. */
    const cards = new Map();
    /** Lower-cased search term, empty when the search box is empty. */
    let searchTerm = "";
    /** Number of pins the current search matches. */
    let visibleTotal = 0;

    const onConfirm =
      typeof opts.onConfirm === "function" ? opts.onConfirm : null;
    const onCancel = typeof opts.onCancel === "function" ? opts.onCancel : null;

    // ---------------------------------------------------------- DOM skeleton

    const overlay = el("div", "pinsaver-sel-overlay");
    overlay.style.zIndex = Z_INDEX;

    const dialog = el("div", "pinsaver-sel-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "pinsaver-sel-heading");
    overlay.appendChild(dialog);

    // Header
    const header = el("div", "pinsaver-sel-header");
    const heading = el("h2", "pinsaver-sel-heading", "Select pins");
    heading.id = "pinsaver-sel-heading";
    const closeBtn = el("button", "pinsaver-sel-close");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    header.appendChild(heading);
    header.appendChild(closeBtn);

    // Toolbar: search box plus the bulk actions
    const toolbar = el("div", "pinsaver-sel-toolbar");
    const search = el("input", "pinsaver-sel-search");
    search.type = "search";
    search.placeholder = "Search pins…";
    search.setAttribute("aria-label", "Search pins by title");
    const filterInfo = el("span", "pinsaver-sel-filterinfo");
    const actions = el("div", "pinsaver-sel-actions");
    const allBtn = el("button", "pinsaver-sel-btn", "All");
    const noneBtn = el("button", "pinsaver-sel-btn", "None");
    const invertBtn = el("button", "pinsaver-sel-btn", "Invert");
    const copyAllBtn = el("button", "pinsaver-sel-btn pinsaver-sel-btn--copy", "Copy links");
    allBtn.type = noneBtn.type = invertBtn.type = copyAllBtn.type = "button";
    copyAllBtn.title = "Copy all selected links";
    copyAllBtn.setAttribute("aria-label", "Copy all selected links");
    actions.appendChild(allBtn);
    actions.appendChild(noneBtn);
    actions.appendChild(invertBtn);
    actions.appendChild(copyAllBtn);
    toolbar.appendChild(search);
    toolbar.appendChild(filterInfo);
    toolbar.appendChild(actions);

    // Status line
    const status = el("div", "pinsaver-sel-status");

    // Body: the scrollable grid of cards
    const body = el("div", "pinsaver-sel-body");
    const grid = el("div", "pinsaver-sel-grid");
    grid.setAttribute("role", "list");
    const empty = el("div", "pinsaver-sel-empty", "No pins to show.");
    empty.hidden = true;
    body.appendChild(grid);
    body.appendChild(empty);

    // Footer: live counter plus the two action buttons
    const footer = el("div", "pinsaver-sel-footer");
    const count = el("span", "pinsaver-sel-count", "0 of 0 selected");
    const footerActions = el("div", "pinsaver-sel-footer-actions");
    const cancelBtn = el("button", "pinsaver-sel-btn pinsaver-sel-btn--ghost", "Cancel");
    const downloadBtn = el(
      "button",
      "pinsaver-sel-btn pinsaver-sel-btn--primary",
      "Download 0 selected",
    );
    cancelBtn.type = downloadBtn.type = "button";
    footerActions.appendChild(cancelBtn);
    footerActions.appendChild(downloadBtn);
    footer.appendChild(count);
    footer.appendChild(footerActions);

    dialog.appendChild(header);
    dialog.appendChild(toolbar);
    dialog.appendChild(status);
    dialog.appendChild(body);
    dialog.appendChild(footer);

    // ------------------------------------------------------- scroll locking

    /**
     * The page behind the dialog must not scroll while it is open, so the
     * inline overflow of the root element and of the body is saved and
     * restored. Inline styles are used because Pinterest sets its own
     * overflow rules and a class toggle would not win against them.
     */
    const rootEl = document.documentElement;
    const bodyEl = document.body;
    const prevRootOverflow = rootEl ? rootEl.style.overflow : "";
    const prevBodyOverflow = bodyEl ? bodyEl.style.overflow : "";
    const previouslyFocused = document.activeElement;

    // ------------------------------------------------------------ behaviour

    /** Pins whose title matches the current search term. */
    function visibleEntries() {
      const out = [];
      for (let i = 0; i < pins.length; i++) {
        const pin = pins[i];
        if (searchTerm && titleFor(pin).toLowerCase().indexOf(searchTerm) === -1) {
          continue;
        }
        out.push({ pin: pin, key: keyFor(pin, i) });
      }
      return out;
    }

    /** The ticked pins, in the order the caller supplied them. */
    function selectedPins() {
      const out = [];
      for (let i = 0; i < pins.length; i++) {
        if (selected.has(keyFor(pins[i], i))) out.push(pins[i]);
      }
      return out;
    }

    /** Refresh the counter, the download button and the filter hint. */
    function updateCounters() {
      const chosen = selectedPins();
      count.textContent = chosen.length + " of " + pins.length + " selected";
      downloadBtn.textContent = "Download " + chosen.length + " selected";
      downloadBtn.disabled = chosen.length === 0;
      // Copying the links of the selection only makes sense with a selection.
      copyAllBtn.disabled = chosen.length === 0;
      filterInfo.textContent = searchTerm
        ? "showing " + visibleTotal + " of " + pins.length
        : "";
    }

    /** Write a line into the status bar of the dialog. */
    function showStatus(text, isError) {
      status.textContent = text == null ? "" : String(text);
      status.classList.toggle("pinsaver-sel-status--error", !!isError);
    }

    /**
     * Copy one pin link and confirm it in the status line.
     *
     * The clipboard may be denied to a content script, so a failure is
     * reported instead of thrown.
     */
    function copyLink(url, message) {
      if (!url) {
        showStatus("This pin has no link", true);
        return;
      }
      copyText(url).then(function (ok) {
        if (state.closed) return;
        if (ok) showStatus(message);
        else showStatus("Could not copy the link", true);
      });
    }

    /** Copy the links of every selected pin, one per line. */
    function copyAllLinks() {
      const chosen = selectedPins();
      if (!chosen.length) return;
      const urls = [];
      for (let i = 0; i < chosen.length; i++) {
        const url = pinUrlFor(chosen[i]);
        if (url) urls.push(url);
      }
      if (!urls.length) {
        showStatus("None of the selected pins has a link", true);
        return;
      }
      copyText(urls.join("\n")).then(function (ok) {
        if (state.closed) return;
        if (ok) {
          showStatus(
            "Copied " + urls.length + (urls.length === 1 ? " link" : " links"),
          );
        } else {
          showStatus("Could not copy the links", true);
        }
      });
    }

    /** Point the thumbnail of a card at a new URL (or at the placeholder). */
    function applyImage(card, url) {
      let img = card.img;
      if (!url) {
        if (img && img.parentNode) img.parentNode.removeChild(img);
        card.img = null;
        card.thumb.classList.add("pinsaver-sel-thumb--empty");
        return;
      }
      if (!img) {
        img = el("img", "pinsaver-sel-thumb-img");
        img.loading = "lazy";
        img.decoding = "async";
        img.alt = "";
        // A dead CDN link must not leave a broken-image icon behind.
        img.addEventListener("error", function () {
          if (card.img !== img) return;
          if (img.parentNode) img.parentNode.removeChild(img);
          card.img = null;
          card.thumb.classList.add("pinsaver-sel-thumb--empty");
        });
        card.thumb.insertBefore(img, card.thumb.firstChild);
        card.img = img;
      }
      card.thumb.classList.remove("pinsaver-sel-thumb--empty");
      // Compare the raw attribute: `img.src` is the resolved absolute URL.
      if (img.getAttribute("src") !== url) img.setAttribute("src", url);
    }

    /** Build the DOM of one pin card. */
    function createCard(pin, key, title) {
      const card = el("label", "pinsaver-sel-card");
      card.setAttribute("role", "listitem");
      card.dataset.key = key;
      card.dataset.selected = "0";

      const thumb = el("span", "pinsaver-sel-thumb");
      thumb.appendChild(el("span", "pinsaver-sel-thumb-ph"));

      const check = el("input", "pinsaver-sel-check");
      check.type = "checkbox";
      check.setAttribute("aria-label", title ? "Select " + title : "Select pin");

      // Per-pin quick actions: copy the pin link, open the pin in a tab.
      const url = pinUrlFor(pin);
      const actions = el("span", "pinsaver-sel-card-actions");
      const copyBtn = el("button", "pinsaver-sel-action pinsaver-sel-action--copy");
      copyBtn.type = "button";
      copyBtn.dataset.action = "copy";
      copyBtn.innerHTML = COPY_ICON;
      const openBtn = el("button", "pinsaver-sel-action pinsaver-sel-action--open");
      openBtn.type = "button";
      openBtn.dataset.action = "open";
      openBtn.innerHTML = OPEN_ICON;
      if (!url) {
        // Without an id there is no permalink, so there is nothing to copy.
        copyBtn.disabled = true;
        openBtn.disabled = true;
      }
      actions.appendChild(copyBtn);
      actions.appendChild(openBtn);

      const foot = el("span", "pinsaver-sel-card-foot");
      const titleEl = el("span", "pinsaver-sel-card-title", title || "Untitled");
      if (!title) titleEl.classList.add("pinsaver-sel-card-title--empty");
      foot.appendChild(titleEl);

      card.appendChild(thumb);
      card.appendChild(check);
      card.appendChild(actions);
      card.appendChild(foot);

      const record = {
        el: card,
        check: check,
        titleEl: titleEl,
        title: title,
        thumb: thumb,
        img: null,
        imageUrl: null,
        copyBtn: copyBtn,
        openBtn: openBtn,
        url: url,
      };

      // The card is a <label> around the checkbox, so clicking the card and
      // clicking the checkbox are the same native action. The `change` event
      // is the single place where the selection is updated.
      check.addEventListener("change", function () {
        if (state.closed) return;
        if (check.checked) selected.add(key);
        else selected.delete(key);
        card.dataset.selected = check.checked ? "1" : "0";
        updateCounters();
      });

      // The quick actions live inside that same <label>, so a click on them
      // would run the label's activation behaviour and tick the pin. Both
      // handlers cancel the event first: `preventDefault()` stops the label
      // from forwarding the click to the checkbox and `stopPropagation()`
      // keeps the click away from the card.
      copyBtn.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (state.closed) return;
        copyLink(record.url, "Link copied");
      });

      openBtn.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (state.closed) return;
        if (!openInNewTab(record.url)) {
          showStatus("The browser blocked the new tab", true);
        }
      });

      return record;
    }

    /** Return the card of a pin, creating or refreshing it when needed. */
    function ensureCard(pin, key) {
      const title = titleFor(pin);
      const url = imageUrlFor(pin);
      const link = pinUrlFor(pin);
      let card = cards.get(key);
      if (!card) {
        card = createCard(pin, key, title);
        cards.set(key, card);
      } else if (card.title !== title) {
        card.title = title;
        card.titleEl.textContent = title || "Untitled";
        card.titleEl.classList.toggle("pinsaver-sel-card-title--empty", !title);
        card.check.setAttribute("aria-label", title ? "Select " + title : "Select pin");
      }
      if (link !== card.url) {
        card.url = link;
        card.copyBtn.disabled = !link;
        card.openBtn.disabled = !link;
      }
      // The aria-labels carry the pin title, so they have to follow a title
      // that changed after the card was built.
      const label = title || "pin";
      card.copyBtn.setAttribute("aria-label", "Copy link to " + label);
      card.openBtn.setAttribute("aria-label", "Open " + label + " in a new tab");
      if (url !== card.imageUrl) {
        card.imageUrl = url;
        applyImage(card, url);
      }
      return card;
    }

    /**
     * Redraw the grid.
     *
     * Cards are reused instead of rebuilt, so a board that keeps streaming
     * new pins does not re-download every thumbnail and the user keeps the
     * ticks they already made. The scroll offset is restored explicitly, so
     * a refresh never jumps the list back to the top.
     */
    function render() {
      const scrollTop = grid.scrollTop;
      const visible = visibleEntries();
      visibleTotal = visible.length;

      const shown = new Set();
      for (let i = 0; i < visible.length; i++) {
        const entry = visible[i];
        const card = ensureCard(entry.pin, entry.key);
        const isOn = selected.has(entry.key);
        if (card.check.checked !== isOn) card.check.checked = isOn;
        card.el.dataset.selected = isOn ? "1" : "0";
        shown.add(entry.key);
      }

      // Detach the cards the search hid. They stay in the map so clearing
      // the search does not have to fetch the thumbnails again.
      cards.forEach(function (card, key) {
        if (!shown.has(key) && card.el.parentNode === grid) {
          grid.removeChild(card.el);
        }
      });

      // Put the visible cards back in order. Only cards that are actually
      // misplaced are moved, so a focused checkbox keeps its focus.
      let reference = grid.firstChild;
      for (let i = 0; i < visible.length; i++) {
        const node = cards.get(visible[i].key).el;
        if (node === reference) {
          reference = reference.nextSibling;
        } else {
          grid.insertBefore(node, reference);
        }
      }

      // Forget the cards of pins that are no longer part of the board.
      const live = new Set();
      for (let i = 0; i < pins.length; i++) live.add(keyFor(pins[i], i));
      cards.forEach(function (card, key) {
        if (!live.has(key)) {
          cards.delete(key);
          if (card.el.parentNode) card.el.parentNode.removeChild(card.el);
        }
      });

      empty.hidden = visible.length > 0;
      if (!visible.length) {
        empty.textContent = searchTerm
          ? "No pin matches “" + searchTerm + "”."
          : "No pins to show.";
      }
      grid.scrollTop = scrollTop;
      updateCounters();
    }

    /** Remove the dialog and release everything it holds. */
    function close() {
      if (state.closed) return;
      state.closed = true;
      document.removeEventListener("keydown", onKeyDown, true);
      if (rootEl) rootEl.style.overflow = prevRootOverflow;
      if (bodyEl) bodyEl.style.overflow = prevBodyOverflow;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      cards.clear();
      selected.clear();
      if (current === state) current = null;
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        try {
          previouslyFocused.focus();
        } catch (_) {
          /* the element may be gone; ignoring is fine */
        }
      }
    }

    /** Hand the ticked pins to the caller and close the dialog. */
    function confirmSelection() {
      if (state.closed) return;
      const chosen = selectedPins();
      try {
        if (onConfirm) onConfirm(chosen);
      } finally {
        close();
      }
    }

    /** Back out of the dialog without downloading anything. */
    function cancelSelection() {
      if (state.closed) return;
      close();
      if (onCancel) onCancel();
    }

    function onKeyDown(event) {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      event.preventDefault();
      event.stopPropagation();
      cancelSelection();
    }

    // ------------------------------------------------------------- wiring

    search.addEventListener("input", function () {
      searchTerm = search.value.trim().toLowerCase();
      render();
    });

    // The bulk actions work on the pins that are currently listed, so a
    // search for "cake" followed by "All" selects the cake pins and not the
    // whole board.
    allBtn.addEventListener("click", function () {
      visibleEntries().forEach(function (entry) {
        selected.add(entry.key);
      });
      render();
    });

    noneBtn.addEventListener("click", function () {
      visibleEntries().forEach(function (entry) {
        selected.delete(entry.key);
      });
      render();
    });

    invertBtn.addEventListener("click", function () {
      visibleEntries().forEach(function (entry) {
        if (selected.has(entry.key)) selected.delete(entry.key);
        else selected.add(entry.key);
      });
      render();
    });

    cancelBtn.addEventListener("click", cancelSelection);
    closeBtn.addEventListener("click", cancelSelection);
    downloadBtn.addEventListener("click", confirmSelection);
    copyAllBtn.addEventListener("click", function () {
      copyAllLinks();
    });

    // Clicking the dimmed backdrop cancels. A drag that starts inside the
    // dialog and ends on the backdrop must not cancel, so the mousedown
    // target is remembered as well.
    let downOnBackdrop = false;
    overlay.addEventListener("mousedown", function (event) {
      downOnBackdrop = event.target === overlay;
    });
    overlay.addEventListener("click", function (event) {
      const onBackdrop = event.target === overlay && downOnBackdrop;
      downOnBackdrop = false;
      if (onBackdrop) cancelSelection();
    });

    // Escape is handled on the document in the capture phase so Pinterest's
    // own key handlers cannot swallow it first.
    document.addEventListener("keydown", onKeyDown, true);

    // --------------------------------------------------------------- API

    /** Replace the listed pins, keeping the ticks of the pins still there. */
    function setPins(next) {
      pins = Array.isArray(next) ? next.slice() : [];
      render();
    }

    /** Show a status line inside the dialog, e.g. "Loaded 443 pins". */
    function setStatus(text, isError) {
      showStatus(text, isError);
    }

    /** The ticked pins, in the order the caller supplied them. */
    function getSelected() {
      return selectedPins();
    }

    state.api = {
      close: close,
      setPins: setPins,
      setStatus: setStatus,
      getSelected: getSelected,
      element: overlay,
    };

    // The module keeps a reference to the open dialog so a second `open()`
    // call can replace the first one.
    state.close = close;

    /** Put the dialog on the page and hand over the keyboard. */
    state.mount = function () {
      const host = document.body || document.documentElement;
      host.appendChild(overlay);
      if (rootEl) rootEl.style.overflow = "hidden";
      if (bodyEl) bodyEl.style.overflow = "hidden";
      render();
      try {
        search.focus();
      } catch (_) {
        /* focusing is a nicety, never a requirement */
      }
    };

    return state;
  }

  PK.SelectionUI = {
    /**
     * Open the dialog.
     *
     * @param {Object} options
     * @param {Array}  options.pins     pin objects: {id, title?, images?:{orig?:{url}}, ...}
     * @param {function} options.onConfirm called with the Array of selected pin objects
     * @param {function} [options.onCancel]
     * @returns {Object} api
     */
    open: function (options) {
      // A second call replaces the first one. The replaced dialog is closed
      // silently: its `onCancel` belongs to a dialog the user never touched.
      if (current) current.close();
      const state = createDialog(options);
      current = state;
      state.mount();
      return state.api;
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
