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

// Cache of beer IDs the user has checked in to. Populated lazily, and mirrored
// to disk so a restart doesn't force a full (slow) re-scan.
let hadBeerIds = null;
let hadUsername = null;
const HAD_FILE = path.join(USER_DATA_DIR, 'had-beers.json');

// Venues without a menu get one built from check-ins this recent.
const CHECKIN_WINDOW_DAYS = 7;

// Every change seen in the session cookies' expiry, to learn how long a login lasts.
const SESSION_LOG = path.join(USER_DATA_DIR, 'session-log.json');
const SESSION_LOG_MAX = 50;

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
  // Stale singleton locks from a prior (now-dead) Chrome process will make a
  // fresh launch fail immediately with "profile appears to be in use".
  // Safe to remove — we only get here when no Chrome is actually running.
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(USER_DATA_DIR, name)); } catch { /* ignore */ }
  }
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
  const loggedIn = untappdCookies.some((c) => /^untappd_(user|session)_/i.test(c.name));
  if (loggedIn) recordSession(sessionExpiry(untappdCookies));
  return loggedIn;
}

// ISO expiry of the login, session and Cloudflare cookies ('session' = no expiry set).
function sessionExpiry(cookies) {
  const expiry = (re) => {
    const c = cookies.find((k) => re.test(k.name));
    if (!c) return null;
    return c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session';
  };
  return {
    login: expiry(/^untappd_user_/i),
    session: expiry(/^untappd_session_/i),
    cloudflare: expiry(/^cf_clearance$/),
  };
}

function readSessionLog() {
  try {
    const log = JSON.parse(fs.readFileSync(SESSION_LOG, 'utf8'));
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}

// Log the expiries when any of them has moved by more than an hour since the
// last entry, so a sliding session shows up without logging every request.
function recordSession(exp) {
  const log = readSessionLog();
  const last = log[log.length - 1];
  const moved = (a, b) => {
    if (a === b) return false;
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    return Number.isNaN(ta) || Number.isNaN(tb) || Math.abs(ta - tb) > 60 * 60 * 1000;
  };
  if (last && !['login', 'session', 'cloudflare'].some((k) => moved(last[k], exp[k]))) return;
  log.push({ seenAt: new Date().toISOString(), ...exp });
  try {
    fs.writeFileSync(SESSION_LOG, JSON.stringify(log.slice(-SESSION_LOG_MAX)));
  } catch (err) {
    console.log('[scraper] could not write session log:', err.message);
  }
}

/** Current cookie expiries plus the logged history of changes, newest first. */
export async function getSessionInfo() {
  const ctx = await getContext();
  const cookies = await ctx.cookies('https://untappd.com').catch(() => []);
  const current = sessionExpiry(cookies);
  if (current.login || current.session) recordSession(current);
  return { ...current, history: readSessionLog().reverse() };
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

// Had-beer IDs if we already know them (memory, then disk) — never scrapes.
function knownHadBeerIds() {
  if (hadBeerIds) return hadBeerIds;
  try {
    const { ids } = JSON.parse(fs.readFileSync(HAD_FILE, 'utf8'));
    if (Array.isArray(ids)) hadBeerIds = new Set(ids);
  } catch { /* not cached yet */ }
  return hadBeerIds;
}

const HAD_PAGE_SIZE = 25;
const HAD_GAP_MS = 300; // pause between history pages
const HAD_MAX_RETRIES = 8; // per page, when Untappd says 429
const HAD_MAX_WAIT_MS = 60 * 1000;
// Bumped when the cache's contents change meaning; older caches get a full re-read
// (v1 counted every beer link on the page, sidebars included).
const HAD_FILE_VERSION = 2;

function hadFileVersion() {
  try {
    return JSON.parse(fs.readFileSync(HAD_FILE, 'utf8')).v ?? 1;
  } catch {
    return null;
  }
}

/**
 * Read the user's beer history into a Set of beer IDs. Calls the endpoint
 * behind the beers page's "Show More" (25 beers per offset, most recent
 * first) directly, one at a time: Untappd answers 429 to bursts, and then
 * the scan waits and retries.
 *
 * Starting from `known` IDs, it stops once it holds `target` beers (the
 * profile's Unique count) or, without a target, at the first page that adds
 * nothing new, so an update reads only as far back as the last one.
 *
 * onProgress({ size, waitUntil }): waitUntil is set while backing off.
 */
async function loadHadBeerIds(ctx, username, { known, target }, onProgress) {
  const page = await ctx.newPage();
  try {
    // Loading the page first gets past Cloudflare and gives fetch() Untappd's cookies.
    await goSafely(page, `https://untappd.com/user/${encodeURIComponent(username)}/beers`);
    const ids = new Set(known || []);
    // The first 25 come with the page; the endpoint serves offsets from 25 on.
    const first = await page.$$eval('.beer-item[data-bid]', (els) => els.map((el) => el.getAttribute('data-bid')));
    let before = ids.size;
    first.forEach((id) => ids.add(id));
    let done = first.length < HAD_PAGE_SIZE
      || (target ? ids.size >= target : !!known && ids.size === before);
    onProgress({ size: ids.size });

    let failures = 0;
    for (let offset = HAD_PAGE_SIZE; !done && offset < 100000;) {
      const url = `/profile/more_beer/${encodeURIComponent(username)}/${offset}?sort=date`;
      const res = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
          return { status: r.status, retryAfter: r.headers.get('retry-after'), html: r.ok ? await r.text() : '' };
        } catch (err) {
          return { status: 0, error: err.message };
        }
      }, url);

      if (res.status !== 200) {
        // 429 (too many requests), 5xx or a network error: back off and retry.
        if (++failures > HAD_MAX_RETRIES) throw new Error(`${url}: HTTP ${res.status || res.error}`);
        const waitMs = Number(res.retryAfter) > 0
          ? Math.min(Number(res.retryAfter) * 1000, HAD_MAX_WAIT_MS)
          : Math.min(5000 * 2 ** (failures - 1), HAD_MAX_WAIT_MS);
        console.log(`[scraper] had-beer scan: HTTP ${res.status || res.error} at offset ${offset}, waiting ${waitMs / 1000}s`);
        onProgress({ size: ids.size, waitUntil: new Date(Date.now() + waitMs).toISOString() });
        await page.waitForTimeout(waitMs);
        continue;
      }
      failures = 0;

      // e.g. <div class="beer-item" data-bid="97996">
      const pageIds = [...res.html.matchAll(/class="beer-item"[^>]*data-bid="(\d+)"/g)].map((m) => m[1]);
      before = ids.size;
      pageIds.forEach((id) => ids.add(id));
      if (pageIds.length < HAD_PAGE_SIZE) done = true; // a short page is the last one
      if (target ? ids.size >= target : !!known && ids.size === before) done = true; // caught up
      onProgress({ size: ids.size });
      offset += HAD_PAGE_SIZE;
      if (!done) await page.waitForTimeout(HAD_GAP_MS);
    }
    return ids;
  } finally {
    await page.close().catch(() => {});
  }
}

