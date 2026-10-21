#!/usr/bin/env node
/**
 * Publish (or update) this extension on the Chrome Web Store.
 *
 * Uses the Chrome Web Store API v1.1:
 *   1. exchange the refresh token for an access token
 *   2. create the store item (first run only)
 *   3. upload the packaged zip
 *   4. set the store listing
 *   5. submit the item for review
 *
 * The v2 endpoints documented at developer.chrome.com/docs/webstore/api are
 * not routed yet — every /v2 path answers 404 — so v1.1 is the working API.
 *
 * Usage:
 *   node scripts/publish-chrome-web-store.mjs \
 *     --client-id=... --client-secret=... --refresh-token=... [--item-id=...] [--dry-run]
 *
 * The three OAuth values come from the Chrome Web Store developer dashboard
 * (https://chrome.google.com/u/0/developer) -> "Publish" -> "Update
 * information" -> the "Google Chrome Web Store API" section -> "Get
 * credentials". They are read from the command line or from the environment
 * (CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN) and are never
 * written to disk.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const ZIP = path.join(ROOT, "pin-saver-extension.zip");
const LISTING = path.join(ROOT, "store", "listing.json");

const API = "https://www.googleapis.com/chromewebstore/v1.1";
const UPLOAD_API = "https://www.googleapis.com/upload/chromewebstore/v1.1";
const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

// ---------------------------------------------------------------- arguments
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const dryRun = Boolean(args["dry-run"]);

const clientId = args["client-id"] || process.env.CWS_CLIENT_ID;
const clientSecret = args["client-secret"] || process.env.CWS_CLIENT_SECRET;
const refreshToken = args["refresh-token"] || process.env.CWS_REFRESH_TOKEN;
let itemId = args["item-id"] || process.env.CWS_ITEM_ID || null;

// ------------------------------------------------------------------- helpers
function fail(message) {
  console.error("ERROR: " + message);
  process.exit(1);
}

async function accessToken() {
  if (!clientId || !clientSecret || !refreshToken) {
    fail(
      "missing OAuth credentials. Pass --client-id/--client-secret/--refresh-token " +
        "or set CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN.",
    );
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: SCOPE,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    fail("token exchange failed: " + JSON.stringify(body).slice(0, 300));
  }
  return body.access_token;
}

async function call(method, url, token, { json, body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(json ? { "content-type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: json ? JSON.stringify(json) : body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    fail(
      method + " " + url + " -> HTTP " + res.status + ": " + JSON.stringify(parsed).slice(0, 600),
    );
  }
  return parsed;
}

/** Convert the listing.json (store-shaped) into the v1.1 listing resource. */
function toV11Listing(listing) {
  const locale = listing.language || listing.locale || "en-US";
  return {
    locale: locale,
    name: listing.name,
    description: listing.description,
    shortDescription: listing.summary || listing.shortDescription,
    iconUrl: listing.iconUrl,
    primaryColor: "#e60023",
    backgroundColor: "#ffffff",
    screenshots: (listing.screenshots || []).map((s, i) => ({
      url: s.url,
      position: i,
    })),
  };
}

// ---------------------------------------------------------------------- main
async function main() {
  if (!existsSync(ZIP)) fail("package not found: " + ZIP + " (run: npm run package)");
  if (!existsSync(LISTING)) fail("listing not found: " + LISTING);

  const listing = JSON.parse(await readFile(LISTING, "utf8"));
  const v11 = toV11Listing(listing);

  console.log("package :", path.basename(ZIP));
  console.log("item id :", itemId || "(will be created)");
  console.log("locale  :", v11.locale);
  console.log("screens :", v11.screenshots.length);

  if (dryRun) {
    console.log("\n-- listing that would be published --");
    console.log(JSON.stringify({ listing: v11 }, null, 2));
    console.log("\nNo request was sent.");
    return;
  }

  const token = await accessToken();
  console.log("token   : acquired");

  if (!itemId) {
    const created = await call("POST", API + "/items", token, { json: {} });
    itemId = created.id;
    console.log("item id :", itemId, "(created)");
  } else {
    console.log("item id :", itemId);
  }

  // 1. upload the package
  const zip = await readFile(ZIP);
  const upload = await call("PUT", UPLOAD_API + "/items/" + itemId, token, {
    headers: {
      "content-type": "application/zip",
      "x-goog-api-client": "chrome-webstore-publish/1.0",
    },
    body: zip,
  });
  console.log("upload  :", upload.uploadState || upload.crxVersion || "ok");
  if (upload.uploadState && upload.uploadState !== "COMPLETE") {
    console.log("         upload still processing, re-run in a minute");
  }

  // 2. publish the listing
  await call("PUT", API + "/items/" + itemId, token, { json: { listing: v11 } });
  console.log("listing : updated");

  // 3. submit for review
  const published = await call("POST", API + "/items/" + itemId + ":publish", token, {
    json: { visibility: "PUBLIC" },
  });
  console.log(
    "review  : submitted",
    published.submissionTime ? "(" + published.submissionTime + ")" : "",
  );
  console.log("\nDone. Watch the review status at https://chrome.google.com/u/0/developer");
}

main().catch((err) => {
  console.error("FAILED:", err && err.message ? err.message : err);
  process.exit(1);
});
