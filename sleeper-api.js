// ── Shared Sleeper API Layer ──────────────────────────────────────
// Base fetch helpers for both War Room Scout and War Room.
// Each app may wrap these with its own orchestration (e.g. War Room Scout's
// loadLeague calls render functions after fetching), but the raw API
// calls live here once.

window.App = window.App || {};

const SLEEPER_BASE = 'https://api.sleeper.app/v1';

// ── Base fetch with error handling ───────────────────────────────
async function sleeperFetch(path) {
  const res = await fetch(SLEEPER_BASE + path);
  if (!res.ok) {
    if (res.status === 404) return null; // Endpoint not found — return null silently
    throw new Error('Sleeper API error: ' + res.status);
  }
  return res.json();
}

// ── IndexedDB key/value cache for payloads too big for Web Storage's ~5MB quota.
// The Sleeper players map is ~15MB, so the old sessionStorage write always threw
// QuotaExceededError and was silently swallowed — the cache never persisted and
// /players/nfl was re-downloaded on every load. IndexedDB has ample room. Degrades
// to a no-op cache miss if IDB is unavailable so callers always fall back to a
// refetch. Named uniquely (not WrIDB) to avoid a top-level collision with War
// Room's core.js when both load in the same global script scope.
const _sleeperIDB = (() => {
  const DB_NAME = 'reconai-sleeper', STORE = 'kv';
  let _dbPromise = null;
  function open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (typeof window.indexedDB === 'undefined') return reject(new Error('indexedDB unavailable'));
      const req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
    });
    _dbPromise.catch(() => { _dbPromise = null; }); // allow retry after a failed open
    return _dbPromise;
  }
  return {
    get(key) {
      return open().then(db => new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      }));
    },
    set(key, value) {
      return open().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('indexedDB write aborted'));
      }));
    },
    del(key) {
      return open().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }));
    },
  };
})();

// ── Player DB cache (persisted in IndexedDB via _sleeperIDB) ─────
let _playersCache = null;
let _playersCacheTime = 0;
let _playersInflight = null;
const PLAYERS_TTL = 60 * 60 * 1000; // 1 hour

async function fetchPlayers() {
  // Check memory cache
  if (_playersCache && Date.now() - _playersCacheTime < PLAYERS_TTL) return _playersCache;
  // Dedup concurrent callers so the ~15MB payload is fetched at most once.
  if (_playersInflight) return _playersInflight;
  _playersInflight = (async () => {
    // Check the persistent IndexedDB cache
    try {
      const cached = await _sleeperIDB.get('fw_players_cache');
      if (cached && cached.data && Date.now() - cached.ts < PLAYERS_TTL) {
        _playersCache = cached.data;
        _playersCacheTime = cached.ts;
        return cached.data;
      }
    } catch (e) { /* IDB unavailable — fall through to refetch */ }
    // Fetch fresh
    const data = await sleeperFetch('/players/nfl');
    _playersCache = data;
    _playersCacheTime = Date.now();
    // Fire-and-forget persist — never block returning data on the write.
    _sleeperIDB.set('fw_players_cache', { data, ts: Date.now() }).catch(() => {});
    return data;
  })();
  try {
    return await _playersInflight;
  } finally {
    _playersInflight = null;
  }
}

// ── Season stats / projections cache (IndexedDB-backed) ──────────
// A full-season map (every player × every stat/projection field) runs to
// several MB — well over Web Storage's ~5MB quota — so the old sessionStorage
// write silently threw QuotaExceededError (swallowed) and the cache never
// persisted: every load re-downloaded multi-MB blobs, the same failure mode the
// players map had. Persist in IndexedDB (_sleeperIDB) instead, with in-flight
// dedup so concurrent callers (loadLeagueIntel + loadRosterStats + the player
// modal) share one download. Completed seasons are immutable → long TTL; the
// in-progress season → short TTL.
const _statsCache = {};              // season → {data, ts} (in-memory, fast path)
// Renamed from _projectionsCache to avoid a top-level identifier collision with
// War Room's js/core.js which declares its own `let _projectionsCache = {}` at
// the same global script scope (two same-named top-level bindings throw a parse
// error and halt core.js before it sets window.App.WrStorage).
const _sleeperProjectionsCache = {}; // season → {data, ts} (in-memory, fast path)
const _seasonInflight = {};          // idbKey → Promise (dedup concurrent fetches)
const _SEASON_LIVE_TTL = 60 * 60 * 1000;            // 1h  — in-progress season
const _SEASON_DONE_TTL = 30 * 24 * 60 * 60 * 1000;  // 30d — completed seasons (immutable)

