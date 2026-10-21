/**
 * A live, clickable view of a browser, straight from the Chrome DevTools
 * Protocol.
 *
 * Why this instead of noVNC: noVNC scrapes the X framebuffer over VNC, which
 * is slow, needs a VNC server, and gives no way to talk to the browser. The
 * CDP screencast sends the browser's own rendered frames as JPEG, and input
 * goes straight back through `Input.dispatch*` — so the view is smooth, the
 * clicks land exactly, and no extra protocol is involved.
 *
 * It is also provider-neutral: point it at any CDP endpoint, for example
 *
 *   browserless:  http://127.0.0.1:3000
 *   plain Chrome: http://127.0.0.1:9222
 *
 * Endpoints
 *   GET  /            the viewer page
 *   GET  /frames      server-sent events: base64 JPEG frames
 *   POST /input       one input event as JSON
 *   GET  /status      what is connected
 *
 * No dependencies: Node's global WebSocket does the CDP work.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CDP_HTTP = process.env.CDP_HTTP || "http://127.0.0.1:9222";
const PORT = Number(process.env.LIVEVIEW_PORT || 6090);
const QUALITY = Number(process.env.LIVEVIEW_QUALITY || 65);

let cdp = null; // { ws, id, pending, handlers }
let nextId = 1;
const clients = new Set(); // SSE responses
let pageInfo = { url: "", title: "" };

/** One CDP call. */
function send(method, params = {}) {
  if (cdp && cdp.playwright) {
    return cdp.playwright.session.send(method, params);
  }
  return new Promise((resolve, reject) => {
    if (!cdp || cdp.ws.readyState !== 1) {
      reject(new Error("not connected"));
      return;
    }
    const id = nextId++;
    cdp.pending.set(id, { resolve, reject });
    cdp.ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (cdp && cdp.pending.has(id)) {
        cdp.pending.delete(id);
        reject(new Error("CDP timeout: " + method));
      }
    }, 30000);
  });
}

/** Find a page target to attach to. */
async function findPage() {
  const token = process.env.CDP_TOKEN ? "&token=" + encodeURIComponent(process.env.CDP_TOKEN) : "";
  const res = await fetch(CDP_HTTP + "/json/list" + (token ? "?" + token.slice(1) : ""));
  const list = await res.json();
  const pages = list.filter((t) => t.type === "page");
  if (!pages.length) throw new Error("no page target at " + CDP_HTTP);
  // Prefer a page that is not the browser's blank start page.
  return pages.find((p) => p.url && !p.url.startsWith("about:blank")) || pages[0];
}

/**
 * Connect through a Playwright endpoint (browserless) instead of raw CDP.
 * The Playwright protocol does not expose a page websocket directly, so a
 * CDP session is opened on the page and the same screencast and input
 * commands are sent through it.
 */
async function connectPlaywright() {
  // An ESM import does not honour NODE_PATH, so the module is loaded by its
  // absolute path (it is the Playwright core already installed in the repo).
  const pwPath =
    process.env.PLAYWRIGHT_CORE ||
    "/home/ubuntu/dsh-workspace/my-version/node_modules/playwright-core/index.js";
  const pw = await import(pwPath);
  // playwright-core is CommonJS, so the named export lives on `default`.
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  if (!chromium) throw new Error("playwright-core has no chromium export");
  const browser = await chromium.connect(process.env.PLAYWRIGHT_WS, { timeout: 30000 });
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());
  const session = await context.newCDPSession(page);

  let lastFrame = Date.now();
  session.on("Page.screencastFrame", async (params) => {
    lastFrame = Date.now();
    session.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    const payload = "data:image/jpeg;base64," + params.data;
    for (const res of clients) res.write("data: " + payload + "\n\n");
  });
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) pageInfo.url = page.url();
  });

  await session.send("Page.enable");
  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: QUALITY,
    everyNthFrame: 1,
    maxWidth: 1600,
    maxHeight: 1000,
  });
  await session.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});

  setInterval(() => {
    if (Date.now() - lastFrame > 1500) {
      lastFrame = Date.now();
      session.send("Page.startScreencast", {
        format: "jpeg",
        quality: QUALITY,
        everyNthFrame: 1,
        maxWidth: 1600,
        maxHeight: 1000,
      }).catch(() => {});
    }
  }, 1000);

  cdp = {
    ws: { readyState: 1 },
    pending: new Map(),
    handlers: new Map(),
    playwright: { browser, context, page, session },
  };
  pageInfo.url = page.url();
  console.log("connected through Playwright to", page.url());
}

async function connect() {
  if (process.env.PLAYWRIGHT_WS) return connectPlaywright();
  const page = await findPage();
  pageInfo = { url: page.url, title: page.title };
  // Browserless (and other token-protected endpoints) want the token on the
  // websocket URL as well as on the HTTP calls.
  let wsUrl = page.webSocketDebuggerUrl;
  const token = process.env.CDP_TOKEN;
  if (token) wsUrl += (wsUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
  });

  cdp = { ws, pending: new Map(), handlers: new Map() };
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && cdp.pending.has(msg.id)) {
      const { resolve, reject } = cdp.pending.get(msg.id);
      cdp.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const handler = cdp.handlers.get(msg.method);
      if (handler) handler(msg.params);
    }
  });

  await send("Page.enable");
  await send("Runtime.enable");

  // The frame handler is registered after the screencast is started below,
  // together with the keep-alive that keeps a static page alive.
  cdp.handlers.set("Page.navigatedWithinDocument", (p) => {
    pageInfo.url = p.url;
  });

  await send("Page.startScreencast", {
    format: "jpeg",
    quality: QUALITY,
    everyNthFrame: 1,
    maxWidth: 1600,
    maxHeight: 1000,
  });

  // A hidden page makes Chrome pause the screencast, and a static page only
  // produces one frame. Marking the page active and asking for a fresh frame
  // when the screen goes quiet keeps the view alive.
  await send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  let lastFrame = Date.now();
  cdp.handlers.set("Page.screencastFrame", (params) => {
    lastFrame = Date.now();
    send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    const payload = "data:image/jpeg;base64," + params.data;
    for (const res of clients) res.write("data: " + payload + "\n\n");
  });
  setInterval(() => {
    if (!cdp || cdp.ws.readyState !== 1) return;
    if (Date.now() - lastFrame > 1500) {
      lastFrame = Date.now();
      send("Page.startScreencast", {
        format: "jpeg",
        quality: QUALITY,
        everyNthFrame: 1,
        maxWidth: 1600,
        maxHeight: 1000,
      }).catch(() => {});
    }
  }, 1000);

  console.log("connected to", page.url);
}

