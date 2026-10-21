/**
 * Pin range selector.
 *
 * A board can hold hundreds of pins and picking them one by one in the page
 * is impractical, so the panel offers a range field instead: "1-50",
 * "100-", "-20", "80", "all". This module turns such an expression into
 * 1-based pin positions and picks the matching pins.
 *
 * Loaded as a plain content script (classic script), so it deliberately
 * attaches to a single global namespace instead of using ES modules. Every
 * function here is side-effect free and is unit-tested in Node.
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});

  /**
   * The board size as a usable count.
   *
   * A caller that does not know the size yet gets an empty board, which
   * selects nothing rather than pretending the pins are there.
   */
  function normalizeTotal(total) {
    const n = Number(total);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  /** Every position of a board, 1-based and ascending. */
  function allPositions(total) {
    const out = [];
    for (let i = 1; i <= total; i++) out.push(i);
    return out;
  }

  /**
   * Parse one comma-separated part of a range expression.
   *
   * The accepted shapes are `all`, a single position (`80`), a span
   * (`10-20`), a headless span (`-20` = the first 20) and an open tail
   * (`100-` = 100 to the end).
   *
   * @param {string} part one part, already trimmed
   * @param {number} total how many pins the board has
   * @returns {{ok:boolean, error:string|null, from:number, to:number}}
   *          `from` and `to` are inclusive 1-based positions; `from > to`
   *          means the part selects nothing.
   */
  function parsePart(part, total) {
    function fail(error) {
      return { ok: false, error: error, from: 1, to: 0 };
    }

    if (part.toLowerCase() === "all") {
      return { ok: true, error: null, from: 1, to: total };
    }

    const dash = part.indexOf("-");
    if (dash === -1) {
      // A single position, e.g. "80".
      if (!/^\d+$/.test(part)) {
        return fail(
          '"' + part + '" is not a pin number or a range like 1-50',
        );
      }
      const n = parseInt(part, 10);
      if (n < 1) {
        return fail("Pin numbers start at 1, but got " + n);
      }
      // A lone position past the end selects nothing, exactly like a range
      // that starts past the end: the user asked for a pin this board does
      // not have, so no pin is handed back and it is still no error.
      if (total < 1 || n > total) {
        return { ok: true, error: null, from: 1, to: 0 };
      }
      return { ok: true, error: null, from: n, to: n };
    }

    const head = part.slice(0, dash).trim();
    const tail = part.slice(dash + 1).trim();

    if (!head && !tail) {
      return fail('The range "-" is missing a number');
    }

    if (!head) {
      // "-20" -> the first 20 pins.
      if (!/^\d+$/.test(tail)) {
        const negative = /^-(\d+)$/.exec(tail);
        if (negative) {
          return fail("Pin numbers start at 1, but got -" + negative[1]);
        }
        return fail(
          '"' + part + '" is not a pin number or a range like 1-50',
        );
      }
      const n = parseInt(tail, 10);
      if (n < 1) {
        return fail("Pin numbers start at 1, but got " + n);
      }
      return { ok: true, error: null, from: 1, to: Math.min(n, total) };
    }

    if (!tail) {
      // "100-" -> pin 100 to the end.
      if (!/^\d+$/.test(head)) {
        return fail(
          '"' + part + '" is not a pin number or a range like 1-50',
        );
      }
      const n = parseInt(head, 10);
      if (n < 1) {
        return fail("Pin numbers start at 1, but got " + n);
      }
      // A range that starts past the end selects nothing, it is no error.
      if (n > total) return { ok: true, error: null, from: 1, to: 0 };
      return { ok: true, error: null, from: n, to: total };
    }

    // "10-20" -> a span.
    if (!/^\d+$/.test(head) || !/^\d+$/.test(tail)) {
      const negative = /^-(\d+)$/.exec(tail);
      if (negative) {
        return fail("Pin numbers start at 1, but got -" + negative[1]);
      }
      return fail(
        '"' + part + '" is not a pin number or a range like 1-50',
      );
    }
    const from = parseInt(head, 10);
    const to = parseInt(tail, 10);
    if (from < 1) {
      return fail("Pin numbers start at 1, but got " + from);
    }
    if (to < 1) {
      return fail("Pin numbers start at 1, but got " + to);
    }
    if (from > to) {
      return fail("The range " + part + " runs backwards");
    }
    // The end is clamped to the board, a range that starts past the end
    // selects nothing.
    if (from > total) return { ok: true, error: null, from: 1, to: 0 };
    return { ok: true, error: null, from: from, to: Math.min(to, total) };
  }

  /**
   * Parse a range expression into 1-based pin positions.
   *
   * Positions are 1-based because a human counts pins from 1. Overlapping
   * parts merge, the result is sorted and free of duplicates. The end of a
   * span is clamped to the board ("8-500" of 10 is pins 8 to 10), while a
   * position or a range that starts past the end selects nothing and is not
   * an error.
   *
   * @param {string} text e.g. "1-50", "1-50, 80, 100-", "-20", "all"
   * @param {number} total how many pins the board has
   * @returns {{ok:boolean, error:string|null, positions:number[]}}
   */
  function parse(text, total) {
    const count = normalizeTotal(total);
    const raw = String(text == null ? "" : text).trim();

    // An empty field means "everything", it is not a mistake.
    if (!raw) {
      return { ok: true, error: null, positions: allPositions(count) };
    }

    const wanted = new Set();
    for (const part of raw.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: "The range has an empty part, check for a stray comma",
          positions: [],
        };
      }
      const parsed = parsePart(trimmed, count);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error, positions: [] };
      }
      for (let p = parsed.from; p <= parsed.to; p++) wanted.add(p);
    }

    const positions = Array.from(wanted).sort(function (a, b) {
      return a - b;
    });
    return { ok: true, error: null, positions: positions };
  }

  /**
   * Pick the pins a range expression names.
   *
   * `positions[i]` is the 1-based position of `pins[i]` on the board, so
   * position 1 is the first pin of the array.
   *
   * @param {Array} pins every pin of the board, in board order
   * @param {string} text e.g. "1-50", "1-50, 80, 100-", "-20", "all"
   * @returns {{ok:boolean, error:string|null, pins:Array, positions:number[]}}
   */
  function select(pins, text) {
    const list = Array.isArray(pins) ? pins : [];
    const parsed = parse(text, list.length);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, pins: [], positions: [] };
    }
    const picked = [];
    for (const position of parsed.positions) {
      const pin = list[position - 1];
      if (pin !== undefined) picked.push(pin);
    }
    return {
      ok: true,
      error: null,
      pins: picked,
      positions: parsed.positions,
    };
  }

  PK.range = {
    parse: parse,
    select: select,
  };

  // Node test harness import.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PK.range;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
