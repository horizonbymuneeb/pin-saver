/**
 * Tests for the archive sort order.
 *
 * The archive is written in the order the API returned the pins, which is
 * useless for finding one photo in a board with hundreds of pins. What must
 * hold here: the order the user picks is applied, the comparison ignores
 * case, pins whose titles compare equal keep their original relative order
 * (a stable sort), and — the part that is easy to break — the caller's pin
 * list is never modified.
 *
 * Run: node --test test/sort.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// util.js attaches PK.util to the global namespace; sort.js looks the title
// helper up there, so it has to be loaded first.
const util = require(path.join(__dirname, "..", "src", "lib", "util.js"));
const sort = require(path.join(__dirname, "..", "src", "lib", "sort.js"));

/** A pin with a plain title. */
function pin(id, title) {
  return { id: id, title: title };
}

/** The ids of a pin list, so an order can be asserted compactly. */
function ids(pins) {
  return pins.map((p) => p.id);
}

// ---------------------------------------------------------------------------
// The order list
// ---------------------------------------------------------------------------

test("ORDERS lists the four selectable orders", () => {
  assert.deepEqual(
    sort.ORDERS.map((o) => o.id),
    ["board", "title-asc", "title-desc", "longest"],
  );
});

test("ORDERS gives every order a label for the selector", () => {
  assert.deepEqual(
    sort.ORDERS.map((o) => o.label),
    ["Board order", "Title A-Z", "Title Z-A", "Longest title first"],
  );
});

// ---------------------------------------------------------------------------
// Board order
// ---------------------------------------------------------------------------

test("board order keeps the input order", () => {
  const pins = [pin("c", "C"), pin("a", "A"), pin("b", "B")];
  assert.deepEqual(ids(sort.order(pins, "board")), ["c", "a", "b"]);
});

test("board order returns a new array, not the same reference", () => {
  const pins = [pin("a", "A"), pin("b", "B")];
  const result = sort.order(pins, "board");
  assert.notStrictEqual(result, pins);
  assert.deepEqual(result, pins);
});

test("board order is the default when no order is given", () => {
  const pins = [pin("b", "B"), pin("a", "A")];
  assert.deepEqual(ids(sort.order(pins)), ["b", "a"]);
  assert.deepEqual(ids(sort.order(pins, undefined)), ["b", "a"]);
});

// ---------------------------------------------------------------------------
// Title order
// ---------------------------------------------------------------------------

test("title-asc sorts A-Z", () => {
  const pins = [pin("c", "Cherry"), pin("a", "Apple"), pin("b", "Banana")];
  assert.deepEqual(ids(sort.order(pins, "title-asc")), ["a", "b", "c"]);
});

test("title-asc ignores case", () => {
  const pins = [pin("a", "apple"), pin("b", "Banana"), pin("c", "cherry")];
  assert.deepEqual(ids(sort.order(pins, "title-asc")), ["a", "b", "c"]);
});

test("title-desc sorts Z-A", () => {
  const pins = [pin("a", "Apple"), pin("b", "Banana"), pin("c", "Cherry")];
  assert.deepEqual(ids(sort.order(pins, "title-desc")), ["c", "b", "a"]);
});

test("title-desc ignores case", () => {
  const pins = [pin("a", "apple"), pin("b", "Banana"), pin("c", "cherry")];
  assert.deepEqual(ids(sort.order(pins, "title-desc")), ["c", "b", "a"]);
});

test("the title comes from the shared pinTitle helper", () => {
  // Pinterest stores the text in different fields per pin type, so the
  // helper in util.js is the only place that knows where to look.
  const pins = [
    { id: "note", note: "Alpha" },
    { id: "desc", description: "Bravo" },
    { id: "grid", grid_title: "Charlie" },
    { id: "idea", story_pin_data: { metadata: { title: "Delta" } } },
    pin("plain", "Echo"),
  ];
  assert.deepEqual(ids(sort.order(pins, "title-asc")), ["note", "desc", "grid", "idea", "plain"]);
});

// ---------------------------------------------------------------------------
// Stability
// ---------------------------------------------------------------------------

