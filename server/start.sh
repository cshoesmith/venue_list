#!/usr/bin/env bash
set -e

echo "[start] launching Xvfb on $DISPLAY ($VNC_RESOLUTION)"
Xvfb "$DISPLAY" -screen 0 "$VNC_RESOLUTION" -ac +extension RANDR +extension GLX &
XVFB_PID=$!

# Wait briefly for Xvfb socket to exist.
for i in $(seq 1 20); do
  [ -e /tmp/.X11-unix/X${DISPLAY#:} ] && break
  sleep 0.1
done

echo "[start] launching fluxbox"
fluxbox >/tmp/fluxbox.log 2>&1 &

echo "[start] launching x11vnc on :5900"
x11vnc -display "$DISPLAY" -forever -shared -nopw -quiet -rfbport 5900 \
       -bg -o /tmp/x11vnc.log

echo "[start] launching noVNC on :$NOVNC_PORT"
websockify --web=/usr/share/novnc "$NOVNC_PORT" localhost:5900 \
           >/tmp/novnc.log 2>&1 &

echo "[start] starting Node server on :$PORT"
exec node index.js
