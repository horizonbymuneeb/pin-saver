# Pin Saver — Privacy Policy

**Last updated: 21 October 2026**

## Summary

Pin Saver does not collect, store, transmit, sell, or share any personal data.
Everything the extension does happens on your own device.

## What the extension does

Pin Saver is a local helper for saving the Pinterest pins that are already
visible on a board you have opened. It:

- reads the pin list for the board you are viewing, using Pinterest's own
  public API, from the browser session you are already signed in with;
- downloads the image or video files of those pins directly from Pinterest's
  own CDN (`pinimg.com`);
- writes a ZIP archive (or a PDF) to your Downloads folder using the browser's
  own download feature;
- writes a small `_metadata.csv` / `_metadata.json` file inside that archive
  describing each pin (title, link, section name).

## What is stored

Nothing. The extension has no server, no database, no analytics, no telemetry,
no crash reporting, and no background service. It keeps no history of what you
have downloaded.

The only two permissions the extension requests are:

| Permission | Why it is needed |
|---|---|
| `activeTab` | to show the small download panel on the board page you opened |
| `downloads` | to write the ZIP / PDF file into your own Downloads folder |

## Cookies and your Pinterest session

The extension never reads, stores, copies, or transmits cookies. When it asks
Pinterest for the pin list of a board, the request is made from your browser
to `pinterest.com` exactly like the website's own front-end does, so your
existing Pinterest sign-in is used and your session stays inside your browser.
No cookie value is ever exposed to the extension, and nothing is sent anywhere
except to Pinterest itself.

## Videos

Video pins are fetched from Pinterest's own video CDN. The extension does not
upload, re-encode for distribution, or share them anywhere.

## Third parties

None. The extension contacts only:

- `pinterest.com` — to read the board you are viewing
- `*.pinimg.com` — to download the image and video files

## Children

The extension is not directed at children and collects no data from anyone.

## Changes

If this policy changes, the updated version will be published in the Chrome
Web Store listing for this extension, along with the new version's review
notes.

## Contact

Questions about this policy can be raised through the Chrome Web Store listing
for this extension.
