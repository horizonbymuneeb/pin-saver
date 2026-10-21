/**
 * Horizontal tabbed panel for the Pin Saver content script.
 *
 * The panel stays a small floating overlay in the bottom-right corner of a
 * board page, but the box now reads like a little tabbed toolbar: the tab
 * strip runs left-to-right across the top (Board | Selected | About) and
 * only the active tab's content is visible.
 *
 * The strip is a real `role="tablist"`: tabs are clickable, reachable with
 * the keyboard (Left/Right/Home/End move, Enter/Space activate) and carry
 * `aria-selected`, so a screen reader announces the same three sections a
 * sighted user sees.
 *
 * Pinterest is a single-page app, so the panel outlives the page it was
 * created on: clicking a pin swaps the board for a single pin without a
 * reload, while the panel element stays in the DOM. The panel therefore has
 * two modes. In `board` mode the tab strip and its three sections are shown
 * exactly as before. In `pin` mode the strip is hidden and a pin-specific
 * view takes its place (title, "Download pin", the JPEG/PNG format row and
 * a "← Back to board" button), so a single-pin page never offers
 * "Download board as ZIP".
 *
 * This module owns the DOM only. Every action is reported back through the
 * callbacks handed to `create()`, so `content.js` stays the single place
 * that knows how a download actually works.
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});

  /** Tabs of the strip, in the order they are shown. */
  const TABS = [
    { id: "board", label: "Board" },
    { id: "selected", label: "Selected" },
    { id: "sections", label: "Sections" },
    { id: "about", label: "About" },
  ];

  const DEFAULT_TITLE = "Pin Saver";

  const ABOUT_TEXT =
    "Save a whole board, or just the pins you picked, as a ZIP or a PDF.";

  const PRIVACY_TEXT =
    "Collects no data. Nothing is uploaded; every export happens in your browser.";

  /**
   * The two shapes the panel can take.
   *
   * `board` shows the tab strip (Board | Selected | About). `pin` hides the
   * strip and shows the single-pin view instead.
   */
  const MODES = { BOARD: "board", PIN: "pin" };

  /** Shown in the pin view when the pin has no usable title. */
  const DEFAULT_PIN_TITLE = "Untitled pin";

  /** Download formats the pin view can offer. */
  const PIN_FORMATS = ["original", "jpeg", "png"];

  /** Build a DOM node with an optional class name and text. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Call an optional callback, ignoring anything that is not a function. */
  function call(fn) {
    if (typeof fn !== "function") return;
    // Forward the extra arguments: a callback such as onDownloadSection needs
    // to know which section was clicked.
    const args = Array.prototype.slice.call(arguments, 1);
    fn.apply(null, args);
  }

  /**
   * Map a tab name onto its internal id.
   *
   * Callers may say "Board", "board" or "BOARD"; unknown names are ignored
   * instead of throwing, so a stale caller can never break the panel.
   */
  function normalizeTab(name) {
    if (typeof name !== "string") return null;
    const id = name.trim().toLowerCase();
    for (const tab of TABS) {
      if (tab.id === id) return tab.id;
    }
    return null;
  }

  /**
   * Map a mode name onto its internal id.
   *
   * Only "pin" selects the pin view; anything else (including a missing or
   * malformed value) falls back to the board view, so a stale caller can
   * never leave the panel in a half-switched state.
   */
  function normalizeMode(mode) {
    if (typeof mode !== "string") return MODES.BOARD;
    const id = mode.trim().toLowerCase();
    return id === MODES.PIN ? MODES.PIN : MODES.BOARD;
  }

  PK.PanelUI = {
    /**
     * Build the panel and attach it to the page.
     *
     * @param {Object} options
     * @param {string} [options.title]
     * @param {string} [options.version]
     * @param {function} options.onZip         called when the ZIP button is pressed
     * @param {function} options.onPdf         called when the PDF button is pressed
     * @param {function} options.onSelectPins  called when "Select pins…" is pressed
     * @param {function} options.onZipSelected called when "ZIP selected" is pressed
     * @param {function} [options.onCancel]    called when "Cancel" is pressed
     * @param {function} [options.onDismiss]   called when the panel is closed
     * @param {function} [options.onDownloadSection] called with a section
     * @param {function} [options.onDownloadPin] called with a format
     *        ("original", "jpeg" or "png") when a pin download button is pressed
     * @param {function} [options.onBackToBoard] called when "← Back to board"
     *        is pressed; the panel also returns to board mode by itself
     * @returns {Object} api
     */
    create(options) {
      const opts = options || {};
      const title = opts.title || DEFAULT_TITLE;
      const version = opts.version || "";

      let selectedCount = 0;
      let busy = false;
      let activeTab = TABS[0].id;
      let mode = MODES.BOARD;
      let destroyed = false;

      // ------------------------------------------------------------- root

      const panel = el("div", "pinsaver-panel");
      panel.id = "pinsaver-panel";
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-label", title);

      // --------------------------------------------------------- tab strip

      const strip = el("div", "pinsaver-tabs");

      const list = el("div", "pinsaver-tabs__list");
      list.setAttribute("role", "tablist");
      list.setAttribute("aria-label", title + " sections");
      list.setAttribute("aria-orientation", "horizontal");

      /** Tab buttons and tab panels, keyed by tab id. */
      const tabs = {};
      const bodies = {};

      TABS.forEach(function (def) {
        const btn = el("button", "pinsaver-tab", def.label);
        btn.type = "button";
        btn.id = "pinsaver-tab-" + def.id;
        btn.setAttribute("role", "tab");
        btn.setAttribute("aria-controls", "pinsaver-panel-" + def.id);
        btn.dataset.pinsaverTab = def.id;
        // Roving tabindex: only the active tab is in the tab order.
        btn.tabIndex = def.id === activeTab ? 0 : -1;
        list.appendChild(btn);
        tabs[def.id] = btn;

        const body = el("div", "pinsaver-panel__tab");
        body.id = "pinsaver-panel-" + def.id;
        body.setAttribute("role", "tabpanel");
        body.setAttribute("aria-labelledby", btn.id);
        body.dataset.pinsaverPanel = def.id;
        body.hidden = def.id !== activeTab;
        bodies[def.id] = body;
      });

      // The count lives on the tab itself so the selection size is readable
      // without switching to the "Selected" tab.
      const countBadge = el("span", "pinsaver-tab__count", "0");
      countBadge.dataset.pinsaverCount = "1";
      tabs.selected.appendChild(countBadge);

      strip.appendChild(list);

      const closeBtn = el("button", "pinsaver-tabs__close", "×");
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Close panel");
      closeBtn.title = "Close panel";
      strip.appendChild(closeBtn);

      panel.appendChild(strip);

      // ------------------------------------------------------------- body

      const body = el("div", "pinsaver-panel__body");
      panel.appendChild(body);

      // --- Pin view: what the panel shows on a single-pin page.
      //
      // It is built once and only revealed in pin mode; the tab strip is
      // hidden in that mode, so the board sections never show next to the
      // pin-specific actions.

      const pinPanel = el("div", "pinsaver-pin");
      pinPanel.setAttribute("role", "group");
      pinPanel.setAttribute("aria-label", "Pin download");
      pinPanel.dataset.pinsaverPinPanel = "1";
      pinPanel.hidden = true;

      // Heading area: the "Pin" label plus the pin's own title.
      const pinHeading = el("div", "pinsaver-pin__heading");
      const pinEyebrow = el("div", "pinsaver-pin__eyebrow", "Pin");
      const pinTitle = el("div", "pinsaver-pin__title");
      pinTitle.dataset.pinsaverPinTitle = "1";
      pinHeading.appendChild(pinEyebrow);
      pinHeading.appendChild(pinTitle);
      pinPanel.appendChild(pinHeading);

      // The primary action: the pin exactly as Pinterest serves it.
      const pinDownloadBtn = el("button", "pinsaver-btn pinsaver-pin__primary", "Download pin");
      pinDownloadBtn.type = "button";
      pinDownloadBtn.dataset.pinsaverPinDownload = "original";
      pinPanel.appendChild(pinDownloadBtn);

      // The format row: the same image, re-encoded as JPEG or PNG.
      const pinFormats = el("div", "pinsaver-pin__formats");
      const pinFormatBtns = {};
      PIN_FORMATS.forEach(function (format) {
        if (format === "original") return; // already the primary button
        const label = format === "jpeg" ? "Download as JPEG" : "Download as PNG";
        const btn = el("button", "pinsaver-btn pinsaver-btn--ghost pinsaver-pin__format", label);
        btn.type = "button";
        btn.dataset.pinsaverPinDownload = format;
        pinFormats.appendChild(btn);
        pinFormatBtns[format] = btn;
      });
      pinPanel.appendChild(pinFormats);

      // Back to the board: the only way out of the pin view.
      const pinBackBtn = el(
        "button",
        "pinsaver-btn pinsaver-btn--ghost pinsaver-pin__back",
        "← Back to board",
      );
      pinBackBtn.type = "button";
      pinBackBtn.dataset.pinsaverPinBack = "1";
      pinPanel.appendChild(pinBackBtn);

      // Read-only line with the pin's id and/or URL.
      const pinMeta = el("div", "pinsaver-pin__meta");
      pinMeta.dataset.pinsaverPinMeta = "1";
      const pinId = el("span", "pinsaver-pin__id");
      pinId.dataset.pinsaverPinId = "1";
      const pinSep = el("span", "pinsaver-pin__sep", " · ");
      const pinUrl = el("span", "pinsaver-pin__url");
      pinUrl.dataset.pinsaverPinUrl = "1";
      pinMeta.appendChild(pinId);
      pinMeta.appendChild(pinSep);
      pinMeta.appendChild(pinUrl);
      pinMeta.hidden = true;
      pinPanel.appendChild(pinMeta);

      // The pin view sits in the content area, above the tab sections.
      body.appendChild(pinPanel);

      // --- Board tab: the two primary actions.

      const zipBtn = el("button", "pinsaver-btn", "Download board as ZIP");
      zipBtn.type = "button";
      bodies.board.appendChild(zipBtn);

      const pdfBtn = el("button", "pinsaver-btn pinsaver-btn--ghost", "Download board as PDF");
      pdfBtn.type = "button";
      bodies.board.appendChild(pdfBtn);

      // --- Board tab: the export options.

      const optionsRow = el("div", "pinsaver-options");

      const formatLabel = el("label", "pinsaver-options__field");
      formatLabel.appendChild(document.createTextNode("Format"));
      const formatSelect = el("select", "pinsaver-options__select");
      formatSelect.dataset.pinsaverOption = "format";
      [["original", "Original"], ["jpeg", "JPEG"], ["png", "PNG"]].forEach(function (pair) {
        const opt = el("option", null, pair[1]);
        opt.value = pair[0];
        formatSelect.appendChild(opt);
      });
      formatLabel.appendChild(formatSelect);
      optionsRow.appendChild(formatLabel);

      const orderLabel = el("label", "pinsaver-options__field");
      orderLabel.appendChild(document.createTextNode("Order"));
      const orderSelect = el("select", "pinsaver-options__select");
      orderSelect.dataset.pinsaverOption = "order";
      // The order list comes from the shared module so the panel and the
      // sorting code can never drift apart.
      const orders =
        PK.sort && PK.sort.ORDERS
          ? PK.sort.ORDERS
          : [
              { id: "board", label: "Board order" },
              { id: "title-asc", label: "Title A-Z" },
              { id: "title-desc", label: "Title Z-A" },
            ];
      orders.forEach(function (pair) {
        const opt = el("option", null, pair.label);
        opt.value = pair.id;
        orderSelect.appendChild(opt);
      });
      orderLabel.appendChild(orderSelect);
      optionsRow.appendChild(orderLabel);

      bodies.board.appendChild(optionsRow);

      const rangeLabel = el("label", "pinsaver-options__range");
      rangeLabel.appendChild(document.createTextNode("Pins"));
      const rangeInput = el("input", "pinsaver-options__input");
      rangeInput.type = "text";
      rangeInput.dataset.pinsaverOption = "range";
      rangeInput.placeholder = "all";
      rangeInput.setAttribute("aria-label", "Which pins to download, for example 1-50");
      rangeLabel.appendChild(rangeInput);
      bodies.board.appendChild(rangeLabel);

      const retryBtn = el("button", "pinsaver-btn pinsaver-btn--ghost pinsaver-retry", "Retry failed pins");
      retryBtn.type = "button";
      retryBtn.hidden = true;
      bodies.board.appendChild(retryBtn);

      // --- Selected tab: the multi-select area.

      const countLine = el("div", "pinsaver-selected__count");
      const countNum = el("span", "pinsaver-selected__num", "0");
      countNum.dataset.pinsaverSelectedCount = "1";
      countLine.appendChild(countNum);
      countLine.appendChild(document.createTextNode(" pins selected"));
      bodies.selected.appendChild(countLine);

      const selectBtn = el("button", "pinsaver-btn pinsaver-btn--ghost", "Select pins…");
      selectBtn.type = "button";
      bodies.selected.appendChild(selectBtn);

      const selZipBtn = el(
        "button",
        // `pinsaver-btn--selected-zip` is the hook the content script uses to
        // find this button, so it is kept even though the tabbed panel is new.
        "pinsaver-btn pinsaver-btn--ghost pinsaver-btn--selected-zip",
        "ZIP selected",
      );
      selZipBtn.type = "button";
      // It only makes sense with a selection, so it starts disabled.
      selZipBtn.disabled = true;
      bodies.selected.appendChild(selZipBtn);

      // --- About tab: what the extension is and what it does not do.

      const aboutTitle = el("div", "pinsaver-panel__title", title);
      bodies.about.appendChild(aboutTitle);

      const aboutText = el("p", "pinsaver-about__text", ABOUT_TEXT);
      bodies.about.appendChild(aboutText);

      const aboutVersion = el("p", "pinsaver-about__version");
      aboutVersion.appendChild(document.createTextNode("Version "));
      const versionValue = el("span", "pinsaver-about__version-value", version || "—");
      aboutVersion.appendChild(versionValue);
      bodies.about.appendChild(aboutVersion);

      const aboutPrivacy = el("p", "pinsaver-about__privacy", PRIVACY_TEXT);
      bodies.about.appendChild(aboutPrivacy);

      // --- Sections tab: the board's sections, each downloadable on its own.

      const sectionsNote = el("p", "pinsaver-sections__note", "Loading the board's sections…");
      bodies.sections.appendChild(sectionsNote);

      const sectionsList = el("div", "pinsaver-sections__list");
      sectionsList.dataset.pinsaverSections = "1";
      bodies.sections.appendChild(sectionsList);

      TABS.forEach(function (def) {
        body.appendChild(bodies[def.id]);
      });

      // --- Footer: the busy-only cancel button and the status line.

      const cancelBtn = el("button", "pinsaver-btn pinsaver-btn--ghost pinsaver-cancel", "Cancel");
      cancelBtn.type = "button";
      cancelBtn.hidden = true;
      body.appendChild(cancelBtn);

      const status = el("div", "pinsaver-status");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.dataset.pinsaverStatus = "1";
      body.appendChild(status);

      // ------------------------------------------------------------ wiring

      formatSelect.addEventListener("change", function () {
        call(opts.onExportOption, "format", formatSelect.value);
      });
      orderSelect.addEventListener("change", function () {
        call(opts.onExportOption, "order", orderSelect.value);
      });
      rangeInput.addEventListener("change", function () {
        call(opts.onExportOption, "range", rangeInput.value);
      });
      retryBtn.addEventListener("click", function () {
        call(opts.onRetryFailed);
      });
      zipBtn.addEventListener("click", function () {
        call(opts.onZip);
      });
      pdfBtn.addEventListener("click", function () {
        call(opts.onPdf);
      });
      selectBtn.addEventListener("click", function () {
        call(opts.onSelectPins);
      });
      selZipBtn.addEventListener("click", function () {
        call(opts.onZipSelected);
      });
      cancelBtn.addEventListener("click", function () {
        call(opts.onCancel);
      });

      // A pin download reports the chosen format back to the caller.
      pinDownloadBtn.addEventListener("click", function () {
        reportPinDownload("original");
      });
      Object.keys(pinFormatBtns).forEach(function (format) {
        pinFormatBtns[format].addEventListener("click", function () {
          reportPinDownload(format);
        });
      });

      // "← Back to board" returns the panel to the board view itself, and
      // then tells the caller, so the panel can never get stuck in pin mode
      // even if the callback throws.
      pinBackBtn.addEventListener("click", function () {
        setMode(MODES.BOARD);
        call(opts.onBackToBoard);
      });

      closeBtn.addEventListener("click", function () {
        // Closing the panel must not throw away the pins the user picked, so
        // the selection is left alone and only the box goes away.
        call(opts.onDismiss);
        destroy();
      });

      // Clicking a tab selects it.
      list.addEventListener("click", function (event) {
        const target = event.target;
        if (!target || !target.closest) return;
        const btn = target.closest("[data-pinsaver-tab]");
        if (!btn) return;
        activate(btn.dataset.pinsaverTab);
      });

      // Keyboard navigation across the strip.
      list.addEventListener("keydown", function (event) {
        const key = event.key;
        const isNext = key === "ArrowRight";
        const isPrev = key === "ArrowLeft";
        const isHome = key === "Home";
        const isEnd = key === "End";
        const isPick = key === "Enter" || key === " " || key === "Spacebar";
        if (!isNext && !isPrev && !isHome && !isEnd && !isPick) return;

        const target = event.target;
        const focused = target && target.dataset ? target.dataset.pinsaverTab : null;
        let index = TABS.findIndex(function (def) {
          return def.id === focused;
        });
        if (index < 0) {
          index = TABS.findIndex(function (def) {
            return def.id === activeTab;
          });
        }

        let next = index;
        if (isNext) next = (index + 1) % TABS.length;
        else if (isPrev) next = (index - 1 + TABS.length) % TABS.length;
        else if (isHome) next = 0;
        else if (isEnd) next = TABS.length - 1;

        // Enter and Space activate the focused tab; the default button
        // behaviour is cancelled so the tab is picked exactly once.
        event.preventDefault();
        activate(TABS[next].id);
        tabs[TABS[next].id].focus();
      });

      // ------------------------------------------------------- tab state

      /** Show one tab and hide the others. */
      function activate(name) {
        const id = normalizeTab(name);
        if (!id) return;
        activeTab = id;
        TABS.forEach(function (def) {
          const isActive = def.id === id;
          const btn = tabs[def.id];
          btn.setAttribute("aria-selected", isActive ? "true" : "false");
          btn.tabIndex = isActive ? 0 : -1;
          btn.classList.toggle("pinsaver-tab--active", isActive);
          bodies[def.id].hidden = !isActive;
        });
      }

      // --------------------------------------------------------- mode state

      /** Report a pin download with the format the user picked. */
      function reportPinDownload(format) {
        if (typeof opts.onDownloadPin === "function") opts.onDownloadPin(format);
      }

      /**
       * Paint the current mode onto the DOM.
       *
       * Board mode shows the tab strip and the active tab; pin mode hides
       * the strip and every board section, and shows the pin view instead.
       */
      function applyMode() {
        const isPin = mode === MODES.PIN;
        strip.hidden = isPin;
        pinPanel.hidden = !isPin;
        panel.classList.toggle("pinsaver-panel--pin", isPin);
        if (isPin) {
          // The board sections stay out of the way while the pin view is up.
          TABS.forEach(function (def) {
            bodies[def.id].hidden = true;
          });
        } else {
          // Restore whichever tab was active before the pin view appeared.
          activate(activeTab);
        }
      }

      /**
       * Apply the busy/selection state to every action button.
       *
       * A running export disables all actions, and "ZIP selected" additionally
       * needs at least one selected pin to be meaningful.
       */
      function syncDisabled() {
        zipBtn.disabled = busy;
        pdfBtn.disabled = busy;
        selectBtn.disabled = busy;
        selZipBtn.disabled = busy || selectedCount === 0;
        cancelBtn.disabled = !busy;
        // The pin view follows the same rule: no new export while one runs.
        pinDownloadBtn.disabled = busy;
        Object.keys(pinFormatBtns).forEach(function (format) {
          pinFormatBtns[format].disabled = busy;
        });
      }

      // ------------------------------------------------------------- api

      /** Attach the panel to the page, if it is not attached already. */
      function mount() {
        if (panel.parentNode) return;
        const host = document.body || document.documentElement;
        if (host) host.appendChild(panel);
      }

      function setStatus(text, isError) {
        status.textContent = text == null ? "" : String(text);
        status.classList.toggle("pinsaver-status--error", !!isError);
      }

      function setBusy(next) {
        busy = !!next;
        cancelBtn.hidden = !busy;
        syncDisabled();
      }

      function setSelectedCount(n) {
        const value = Number(n);
        selectedCount = isFinite(value) && value > 0 ? Math.floor(value) : 0;
        countNum.textContent = String(selectedCount);
        countBadge.textContent = String(selectedCount);
        syncDisabled();
      }

      function setTab(name) {
        // In pin mode the tab strip is hidden, so switching tabs would be
        // invisible. The call is ignored instead of throwing.
        if (mode === MODES.PIN) return;
        activate(name);
      }

      /**
       * Switch the panel between the board view and the pin view.
       *
       * @param {string} next "board" or "pin"; anything else means board
       */
      function setMode(next) {
        mode = normalizeMode(next);
        applyMode();
      }

      /**
       * Update the text of the pin view.
       *
       * Every field is optional: a missing or empty title falls back to a
       * generic label, and the id/URL line disappears when there is nothing
       * to show. This never throws, whatever the caller passes in.
       *
       * @param {Object} info `{ title, id, url }`
       */
      /**
       * Show the board's sections.
       *
       * @param {Array<{id: string, name: string, pinCount: number|null}>} list
       */
      function setSections(list) {
        if (!sectionsList) return;
        sectionsList.textContent = "";
        const rows = Array.isArray(list) ? list : [];
        if (!rows.length) {
          sectionsNote.textContent = "This board has no sections.";
          return;
        }
        sectionsNote.textContent = "Download one section on its own:";
        rows.forEach(function (section) {
          const row = el("div", "pinsaver-sections__row");
          const label = el("span", "pinsaver-sections__name", section && section.name ? section.name : "Section");
          if (section && section.pinCount != null) {
            const count = el("span", "pinsaver-sections__count", String(section.pinCount));
            row.appendChild(count);
          }
          row.appendChild(label);
          const btn = el("button", "pinsaver-btn pinsaver-btn--ghost pinsaver-sections__btn", "↓");
          btn.type = "button";
          btn.title = "Download this section";
          btn.addEventListener("click", function () {
            call(opts.onDownloadSection, section);
          });
          row.appendChild(btn);
          sectionsList.appendChild(row);
        });
      }

      /**
       * Show how many pins failed, and offer a retry.
       *
       * @param {number} count
       */
      function setFailed(count) {
        const n = Number(count) || 0;
        retryBtn.hidden = n <= 0;
        retryBtn.textContent = n > 0 ? "Retry " + n + " failed pin" + (n === 1 ? "" : "s") : "Retry failed pins";
      }

      /**
       * Set one of the export options from outside.
       *
       * @param {string} name "format" | "order" | "range"
       * @param {string} value
       */
      function setOption(name, value) {
        if (name === "format") formatSelect.value = value;
        else if (name === "order") orderSelect.value = value;
        else if (name === "range") rangeInput.value = value == null ? "" : String(value);
      }

      function setPinInfo(info) {
        const data = info && typeof info === "object" ? info : {};

        const title = data.title == null ? "" : String(data.title).trim();
        const id = data.id == null ? "" : String(data.id).trim();
        const url = data.url == null ? "" : String(data.url).trim();

        pinTitle.textContent = title || DEFAULT_PIN_TITLE;
        pinId.textContent = id;
        pinUrl.textContent = url;
        pinSep.hidden = !(id && url);
        pinMeta.hidden = !(id || url);
      }

      function show() {
        if (destroyed) return;
        mount();
        panel.hidden = false;
      }

      function hide() {
        panel.hidden = true;
      }

      function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (panel.parentNode) panel.parentNode.removeChild(panel);
      }

      const api = {
        element: panel,
        setStatus: setStatus,
        setBusy: setBusy,
        setSelectedCount: setSelectedCount,
        setTab: setTab,
        setMode: setMode,
        setPinInfo: setPinInfo,
        setSections: setSections,
        setFailed: setFailed,
        setOption: setOption,
        show: show,
        hide: hide,
        destroy: destroy,
      };

      mount();
      applyMode();
      syncDisabled();

      return api;
    },
  };

  // Node test harness import.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PK.PanelUI;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
