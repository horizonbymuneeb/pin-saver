/**
 * Tests for the export runner.
 *
 * The bug behind "Saved 180 pins, 3 skipped" was that the three failures
 * simply vanished: the user was never told which pins were lost and had no
 * way to save them. The runner therefore has to record every failure with
 * its reason, keep the pins that worked, and hand the failed pins back so
 * that only those are retried.
 *
 * Run: node --test test/export.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const exporter = require(path.join(__dirname, "..", "src", "lib", "export.js"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A pin shaped like the resource API returns. */
function pin(id) {
  return { id: String(id), title: "Pin " + id };
}

/** The media a successful fetch produces. */
function media(target) {
  return {
    bytes: new Uint8Array([1, 2, 3]),
    ext: "jpg",
    isVideo: false,
    url: "https://i.pinimg.com/originals/" + target.id + ".jpg",
  };
}

/** A fetch that always succeeds. */
function okFetch() {
  return async function (target) {
    return media(target);
  };
}

/** A promise that resolves after `ms`. */
function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/** A list of `count` pins. */
function pinList(count) {
  const pins = [];
  for (let i = 0; i < count; i++) pins.push(pin(i + 1));
  return pins;
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

test("run keeps the results in the order of the pin list", async () => {
  // The pins finish out of order, so the results cannot be in the order the
  // requests happened to complete in.
  const delays = { 1: 40, 2: 5, 3: 20 };

  const report = await exporter.run([pin(1), pin(2), pin(3)], async (target) => {
    await sleep(delays[target.id] || 0);
    return media(target);
  });

  assert.equal(report.total, 3);
  assert.equal(report.done, 3);
  assert.equal(report.results.length, 3);
  report.results.forEach(function (result, index) {
    assert.notEqual(result, null, "pin " + index + " must have media");
    assert.equal(
      result.url,
      "https://i.pinimg.com/originals/" + (index + 1) + ".jpg",
      "result " + index + " is out of order",
    );
  });
  assert.deepEqual(report.failed, []);
});

test("a failed pin leaves a hole in the results at its own index", async () => {
  const report = await exporter.run([pin(1), pin(2), pin(3)], async (target) => {
    if (target.id === "2") throw new Error("Media HTTP 403");
    return media(target);
  });

  assert.equal(report.results.length, 3);
  assert.notEqual(report.results[0], null);
  assert.equal(report.results[1], null, "the failed pin has no media");
  assert.notEqual(report.results[2], null);
});

// ---------------------------------------------------------------------------
// Failures never abort the run
// ---------------------------------------------------------------------------

test("a throwing fetchOne is recorded as failed and does not abort the run", async () => {
  const attempted = [];

  const report = await exporter.run([pin(1), pin(2), pin(3)], async (target) => {
    attempted.push(target.id);
    if (target.id === "2") throw new Error("Media HTTP 403");
    return media(target);
  });

  assert.deepEqual(attempted.sort(), ["1", "2", "3"], "every pin is attempted");
  assert.equal(report.done, 3);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].pin.id, "2");
  assert.match(report.failed[0].error, /403/, "the failure carries its reason");
  assert.notEqual(report.results[2], null, "the pins after it survive");
});

test("a pin whose fetch resolves null counts as failed", async () => {
  const report = await exporter.run([pin(1), pin(2)], async (target) => {
    if (target.id === "1") return null;
    return media(target);
  });

  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].pin.id, "1");
  assert.ok(report.failed[0].error, "the failure carries a reason");
  assert.equal(report.results[0], null);
  assert.notEqual(report.results[1], null);
});

test("a throwing progress callback does not lose pins", async () => {
  const report = await exporter.run([pin(1), pin(2)], okFetch(), {
    onProgress: function () {
      throw new Error("the panel is broken");
    },
  });

  assert.equal(report.done, 2);
  assert.equal(report.failed.length, 0);
  assert.notEqual(report.results[0], null);
});

// ---------------------------------------------------------------------------
// Retrying only the failed pins
// ---------------------------------------------------------------------------

test("failedPins returns the failed pins in the original order", async () => {
  // The failures complete out of order, so a report built from the order the
  // requests finished in would come out as 3, 1.
  const report = await exporter.run(
    [pin(1), pin(2), pin(3), pin(4)],
    async (target) => {
      if (target.id === "1") {
        await sleep(30);
        throw new Error("boom 1");
      }
      if (target.id === "3") {
        await sleep(5);
        throw new Error("boom 3");
      }
      return media(target);
    },
  );

  assert.deepEqual(
    report.failed.map(function (entry) {
      return entry.pin.id;
    }),
    ["1", "3"],
    "the failures keep the order of the pin list",
  );

  const failed = exporter.failedPins(report);
  assert.equal(failed.length, 2);
  assert.deepEqual(
    failed.map(function (p) {
      return p.id;
    }),
    ["1", "3"],
  );
  assert.equal(failed[0].title, "Pin 1", "the pin objects themselves are returned");
});

