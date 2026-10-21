/**
 * Mock Pinterest origin for end-to-end testing.
 *
 * Serves the exact request shapes the extension expects, so the real extension
 * can be exercised in a real Chromium without touching production:
 *
 *   GET /resource/BoardResource/get/   → board id
 *   GET /resource/BoardFeedResource/get/ → pins
 *   GET /236x/... | /originals/...     → JPEG bytes
 *   GET /pinterest/<board>/            → board page with the pin DOM
 *
 * Every response sends permissive CORS headers because the background worker
 * fetches the media cross-origin.
 */
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.MOCK_PORT || 8443);
const JPEG = fs.readFileSync(path.join(__dirname, "mock.jpg"));
const PNG = fs.readFileSync(path.join(__dirname, "mock.png"));

const PIN_COUNT = 6;

/** Where the mock serves HLS playlists and the backing media file. */
const VIDEO_BASE = "https://v1.pinimg.com/videos/iht/hls/aa/bb/cc";
const VIDEO_FILE = VIDEO_BASE + "/vid1_720w.cmfv";

/** Requests the server saw, so the test can assert the extension made them. */

const PIN_TITLES = [
  "Making cute pink meringues",
  "Cozy bedroom corner ideas",
  "Sunday brunch table setting",
  "Neon party lights for the patio",
  "Matching nails for the weekend",
  "Recipe: raspberry chocolate cake",
  "Playlist for a girls night in",
  "Outfit ideas for the holiday party",
  "Cocktail recipes you can actually make",
  "Movie night snack board",
];

/* A Pinterest-like board page: header, sidebar, masonry grid. The extension
   is injected into this DOM, so the page has to look like the real thing for
   the store screenshots to be worth anything. */
const MOCK_CSS = `
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
         color:#111; background:#fff; }
  .topbar { position:fixed; top:0; left:0; right:0; height:56px; display:flex; align-items:center;
            gap:16px; padding:0 16px; background:#fff; border-bottom:1px solid #eee; z-index:5; }
  .topbar__logo { width:32px; height:32px; border-radius:50%; background:#e60023; color:#fff;
                  display:flex; align-items:center; justify-content:center; font-weight:800; font-size:20px; }
  .topbar__search { flex:1; max-width:520px; height:40px; border-radius:20px; background:#efefef;
                    display:flex; align-items:center; padding:0 16px; color:#767676; font-size:14px; }
  .topbar__icons { margin-left:auto; display:flex; gap:12px; }
  .topbar__icons span { width:24px; height:24px; border-radius:50%; background:#e2e2e2; }
  .layout { display:flex; padding-top:56px; }
  .sidebar { width:80px; padding:16px 8px; display:flex; flex-direction:column; align-items:center; gap:14px; }
  .avatar { width:40px; height:40px; border-radius:50%; background:linear-gradient(135deg,#ffd36e,#e60023); }
  .nav__item { display:flex; flex-direction:column; align-items:center; gap:4px; }
  .nav__icon { width:24px; height:24px; border-radius:8px; background:#e2e2e2; }
  .nav__label { font-size:9px; color:#555; }
  .main { flex:1; padding:16px 24px 40px; max-width:1240px; }
  h1 { font-size:28px; margin:4px 0 2px; }
  .board-sub { color:#767676; font-size:13px; margin-bottom:20px; }
  .grid { column-count:5; column-gap:18px; }
  .card { break-inside:avoid; margin-bottom:18px; position:relative; }
  .card__link { text-decoration:none; color:inherit; display:block; }
  .card__media { position:relative; border-radius:14px; overflow:hidden; background:#eee; }
  .card__media img { width:100%; display:block; }
  .card__badge { position:absolute; top:8px; right:8px; width:32px; height:32px; border-radius:50%;
                 background:rgba(255,255,255,.92); color:#111; display:flex; align-items:center;
                 justify-content:center; font-size:17px; }
  .card__meta { padding:6px 2px 0; }
  .card__title { font-size:14px; font-weight:600; line-height:1.3; }
  .card__sub { font-size:12px; color:#767676; margin-top:2px; }
  .closeup { display:flex; gap:24px; padding:80px 40px; }
  .closeup__media { width:420px; border-radius:14px; overflow:hidden; }
  .closeup__media img { width:100%; display:block; }
  .closeup__side { flex:1; padding-top:20px; }
  .closeup__title { font-size:24px; font-weight:700; margin-bottom:8px; }
  .closeup__sub { color:#767676; font-size:14px; margin-bottom:20px; }
  .closeup__btn { display:inline-block; padding:12px 20px; border-radius:22px; background:#e60023; color:#fff;
                  font-size:14px; font-weight:600; }
  .closeup__actions { display:flex; gap:10px; margin:18px 0 14px; }
  .closeup__save { padding:11px 22px; border-radius:22px; background:#e60023; color:#fff;
                   font-size:14px; font-weight:600; }
  .closeup__more { width:42px; height:42px; border-radius:50%; background:#efefef;
                   display:flex; align-items:center; justify-content:center; font-size:18px; }
  .closeup__note { font-size:13px; line-height:1.6; color:#333; max-width:520px;
                   border-left:3px solid #e60023; padding-left:12px; }
  .closeup__brand { margin-top:20px; display:inline-flex; align-items:center; gap:8px;
                    font-size:13px; font-weight:700; color:#e60023; }
  .closeup__brandmark { width:26px; height:26px; border-radius:50%; background:#e60023; color:#fff;
                        display:flex; align-items:center; justify-content:center; font-size:14px; }
  .related { padding:8px 104px 40px; }
  .related h2 { font-size:18px; margin:0 0 12px; }
  .related__row { display:flex; gap:16px; }
  .related__card { width:170px; text-decoration:none; color:inherit; }
  .related__card img { width:170px; border-radius:12px; display:block; }
  .related__title { font-size:12px; font-weight:600; margin-top:6px; }
`;

