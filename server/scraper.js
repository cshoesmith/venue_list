import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = process.env.USER_DATA_DIR || path.join(__dirname, '.user-data');
const CDP_PORT = Number(process.env.CDP_PORT) || 9333;
const CHROME_NO_SANDBOX = /^(1|true|yes)$/i.test(process.env.CHROME_NO_SANDBOX || '');

// CHROME_PATH env wins; otherwise fall back to the most likely location per OS.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

let chromeProc = null;
let browser = null;
let context = null;
let lastDebugHtml = '';

// Cache of beer IDs the user has checked in to. Populated lazily.
let hadBeerIds = null;
let hadUsername = null;

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  throw new Error('Could not find Google Chrome. Set CHROME_PATH env var.');
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => {
      s.end(); resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome CDP port ${port} never opened`);
}

async function ensureChrome() {
  if (chromeProc && !chromeProc.killed && (await portOpen(CDP_PORT))) return;
  if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const exe = findChrome();
  // Minimal, clean flags. Critically NO --enable-automation and NO
  // --disable-blink-features=AutomationControlled (the latter is itself a tell).
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
  ];
  if (CHROME_NO_SANDBOX) {
    // Required when running as root inside a container; also bypasses /dev/shm issues.
    args.push('--no-sandbox', '--disable-dev-shm-usage');
  }
  args.push('about:blank');
  console.log('[scraper] launching Chrome:', exe);
  chromeProc = spawn(exe, args, { detached: false, stdio: 'ignore' });
  chromeProc.on('exit', (code) => {
    console.log('[scraper] Chrome exited, code=', code);
    chromeProc = null;
    browser = null;
    context = null;
  });
  await waitForPort(CDP_PORT);
}

async function getContext() {
  await ensureChrome();
  if (browser && browser.isConnected() && context) return context;
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  // Use the default (first) context of the real Chrome profile.
  const contexts = browser.contexts();
  context = contexts[0] || (await browser.newContext());
  return context;
}

export async function shutdown() {
  try { if (browser && browser.isConnected()) await browser.close(); } catch { /* ignore */ }
  try { if (chromeProc && !chromeProc.killed) chromeProc.kill(); } catch { /* ignore */ }
}

export function getLastDebug() {
  return lastDebugHtml;
}

export async function isLoggedIn() {
  const ctx = await getContext();
  // Try multiple cookie lookup strategies — CDP-attached contexts can be finicky.
  let cookies = [];
  try { cookies = await ctx.cookies('https://untappd.com'); } catch { /* ignore */ }
  if (!cookies.length) {
    try { cookies = await ctx.cookies(); } catch { /* ignore */ }
  }
  // Last resort: use raw CDP to dump ALL cookies.
  if (!cookies.length) {
    try {
      const cdp = await ctx.newCDPSession(await ctx.newPage());
      const { cookies: cdpCookies } = await cdp.send('Storage.getCookies');
      cookies = cdpCookies;
    } catch { /* ignore */ }
  }
  const untappdCookies = cookies.filter((c) =>
    /untappd\.com$/i.test((c.domain || '').replace(/^\./, '')),
  );
  console.log(
    `[scraper] isLoggedIn cookies: total=${cookies.length} untappd=${untappdCookies.length} names=[${untappdCookies.map((c) => c.name).join(',')}]`,
  );
  return untappdCookies.some((c) => /^untappd_(user|session)_/i.test(c.name));
}

export async function openLoginWindow() {
  const ctx = await getContext();
  const page = await ctx.newPage();
  // Fire-and-forget navigation so the HTTP request returns immediately.
  page.goto('https://untappd.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
  try { await page.bringToFront(); } catch { /* ignore */ }
  return { opened: true, loggedIn: await isLoggedIn() };
}

async function goSafely(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  const isChallenge = async () => {
    const title = await page.title().catch(() => '');
    if (/just a moment|attention required/i.test(title)) return true;
    const body = await page.locator('body').innerText().catch(() => '');
    return /verify you are human|checking your browser|cloudflare/i.test(body);
  };

  for (let i = 0; i < 30; i++) {
    if (!(await isChallenge())) break;
    await page.waitForTimeout(1000);
  }
  if (await isChallenge()) {
    lastDebugHtml = await page.content();
    throw new Error(
      'Cloudflare challenge blocked the request. Switch to the Chrome window, solve the checkbox, then retry.',
    );
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

async function getUsername(ctx) {
  if (hadUsername) return hadUsername;
  const page = await ctx.newPage();
  try {
    await goSafely(page, 'https://untappd.com/home');
    const username = await page.evaluate(() => {
      // The profile link is /user/<username> in the account menu.
      const links = Array.from(document.querySelectorAll('a[href^="/user/"]'));
      for (const a of links) {
        const m = (a.getAttribute('href') || '').match(/^\/user\/([^/?#]+)$/);
        if (m) return m[1];
      }
      return null;
    });
    if (!username) throw new Error('Could not detect Untappd username.');
    hadUsername = username;
    console.log('[scraper] detected username:', username);
    return username;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Scrape the user's entire beer history. Returns a Set of beer IDs (as strings).
 * Uses the /user/<name>/beers page and repeatedly clicks "Show More".
 */
async function loadHadBeerIds(ctx, force = false) {
  if (hadBeerIds && !force) return hadBeerIds;
  const username = await getUsername(ctx);
  const page = await ctx.newPage();
  try {
    await goSafely(page, `https://untappd.com/user/${encodeURIComponent(username)}/beers`);

    // Click "Show More" until it's gone or stops loading new entries.
    let prevCount = 0;
    for (let i = 0; i < 500; i++) {
      const count = await page.locator('a[href*="/b/"]').count();
      const btn = page
        .locator('a.more_checkins, a:has-text("Show More"), button:has-text("Show More"), a.show-more, button.show-more')
        .first();
      if (!(await btn.count())) {
        // Try infinite-scroll: scroll to bottom.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(800);
        const newCount = await page.locator('a[href*="/b/"]').count();
        if (newCount === count) break;
        continue;
      }
      try {
        await btn.scrollIntoViewIfNeeded({ timeout: 2000 });
        await btn.click({ timeout: 2500 });
      } catch {
        break;
      }
      await page.waitForTimeout(600);
      const newCount = await page.locator('a[href*="/b/"]').count();
      if (newCount === prevCount && newCount === count) break;
      prevCount = newCount;
    }

    const ids = await page.evaluate(() => {
      const set = new Set();
      document.querySelectorAll('a[href*="/b/"]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/b\/[^/?#]+\/(\d+)/);
        if (m) set.add(m[1]);
      });
      return Array.from(set);
    });

    hadBeerIds = new Set(ids);
    console.log(`[scraper] loaded ${hadBeerIds.size} had-beer IDs for ${username}`);
    return hadBeerIds;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function refreshHadBeers() {
  const ctx = await getContext();
  const ids = await loadHadBeerIds(ctx, true);
  return { count: ids.size, username: hadUsername };
}