// Completed seasons (before the current calendar year) never change. In the
// offseason (e.g. June 2026) the just-finished 2025 season is < 2026 → long TTL;
// the upcoming 2026 season is >= 2026 → short TTL. Sound for stats + projections.
function _seasonTtl(season) {
  return (parseInt(season, 10) < new Date().getFullYear()) ? _SEASON_DONE_TTL : _SEASON_LIVE_TTL;
}

async function _fetchSeasonCached(season, memCache, idbKey, path) {
  // Memory hits must respect the TTL too — without the ts check, the first
  // in-season fetch was served for the whole session (a tab left open across
  // game day fed day-old stats to every engine until a hard reload).
  const mem = memCache[season];
  if (mem && mem.data && Date.now() - mem.ts < _seasonTtl(season)) return mem.data;
  if (_seasonInflight[idbKey]) return _seasonInflight[idbKey];
  _seasonInflight[idbKey] = (async () => {
    const ttl = _seasonTtl(season);
    try {
      const cached = await _sleeperIDB.get(idbKey);
      if (cached && cached.data && Date.now() - cached.ts < ttl) {
        memCache[season] = { data: cached.data, ts: cached.ts };
        return cached.data;
      }
    } catch (e) { /* IDB unavailable — fall through to refetch */ }
    const data = await sleeperFetch(path);
    memCache[season] = { data, ts: Date.now() };
    // Fire-and-forget persist — never block returning data on the write.
    _sleeperIDB.set(idbKey, { data, ts: Date.now() }).catch(() => {});
    return data;
  })();
  try { return await _seasonInflight[idbKey]; }
  finally { delete _seasonInflight[idbKey]; }
}

// Keys carry a _v2 suffix so they live in IndexedDB, never colliding with the
// legacy sessionStorage `fw_stats_{season}` key still read by older callers.
async function fetchSeasonStats(season) {
  return _fetchSeasonCached(season, _statsCache, 'fw_stats_v2_' + season, '/stats/nfl/regular/' + season);
}

async function fetchSeasonProjections(season) {
  return _fetchSeasonCached(season, _sleeperProjectionsCache, 'fw_proj_v2_' + season, '/projections/nfl/regular/' + season);
}

// Force-expire the players + season caches so the next fetch hits the network.
// Called by the manual "Refresh Data" path (which previously nulled a window
// global that was never the real cache). Memory is cleared for every cached
// season; IndexedDB entries are deleted only for LIVE seasons — completed
// seasons are immutable, so re-downloading those multi-MB blobs is pure waste.
function clearSeasonCaches() {
  const yr = new Date().getFullYear();
  [[_statsCache, 'fw_stats_v2_'], [_sleeperProjectionsCache, 'fw_proj_v2_']].forEach(([cache, prefix]) => {
    Object.keys(cache).forEach(season => {
      delete cache[season];
      if (parseInt(season, 10) >= yr) _sleeperIDB.del(prefix + season).catch(() => {});
    });
  });
  _playersCache = null;
  _playersCacheTime = 0;
  _sleeperIDB.del('fw_players_cache').catch(() => {});
}

