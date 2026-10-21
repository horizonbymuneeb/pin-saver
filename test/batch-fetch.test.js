/**
 * Tests for the batched media fetch in the background service worker.
 *
 * The "Slow Archiving" bug was a shape problem, not a network problem: the
 * content script asked the worker for one pin at a time and waited for the
 * bytes before starting the next one, so a 500-pin board cost 500 strictly
 * serial round trips.
 *
 * The worker now answers `fetchMediaBatch` with several pins per message and
 * runs them concurrently, capped so a big board cannot flood the CDN, and
 * `cancelFetch` aborts whatever is in flight.
 *
 * Run: node --test test/batch-fetch.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const BACKGROUND = path.join(__dirname, "..", "src", "background.js");

// ---------------------------------------------------------------------------
// Harness: a fake chrome global plus a way to talk to the message listener
// ---------------------------------------------------------------------------

/**
 * Load a pristine copy of the service worker.
 *
 * The worker registers its `chrome.runtime.onMessage` listener at load time and
 * keeps module-level state (the blob cache, the in-flight abort registry), so
 * the module cache is cleared to give every test a clean instance.
 */
function loadWorker() {
  delete require.cache[require.resolve(BACKGROUND)];

  const listeners = [];
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      lastError: undefined,
      getManifest: () => ({ version: "1.0.0" }),
    },
    downloads: { download: (_options, callback) => callback(1) },
    tabs: { onUpdated: { addListener: () => {} } },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
    },
  };

  require(BACKGROUND);
  assert.equal(listeners.length, 1, "the worker must register one message listener");
  const listener = listeners[0];

  return {
    /** Send a message and resolve with the worker's reply. */
    send(message) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            reject(new Error("worker never replied to " + message.action));
          }
        }, 10000);
        const done = (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(response);
        };
        try {
          listener(message, {}, done);
        } catch (err) {
          done({
            ok: false,
            error: String(err && err.message ? err.message : err),
          });
        }
      });
    },
  };
}

/**
 * Install a fake fetch that tracks concurrency and honours abort signals.
 *
 * The concurrency counter is the point: it is the only way to prove the
 * worker does not fire hundreds of requests at once.
 */
