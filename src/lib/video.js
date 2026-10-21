/**
 * Pinterest video resolution.
 *
 * What the API hands out for a video pin is an HLS **master** playlist
 * (`.m3u8`, <1 KB). Saving that byte-for-byte would give the user a text file,
 * not a video — so the real media file has to be located first.
 *
 * Observed shape of a Pinterest HLS stream:
 *
 *   master.m3u8
 *     └─ #EXT-X-STREAM-INF ... → <hash>_240w.m3u8 … <hash>_720w.m3u8
 *          └─ #EXT-X-MAP:URI="<hash>_720w.cmfv",BYTERANGE="972@0"
 *             #EXT-X-BYTERANGE:411223@1132 → <hash>_720w.cmfv
 *             … all segments are BYTERANGE slices of that ONE .cmfv file
 *
 * Because every segment is a byte range of the same `.cmfv` file and the
 * ranges are contiguous, that single file *is* the complete fragmented MP4.
 * Downloading it (and saving it as `.mp4`) yields a normal, playable video —
 * no remuxing, no ffmpeg, no segment concatenation.
 *
 * Verified against production: a 720w `.cmfv` returned `video/mp4`, `ftyp
 * iso6`, and ffprobe reported h264 720x1280.
 */
(function (root) {
  "use strict";

  const PK = (root.PK = root.PK || {});

  /** Parse attribute lists like `BANDWIDTH=123,RESOLUTION=720x1280`. */
  function parseAttributes(line) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(line))) {
      let value = m[2];
      if (value && value[0] === '"' && value[value.length - 1] === '"') {
        value = value.slice(1, -1);
      }
      attrs[m[1]] = value;
    }
    return attrs;
  }

  /**
   * Parse a master playlist into variants, highest bandwidth first.
   * @returns {Array<{bandwidth:number, resolution:string, uri:string}>}
   */
  function parseMasterPlaylist(text) {
    const lines = String(text || "").split(/\r?\n/);
    const variants = [];
    let pending = null;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
        pending = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
        continue;
      }
      if (line[0] === "#") continue;
      if (pending) {
        variants.push({
          bandwidth: parseInt(pending.BANDWIDTH || "0", 10) || 0,
          resolution: pending.RESOLUTION || "",
          uri: line,
        });
        pending = null;
      }
    }

    variants.sort(function (a, b) {
      return b.bandwidth - a.bandwidth;
    });
    return variants;
  }

  /**
   * Parse a media playlist, returning the media file and whether it was
   * declared as an external / HLS variant playlist.
   * @returns {{mapUri: string|null, segmentUri: string|null, isMedia: boolean}}
   */
  function parseMediaPlaylist(text) {
    const lines = String(text || "").split(/\r?\n/);
    let mapUri = null;
    let segmentUri = null;
    let isMedia = false;
    let isMaster = false;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // A master playlist advertises variant streams; its plain URI lines are
      // other playlists, not media segments, so it must not be treated as
      // media.
      if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
        isMaster = true;
        continue;
      }
      if (line.indexOf("#EXT-X-MAP:") === 0) {
        const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
        if (attrs.URI) mapUri = attrs.URI;
        isMedia = true;
        continue;
      }
      if (line[0] === "#") continue;
      if (!segmentUri) segmentUri = line;
      isMedia = true;
    }

    if (isMaster) {
      return { mapUri: null, segmentUri: null, isMedia: false };
    }
    return { mapUri: mapUri, segmentUri: segmentUri, isMedia: isMedia };
  }

  /** Resolve a possibly-relative playlist URI against its own URL. */
  function resolveUri(baseUrl, uri) {
    try {
      return new URL(uri, baseUrl).toString();
    } catch (_) {
      return uri;
    }
  }

  /** True when the URL is already a direct, saveable media file. */
  function isDirectMedia(url) {
    return /\.(mp4|mov|webm|cmfv)(\?|$)/i.test(String(url || ""));
  }

  /**
   * Turn a video URL into a direct MP4 URL.
   *
   * @param {string} url     whatever the pin object supplied
   * @param {Function} fetchFn  injectable for tests (defaults to global fetch)
   * @returns {Promise<{url: string, kind: string, bandwidth?: number}>}
   */
  async function resolveVideoUrl(url, fetchFn) {
    const doFetch = fetchFn || fetch;
    if (!url) throw new Error("No video URL");
    if (isDirectMedia(url)) {
      return { url: url, kind: "direct" };
    }
    if (!/\.m3u8(\?|$)/i.test(url)) {
      // Unknown shape — hand it back and let the caller try.
      return { url: url, kind: "unknown" };
    }

    // 1. Master playlist → best variant.
    const masterText = await fetchText(url, doFetch);
    const variants = parseMasterPlaylist(masterText);

    let mediaUrl = url;
    let bandwidth = null;
    if (variants.length) {
      mediaUrl = resolveUri(url, variants[0].uri);
      bandwidth = variants[0].bandwidth;
    }

    // 2. Variant playlist → the single media file backing every segment.
    const mediaText = await fetchText(mediaUrl, doFetch);
    const media = parseMediaPlaylist(mediaText);

    const fileUri = media.mapUri || media.segmentUri;
    if (!fileUri) {
      throw new Error("HLS playlist did not reference a media file");
    }

    const fileUrl = resolveUri(mediaUrl, fileUri);
    if (!isDirectMedia(fileUrl)) {
      // Some pins use true segmented .ts streams; those need remuxing, which
      // is out of scope. Report it instead of saving a useless playlist.
      throw new Error("Video is segmented and cannot be saved directly: " + fileUrl);
    }

    return { url: fileUrl, kind: "hls-file", bandwidth: bandwidth };
  }

  async function fetchText(url, doFetch) {
    const res = await doFetch(url, {
      method: "GET",
      headers: { Referer: "https://www.pinterest.com/" },
      credentials: "omit",
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " fetching playlist");
    return res.text();
  }

  PK.video = {
    parseAttributes: parseAttributes,
    parseMasterPlaylist: parseMasterPlaylist,
    parseMediaPlaylist: parseMediaPlaylist,
    resolveUri: resolveUri,
    isDirectMedia: isDirectMedia,
    resolveVideoUrl: resolveVideoUrl,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = PK.video;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