const log = [];

/**
 * A media asset that fails twice before succeeding, so the extension's retry
 * path is exercised. Keyed by path.
 */
const flakyAttempts = {};
/** The board feed answers 500 once before succeeding. */
let feedFailures = 0;
const FEED_FAILURES = 1;
/** Number of deliberately injected transient failures, so the test can expect them. */
const stats = { injectedFailures: 0 };
/**
 * A deliberately huge asset. The bytes used to travel back from the worker as
 * base64 inside a message, and a message may not exceed 64 MiB — two of these
 * broke the export with "Message exceeded maximum allowed size of 64MiB".
 */
const BIG_BYTES = 26 * 1024 * 1024;
/** When set, media answers slowly — used to test cancelling a long export. */
let mediaDelayMs = 0;
const FLAKY_PATH = "/originals/aa/bb/cc/pin3.jpg";
const FLAKY_FAILURES = 2;

/**
 * Pin 6 is a PNG so the PDF writer has to convert it to JPEG, and pins 4 and 5
 * point at an asset that is larger than a single message may carry.
 */
function buildImages(i) {
  if (i === 4 || i === 5) {
    const url = "https://i.pinimg.com/originals/big/big/bigpin" + i + ".jpg";
    return { orig: { url: url }, "736x": { url: url }, "236x": { url: url } };
  }
  const ext = i === 6 ? "png" : "jpg";
  return {
    orig: { url: "https://i.pinimg.com/originals/aa/bb/cc/pin" + i + "." + ext },
    "736x": { url: "https://i.pinimg.com/736x/aa/bb/cc/pin" + i + "." + ext },
    "236x": { url: "https://i.pinimg.com/236x/aa/bb/cc/pin" + i + "." + ext },
  };
}

