# ---------- Stage 1: build the React client ----------
FROM node:20-bookworm-slim AS client-builder
WORKDIR /client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---------- Stage 2: runtime (Playwright + Chrome + Xvfb + noVNC) ----------
FROM mcr.microsoft.com/playwright:v1.47.0-jammy AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
 && ln -fs /usr/share/zoneinfo/$TZ /etc/localtime \
 && dpkg-reconfigure -f noninteractive tzdata \
 && apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        fluxbox \
        novnc \
        websockify \
        wget \
        gnupg \
        ca-certificates \
        tini \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install server deps.
COPY server/package*.json ./
RUN npm ci --omit=dev

# Copy server source + start script.
COPY server/ ./

# Copy the built client into /app/public so Express can serve it.
COPY --from=client-builder /client/dist ./public

ENV CHROME_PATH=/usr/bin/google-chrome \
    USER_DATA_DIR=/app/.user-data \
    CHROME_NO_SANDBOX=1 \
    DISPLAY=:99 \
    VNC_RESOLUTION=1440x900x24 \
    NOVNC_PORT=6080 \
    PORT=5175 \
    STATIC_DIR=/app/public

EXPOSE 5175 6080

RUN chmod +x /app/start.sh
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
