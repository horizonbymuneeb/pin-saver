/**
 * Pre-flight validation: catches the mistakes that make Chrome silently
 * refuse to load an unpacked extension (bad manifest references, syntax
 * errors, missing icons).
 *
 * Run: node scripts/check.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const problems = [];
const notes = [];

function must(condition, message) {
  if (!condition) problems.push(message);
}

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  } catch (err) {
    problems.push(`Cannot parse ${rel}: ${err.message}`);
    return null;
  }
}

const manifest = readJson("manifest.json");
if (manifest) {
  must(manifest.manifest_version === 3, "manifest_version must be 3");
  must(Boolean(manifest.name), "name is required");
  must(Boolean(manifest.version), "version is required");

  // Every file the manifest points at must exist.
  const referenced = new Set();
  if (manifest.background && manifest.background.service_worker) {
    referenced.add(manifest.background.service_worker);
  }
  if (manifest.action) {
    if (manifest.action.default_popup) referenced.add(manifest.action.default_popup);
    for (const icon of Object.values(manifest.action.default_icon || {})) {
      referenced.add(icon);
    }
  }
  for (const icon of Object.values(manifest.icons || {})) referenced.add(icon);
  for (const cs of manifest.content_scripts || []) {
    for (const f of [...(cs.js || []), ...(cs.css || [])]) referenced.add(f);
  }
  for (const rel of referenced) {
    must(fs.existsSync(path.join(root, rel)), `manifest references missing file: ${rel}`);
  }

  // Only permissions the code actually uses. Anything else is dead weight that
  // widens the install warning for no benefit.
  const perms = manifest.permissions || [];
  must(perms.includes("downloads"), "missing required permission: downloads");

  const usedApis = ["chrome.downloads", "chrome.tabs", "chrome.action", "chrome.runtime"];
  const permFor = { "chrome.storage": "storage", "chrome.scripting": "scripting" };
  for (const entry of Object.entries(permFor)) {
    const [api, perm] = entry;
    if (perms.includes(perm)) {
      // Only meaningful as a warning: an unused permission is not fatal.
      const fsx = require("node:fs");
      const dirs = ["src", "popup"];
      let used = false;
      for (const d of dirs) {
        const walk = function (dir) {
          for (const f of fsx.readdirSync(dir, { withFileTypes: true })) {
            const full = dir + "/" + f.name;
            if (f.isDirectory()) walk(full);
            else if (/\.js$/.test(f.name) && fsx.readFileSync(full, "utf8").includes(api)) used = true;
          }
        };
        try { walk(d); } catch (_) {}
      }
      if (!used) console.warn("  warning: " + perm + " permission declared but " + api + " is never used");
    }
  }
  void usedApis;

  const hosts = (manifest.host_permissions || []).join(" ");
  must(hosts.includes("pinterest.com"), "host_permissions must include pinterest.com");
  must(hosts.includes("pinimg.com"), "host_permissions must include pinimg.com");
}

// Syntax-check every shipped script.
const scripts = ["src/background.js", "src/content.js", "src/lib/util.js", "src/lib/zip.js", "src/lib/api.js", "src/lib/pdf.js", "src/lib/video.js", "popup/popup.js"];
for (const rel of scripts) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    problems.push(`missing script: ${rel}`);
    continue;
  }
  try {
    execFileSync(process.execPath, ["--check", abs], { stdio: "pipe" });
  } catch (err) {
    problems.push(`syntax error in ${rel}: ${String(err.stderr || err.message).split("\n")[0]}`);
  }
}

// Icons must be real PNG files.
for (const rel of ["icons/icon16.png", "icons/icon48.png", "icons/icon128.png"]) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    problems.push(`missing icon: ${rel}`);
    continue;
  }
  const head = fs.readFileSync(abs).subarray(0, 8);
  const isPng =
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  must(isPng, `${rel} is not a valid PNG`);
}

notes.push(`checked ${scripts.length} scripts, ${referencedSize(manifest)} manifest paths`);

function referencedSize(m) {
  return m ? "all" : "0";
}

if (problems.length) {
  console.error("FAILED:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

console.log("OK: extension is structurally valid and loadable");
for (const n of notes) console.log("  " + n);
