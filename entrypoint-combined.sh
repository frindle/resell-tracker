#!/bin/bash
set -e

# Create data directories
mkdir -p /data/sessions /data/debug /data/files

echo "[combined-entrypoint] Starting resell-tracker container with all services..."

# Start the Next.js app on port 3000 in background
echo "[combined-entrypoint] Starting Next.js application..."
node_modules/.bin/prisma migrate deploy && node server.js &
APP_PID=$!

# Virtual framebuffer for Chrome — every Playwright launch runs headed (headless:false)
# against this display, both the one-time interactive login and unattended poll-loop.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
XVFB_PID=$!

# Wait a moment for Xvfb to start
sleep 1

# Start VNC server so users can see/drive the one-time interactive login
echo "[combined-entrypoint] Starting VNC server..."
mkdir -p /tmp/.vnc
rm -f /tmp/.vnc/passwd

# Generate a random password if none is set (this mimics the original sidecar behavior)
if [ -z "$VNC_PASSWORD" ]; then
  VNC_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")
  echo "[combined-entrypoint] Generated one-time password: $VNC_PASSWORD"
fi

# Set up the password file for x11vnc (using the same approach as original sidecar)
printf '%s\n' "$VNC_PASSWORD" > /tmp/.vnc/passwd
x11vnc -display :99 -forever -quiet -passwdfile read:/tmp/.vnc/passwd &
VNC_PID=$!

# Start noVNC proxy for browser access to VNC
echo "[combined-entrypoint] Starting noVNC proxy..."
websockify --web=/usr/share/novnc 6080 localhost:5900 & 
NOVNC_PID=$!

# Start the sidecar poller in background
echo "[combined-entrypoint] Starting sidecar poller..."
node ./src/poll.js &
POLLER_PID=$!

# Start OCR service on port 8080 if enabled
if [ "$GIFTCARD_OCR_ENABLED" = "true" ]; then
    echo "[combined-entrypoint] Starting gift-card OCR service..."
    # Preload the model at startup (like in original Dockerfile)
    python preload.py
    
    # Start the OCR server
    python server.py &
    OCR_PID=$!
else
    echo "[combined-entrypoint] Gift-card OCR service disabled by GIFTCARD_OCR_ENABLED flag"
fi

echo "[combined-entrypoint] All services started successfully!"
echo "[combined-entrypoint] App: 3000, VNC: 5900, noVNC: 6080, OCR: 8080"

# Wait for all processes to complete
wait $APP_PID $XVFB_PID $VNC_PID $NOVNC_PID $POLLER_PID $OCR_PID