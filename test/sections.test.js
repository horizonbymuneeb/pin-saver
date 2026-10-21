/**
 * Tests for the single-section export helper.
 *
 * The helper is a thin layer on top of the API client, so the tests drive
 * the real client against a fake Pinterest server: the pagination, the
 * abort handling and the error paths are the ones that actually run in the
 * panel.
 *
 * Run: node --test test/sections.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// api.js touches `document`/`location` only inside functions, but a minimal
// stub keeps the module loadable in Node.
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.location = { pathname: "/alice/my-board/" };

const api = require(path.join(__dirname, "..", "src", "lib", "api.js"));
const sections = require(path.join(__dirname, "..", "src", "lib", "sections.js"));
const util = require(path.join(__dirname, "..", "src", "lib", "util.js"));

/** Build a pin shaped like the resource API returns. */
function pin(id) {
  return {
    id: String(id),
    images: { orig: { url: `https://i.pinimg.com/originals/aa/bb/${id}.jpg` } },
    title: `Pin ${id}`,
  };
}

/** A successful resource answer. */
function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

/**
 * Install a fake fetch for the duration of one test.
 * The handler receives the request URL and answers with a response object.
 */
function installFakeFetch(handler) {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async function (url) {
    calls.push(String(url));
    return handler(String(url));
  };

  return {
    calls: calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

/** The options a resource request carried. */
function requestOptions(url) {
  return JSON.parse(new URL(url).searchParams.get("data")).options;
}

// ---------------------------------------------------------------------------
// Listing the sections of a board
// ---------------------------------------------------------------------------

test("list returns one entry per section with its id and a usable name", async () => {
  const server = installFakeFetch(() =>
    jsonResponse({
      resource_response: {
        status: "success",
        data: [
          { id: "s1", name: "Ideas", slug: "ideas" },
          { id: "s2", name: "Recipes", slug: "recipes" },
        ],
      },
    }),
  );
  try {
    const out = await sections.list("777");
    assert.equal(out.length, 2, "one entry per section");
    assert.equal(out[0].id, "s1");
    assert.equal(out[0].name, "Ideas");
    assert.equal(out[1].id, "s2");
    assert.equal(out[1].name, "Recipes");
    for (const entry of out) {
      assert.equal(typeof entry.name, "string");
      assert.ok(entry.name.length > 0, "the name must never be empty");
    }
    assert.ok(
      server.calls.some((u) => u.includes("BoardSectionsResource")),
      "must ask the API for the sections",
    );
  } finally {
    server.restore();
  }
});

test("list reports a section without a pin count as null", async () => {
  const server = installFakeFetch(() =>
    jsonResponse({
      resource_response: {
        status: "success",
        data: [{ id: "s1", name: "Ideas", slug: "ideas" }],
      },
    }),
  );
  try {
    const out = await sections.list("777");
    assert.equal(out[0].pinCount, null, "a missing count is never invented");
  } finally {
    server.restore();
  }
});

test("list reports the section's own pin count when the API sends one", async () => {
  const server = installFakeFetch(() =>
    jsonResponse({
      resource_response: {
        status: "success",
        data: [{ id: "s1", name: "Ideas", pin_count: 12 }],
      },
    }),
  );
  try {
    const out = await sections.list("777");
    assert.equal(out[0].pinCount, 12);
  } finally {
    server.restore();
  }
});

test("list falls back to a usable name when the section has none", async () => {
  const server = installFakeFetch(() =>
    jsonResponse({
      resource_response: {
        status: "success",
        data: [{ id: "s1", name: "" }, { id: "s2" }],
      },
    }),
  );
  try {
    const out = await sections.list("777");
    for (const entry of out) {
      assert.equal(typeof entry.name, "string");
      assert.ok(entry.name.length > 0, "the name must never be empty");
    }
  } finally {
    server.restore();
  }
});

test("list resolves with an empty array for a board without sections", async () => {
  const server = installFakeFetch(() =>
    jsonResponse({
      resource_response: { status: "success", data: [], bookmark: null },
    }),
  );
  try {
    const out = await sections.list("777");
    assert.deepEqual(out, [], "a board without sections is not an error");
  } finally {
    server.restore();
  }
});

test("list rejects with the error the API layer produced", async () => {
  const server = installFakeFetch(() =>
    jsonResponse({
      resource_response: { error: { message: "Board not found", code: 404 } },
    }),
  );
  try {
    await assert.rejects(() => sections.list("777"), /Board not found/);
  } finally {
    server.restore();
  }
});

test("list rejects when the API answers with an error status", async () => {
  const server = installFakeFetch(() => ({
    ok: false,
    status: 403,
    json: async () => ({}),
  }));
  try {
    await assert.rejects(() => sections.list("777"), /HTTP 403/);
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// Reading the pins of one section
// ---------------------------------------------------------------------------

test("pins returns the section's pins with the section path attached", async () => {
  const server = installFakeFetch((url) => {
    if (url.includes("BoardSectionPinsResource")) {
      return jsonResponse({
        resource_response: {
          data: [pin(555), pin(556)],
          bookmark: "-end-",
        },
      });
    }
    throw new Error("Unexpected URL in fake server: " + url);
  });
  try {
    const found = await sections.pins("777", {
      id: "s1",
      name: "Ideas",
      slug: "ideas",
    });
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((p) => p.id),
      ["555", "556"],
    );
    assert.deepEqual(found[0].sectionPath, ["Ideas"], "folder path attached");
    assert.deepEqual(found[1].sectionPath, ["Ideas"], "folder path attached");
    assert.equal(
      util.sectionFolderPath(found[0], ""),
      "Ideas",
      "the archive can build the folder",
    );
    const options = requestOptions(server.calls[0]);
    assert.equal(options.section_id, "s1", "the section is asked for by id");
  } finally {
    server.restore();
  }
});

test("pins tags the pins with the section that was picked", async () => {
  const server = installFakeFetch((url) => {
    if (url.includes("BoardSectionPinsResource")) {
      return jsonResponse({
        resource_response: { data: [pin(777)], bookmark: "-end-" },
      });
    }
    throw new Error("Unexpected URL in fake server: " + url);
  });
  try {
    const found = await sections.pins("777", { id: "s2", name: "Recipes" });
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].sectionPath, ["Recipes"]);
  } finally {
    server.restore();
  }
});

test("pins rejects with the API error when the section cannot be read", async () => {
  const server = installFakeFetch(() =>
    jsonResponse({
      resource_response: { error: { message: "Section not found" } },
    }),
  );
  try {
    await assert.rejects(
      () => sections.pins("777", { id: "s1", name: "Ideas" }),
      /Section not found/,
    );
  } finally {
    server.restore();
  }
});

test("pins keeps the pins it collected and reports the failed page", async () => {
  let call = 0;
  const server = installFakeFetch(() => {
    call++;
    if (call === 1) {
      return jsonResponse({
        resource_response: { data: [pin(1)], bookmark: "next" },
      });
    }
    return jsonResponse({
      resource_response: { error: { message: "Page failed" } },
    });
  });
  const seen = [];
  try {
    const found = await sections.pins(
      "777",
      { id: "s1", name: "Ideas" },
      {
        onProgress: (count, error) =>
          seen.push([count, error && error.message]),
      },
    );
    assert.equal(found.length, 1, "the pins before the failure are kept");
    assert.deepEqual(found[0].sectionPath, ["Ideas"]);
    assert.equal(seen.length, 1, "the failure is reported, not swallowed");
    assert.equal(seen[0][0], 1);
    assert.match(seen[0][1], /Page failed/);
  } finally {
    server.restore();
  }
});

// ---------------------------------------------------------------------------
// Aborting
// ---------------------------------------------------------------------------

test("an aborted signal rejects the section list", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => sections.list("777", { signal: controller.signal }),
    (err) => {
      assert.equal(err.name, "AbortError");
      return true;
    },
  );
});

test("an aborted signal rejects the section pins", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => sections.pins("777", { id: "s1", name: "Ideas" }, { signal: controller.signal }),
    (err) => {
      assert.equal(err.name, "AbortError");
      return true;
    },
  );
});

test("an abort during the request rejects instead of waiting for the answer", async () => {
  const controller = new AbortController();
  // The fake server never answers, so only the abort can end the call.
  const server = installFakeFetch(() => new Promise(() => {}));
  try {
    const pending = sections.list("777", { signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, /aborted/i);
  } finally {
    server.restore();
  }
});