// ── Common fetch helpers ─────────────────────────────────────────
async function fetchUser(username)              { return sleeperFetch('/user/' + encodeURIComponent(username)); }
async function fetchLeagues(userId, season)     { return sleeperFetch('/user/' + userId + '/leagues/nfl/' + season); }
async function fetchRosters(leagueId)           { return sleeperFetch('/league/' + leagueId + '/rosters'); }
async function fetchLeagueInfo(leagueId)        { return sleeperFetch('/league/' + leagueId); }
async function fetchLeagueUsers(leagueId)       { return sleeperFetch('/league/' + leagueId + '/users'); }
async function fetchTradedPicks(leagueId)       { return sleeperFetch('/league/' + leagueId + '/traded_picks'); }
async function fetchDrafts(leagueId)            { return sleeperFetch('/league/' + leagueId + '/drafts'); }
async function fetchDraftPicks(draftId)         { return sleeperFetch('/draft/' + draftId + '/picks'); }
async function fetchMatchups(leagueId, week)    { return sleeperFetch('/league/' + leagueId + '/matchups/' + week); }
async function fetchTransactions(leagueId, week){ return sleeperFetch('/league/' + leagueId + '/transactions/' + week); }
async function fetchNflState()                  { return sleeperFetch('/state/nfl'); }

async function fetchTrending(type, hours, limit) {
  try {
    return await sleeperFetch('/players/nfl/trending/' + type
      + '?lookback_hours=' + (hours || 24)
      + '&limit=' + (limit || 25));
  } catch (e) { return []; }
}

async function fetchWinnersBracket(leagueId) {
  return sleeperFetch('/league/' + leagueId + '/winners_bracket');
}

async function fetchLosersBracket(leagueId) {
  return sleeperFetch('/league/' + leagueId + '/losers_bracket').catch(function () { return []; });
}

// ── Fantasy Points Calculator ────────────────────────────────────
// Full scoring: offense + IDP (prefixed & non-prefixed) + kicking + special teams.
// `stats` = raw stat line from Sleeper, `sc` = league scoring_settings object.

function calcFantasyPts(stats, sc) {
  if (!stats) return 0;
  let pts = 0;
  // Use ?? so leagues that explicitly set a scoring value to 0 aren't overridden by defaults
  var add = function (stat, mult) { pts += (stats[stat] || 0) * (mult ?? 0); };

  // Offense — passing
  add('pass_yd',   sc.pass_yd   ?? 0);
  add('pass_td',   sc.pass_td   ?? 4);
  add('pass_int',  sc.pass_int  ?? -1);
  add('pass_2pt',  sc.pass_2pt  ?? 0);
  add('pass_sack', sc.pass_sack ?? 0);

  // Offense — rushing
  add('rush_yd',  sc.rush_yd  ?? 0.1);
  add('rush_td',  sc.rush_td  ?? 6);
  add('rush_2pt', sc.rush_2pt ?? 0);
  add('rush_fd',  sc.rush_fd  ?? 0);

  // Offense — receiving
  add('rec',     sc.rec     ?? 0.5);
  add('rec_yd',  sc.rec_yd  ?? 0.1);
  add('rec_td',  sc.rec_td  ?? 6);
  add('rec_2pt', sc.rec_2pt ?? 0);
  add('rec_fd',  sc.rec_fd  ?? 0);

  // Fumbles
  add('fum_lost',   sc.fum_lost   ?? -0.5);
  add('fum_rec_td', sc.fum_rec_td ?? 0);

  // Kicking
  add('xpm',          sc.xpm          ?? 0);
  add('xpmiss',       sc.xpmiss       ?? 0);
  add('fgm',          sc.fgm          ?? 0);
  add('fgm_0_19',     sc.fgm_0_19     ?? 0);
  add('fgm_20_29',    sc.fgm_20_29    ?? 0);
  add('fgm_30_39',    sc.fgm_30_39    ?? 0);
  add('fgm_40_49',    sc.fgm_40_49    ?? 0);
  add('fgm_50p',      sc.fgm_50p      ?? 0);
  add('fgm_50_59',    sc.fgm_50_59    ?? 0);
  add('fgm_60p',      sc.fgm_60p      ?? 0);
  add('fgm_yds',      sc.fgm_yds      ?? 0);
  add('fgmiss',       sc.fgmiss       ?? 0);
  add('fgmiss_0_19',  sc.fgmiss_0_19  ?? 0);
  add('fgmiss_20_29', sc.fgmiss_20_29 ?? 0);

  // IDP — try both idp-prefixed and non-prefixed field names (Sleeper uses both)
  var idpFields = [
    ['idp_tkl_solo',  'tkl_solo'],
    ['idp_tkl_ast',   'tkl_ast'],
    ['idp_tkl_loss',  'tkl_loss'],
    ['idp_sack',      'sack'],
    ['idp_qb_hit',    'qb_hit'],
    ['idp_int',       'int'],
    ['idp_ff',        'ff'],
    ['idp_fum_rec'],
    ['idp_pass_def',  'pass_def'],
    ['idp_pass_def_3p'],
    ['idp_def_td',    'def_td'],
    ['idp_blk_kick'],
    ['idp_safe'],
    ['idp_sack_yd'],
    ['idp_int_ret_yd'],
    ['idp_fum_ret_yd'],
  ];
  idpFields.forEach(function (names) {
    var scKey = names[0]; // scoring setting key is always idp_ prefixed
    var mult = sc[scKey] ?? 0;
    if (!mult) return;
    // Try each field name variant, use first non-zero
    var val = 0;
    for (var i = 0; i < names.length; i++) {
      if (stats[names[i]]) { val = stats[names[i]]; break; }
    }
    pts += val * mult;
  });

  // Special teams
  add('st_td',       sc.st_td       ?? 0);
  add('st_ff',       sc.st_ff       ?? 0);
  add('st_fum_rec',  sc.st_fum_rec  ?? 0);
  add('st_tkl_solo', sc.st_tkl_solo ?? 0);
  add('kr_yd',       sc.kr_yd       ?? 0);
  add('pr_yd',       sc.pr_yd       ?? 0);

  return Math.round(pts * 10) / 10;
}