// The current or last beer-history scan, polled by the client for its progress bar.
let hadProgress = { running: false };
let hadJob = null; // promise of the running scan (never rejects)
let hadScanListener = null;

// Beers the user tapped check in on: beer ID -> scans left to look for it.
const pendingCheckins = new Map();
let checkinTimer = null;
const CHECKIN_SCAN_EVERY_MS = 60 * 1000;
const CHECKIN_MAX_SCANS = 3; // so the watch ends 3 minutes after the last tap

// `watching` lists beers awaiting a check-in, so menus can badge them "Updating".
export function getHadProgress() {
  return { ...hadProgress, watching: [...pendingCheckins.keys()] };
}

/** Called with the full Set of had-beer IDs after every successful scan. */
export function onHadScan(fn) {
  hadScanListener = fn;
}

/**
 * The user tapped check in on a beer: run an update scan once a minute until
 * the beer shows up in their history, at most 3 times. Only ever started by a
 * tap; nothing scans on a timer of its own. Already-had beers are ignored,
 * since checking in again adds nothing new.
 */
export function watchForCheckin(beerId) {
  if (!beerId || knownHadBeerIds()?.has(beerId)) return getHadProgress();
  pendingCheckins.set(beerId, CHECKIN_MAX_SCANS);
  if (!checkinTimer) scheduleCheckinScan();
  return getHadProgress();
}

