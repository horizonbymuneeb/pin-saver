/**
 * Integration test: drives the real API client against a fake Pinterest
 * server, so pagination, bookmark handling and error paths are exercised
 * end-to-end instead of only in isolation.
 *
 * Run: node --test test/
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// api.js touches `document`/`location` only inside functions, but a minimal
// stub keeps the module loadable in Node.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.location = { pathname: "/alice/my-board/" };

const api = require(path.join(__dirname, "..", "src", "lib", "api.js"));

/** Build a pin shaped like the resource API returns. */
function pin(id) {
  return {
    id: String(id),
    images: { orig: { url: `https://i.pinimg.com/originals/aa/bb/${id}.jpg` } },
    title: `Pin ${id}`,
  };
}

/**
 * Install a fake fetch that serves a paginated board.
 * Board id is resolved first, then pages are served in bookmark order.
 */
function installFakeBoard(totalPins, pageSize) {
  const calls = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function (url) {
    calls.push(String(url));
    const parsed = new URL(url);

    if (parsed.pathname.includes("BoardResource")) {
      return jsonResponse({
        resource_response: { status: "success", data: { id: "998877" } },
      });
    }

    if (parsed.pathname.includes("BoardFeedResource")) {
      const data = JSON.parse(parsed.searchParams.get("data"));
      const bookmarks = data.options.bookmarks || [];
      // Bookmark encodes the offset, the way Pinterest's opaque cursor does.
      const offset = bookmarks.length ? parseInt(bookmarks[0].split(":")[1], 10) : 0;
      const slice = [];
      for (let i = offset; i < Math.min(offset + pageSize, totalPins); i++) {
        slice.push(pin(i + 1));
      }
      const nextOffset = offset + pageSize;
      const bookmark = nextOffset < totalPins ? `b:${nextOffset}` : "-end-";
      return jsonResponse({
        resource_response: { status: "success", data: slice, bookmark: bookmark },
      });
    }

    throw new Error("Unexpected URL in fake server: " + url);
  };

  return {
    calls: calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

test("fetchBoardId resolves the numeric id from BoardResource", async () => {
  const server = installFakeBoard(10, 5);
  try {
    const id = await api.fetchBoardId("/alice/my-board/");
    assert.equal(id, "998877");
    assert.ok(
      server.calls.some((u) => u.includes("BoardResource")),
      "must call BoardResource",
    );
  } finally {
    server.restore();
  }
});

test("fetchAllBoardPins walks every page and returns the full board", async () => {
  const server = installFakeBoard(120, 50);
  try {
    const pins = await api.fetchAllBoardPins("998877", null);
    assert.equal(pins.length, 120, "should collect all 120 pins across pages");
    // Ids must be present and unique.
    const ids = new Set(pins.map((p) => p.id));
    assert.equal(ids.size, 120);
    // 120 pins at 50/page = 3 feed calls.
    const feedCalls = server.calls.filter((u) => u.includes("BoardFeedResource"));
    assert.equal(feedCalls.length, 3);
  } finally {
    server.restore();
  }
});

test("fetchAllBoardPins reports progress after each page", async () => {
  const server = installFakeBoard(100, 40);
  const seen = [];
  try {
    await api.fetchAllBoardPins("998877", (count, page) => {
      seen.push([count, page]);
    });
    assert.deepEqual(seen, [
      [40, 1],
      [80, 2],
      [100, 3],
    ]);
  } finally {
    server.restore();
  }
});

test("pagination stops exactly at the -end- bookmark", async () => {
  const server = installFakeBoard(50, 50);
  try {
    const pins = await api.fetchAllBoardPins("998877", null);
    assert.equal(pins.length, 50);
    const feedCalls = server.calls.filter((u) => u.includes("BoardFeedResource"));
    assert.equal(feedCalls.length, 1, "one full page is enough");
  } finally {
    server.restore();
  }
});

test("duplicate pins across pages are de-duplicated by id", async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async function () {
    call++;
    const pins = call === 1 ? [pin(1), pin(2)] : [pin(2), pin(3)];
    return jsonResponse({
      resource_response: {
        data: pins,
        bookmark: call === 1 ? "next" : "-end-",
      },
    });
  };
  try {
    const pins = await api.fetchAllBoardPins("998877", null);
    assert.deepEqual(
      pins.map((p) => p.id),
      ["1", "2", "3"],
      "overlapping pages must not duplicate pin 2",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an API error inside the body is surfaced as an exception", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return jsonResponse({
      resource_response: { error: { message: "Board not found", code: 404 } },
    });
  };
  try {
    await assert.rejects(
      () => api.fetchBoardId("/alice/missing-board/"),
      /Board not found/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a non-OK HTTP status is surfaced as an exception", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return { ok: false, status: 403, json: async () => ({}) };
  };
  try {
    await assert.rejects(
      () => api.fetchBoardId("/alice/my-board/"),
      /HTTP 403/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchBoardId retries with the decoded slug before giving up", async () => {
  const originalFetch = globalThis.fetch;
  const tried = [];
  globalThis.fetch = async function (url) {
    const sourceUrl = new URL(url).searchParams.get("source_url");
    tried.push(sourceUrl);
    // The percent-encoded form fails, the decoded form succeeds.
    if (sourceUrl.includes("%")) {
      return jsonResponse({ resource_response: { error: { message: "nope" } } });
    }
    return jsonResponse({
      resource_response: { status: "success", data: { id: "42" } },
    });
  };
  try {
    const id = await api.fetchBoardId("/bob/%D8%A8%D9%88%D8%B1%DA%88/");
    assert.equal(id, "42");
    assert.equal(tried.length, 2, "must try encoded then decoded slug");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Board sections → archive folders
//
// A bare board feed returns no section information at all, so pins can only be
// attributed to a folder by asking the section endpoints. These tests pin that
// behaviour down.
// ---------------------------------------------------------------------------

test("fetchBoardSections returns an empty list for a sectionless board", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return jsonResponse({
      resource_response: { status: "success", data: [], bookmark: null },
    });
  };
  try {
    const sections = await api.fetchBoardSections("777");
    assert.deepEqual(sections, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchBoardSections reads id and name from the payload", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return jsonResponse({
      resource_response: {
        status: "success",
        data: [
          { id: "s1", name: "Ideas", slug: "ideas" },
          { id: "s2", name: "Recipes", slug: "recipes" },
        ],
      },
    });
  };
  try {
    const sections = await api.fetchBoardSections("777");
    assert.equal(sections.length, 2);
    assert.equal(sections[0].name, "Ideas");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sectioned pins are tagged with the folder path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url) {
    const u = String(url);
    if (u.includes("BoardSectionsResource")) {
      return jsonResponse({
        resource_response: { status: "success", data: [{ id: "s1", name: "Ideas", slug: "ideas" }] },
      });
    }
    if (u.includes("BoardSectionPinsResource")) {
      return jsonResponse({
        resource_response: {
          data: [{ id: "555", images: { orig: { url: "u" } } }],
          bookmark: "-end-",
        },
      });
    }
    return jsonResponse({ resource_response: { data: [], bookmark: "-end-" } });
  };
  try {
    const pins = await api.fetchAllBoardPins("777", null);
    const sectioned = pins.find((p) => p.id === "555");
    assert.ok(sectioned, "sectioned pin must be collected");
    assert.deepEqual(sectioned.sectionPath, ["Ideas"], "folder path attached");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failing sections call does not lose the board pins", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url) {
    const u = String(url);
    if (u.includes("BoardSectionsResource")) throw new Error("boom");
    return jsonResponse({
      resource_response: {
        data: [{ id: "1", images: { orig: { url: "u" } } }],
        bookmark: "-end-",
      },
    });
  };
  try {
    const pins = await api.fetchAllBoardPins("777", null);
    assert.equal(pins.length, 1, "board pins survive a sections failure");
    assert.equal(pins[0].sectionPath, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sectioned and sectionless pins are de-duplicated by id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url) {
    const u = String(url);
    if (u.includes("BoardSectionsResource")) {
      return jsonResponse({
        resource_response: { status: "success", data: [{ id: "s1", name: "Ideas", slug: "ideas" }] },
      });
    }
    if (u.includes("BoardSectionPinsResource")) {
      return jsonResponse({
        resource_response: {
          data: [{ id: "1", images: { orig: { url: "u" } } }],
          bookmark: "-end-",
        },
      });
    }
    return jsonResponse({
      resource_response: {
        data: [{ id: "1", images: { orig: { url: "u" } } }],
        bookmark: "-end-",
      },
    });
  };
  try {
    const pins = await api.fetchAllBoardPins("777", null);
    assert.equal(pins.length, 1, "the same pin must not appear twice");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Section request shape
//
// Production rejects BoardSectionPinsResource with page_size 250 (HTTP 400
// "Invalid parameters") while accepting 50. The board feed and the section feed
// do not share the same limit, so this guards the two constants separately.
// ---------------------------------------------------------------------------

test("section requests use the smaller section page size", async () => {
  const originalFetch = globalThis.fetch;
  let sectionOptions = null;

  globalThis.fetch = async function (url) {
    const u = String(url);
    if (u.includes("BoardSectionsResource")) {
      return jsonResponse({
        resource_response: { status: "success", data: [{ id: "s1", name: "Ideas", slug: "ideas" }] },
      });
    }
    if (u.includes("BoardSectionPinsResource")) {
      const data = JSON.parse(new URL(u).searchParams.get("data"));
      sectionOptions = data.options;
      return jsonResponse({
        resource_response: { data: [], bookmark: "-end-" },
      });
    }
    return jsonResponse({ resource_response: { data: [], bookmark: "-end-" } });
  };

  try {
    await api.fetchAllBoardPins("777", null);
    assert.ok(sectionOptions, "section endpoint must be called");
    assert.equal(sectionOptions.page_size, 50, "section page_size must be 50");
    assert.equal(sectionOptions.section_id, "s1", "section_id must be sent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the board feed keeps the larger page size", async () => {
  const originalFetch = globalThis.fetch;
  let feedOptions = null;

  globalThis.fetch = async function (url) {
    const u = String(url);
    if (u.includes("BoardSectionsResource")) {
      return jsonResponse({ resource_response: { status: "success", data: [] } });
    }
    if (u.includes("BoardFeedResource")) {
      const data = JSON.parse(new URL(u).searchParams.get("data"));
      feedOptions = data.options;
    }
    return jsonResponse({ resource_response: { data: [], bookmark: "-end-" } });
  };

  try {
    await api.fetchAllBoardPins("777", null);
    assert.ok(feedOptions, "board feed must be called");
    assert.equal(feedOptions.page_size, 250, "board feed page_size must be 250");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