function pins() {
  const out = [];
  for (let i = 1; i <= PIN_COUNT; i++) {
    out.push({
      id: "9000" + i,
      title: "Mock pin " + i,
      description: "desc " + i,
      link: "https://example.invalid/" + i,
      images: buildImages(i),
    });
  }

  // One video pin, shaped like an idea pin: the video lives under
  // story_pin_data and is exposed as an HLS playlist, exactly as production
  // Pinterest does it.
  out.push({
    id: "9900",
    title: "Mock video pin",
    story_pin_data: {
      pages: [
        {
          blocks: [
            {
              video: {
                video_list: {
                  V_HLSV3_MOBILE: {
                    width: 720,
                    height: 1280,
                    url: VIDEO_BASE + "/vid1.m3u8",
                    thumbnail: "https://i.pinimg.com/236x/aa/bb/cc/pin1.jpg",
                  },
                },
              },
            },
          ],
        },
      ],
    },
  });
  // A video pin whose playlist answers 404: resolving it throws, and that must
  // not abort the whole archive.
  out.push({
    id: "9901",
    title: "Mock broken video pin",
    story_pin_data: {
      pages: [
        {
          blocks: [
            {
              video: {
                video_list: {
                  V_HLSV3_MOBILE: {
                    url: VIDEO_BASE + "/missing.m3u8",
                  },
                },
              },
            },
          ],
        },
      ],
    },
  });

  return out;
}

function boardHtml() {
  const cards = [];
  for (let i = 1; i <= PIN_COUNT; i++) {
    const ext = i === 6 ? "png" : "jpg";
    if (i === 4 || i === 5) {
      cards.push(
        '<div class="card" data-test-id="pin">' +
          '<a class="card__link" href="/pin/9000' + i + '/">' +
            '<div class="card__media">' +
              '<img alt="Big pin ' + i + '" src="https://i.pinimg.com/originals/big/big/bigpin' + i + '.jpg">' +
            "</div>" +
            '<div class="card__meta"><div class="card__title">Big pin ' + i + "</div>" +
            '<div class="card__sub">Save</div></div>' +
          "</a>" +
        "</div>",
      );
      continue;
    }

    const title = PIN_TITLES[i - 1] || "Mock pin " + i;
    // The anchor carries the pin id, the way Pinterest's grid does, so the
    // extension can match a picked card back to an API pin.
    cards.push(
      '<div class="card" data-test-id="pin">' +
        '<a class="card__link" href="/pin/9000' + i + '/">' +
          '<div class="card__media">' +
            '<img alt="' + title + '" src="https://i.pinimg.com/736x/aa/bb/cc/pin' + i + "." + ext + '">' +
            '<div class="card__badge">&#9825;</div>' +
          "</div>" +
          '<div class="card__meta">' +
            '<div class="card__title">' + title + "</div>" +
            '<div class="card__sub">Save</div>' +
          "</div>" +
        "</a>" +
      "</div>",
    );
  }
  const nav = ["Home", "Explore", "Create", "Notifications", "Messages", "Profile"]
    .map(function (label) {
      return '<div class="nav__item"><span class="nav__icon"></span><span class="nav__label">' + label + "</span></div>";
    })
    .join("");

  return (
    "<!doctype html><html><head><title>Mock board</title>" +
    '<meta name="pinterest-app-version" content="deadbeef">' +
    "<style>" + MOCK_CSS + "</style>" +
    "</head><body>" +
    '<header class="topbar">' +
      '<div class="topbar__logo">P</div>' +
      '<div class="topbar__search">Search</div>' +
      '<div class="topbar__icons"><span></span><span></span><span></span></div>' +
    "</header>" +
    '<div class="layout">' +
      '<aside class="sidebar"><div class="avatar"></div>' + nav + "</aside>" +
      '<main class="main">' +
        '<h1 id="board-name">girls&rsquo; night in</h1>' +
        '<div class="board-sub">1.2k followers &middot; 246 pins</div>' +
        '<div class="grid">' + cards.join("") + "</div>" +
      "</main>" +
    "</div>" +
    "</body></html>"
  );
}

