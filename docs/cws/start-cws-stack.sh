#!/usr/bin/env bash
# The shared browser stack for the Chrome Web Store work.
#
#   1. Xvfb :99 + Chromium 148 with the extension preloaded (CDP on 9222)
#   2. the live view: the browser's own frames over the DevTools Protocol,
#      streamed to the browser with server-sent events; clicks and keys go
#      back through Input.dispatch*. No VNC, no framebuffer scraping.
#   3. browserless in Docker: a disposable, open-source remote browser with
#      its own debugger UI
#   4. nginx publishes all three behind the DSH session gate
#
# The nginx paths carry random tokens, so the URLs below are the only way in.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LOGS=/tmp/cws-logs
mkdir -p "$LOGS"

echo "== 1. the virtual display and the browser =="
bash "$HERE/start-live-browser.sh"

echo
echo "== 2. the live view =="
for pid in $(ss -ltnp 2>/dev/null | awk '/127.0.0.1:6090/{print $0}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
  kill "$pid" 2>/dev/null
done
sleep 1
cd "$HERE" && nohup node liveview.mjs > "$LOGS/liveview.log" 2>&1 &
sleep 4
curl -s --max-time 8 http://127.0.0.1:6090/status && echo

echo
echo "== 3. browserless =="
cd "$HERE/browserless" && docker compose up -d chrome 2>&1 | tail -2
sleep 8
curl -s --max-time 8 http://127.0.0.1:3000/json/version | head -c 80 && echo

echo
echo "== 4. the published URLs =="
for f in /tmp/live_token.txt /tmp/bl_token.txt; do
  [ -f "$f" ] && echo "  token file: $f -> $(cat $f)"
done
echo "  live view : https://dsh.hhdevs.space/cws-live-$(cat /tmp/live_token.txt 2>/dev/null)/"
echo "  browserless: https://dsh.hhdevs.space/cws-bl-$(cat /tmp/bl_token.txt 2>/dev/null)/"
echo "  noVNC     : https://dsh.hhdevs.space/cws-$(cat /tmp/cws_path_token.txt 2>/dev/null)/"
