#!/usr/bin/env node
/**
 * Drive the Chrome Web Store dashboard with a signed-in browser.
 *
 * The dashboard needs a real Google session. This script takes a Netscape
 * cookie file (the format Cookie-Editor exports), loads it into a persistent
 * Chromium, and then performs the publish flow against the live dashboard.
 *
 * Usage:
 *   node scripts/publish-via-dashboard.js --cookies=/path/to/cookies.txt \
 *        [--probe] [--step=<n>]
 *
 *   --probe   only open the dashboard, report what is on screen, and exit
 *   --step=N  run the flow up to step N (1 = upload, 2 = listing, 3 = submit)
 *
 * The cookie file is read from disk and never written anywhere.
 */
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const ZIP = path.join(ROOT, "pin-saver-extension.zip");
const PROFILE = path.join(os.tmpdir(), "cws-dashboard-profile");
const SHOTS = path.join(ROOT, "..", "store", "dashboard");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const cookieFile = args.cookies || process.env.CWS_COOKIES;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/148.0.0.0 Safari/537.36";

function log(...parts) {
  console.log(...parts);
}

function parseNetscapeCookies(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const p = line.split("\t");
    if (p.length < 7) continue;
    const [domain, flag, cookiePath, secure, expires, name, value] = p;
    const hostOnly = flag.toUpperCase() === "TRUE";
    const domainValue = hostOnly ? domain : "." + domain.replace(/^\./, "");
    out.push({
      name,
      value,
      domain: domainValue,
      path: cookiePath || "/",
      secure: secure.toUpperCase() === "TRUE",
      httpOnly: false,
      expires: Number(expires) > 0 ? Number(expires) : -1,
    });
  }
  return out;
}

async function main() {
  if (!cookieFile || !existsSync(cookieFile)) {
    console.error("ERROR: pass --cookies=<netscape cookie file>");
    process.exit(1);
  }
  if (!existsSync(ZIP)) {
    console.error("ERROR: package not found: " + ZIP);
    process.exit(1);
  }
  mkdirSync(SHOTS, { recursive: true });

  const cookies = parseNetscapeCookies(await readFile(cookieFile, "utf8"));
  log("cookies loaded:", cookies.length, "->", cookies.map((c) => c.name).slice(0, 12).join(", "));

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath:
      process.env.CHROME_PATH ||
      path.join(os.homedir(), ".cache/ms-playwright/chromium-1223/chrome-linux/chrome"),
    headless: true,
    userAgent: UA,
    locale: "en-US",
    viewport: { width: 1440, height: 1000 },
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  await ctx.addCookies(cookies);

  const page = ctx.newPage();
  page.setDefaultTimeout(30000);

  const url = "https://chrome.google.com/u/0/developer";
  log("opening", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);

  const state = await page.evaluate(() => {
    const t = (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 700);
    return {
      title: document.title,
      url: location.href,
      text: t,
      buttons: Array.from(document.querySelectorAll("button,a[role=button]"))
        .map((b) => (b.innerText || b.textContent || "").trim())
        .filter(Boolean)
        .slice(0, 25),
    };
  });
  log("\n--- dashboard state ---");
  log("title:", state.title);
  log("url  :", state.url);
  log("text :", state.text);
  log("buttons:", JSON.stringify(state.buttons));

  await page.screenshot({ path: path.join(SHOTS, "01-dashboard.png"), fullPage: false });
  log("\nscreenshot -> store/dashboard/01-dashboard.png");

  if (args.probe) {
    await ctx.close();
    return;
  }

  log("\n(Publish flow not implemented yet — probe first.)");
  await ctx.close();
}

main().catch((err) => {
  console.error("FAILED:", err && err.message ? err.message : err);
  process.exit(1);
});
