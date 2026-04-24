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

The scraper can run in a container that ships real Google Chrome, Xvfb, and a noVNC bridge so you can see / drive the headed browser from any web browser (required for the one-time Untappd login and any Cloudflare challenges).

### Start

```powershell
docker compose up -d --build
```

Exposed ports:
- `5175` — REST API (the React client talks to this via the Vite proxy just like before).
- `6080` — noVNC web UI.

The Untappd profile cookies are persisted in a named Docker volume (`userdata`), so logins survive container restarts and rebuilds.

### First-time login (inside the container)

1. Start the client locally: `npm run client` (still points at `localhost:5175`).
2. Open the app at http://localhost:5173 and click **Open login window**. Chrome launches *inside* the container on its virtual display; you can't see it yet.
3. Open http://localhost:6080/vnc.html → **Connect** (no password). You'll see the container's desktop with the Chromium window on Untappd.
4. Log in to Untappd. Solve any Cloudflare checkbox. Close the tab when done.
5. Back in the app, the status dot should flip to **logged in to Untappd**.

From then on the session cookie lives in the `userdata` volume and everything works the same as the host-based setup.

### Stop / rebuild / reset

```powershell
docker compose down           # stop
docker compose up -d --build  # rebuild after code changes
docker compose down -v        # also wipe the login volume (forces re-login)
```

