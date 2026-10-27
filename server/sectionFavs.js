import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Favourite menu sections per venue: { [venueUrl]: [sectionKey, ...] }.
// Shared by every device, so it lives in the user-data volume.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = process.env.USER_DATA_DIR || path.join(__dirname, '.user-data');
const FAVS_FILE = path.join(USER_DATA_DIR, 'section-favs.json');

const MAX_PER_VENUE = 50;

function load() {
  try {
    const favs = JSON.parse(fs.readFileSync(FAVS_FILE, 'utf8'));
    return favs && typeof favs === 'object' && !Array.isArray(favs) ? favs : {};
  } catch {
    return {};
  }
}

function store(favs) {
  if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  // Write-then-rename so a crash mid-write can't leave a truncated file.
  const tmp = `${FAVS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(favs));
  fs.renameSync(tmp, FAVS_FILE);
}

export function listSectionFavs() {
  return load();
}

// Replace a venue's favourite sections; an empty list removes the venue.
export function setSectionFavs(url, sections) {
  const keys = [...new Set(
    sections.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 200)),
  )].slice(0, MAX_PER_VENUE);
  const favs = load();
  if (keys.length) favs[url] = keys;
  else delete favs[url];
  store(favs);
  return keys;
}