const VIEWER = `<!doctype html>
<html><head><meta charset="utf-8"><title>shared browser</title>
<style>
  html,body{margin:0;height:100%;background:#0e1116;color:#e6e6e6;
            font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{display:flex;gap:12px;align-items:center;padding:8px 12px;background:#161b22;
         border-bottom:1px solid #262c36}
  header b{font-weight:600}
  #url{flex:1;color:#9aa4b2;font-size:12px;overflow:hidden;text-overflow:ellipsis;
       white-space:nowrap;background:#0e1116;padding:4px 8px;border-radius:6px}
  #state{font-size:12px;color:#7ee787}
  #view{position:relative;height:calc(100% - 41px);display:flex;align-items:center;
        justify-content:center;overflow:hidden}
  canvas{max-width:100%;max-height:100%;cursor:crosshair;image-rendering:auto}
</style></head>
<body>
<header>
  <b>Shared browser</b>
  <span id="url">connecting…</span>
  <span id="state">live</span>
</header>
<div id="view"><canvas id="c"></canvas></div>
<script>
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const urlEl = document.getElementById("url");
const stateEl = document.getElementById("state");

const es = new EventSource("/frames");
es.onmessage = (e) => {
  const b64 = e.data.replace(/^data:image\\/jpeg;base64,/, "");
  const img = new Image();
  img.onload = () => {
    if (canvas.width !== img.width || canvas.height !== img.height) {
      canvas.width = img.width; canvas.height = img.height;
    }
    ctx.drawImage(img, 0, 0);
  };
  img.src = "data:image/jpeg;base64," + b64;
};
es.onerror = () => { stateEl.textContent = "reconnecting…"; };
es.onopen = () => { stateEl.textContent = "live"; };

function post(o) {
  fetch("/input", { method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify(o) }).catch(() => {});
}
function scale(ev) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - r.left) / r.width) * canvas.width,
    y: ((ev.clientY - r.top) / r.height) * canvas.height,
  };
}
canvas.addEventListener("mousedown", (ev) => {
  const p = scale(ev);
  post({ type: "mouse", kind: "mousePressed", x: p.x, y: p.y, button: ev.button, clickCount: 1 });
});
canvas.addEventListener("mouseup", (ev) => {
  const p = scale(ev);
  post({ type: "mouse", kind: "mouseReleased", x: p.x, y: p.y, button: ev.button, clickCount: 1 });
});
canvas.addEventListener("mousemove", (ev) => {
  const p = scale(ev);
  post({ type: "mouse", kind: "mouseMoved", x: p.x, y: p.y, buttons: ev.buttons });
});
canvas.addEventListener("wheel", (ev) => {
  const p = scale(ev);
  post({ type: "mouse", kind: "mouseWheel", x: p.x, y: p.y, deltaX: ev.deltaX, deltaY: ev.deltaY });
});
window.addEventListener("keydown", (ev) => {
  post({ type: "key", kind: "keyDown", key: ev.key, code: ev.code, text: ev.key.length === 1 ? ev.key : undefined });
  if (ev.key === "Tab") ev.preventDefault();
});
window.addEventListener("keyup", (ev) => {
  post({ type: "key", kind: "keyUp", key: ev.key, code: ev.code });
});
fetch("/status").then(r => r.json()).then(s => { urlEl.textContent = s.url || ""; });
setInterval(() => fetch("/status").then(r => r.json()).then(s => { urlEl.textContent = s.url || ""; }), 3000);
</script>
</body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(VIEWER);
    return;
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ connected: Boolean(cdp), url: pageInfo.url, title: pageInfo.title }));
    return;
  }

  if (url.pathname === "/frames") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/input" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const ev = JSON.parse(body || "{}");
        if (ev.type === "mouse") {
          await send("Input.dispatchMouseEvent", {
            type: ev.kind,
            x: ev.x,
            y: ev.y,
            button: ev.button === 2 ? "right" : ev.button === 1 ? "middle" : "left",
            buttons: ev.buttons || 0,
            clickCount: ev.clickCount || 0,
            deltaX: ev.deltaX || 0,
            deltaY: ev.deltaY || 0,
          });
        } else if (ev.type === "key") {
          await send("Input.dispatchKeyEvent", {
            type: ev.kind,
            key: ev.key,
            code: ev.code,
            text: ev.text,
          });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("live view on http://127.0.0.1:" + PORT + "  (CDP: " + CDP_HTTP + ")");
});

connect().catch((err) => {
  console.error("connect failed:", err.message);
  setTimeout(connect, 5000);
});