test("a retry of only the failed pins saves the rest of the board", async () => {
  const pins = pinList(5);
  let broken = true;

  const first = await exporter.run(pins, async (target) => {
    if (broken && target.id === "2") throw new Error("Media HTTP 403");
    if (broken && target.id === "4") return null;
    return media(target);
  });

  assert.equal(first.failed.length, 2, "two pins are missing from the archive");

  broken = false;
  const retryPins = exporter.failedPins(first);
  assert.equal(retryPins.length, 2);

  const second = await exporter.run(retryPins, okFetch());
  assert.equal(second.done, 2);
  assert.equal(second.failed.length, 0, "the retry saves every pin it was given");
  assert.equal(second.stopped, false);
});

test("failedPins copes with a report that has no failures", async () => {
  assert.deepEqual(exporter.failedPins(null), []);
  assert.deepEqual(exporter.failedPins({}), []);
  const report = await exporter.run([pin(1)], okFetch());
  assert.deepEqual(exporter.failedPins(report), []);
});

// ---------------------------------------------------------------------------
// Bounded concurrency
// ---------------------------------------------------------------------------

test("the run never keeps more fetches in flight than the concurrency limit", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  const report = await exporter.run(
    pinList(12),
    async (target) => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await sleep(10);
      inFlight -= 1;
      return media(target);
    },
    { concurrency: 3 },
  );

  assert.ok(maxInFlight <= 3, "concurrency cap exceeded: " + maxInFlight);
  assert.equal(maxInFlight, 3, "the run must actually fetch in parallel");
  assert.equal(report.done, 12);
  assert.equal(report.failed.length, 0);
});

test("the default concurrency is four", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  await exporter.run(
    pinList(10),
    async (target) => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await sleep(10);
      inFlight -= 1;
      return media(target);
    },
  );

  assert.equal(maxInFlight, 4);
});

test("a concurrency of one fetches the pins one at a time", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  await exporter.run(
    pinList(5),
    async (target) => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await sleep(5);
      inFlight -= 1;
      return media(target);
    },
    { concurrency: 1 },
  );

  assert.equal(maxInFlight, 1);
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

test("onProgress is called once per finished pin with a rising count", async () => {
  const seen = [];

  const report = await exporter.run(
    [pin(1), pin(2), pin(3)],
    async (target) => {
      await sleep(5);
      if (target.id === "2") throw new Error("boom");
      return media(target);
    },
    {
      onProgress: function (done, total) {
        seen.push([done, total]);
      },
    },
  );

  assert.equal(seen.length, 3, "once per finished pin, failures included");
  seen.forEach(function (entry, index) {
    assert.equal(entry[0], index + 1, "the count rises");
    assert.equal(entry[1], 3, "the total is the pin count");
  });
  assert.equal(report.done, 3);
});

test("onProgress is optional", async () => {
  const report = await exporter.run([pin(1)], okFetch());
  assert.equal(report.done, 1);
  assert.equal(report.failed.length, 0);
});

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

test("shouldStop stops the run and reports the untouched pins as failed", async () => {
  const attempted = [];

  const report = await exporter.run(
    [pin(1), pin(2), pin(3), pin(4)],
    async (target) => {
      attempted.push(target.id);
      await sleep(5);
      return media(target);
    },
    {
      concurrency: 1,
      shouldStop: function () {
        return attempted.length >= 2;
      },
    },
  );

  assert.equal(report.stopped, true, "the run reports that it was stopped");
  assert.deepEqual(attempted, ["1", "2"], "no pin is started after the stop");
  assert.equal(report.done, 2, "only the finished pins are counted");
  assert.equal(report.total, 4);

  assert.equal(report.failed.length, 2, "the untouched pins are reported as failed");
  assert.deepEqual(
    report.failed.map(function (entry) {
      return entry.pin.id;
    }),
    ["3", "4"],
  );
  assert.match(report.failed[0].error, /not started/i);

  assert.equal(report.results.length, 4);
  assert.notEqual(report.results[0], null);
  assert.equal(report.results[2], null, "an untouched pin has no media");
});

test("a stopped run can be resumed by retrying the pins that are missing", async () => {
  const pins = pinList(4);

  // The user cancels before anything was fetched.
  const stopped = await exporter.run(
    pins,
    async (target) => {
      await sleep(5);
      return media(target);
    },
    {
      concurrency: 1,
      shouldStop: function () {
        return true;
      },
    },
  );

  assert.equal(stopped.stopped, true);
  assert.equal(stopped.done, 0, "nothing was fetched");
  assert.equal(stopped.failed.length, 4, "every pin is reported as missing");

  // The retry picks up exactly those pins and saves them.
  const retryPins = exporter.failedPins(stopped);
  assert.equal(retryPins.length, 4);

  const second = await exporter.run(retryPins, okFetch());
  assert.equal(second.done, 4);
  assert.equal(second.failed.length, 0);
  assert.equal(second.stopped, false);
});

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

test("an empty pin list is a valid, empty run", async () => {
  const report = await exporter.run([], okFetch());

  assert.equal(report.total, 0);
  assert.equal(report.done, 0);
  assert.equal(report.stopped, false);
  assert.deepEqual(report.results, []);
  assert.deepEqual(report.failed, []);
});

test("run refuses to run without a fetchOne function", async () => {
  await assert.rejects(
    function () {
      return exporter.run([pin(1)], null);
    },
    /fetchOne/,
  );
});

test("a pin list that is not an array is an empty run", async () => {
  const report = await exporter.run(null, okFetch());
  assert.equal(report.total, 0);
  assert.deepEqual(report.results, []);
});
