import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Saved ("favourite") venue menus, cached server-side so every device sees the
// same list. Lives in the user-data volume so it survives container rebuilds.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = process.env.USER_DATA_DIR || path.join(__dirname, '.user-data');
const SAVED_FILE = path.join(USER_DATA_DIR, 'saved-menus.json');

export const MAX_SAVED = 20;

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function store(list) {
  if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a truncated file.
  const tmp = `${SAVED_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list));
  fs.renameSync(tmp, SAVED_FILE);
}

export function listSaved() {
  return load();
}

// Entry shape: { venue: {url, name, address}, menu, checkedAt }
export function saveMenu(venue, menu, checkedAt) {
  const list = load();
  const entry = { venue, menu, checkedAt: checkedAt || new Date().toISOString() };
  const i = list.findIndex((e) => e.venue.url === venue.url);
  if (i >= 0) {
    list[i] = entry;
  } else {
    if (list.length >= MAX_SAVED) {
      throw new Error(`You can save up to ${MAX_SAVED} menus. Remove one first.`);
    }
    list.push(entry);
  }
  store(list);
  return entry;
}

export function removeSaved(url) {
  store(load().filter((e) => e.venue.url !== url));
}

// Called after every fresh scrape: if this venue is saved, refresh its cache.
export function updateIfSaved(url, menu, checkedAt) {
  const list = load();
  const entry = list.find((e) => e.venue.url === url);
  if (!entry) return;
  entry.menu = menu;
  entry.checkedAt = checkedAt;
  store(list);
}