function scheduleCheckinScan() {
  hadProgress.scheduledFor = new Date(Date.now() + CHECKIN_SCAN_EVERY_MS).toISOString();
  checkinTimer = setTimeout(async () => {
    if (!hadProgress.running) startHadRefresh();
    await hadJob; // ours, or one that was already running
    checkinTimer = null;
    const had = knownHadBeerIds();
    for (const [id, left] of pendingCheckins) {
      if (had?.has(id) || left <= 1) pendingCheckins.delete(id);
      else pendingCheckins.set(id, left - 1);
    }
    if (pendingCheckins.size) scheduleCheckinScan();
    else hadProgress.scheduledFor = undefined;
  }, CHECKIN_SCAN_EVERY_MS);
}

/**
 * Start a beer-history scan in the background; a no-op while one is running.
 * By default it only reads back to the last update; `full` re-reads everything.
 * Progress counts new beers (update) or all beers (full) towards `total`.
 */
export function startHadRefresh({ full = false } = {}) {
  if (hadProgress.running) return getHadProgress();
  const prevIds = knownHadBeerIds();
  const known = full || hadFileVersion() !== HAD_FILE_VERSION ? null : prevIds;
  const base = known?.size || 0;
  hadProgress = {
    running: true,
    mode: known ? 'update' : 'full',
    loaded: 0,
    total: null,
    previous: prevIds?.size ?? null,
    startedAt: new Date().toISOString(),
    // Still watching for a check-in.
    scheduledFor: checkinTimer ? hadProgress.scheduledFor : undefined,
  };
  hadJob = (async () => {
    try {
      const ctx = await getContext();
      const username = await getUsername(ctx);
      hadProgress.username = username;
      // The profile's Unique count says when to stop and sizes the progress bar.
      let target = null;
      try {
        const unique = (await getProfile(true)).stats.find((s) => /unique/i.test(s.label));
        const n = unique ? parseInt(unique.value.replace(/\D/g, ''), 10) : NaN;
        if (n > 0) target = n;
      } catch { /* stop on a page with nothing new; the bar stays indeterminate */ }
      if (target) hadProgress.total = Math.max(0, target - base);
      const ids = await loadHadBeerIds(ctx, username, { known, target }, ({ size, waitUntil }) => {
        hadProgress.loaded = size - base;
        hadProgress.waitUntil = waitUntil || null;
      });
      if (!ids.size) throw new Error('No beers found. Untappd’s page may have changed.');
      hadBeerIds = ids;
      console.log(`[scraper] loaded ${ids.size} had-beer IDs for ${username}`);
      try {
        fs.writeFileSync(HAD_FILE, JSON.stringify({
          v: HAD_FILE_VERSION, username, ids: [...ids], savedAt: new Date().toISOString(),
        }));
      } catch (err) {
        console.log('[scraper] could not cache had-beer IDs:', err.message);
      }
      try { hadScanListener?.(ids); } catch (err) { console.log('[scraper] had-scan listener failed:', err.message); }
      hadProgress = {
        ...hadProgress,
        running: false,
        count: ids.size,
        // New since the last scan, so open menus can mark them Had.
        added: prevIds ? [...ids].filter((id) => !prevIds.has(id)) : [],
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.log('[scraper] had-beer scan failed:', err.message);
      hadProgress = { ...hadProgress, running: false, error: String(err?.message || err) };
    }
  })();
  return getHadProgress();
}

const beerCache = new Map(); // url -> { data, fetchedAt }
const BEER_TTL_MS = 30 * 60 * 1000;

/** The useful bits of an Untappd beer page, without the feed and ads. */
export async function getBeer(beerUrl) {
  if (!/^https?:\/\/(www\.)?untappd\.com\/b\//i.test(beerUrl)) {
    throw new Error('Not an Untappd beer URL');
  }
  const hit = beerCache.get(beerUrl);
  if (hit && Date.now() - hit.fetchedAt < BEER_TTL_MS) return hit.data;

  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await goSafely(page, beerUrl);
    const data = await page.evaluate(() => {
      const text = (sel) => (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
      // The "read-less" block holds the full description; "read-more" is the truncated one.
      const descEl = document.querySelector('.beer-descrption-read-less')
        || document.querySelector('.beer-descrption-read-more');
      const description = descEl
        ? descEl.textContent.replace(/Show (More|Less)\s*$/i, '').replace(/\s+/g, ' ').trim()
        : '';
      const caps = document.querySelector('.details .caps[data-rating]');
      const rating = caps ? parseFloat(caps.getAttribute('data-rating')) : NaN;
      const raters = text('.details .raters').match(/[\d,]+/);
      const ibu = text('.details .ibu');
      // e.g. <p><span class="stat">Total (?)</span><span class="count">117</span></p>
      const stats = Array.from(document.querySelectorAll('.stats p')).map((p) => ({
        label: (p.querySelector('.stat')?.textContent || '').replace(/\(\?\)/, '').trim(),
        value: (p.querySelector('.count')?.textContent || '').trim(),
      })).filter((s) => s.label && s.value);
      return {
        name: text('.content .name h1'),
        brewery: text('.content .name .brewery'),
        style: text('.content .name .style'),
        abv: text('.details .abv'),
        ibu: /N\/A/i.test(ibu) ? '' : ibu,
        rating: Number.isNaN(rating) || rating === 0 ? null : rating,
        raters: raters ? raters[0] : '',
        description,
        label: document.querySelector('.content .label img, a.label img')?.getAttribute('src') || '',
        stats,
      };
    });
    const id = (beerUrl.match(/\/b\/[^/?#]+\/(\d+)/) || [])[1] || '';
    const beer = { url: beerUrl, id, ...data };
    beerCache.set(beerUrl, { data: beer, fetchedAt: Date.now() });
    return beer;
  } finally {
    await page.close().catch(() => {});
  }
}

let profileCache = null;
const PROFILE_TTL_MS = 10 * 60 * 1000;

/** Avatar, display name and headline stats from the user's Untappd profile. */
export async function getProfile(force = false) {
  if (!force && profileCache && Date.now() - profileCache.fetchedAt < PROFILE_TTL_MS) {
    return profileCache;
  }
  const ctx = await getContext();
  const username = await getUsername(ctx);
  const page = await ctx.newPage();
  try {
    await goSafely(page, `https://untappd.com/user/${encodeURIComponent(username)}`);
    const profile = await page.evaluate(() => {
      const text = (sel) => (document.querySelector(sel)?.textContent || '').trim();
      // e.g. <a><span class="stat">4,021</span><span class="title">Unique</span></a>
      const stats = Array.from(document.querySelectorAll('.user-info .stats a')).map((a) => ({
        label: (a.querySelector('.title')?.textContent || '').trim(),
        value: (a.querySelector('.stat')?.textContent || '').trim(),
      }));
      return {
        name: text('.user-info .info h1'),
        location: text('.user-info .location'),
        avatar: document.querySelector('.user-info .avatar-holder img')?.getAttribute('src') || '',
        stats,
      };
    });
    profileCache = { username, ...profile, fetchedAt: Date.now() };
    return profileCache;
  } finally {
    await page.close().catch(() => {});
  }
}

/** Sign the shared Chrome out of Untappd and forget everything tied to the user. */
export async function logout() {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto('https://untappd.com/logout', { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(() => {});
  } finally {
    await page.close().catch(() => {});
  }
  // Belt and braces: drop the session cookies isLoggedIn() looks for, but keep
  // Cloudflare's clearance cookie so the next login isn't challenged.
  await ctx.clearCookies({ name: /^untappd_(user|session)_/i }).catch(() => {});
  hadUsername = null;
  hadBeerIds = null;
  profileCache = null;
  try { fs.unlinkSync(HAD_FILE); } catch { /* not cached */ }
  console.log('[scraper] logged out of Untappd');
}

// Cached after the first lookup, so only the first call visits Untappd.
export async function currentUsername() {
  try {
    return await getUsername(await getContext());
  } catch {
    return null;
  }
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

/**
 * Build a pseudo-menu from a venue's recent check-ins (for unverified venues
 * that have no menu). Untappd serves the activity feed 25 at a time via
 * "Show More" and stops after ~275, so we stop paging once we're past the window.
 */
async function getCheckinMenu(page, venueUrl) {
  const activityUrl = `${venueUrl.replace(/[?#].*$/, '').replace(/\/+$/, '')}/activity`;
  await goSafely(page, activityUrl);
  const cutoff = Date.now() - CHECKIN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const items = page.locator('[id^="checkin_"]');
  for (let i = 0; i < 12; i++) {
    const n = await items.count();
    if (!n) break;
    const oldest = await items
      .nth(n - 1)
      .locator('a.time[data-gregtime]')
      .getAttribute('data-gregtime', { timeout: 2000 })
      .catch(() => null);
    if (oldest && Date.parse(oldest) < cutoff) break;
    const btn = page.locator('a.more_checkins:visible').first();
    if (!(await btn.count())) break;
    try { await btn.click({ timeout: 3000 }); } catch { break; }
    const grew = await page
      .waitForFunction(
        (prev) => document.querySelectorAll('[id^="checkin_"]').length > prev,
        n,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!grew) break;
  }

  lastDebugHtml = await page.content();

  // Feed items read "<user> is drinking a <beer> by <brewery> at <venue>".
  const checkins = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[id^="checkin_"]')).map((el) => {
      const links = Array.from(el.querySelectorAll('.checkin p.text a:not(.user)'));
      const beerA = links.find((a) => /^\/b\//.test(a.getAttribute('href') || ''));
      if (!beerA) return null;
      const href = beerA.getAttribute('href');
      const m = href.match(/\/b\/[^/?#]+\/(\d+)/);
      if (!m) return null;
      const breweryA = links[links.indexOf(beerA) + 1];
      const brewery = breweryA && !/^\/v\//.test(breweryA.getAttribute('href') || '')
        ? breweryA.textContent.trim()
        : '';
      const img = el.querySelector('a.label img');
      const caps = el.querySelector('.caps[data-rating]');
      const r = caps ? parseFloat(caps.getAttribute('data-rating')) : NaN;
      const t = el.querySelector('a.time[data-gregtime]');
      return {
        id: m[1],
        name: beerA.textContent.trim(),
        url: `https://untappd.com${href}`,
        brewery,
        label: img ? img.getAttribute('src') || '' : '',
        rating: Number.isNaN(r) || r === 0 ? null : r,
        time: t ? t.getAttribute('data-gregtime') : null,
      };
    }).filter(Boolean),
  );

  // One tile per beer: most recent sighting, check-in count, average rating.
  const had = knownHadBeerIds();
  const byId = new Map();
  for (const c of checkins) {
    const t = Date.parse(c.time);
    if (Number.isNaN(t) || t < cutoff) continue;
    let b = byId.get(c.id);
    if (!b) {
      b = {
        id: c.id, name: c.name, brewery: c.brewery, style: '', abv: '', ibu: '',
        label: c.label, url: c.url, had: !!had?.has(c.id),
        lastSeen: new Date(t).toISOString(), checkins: 0, ratingSum: 0, ratingCount: 0,
      };
      byId.set(c.id, b);
    }
    b.checkins++;
    if (t > Date.parse(b.lastSeen)) b.lastSeen = new Date(t).toISOString();
    if (c.rating) { b.ratingSum += c.rating; b.ratingCount++; }
  }
  const beers = [...byId.values()]
    .map(({ ratingSum, ratingCount, ...b }) => ({
      ...b,
      rating: ratingCount ? Math.round((ratingSum / ratingCount) * 100) / 100 : null,
    }))
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));

  console.log(
    `[scraper] check-in menu: ${checkins.length} check-ins scanned, ${beers.length} beers in last ${CHECKIN_WINDOW_DAYS} days`,
  );
  return {
    sections: beers.length
      ? [{ name: `Recent check-ins (last ${CHECKIN_WINDOW_DAYS} days)`, beers }]
      : [],
    hadKnown: !!had,
  };
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
      const logoEl = document.querySelector('.venue-header .logo img');
      return {
        name: nameEl ? nameEl.textContent.trim() : '',
        address: addrEl ? addrEl.textContent.trim() : '',
        logo: logoEl ? logoEl.getAttribute('src') || '' : '',
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

        // Brewery links are e.g. href="/Future_Brewing" data-href=":brewery".
        const breweryEl = info.querySelector('a[data-href=":brewery"], h6 a[href*="/w/"], a[href*="/w/"]');
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
    if (!totalBeers) {
      // Unverified venues have no menu — fall back to recent check-ins.
      const fallback = await getCheckinMenu(page, venueUrl);
      return {
        venue: { url: venueUrl, ...info },
        sections: fallback.sections,
        source: 'checkins',
        windowDays: CHECKIN_WINDOW_DAYS,
        hadKnown: fallback.hadKnown,
      };
    }
    return { venue: { url: venueUrl, ...info }, sections, source: 'menu' };
  } finally {
    await page.close().catch(() => {});
  }
}
