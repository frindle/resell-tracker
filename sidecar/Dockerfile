# Real headed Chrome under Xvfb, not --headless. The migration research
# (see Obsidian Claude/Projects/resell-tracker.md) found headless launch
# flags trigger more Amazon/Walmart bot detection than a genuine headed
# browser on a virtual display — same conclusion this user's
# teams-shifts-exporter-docker project reached, and that pattern is
# mirrored here for consistency. node:22-slim (Debian), not alpine — musl
# makes real Chrome installs fragile (per that project's Dockerfile notes
# and the main app's own alpine base, which has no Chromium at all).
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    wget gnupg2 ca-certificates \
    xvfb x11vnc \
    --no-install-recommends \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
     | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
     http://dl.google.com/linux/chrome/deb/ stable main" \
     > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY entrypoint.sh ./
RUN chmod +x ./entrypoint.sh

ENV CHROME_PATH=/usr/bin/google-chrome-stable
ENV DATA_DIR=/data
ENV DISPLAY=:99

EXPOSE 5900

CMD ["./entrypoint.sh"]
