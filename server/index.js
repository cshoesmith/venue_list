import express from 'express';
import cors from 'cors';
import {
  openLoginWindow,
  searchVenues,
  getVenueMenu,
  isLoggedIn,
  shutdown,
  getLastDebug,
  refreshHadBeers,
} from './scraper.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