function installFetch(handler) {
  const original = globalThis.fetch;
  const state = { calls: [], inFlight: 0, maxInFlight: 0 };
  globalThis.fetch = async function (url, init) {
    const target = String(url);
    state.calls.push(target);
    state.inFlight += 1;
    if (state.inFlight > state.maxInFlight) state.maxInFlight = state.inFlight;
    try {
      return await handler(target, init || {}, state);
    } finally {
      state.inFlight -= 1;
    }
  };
  return {
    state: state,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A minimal Response-alike carrying the bytes the worker expects. */
function mediaResponse(payload, contentType) {
  const bytes = new TextEncoder().encode(payload);
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType || "image/jpeg" },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/** A Response-alike for a failed request. */
function errorResponse(status) {
  return {
    ok: false,
    status: status,
    headers: { get: () => null },
  };
}

/** A delay that rejects as soon as the request is aborted. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The same shape a real `AbortController` produces. */
function abortError() {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/** Decode a base64 reply back into text so it can be compared. */
function decode(result) {
  return Buffer.from(result.data, "base64").toString("utf8");
}

/** Build `count` distinct Pinterest media URLs. */
function mediaUrls(prefix, count) {
  const urls = [];
  for (let i = 0; i < count; i++) {
    urls.push(`https://i.pinimg.com/originals/aa/bb/${prefix}${i}.jpg`);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Batch shape
// ---------------------------------------------------------------------------

test("fetchMediaBatch keeps results in the same order as the request", async () => {
  const worker = loadWorker();
  const server = installFetch(async (url) => {
    // Later items answer first, so the order cannot come from completion order.
    const index = Number(url.match(/(\d+)\.jpg$/)[1]);
    await delay(30 - index);
    return mediaResponse("pin-" + index);
  });

  try {
    const items = mediaUrls("order", 5).map((url) => ({ url, isVideo: false }));
    const res = await worker.send({ action: "fetchMediaBatch", items });

    assert.equal(res.ok, true);
    assert.equal(res.results.length, items.length, "one result per item");
    res.results.forEach((result, index) => {
      assert.equal(result.ok, true, "item " + index + " must succeed");
      assert.equal(decode(result), "pin-" + index, "result " + index + " is out of order");
    });
  } finally {
    server.restore();
  }
});

test("fetchMediaBatch returns the base64 bytes and the size of every item", async () => {
  const worker = loadWorker();
  const server = installFetch(async () => mediaResponse("hello"));

  try {
    const res = await worker.send({
      action: "fetchMediaBatch",
      items: [{ url: "https://i.pinimg.com/originals/aa/bb/one.jpg", isVideo: false }],
    });

    assert.equal(res.ok, true);
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].ok, true);
    assert.equal(typeof res.results[0].data, "string", "bytes must cross as base64");
    assert.equal(res.results[0].size, 5);
    assert.equal(decode(res.results[0]), "hello");
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// One broken pin must not take the board down
// ---------------------------------------------------------------------------

test("a failing item fails in place without failing the batch", async () => {
  const worker = loadWorker();
  const server = installFetch(async (url) => {
    if (url.includes("/broken")) return errorResponse(404);
    return mediaResponse("ok:" + url);
  });

  try {
    const res = await worker.send({
      action: "fetchMediaBatch",
      items: [
        { url: "https://i.pinimg.com/originals/aa/bb/1.jpg", isVideo: false },
        { url: "https://i.pinimg.com/originals/aa/bb/broken.jpg", isVideo: false },
        { url: "https://i.pinimg.com/originals/aa/bb/3.jpg", isVideo: false },
      ],
    });

    assert.equal(res.ok, true, "the batch itself must still succeed");
    assert.equal(res.results.length, 3, "every item still gets a result");
    assert.equal(res.results[0].ok, true);
    assert.equal(res.results[1].ok, false, "the broken pin fails");
    assert.match(res.results[1].error, /404/, "the failure carries a reason");
    assert.equal(res.results[2].ok, true, "the pins after the broken one survive");
  } finally {
    server.restore();
  }
});

test("a transient failure inside a batch is still retried", async () => {
  const worker = loadWorker();
  let attempts = 0;
  const server = installFetch(async () => {
    attempts += 1;
    if (attempts === 1) return errorResponse(500);
    return mediaResponse("late");
  });

  try {
    const res = await worker.send({
      action: "fetchMediaBatch",
      items: [{ url: "https://i.pinimg.com/originals/aa/bb/flaky.jpg", isVideo: false }],
    });

    assert.equal(res.ok, true);
    assert.equal(res.results[0].ok, true, "the retry must recover the pin");
    assert.equal(decode(res.results[0]), "late");
    assert.equal(attempts, 2, "one retry is enough");
  } finally {
    server.restore();
  }
});

test("a non-Pinterest item fails in place without failing the batch", async () => {
  const worker = loadWorker();
  const server = installFetch(async () => mediaResponse("ok"));

  try {
    const res = await worker.send({
      action: "fetchMediaBatch",
      items: [
        { url: "https://evil.example.com/a.jpg", isVideo: false },
        { url: "https://i.pinimg.com/originals/aa/bb/2.jpg", isVideo: false },
      ],
    });

    assert.equal(res.ok, true);
    assert.equal(res.results[0].ok, false);
    assert.match(res.results[0].error, /Refusing non-Pinterest/);
    assert.equal(res.results[1].ok, true);
    assert.equal(
      server.state.calls.length,
      1,
      "the refused URL must never reach the network",
    );
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// Bounded concurrency
// ---------------------------------------------------------------------------

test("the batch never runs more than eight fetches at once", async () => {
  const worker = loadWorker();
  const server = installFetch(async (url, init) => {
    await delay(20, init.signal);
    return mediaResponse("x");
  });

  try {
    const items = mediaUrls("conc", 24).map((url) => ({ url, isVideo: false }));
    const res = await worker.send({ action: "fetchMediaBatch", items });

    assert.equal(res.ok, true);
    assert.equal(res.results.length, 24);
    assert.ok(
      server.state.maxInFlight <= 8,
      "concurrency cap exceeded: " + server.state.maxInFlight,
    );
    assert.equal(
      server.state.maxInFlight,
      8,
      "the batch must actually run in parallel, not serially",
    );
  } finally {
    server.restore();
  }
});

test("a batch of one item still runs (the cap is a ceiling, not a target)", async () => {
  const worker = loadWorker();
  const server = installFetch(async () => mediaResponse("x"));

  try {
    const res = await worker.send({
      action: "fetchMediaBatch",
      items: [{ url: "https://i.pinimg.com/originals/aa/bb/solo.jpg", isVideo: false }],
    });

    assert.equal(res.ok, true);
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].ok, true);
    assert.equal(server.state.maxInFlight, 1);
  } finally {
    server.restore();
  }
});

test("an empty batch is a valid, empty answer", async () => {
  const worker = loadWorker();
  const server = installFetch(async () => mediaResponse("x"));

  try {
    const res = await worker.send({ action: "fetchMediaBatch", items: [] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.results, []);
    assert.equal(server.state.calls.length, 0);
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// Message size guard
// ---------------------------------------------------------------------------

test("a batch larger than 32 items is rejected outright", async () => {
  const worker = loadWorker();
  const server = installFetch(async () => mediaResponse("x"));

  try {
    const items = mediaUrls("big", 33).map((url) => ({ url, isVideo: false }));
    const res = await worker.send({ action: "fetchMediaBatch", items });

    assert.equal(res.ok, false, "an oversized batch must be refused");
    assert.match(res.error, /too large/i);
    assert.equal(res.results, undefined, "no results for a rejected batch");
    assert.equal(
      server.state.calls.length,
      0,
      "a rejected batch must not hit the network at all",
    );
  } finally {
    server.restore();
  }
});

test("a batch of exactly 32 items is accepted", async () => {
  const worker = loadWorker();
  const server = installFetch(async () => mediaResponse("x"));

  try {
    const items = mediaUrls("max", 32).map((url) => ({ url, isVideo: false }));
    const res = await worker.send({ action: "fetchMediaBatch", items });

    assert.equal(res.ok, true);
    assert.equal(res.results.length, 32);
  } finally {
    server.restore();
  }
});

test("fetchMediaBatch rejects a message whose items are not an array", async () => {
  const worker = loadWorker();
  const server = installFetch(async () => mediaResponse("x"));

  try {
    const res = await worker.send({ action: "fetchMediaBatch", items: "nope" });
    assert.equal(res.ok, false);
    assert.match(res.error, /items array/);
    assert.equal(server.state.calls.length, 0);
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test("cancelFetch aborts an in-flight batch and the items resolve as cancelled", async () => {
  const worker = loadWorker();
  const server = installFetch(async (url, init) => {
    await delay(5000, init.signal);
    return mediaResponse("never");
  });

  try {
    const items = mediaUrls("slow", 2).map((url) => ({ url, isVideo: false }));
    const batch = worker.send({ action: "fetchMediaBatch", items });

    // Give the requests a moment to actually be in flight.
    await delay(50);

    const cancel = await worker.send({ action: "cancelFetch" });
    assert.equal(cancel.ok, true);
    assert.equal(cancel.aborted, 2, "both in-flight requests are aborted");

    const res = await batch;
    assert.equal(res.ok, true, "the batch still replies");
    assert.equal(res.results.length, 2);
    for (const result of res.results) {
      assert.equal(result.ok, false);
      assert.equal(result.error, "cancelled");
    }
    assert.equal(
      server.state.calls.length,
      2,
      "a cancelled item must never be retried",
    );
  } finally {
    server.restore();
  }
});

test("cancelFetch aborts a queued item so it never starts", async () => {
  const worker = loadWorker();
  const server = installFetch(async (url, init) => {
    await delay(5000, init.signal);
    return mediaResponse("never");
  });

  try {
    // More items than the concurrency window, so some stay queued.
    const items = mediaUrls("queued", 12).map((url) => ({ url, isVideo: false }));
    const batch = worker.send({ action: "fetchMediaBatch", items });

    await delay(50);
    await worker.send({ action: "cancelFetch" });

    const res = await batch;
    assert.equal(res.ok, true);
    assert.equal(res.results.length, 12, "every item still gets a result");
    for (const result of res.results) {
      assert.equal(result.ok, false);
      assert.equal(result.error, "cancelled");
    }
    assert.equal(
      server.state.calls.length,
      8,
      "only the requests already in flight were ever started",
    );
  } finally {
    server.restore();
  }
});

test("cancelFetch also aborts a single in-flight fetchMedia", async () => {
  const worker = loadWorker();
  const server = installFetch(async (url, init) => {
    await delay(5000, init.signal);
    return mediaResponse("never");
  });

  try {
    const single = worker.send({
      action: "fetchMedia",
      url: "https://i.pinimg.com/originals/aa/bb/solo.jpg",
      isVideo: false,
    });

    await delay(50);
    const cancel = await worker.send({ action: "cancelFetch" });
    assert.equal(cancel.ok, true);
    assert.equal(cancel.aborted, 1);

    const res = await single;
    assert.equal(res.ok, false);
    assert.equal(res.error, "cancelled");
  } finally {
    server.restore();
  }
});

test("a batch started after a cancel runs normally", async () => {
  const worker = loadWorker();
  const server = installFetch(async () => mediaResponse("fresh"));

  try {
    const cancel = await worker.send({ action: "cancelFetch" });
    assert.equal(cancel.ok, true);
    assert.equal(cancel.aborted, 0, "nothing was in flight");

    const res = await worker.send({
      action: "fetchMediaBatch",
      items: [{ url: "https://i.pinimg.com/originals/aa/bb/new.jpg", isVideo: false }],
    });
    assert.equal(res.ok, true);
    assert.equal(res.results[0].ok, true);
    assert.equal(decode(res.results[0]), "fresh");
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// The pre-existing single-pin action must keep working exactly as before
// ---------------------------------------------------------------------------

test("the single fetchMedia action keeps its original response shape", async () => {
  const worker = loadWorker();
  const server = installFetch(async () => mediaResponse("single"));

  try {
    const res = await worker.send({
      action: "fetchMedia",
      url: "https://i.pinimg.com/originals/aa/bb/one.jpg",
      isVideo: false,
    });

    assert.equal(res.ok, true);
    assert.equal(typeof res.data, "string");
    assert.equal(res.size, 6);
    assert.equal(decode(res), "single");
  } finally {
    server.restore();
  }
});

test("the single fetchMedia action still refuses a non-Pinterest URL", async () => {
  const worker = loadWorker();
  const server = installFetch(async () => mediaResponse("x"));

  try {
    const res = await worker.send({
      action: "fetchMedia",
      url: "https://evil.example.com/a.jpg",
      isVideo: false,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /Refusing non-Pinterest/);
    assert.equal(server.state.calls.length, 0);
  } finally {
    server.restore();
  }
});
