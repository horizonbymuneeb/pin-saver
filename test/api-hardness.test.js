/**
 * Hardening tests for the Pinterest resource client.
 *
 * On boards with 500+ pins Pinterest intermittently answers a single page
 * request with HTTP 500. That failure used to escape the pagination loop and
 * abort the whole download, so the user ended up with no archive at all.
 *
 * These tests pin down the contract that replaces it:
 *   - a page that cannot be read costs only the pins behind it,
 *   - the pins already collected are always kept,
 *   - the caller is told what was skipped,
 *   - a cancelled export rejects instead of returning partial data.
 *
 * Run: node --test test/api-hardness.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// api.js touches `document`/`location` only inside functions, but a minimal
// stub keeps the module loadable in Node.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.location = { pathname: "/alice/my-board/" };

const api = require(path.join(__dirname, "..", "src", "lib", "api.js"));

// ---------------------------------------------------------------------------
// Fake Pinterest
// ---------------------------------------------------------------------------

/** Build a pin shaped like the resource API returns. */
function pin(id) {
  return {
    id: String(id),
    images: { orig: { url: `https://i.pinimg.com/originals/aa/bb/${id}.jpg` } },
    title: `Pin ${id}`,
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function httpError(status) {
  return { ok: false, status: status, json: async () => ({}) };
}

/** The error a browser produces for an aborted fetch. */
function abortError() {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  return err;
}

/**
 * Install a fake fetch that dispatches on the resource name.
 *
 * Every route is `{ resource, handle(url) }`. The fake honours the abort
 * signal, like a real `fetch` does.
 */
function installFetch(routes) {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async function (url, init) {
    calls.push(String(url));
    if (init && init.signal && init.signal.aborted) throw abortError();
    const u = String(url);
    for (const route of routes) {
      if (!u.includes(route.resource)) continue;
      return route.handle(u);
    }
    throw new Error("Unexpected URL in fake server: " + u);
  };

  return {
    calls: calls,
    callsTo(resource) {
      return calls.filter((u) => u.includes(resource)).length;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

/**
 * The page index a request asks for.
 *
 * Pinterest's cursor is opaque; the fake encodes the page number in it, the
 * way the integration test does. Keying the pages on the cursor instead of
 * on the call count matters: a retried page has to serve the same page again.
 */
function requestedPage(url) {
  const data = JSON.parse(new URL(url).searchParams.get("data"));
  const bookmarks = data.options.bookmarks || [];
  if (!bookmarks.length) return 0;
  return parseInt(String(bookmarks[0]).split(":")[1], 10);
}

/**
 * Serve a paginated board feed.
 *
 * `pages[i]` is the page requested with the cursor "b:i"; the string "fail"
 * answers with HTTP 500 instead of a page.
 */
function boardFeedRoute(pages) {
  return {
    resource: "BoardFeedResource",
    handle(url) {
      const index = requestedPage(url);
      const spec = pages[index];
      if (!spec) throw new Error("Unexpected board page: " + index);
      if (spec === "fail") return httpError(500);
      return jsonResponse({
        resource_response: {
          status: "success",
          data: spec.pins,
          bookmark: spec.bookmark,
        },
      });
    },
  };
}

/** Serve the section list of a board. */
function sectionsRoute(sections) {
  return {
    resource: "BoardSectionsResource",
    handle() {
      return jsonResponse({
        resource_response: {
          status: "success",
          data: sections,
          bookmark: "-end-",
        },
      });
    },
  };
}

/**
 * Serve the pins of each section. `specs` maps a section id to its list of
 * pages; the string "fail" answers with HTTP 500.
 */
function sectionPinsRoute(specs) {
  return {
    resource: "BoardSectionPinsResource",
    handle(url) {
      const data = JSON.parse(new URL(url).searchParams.get("data"));
      const sectionId = String(data.options.section_id);
      const pages = specs[sectionId] || [];
      const spec = pages[requestedPage(url)];
      if (!spec) throw new Error("Unexpected section page for " + sectionId);
      if (spec === "fail") return httpError(500);
      return jsonResponse({
        resource_response: {
          status: "success",
          data: spec.pins,
          bookmark: spec.bookmark,
        },
      });
    },
  };
}

/** Collect every progress callback invocation as [count, page, error]. */
function progressRecorder() {
  const seen = [];
  const onProgress = (count, page, error) => {
    seen.push([count, page, error]);
  };
  onProgress.seen = seen;
  onProgress.errors = () => seen.filter((row) => row[2] !== undefined);
  return onProgress;
}

// ---------------------------------------------------------------------------
// A failed page must never destroy the download
// ---------------------------------------------------------------------------

test("a page that fails permanently keeps the pins of the other pages", async () => {
  // Three pages, the middle one always answers HTTP 500.
  const server = installFetch([
    boardFeedRoute([
      { pins: [pin(1), pin(2)], bookmark: "b:1" },
      "fail",
      { pins: [pin(5)], bookmark: "-end-" },
    ]),
    sectionsRoute([]),
  ]);
  const progress = progressRecorder();
  try {
    const pins = await api.fetchAllBoardPins("998877", progress);
    assert.equal(pins.length, 2, "the pins before the failed page survive");
    assert.deepEqual(
      pins.map((p) => p.id),
      ["1", "2"],
    );
    const failures = progress.errors();
    assert.equal(failures.length, 1, "the skipped page is reported once");
    assert.equal(failures[0][1], 2, "the report names the failed page");
    assert.equal(failures[0][0], 2, "the report carries the pins collected");
  } finally {
    server.restore();
  }
});

test("a failed last page still returns every earlier pin", async () => {
  const server = installFetch([
    boardFeedRoute([
      { pins: [pin(1), pin(2)], bookmark: "b:1" },
      { pins: [pin(3), pin(4)], bookmark: "b:2" },
      "fail",
    ]),
    sectionsRoute([]),
  ]);
  const progress = progressRecorder();
  try {
    const pins = await api.fetchAllBoardPins("998877", progress);
    assert.equal(pins.length, 4, "every pin before the failed page survives");
    assert.equal(progress.errors().length, 1, "the failure is reported");
  } finally {
    server.restore();
  }
});

test("a failed page is reported with the HTTP status and message", async () => {
  const server = installFetch([
    boardFeedRoute(["fail"]),
    sectionsRoute([]),
  ]);
  const progress = progressRecorder();
  try {
    await api.fetchAllBoardPins("998877", progress);
    const failures = progress.errors();
    assert.equal(failures.length, 1);
    const err = failures[0][2];
    assert.ok(err, "an error is handed to the caller");
    assert.equal(err.status, 500, "the HTTP status is preserved");
    assert.match(err.message, /500/, "the message names the status");
  } finally {
    server.restore();
  }
});

test("a failed board feed does not stop the section feeds", async () => {
  // The board feed is broken, but the section feed still answers.
  const server = installFetch([
    boardFeedRoute(["fail"]),
    sectionsRoute([{ id: "s1", name: "Ideas", slug: "ideas" }]),
    sectionPinsRoute({
      s1: [{ pins: [pin(9)], bookmark: "-end-" }],
    }),
  ]);
  const progress = progressRecorder();
  try {
    const pins = await api.fetchAllBoardPins("998877", progress);
    assert.equal(pins.length, 1, "the section pin is still collected");
    assert.deepEqual(pins[0].sectionPath, ["Ideas"]);
    assert.equal(progress.errors().length, 1, "only the feed failure is reported");
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// A transient failure that recovers must not be reported at all
// ---------------------------------------------------------------------------

test("a 500 that succeeds on retry loses no pin and reports no failure", async () => {
  let feedCalls = 0;
  const server = installFetch([
    {
      resource: "BoardFeedResource",
      handle() {
        feedCalls++;
        if (feedCalls === 1) return httpError(500);
        return jsonResponse({
          resource_response: {
            status: "success",
            data: [pin(1), pin(2)],
            bookmark: "-end-",
          },
        });
      },
    },
    sectionsRoute([]),
  ]);
  const progress = progressRecorder();
  try {
    const pins = await api.fetchAllBoardPins("998877", progress);
    assert.equal(pins.length, 2, "the retried page is delivered");
    assert.equal(progress.errors().length, 0, "a recovered page is not a failure");
  } finally {
    server.restore();
  }
});

test("a page that survives the pagination-level retry is not reported", async () => {
  // The three internal retries fail, the extra page-level attempt succeeds.
  let feedCalls = 0;
  const server = installFetch([
    {
      resource: "BoardFeedResource",
      handle() {
        feedCalls++;
        if (feedCalls <= 4) return httpError(500);
        return jsonResponse({
          resource_response: {
            status: "success",
            data: [pin(1)],
            bookmark: "-end-",
          },
        });
      },
    },
    sectionsRoute([]),
  ]);
  const progress = progressRecorder();
  try {
    const pins = await api.fetchAllBoardPins("998877", progress);
    assert.equal(pins.length, 1, "the recovered page is delivered");
    assert.equal(progress.errors().length, 0, "nothing was skipped");
    assert.equal(feedCalls, 5, "3 internal retries plus one page-level retry");
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// Transient vs permanent failures
// ---------------------------------------------------------------------------

test("a permanent 404 is not retried", async () => {
  const server = installFetch([
    {
      resource: "BoardFeedResource",
      handle() {
        return httpError(404);
      },
    },
    sectionsRoute([]),
  ]);
  const progress = progressRecorder();
  try {
    const pins = await api.fetchAllBoardPins("998877", progress);
    assert.equal(pins.length, 0);
    assert.equal(
      server.callsTo("BoardFeedResource"),
      1,
      "a missing board must not be retried",
    );
    const failures = progress.errors();
    assert.equal(failures.length, 1, "the failure is still reported");
    assert.equal(failures[0][2].status, 404);
  } finally {
    server.restore();
  }
});

test("a permanent in-body API error is not retried", async () => {
  const server = installFetch([
    {
      resource: "BoardFeedResource",
      handle() {
        return jsonResponse({
          resource_response: {
            error: { message: "Board not found", code: 404 },
          },
        });
      },
    },
    sectionsRoute([]),
  ]);
  const progress = progressRecorder();
  try {
    await api.fetchAllBoardPins("998877", progress);
    assert.equal(
      server.callsTo("BoardFeedResource"),
      1,
      "an in-body error is a definitive answer",
    );
    assert.equal(progress.errors().length, 1, "the failure is reported");
  } finally {
    server.restore();
  }
});

test("a transient 500 is retried before the page is given up", async () => {
  const server = installFetch([
    {
      resource: "BoardFeedResource",
      handle() {
        return httpError(500);
      },
    },
    sectionsRoute([]),
  ]);
  const progress = progressRecorder();
  try {
    await api.fetchAllBoardPins("998877", progress);
    assert.equal(
      server.callsTo("BoardFeedResource"),
      6,
      "two rounds of three internal attempts",
    );
    assert.equal(progress.errors().length, 1, "the failure is reported once");
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

test("a section whose pins fail does not lose the section-less pins", async () => {
  const server = installFetch([
    boardFeedRoute([{ pins: [pin(1), pin(2)], bookmark: "-end-" }]),
    sectionsRoute([{ id: "s1", name: "Ideas", slug: "ideas" }]),
    sectionPinsRoute({ s1: ["fail"] }),
  ]);
  const progress = progressRecorder();
  try {
    const pins = await api.fetchAllBoardPins("998877", progress);
    assert.equal(pins.length, 2, "the section-less pins survive");
    assert.equal(pins[0].sectionPath, undefined);
    assert.equal(progress.errors().length, 1, "the failed section is reported");
  } finally {
    server.restore();
  }
});

test("a failed section does not stop the other sections", async () => {
  const server = installFetch([
    boardFeedRoute([{ pins: [pin(1)], bookmark: "-end-" }]),
    sectionsRoute([
      { id: "s1", name: "Broken", slug: "broken" },
      { id: "s2", name: "Recipes", slug: "recipes" },
    ]),
    sectionPinsRoute({
      s1: ["fail"],
      s2: [{ pins: [pin(7)], bookmark: "-end-" }],
    }),
  ]);
  const progress = progressRecorder();
  try {
    const pins = await api.fetchAllBoardPins("998877", progress);
    const sectioned = pins.find((p) => p.id === "7");
    assert.ok(sectioned, "the healthy section is still read");
    assert.deepEqual(sectioned.sectionPath, ["Recipes"]);
    assert.equal(progress.errors().length, 1, "only the broken section is reported");
  } finally {
    server.restore();
  }
});

test("a failed section page keeps the pins of that section collected so far", async () => {
  const server = installFetch([
    boardFeedRoute([{ pins: [], bookmark: "-end-" }]),
    sectionsRoute([{ id: "s1", name: "Ideas", slug: "ideas" }]),
    sectionPinsRoute({
      s1: [{ pins: [pin(3)], bookmark: "b:1" }, "fail"],
    }),
  ]);
  try {
    const pins = await api.fetchAllBoardPins("998877", null);
    assert.equal(pins.length, 1, "the first section page survives");
    assert.equal(pins[0].id, "3");
  } finally {
    server.restore();
  }
});

test("a failing sections call does not lose the board pins", async () => {
  const server = installFetch([
    boardFeedRoute([{ pins: [pin(1)], bookmark: "-end-" }]),
    {
      resource: "BoardSectionsResource",
      handle() {
        return httpError(500);
      },
    },
  ]);
  const progress = progressRecorder();
  try {
    const pins = await api.fetchAllBoardPins("998877", progress);
    assert.equal(pins.length, 1, "the board pins survive");
    assert.equal(pins[0].sectionPath, undefined);
    // The board feed already carried every pin, so only the folder
    // attribution is lost: no pin was skipped, so nothing is reported.
    assert.equal(progress.errors().length, 0, "no pin was skipped");
    assert.deepEqual(
      progress.seen.map((row) => [row[0], row[1]]),
      [[1, 1]],
      "the progress sequence is unchanged",
    );
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test("an aborted signal rejects instead of returning partial data", async () => {
  const controller = new AbortController();
  const server = installFetch([
    {
      resource: "BoardFeedResource",
      handle() {
        // The user cancels while the first page is on its way.
        controller.abort();
        return jsonResponse({
          resource_response: {
            status: "success",
            data: [pin(1)],
            bookmark: "b:1",
          },
        });
      },
    },
    sectionsRoute([]),
  ]);
  try {
    await assert.rejects(
      () => api.fetchAllBoardPins("998877", null, controller.signal),
      (err) => {
        assert.equal(err.name, "AbortError", "an abort is not a page failure");
        return true;
      },
    );
  } finally {
    server.restore();
  }
});

test("a signal that is already aborted rejects immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  const server = installFetch([
    boardFeedRoute([{ pins: [pin(1)], bookmark: "-end-" }]),
    sectionsRoute([]),
  ]);
  try {
    await assert.rejects(
      () => api.fetchAllBoardPins("998877", null, controller.signal),
      /abort/i,
    );
    assert.equal(
      server.callsTo("BoardFeedResource"),
      0,
      "an aborted export must not call the API",
    );
  } finally {
    server.restore();
  }
});

test("an abort is never reported as a skipped page", async () => {
  const controller = new AbortController();
  const server = installFetch([
    {
      resource: "BoardFeedResource",
      handle() {
        controller.abort();
        return httpError(500);
      },
    },
    sectionsRoute([]),
  ]);
  const progress = progressRecorder();
  try {
    await assert.rejects(() =>
      api.fetchAllBoardPins("998877", progress, controller.signal),
    );
    assert.equal(
      progress.errors().length,
      0,
      "an abort must not be reported as a failed page",
    );
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

test("a two-argument progress callback keeps working unchanged", async () => {
  const server = installFetch([
    boardFeedRoute([
      { pins: [pin(1), pin(2)], bookmark: "b:1" },
      { pins: [pin(3)], bookmark: "-end-" },
    ]),
    sectionsRoute([]),
  ]);
  const seen = [];
  try {
    await api.fetchAllBoardPins("998877", (count, page) => {
      seen.push([count, page]);
    });
    assert.deepEqual(seen, [
      [2, 1],
      [3, 2],
    ]);
  } finally {
    server.restore();
  }
});

test("a two-argument progress callback survives a failed page", async () => {
  const server = installFetch([
    boardFeedRoute([{ pins: [pin(1)], bookmark: "b:1" }, "fail"]),
    sectionsRoute([]),
  ]);
  const seen = [];
  try {
    const pins = await api.fetchAllBoardPins("998877", (count, page) => {
      seen.push([count, page]);
    });
    assert.equal(pins.length, 1, "the collected pins survive");
    // The failed page is reported through the same callback, so the pin
    // count never grows but the page number moves on.
    assert.deepEqual(seen, [[1, 1], [1, 2]]);
  } finally {
    server.restore();
  }
});
