/**
 * Unit tests for the pin range selector.
 *
 * A board can hold hundreds of pins and the user usually wants a slice of
 * it: "the first 50", "pins 100 to 150", "just the last 20". The range field
 * therefore has to understand a small, forgiving grammar, and it must never
 * make the user guess what went wrong.
 *
 * Run: node --test test/range.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const range = require(path.join(__dirname, "..", "src", "lib", "range.js"));

/** A board of `count` pins, each one carrying its 1-based position. */
function board(count) {
  const pins = [];
  for (let i = 1; i <= count; i++) pins.push({ id: "pin-" + i, pos: i });
  return pins;
}

/** The positions of a successful parse, or null when the expression is bad. */
function positionsOf(text, total) {
  const result = range.parse(text, total);
  if (!result.ok) return null;
  return result.positions;
}

// ---------------------------------------------------------------------------
// The accepted grammar
// ---------------------------------------------------------------------------

test("a span selects every position it covers", () => {
  assert.deepEqual(positionsOf("1-3", 10), [1, 2, 3]);
});

test("a single number selects one pin", () => {
  assert.deepEqual(positionsOf("5", 10), [5]);
});

test("a headless span selects the first pins", () => {
  assert.deepEqual(positionsOf("-2", 10), [1, 2]);
});

test("an open tail selects from that pin to the end", () => {
  assert.deepEqual(positionsOf("2-", 5), [2, 3, 4, 5]);
});

test("all selects every pin", () => {
  assert.deepEqual(positionsOf("all", 4), [1, 2, 3, 4]);
});

test("an empty field selects every pin", () => {
  assert.deepEqual(positionsOf("", 4), [1, 2, 3, 4]);
  assert.deepEqual(positionsOf("   ", 4), [1, 2, 3, 4]);
});

test("whitespace around the parts is ignored", () => {
  assert.deepEqual(positionsOf(" 1-3 , 5 ", 10), [1, 2, 3, 5]);
});

test("several parts are all honoured", () => {
  assert.deepEqual(positionsOf("1-3, 80, 100-", 120), [
    1, 2, 3, 80, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111,
    112, 113, 114, 115, 116, 117, 118, 119, 120,
  ]);
});

// ---------------------------------------------------------------------------
// Merging, sorting and clamping
// ---------------------------------------------------------------------------

test("overlapping parts merge and the result is sorted", () => {
  assert.deepEqual(positionsOf("5,1-3,2", 10), [1, 2, 3, 5]);
});

test("the same pin is never listed twice", () => {
  assert.deepEqual(positionsOf("1-3,2-4,3", 10), [1, 2, 3, 4]);
});

test("a lone position past the end selects nothing without an error", () => {
  // "500" on a 10-pin board is a typo, not a request for the last pin.
  const result = range.parse("500", 10);
  assert.equal(result.ok, true, "a position past the end is not an error");
  assert.equal(result.error, null);
  assert.deepEqual(result.positions, []);
});

test("a lone position past the end behaves like a range past the end", () => {
  assert.deepEqual(
    range.parse("500", 10).positions,
    range.parse("500-600", 10).positions,
    "both expressions point past the end and must select the same",
  );
});

test("the end of a span is clamped to the board", () => {
  assert.deepEqual(positionsOf("8-500", 10), [8, 9, 10]);
});

test("a range that starts past the end selects nothing without an error", () => {
  const result = range.parse("500-600", 10);
  assert.equal(result.ok, true, "a range past the end is not an error");
  assert.equal(result.error, null);
  assert.deepEqual(result.positions, []);
});

test("an open tail past the end selects nothing without an error", () => {
  const result = range.parse("500-", 10);
  assert.equal(result.ok, true);
  assert.deepEqual(result.positions, []);
});

test("an empty board selects nothing", () => {
  assert.deepEqual(positionsOf("all", 0), []);
  assert.deepEqual(positionsOf("1-50", 0), []);
  assert.deepEqual(positionsOf("1", 0), []);
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test("a backwards range is an error", () => {
  const result = range.parse("50-10", 100);
  assert.equal(result.ok, false);
  assert.deepEqual(result.positions, []);
  assert.match(result.error, /50-10/, "the error names the offending range");
  assert.match(result.error, /backwards/, "the error says what is wrong");
});

test("pin number zero is an error", () => {
  const result = range.parse("0", 100);
  assert.equal(result.ok, false);
  assert.deepEqual(result.positions, []);
  assert.match(result.error, /start at 1/, "the error says what is wrong");
});

test("a zero inside a range is an error", () => {
  assert.equal(range.parse("0-10", 100).ok, false);
  assert.equal(range.parse("5-0", 100).ok, false);
  assert.equal(range.parse("-0", 100).ok, false);
});

test("a negative pin number is an error", () => {
  const result = range.parse("1--5", 100);
  assert.equal(result.ok, false);
  assert.deepEqual(result.positions, []);
  assert.match(result.error, /start at 1/, "the error says what is wrong");
});

test("a non-numeric part is an error", () => {
  const result = range.parse("abc", 100);
  assert.equal(result.ok, false);
  assert.deepEqual(result.positions, []);
  assert.match(result.error, /abc/, "the error names the offending part");
});

test("a non-numeric part spoils the whole expression", () => {
  assert.equal(range.parse("1-3, abc", 100).ok, false);
  assert.equal(range.parse("1.5", 100).ok, false);
  assert.equal(range.parse("1-2-3", 100).ok, false);
});

test("a stray comma leaves an empty part and is an error", () => {
  const result = range.parse("1,,3", 100);
  assert.equal(result.ok, false);
  assert.deepEqual(result.positions, []);
  assert.match(result.error, /empty part/, "the error says what is wrong");
});

test("a lone dash is an error", () => {
  const result = range.parse("-", 100);
  assert.equal(result.ok, false);
  assert.match(result.error, /missing a number/, "the error says what is wrong");
});

// ---------------------------------------------------------------------------
// select()
// ---------------------------------------------------------------------------

test("select maps positions onto the pin objects", () => {
  const pins = board(5);
  const result = range.select(pins, "2-4");
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.positions, [2, 3, 4]);
  assert.deepEqual(
    result.pins.map((p) => p.id),
    ["pin-2", "pin-3", "pin-4"],
  );
});

test("select keeps the pins in board order", () => {
  const pins = board(5);
  const result = range.select(pins, "5,1-3,2");
  assert.deepEqual(
    result.pins.map((p) => p.id),
    ["pin-1", "pin-2", "pin-3", "pin-5"],
  );
});

test("select returns every pin for an empty range", () => {
  const pins = board(3);
  const result = range.select(pins, "");
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.pins.map((p) => p.id),
    ["pin-1", "pin-2", "pin-3"],
  );
});

test("select returns nothing for a bad expression", () => {
  const result = range.select(board(5), "50-10");
  assert.equal(result.ok, false);
  assert.deepEqual(result.pins, []);
  assert.deepEqual(result.positions, []);
  assert.match(result.error, /backwards/);
});

test("select survives a board that is not an array", () => {
  const result = range.select(null, "1-2");
  assert.equal(result.ok, true);
  assert.deepEqual(result.pins, []);
  assert.deepEqual(result.positions, []);
});

test("select on an empty board returns nothing", () => {
  const result = range.select([], "1-50");
  assert.equal(result.ok, true);
  assert.deepEqual(result.pins, []);
});