export async function searchVenues(query) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    const url = `https://untappd.com/search?q=${encodeURIComponent(query)}&type=venues`;
    console.log('[scraper] searchVenues:', url);
    await goSafely(page, url);
    lastDebugHtml = await page.content();

    const venues = await page.evaluate(() => {
      const out = [];
      // Find every link to a venue page, then walk up to the nearest container
      // to grab name/address context.
      const links = document.querySelectorAll('a[href*="/v/"]');
      links.forEach((link) => {
        const href = link.getAttribute('href') || '';
        const m = href.match(/^\/?v\/([^/?#]+)\/(\d+)/) || href.match(/untappd\.com\/v\/([^/?#]+)\/(\d+)/);
        if (!m) return;
        const fullUrl = href.startsWith('http') ? href : `https://untappd.com${href}`;
        // Walk up to a plausible container
        let container = link.closest('li, .item, .beer-item, .venue-item, .result, article, div.search-result, div');
        for (let i = 0; i < 4 && container; i++) {
          if (container.querySelector && container.innerText && container.innerText.length > 20) break;
          container = container.parentElement;
        }
        const root = container || link.parentElement || link;

        // Name: prefer the link's own text if meaningful, else a heading.
        let name = (link.textContent || '').trim();
        if (!name || name.length < 2) {
          const h = root.querySelector('h1, h2, h3, h4, h5, .name, p.name');
          if (h) name = (h.textContent || '').trim();
        }
        // Address: look for typical address-bearing elements.
        const addrEl = root.querySelector('.address, p.address, .location, .venue-address');
        let address = addrEl ? (addrEl.textContent || '').trim() : '';
        if (!address) {
          // Fallback: any text line that looks like an address (contains comma + digits or state abbr).
          const lines = (root.innerText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
          const candidate = lines.find((l) =>
            l !== name && /,/.test(l) && /\b\d/.test(l) && l.length < 120,
          );
          if (candidate) address = candidate;
        }
        out.push({ id: m[2], name, address, url: fullUrl });
      });
      const seen = new Set();
      return out.filter((v) => {
        if (!v.name || !v.url) return false;
        if (seen.has(v.url)) return false;
        seen.add(v.url);
        return true;
      });
    });

    console.log(`[scraper] searchVenues found ${venues.length} venues`);
    return venues;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function getVenueMenu(venueUrl) {
  if (!/^https?:\/\/(www\.)?untappd\.com\/v\//i.test(venueUrl)) {
    throw new Error('Not an Untappd venue URL');
  }
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await goSafely(page, venueUrl);

    for (let i = 0; i < 25; i++) {
      const btn = page
        .locator('a:has-text("Show More"), button:has-text("Show More"), a.show-more, button.show-more')
        .first();
      if (!(await btn.count())) break;
      try {
        await btn.click({ timeout: 2000 });
        await page.waitForTimeout(500);
      } catch { break; }
    }

    lastDebugHtml = await page.content();

    const info = await page.evaluate(() => {
      const nameEl = document.querySelector('.venue-name h1, .venue h1, h1');
      const addrEl = document.querySelector('.venue-address, .address, p.address');
      return {
        name: nameEl ? nameEl.textContent.trim() : '',
        address: addrEl ? addrEl.textContent.trim() : '',
      };
    });

    // Iterate menu sections. Structure on Untappd venue pages:
    //   <div class="menu-section">
    //     <div class="menu-section-header"><h4>Section Name</h4> ...</div>
    //     <ul> <li class="menu-item"> <div class="beer-info drankit?"> ... </li> ... </ul>
    //   </div>
    const sections = await page.evaluate(() => {
      function extractBeer(row) {
        // row is the <li.menu-item> or a .beer-info wrapper
        const info = row.querySelector('.beer-info') || row;
        const link = info.querySelector('h5 a[href*="/b/"], a[href*="/b/"]');
        if (!link) return null;
        const href = link.getAttribute('href') || '';
        const m = href.match(/\/b\/([^/?#]+)\/(\d+)/);
        if (!m) return null;
        const id = m[2];
        const url = href.startsWith('http') ? href : `https://untappd.com${href}`;
        const name = (link.textContent || '').trim();

        const had =
          info.classList.contains('drankit') ||
          !!info.querySelector('.drankit') ||
          !!row.querySelector('.drankit');

        const emEl = info.querySelector('h5 em');
        const style = emEl ? (emEl.textContent || '').trim() : '';

        const breweryEl = info.querySelector('h6 a[href*="/w/"], a[href*="/w/"]');
        const brewery = breweryEl ? (breweryEl.textContent || '').trim() : '';

        const blockText = (info.innerText || '').slice(0, 600);
        const abvMatch = blockText.match(/([\d.]+)\s*%\s*ABV/i);
        const abv = abvMatch ? `${abvMatch[1]}% ABV` : '';
        const ibuMatch = blockText.match(/([\d.]+|N\/A)\s*IBU/i);
        const ibu = ibuMatch && ibuMatch[1] !== 'N/A' ? `${ibuMatch[1]} IBU` : '';

        const labelImg = info.querySelector('.beer-label img, img[src*="labels.untappd.com"]');
        const label = labelImg ? labelImg.getAttribute('src') || '' : '';

        let rating = null;
        const capsEl = info.querySelector('.caps[data-rating]');
        if (capsEl) {
          const r = parseFloat(capsEl.getAttribute('data-rating'));
          if (!Number.isNaN(r)) rating = r;
        }
        if (rating === null) {
          const numEl = info.querySelector('.num');
          if (numEl) {
            const mm = (numEl.textContent || '').match(/([\d.]+)/);
            if (mm) rating = parseFloat(mm[1]);
          }
        }

        return { id, name, brewery, style, abv, ibu, rating, label, url, had };
      }

      const result = [];
      const sectionEls = document.querySelectorAll('.menu-section');
      if (sectionEls.length === 0) {
        // Fallback: no section wrappers — put everything in one unnamed section.
        const beers = [];
        const seen = new Set();
        document.querySelectorAll('li.menu-item, .beer-container, .beer-info').forEach((row) => {
          const b = extractBeer(row);
          if (b && !seen.has(b.id)) { seen.add(b.id); beers.push(b); }
        });
        if (beers.length) result.push({ name: '', beers });
        return result;
      }

      sectionEls.forEach((sec) => {
        // Skip wrapper sections that contain nested sections — we'll emit the
        // inner (leaf) sections separately, so including their beers here would
        // double-count them and produce a giant "parent" section.
        if (sec.querySelector('.menu-section')) return;

        const headerEl = sec.querySelector('.menu-section-header h4, .menu-section-header h3, h4, h3');
        let sectionName = headerEl ? (headerEl.textContent || '').trim() : '';
        // Untappd headers often include an item-count suffix like "(12 Items)" — keep it, it's useful.
        sectionName = sectionName.replace(/\s+/g, ' ').trim();

        const beers = [];
        const seen = new Set();
        sec.querySelectorAll('li.menu-item, .beer-container').forEach((row) => {
          const b = extractBeer(row);
          if (b && !seen.has(b.id)) { seen.add(b.id); beers.push(b); }
        });
        if (beers.length) result.push({ name: sectionName, beers });
      });
      return result;
    });

    const totalBeers = sections.reduce((n, s) => n + s.beers.length, 0);
    const hadBeers = sections.reduce(
      (n, s) => n + s.beers.filter((b) => b.had).length,
      0,
    );
    console.log(
      `[scraper] venue menu: ${sections.length} sections, ${totalBeers} beers, ${hadBeers} had`,
    );
    return { venue: { url: venueUrl, ...info }, sections };
  } finally {
    await page.close().catch(() => {});
  }
}