// ── Normalize traded picks: owner_id can be roster_id OR user_id ─
// Sleeper's /traded_picks API is ambiguous — detect which type and
// convert to roster_id so all downstream code can compare safely.
function normalizeTradedPicks(rosters, tradedPicks) {
  if (!tradedPicks?.length || !rosters?.length) return tradedPicks || [];
  const rosterIds = new Set(rosters.map(r => String(r.roster_id)));
  const userIds   = new Set(rosters.map(r => String(r.owner_id)));
  let rosterHits = 0, userHits = 0;
  for (const tp of tradedPicks) {
    const oid = String(tp.owner_id ?? '');
    if (rosterIds.has(oid)) rosterHits++;
    if (userIds.has(oid))   userHits++;
  }
  if (rosterHits >= userHits) return tradedPicks; // already roster_ids
  // Convert user_ids → roster_ids
  const userToRoster = {};
  for (const r of rosters) userToRoster[String(r.owner_id)] = String(r.roster_id);
  return tradedPicks.map(tp => {
    const rid = userToRoster[String(tp.owner_id ?? '')];
    return rid ? { ...tp, owner_id: rid } : tp;
  });
}

// ── PlatformProvider adapter ──────────────────────────────────────
// Implements the unified PlatformProvider interface (see
// shared/platform-provider.js). Wraps the Sleeper-native fetch
// pipeline that War Room's LeagueDetail used to do inline, so that
// LeagueDetail can consume all four platforms uniformly.

// STATS_YEAR_FALLBACK: prior season used as a baseline when the
// current season has little data yet (early offseason). War Room
// passes its own value via ctx.prevSeason when available; we fall
// back to (currentSeason - 1) otherwise.
const STATS_YEAR_FALLBACK_DEFAULT = String(new Date().getFullYear() - 1);

// Capture fetch function references by closure at module load time.
// Classic <script src=> at top level registers `async function X` on
// the global object, so a later-loaded script (e.g. War Room's
// js/core.js) that redeclares `fetchLeagueUsers` / `fetchRosters` etc.
// can overwrite those globals. Using this local alias ensures the
// Sleeper provider always calls sleeper-api.js's versions, not any
// shadowed variant with a different SLEEPER_BASE_URL.
const _SP = {
  fetchSeasonStats,
  fetchSeasonProjections,
  fetchRosters,
  fetchLeagueUsers,
  fetchTradedPicks,
  fetchMatchups,
  fetchTransactions,
  fetchNflState,
  fetchTrending,
};

