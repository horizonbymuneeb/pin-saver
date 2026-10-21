/**
 * Publish an extension to the Chrome Web Store with the v2 API.
 *
 * The v1.1 API no longer creates items: `POST /v1.1/items` answers 400
 * "Invalid Value" and its publish route is not handled at all. The v2 API can
 * upload a package, set the listing and submit an item for review, but it has
 * no create method either — the item itself is created in the developer
 * dashboard, and the item URL there carries the publisher id and the item id.
 *
 * Usage:
 *   node scripts/publish-v2.mjs --publisher-id=<id> --item-id=<id>
 *   node scripts/publish-v2.mjs --publisher-id=<id> --item-id=<id> --status-only
 *
 * Credentials come from .cws-credentials.json, CWS_CLIENT_ID /
 * CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN, or --client-id/--client-secret/
 * --refresh-token.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const API = "https://chromewebstore.googleapis.com/v2";
const ZIP = path.join(ROOT, "pin-saver-extension.zip");
const LISTING = path.join(ROOT, "store", "listing.json");
const CREDENTIALS = path.join(ROOT, ".cws-credentials.json");

const args = {};
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}

function fail(message) {
  console.error("ERROR:", message);
  process.exit(1);
}

async function credentials() {
  let saved = {};
  if (existsSync(CREDENTIALS)) {
    try {
      saved = JSON.parse(await readFile(CREDENTIALS, "utf8"));
    } catch {
      saved = {};
    }
  }
  return {
    clientId: args["client-id"] || process.env.CWS_CLIENT_ID || saved.client_id,
    clientSecret: args["client-secret"] || process.env.CWS_CLIENT_SECRET || saved.client_secret,
    refreshToken: args["refresh-token"] || process.env.CWS_REFRESH_TOKEN || saved.refresh_token,
  };
}

async function accessToken(cred) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
      refresh_token: cred.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    fail("token exchange failed: " + JSON.stringify(body).slice(0, 300));
  }
  return body.access_token;
}

async function call(token, method, url, body, contentType) {
  const headers = { authorization: "Bearer " + token };
  if (contentType) headers["content-type"] = contentType;
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const message = parsed && parsed.error ? parsed.error.message : text.slice(0, 300);
    fail(method + " " + url + " -> HTTP " + res.status + ": " + message);
  }
  return parsed || {};
}

/** The listing resource, in the shape the v2 upload endpoint expects. */
function toV2Listing(listing) {
  return {
    locale: listing.language || listing.locale || "en-US",
    name: listing.name,
    description: listing.description,
    shortDescription: listing.summary || listing.shortDescription,
    iconUrl: listing.iconUrl,
    privacyPolicyUrl: listing.privacyPolicyUrl || "",
    primaryColor: "#e60023",
    backgroundColor: "#ffffff",
    screenshots: (listing.screenshots || []).map((s, i) => ({
      url: s.url,
      position: i,
    })),
  };
}

/** A multipart/related body: the listing JSON plus the extension package. */
async function multipartBody(listing, zip) {
  const boundary = "pin_saver_boundary_8977";
  const head =
    "--" + boundary + "\r\n" +
    "Content-Type: application/json\r\n\r\n" +
    JSON.stringify(listing) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: application/zip\r\n\r\n";
  const tail = "\r\n--" + boundary + "--\r\n";
  return {
    body: Buffer.concat([Buffer.from(head, "utf8"), zip, Buffer.from(tail, "utf8")]),
    contentType: "multipart/related; boundary=" + boundary,
  };
}

async function main() {
  const cred = await credentials();
  if (!cred.clientId || !cred.clientSecret || !cred.refreshToken) {
    fail(
      "missing OAuth credentials. Run:\n" +
        "  node scripts/auth-chrome-web-store.mjs --client-id=<id> --client-secret=<secret> --code=<code>\n" +
        "or set CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN.",
    );
  }

  const publisherId = args["publisher-id"] || process.env.CWS_PUBLISHER_ID;
  const itemId = args["item-id"] || process.env.CWS_ITEM_ID;
  if (!publisherId || !itemId) {
    fail(
      "publisher id and item id are required.\n" +
        "Open the item in the developer dashboard and copy the id from the URL,\n" +
        "e.g. https://chrome.google.com/u/0/developer/<publisher-id>/<item-id>\n" +
        "  node scripts/publish-v2.mjs --publisher-id=<id> --item-id=<id>",
    );
  }

  const name = "publishers/" + publisherId + "/items/" + itemId;
  const token = await accessToken(cred);
  console.log("token   : acquired");
  console.log("item    :", name);

  if (args["status-only"]) {
    const status = await call(token, "GET", API + "/" + name + ":fetchStatus");
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (!args["skip-upload"]) {
    if (!existsSync(ZIP)) fail("package not found: " + ZIP + " (run: npm run package)");
    if (!existsSync(LISTING)) fail("listing not found: " + LISTING);
    const listing = JSON.parse(await readFile(LISTING, "utf8"));
    const zip = await readFile(ZIP);
    const { body, contentType } = await multipartBody(toV2Listing(listing), zip);
    const res = await call(token, "POST", API + "/" + name + ":upload", body, contentType);
    console.log("upload  :", res.uploadState || "ok");
    if (res.uploadState && res.uploadState !== "SUCCEEDED") {
      console.log("         poll with --status-only in a minute");
    }
  } else {
    console.log("upload  : skipped (the dashboard upload is used)");
  }

  const published = await call(token, "POST", API + "/" + name + ":publish", {
    publishType: "DEFAULT_PUBLISH",
    blockOnWarnings: false,
  });
  console.log("review  : submitted ->", published.state || "PENDING_REVIEW");

  const status = await call(token, "GET", API + "/" + name + ":fetchStatus");
  console.log("status  :", JSON.stringify(status).slice(0, 400));
  console.log(
    "\nDashboard: https://chrome.google.com/u/0/developer/" + publisherId + "/" + itemId,
  );
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
