#!/usr/bin/env bash
# A live, shared browser session the user can log into and I can drive.
#
#   Xvfb :99            virtual display
#   chromium            the real browser on that display, with CDP on 9222
#   x11vnc              exposes the display over VNC (localhost only)
#   websockify          bridges VNC to a websocket that nginx publishes
#
set -euo pipefail

DISPLAY_NUM=99
VNC_PORT=5900
WS_PORT=6080
CDP_PORT=9222
PROFILE=/tmp/cws-chrome-profile
CHROME=/home/ubuntu/.cache/ms-playwright/chromium-1223/chrome-linux/chrome

pkill -f "Xvfb :$DISPLAY_NUM" 2>/dev/null || true
pkill -f "x11vnc.*$VNC_PORT" 2>/dev/null || true
pkill -f "websockify.*$WS_PORT" 2>/dev/null || true
pkill -f "remote-debugging-port=$CDP_PORT" 2>/dev/null || true
sleep 1

mkdir -p "$PROFILE" /tmp/cws-logs

# 1. the virtual display
Xvfb :$DISPLAY_NUM -screen 0 1600x1000x24 -nolisten tcp > /tmp/cws-logs/xvfb.log 2>&1 &
sleep 2

# 2. the browser, headed on that display, with the extension preloaded
DISPLAY=:$DISPLAY_NUM "$CHROME" \
  --remote-debugging-port=$CDP_PORT \
  --remote-allow-origins=* \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check --no-sandbox --disable-dev-shm-usage \
  --disable-features=Translate,OptimizationHints \
  --window-size=1600,1000 --window-position=0,0 \
  --load-extension=/home/ubuntu/dsh-workspace/my-version \
  --disable-extensions-except=/home/ubuntu/dsh-workspace/my-version \
  about:blank > /tmp/cws-logs/chrome.log 2>&1 &
sleep 6

# 3. the VNC server, bound to localhost only
x11vnc -display :$DISPLAY_NUM -rfbport $VNC_PORT -localhost -forever -shared \
  -nopw -xkb -repeat -bg -o /tmp/cws-logs/x11vnc.log 2>&1 || true
sleep 2

# 4. websockify: noVNC's web page + the VNC websocket
websockify --web=/usr/share/novnc 127.0.0.1:$WS_PORT 127.0.0.1:$VNC_PORT \
  > /tmp/cws-logs/websockify.log 2>&1 &
sleep 2

echo "--- status ---"
ss -ltn 2>/dev/null | grep -E ":($VNC_PORT|$WS_PORT|$CDP_PORT)\b" || true
echo "CDP:  $(curl -s --max-time 5 http://127.0.0.1:$CDP_PORT/json/version | head -c 120)"
echo "noVNC: http://127.0.0.1:$WS_PORT/vnc.html"
