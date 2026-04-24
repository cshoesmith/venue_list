# venue_list

Local web app for exploring an Untappd venue's beer list and highlighting which beers you have (or haven't) had.

Because Untappd aggressively blocks scrapers and does not expose a "have I had this beer" flag through its public API, this app drives a real Chromium browser via Playwright. You log in once in a visible browser window, and the session is reused for every subsequent scrape.

## Prerequisites

- Node.js 18+
- Windows / macOS / Linux

## Install

```powershell
npm run install:all
```

This installs root, server, and client dependencies and downloads the Chromium build Playwright needs.

## First-time login

Start the server (or the whole app) and open the UI:

```powershell
npm run dev
```

- Server: http://localhost:5175
- Client: http://localhost:5173

In the UI, click **Open login window**. A Chromium window appears -- log in to Untappd normally, then close the window. The session is stored in `server/.user-data/` (git-ignored) and reused on future runs.

## Using the app

1. Type a venue name (e.g. "Monkish Brewing").
2. Pick the correct venue from the results (address shown).
3. The app opens the venue's menu, scrapes every beer, and shows whether you've had each one.
4. Toggle between **All beers**, **Not had** and **Had**.

## Notes

- Selectors in `server/scraper.js` are the most likely thing to drift when Untappd tweaks its markup. If results look wrong, hit `/api/debug/last` on the server to see the last page HTML the scraper saw.
- Do not abuse this -- it hits Untappd from your own logged-in session. Keep volume low.

## Running the server in Docker

The scraper runs in a container that ships real Google Chrome, Xvfb, a noVNC bridge (so you can log in to Untappd from any browser), and the **built React client** served by Express on the same port as the API.

### Configure

Copy `.env.example` to `.env` and fill in:

```ini
APP_SECRET=<long random string>
TUNNEL_TOKEN=<from Cloudflare Zero Trust → Tunnels>
```

### Start

```powershell
docker compose up -d --build
```

Exposed ports on the host:
- `5175` — UI + API (Express serves the built client and `/api/*`).
- `6080` — noVNC web UI for driving the container's Chrome.

Persistent Untappd login lives in a Docker volume (`userdata`) so it survives rebuilds.

### First-time Untappd login

1. Open http://localhost:5175/#k=YOUR_APP_SECRET (the hash seeds the client's stored secret, then is stripped from the URL).
2. Click **Open login window**. Chrome launches on the container's virtual display.
3. Open http://localhost:6080/vnc.html → **Connect** (no password). You'll see Chrome on Untappd; log in and solve any Cloudflare challenge.
4. Back on :5175 the status dot flips to green.

### Public access via Cloudflare Tunnel

Goal: `https://verified.craftbeers.app` → your machine's container → the app.

1. Cloudflare dashboard → **Zero Trust** → **Networks → Tunnels** → **Create tunnel** (Cloudflared).
2. Name it (e.g. `venue_list`). Copy the generated **connector token** into `.env` as `TUNNEL_TOKEN`.
3. In the tunnel's **Public Hostname** tab, add a route:
   - Subdomain: `verified`  Domain: `craftbeers.app`
   - Service: `HTTP`  URL: `venue_list:5175`  ← this is the compose service name; cloudflared resolves it on the Docker network.
4. DNS: the tunnel wizard auto-creates the CNAME. Verify `verified.craftbeers.app` appears in your DNS records.
5. `docker compose up -d` (the `cloudflared` service reads `TUNNEL_TOKEN` and connects).
6. Share the URL with a hash-seeded secret the first time: `https://verified.craftbeers.app/#k=YOUR_APP_SECRET`. After that, the client remembers it in localStorage.

Anyone hitting the URL without the secret gets `401` on `/api/*`. The UI itself loads but can't fetch data.

### Stop / rebuild / reset

```powershell
docker compose down           # stop
docker compose up -d --build  # rebuild after code changes
docker compose down -v        # also wipe the login volume (forces re-login)
```

