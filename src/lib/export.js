/**
 * The export runner.
 *
 * Exporting a board means walking a pin list and fetching every pin's media.
 * The panel used to do that one pin at a time and simply drop whatever failed,
 * so the user was told "Saved 180 pins, 3 skipped" and had no way to find out
 * which three were lost, let alone save them.
 *
 * This module is the part that can be tested: the pin list goes in, the media
 * comes out, and every pin that failed is recorded with the reason why. The
 * failed pins are handed back in their original order, so the panel can offer
 * a retry of exactly those and nothing else.
 *
 * The fetching itself is injected as `fetchOne`, so this file knows nothing
 * about the network, the DOM or `chrome.*` and can run in Node.
 *
 * Loaded as a plain content script (classic script), so it attaches to the
 * single `PK` namespace like every other library in this extension.
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});

  /** How many pins are fetched at once when the caller does not say. */
  const DEFAULT_CONCURRENCY = 4;

  /**
   * The reason recorded for a pin that was never attempted.
   *
   * A stopped run must not look like a run where those pins simply do not
   * exist, so they are reported as failed as well: the user can retry them.
   */
  const NOT_STARTED = "not started (the run was stopped)";

  /** The reason recorded for a pin whose media could not be produced. */
  const NO_MEDIA = "no media returned";

  /**
   * The message of a thrown error.
   *
   * The reason is shown to the user, so an error without a message falls back
   * to its own string form rather than to "undefined".
   */
  function errorMessage(err) {
    if (err == null) return "Unknown error";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  }

  /**
   * How many pins may be fetched at once.
   *
   * A caller that asks for a nonsensical number gets the default rather than
   * a run that can never make progress: a concurrency of zero would deadlock.
   */
  function normalizeConcurrency(value) {
    if (value == null) return DEFAULT_CONCURRENCY;
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
    return Math.max(1, Math.floor(n));
  }

  /**
   * Fetch one pin and record what happened to it.
   *
   * A pin that throws is a failed pin, not a failed run: one broken CDN
   * response must never cost the user the rest of the board.
   */
  async function fetchPin(index, list, fetchOne, results, errors, state) {
    const pin = list[index];
    state.attempted[index] = true;

    let value = null;
    let failure = null;
    try {
      value = await fetchOne(pin);
    } catch (err) {
      failure = errorMessage(err);
    }

    if (value == null) {
      results[index] = null;
      errors[index] = failure == null ? NO_MEDIA : failure;
    } else {
      results[index] = value;
    }

    state.done += 1;
    if (state.onProgress) {
      // A broken progress callback must never cost the user a pin, so a
      // throwing one is ignored rather than allowed to break the run.
      try {
        state.onProgress(state.done, state.total);
      } catch (_) {
        // ignored on purpose
      }
    }
  }

  /**
   * Fetch every pin's media, recording the ones that fail.
   *
   * The pins are fetched with a bounded number of workers rather than one at
   * a time, so a large board does not take minutes of wall clock.
   *
   * @param {Array} pins the pins to export, in the order they are archived
   * @param {function} fetchOne async (pin) => {bytes: Uint8Array, ext: string,
   *   isVideo: boolean, url: string} | null; resolving null means the pin
   *   failed, and throwing means it failed too
   * @param {object} [options] {concurrency, onProgress, shouldStop}
   * @returns {Promise<{results: Array, failed: Array<{pin: object, error:
   *   string}>, done: number, total: number, stopped: boolean}>}
   */
  async function run(pins, fetchOne, options) {
    if (typeof fetchOne !== "function") {
      throw new Error("A fetchOne function is required");
    }

    const settings = options || {};
    const list = Array.isArray(pins) ? pins : [];
    const total = list.length;
    const limit = normalizeConcurrency(settings.concurrency);

    const results = new Array(total);
    const errors = new Array(total);

    const state = {
      done: 0,
      total: total,
      stopped: false,
      attempted: new Array(total),
      onProgress:
        typeof settings.onProgress === "function" ? settings.onProgress : null,
      shouldStop:
        typeof settings.shouldStop === "function" ? settings.shouldStop : null,
    };

    // The workers pull pins off one shared cursor, so no pin is fetched twice
    // and no more than `limit` of them are ever in flight.
    let cursor = 0;

    async function worker() {
      for (;;) {
        // Another worker already stopped the run: do not start more work.
        if (state.stopped) return;

        const index = cursor;
        cursor += 1;
        if (index >= total) return;

        if (state.shouldStop) {
          let stop = false;
          try {
            stop = !!state.shouldStop();
          } catch (_) {
            // A stop check that blows up is treated as "stop": starting more
            // work after the user asked to cancel is the worse mistake.
            stop = true;
          }
          if (stop) {
            state.stopped = true;
            return;
          }
        }

        await fetchPin(index, list, fetchOne, results, errors, state);
      }
    }

    const workers = [];
    const count = Math.min(limit, total);
    for (let i = 0; i < count; i++) workers.push(worker());
    await Promise.all(workers);

    // Pins that were never started are reported as failed too, so a stopped
    // run can be resumed by retrying exactly the pins that are missing.
    const failed = [];
    for (let i = 0; i < total; i++) {
      if (!state.attempted[i]) {
        results[i] = null;
        errors[i] = NOT_STARTED;
      }
      if (errors[i] != null) {
        failed.push({ pin: list[i], error: errors[i] });
      }
    }

    return {
      results: results,
      failed: failed,
      done: state.done,
      total: total,
      stopped: state.stopped,
    };
  }

  /**
   * The pins that failed in a previous run, in their original order.
   *
   * This is what the panel hands back to a retry, so it must contain the pin
   * objects themselves and not just their ids.
   *
   * @param {{failed: Array<{pin: object, error: string}>}} report
   * @returns {Array} the failed pins, in the order they were given
   */
  function failedPins(report) {
    if (!report || !Array.isArray(report.failed)) return [];
    const out = [];
    for (const entry of report.failed) {
      if (entry) out.push(entry.pin);
    }
    return out;
  }

  PK.export = {
    run: run,
    failedPins: failedPins,
  };

  // Node test harness import.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PK.export;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