async function _sleeperFetchAllWeeklyTransactions(leagueId, nflState, currentWeek) {
  // Sleeper splits transactions into per-week endpoints. During the
  // offseason we fetch all 18 weeks to pick up offseason trades; in
  // season we fetch up to the current week.
  const isOffseason = !nflState?.season_type || nflState.season_type === 'off' || currentWeek <= 1;
  const maxWeek = isOffseason ? 18 : Math.min(18, currentWeek);
  const weekFetches = [];
  for (let w = 0; w <= maxWeek; w++) {
    weekFetches.push(_SP.fetchTransactions(leagueId, w).catch(() => []));
  }
  const weekResults = await Promise.all(weekFetches);
  return weekResults.flat().filter(t => t && t.type && t.status !== 'failed');
}

const SleeperProvider = {
  id: 'sleeper',
  displayName: 'Sleeper',
  capabilities: {
    hasTransactions: true,
    hasDrafts: true,
    hasTradedPicks: true,
    hasMatchups: true,
    hasBracket: true,
    hasYearChain: true,
    hasFaab: true,
    hasTrending: true,
    hasPlayerStats: true,
    requiresOAuth: false,
    requiresFranchisePicker: false,
  },

  // Sleeper uses a single global auth (od_auth_v1 / Sleeper username)
  // rather than per-league credentials — these are no-ops.
  saveCredentials() {},
  loadCredentials() { return null; },
  clearCredentials() {},

  // ── Phase 1: CONNECT ────────────────────────────────────────────
  async connect(creds) {
    const { username, season } = creds || {};
    if (!username) throw new Error('Sleeper username required');
    const user = await fetchUser(username);
    if (!user?.user_id) throw new Error('Sleeper user not found: ' + username);
    const yr = season || String(new Date().getFullYear());
    const leagues = (await fetchLeagues(user.user_id, yr)) || [];
    return {
      leagues: leagues.map(l => ({
        id: l.league_id,
        name: l.name,
        season: String(l.season || yr),
        _platform: 'sleeper',
        _platformCreds: {},        // Sleeper uses global auth
        // Keep the raw Sleeper league shape — LeagueDetail already understands it
        ...l,
      })),
      needsFranchisePicker: false,
    };
  },

  // ── Phase 2: HYDRATE ────────────────────────────────────────────
  async hydrate(league, ctx) {
    const context = ctx || {};
    const currentSeason = context.currentSeason || league.season || String(new Date().getFullYear());
    const prevSeason = context.prevSeason || STATS_YEAR_FALLBACK_DEFAULT;
    const leagueId = league.league_id || league.id;

    // First, fetch NFL state so we know the current week for transactions
    const nflState = context.nflState || await _SP.fetchNflState().catch(() => ({}));
    const currentWeek = context.currentWeek != null
      ? context.currentWeek
      : (nflState?.display_week || nflState?.week || 1);

    // Fire the main pipeline in parallel — Sleeper can handle it.
    // All fetches go through _SP (closure-captured) instead of bare
    // identifiers to avoid global shadowing by consumer apps.
    const [
      stats,
      projections,
      prevStats,
      rosters,
      leagueUsers,
      tradedPicks,
      matchups,
      rawTxns,
      trendingAdds,
      trendingDrops,
    ] = await Promise.all([
      _SP.fetchSeasonStats(currentSeason).catch(() => ({})),
      _SP.fetchSeasonProjections(currentSeason).catch(() => ({})),
      _SP.fetchSeasonStats(prevSeason).catch(() => ({})),
      _SP.fetchRosters(leagueId).catch(() => []),
      _SP.fetchLeagueUsers(leagueId).catch(() => []),
      _SP.fetchTradedPicks(leagueId).catch(() => []),
      _SP.fetchMatchups(leagueId, currentWeek).catch(() => []),
      _sleeperFetchAllWeeklyTransactions(leagueId, nflState, currentWeek),
      _SP.fetchTrending('add', 24, 15).catch(() => []),
      _SP.fetchTrending('drop', 24, 15).catch(() => []),
    ]);

    // Normalize traded picks (Sleeper's /traded_picks API is ambiguous
    // about roster_id vs user_id in owner_id — fix it here).
    const normalizedTradedPicks = normalizeTradedPicks(rosters, tradedPicks);

    // Bucket transactions by week — Sleeper already gives them with a
    // `leg` field that says which week. Fallback to 'w0' if missing.
    const transactionsByWeek = {};
    rawTxns
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .forEach(t => {
        const wkKey = 'w' + (t.leg ?? t.week ?? 0);
        if (!transactionsByWeek[wkKey]) transactionsByWeek[wkKey] = [];
        transactionsByWeek[wkKey].push(t);
      });

    // The league object passed in is already Sleeper-shaped — pass it
    // through unchanged so LeagueDetail sees the same shape it used to
    // get from its hand-rolled pipeline.
    return {
      league,
      rosters,
      leagueUsers,
      players: {},                 // Sleeper DB is loaded separately by the caller
      transactions: transactionsByWeek,
      tradedPicks: normalizedTradedPicks,
      drafts: [],                  // LeagueDetail fetches drafts via its own path when needed
      matchups,
      nflState,
      trending: { adds: trendingAdds || [], drops: trendingDrops || [] },
      _extras: { stats, projections, prevStats },
    };
  },
};

