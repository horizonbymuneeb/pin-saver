/**
 * Archive sort order.
 *
 * The archive is written in the order the API returned the pins, which is
 * good for fidelity but useless for finding one photo in a board with
 * hundreds of pins. This module reorders a pin list without touching it, so
 * the caller can write the archive in the order the user picked.
 *
 * Loaded as a plain content script (classic script), so it attaches to the
 * single global namespace instead of using ES modules, exactly like
 * `util.js` does.
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});

  /**
   * The orders a user can pick, in the order they should be offered.
   *
   * `id` is what the panel passes back to `order()`; `label` is the text
   * shown in the selector.
   */
  const ORDERS = [
    { id: "board", label: "Board order" },
    { id: "title-asc", label: "Title A-Z" },
    { id: "title-desc", label: "Title Z-A" },
    { id: "longest", label: "Longest title first" },
  ];

  /**
   * The title of a pin, as the rest of the extension sees it.
   *
   * Pinterest puts the same "title" in different fields depending on the
   * pin type (plain pins use `title`, idea pins use a nested metadata
   * object, and some pins only have a `description` or a `note`), so the
   * helper in `util.js` is the single place that knows how to find one.
   *
   * It is looked up on every call instead of captured when this file loads:
   * the manifest decides whether `util.js` or this module is injected first,
   * and a manifest that lists this module first must not break sorting.
   */
  function titleOf(pin) {
    const util = PK.util;
    if (!util || typeof util.pinTitle !== "function") return "";
    return String(util.pinTitle(pin) || "");
  }

  /**
   * The sort key of a pin title.
   *
   * The comparison is case-insensitive, so "Apple" and "apple" are the same
   * key and therefore keep their original relative order.
   */
  function titleKey(pin) {
    return titleOf(pin).toLowerCase();
  }

  /**
   * Compare two pins by title, A-Z.
   *
   * Returns 0 for equal keys, which is what makes the sort stable.
   */
  function compareTitleAsc(a, b) {
    const ka = titleKey(a);
    const kb = titleKey(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  }

  /**
   * Compare two pins by title, Z-A.
   *
   * The comparison is negated instead of sorting ascending and reversing
   * the result: reversing would flip pins that compare equal and break the
   * "equal titles keep their original order" rule.
   */
  function compareTitleDesc(a, b) {
    return -compareTitleAsc(a, b);
  }

  /**
   * Compare two pins by title length, longest first.
   */
  function compareLongest(a, b) {
    const la = titleOf(a).length;
    const lb = titleOf(b).length;
    if (la > lb) return -1;
    if (la < lb) return 1;
    return 0;
  }

  /**
   * Sort without ever moving equal items relative to each other.
   *
   * `Array.prototype.sort` has been required to be stable since ES2019, but
   * the explicit index tiebreaker makes that guarantee visible and keeps it
   * independent of the engine, and it is exactly what keeps pins with equal
   * titles in their original relative order.
   */
  function stableSort(items, compare) {
    return items
      .map(function (item, index) {
        return { item: item, index: index };
      })
      .sort(function (a, b) {
        const c = compare(a.item, b.item);
        if (c !== 0) return c;
        return a.index - b.index;
      })
      .map(function (entry) {
        return entry.item;
      });
  }

  /**
   * Reorder pins for the archive.
   *
   * The input list is never modified: the result is always a new array, so
   * the caller can keep the API order for the metadata sidecar while
   * writing the files in the order the user asked for.
   *
   * @param {Array} pins
   * @param {string} order one of the ORDERS ids (default "board")
   * @returns {Array} a NEW array; the input is not modified
   */
  function order(pins, order) {
    const list = Array.isArray(pins) ? pins.slice() : [];
    const id = typeof order === "string" ? order.trim().toLowerCase() : "";

    switch (id) {
      case "title-asc":
        return stableSort(list, compareTitleAsc);
      case "title-desc":
        return stableSort(list, compareTitleDesc);
      case "longest":
        return stableSort(list, compareLongest);
      case "board":
      default:
        // An unknown order is not worth an error: fall back to the order
        // the board itself came in.
        return list;
    }
  }

  PK.sort = {
    ORDERS: ORDERS,
    order: order,
  };

  // Node test harness import.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PK.sort;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
