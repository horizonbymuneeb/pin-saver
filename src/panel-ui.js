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
    { id: "about", label: "About" },
  ];

  const DEFAULT_TITLE = "Pin Saver";

  const ABOUT_TEXT =
    "Save a whole board, or just the pins you picked, as a ZIP or a PDF.";

  const PRIVACY_TEXT =
    "Collects no data. Nothing is uploaded; every export happens in your browser.";

  /** Build a DOM node with an optional class name and text. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Call an optional callback, ignoring anything that is not a function. */
  function call(fn) {
    if (typeof fn === "function") fn();
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
     * @returns {Object} api
     */
    create(options) {
      const opts = options || {};
      const title = opts.title || DEFAULT_TITLE;
      const version = opts.version || "";

      let selectedCount = 0;
      let busy = false;
      let activeTab = TABS[0].id;
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

      // --- Board tab: the two primary actions.

      const zipBtn = el("button", "pinsaver-btn", "Download board as ZIP");
      zipBtn.type = "button";
      bodies.board.appendChild(zipBtn);

      const pdfBtn = el("button", "pinsaver-btn pinsaver-btn--ghost", "Download board as PDF");
      pdfBtn.type = "button";
      bodies.board.appendChild(pdfBtn);

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
        activate(name);
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
        show: show,
        hide: hide,
        destroy: destroy,
      };

      mount();
      activate(activeTab);
      syncDisabled();

      return api;
    },
  };

  // Node test harness import.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PK.PanelUI;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
