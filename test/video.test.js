/**
 * Tests for HLS → direct MP4 resolution.
 *
 * The playlist shapes here mirror what production Pinterest actually returned
 * during analysis: a master playlist with several BANDWIDTH variants, and a
 * variant whose `#EXT-X-MAP` plus contiguous BYTERANGE segments all point at
 * one `.cmfv` file.
 *
 * Run: node --test test/video.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const video = require(path.join(__dirname, "..", "src", "lib", "video.js"));

const HASH = "0123456789abcdef0123456789abcdef";
const BASE = "https://v1.pinimg.com/videos/iht/hls/01/23/45/";

const MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:6",
  "#EXT-X-INDEPENDENT-SEGMENTS",
  "",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio1",NAME="1",LANGUAGE="eng",AUTOSELECT=YES,URI="' +
    HASH + '_audio.m3u8",CHANNELS="2"',
  '#EXT-X-STREAM-INF:BANDWIDTH=414032,RESOLUTION=234x416,AUDIO="audio1"',
  HASH + "_240w.m3u8",
  "",
  '#EXT-X-STREAM-INF:BANDWIDTH=738528,RESOLUTION=360x640,AUDIO="audio1"',
  HASH + "_360w.m3u8",
  "",
  '#EXT-X-STREAM-INF:BANDWIDTH=2165688,RESOLUTION=720x1280,AUDIO="audio1"',
  HASH + "_720w.m3u8",
  "",
].join("\n");

const MEDIA = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:3",
  "#EXT-X-VERSION:6",
  "#EXT-X-PLAYLIST-TYPE:VOD",
  '#EXT-X-MAP:URI="' + HASH + '_720w.cmfv",BYTERANGE="972@0"',
  "#EXTINF:2.00427",
  "#EXT-X-BYTERANGE:411223@1132",
  HASH + "_720w.cmfv",
  "#EXTINF:2.00427",
  "#EXT-X-BYTERANGE:406973@412355",
  HASH + "_720w.cmfv",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Playlist parsing
// ---------------------------------------------------------------------------

test("parseMasterPlaylist returns variants sorted by bandwidth descending", () => {
  const variants = video.parseMasterPlaylist(MASTER);
  assert.equal(variants.length, 3);
  assert.equal(variants[0].bandwidth, 2165688);
  assert.equal(variants[0].uri, HASH + "_720w.m3u8");
  assert.equal(variants[1].bandwidth, 738528);
  assert.equal(variants[2].bandwidth, 414032);
});

test("parseMasterPlaylist ignores audio-only renditions", () => {
  const variants = video.parseMasterPlaylist(MASTER);
  assert.ok(
    variants.every((v) => v.uri.indexOf("audio") === -1),
    "audio playlist must not be treated as a video variant",
  );
});

test("parseMasterPlaylist handles an empty or malformed playlist", () => {
  assert.deepEqual(video.parseMasterPlaylist(""), []);
  assert.deepEqual(video.parseMasterPlaylist("#EXTM3U\n#EXT-X-VERSION:6"), []);
});

test("parseMediaPlaylist finds the EXT-X-MAP media file", () => {
  const media = video.parseMediaPlaylist(MEDIA);
  assert.equal(media.mapUri, HASH + "_720w.cmfv");
  assert.equal(media.segmentUri, HASH + "_720w.cmfv");
  assert.equal(media.isMedia, true);
});

test("parseMediaPlaylist reports nothing for a master playlist", () => {
  const media = video.parseMediaPlaylist(MASTER);
  assert.equal(media.isMedia, false);
  assert.equal(media.mapUri, null);
});

test("parseAttributes strips quotes and parses numeric values", () => {
  const attrs = video.parseAttributes('URI="a.m3u8",BANDWIDTH=123,RESOLUTION=720x1280');
  assert.equal(attrs.URI, "a.m3u8");
  assert.equal(attrs.BANDWIDTH, "123");
  assert.equal(attrs.RESOLUTION, "720x1280");
});

test("resolveUri resolves a relative playlist reference", () => {
  assert.equal(
    video.resolveUri(BASE + HASH + ".m3u8", HASH + "_720w.m3u8"),
    BASE + HASH + "_720w.m3u8",
  );
});

test("resolveUri passes an absolute URL through unchanged", () => {
  const abs = "https://v1.pinimg.com/other/file.cmfv";
  assert.equal(video.resolveUri(BASE + "x.m3u8", abs), abs);
});

test("isDirectMedia accepts mp4/cmfv/webm but not m3u8", () => {
  assert.equal(video.isDirectMedia("https://x/y.cmfv"), true);
  assert.equal(video.isDirectMedia("https://x/y.mp4"), true);
  assert.equal(video.isDirectMedia("https://x/y.webm"), true);
  assert.equal(video.isDirectMedia("https://x/y.m3u8"), false);
});

// ---------------------------------------------------------------------------
// End-to-end resolution
// ---------------------------------------------------------------------------

test("resolveVideoUrl turns a master playlist into the backing .cmfv file", async () => {
  const requested = [];
  const fakeFetch = async function (url) {
    requested.push(url);
    if (url.endsWith(".m3u8") && url.indexOf("_720w") === -1 && !url.match(/_\d+w\.m3u8/)) {
      return { ok: true, status: 200, text: async () => MASTER };
    }
    return { ok: true, status: 200, text: async () => MEDIA };
  };

  const result = await video.resolveVideoUrl(BASE + HASH + ".m3u8", fakeFetch);
  assert.equal(result.kind, "hls-file");
  assert.equal(result.url, BASE + HASH + "_720w.cmfv");
  assert.equal(result.bandwidth, 2165688);
  assert.equal(requested.length, 2, "master then variant");
  assert.ok(requested[0].endsWith(".m3u8"));
});

test("resolveVideoUrl returns a direct mp4 without any network call", async () => {
  let called = false;
  const fakeFetch = async function () {
    called = true;
    return { ok: true, text: async () => "" };
  };
  const result = await video.resolveVideoUrl("https://v1.pinimg.com/videos/x.mp4", fakeFetch);
  assert.equal(result.kind, "direct");
  assert.equal(result.url, "https://v1.pinimg.com/videos/x.mp4");
  assert.equal(called, false);
});

test("resolveVideoUrl fails loudly when the playlist has no media file", async () => {
  const fakeFetch = async function () {
    return { ok: true, status: 200, text: async () => "#EXTM3U\n#EXT-X-VERSION:6\n" };
  };
  await assert.rejects(
    () => video.resolveVideoUrl(BASE + HASH + ".m3u8", fakeFetch),
    /did not reference a media file/,
  );
});

test("resolveVideoUrl refuses true segmented .ts streams", async () => {
  const tsPlaylist = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXTINF:2.0",
    "segment-1.ts",
    "#EXTINF:2.0",
    "segment-2.ts",
  ].join("\n");
  const fakeFetch = async function () {
    return { ok: true, status: 200, text: async () => tsPlaylist };
  };
  await assert.rejects(
    () => video.resolveVideoUrl(BASE + HASH + ".m3u8", fakeFetch),
    /segmented/,
  );
});

test("resolveVideoUrl rejects a missing URL", async () => {
  await assert.rejects(() => video.resolveVideoUrl("", async () => ({})), /No video URL/);
});
