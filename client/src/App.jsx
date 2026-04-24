import { useEffect, useMemo, useState } from 'react';

async function api(path, options) {
  const res = await fetch(path, options);
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

export default function App() {
  const persisted = loadPersisted() || {};
  const [loggedIn, setLoggedIn] = useState(null);
  const [query, setQuery] = useState(persisted.query || '');
  const [venues, setVenues] = useState(persisted.venues || []);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(persisted.selected || null);
  const [menu, setMenu] = useState(persisted.menu || null);
  const [loadingMenu, setLoadingMenu] = useState(false);
  const [filter, setFilter] = useState(persisted.filter || 'new');
  const [error, setError] = useState('');

  // Persist state on every meaningful change.
  useEffect(() => {
    savePersisted({ query, venues, selected, menu, filter });
  }, [query, venues, selected, menu, filter]);

  const refreshStatus = async () => {
    try {
      const { loggedIn } = await api('/api/status');
      setLoggedIn(loggedIn);
    } catch (e) {
      setLoggedIn(false);
      setError(e.message);
    }
  };

  useEffect(() => { refreshStatus(); }, []);

  const doLogin = async () => {
    setError('');
    try {
      await api('/api/login', { method: 'POST' });
      const start = Date.now();
      while (Date.now() - start < 5 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const { loggedIn } = await api('/api/status');
          setLoggedIn(loggedIn);
          if (loggedIn) break;
        } catch { /* keep polling */ }
      }
    } catch (e) {
      setError(e.message);
    }
  };

  const doSearch = async (e) => {
    e?.preventDefault?.();
    if (!query.trim()) return;
    setError(''); setSearching(true); setVenues([]); setSelected(null); setMenu(null);
    try {
      const { venues } = await api(`/api/venues?q=${encodeURIComponent(query)}`);
      setVenues(venues);
      if (!venues.length) setError('No venues found.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  };

  const pickVenue = async (v) => {
    setSelected(v); setMenu(null); setLoadingMenu(true); setError('');
    try {
      const data = await api(`/api/venue?url=${encodeURIComponent(v.url)}`);
      setMenu(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMenu(false);
    }
  };

  const reloadMenu = async () => {
    if (!selected) return;
    setLoadingMenu(true); setError('');
    try {
      const data = await api(`/api/venue?url=${encodeURIComponent(selected.url)}`);
      setMenu(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMenu(false);
    }
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
        const ranked = [...s.beers]
          .sort((a, b) => {
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

  return (
    <div className="app">
      <header className="top">
        <h1>Venue List</h1>
        <div className={`status ${loggedIn ? 'ok' : ''}`}>
          <span className="dot" />
          {loggedIn === null ? 'checking…' : loggedIn ? 'logged in to Untappd' : 'not logged in'}
          {!loggedIn && (
            <button style={{ marginLeft: 10 }} onClick={doLogin}>
              Open login window
            </button>
          )}
          <button className="secondary" style={{ marginLeft: 8 }} onClick={refreshStatus}>
            Refresh
          </button>
          {loggedIn && (
            <button
              className="secondary"
              style={{ marginLeft: 8 }}
              onClick={async () => {
                setError('');
                try {
                  const r = await api('/api/refresh-had', { method: 'POST' });
                  alert(`Cached ${r.count} beers you've had (${r.username}).`);
                } catch (e) { setError(e.message); }
              }}
            >
              Refresh my beers
            </button>
          )}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <form className="search" onSubmit={doSearch}>
        <input
          placeholder="Venue name (e.g. Monkish Brewing)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={searching || !loggedIn}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {!!venues.length && !selected && (
        <>
          <div className="section-title">Venues</div>
          <div className="results">
            {venues.map((v) => (
              <div key={v.url} className="row" onClick={() => pickVenue(v)}>
                <div className="beer-left">
                  <div className="name">{v.name}</div>
                  <div className="address">{v.address || '—'}</div>
                </div>
                <button className="secondary" type="button">Select</button>
              </div>
            ))}
          </div>
        </>
      )}

      {selected && (
        <>
          <div className="section-title">
            {menu?.venue?.name || selected.name}
            {menu && (
              <span style={{ marginLeft: 10, textTransform: 'none' }}>
                — {allBeers.length} beers, {hadCount} had, {allBeers.length - hadCount} new
              </span>
            )}
          </div>

          {loadingMenu && <div className="loading">Loading beer list…</div>}

          {menu && (
            <>
              <div className="tabs">
                {[
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
                <button
                  className="secondary"
                  style={{ marginLeft: 'auto' }}
                  onClick={reloadMenu}
                  disabled={loadingMenu}
                >
                  {loadingMenu ? 'Reloading…' : 'Reload menu'}
                </button>
                <button
                  className="secondary"
                  onClick={() => { setSelected(null); setMenu(null); }}
                >
                  ← Back to venues
                </button>
              </div>

              <div className="menu">
                {filteredSections.length === 0 && <div className="empty">Nothing here.</div>}
              </div>
              {filteredSections.map((section) => {
                const secHad = section.beers.filter((b) => b.had).length;
                return (
                  <div key={section.name || 'unnamed'} style={{ marginBottom: 18 }}>
                    {section.name && (
                      <div className="section-header">
                        <span>{section.name}</span>
                        <span className="section-stats">
                          {section.beers.length} items · {secHad} had
                        </span>
                      </div>
                    )}
                    <div className="menu">
                      {section.beers.map((b) => (
                        <div key={b.url} className={`row ${b.had ? 'had' : ''}`}>
                          <span className="rank">#{b.rank}</span>
                          {b.label ? (
                            <img className="beer-label" src={b.label} alt="" />
                          ) : (
                            <div className="beer-label placeholder" />
                          )}
                          <div className="beer-left">
                            <div className="name">
                              <a href={b.url} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                                {b.name}
                              </a>
                            </div>
                            <div className="meta">
                              {[b.brewery, b.style].filter(Boolean).join(' · ') || '—'}
                            </div>
                            <div className="meta sub">
                              {[b.abv, b.ibu, b.rating ? `★ ${Number(b.rating).toFixed(2)}` : null]
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
        </>
      )}
    </div>
  );
}
