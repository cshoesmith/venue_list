import { useEffect, useId, useMemo, useRef, useState } from 'react';

// Capture an API secret from `#k=...` on first load, persist in localStorage.
const SECRET_KEY = 'venue_list.secret';
(function captureSecret() {
  try {
    const hash = window.location.hash || '';
    const m = hash.match(/[#&]k=([^&]+)/);
    if (m) {
      localStorage.setItem(SECRET_KEY, decodeURIComponent(m[1]));
      // Strip the secret from the URL so it doesn't leak into history/screenshots.
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  } catch { /* ignore */ }
})();

async function api(path, options = {}) {
  const secret = (() => { try { return localStorage.getItem(SECRET_KEY) || ''; } catch { return ''; } })();
  const headers = new Headers(options.headers || {});
  if (secret) headers.set('X-App-Secret', secret);
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const STORAGE_KEY = 'venue_list.state.v1';

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function savePersisted(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { /* ignore quota errors */ }
}

function timeAgo(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.floor((now - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

// Section names carry a live item count ("On Tap (12 Items)"); favourites
// must survive it changing.
function sectionKey(name) {
  return (name || '').replace(/\s*\(\d+\s+items?\)\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function shortDate(iso, withTime = false) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso === 'session' ? 'session' : '—';
  return new Date(t).toLocaleString(undefined, withTime
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

// "21 Nov 2026 (in 24 days)" for a cookie expiry.
function expiryText(iso, now) {
  if (!iso) return 'not set';
  if (iso === 'session') return 'when Chrome closes';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  if (t <= now) return `${shortDate(iso)} (expired)`;
  const days = Math.floor((t - now) / 86400000);
  const rel = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return `${shortDate(iso)} (${rel})`;
}

// Crown-cap outline (21 crimps), shared with public/favicon.svg.
const CAP_POINTS =
  '12.00,0.50 13.52,1.91 15.39,1.01 16.43,2.81 18.48,2.50 18.94,4.52 20.99,4.83 20.83,6.90 '
  + '22.71,7.80 21.94,9.73 23.47,11.14 22.17,12.76 23.21,14.56 21.49,15.73 21.96,17.75 19.97,18.36 '
  + '19.82,20.43 17.75,20.43 16.99,22.36 15.01,21.75 13.71,23.37 12.00,22.20 10.29,23.37 8.99,21.75 '
  + '7.01,22.36 6.25,20.43 4.18,20.43 4.03,18.36 2.04,17.75 2.51,15.73 0.79,14.56 1.83,12.76 '
  + '0.53,11.14 2.06,9.73 1.29,7.80 3.17,6.90 3.01,4.83 5.06,4.52 5.52,2.50 7.57,2.81 8.61,1.01 10.48,1.91';

function Logo() {
  return (
    <h1 className="logo" aria-label="Verified">
      <svg className="logo-badge" viewBox="0 0 24 24" aria-hidden="true">
        <polygon points={CAP_POINTS} fill="var(--accent)" />
        <circle cx="12" cy="12" r="7.6" fill="none" stroke="var(--header-bg)" strokeOpacity="0.35" strokeWidth="0.8" />
        <path d="M7.6 12.3l2.9 2.9 5.9-6" fill="none" stroke="var(--header-bg)" strokeWidth="2.4"
          strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="logo-word">Verified</span>
    </h1>
  );
}

// Looping "busy" indicator: a mug that fills with beer, foams, then empties.
function BeerMug() {
  const clipId = useId();
  return (
    <svg className="beer-mug" viewBox="0 0 24 24" aria-hidden="true">
      <clipPath id={clipId}>
        <rect x="4" y="5" width="12" height="15" rx="1.5" />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <g className="beer-mug-fill">
          <rect x="4" y="5" width="12" height="3" fill="#fff8e1" />
          <rect x="4" y="8" width="12" height="12" fill="var(--accent)" />
        </g>
      </g>
      <rect x="4" y="5" width="12" height="15" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16 9h2.5a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H16" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

// Open modals, oldest first. Modals can stack (beer over menu), so only the
// top one reacts to Escape, and the page stays locked until the last closes.
const openModals = [];

function Modal({ title, subtitle, logo, onBack, actions, toolbar, size, onClose, children }) {
  // Keep the latest onClose without re-binding the key listener every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const token = {};
    openModals.push(token);
    const onKey = (e) => {
      if (e.key === 'Escape' && openModals[openModals.length - 1] === token) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      openModals.splice(openModals.indexOf(token), 1);
      if (!openModals.length) document.body.style.overflow = '';
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={() => closeRef.current()}>
      <div
        className={`modal ${size || ''}`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-head-row">
            {onBack && (
              <button className="secondary" onClick={onBack} aria-label="Back to results">←</button>
            )}
            {logo && <img className="venue-logo" src={logo} alt="" />}
            <div className="modal-title">
              {title}
              {subtitle && <div className="modal-sub">{subtitle}</div>}
            </div>
            {actions}
            <button className="secondary" onClick={() => closeRef.current()} aria-label="Close">✕</button>
          </div>
          {toolbar && <div className="tabs modal-toolbar">{toolbar}</div>}
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export default function App() {
  const persisted = loadPersisted() || {};
  const [loggedIn, setLoggedIn] = useState(null);
  const [username, setUsername] = useState(null);
  const [showProfile, setShowProfile] = useState(false);
  const [profile, setProfile] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [beer, setBeer] = useState(null); // tile data for the open beer modal
  const [beerInfo, setBeerInfo] = useState(null); // full details from /api/beer
  const [beerError, setBeerError] = useState('');
  const [query, setQuery] = useState(persisted.query || '');
  const [venues, setVenues] = useState([]);
  const [showVenues, setShowVenues] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null); // non-null = menu modal open
  const [menuFrom, setMenuFrom] = useState(null); // 'search' | 'saved'
  const [menu, setMenu] = useState(null);
  const [loadingMenu, setLoadingMenu] = useState(false);
  const [filter, setFilter] = useState(persisted.filter || 'new');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState([]);
  const [savedMax, setSavedMax] = useState(20);
  const [refreshing, setRefreshing] = useState({}); // url -> true while a saved tile reloads
  const [sectionFavs, setSectionFavs] = useState({}); // venue url -> [section key]
  const [sectionOpen, setSectionOpen] = useState({}); // section key -> expanded, set by the user
  const [now, setNow] = useState(Date.now());
  // URL of the menu currently shown, so a slow fetch can't land in a closed modal.
  const activeUrl = useRef(null);
  const searchInput = useRef(null);
  const activeBeerUrl = useRef(null);

  // Re-render once a minute so "Last checked" stays current.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Only remember preferences; every visit starts on the home page.
  useEffect(() => {
    savePersisted({ query, filter });
  }, [query, filter]);

  const refreshStatus = async () => {
    try {
      const { loggedIn, username } = await api('/api/status');
      setLoggedIn(loggedIn);
      setUsername(username || null);
    } catch (e) {
      setLoggedIn(false);
      setError(e.message);
    }
  };

  const loadSaved = async () => {
    try {
      const r = await api('/api/saved');
      setSaved(r.saved);
      setSavedMax(r.max);
    } catch (e) {
      setError(e.message);
    }
  };

  const loadSectionFavs = async () => {
    try {
      setSectionFavs((await api('/api/section-favs')).favs);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => { refreshStatus(); loadSaved(); loadSectionFavs(); }, []);

  // Re-check login and re-sync saved venues and favourite sections (they may
  // have changed on another device) whenever the tab comes back into view.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      refreshStatus();
      loadSaved();
      loadSectionFavs();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const savedEntry = (url) => saved.find((e) => e.venue.url === url);
  const isSaved = !!(selected && savedEntry(selected.url));

  // Each venue opens with its sections in their default state.
  useEffect(() => { setSectionOpen({}); }, [selected?.url]);

  const toggleSectionFav = async (key) => {
    const url = selected?.url;
    if (!url) return;
    const prev = sectionFavs[url] || [];
    const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
    setSectionFavs((f) => ({ ...f, [url]: next }));
    try {
      await api('/api/section-favs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, sections: next }),
      });
    } catch (e) {
      setSectionFavs((f) => ({ ...f, [url]: prev }));
      setError(e.message);
    }
  };

  // The server refreshes its cached copy on every scrape; mirror that locally.
  const syncSaved = (url, data) => {
    setSaved((list) => list.map((e) => (
      e.venue.url === url ? { ...e, menu: data, checkedAt: data.checkedAt } : e
    )));
  };

  const openSaved = (entry, from = 'saved') => {
    setError('');
    activeUrl.current = entry.venue.url;
    setShowVenues(false);
    setMenuFrom(from);
    setSelected(entry.venue);
    setMenu({ ...entry.menu, checkedAt: entry.checkedAt });
  };

  const closeMenu = () => {
    activeUrl.current = null;
    setSelected(null);
    setMenu(null);
    setLoadingMenu(false);
    setError('');
  };

  const backToResults = () => {
    closeMenu();
    setShowVenues(true);
  };

  const toggleSave = async () => {
    if (!selected || !menu) return;
    setError('');
    try {
      if (isSaved) {
        await api(`/api/saved?url=${encodeURIComponent(selected.url)}`, { method: 'DELETE' });
      } else {
        await api('/api/saved', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ venue: selected, menu }),
        });
      }
      await loadSaved();
    } catch (e) {
      setError(e.message);
    }
  };

  const refreshSaved = async (url) => {
    setError('');
    setRefreshing((r) => ({ ...r, [url]: true }));
    try {
      const data = await api(`/api/venue?url=${encodeURIComponent(url)}`);
      syncSaved(url, data);
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(({ [url]: _, ...rest }) => rest);
    }
  };

  const removeSaved = async (url) => {
    setError('');
    try {
      await api(`/api/saved?url=${encodeURIComponent(url)}`, { method: 'DELETE' });
      await loadSaved();
    } catch (e) {
      setError(e.message);
    }
  };

  const doLogin = async () => {
    setError('');
    try {
      await api('/api/login', { method: 'POST' });
      const start = Date.now();
      while (Date.now() - start < 5 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const { loggedIn, username } = await api('/api/status');
          setLoggedIn(loggedIn);
          setUsername(username || null);
          if (loggedIn) break;
        } catch { /* keep polling */ }
      }
    } catch (e) {
      setError(e.message);
    }
  };

  const openBeer = async (b) => {
    activeBeerUrl.current = b.url;
    setBeer(b); setBeerInfo(null); setBeerError('');
    try {
      const info = await api(`/api/beer?url=${encodeURIComponent(b.url)}`);
      if (activeBeerUrl.current === b.url) setBeerInfo(info);
    } catch (e) {
      if (activeBeerUrl.current === b.url) setBeerError(e.message);
    }
  };

  const closeBeer = () => {
    activeBeerUrl.current = null;
    setBeer(null); setBeerInfo(null); setBeerError('');
  };

  const openProfile = async () => {
    setError('');
    setShowProfile(true);
    try {
      setProfile(await api('/api/me'));
    } catch (e) {
      setError(e.message);
    }
  };

  const closeProfile = () => {
    setShowProfile(false);
    setError('');
  };

  const doLogout = async () => {
    if (!window.confirm('Log out of Untappd? This signs out every device using this app.')) return;
    setLoggingOut(true); setError('');
    try {
      await api('/api/logout', { method: 'POST' });
      setProfile(null);
      setShowProfile(false);
      await refreshStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoggingOut(false);
    }
  };

  const doSearch = async (e) => {
    e?.preventDefault?.();
    if (!query.trim()) return;
    setError(''); setSearching(true); setVenues([]); setShowVenues(true);
    try {
      const { venues } = await api(`/api/venues?q=${encodeURIComponent(query)}`);
      setVenues(venues);
    } catch (e) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  };

  const fetchMenu = async (url) => {
    setLoadingMenu(true); setError('');
    try {
      const data = await api(`/api/venue?url=${encodeURIComponent(url)}`);
      syncSaved(url, data);
      if (activeUrl.current === url) setMenu(data);
    } catch (e) {
      if (activeUrl.current === url) setError(e.message);
    } finally {
      if (activeUrl.current === url) setLoadingMenu(false);
    }
  };

  const pickVenue = (v) => {
    const cached = savedEntry(v.url);
    if (cached) return openSaved(cached, 'search');
    activeUrl.current = v.url;
    setShowVenues(false);
    setMenuFrom('search');
    setSelected(v);
    setMenu(null);
    fetchMenu(v.url);
  };

  const allBeers = useMemo(
    () => (menu?.sections || []).flatMap((s) => s.beers),
    [menu],
  );

  const filteredSections = useMemo(() => {
    if (!menu) return [];
    return menu.sections
      .map((s) => {
        // Rank by rating across the full section (desc), ties broken by name.
        // Check-in menus rank by most recently seen instead.
        const ranked = [...s.beers]
          .sort((a, b) => {
            if (menu.source === 'checkins') {
              return Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
            }
            const ra = Number(a.rating) || 0;
            const rb = Number(b.rating) || 0;
            if (rb !== ra) return rb - ra;
            return (a.name || '').localeCompare(b.name || '');
          })
          .map((beer, i) => ({ ...beer, rank: i + 1 }));
        return {
          ...s,
          beers: ranked.filter((b) => {
            if (filter === 'had') return b.had;
            if (filter === 'new') return !b.had;
            return true;
          }),
        };
      })
      .filter((s) => s.beers.length > 0);
  }, [menu, filter]);

  const hadCount = allBeers.filter((b) => b.had).length;

  // Multi-section menus collapse: favourite sections start expanded, the rest
  // collapsed. With no favourite on this menu, everything starts expanded.
  const multiSection = (menu?.sections?.length || 0) > 1;
  const favKeys = (selected && sectionFavs[selected.url]) || [];
  const hasFavHere = !!menu?.sections?.some((s) => favKeys.includes(sectionKey(s.name)));
  const isExpanded = (key) => !multiSection
    || (sectionOpen[key] ?? (!hasFavHere || favKeys.includes(key)));
  const modalOpen = showVenues || !!selected || showProfile;

  return (
    <div className="app">
      <header className="top">
        <Logo />
        <div className="header-actions">
          {loggedIn ? (
            <button
              type="button"
              className="status ok status-btn"
              title={`Logged in to Untappd${username ? ` as ${username}` : ''} — view profile`}
              onClick={openProfile}
            >
              <span className="dot" />
              {username || 'logged in'}
            </button>
          ) : (
            <div className="status">
              <span className="dot" />
              {loggedIn === null ? 'checking…' : 'not logged in'}
            </div>
          )}
          {!loggedIn && (
            <button onClick={doLogin}>
              Open login window
            </button>
          )}
          {loggedIn && (
            <button
              className="secondary"
              title={`Re-scan ${username || 'your'} Untappd history for beers you've had`}
              onClick={async () => {
                setError('');
                try {
                  const r = await api('/api/refresh-had', { method: 'POST' });
                  if (r.username) setUsername(r.username);
                  alert(`Cached ${r.count} beers you've had (${r.username}).`);
                } catch (e) { setError(e.message); }
              }}
            >
              Update Uniques
            </button>
          )}
        </div>
      </header>

      {error && !modalOpen && <div className="error">{error}</div>}

      <form className="search" onSubmit={doSearch}>
        <input
          ref={searchInput}
          placeholder="Venue name (e.g. Monkish Brewing)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="secondary"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => { setQuery(''); searchInput.current?.focus(); }}
          >
            ✕
          </button>
        )}
        <button type="submit" disabled={searching || !loggedIn}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {!!saved.length && (
        <div className="section-title">Saved venues ({saved.length}/{savedMax})</div>
      )}
      <div className="results" hidden={!saved.length}>
        {saved.map((e) => {
          const beers = (e.menu?.sections || []).flatMap((s) => s.beers);
          const newCount = beers.filter((b) => !b.had).length;
          const logo = e.menu?.venue?.logo;
          return (
            <div key={e.venue.url} className="row" onClick={() => openSaved(e)}>
              {logo ? (
                <img className="venue-logo" src={logo} alt="" />
              ) : (
                <div className="venue-logo placeholder" />
              )}
              <div className="beer-left">
                <div className="name">{e.menu?.venue?.name || e.venue.name}</div>
                <div className="address">
                  Last checked: {timeAgo(e.checkedAt, now)} · {beers.length} beers, {newCount} new
                  {e.menu?.source === 'checkins' && ' · from check-ins'}
                </div>
              </div>
              <div className="slot-actions">
                <button
                  className="secondary"
                  type="button"
                  title="Fetch the latest menu from Untappd"
                  aria-label="Refresh menu"
                  disabled={!!refreshing[e.venue.url] || !loggedIn}
                  onClick={(ev) => { ev.stopPropagation(); refreshSaved(e.venue.url); }}
                >
                  {refreshing[e.venue.url] ? <BeerMug /> : <span>↻</span>}
                  <span className="btn-label">
                    {refreshing[e.venue.url] ? ' Refreshing…' : ' Refresh'}
                  </span>
                </button>
                <button
                  className="secondary"
                  type="button"
                  title="Remove from saved venues"
                  onClick={(ev) => { ev.stopPropagation(); removeSaved(e.venue.url); }}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {showProfile && (
        <Modal title="Untappd account" size="small" onClose={closeProfile}>
          {error && <div className="error">{error}</div>}
          {!profile && !error && (
            <div className="loading"><BeerMug /> Loading profile…</div>
          )}
          {profile && (
            <div className="profile">
              {profile.avatar && <img className="profile-avatar" src={profile.avatar} alt="" />}
              <div className="profile-name">{profile.name || profile.username}</div>
              <div className="profile-sub">
                {[`@${profile.username}`, profile.location].filter(Boolean).join(' · ')}
              </div>
              <div className="profile-stats">
                {profile.stats.map((s) => (
                  <div key={s.label} className="profile-stat">
                    <div className="profile-stat-value">{s.value}</div>
                    <div className="profile-stat-label">{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {profile?.session && (
            <div className="session-info">
              <div className="session-title">Server session</div>
              <dl>
                <dt>Login</dt><dd>{expiryText(profile.session.login, now)}</dd>
                <dt>Session</dt><dd>{expiryText(profile.session.session, now)}</dd>
                <dt>Cloudflare</dt><dd>{expiryText(profile.session.cloudflare, now)}</dd>
              </dl>
              {!!profile.session.history?.length && (
                <details>
                  <summary>Expiry history ({profile.session.history.length})</summary>
                  <ul>
                    {profile.session.history.map((h) => (
                      <li key={h.seenAt}>
                        {shortDate(h.seenAt, true)}: login {shortDate(h.login, true)},
                        session {shortDate(h.session, true)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          <div className="profile-actions">
            <button className="danger" onClick={doLogout} disabled={loggingOut}>
              {loggingOut ? 'Logging out…' : 'Log out'}
            </button>
            <button className="secondary" onClick={closeProfile}>Close</button>
          </div>
        </Modal>
      )}

      {showVenues && (
        <Modal title={`Venues matching “${query}”`} onClose={() => { setShowVenues(false); setError(''); }}>
          {error && <div className="error">{error}</div>}
          {searching && <div className="loading">Searching…</div>}
          {!searching && !error && !venues.length && <div className="empty">No venues found.</div>}
          {!!venues.length && (
            <div className="results">
              {venues.map((v) => (
                <div key={v.url} className="row" onClick={() => pickVenue(v)}>
                  <div className="beer-left">
                    <div className="name">
                      {v.name}
                      {savedEntry(v.url) && <span className="saved-star"> ★</span>}
                    </div>
                    <div className="address">{v.address || '—'}</div>
                  </div>
                  <button className="secondary" type="button">Select</button>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {selected && (
        <Modal
          title={menu?.venue?.name || selected.name}
          subtitle={menu && (
            <>
              {allBeers.length} beers, {hadCount} had, {allBeers.length - hadCount} new
              {menu.checkedAt && <> · Last checked: {timeAgo(menu.checkedAt, now)}</>}
            </>
          )}
          logo={menu?.venue?.logo}
          onBack={menuFrom === 'search' && venues.length > 0 ? backToResults : undefined}
          actions={menu && (
            <button
              className={`star ${isSaved ? 'on' : ''}`}
              onClick={toggleSave}
              disabled={!isSaved && saved.length >= savedMax}
              aria-label={isSaved ? 'Remove from saved venues' : 'Save venue'}
              title={!isSaved && saved.length >= savedMax
                ? `You can save up to ${savedMax} venues. Remove one first.`
                : isSaved ? 'Saved — tap to remove' : 'Save venue'}
            >
              {isSaved ? '★' : '☆'}
            </button>
          )}
          toolbar={menu && [
            ['new', `Not had (${allBeers.length - hadCount})`],
            ['had', `Had (${hadCount})`],
            ['all', `All (${allBeers.length})`],
          ].map(([k, label]) => (
            <button
              key={k}
              className={filter === k ? 'active' : ''}
              onClick={() => setFilter(k)}
            >
              {label}
            </button>
          ))}
          onClose={closeMenu}
        >
          {error && <div className="error">{error}</div>}

          {loadingMenu && !menu && <div className="loading">Loading beer list…</div>}

          {menu && (
            <>
              {menu.source === 'checkins' && (
                <div className="notice">
                  This venue has no menu on Untappd, so this list is built from check-ins
                  in the last {menu.windowDays} days. Ratings are check-in averages.
                  {!menu.hadKnown && ' Tap Update Uniques to mark the beers you’ve had.'}
                </div>
              )}
              {filteredSections.length === 0 && (
                <div className="menu"><div className="empty">Nothing here.</div></div>
              )}
              {filteredSections.map((section) => {
                const secHad = section.beers.filter((b) => b.had).length;
                const key = sectionKey(section.name);
                const expanded = isExpanded(key);
                const fav = favKeys.includes(key);
                return (
                  <div key={section.name || 'unnamed'} style={{ marginBottom: 18 }}>
                    {section.name && (
                      <div className="section-header">
                        {multiSection ? (
                          <button
                            type="button"
                            className="section-toggle"
                            aria-expanded={expanded}
                            onClick={() => setSectionOpen((o) => ({ ...o, [key]: !expanded }))}
                          >
                            <span className="chevron">{expanded ? '▾' : '▸'}</span>
                            {section.name}
                          </button>
                        ) : (
                          <span>{section.name}</span>
                        )}
                        <span className="section-stats">
                          {section.beers.length} items · {secHad} had
                          {multiSection && (
                            <button
                              type="button"
                              className={`star small ${fav ? 'on' : ''}`}
                              onClick={() => toggleSectionFav(key)}
                              aria-label={fav ? 'Unfavourite section' : 'Favourite section'}
                              title={fav
                                ? 'Favourite section — opens expanded. Tap to remove.'
                                : 'Favourite this section so it opens expanded'}
                            >
                              {fav ? '★' : '☆'}
                            </button>
                          )}
                        </span>
                      </div>
                    )}
                    <div className="menu" hidden={!expanded}>
                      {section.beers.map((b) => (
                        <div
                          key={b.url}
                          className={`row ${b.had ? 'had' : ''}`}
                          onClick={() => openBeer(b)}
                        >
                          <span className="rank">#{b.rank}</span>
                          {b.label ? (
                            <img className="beer-label" src={b.label} alt="" />
                          ) : (
                            <div className="beer-label placeholder" />
                          )}
                          <div className="beer-left">
                            <div className="name">{b.name}</div>
                            <div className="meta">
                              {[b.brewery, b.style].filter(Boolean).join(' · ') || '—'}
                            </div>
                            <div className="meta sub">
                              {[
                                b.abv,
                                b.ibu,
                                b.rating ? `★ ${Number(b.rating).toFixed(2)}` : null,
                                b.lastSeen ? `seen ${timeAgo(b.lastSeen, now)}` : null,
                                b.checkins > 1 ? `${b.checkins} check-ins` : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          </div>
                          <span className={`badge ${b.had ? 'had' : 'new'}`}>
                            {b.had ? 'Had' : 'New'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </Modal>
      )}

      {beer && (() => {
        // Prefer the beer page's details, falling back to what the tile had.
        const pick = (k) => beerInfo?.[k] || beer[k];
        const id = beer.id || (beer.url.match(/\/b\/[^/?#]+\/(\d+)/) || [])[1];
        const rating = beerInfo ? beerInfo.rating : beer.rating;
        const isTouch = window.matchMedia?.('(pointer: coarse)').matches;
        return (
          <Modal
            title={pick('name')}
            subtitle={[pick('brewery'), pick('style')].filter(Boolean).join(' · ')}
            logo={pick('label')}
            size="small"
            onClose={closeBeer}
          >
            {beerError && <div className="error">Couldn’t load full details: {beerError}</div>}
            <div className="beer-facts">
              <span className={`badge ${beer.had ? 'had' : 'new'}`}>{beer.had ? 'Had' : 'New'}</span>
              {[
                pick('abv'),
                pick('ibu'),
                rating ? `★ ${Number(rating).toFixed(2)}` : null,
                beerInfo?.raters ? `${beerInfo.raters} ratings` : null,
              ].filter(Boolean).join(' · ')}
            </div>
            {!beerInfo && !beerError && (
              <div className="loading"><BeerMug /> Loading details…</div>
            )}
            {beerInfo?.description && <p className="beer-desc">{beerInfo.description}</p>}
            {!!beerInfo?.stats?.length && (
              <div className="profile-stats">
                {beerInfo.stats.map((s) => (
                  <div key={s.label} className="profile-stat">
                    <div className="profile-stat-value">{s.value}</div>
                    <div className="profile-stat-label">{s.label}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="profile-actions">
              <a className="button" href={beer.url} target="_blank" rel="noreferrer">
                Check in on Untappd ↗
              </a>
              {isTouch && id && (
                <a className="button secondary" href={`untappd://beer/${id}`}>Open in app</a>
              )}
              <button className="secondary" onClick={closeBeer}>Close</button>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}