/** Two pins that live inside one board section, for folder tests. */
function sectionPins() {
  return [1, 2].map(function (n) {
    return {
      id: "940" + n,
      title: "Section pin " + n,
      images: {
        orig: { url: "https://i.pinimg.com/originals/aa/bb/cc/sec" + n + ".jpg" },
      },
    };
  });
}

/**
 * A board page whose grid uses only `/pin/<id>/` anchors — no
 * `[data-test-id="pin"]` cards. Pinterest's markup changes; the extension must
 * still find the pins.
 */
function altBoardHtml() {
  const cards = [];
  for (let i = 1; i <= 4; i++) {
    cards.push(
      '<a href="/pin/910' + i + '/" style="display:block">' +
        '<img alt="Alt pin ' + i + '" width="200" height="200" ' +
        'src="https://i.pinimg.com/236x/aa/bb/cc/pin' + i + '.jpg"></a>',
    );
  }
  return (
    "<!doctype html><html><head><title>Alt board</title>" +
    '<meta name="pinterest-app-version" content="deadbeef">' +
    '</head><body><h1 id="board-name">Alt Board</h1>' +
    '<div id="grid">' + cards.join("") + "</div></body></html>"
  );
}

/**
 * Pinterest's logged-out wall: it ships image placeholders and a login button,
 * with no real pins. The extension must not decorate this.
 */
function gatedHtml() {
  const cells = [];
  for (let i = 1; i <= 5; i++) {
    cells.push(
      '<div data-test-id="gated-pin-rep">' +
        '<img data-test-id="gated-pin-image" width="300" height="400" ' +
        'src="https://i.pinimg.com/236x/aa/bb/cc/pin' + i + '.jpg"></div>',
    );
  }
  return (
    "<!doctype html><html><head><title>Gated</title>" +
    '<meta name="pinterest-app-version" content="deadbeef">' +
    "</head><body>" +
    '<div data-test-id="login-button">Log in</div>' +
    cells.join("") +
    "</body></html>"
  );
}

