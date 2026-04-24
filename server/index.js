import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  openLoginWindow,
  searchVenues,
  getVenueMenu,
  isLoggedIn,
  shutdown,
  getLastDebug,
  refreshHadBeers,
} from './scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'public');
const APP_SECRET = process.env.APP_SECRET || '';

const app = express();
app.set('trust proxy', 1); // we're behind Cloudflare Tunnel
app.use(cors());
app.use(express.json());

// Health endpoint (unauthenticated) — used by tunnel / uptime checks.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Secret gate for every other /api/* route. If APP_SECRET is blank, skip.
app.use('/api', (req, res, next) => {
  if (!APP_SECRET) return next();
  if (req.path === '/health') return next();
  const provided = req.get('x-app-secret') || req.query.k || '';
  if (provided === APP_SECRET) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.get('/api/status', async (_req, res) => {
  try {
    const loggedIn = await isLoggedIn();
    res.json({ loggedIn });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/api/login', async (_req, res) => {
  try {
    const result = await openLoginWindow();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/api/venues', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing q' });
  try {
    const venues = await searchVenues(q);
    res.json({ venues });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/api/venue', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const data = await getVenueMenu(url);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/api/debug/last', (_req, res) => {
  res.type('html').send(getLastDebug() || '<em>no debug html captured yet</em>');
});

app.post('/api/refresh-had', async (_req, res) => {
  try {
    const result = await refreshHadBeers();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Serve the built React client (if present) and fall back to index.html
// for client-side routes. Placed AFTER /api/* handlers.
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR, { index: 'index.html' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
  console.log(`[server] serving static client from ${STATIC_DIR}`);
} else {
  console.log(`[server] no static dir at ${STATIC_DIR} (dev mode — use Vite on :5173)`);
}

const PORT = Number(process.env.PORT) || 5175;
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

const gracefulExit = async () => {
  console.log('[server] shutting down...');
  await shutdown();
  process.exit(0);
};
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);
