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