/** A single-pin page, shaped like Pinterest's closeup view. */
function pinHtml() {
  const related = [];
  for (let i = 2; i <= 7; i++) {
    const ext = i === 6 ? "png" : "jpg";
    related.push(
      '<a class="related__card" href="/pin/9000' + i + '/">' +
        '<img alt="Related pin ' + i + '" src="https://i.pinimg.com/236x/aa/bb/cc/pin' + i + "." + ext + '">' +
        '<div class="related__title">' + (PIN_TITLES[i - 1] || "Related pin") + "</div>" +
      "</a>",
    );
  }
  return (
    "<!doctype html><html><head><title>Mock pin</title>" +
    '<meta name="pinterest-app-version" content="deadbeef">' +
    "<style>" + MOCK_CSS + "</style>" +
    "</head><body>" +
    '<header class="topbar">' +
      '<div class="topbar__logo">P</div>' +
      '<div class="topbar__search">Search</div>' +
      '<div class="topbar__icons"><span></span><span></span><span></span></div>' +
    "</header>" +
    '<div class="layout"><aside class="sidebar"><div class="avatar"></div></aside>' +
    '<main class="closeup" data-test-id="closeup-body">' +
      '<div class="closeup__media">' +
        '<img alt="Making cute pink meringues" src="https://i.pinimg.com/736x/aa/bb/cc/pin1.jpg">' +
      "</div>" +
      '<div class="closeup__side">' +
        '<div class="closeup__title">Making cute pink meringues</div>' +
        '<div class="closeup__sub">Recipe &middot; 12.4k saves &middot; by Baking &amp; Co</div>' +
        '<div class="closeup__actions">' +
          '<div class="closeup__save">Save</div>' +
          '<div class="closeup__more">&#8942;</div>' +
        "</div>" +
        '<div class="closeup__note">Whisk the whites to soft peaks, add the pink gel colouring a ' +
          "drop at a time, then pipe little kisses onto a baking tray and bake at 100&deg;C " +
          "for an hour and a half. They keep for a day in an airtight tin." +
        "</div>" +
        '<div class="closeup__brand"><span class="closeup__brandmark">&#8595;</span> Pin Saver</div>' +
      "</div>" +
    "</main>" +
    '<section class="related"><h2>More like this</h2>' +
      '<div class="related__row">' + related.join("") + "</div>" +
    "</section>" +
    "</body></html>"
  );
}

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type || "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(__dirname, "key.pem")),
    cert: fs.readFileSync(path.join(__dirname, "cert.pem")),
  },
  function (req, res) {
    const url = new URL(req.url, "https://www.pinterest.com");
    const p = url.pathname;
    log.push({ path: p, host: req.headers.host, cookie: req.headers.cookie || "" });

    if (req.method === "OPTIONS") return send(res, 204, "");

    if (p.startsWith("/resource/BoardResource/")) {
      const source = decodeURIComponent(url.searchParams.get("source_url") || "");
      if (source.indexOf("missing-board") !== -1) {
        // Pinterest's real shape for a board that does not exist.
        return send(
          res,
          200,
          JSON.stringify({
            resource_response: {
              error: { status: "failure", http_status: 404, code: 40, message: "Board not found." },
            },
          }),
        );
      }
      const id = source.indexOf("empty-board") !== -1 ? "777002" : "777001";
      return send(
        res,
        200,
        JSON.stringify({
          resource_response: { status: "success", data: { id: id, name: "Mock Board", pin_count: PIN_COUNT } },
        }),
      );
    }

    if (p.startsWith("/resource/BoardSectionsResource/")) {
      const sd = JSON.parse(url.searchParams.get("data") || "{}");
      if (sd && sd.options && String(sd.options.board_id) === "777002") {
        return send(res, 200, JSON.stringify({
          resource_response: { status: "success", data: [] },
        }));
      }
      // One section, so the archive is expected to grow a folder.
      return send(
        res,
        200,
        JSON.stringify({
          resource_response: {
            status: "success",
            data: [{ id: "sec-1", name: "Section A", slug: "section-a" }],
          },
        }),
      );
    }

    if (p.startsWith("/resource/BoardSectionPinsResource/")) {
      return send(
        res,
        200,
        JSON.stringify({
          resource_response: { status: "success", data: sectionPins(), bookmark: "-end-" },
        }),
      );
    }

    if (p.startsWith("/resource/BoardFeedResource/")) {
      if (feedFailures < FEED_FAILURES) {
        feedFailures++;
        stats.injectedFailures++;
        return send(res, 500, JSON.stringify({ error: "transient" }));
      }
      const data = JSON.parse(url.searchParams.get("data") || "{}");
      const isEmpty = data && data.options && String(data.options.board_id) === "777002";
      return send(
        res,
        200,
        JSON.stringify({
          resource_response: {
            status: "success",
            data: isEmpty ? [] : pins(),
            bookmark: "-end-",
          },
        }),
      );
    }

    if (p === FLAKY_PATH) {
      flakyAttempts[p] = (flakyAttempts[p] || 0) + 1;
      if (flakyAttempts[p] <= FLAKY_FAILURES) {
        return send(res, 503, "temporarily unavailable", "text/plain");
      }
    }

    if (p.indexOf("bigpin") !== -1) {
      // A very large asset, shaped like a JPEG so the PDF writer can still
      // measure it. The archive of a board with these in it is bigger than a
      // single message may carry, which is the case this mock exists for.
      const head = Buffer.from([
        0xff, 0xd8, // SOI
        0xff, 0xc0, 0x00, 0x11, 0x08, // SOF0, length 17, 8-bit
        0x00, 0x64, // height 100
        0x00, 0x64, // width 100
        0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
      ]);
      const tail = Buffer.from([0xff, 0xd9]); // EOI
      const pad = Buffer.alloc(
        Math.max(0, BIG_BYTES - head.length - tail.length),
        0x5a,
      );
      return send(res, 200, Buffer.concat([head, pad, tail]), "image/jpeg");
    }

    if (p.startsWith("/originals/") || p.startsWith("/236x/") || p.startsWith("/736x/")) {
      // Serve the per-pin artwork so the page looks like a real board.
      const base = p.slice(p.lastIndexOf("/") + 1);
      const file = path.join(__dirname, "mock", base);
      if (/^pin\d+\.(jpg|png)$/.test(base) && fs.existsSync(file)) {
        const buf = fs.readFileSync(file);
        return send(res, 200, buf, base.endsWith(".png") ? "image/png" : "image/jpeg");
      }
      if (mediaDelayMs) {
        return setTimeout(function () {
          const base2 = p.slice(p.lastIndexOf("/") + 1);
          const file2 = path.join(__dirname, "mock", base2);
          if (/^pin\d+\.(jpg|png)$/.test(base2) && fs.existsSync(file2)) {
            send(res, 200, fs.readFileSync(file2), base2.endsWith(".png") ? "image/png" : "image/jpeg");
            return;
          }
          send(res, 200, JPEG, "image/jpeg");
        }, mediaDelayMs);
      }
      if (p.endsWith(".png")) return send(res, 200, PNG, "image/png");
      return send(res, 200, JPEG, "image/jpeg");
    }

    if (p.startsWith("/pin/")) {
      return send(res, 200, pinHtml(), "text/html; charset=utf-8");
    }

    if (p === "/favicon.ico") {
      return send(res, 200, Buffer.alloc(0), "image/x-icon");
    }

    if (p.endsWith(".m3u8") && p.indexOf("vid1") !== -1) {
      const isVariant = p.indexOf("_720w") !== -1;
      const body = isVariant
        ? [
            "#EXTM3U",
            "#EXT-X-VERSION:6",
            "#EXT-X-PLAYLIST-TYPE:VOD",
            '#EXT-X-MAP:URI="vid1_720w.cmfv",BYTERANGE="24@0"',
            "#EXTINF:2.0",
            "#EXT-X-BYTERANGE:1024@24",
            "vid1_720w.cmfv",
          ].join("\n")
        : [
            "#EXTM3U",
            "#EXT-X-VERSION:6",
            '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=360x640',
            "vid1_360w.m3u8",
            '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=720x1280',
            "vid1_720w.m3u8",
          ].join("\n");
      return send(res, 200, body, "application/vnd.apple.mpegurl");
    }

    if (p.endsWith(".cmfv")) {
      // A tiny but structurally valid fragmented-MP4 header: `ftyp` box.
      const ftyp = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x36, 0x00, 0x00, 0x00, 0x01,
        0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32,
      ]);
      return send(res, 200, Buffer.concat([ftyp, Buffer.alloc(4096, 7)]), "video/mp4");
    }

    if (p.indexOf("/slow-board/") !== -1) {
      mediaDelayMs = 900;
      return send(res, 200, boardHtml().replace("Mock Board", "Slow Board"), "text/html; charset=utf-8");
    }

    if (p.indexOf("/gated-board/") !== -1) {
      return send(res, 200, gatedHtml(), "text/html; charset=utf-8");
    }

    if (p.indexOf("/alt-dom/") !== -1) {
      return send(res, 200, altBoardHtml(), "text/html; charset=utf-8");
    }

    if (p.startsWith("/pinterest/")) {
      return send(res, 200, boardHtml(), "text/html; charset=utf-8");
    }

    return send(res, 404, JSON.stringify({ error: "not found", path: p }));
  },
);

server.listen(PORT, "127.0.0.1", function () {
  console.log("mock pinterest listening on " + PORT);
});

module.exports = { server: server, log: log, stats: stats };