test("pins with equal titles keep their original relative order", () => {
  const pins = [
    pin("first", "Same"),
    pin("apple", "apple"),
    pin("second", "SAME"),
    pin("banana", "Banana"),
  ];
  // "Same" and "SAME" compare equal, so they stay in the order they came in.
  assert.deepEqual(ids(sort.order(pins, "title-asc")), ["apple", "banana", "first", "second"]);
});

test("equal titles keep their original relative order when reversed", () => {
  const pins = [
    pin("first", "Same"),
    pin("apple", "apple"),
    pin("second", "SAME"),
    pin("banana", "Banana"),
  ];
  // Sorting ascending and reversing the result would swap "first" and
  // "second"; comparing in the other direction must not.
  assert.deepEqual(ids(sort.order(pins, "title-desc")), ["first", "second", "banana", "apple"]);
});

test("equal length titles keep their original relative order", () => {
  const pins = [pin("first", "abcd"), pin("longer", "abcdef"), pin("second", "ABCD")];
  assert.deepEqual(ids(sort.order(pins, "longest")), ["longer", "first", "second"]);
});

// ---------------------------------------------------------------------------
// Longest title first
// ---------------------------------------------------------------------------

test("longest puts the longest title first", () => {
  const pins = [pin("s", "Two"), pin("l", "The longest title here"), pin("m", "Middle one")];
  assert.deepEqual(ids(sort.order(pins, "longest")), ["l", "m", "s"]);
});

test("longest measures the title, not the whole pin", () => {
  const pins = [
    { id: "verbose", description: "x".repeat(200), title: "Short" },
    { id: "long", title: "A somewhat longer title" },
  ];
  assert.deepEqual(ids(sort.order(pins, "longest")), ["long", "verbose"]);
});

// ---------------------------------------------------------------------------
// Fallbacks and edge cases
// ---------------------------------------------------------------------------

test("an unknown order falls back to the board order", () => {
  const pins = [pin("c", "C"), pin("a", "A"), pin("b", "B")];
  assert.deepEqual(ids(sort.order(pins, "nonsense")), ["c", "a", "b"]);
  assert.deepEqual(ids(sort.order(pins, "")), ["c", "a", "b"]);
  assert.deepEqual(ids(sort.order(pins, null)), ["c", "a", "b"]);
  assert.deepEqual(ids(sort.order(pins, 42)), ["c", "a", "b"]);
});

test("an unknown order still returns a new array", () => {
  const pins = [pin("a", "A")];
  assert.notStrictEqual(sort.order(pins, "nonsense"), pins);
});

test("an empty list is handled", () => {
  for (const order of ["board", "title-asc", "title-desc", "longest", "nonsense"]) {
    const result = sort.order([], order);
    assert.deepEqual(result, []);
    assert.equal(result.length, 0);
  }
});

test("null and undefined are handled", () => {
  assert.deepEqual(sort.order(null, "title-asc"), []);
  assert.deepEqual(sort.order(undefined, "title-asc"), []);
  assert.deepEqual(sort.order(null), []);
});

test("pins without a title are sorted as empty titles", () => {
  const pins = [pin("none", ""), pin("b", "B"), pin("empty", {})];
  const result = sort.order(pins, "title-asc");
  assert.equal(result.length, 3);
  // Both untitled pins sort before "B", and because they compare equal they
  // keep the order they came in.
  assert.deepEqual(ids(result), ["none", "empty", "b"]);
});

// ---------------------------------------------------------------------------
// The caller's list
// ---------------------------------------------------------------------------

test("the input array is not modified", () => {
  const pins = [pin("c", "C"), pin("a", "A"), pin("b", "B")];
  const before = ids(pins);
  sort.order(pins, "title-asc");
  sort.order(pins, "title-desc");
  sort.order(pins, "longest");
  assert.deepEqual(ids(pins), before);
  assert.deepEqual(before, ["c", "a", "b"]);
});

test("the result holds the same pin objects", () => {
  const pins = [pin("b", "B"), pin("a", "A")];
  const result = sort.order(pins, "title-asc");
  assert.strictEqual(result[0], pins[1]);
  assert.strictEqual(result[1], pins[0]);
});
