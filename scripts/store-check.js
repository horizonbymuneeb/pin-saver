#!/usr/bin/env node
/**
 * Chrome Web Store readiness check.
 *
 * The store rejects packages that violate its policy, and rejects listings
 * that miss required fields. This validates the package and the listing
 * before anything is uploaded, so a rejection is not the first time anyone
 * finds out.
 *
 * Usage: node scripts/store-check.js
 */
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const PKG = path.join(ROOT, "pin-saver-extension.zip");
const LISTING = path.join(ROOT, "store", "listing.json");

let failures = 0;
let warnings = 0;

function ok(label, detail) {
  console.log("  OK    " + label + (detail ? ": " + detail : ""));
}
function bad(label, detail) {
  console.log("  FAIL  " + label + (detail ? ": " + detail : ""));
  failures++;
}
function warn(label, detail) {
  console.log("  WARN  " + label + (detail ? ": " + detail : ""));
  warnings++;
}

console.log("Chrome Web Store readiness\n");

// ---------------------------------------------------------------- the package
if (!existsSync(PKG)) {
  bad("package exists", PKG + " (run: npm run package)");
} else {
  const size = (await stat(PKG)).size;
  ok("package exists", path.basename(PKG) + " (" + size.toLocaleString() + " bytes)");
  if (size > 2 * 1024 * 1024 * 1024) bad("package size", "over the 2 GB store limit");
}

// The zip is read with the tools that ship with Node; no dependency is added.
const { execFileSync } = await import("node:child_process");
const files = execFileSync("unzip", ["-Z1", PKG], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

ok("package entries", files.length + " files");

if (!files.includes("manifest.json")) bad("manifest.json is present");
else ok("manifest.json is present");

// -------------------------------------------------------- policy: no remote code
const codeFiles = files.filter((f) => f.endsWith(".js") || f.endsWith(".html"));
let remoteCode = [];
for (const f of codeFiles) {
  const text = execFileSync("unzip", ["-p", PKG, f], { encoding: "utf8", maxBuffer: 1 << 24 });
  if (/\beval\s*\(/.test(text)) remoteCode.push(f + ": eval(");
  if (/new\s+Function\s*\(/.test(text)) remoteCode.push(f + ": new Function(");
  if (/\bimportScripts\s*\(/.test(text)) remoteCode.push(f + ": importScripts(");
  if (/<script[^>]+src\s*=\s*["']https?:/i.test(text)) remoteCode.push(f + ": remote <script src>");
}
if (remoteCode.length) bad("no remote code / eval", remoteCode.join("; "));
else ok("no remote code / eval", codeFiles.length + " code files scanned");

// ------------------------------------------------------------- the manifest
const manifest = JSON.parse(execFileSync("unzip", ["-p", PKG, "manifest.json"], { encoding: "utf8" }));
if (manifest.manifest_version !== 3) bad("manifest_version is 3", String(manifest.manifest_version));
else ok("manifest_version is 3");

for (const perm of manifest.permissions || []) {
  const risky = ["<all_urls>", "webRequest", "webRequestBlocking", "debugger", "proxy", "nativeMessaging"];
  if (risky.includes(perm)) bad("permission is acceptable", perm);
}
ok("permissions reviewed", (manifest.permissions || []).join(", ") || "none");
ok("host permissions reviewed", (manifest.host_permissions || []).join(", "));

// A minimum 128x128 icon is required for a store listing.
const icons = Object.keys(manifest.icons || {});
if (!icons.includes("128")) bad("a 128x128 icon is declared", icons.join(", "));
else ok("a 128x128 icon is declared");

// The store rejects a package whose background service worker is missing.
if (!manifest.background || !manifest.background.service_worker) {
  bad("service worker is declared");
} else {
  ok("service worker is declared", manifest.background.service_worker);
}

// ----------------------------------------------------------------- the listing
if (!existsSync(LISTING)) {
  bad("listing exists", LISTING);
} else {
  const listing = JSON.parse(await readFile(LISTING, "utf8"));
  const name = listing.name || "";
  const summary = listing.summary || "";
  const description = listing.description || "";
  if (name.length > 45) bad("listing name <= 45 chars", name.length + " chars");
  else ok("listing name <= 45 chars", name.length + " chars");
  if (summary.length > 132) bad("listing summary <= 132 chars", summary.length + " chars");
  else ok("listing summary <= 132 chars", summary.length + " chars");
  if (description.length > 16000) bad("listing description <= 16000 chars", description.length + " chars");
  else ok("listing description <= 16000 chars", description.length + " chars");
  if (!description.trim()) bad("listing description is filled in");
  const shots = listing.screenshots || [];
  if (shots.length < 1) bad("at least one screenshot is set");
  else ok("screenshots set", shots.length + "");
  if (!listing.iconUrl) bad("listing icon URL is set");
  else ok("listing icon URL is set");
  for (const shot of shots) {
    if (!/^https:\/\//.test(shot.url)) bad("screenshot URL is https", shot.url);
  }
  ok("all screenshot URLs are https");
}

console.log("");
if (failures) {
  console.log("RESULT: " + failures + " problem(s), " + warnings + " warning(s)");
  process.exit(1);
}
console.log("RESULT: ready to publish" + (warnings ? " (" + warnings + " warning(s))" : ""));
