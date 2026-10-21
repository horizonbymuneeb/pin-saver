#!/usr/bin/env node
/**
 * Get a Chrome Web Store API refresh token.
 *
 * The Chrome Web Store API needs an OAuth 2.0 token with the
 * chromewebstore scope. This helper starts a one-shot local callback server,
 * prints the consent URL, and exchanges the returned code for a refresh token.
 * The token is written to .cws-credentials.json (git-ignored) so the publish
 * script can use it without pasting it around.
 *
 * Usage:
 *   node scripts/auth-chrome-web-store.mjs --client-id=... --client-secret=...
 *
 * Then open the printed URL, sign in, approve, and the script finishes.
 */
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const OUT = path.join(ROOT, ".cws-credentials.json");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const clientId = args["client-id"] || process.env.CWS_CLIENT_ID;
const clientSecret = args["client-secret"] || process.env.CWS_CLIENT_SECRET;
const scope = "https://www.googleapis.com/auth/chromewebstore";

if (!clientId || !clientSecret) {
  console.error(
    "ERROR: pass --client-id and --client-secret (or set CWS_CLIENT_ID / CWS_CLIENT_SECRET).",
  );
  process.exit(1);
}

const PORT = 8977;
// A Desktop-app client needs a loopback redirect. The port may be any free
// port and the path is not significant for an installed app.
const redirectUri = "http://localhost:" + PORT + "/";
// The authorization endpoint. https://oauth2.googleapis.com/auth does not
// exist and answers 404; the working one is accounts.google.com.
const AUTH_URL = "https://accounts.google.com/o/oauth2/auth";

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404).end("not found");
    return;
  }
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (!code) {
    res.writeHead(400).end("no code: " + (err || "unknown"));
    server.close();
    process.exit(1);
  }

  res
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(
      "<html><body style='font:16px sans-serif;padding:40px'>" +
        "<h2>Got it — you can close this tab.</h2>" +
        "<p>Back in the terminal, the refresh token is printed and saved.</p>" +
        "</body></html>",
    );

  exchange(code).finally(() => server.close());
});

async function exchange(code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.refresh_token) {
    console.error("ERROR: token exchange failed:", JSON.stringify(body).slice(0, 300));
    process.exit(1);
  }
  await writeFile(
    OUT,
    JSON.stringify(
      { client_id: clientId, client_secret: clientSecret, refresh_token: body.refresh_token },
      null,
      2,
    ),
  );
  console.log("\nREFRESH TOKEN (also saved to .cws-credentials.json):\n");
  console.log(body.refresh_token);
  console.log("\nNow run:");
  console.log("  npm run publish -- --item-id=<id>   (or omit --item-id to create one)");
  process.exit(0);
}

// Print the consent URL and stop: the caller opens it on their own machine
// and sends the authorization code back.
if (args["print-url"]) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scope,
    access_type: "offline",
    prompt: "consent",
  });
  console.log(AUTH_URL + "?" + params.toString());
  process.exit(0);
}

// Remote mode: the browser on the caller's machine cannot reach this
// server's localhost, so the consent flow ends on a page that cannot load.
// The authorization code is still in the address bar, and the caller pastes
// it back here.
if (args.code) {
  exchange(String(args.code)).catch((err) => {
    console.error("ERROR:", err.message);
    process.exit(1);
  });
} else {
server.listen(PORT, () => {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scope,
    access_type: "offline",
    prompt: "consent",
  });
  console.log("Open this URL in your browser, sign in, and approve:\n");
  console.log(AUTH_URL + "?" + params.toString() + "\n");
  console.log(
    "If the browser cannot reach this machine, the page will fail to load —\n" +
      "that is expected. Copy the `code` from the address bar and run:\n" +
      "  node scripts/auth-chrome-web-store.mjs --client-id=<id> " +
      "--client-secret=<secret> --code=<code>\n",
  );
  console.log("Waiting for the callback on http://localhost:" + PORT + " ...");
});
}