if (window.App?.Platforms?.register) {
  window.App.Platforms.register(SleeperProvider);
} else {
  console.warn('[Sleeper] platform-provider.js not loaded — provider will not be registered');
}

// ── Expose on window ─────────────────────────────────────────────
var SleeperAPI = {
  SLEEPER_BASE:       SLEEPER_BASE,
  sleeperFetch:       sleeperFetch,
  fetchPlayers:       fetchPlayers,
  fetchSeasonStats:   fetchSeasonStats,
  fetchSeasonProjections: fetchSeasonProjections,
  clearSeasonCaches:  clearSeasonCaches,
  fetchUser:          fetchUser,
  fetchLeagues:       fetchLeagues,
  fetchRosters:       fetchRosters,
  fetchLeagueInfo:    fetchLeagueInfo,
  fetchLeagueUsers:   fetchLeagueUsers,
  fetchTradedPicks:   fetchTradedPicks,
  fetchDrafts:        fetchDrafts,
  fetchDraftPicks:    fetchDraftPicks,
  fetchMatchups:      fetchMatchups,
  fetchTransactions:  fetchTransactions,
  fetchNflState:      fetchNflState,
  fetchTrending:      fetchTrending,
  fetchWinnersBracket:fetchWinnersBracket,
  fetchLosersBracket: fetchLosersBracket,
  calcFantasyPts:     calcFantasyPts,
  normalizeTradedPicks: normalizeTradedPicks,

  // Unified PlatformProvider interface
  provider: SleeperProvider,
};

window.App.Sleeper = SleeperAPI;
window.Sleeper     = SleeperAPI;
// Alias sf for DHQ engine compatibility
window.App.sf = sleeperFetch;
window.sf = sleeperFetch;
window.App.SLEEPER = SLEEPER_BASE;
// Expose calcFantasyPts as a bare global so js/sleeper-api.js callers can use it without the Sleeper prefix
window.calcFantasyPts = calcFantasyPts;
window.normalizeTradedPicks = normalizeTradedPicks;

// ── Module global exports (Vite migration) ───────────────────────────────────
window.sleeperFetch = sleeperFetch;
window.fetchPlayers = fetchPlayers;
window.fetchSeasonStats = fetchSeasonStats;
window.fetchUser = fetchUser;
window.fetchLeagues = fetchLeagues;
window.fetchRosters = fetchRosters;
window.fetchLeagueInfo = fetchLeagueInfo;
window.fetchLeagueUsers = fetchLeagueUsers;
window.fetchTradedPicks = fetchTradedPicks;
window.fetchDrafts = fetchDrafts;
window.fetchDraftPicks = fetchDraftPicks;
window.fetchMatchups = fetchMatchups;
window.fetchTransactions = fetchTransactions;
window.fetchNflState = fetchNflState;
window.fetchTrending = fetchTrending;
window.fetchWinnersBracket = fetchWinnersBracket;
window.fetchLosersBracket = fetchLosersBracket;
