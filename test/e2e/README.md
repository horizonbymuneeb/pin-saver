# End-to-end browser test

Loads the real unpacked extension into a real Chromium, redirects
`www.pinterest.com` / `i.pinimg.com` to a local mock origin, and drives the UI.

This is the only test that proves the whole chain works inside Chrome:

- the manifest loads and the service worker registers
- the content script injects the panel and per-pin buttons
- the resource API is called (`BoardResource`, `BoardFeedResource`)
- media is fetched at `/originals/` through the background worker
- a real ZIP with pins + metadata lands on disk
- a real PDF with one page per image lands on disk
- the per-pin button saves a single image
- no page or console errors

It runs 18 checks and caught a bug the unit tests could not: Chrome JSON-serialises
`chrome.runtime.sendMessage` payloads, turning a `Uint8Array` into
`{"0":137,"1":80,...}`. Binary now crosses as base64.

## Run

```bash
npm i -D playwright-core
npx playwright install chromium
npm run test:e2e
```

Override auto-detection with `CHROME_PATH=/path/to/chrome`, or point at another
extension copy with `EXT_DIR=/path/to/extension`.

## Files

| File | Purpose |
|---|---|
| `run-e2e.js` | Playwright driver + assertions |
| `server.js` | mock Pinterest origin (board page, resource API, media) |
| `cert.pem` / `key.pem` | self-signed cert for the mock HTTPS origin (CN=www.pinterest.com) |
| `mock.jpg` | stand-in image bytes served as pin media |

The mock port is 8443; override with `MOCK_PORT`.
