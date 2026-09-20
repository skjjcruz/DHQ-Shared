// ══════════════════════════════════════════════════════════════════
// shared/mfl-api.js — MyFantasyLeague connector
// Fetches MFL league data and maps it to Sleeper-equivalent format
// so all existing ReconAI/WarRoom features work without modification.
//
// window.MFL exposes:
//   fetchLeague(leagueId, year, apiKey) → { league, rosters, players }
//   mapToSleeperState(raw, leagueId, year) → { players, rosters, league, leagueUsers }
//   buildCrosswalk(sleeperPlayers, mflPlayers, year) → MFL playerId → Sleeper pid map
//   connectLeague(leagueId, year, apiKey, myFranchiseId) → populates window.S
// ══════════════════════════════════════════════════════════════════

window.App = window.App || {};

(function () {
'use strict';

const MFL_BASE = 'https://api.myfantasyleague.com';

// MFL scoring event code → Sleeper scoring key.
// MFL scoring lives in the TYPE=rules export as position-specific rules, each
// with an `event` code (e.g. "PY", "TK") and a `points` formula (e.g. "*.04",
// "3/.5"). These codes map onto the flat Sleeper scoring_settings keys the DHQ
// engine reads. (The old name-based map — TACKLE_SOLO etc. — never matched MFL's
// real export, so IDP scoring silently produced nothing.)
const MFL_EVENT_MAP = {
  // Passing
  '#P': 'pass_td', 'PY': 'pass_yd', 'IN': 'pass_int', 'P2': 'pass_2pt',
  // Rushing
  '#R': 'rush_td', 'RY': 'rush_yd', 'R2': 'rush_2pt',
  // Receiving
  '#C': 'rec_td', 'CY': 'rec_yd', 'CC': 'rec', 'C2': 'rec_2pt',
  // Fumbles (offense)
  'FL': 'fum_lost',
  // Returns
  'KY': 'kr_yd', 'UY': 'pr_yd', '#KT': 'kr_td', '#UT': 'pr_td',
  // ── IDP (defense) ──
  'TK':  'idp_tkl_solo',   // solo tackle
  'AS':  'idp_tkl_ast',    // assisted tackle
  'TKL': 'idp_tkl_loss',   // tackle for loss
  'SK':  'idp_sack',
  'QH':  'idp_qb_hit',
  'IC':  'idp_int',        // interception caught (defensive)
  'FF':  'idp_ff',         // forced fumble
  'FC':  'idp_fum_rec',    // fumble recovered
  'PD':  'idp_pass_def',
  'SF':  'idp_safe',
  '#IR': 'idp_def_td',     // interception return TD
  '#FR': 'idp_def_td',     // fumble return TD
  '#DR': 'idp_def_td',     // defensive return TD
};

// Unwrap MFL's BadgerFish JSON ({"$t": "value"}) — TYPE=rules wraps text nodes,
// while flat attribute exports (players/franchises) do not. Safe on both.
function _mflText(v) {
  return (v && typeof v === 'object' && '$t' in v) ? v.$t : v;
}

// Parse an MFL points formula into a per-unit multiplier:
//   "*2.5" → 2.5  |  "3/.5" → 6 (3 pts per 0.5 units)  |  "=4"/"4" → 4
function _parseMflPoints(formula) {
  const f = String(_mflText(formula) ?? '').trim();
  if (!f) return 0;
  if (f[0] === '*' || f[0] === '=') return parseFloat(f.slice(1)) || 0;
  if (f.includes('/')) {
    const [pts, units] = f.split('/').map(s => parseFloat(s));
    return units ? pts / units : (pts || 0);
  }
  return parseFloat(f) || 0;
}

// Detects position groups that field defenders, so IDP multipliers are averaged
// only across real IDP groups (offensive groups list IDP events as filler).
const _MFL_IDP_POS = /(^|\|)(DL|DE|DT|EDGE|NT|LB|OLB|ILB|MLB|CB|S|SS|FS|DB)(\||$)/i;

// MFL player status → Sleeper-style slot classification
// ROSTER = normal, INJURED_RESERVE = IR, TAXI_SQUAD = taxi
const MFL_ROSTER_STATUS = {
  'ROSTER':           'active',
  'INJURED_RESERVE':  'ir',
  'TAXI_SQUAD':       'taxi',
  'PRACTICE_SQUAD':   'taxi',
};

// MFL NFL team abbreviations are mostly identical to Sleeper's;
// map the few that differ
const MFL_TEAM_MAP = {
  'ARZ': 'ARI',
  'BLT': 'BAL',
  'CLV': 'CLE',
  'HST': 'HOU',
  'KCC': 'KC',
  'NOS': 'NO',
  'NEP': 'NE',
  'NWE': 'NE',
  'NYG': 'NYG',
  'NYJ': 'NYJ',
  'SFO': 'SF',
  'TBB': 'TB',
  'GBP': 'GB',
  'SLC': 'LAR',
  'RAM': 'LAR',
  'SDC': 'LAC',
  'OAK': 'LV',
  'LVR': 'LV',
  'JAX': 'JAC',
  'FA':  'FA',
};

function _normTeam(t) {
  if (!t) return 'FA';
  const u = t.toUpperCase();
  return MFL_TEAM_MAP[u] || u;
}

// ── Crosswalk cache ───────────────────────────────────────────────
let _crosswalk = null;
let _crosswalkYear = null;

// ── Fetch helpers ─────────────────────────────────────────────────

// Every transport and assembled response belongs to its initiating app account,
// connection and selected view. Client checks establish consistency only.
const MFL_BOUNDARY_KEYS = ['fw_session_v1', 'od_session_v1', 'od_auth_v1', 'wr_guest_v1',
  'mfl_league_id', 'mfl_year', 'mfl_franchise_id', 'mfl_api_key', 'mfl_connection_owner_v1'];
const MFL_TAB_KEYS = ['mfl_api_key', 'mfl_api_key_context_v1', 'mfl_guest_owner_v1'];
let _mflEpoch = 0;
window.addEventListener?.('storage', event => {
  if (!event.key || MFL_BOUNDARY_KEYS.includes(event.key) || event.key.startsWith('mfl_connection_v2:') || event.key.startsWith('mfl_creds_') || /^sb-.*-auth-token/.test(event.key)) _mflEpoch++;
});
function _mflSelection(leagueId, year) {
  const id = String(leagueId ?? '').trim().replace(/#.*$/, '');
  const season = String(year ?? '').trim();
  if (!/^\d+$/.test(id) || !/[1-9]/.test(id) || !/^(19|20|21)\d{2}$/.test(season)) throw new Error('Select the exact MFL league ID and season before loading it.');
  return { id, year: season, key: 'mfl_' + id + '_' + season };
}
function _mflContext(leagueKey, options = {}) {
  const owner = _mflOwner();
  const keys = [...MFL_BOUNDARY_KEYS, ...(leagueKey ? ['mfl_creds_' + leagueKey, _mflOwnedKey(owner, leagueKey)] : []), _mflPointerKey(owner)];
  const read = () => [...keys.map(key => localStorage.getItem(key)), ...MFL_TAB_KEYS.map(key => sessionStorage.getItem(key))];
  let values, observedToken, token;
  try {
    values = read(); observedToken = window.OD?.getSessionToken?.() || null; token = observedToken;
    if (values[0] !== null) {
      const record = JSON.parse(values[0]), parts = String(record?.token || '').split('.');
      const claims = JSON.parse(window.atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (parts.length !== 3 || typeof record.user?.id !== 'string' || !record.user.id || claims.sub !== record.user.id
          || claims.app_metadata?.user_id !== record.user.id || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()
          || (observedToken && observedToken !== record.token)) throw new Error('identity');
      token = record.token;
    }
  } catch (_) { throw new Error('Your app session is incomplete or unavailable. Sign in again before loading MFL.'); }
  const epoch = _mflEpoch;
  let active = true;
  const scope = { token, signature: JSON.stringify([values, observedToken]),
    timeoutMs: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 20000) : 20000,
    assertCurrent() {
      try {
        if (!active || epoch !== _mflEpoch || !read().every((value, i) => value === values[i])
            || (window.OD?.getSessionToken?.() || null) !== observedToken
            || (typeof options.isCurrent === 'function' && !options.isCurrent())) throw new Error('changed');
      } catch (_) { active = false; throw new Error('Your account, MFL connection or selected view changed. Reopen it before continuing.'); }
    },
  };
  scope.assertCurrent();
  return scope;
}
// Stable local ownership is checked separately from request freshness. A new
// session must never adopt old private connector credentials merely by loading.
function _mflOwner(createGuest = false) {
  const modern = localStorage.getItem('fw_session_v1');
  if (modern !== null) {
    try {
      const record = JSON.parse(modern), parts = String(record?.token || '').split('.');
      const claims = JSON.parse(window.atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      const token = window.OD?.getSessionToken?.();
      if (parts.length !== 3 || typeof record.user?.id !== 'string' || !record.user.id || claims.sub !== record.user.id
          || claims.app_metadata?.user_id !== record.user.id || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()
          || (token && token !== record.token)) throw new Error('invalid');
      return 'app:' + record.user.id;
    } catch (_) { throw new Error('Your app session is incomplete or unavailable. Sign in again before loading MFL.'); }
  }
  const token = window.OD?.getSessionToken?.();
  if (token) {
    try {
      const parts = String(token).split('.');
      const claims = JSON.parse(window.atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (parts.length !== 3 || typeof claims.sub !== 'string' || !claims.sub || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()
          || (claims.app_metadata?.user_id && claims.app_metadata.user_id !== claims.sub)) throw new Error('invalid');
      return claims.app_metadata?.user_id ? 'app:' + claims.app_metadata.user_id : 'legacy:' + claims.sub;
    } catch (_) { throw new Error('Your app session is incomplete. Sign in again before loading MFL.'); }
  }
  let guest = sessionStorage.getItem('mfl_guest_owner_v1');
  if (!guest && createGuest) {
    guest = window.crypto.randomUUID();
    sessionStorage.setItem('mfl_guest_owner_v1', guest);
    if (sessionStorage.getItem('mfl_guest_owner_v1') !== guest) throw new Error('The guest MFL connection could not be saved.');
  }
  return guest ? 'guest:' + guest : null;
}
function _mflOwnedKey(owner, leagueKey) { return 'mfl_creds_v2:' + encodeURIComponent(owner || '') + ':' + leagueKey; }
function _mflPointerKey(owner) { return 'mfl_connection_v2:' + encodeURIComponent(owner || ''); }
function _mflRequireOwner(owner) {
  const current = _mflOwner();
  if (!current || !owner || owner !== current) throw new Error('This saved MFL connection belongs to another or unknown account. Reconnect it for the current account.');
  return current;
}
const _mflRawContexts = new WeakMap();
const _mflList = value => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : null;
function _mflIdentity(part, selected) {
  if (!part || typeof part !== 'object' || Array.isArray(part) || part.error) throw new Error('MFL did not return complete league data.');
  for (const field of ['leagueId', 'league_id', 'leagueID']) if (part[field] != null && String(part[field]) !== selected.id) throw new Error('MFL returned another league.');
  for (const field of ['year', 'season', 'seasonId']) if (part[field] != null && String(part[field]) !== selected.year) throw new Error('MFL returned another season.');
}
function _validateMflPlayers(data) {
  const list = _mflList(data?.players?.player);
  if (data?.error || !list?.length || list.some(player => !/^\d+$/.test(String(player?.id ?? ''))
      || typeof player.name !== 'string' || !player.name.trim() || typeof player.position !== 'string' || !player.position.trim())
      || new Set(list.map(player => String(player.id))).size !== list.length) throw new Error('MFL did not return a complete player directory. Retry loading this season.');
  return data;
}
function _validateMflRaw(raw, leagueId, year) {
  const selected = _mflSelection(leagueId, year), provenance = raw && _mflRawContexts.get(raw);
  if (provenance) {
    provenance.scope.assertCurrent();
    if (provenance.key !== selected.key) throw new Error('MFL data does not match the selected league and season.');
  }
  const lg = raw?.leagueData?.league, rosters = raw?.rostersData?.rosters;
  _mflIdentity(lg, selected); _mflIdentity(rosters, selected);
  if (lg.id != null && String(lg.id) !== selected.id) throw new Error('MFL returned another league.');
  const franchises = _mflList(lg.franchises?.franchise), rosterRows = _mflList(rosters.franchise);
  const positions = _mflList(lg.starters?.position);
  if (typeof lg.name !== 'string' || !lg.name.trim() || !franchises?.length || !rosterRows || !positions?.length
      || !Number.isInteger(Number(lg.rosterSize ?? lg.roster_size)) || Number(lg.rosterSize ?? lg.roster_size) <= 0
      || positions.some(row => typeof row?.name !== 'string' || !row.name.trim() || !/^\d+(?:-\d+)?$/.test(String(row.count ?? row.limit ?? '')))
      || !positions.some(row => Number.parseInt(row.count ?? row.limit, 10) > 0)
      || franchises.some(row => !/^\d+$/.test(String(row?.id ?? '')))
      || new Set(franchises.map(row => String(row.id))).size !== franchises.length
      || (lg.franchises?.count != null && Number(lg.franchises.count) !== franchises.length)) throw new Error('MFL did not return complete league settings and franchises.');
  const ids = new Set(franchises.map(row => String(row.id)));
  if (rosterRows.length !== ids.size || new Set(rosterRows.map(row => String(row?.id))).size !== ids.size
      || rosterRows.some(row => !ids.has(String(row?.id)) || (row.player != null && !_mflList(row.player)))) throw new Error('MFL did not return every franchise roster.');
  _validateMflPlayers(raw.playersData);
  const players = new Set(_mflList(raw.playersData.players.player).map(player => String(player.id)));
  if (rosterRows.some(row => (_mflList(row.player) || []).some(player => !players.has(String(player?.id))))) throw new Error('MFL returned incomplete roster player data.');
  _mflIdentity(raw.rulesData?.rules, selected);
  if (!Object.keys(mapMFLSettings(raw.leagueData, selected.id, selected.year, raw.rulesData).scoring_settings).length) throw new Error('MFL scoring rules are missing or unsupported. Retry loading the league.');
  return raw;
}

function _mflUrl(year, type, leagueId, apiKey, extra) {
  // Strip URL fragments (#) and whitespace from league ID
  const cleanId = String(leagueId).replace(/#.*$/, '').trim();
  let url = `${MFL_BASE}/${year}/export?TYPE=${type}&L=${cleanId}&JSON=1`;
  if (apiKey) url += '&APIKEY=' + encodeURIComponent(apiKey);
  if (extra) url += '&' + extra;
  return url;
}

// ── MFL proxy via Supabase Edge Function ─────────────────────────
// MFL blocks all cross-origin browser requests (no CORS headers).
// Route through our own Edge Function which relays server-side.
function _getProxyUrl() {
  const config = window.App?.CONFIG || window.OD?.CONFIG || {};
  if (config.endpoints?.mflProxy) return config.endpoints.mflProxy;
  if (config.functionsBase) return config.functionsBase + '/mfl-proxy';
  const base = window.OD?.SUPABASE_URL || window.App?.SUPABASE_URL;
  return base ? base + '/functions/v1/mfl-proxy' : null;
}

async function _mflGet(url, requestContext) {
  const scope = requestContext || _mflContext();
  scope.assertCurrent();
  const proxyUrl = _getProxyUrl();
  const anonKey = window.App?.CONFIG?.supabaseAnon || window.OD?.CONFIG?.supabaseAnon || window.OD?.SUPABASE_ANON || window.App?.SUPABASE_ANON;
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(proxyUrl && anonKey ? proxyUrl : url, proxyUrl && anonKey ? {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (scope.token || anonKey), apikey: anonKey },
          body: JSON.stringify({ url }), signal: controller.signal,
        } : { signal: controller.signal });
        scope.assertCurrent();
        const data = await res.json();
        scope.assertCurrent();
        if (!res.ok || data?.error) throw new Error(typeof data?.error === 'string' ? data.error : 'MFL request failed (' + res.status + '). Check league access and retry.');
        return data;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('MFL took too long to respond. Retry loading this league.')); }, scope.timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// ── MFL players-universe cache ───────────────────────────────────
// TYPE=players&DETAILS=1 is MFL's entire NFL player universe (~900KB) and is
// identical for every league in a given year — yet it was re-fetched on every
// league open, and twice per open (app-mount rehydrate + LeagueDetail hydrate),
// all routed through the Supabase proxy. That ~1MB round-trip dominated MFL load
// time. Cache it per year in IndexedDB behind a short-lived in-memory layer so
// the big payload is pulled at most once per TTL. Mirrors sleeper-api's player
// DB cache; degrades to a plain refetch if IDB is unavailable. Named uniquely
// (not WrIDB / _sleeperIDB) to avoid a global collision when all three load in
// the same script scope.
const _mflIDB = (() => {
  const DB_NAME = 'reconai-mfl', STORE = 'kv';
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
  };
})();

const _MFL_PLAYERS_TTL = 12 * 60 * 60 * 1000; // 12h — the player universe barely moves intraday
const _mflPlayersMem = {};      // year → { data, ts }
const _mflPlayersInflight = {}; // year + initiating context → Promise

// Fetch the global MFL player universe for a year, served from cache when warm.
// The export is league-independent, so we drop L= and key the cache by year
// only — one entry is reused across every league (and every reopen).
async function _fetchPlayersCached(year, scope) {
  scope.assertCurrent();
  const mem = _mflPlayersMem[year];
  if (mem && Date.now() - mem.ts < _MFL_PLAYERS_TTL) return _validateMflPlayers(mem.data);
  const inflightKey = JSON.stringify([year, scope.signature]);
  if (_mflPlayersInflight[inflightKey]) return _mflPlayersInflight[inflightKey];
  const cacheKey = 'mfl_players_' + year;
  _mflPlayersInflight[inflightKey] = (async () => {
    try {
      const cached = await _mflIDB.get(cacheKey);
      scope.assertCurrent();
      if (cached && cached.data && Date.now() - cached.ts < _MFL_PLAYERS_TTL) {
        _validateMflPlayers(cached.data);
        _mflPlayersMem[year] = { data: cached.data, ts: cached.ts };
        return cached.data;
      }
    } catch (e) { /* IDB unavailable — fall through to refetch */ }
    scope.assertCurrent();
    const url = `${MFL_BASE}/${year}/export?TYPE=players&DETAILS=1&JSON=1`;
    const data = _validateMflPlayers(await _mflGet(url, scope));
    scope.assertCurrent();
    _mflPlayersMem[year] = { data, ts: Date.now() };
    // Fire-and-forget persist — never block returning data on the write.
    _mflIDB.set(cacheKey, { data, ts: Date.now() }).catch(() => {});
    return data;
  })();
  try { return await _mflPlayersInflight[inflightKey]; }
  finally { delete _mflPlayersInflight[inflightKey]; }
}

/**
 * Fetch all data needed to populate window.S.
 * Returns { leagueData, rostersData, playersData }
 *
 * Deduped per (leagueId, year): the app-mount MFL rehydrate and the subsequent
 * LeagueDetail hydrate used to each issue a full 5-call fetch seconds apart. We
 * stash the assembled payload so the second caller reuses it (see _getStashedRaw,
 * 5-min TTL) instead of re-hitting the proxy for league/rosters/rules/draft.
 */
async function fetchLeague(leagueId, year, apiKey, options) {
  const selected = _mflSelection(leagueId, year);
  leagueId = selected.id; year = selected.year;
  const scope = options?.assertCurrent ? options : _mflContext(selected.key, options);
  scope.assertCurrent();
  const stashed = _getStashedRaw(leagueId, year, apiKey, scope);
  if (stashed) return stashed;
  const [leagueData, rostersData, playersData, rulesData, draftResultsData] = await Promise.all([
    _mflGet(_mflUrl(year, 'league', leagueId, apiKey), scope),
    _mflGet(_mflUrl(year, 'rosters', leagueId, apiKey), scope),
    _fetchPlayersCached(year, scope),
    _mflGet(_mflUrl(year, 'rules', leagueId, apiKey), scope),
    _mflGet(_mflUrl(year, 'draftResults', leagueId, apiKey), scope).catch(() => { scope.assertCurrent(); return null; }),
  ]);
  scope.assertCurrent();
  const raw = _validateMflRaw({ leagueData, rostersData, playersData, rulesData, draftResultsData }, leagueId, year);
  _mflRawContexts.set(raw, { key: selected.key, scope });
  _stashRaw(leagueId, year, raw, apiKey);
  return raw;
}

// ── Data mappers ──────────────────────────────────────────────────

/**
 * Parse MFL player name "LastName, FirstName" → { full_name, first_name, last_name }
 */
function _parseMFLName(nameStr) {
  const parts = (nameStr || '').split(',').map(s => s.trim());
  if (parts.length >= 2) {
    return {
      full_name: parts[1] + ' ' + parts[0],
      first_name: parts[1],
      last_name: parts[0],
    };
  }
  return { full_name: nameStr || '', first_name: '', last_name: nameStr || '' };
}

/**
 * Map an MFL player entry → Sleeper-compatible player object.
 * player_id is set to 'mfl_{id}' initially; crosswalk resolves to Sleeper ID later.
 */
function mapMFLPlayer(p) {
  if (!p || !p.id) return null;
  const { full_name, first_name, last_name } = _parseMFLName(p.name);
  const team = _normTeam(p.team);
  // MFL flags the current rookie class with status 'R' (every draft_year===this
  // year player carries it). Surface a clean boolean + draft capital so rookie
  // detection and rookie boards work without re-deriving from names.
  const isRookie = String(p.status || '').toUpperCase() === 'R';
  return {
    player_id: 'mfl_' + p.id,
    _mfl_id: p.id,
    full_name,
    first_name,
    last_name,
    position: (p.position || '').toUpperCase(),
    team,
    age: parseInt(p.age) || 0,
    years_exp: p.draft_year ? (new Date().getFullYear() - parseInt(p.draft_year)) : 0,
    injury_status: p.injury_status || '',
    draft_year: p.draft_year ? parseInt(p.draft_year) : null,
    college: p.college || '',
    rookie: isRookie,
    // NFL draft capital (present on rookie-class records) — handy for boards.
    nfl_draft_round: p.draft_round || '',
    nfl_draft_pick: p.draft_pick || '',
  };
}

/**
 * Map an MFL franchise + its roster entries → Sleeper-compatible roster object.
 * crosswalk: Map<mflId, sleeperId>
 */
function mapMFLRoster(franchise, rosterEntries, crosswalk) {
  const players = [];
  const starters = [];
  const reserve = [];
  const taxi = [];
  // Exact per-franchise Sleeper-pid → MFL-id map. The global crosswalk reverse
  // can collapse collisions to the wrong owner; this preserves the id THIS
  // franchise actually rosters, for the lineup-write path (submitLineup).
  const mflPlayerIds = {};

  (rosterEntries || []).forEach(entry => {
    const mflId = entry.id;
    if (!mflId) return;
    const pid = (crosswalk && crosswalk[mflId]) ? crosswalk[mflId] : 'mfl_' + mflId;
    players.push(pid);
    mflPlayerIds[pid] = String(mflId);
    const status = (entry.status || 'ROSTER').toUpperCase();
    if (status === 'INJURED_RESERVE') {
      reserve.push(pid);
    } else if (status === 'TAXI_SQUAD' || status === 'PRACTICE_SQUAD') {
      taxi.push(pid);
    }
    // ROSTER players are in players[] — no separate starters list for MFL (no lineup data in rosters export)
  });

  return {
    roster_id: franchise.id,
    owner_id: franchise.id, // MFL uses franchise ID as owner identifier
    players,
    starters: [], // MFL doesn't expose lineup decisions in the rosters export
    reserve,
    taxi,
    settings: {
      wins: parseInt(franchise.h2hw || 0),
      losses: parseInt(franchise.h2hl || 0),
      ties: parseInt(franchise.h2ht || 0),
      fpts: parseFloat(franchise.pf || 0),
      fpts_decimal: 0,
      fpts_against: parseFloat(franchise.pa || 0),
      fpts_against_decimal: 0,
    },
    _owner_name: franchise.owner_name || franchise.name || ('Team ' + franchise.id),
    _team_name: franchise.name || ('Team ' + franchise.id),
    _team_abbrev: franchise.abbrev || '',
    _mflPlayerIds: mflPlayerIds,
  };
}

/**
 * Map MFL league export → Sleeper-compatible league settings object.
 */
function mapMFLSettings(leagueRaw, leagueId, year, rulesRaw) {
  const lg = leagueRaw?.league || {};

  // ── Scoring settings ──
  // MFL scoring comes from the TYPE=rules export (position-specific rules), NOT
  // the league export. Collapse to Sleeper's flat scoring_settings: offensive
  // values are consistent across position groups (first wins); IDP values vary
  // by position, so average them across the defensive groups only. Offense is
  // masked by FantasyCalc when this is empty, but IDP has no fallback — which is
  // why broken scoring here showed up as "IDP scores not populating".
  const scoring_settings = {};
  const idpAccum = {}; // key → { sum, n }
  let prGroups = rulesRaw?.rules?.positionRules || [];
  if (!Array.isArray(prGroups)) prGroups = [prGroups];
  prGroups.forEach(group => {
    if (!group) return;
    const isIdpGroup = _MFL_IDP_POS.test(String(_mflText(group.positions) || ''));
    let ruleArr = group.rule || [];
    if (!Array.isArray(ruleArr)) ruleArr = [ruleArr];
    ruleArr.forEach(r => {
      const code = String(_mflText(r && r.event) || '').trim();
      const key = MFL_EVENT_MAP[code];
      if (!key) return;
      const mult = _parseMflPoints(r && r.points);
      if (!mult) return;
      if (key.startsWith('idp_')) {
        if (!isIdpGroup) return; // skip filler IDP rules listed on offensive groups
        const a = idpAccum[key] || (idpAccum[key] = { sum: 0, n: 0 });
        a.sum += mult; a.n += 1;
      } else if (scoring_settings[key] === undefined) {
        scoring_settings[key] = mult;
      }
    });
  });
  Object.entries(idpAccum).forEach(([key, a]) => {
    if (a.n) scoring_settings[key] = +(a.sum / a.n).toFixed(3);
  });
  // Ensure negatives for turnovers
  if (scoring_settings.pass_int > 0) scoring_settings.pass_int = -scoring_settings.pass_int;
  if (scoring_settings.fum_lost > 0) scoring_settings.fum_lost = -scoring_settings.fum_lost;

  // ── Roster positions ──
  const roster_positions = [];
  const positions = lg.starters?.position || [];
  const posArr = Array.isArray(positions) ? positions : [positions];
  posArr.forEach(pos => {
    const name = (pos.name || '').toUpperCase();
    const count = parseInt(pos.count || 1);
    for (let i = 0; i < count; i++) roster_positions.push(name);
  });

  // ── Bench slots ──
  const rosterSize = parseInt(lg.rosterSize || lg.roster_size || 20);
  const starterCount = posArr.reduce((acc, p) => acc + parseInt(p.count || 1), 0);
  const benchCount = Math.max(0, rosterSize - starterCount);
  for (let i = 0; i < benchCount; i++) roster_positions.push('BN');

  const franchises = _getFranchiseArr(leagueRaw);

  // ── Multi-copy leagues ──
  // MFL "rostersPerPlayer" = how many franchises may roster the SAME NFL player
  // (e.g. 3 in a 3-copy league); playerLimitUnit scopes it (LEAGUE-wide here).
  // Surfaced as settings.player_copies so availability logic can compute
  // remaining = copies - rosteredCount. Defaults to 1 (single-copy ⇒ no-op for
  // every other platform).
  const playerCopies = Math.max(1, parseInt(lg.rostersPerPlayer || lg.rosters_per_player || 1) || 1);

  // ── League type ──
  // Dynasty-first default, detection-first posture: MFL's TYPE=league export
  // has no explicit dynasty value, and its keeperType vocabulary is unverified
  // against a real payload — a live dynasty league may report 'keeper' (or
  // 'none' with the module off), so deriving settings.type from it here could
  // silently re-type real leagues and shift value calibration. The raw field
  // rides along as _mflKeeperType below; flip to a derived type only after
  // verifying the owner's MLS TYPE=league payload. Until then the per-league
  // override (intelligence-context.js setLeagueTypeOverride) is the correction
  // seam for mis-typed MFL leagues.

  return {
    league_id: 'mfl_' + leagueId + '_' + year,
    name: lg.name || ('MFL League ' + leagueId),
    total_rosters: franchises.length || parseInt(lg.franchises?.count || 12),
    season: String(year),
    status: 'in_season', // overwritten by mapToSleeperState from the draft state
    settings: { type: 2, player_copies: playerCopies },
    scoring_settings,
    roster_positions,
    avatar: null,
    _source: 'mfl',
    _mfl_id: String(leagueId),
    // ── Draft-lifecycle fields (from TYPE=league) used to classify the draft
    // and render scheduled/clock UI. Dropped on the floor before. ──
    _mflPlayerLimitUnit: lg.playerLimitUnit || lg.player_limit_unit || 'LEAGUE',
    _mflDraftPlayerPool: lg.draftPlayerPool || '',
    _mflDraftTimer: lg.draftTimer || '',
    _mflDraftLimitHours: lg.draftLimitHours || '',
    _mflDraftKind: lg.draft_kind || '',
    _mflLockout: lg.lockout || '',
    _mflKeeperType: lg.keeperType || lg.keeper_type || '',
  };
}

function _getFranchiseArr(leagueRaw) {
  const f = leagueRaw?.league?.franchises?.franchise || [];
  return Array.isArray(f) ? f : [f];
}

// ── Player crosswalk ──────────────────────────────────────────────

function _normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build MFL playerId → Sleeper playerId crosswalk.
 * Matches by normalized full name + NFL team abbreviation.
 * Result cached in localStorage per year.
 */
function buildCrosswalk(sleeperPlayers, mflPlayers, year) {
  const cacheKey = 'mfl_crosswalk_' + year;

  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const cached = JSON.parse(raw);
      if (Date.now() - (cached._ts || 0) < 24 * 60 * 60 * 1000) {
        _crosswalk = cached.map;
        _crosswalkYear = year;
        return cached.map;
      }
    }
  } catch (e) {}

  // Build Sleeper name+team index
  const nameTeamIndex = {};
  const nameOnlyIndex = {};

  Object.entries(sleeperPlayers || {}).forEach(([sid, p]) => {
    const name = _normalizeName(p.full_name || (p.first_name + ' ' + p.last_name));
    if (!name) return;
    const team = (p.team || 'FA').toUpperCase();
    nameTeamIndex[name + '|' + team] = sid;
    if (!nameOnlyIndex[name]) nameOnlyIndex[name] = [];
    nameOnlyIndex[name].push(sid);
  });

  // Match MFL players → Sleeper IDs
  const map = {};
  (mflPlayers || []).forEach(p => {
    if (!p || !p.id) return;
    const { full_name } = _parseMFLName(p.name);
    const name = _normalizeName(full_name);
    const team = _normTeam(p.team).toUpperCase();

    let sleeperPid = nameTeamIndex[name + '|' + team];
    if (!sleeperPid && nameOnlyIndex[name]) {
      sleeperPid = nameOnlyIndex[name][0];
    }
    if (sleeperPid) map[p.id] = sleeperPid;
  });

  // Skip caching empty maps — callers sometimes pass an empty sleeperPlayers
  // dict (e.g., War Room's handleMFLConnect before LeagueDetail loads the DB).
  // Caching that would poison the cache for 24h and prevent rebuild against
  // the real Sleeper DB. Only persist maps that actually resolved at least
  // one player.
  try {
    if (Object.keys(map).length > 0) {
      localStorage.setItem(cacheKey, JSON.stringify({ map, _ts: Date.now() }));
    }
  } catch (e) {}

  _crosswalk = map;
  _crosswalkYear = year;
  return map;
}

function lookupSleeperPlayerId(mflId) {
  if (_crosswalk && _crosswalk[mflId]) return _crosswalk[mflId];
  return 'mfl_' + mflId;
}

// ── Transactions ─────────────────────────────────────────────────

/**
 * Fetch MFL transactions and map to Sleeper-compatible format.
 * MFL TYPE=transactions returns trades, adds, drops, IR moves.
 */
async function fetchTransactions(leagueId, year, apiKey, options) {
  const selected = _mflSelection(leagueId, year);
  leagueId = selected.id; year = selected.year;
  const scope = options?.assertCurrent ? options : _mflContext(selected.key, options);
  try {
    const data = await _mflGet(_mflUrl(year, 'transactions', leagueId, apiKey), scope);
    const txnArr = data?.transactions?.transaction || [];
    const txns = Array.isArray(txnArr) ? txnArr : [txnArr];
    const cw = scope.crosswalk || (String(_crosswalkYear) === String(year) ? _crosswalk : null) || {};

    // Helper: parse comma-separated items, skip picks (FP_*, DP_*), resolve player IDs
    function _parseItems(str) {
      return (str || '').split(',').map(s => s.trim()).filter(s => s && !s.startsWith('FP_') && !s.startsWith('DP_'));
    }
    function _parsePicks(str) {
      return (str || '').split(',').map(s => s.trim()).filter(s => s.startsWith('FP_') || s.startsWith('DP_'));
    }

    return txns.filter(t => t && t.type).map(t => {
      const type = (t.type || '').toUpperCase();
      const ts = parseInt(t.timestamp || 0) * 1000;

      if (type === 'TRADE') {
        // MFL trade format: franchise1_gave_up / franchise2_gave_up
        // Items are comma-separated: player IDs, FP_fran_year_round (future picks), DP_unit_pick (draft picks)
        const rids = [t.franchise, t.franchise2].filter(Boolean);
        const adds = {};
        const drops = {};
        // What franchise1 gave up → franchise2 acquired
        _parseItems(t.franchise1_gave_up).forEach(pid => {
          const sid = cw[pid] || ('mfl_' + pid);
          adds[sid] = t.franchise2; drops[sid] = t.franchise;
        });
        // What franchise2 gave up → franchise1 acquired
        _parseItems(t.franchise2_gave_up).forEach(pid => {
          const sid = cw[pid] || ('mfl_' + pid);
          adds[sid] = t.franchise; drops[sid] = t.franchise2;
        });
        // Collect pick info for metadata
        const picks = [..._parsePicks(t.franchise1_gave_up), ..._parsePicks(t.franchise2_gave_up)];
        return { type: 'trade', status: 'complete', created: ts, roster_ids: rids, adds, drops, _picks: picks, _source: 'mfl' };
      }

      if (type === 'FREE_AGENT' || type === 'BBID_WAIVER' || type === 'WAIVER') {
        // MFL FA format: transaction field is "|pid1,pid2,pid3," (pipe-delimited, comma-separated player IDs)
        const adds = {};
        const raw = (t.transaction || '').replace(/^\|/, '');
        raw.split(',').map(s => s.trim()).filter(Boolean).forEach(pid => {
          const sid = cw[pid] || ('mfl_' + pid);
          adds[sid] = t.franchise;
        });
        return { type: type === 'BBID_WAIVER' ? 'waiver' : 'free_agent', status: 'complete', created: ts, adds, drops: {}, _source: 'mfl' };
      }

      return { type: type.toLowerCase(), status: 'complete', created: ts, _source: 'mfl' };
    }).filter(t => t.type === 'trade' || t.type === 'free_agent' || t.type === 'waiver');
  } catch (e) {
    scope.assertCurrent();
    console.warn('[MFL] Transaction fetch error:', e);
    return [];
  }
}

/**
 * Fetch MFL draft results and map to Sleeper-compatible format.
 * Handles large drafts (100+ picks for mega-leagues).
 */
async function fetchDraftResults(leagueId, year, apiKey, options) {
  const selected = _mflSelection(leagueId, year);
  leagueId = selected.id; year = selected.year;
  const scope = options?.assertCurrent ? options : _mflContext(selected.key, options);
  try {
    const data = await _mflGet(_mflUrl(year, 'draftResults', leagueId, apiKey), scope);
    const units = data?.draftResults?.draftUnit;
    if (!units) return [];
    const unitArr = Array.isArray(units) ? units : [units];
    const cw = scope.crosswalk || (String(_crosswalkYear) === String(year) ? _crosswalk : null) || {};
    const allPicks = [];

    unitArr.forEach(unit => {
      const picks = unit?.draftPick || [];
      const pickArr = Array.isArray(picks) ? picks : [picks];
      pickArr.forEach(pick => {
        if (!pick || !pick.player) return;
        const sid = cw[pick.player] || ('mfl_' + pick.player);
        const [rd, pk] = (pick.pick || '').split('.');
        allPicks.push({
          player_id: sid,
          picked_by: pick.franchise,
          round: parseInt(rd) || 1,
          pick_no: parseInt(pk) || 1,
          overall: allPicks.length + 1,
          timestamp: parseInt(pick.timestamp || 0) * 1000,
          _source: 'mfl',
        });
      });
    });

    return allPicks;
  } catch (e) {
    scope.assertCurrent();
    console.warn('[MFL] Draft results fetch error:', e);
    return [];
  }
}

/**
 * Map an MFL TYPE=draftResults payload → an array of Sleeper-draft-shaped
 * objects with an INFERRED status. MFL has no explicit status flag, but the
 * draftResults export seeds every slot (franchise + round + pick) up front and
 * fills `player`/`timestamp` as picks land — so:
 *   0 picks filled            → 'pre_draft'  (scheduled / waiting room)
 *   some filled, some empty    → 'drafting'   (on the clock = first empty slot)
 *   all filled                → 'complete'
 * `picks` holds MADE picks only (Sleeper semantics); the full seeded board is on
 * `_slots` for rendering an upcoming/pre-draft board.
 */
function mapDraftStatus(draftResultsRaw, leagueId, year, league, crosswalk) {
  const cw = crosswalk || (String(_crosswalkYear) === String(year) ? _crosswalk : null) || {};
  const units = draftResultsRaw?.draftResults?.draftUnit;
  if (!units) return [];
  const unitArr = Array.isArray(units) ? units : [units];
  const isRookiePool = String(league?._mflDraftPlayerPool || '').toLowerCase().includes('rookie');

  return unitArr.map((unit, ui) => {
    const picksRaw = unit?.draftPick || [];
    const pickArr = Array.isArray(picksRaw) ? picksRaw : (picksRaw ? [picksRaw] : []);

    // ── Pass 1: parse rounds + within-round slots ──
    // MFL's `pick` attribute is the WITHIN-ROUND slot (1..teams), NOT a global
    // index. We need the round count + team count before we can assign a unique
    // GLOBAL pick_no, which the live-sync reconciler keys on.
    let maxRound = 0;
    let lastTs = 0;
    const franchiseSet = new Set();
    const parsed = pickArr.map((pick, i) => {
      const rd = parseInt(pick.round) || 1;
      const pir = parseInt(pick.pick) || 0; // pick within round (1..teams)
      if (rd > maxRound) maxRound = rd;
      if (pick.franchise) franchiseSet.add(pick.franchise);
      const hasPlayer = !!(pick.player && String(pick.player).trim());
      const ts = parseInt(pick.timestamp || 0) * 1000;
      if (ts > lastTs) lastTs = ts;
      return { rd, pir, idx: i, franchise: pick.franchise || '', player: pick.player || '', hasPlayer, comments: pick.comments || '' };
    });
    const total = parsed.length;

    // Team count = picks-per-round (slots / rounds). round1DraftOrder UNDERCOUNTS
    // when picks are traded (one franchise can hold several round-1 slots, another
    // none — round1DraftOrder is positional, so unique ids < teams).
    const teams = (maxRound && total)
      ? Math.round(total / maxRound)
      : (franchiseSet.size || league?.total_rosters || 0);

    // ── Pass 2: assign a GLOBAL overall pick_no = (round-1)*teams + slot ──
    // → strictly increasing 1..total across all rounds, which is the contract the
    // live-sync reconciler/reducer require (within-round pick_no would collide every
    // round and jam the mirror). The within-round value is kept on draft_slot.
    const slots = parsed.map(p => {
      const overall = (teams && p.pir) ? ((p.rd - 1) * teams + p.pir) : (p.idx + 1);
      return {
        round: p.rd,
        pick_no: overall,
        draft_slot: p.pir || ((p.idx % (teams || 1)) + 1),
        roster_id: p.franchise || null,
        picked_by: p.franchise || '',
        player_id: p.hasPlayer ? (cw[p.player] || ('mfl_' + p.player)) : '',
        _mfl_player: p.player,
        _traded: /traded/i.test(p.comments),
      };
    }).sort((a, b) => a.pick_no - b.pick_no);

    const made = slots.filter(s => s.player_id);
    const status = made.length === 0
      ? 'pre_draft'
      : (made.length >= total ? 'complete' : 'drafting');

    // draft_order keyed by franchise id (= the owner_id/user_id MFL rosters use),
    // so command-center's slotToRoster (rosters.find owner_id === key) resolves.
    const draft_order = {};
    const slot_to_roster_id = {};
    String(unit?.round1DraftOrder || '').split(',').map(s => s.trim()).filter(Boolean).forEach((fid, idx) => {
      draft_order[fid] = idx + 1;
      slot_to_roster_id[idx + 1] = fid;
    });
    const onClock = slots.find(s => !s.player_id) || null;

    return {
      draft_id: 'mfl_draft_' + leagueId + '_' + year + (ui ? '_' + ui : ''),
      league_id: 'mfl_' + leagueId + '_' + year,
      status,
      type: String(unit?.draftType || '').toUpperCase() === 'SAME' ? 'linear' : 'snake',
      season: String(year),
      start_time: null, // MFL exposes a per-pick clock (draftLimitHours), not an absolute start
      created: lastTs || null,
      last_picked: lastTs || null,
      settings: {
        rounds: maxRound || (total && teams ? Math.round(total / teams) : 0),
        teams,
        player_type: isRookiePool ? 1 : 0,
      },
      metadata: {
        name: (league?._mflDraftPlayerPool || 'MFL') + ' Draft',
        description: league?._mflDraftPlayerPool || '',
        player_type: isRookiePool ? '1' : '0',
      },
      draft_order,
      slot_to_roster_id,
      picks: made,
      _slots: slots,
      // These dimensions describe this payload, not independently configured
      // board coverage. Consumers must not use them to certify completeness.
      _dimensionsInferred: true,
      on_the_clock: onClock ? onClock.roster_id : null,
      _source: 'mfl',
    };
  });
}

/**
 * Fetch + map the live draft state. Used by the live-draft poller to re-pull
 * status as picks land. `league`/`crosswalk` are optional (pool-type detection
 * + id resolution); falls back to the cached crosswalk.
 */
async function fetchDraftStatus(leagueId, year, apiKey, league, crosswalk, options) {
  const selected = _mflSelection(leagueId, year);
  leagueId = selected.id; year = selected.year;
  const scope = options?.assertCurrent ? options : _mflContext(selected.key, options);
  try {
    const data = await _mflGet(_mflUrl(year, 'draftResults', leagueId, apiKey), scope);
    return mapDraftStatus(data, leagueId, year, league, crosswalk) || [];
  } catch (e) {
    scope.assertCurrent();
    console.warn('[MFL] Draft status fetch error:', e);
    return [];
  }
}

// ── Future draft picks (authoritative pick ownership) ─────────────
// TYPE=futureDraftPicks lists, per franchise, the future picks it CURRENTLY owns
// with the pick's round/year and `originalPickFor` (the franchise it started with).
// This is the real, post-trade pick-ownership source — far better than inferring
// from trade transactions (which don't say which round/season/pick moved).
async function fetchFutureDraftPicks(leagueId, year, apiKey, options) {
  const selected = _mflSelection(leagueId, year);
  leagueId = selected.id; year = selected.year;
  const scope = options?.assertCurrent ? options : _mflContext(selected.key, options);
  try {
    return await _mflGet(_mflUrl(year, 'futureDraftPicks', leagueId, apiKey), scope);
  } catch (e) {
    scope.assertCurrent();
    console.warn('[MFL] futureDraftPicks fetch error:', e);
    return null;
  }
}

/**
 * Map a TYPE=futureDraftPicks payload → Sleeper-shaped tradedPicks DELTAS that
 * the Trade Center's buildPicksByOwner consumes: { season, round, roster_id (the
 * pick's ORIGINAL owner), owner_id (the current owner), previous_owner_id }.
 * Only emits a delta for picks that actually changed hands (originalPickFor !==
 * current owner) — a franchise's own picks are covered by the base seed.
 * MFL franchise ids double as roster_id AND owner_id in the mapped state, so the
 * Trade Center resolves them in either id-mode.
 */
function mapTradedPicks(futureRaw) {
  const out = [];
  const fr = futureRaw?.futureDraftPicks?.franchise;
  if (!fr) return out;
  const franchises = Array.isArray(fr) ? fr : [fr];
  franchises.forEach(f => {
    if (!f || !f.id) return;
    const owner = String(f.id);
    let picks = f.futureDraftPick || [];
    if (!Array.isArray(picks)) picks = picks ? [picks] : [];
    picks.forEach(p => {
      if (!p) return;
      const origin = String(p.originalPickFor || owner);
      if (origin === owner) return; // own pick — base ownership already covers it
      const season = parseInt(p.year, 10);
      const round = parseInt(p.round, 10) || 1;
      if (!season) return;
      out.push({
        season,
        round,
        roster_id: origin,        // pick's original owner
        owner_id: owner,          // current owner (post-trade)
        previous_owner_id: origin,
        _source: 'mfl',
      });
    });
  });
  return out;
}

/**
 * Map a TYPE=futureDraftPicks payload → COMPLETE per-owner future pick ownership:
 *   { [ownerFranchiseId]: [ { season, round, roster_id (original owner) } ] }
 * Unlike mapTradedPicks (which only emits the picks that MOVED, as deltas), this
 * lists EVERY future pick each franchise currently owns. The Trade Center uses it
 * to render the exact set of future picks that exist — real years, real rounds,
 * real ownership — instead of inventing a fixed N rounds × every team. If the
 * league has no future picks defined, this is empty and the UI shows none.
 */
function mapFuturePicksByOwner(futureRaw) {
  const out = {};
  const fr = futureRaw?.futureDraftPicks?.franchise;
  if (!fr) return out;
  const franchises = Array.isArray(fr) ? fr : [fr];
  franchises.forEach(f => {
    if (!f || !f.id) return;
    const owner = String(f.id);
    let picks = f.futureDraftPick || [];
    if (!Array.isArray(picks)) picks = picks ? [picks] : [];
    picks.forEach(p => {
      if (!p) return;
      const season = parseInt(p.year, 10);
      const round = parseInt(p.round, 10) || 1;
      if (!season) return;
      (out[owner] = out[owner] || []).push({ season, round, roster_id: String(p.originalPickFor || owner) });
    });
  });
  return out;
}

// ── Full state population ─────────────────────────────────────────

/**
 * Map raw MFL API responses → { players, rosters, league, leagueUsers, drafts }.
 */
function mapToSleeperState(raw, leagueId, year, crosswalk) {
  _validateMflRaw(raw, leagueId, year);
  const cw = crosswalk || (_crosswalkYear === String(year) || _crosswalkYear === Number(year) ? _crosswalk : null) || {};
  const { leagueData, rostersData, playersData, rulesData, draftResultsData } = raw;

  // ── League settings ──
  const league = mapMFLSettings(leagueData, leagueId, year, rulesData);

  // ── Franchises (owners) ──
  const franchises = _getFranchiseArr(leagueData);
  const leagueUsers = franchises.map(f => ({
    user_id: f.id,
    display_name: f.owner_name || f.name || ('Team ' + f.id),
    username: (f.owner_name || f.name || '').toLowerCase().replace(/\s+/g, '_'),
    avatar: null,
    metadata: {},
  }));

  // Build franchise id → standings lookup from rosters endpoint
  const standingsMap = {};
  const rosterFranchises = rostersData?.rosters?.franchise || [];
  const rosterArr = Array.isArray(rosterFranchises) ? rosterFranchises : [rosterFranchises];

  // Franchise standings come from the league endpoint franchises
  franchises.forEach(f => {
    standingsMap[f.id] = f;
  });

  // ── Players + Rosters ──
  const players = {};

  // Build MFL player lookup from players export
  const mflPlayerLookup = {};
  const mflPlayerArr = playersData?.players?.player || [];
  const allMflPlayers = Array.isArray(mflPlayerArr) ? mflPlayerArr : [mflPlayerArr];
  allMflPlayers.forEach(p => {
    if (p && p.id) mflPlayerLookup[p.id] = p;
  });

  // Add all MFL players to the players dict
  allMflPlayers.forEach(p => {
    if (!p || !p.id) return;
    const sleeperPid = cw[p.id] || ('mfl_' + p.id);
    if (!players[sleeperPid]) {
      const mapped = mapMFLPlayer(p);
      if (mapped) {
        mapped.player_id = sleeperPid;
        players[sleeperPid] = mapped;
      }
    }
  });

  // Map rosters
  const rosters = rosterArr.map(rf => {
    const franchise = standingsMap[rf.id] || { id: rf.id, name: 'Team ' + rf.id };
    const rosterEntries = Array.isArray(rf.player) ? rf.player : (rf.player ? [rf.player] : []);
    return mapMFLRoster(franchise, rosterEntries, cw);
  });

  // ── Copy availability ──
  // In a multi-copy league the SAME pid legitimately sits on several franchises.
  // Count each pid across ALL rosters (active + taxi + reserve — each consumes a
  // copy) so consumers can compute remaining = copies - rosterCount instead of a
  // gone-on-first-roster boolean. copies===1 makes this a transparent no-op.
  const copies = Math.max(1, Number(league?.settings?.player_copies) || 1);
  const rosterCount = {};
  rosters.forEach(r => {
    // taxi[] / reserve[] entries are ALSO in players[] (mapMFLRoster pushes every
    // entry into players[] and additionally into taxi/reserve). Dedupe per franchise
    // so a taxi/IR stash counts as ONE copy, not two.
    new Set([].concat(r.players || [], r.taxi || [], r.reserve || []).map(String)).forEach(k => {
      rosterCount[k] = (rosterCount[k] || 0) + 1;
    });
  });
  league._availability = { copies, rosterCount };

  // ── Drafts + draft-driven league status ──
  // mapDraftStatus infers pre_draft|drafting|complete from the seeded board.
  // Reflect a pending/active rookie draft into league.status so the FA rookie
  // lock (rookiesLockedForWaivers) engages even if the draft object is missed.
  const drafts = mapDraftStatus(draftResultsData, leagueId, year, league, cw);
  const liveDraft = drafts.find(d => d.status === 'drafting')
    || drafts.find(d => d.status === 'pre_draft');
  if (liveDraft && (liveDraft.status === 'pre_draft' || liveDraft.status === 'drafting')) {
    league.status = liveDraft.status;
  }

  return { players, rosters, league, leagueUsers, drafts };
}

// ── Main connect function ─────────────────────────────────────────

/**
 * Connect to an MFL league and populate window.S.
 * Returns { players, rosters, league, leagueUsers } after populating state.
 *
 * @param {string|number} leagueId       MFL league ID
 * @param {number}        year           Season year (e.g. 2024)
 * @param {string}        apiKey         Optional: MFL API key for private leagues
 * @param {string}        myFranchiseId  Optional: franchise ID (e.g. "0001") for current user
 */
async function connectLeague(leagueId, year, apiKey, myFranchiseId, options = {}) {
  const S = window.S || window.App?.S;
  if (!S) throw new Error('window.S not initialized');
  const selected = _mflSelection(leagueId, year), activeLeague = S.currentLeagueId;
  const isCurrent = () => S.currentLeagueId === activeLeague && (typeof options.isCurrent !== 'function' || options.isCurrent());
  const scope = _mflContext(selected.key, { ...options, isCurrent });
  const raw = await fetchLeague(selected.id, selected.year, apiKey, scope);
  scope.assertCurrent();
  const crosswalk = buildCrosswalk(S.players || {}, _mflList(raw.playersData.players.player), selected.year);
  scope.crosswalk = crosswalk;
  const mapped = mapToSleeperState(raw, selected.id, selected.year, crosswalk);
  if (myFranchiseId && !mapped.rosters.some(row => String(row.roster_id) === String(myFranchiseId))) throw new Error('The selected MFL franchise is not in this league. Select your team again.');
  const txns = await fetchTransactions(selected.id, selected.year, apiKey, scope);
  scope.assertCurrent();
  const futureRaw = await fetchFutureDraftPicks(selected.id, selected.year, apiKey, scope);
  scope.assertCurrent();
  const transactions = {};
  if (txns.length) transactions.w0 = txns;
  Object.assign(S, { platform: 'mfl', mflLeagueId: selected.id, mflYear: selected.year,
    _mflApiKey: apiKey || null, players: { ...(S.players || {}), ...mapped.players },
    rosters: mapped.rosters, leagueUsers: mapped.leagueUsers, bracket: { w: [], l: [] }, matchups: {},
    season: selected.year, transactions, tradedPicks: mapTradedPicks(futureRaw),
    _mflFuturePicks: futureRaw ? mapFuturePicksByOwner(futureRaw) : null, drafts: mapped.drafts || [],
    leagues: [mapped.league], currentLeagueId: mapped.league.league_id,
    myRosterId: myFranchiseId ? String(myFranchiseId) : null });
  return { ...mapped, raw };
}

// ── PlatformProvider adapter ──────────────────────────────────────
// Implements the unified PlatformProvider interface (see
// shared/platform-provider.js). War Room's LeagueDetail calls
// provider.hydrate() uniformly across all four platforms instead of
// hand-rolled platform branches.

// Per-session cache of raw fetchLeague payloads keyed by leagueId+year
// so that connect() → hydrate() doesn't re-fetch the same data.
const _rawLeagueStash = {};
function _stashRaw(leagueId, year, raw, apiKey) {
  const selected = _mflSelection(leagueId, year);
  _rawLeagueStash[selected.key] = { raw: JSON.stringify(raw), apiKey: apiKey || null, scope: _mflContext(selected.key), ts: Date.now() };
}
function _getStashedRaw(leagueId, year, apiKey, scope) {
  const selected = _mflSelection(leagueId, year), entry = _rawLeagueStash[selected.key];
  if (!entry || entry.apiKey !== (apiKey || null) || entry.scope.signature !== scope.signature || Date.now() - entry.ts > 5 * 60 * 1000) return null;
  try { entry.scope.assertCurrent(); scope.assertCurrent(); } catch (_) { return null; }
  const raw = _validateMflRaw(JSON.parse(entry.raw), selected.id, selected.year);
  _mflRawContexts.set(raw, { key: selected.key, scope });
  return raw;
}

const MflProvider = {
  id: 'mfl',
  displayName: 'MyFantasyLeague',
  capabilities: {
    hasTransactions: true,
    hasDrafts: true,
    hasTradedPicks: true,
    hasMatchups: false,           // MFL rosters export doesn't include lineup data
    hasBracket: false,
    hasYearChain: false,          // same league ID across years, queried directly
    hasFaab: false,               // MFL transactions don't structurally expose FAAB bids
    hasTrending: false,
    hasPlayerStats: false,
    requiresOAuth: false,
    requiresFranchisePicker: true,
  },

  // ── Credentials ─────────────────────────────────────────────────
  saveCredentials(leagueKey, creds) {
    const selected = _mflSelection(creds?.leagueId, creds?.year);
    const owner = _mflOwner(true);
    if (creds._mflOwner && creds._mflOwner !== owner) throw new Error('This MFL connection belongs to another account. Reconnect it before saving.');
    if (creds.franchiseId != null && !/^\d{1,4}$/.test(String(creds.franchiseId))) throw new Error('Select the exact MFL franchise before saving.');
    if (leagueKey !== selected.key) throw new Error('MFL credentials do not match the selected league and season.');
    const safeCreds = { ...creds, leagueId: selected.id, year: selected.year, _mflOwner: owner };
    delete safeCreds.apiKey;
    const updates = [
      [localStorage, _mflOwnedKey(owner, leagueKey), JSON.stringify(safeCreds)],
      [localStorage, _mflPointerKey(owner), selected.key],
      [localStorage, 'mfl_league_id', selected.id], [localStorage, 'mfl_year', selected.year],
      [localStorage, 'mfl_connection_owner_v1', owner],
      [localStorage, 'mfl_franchise_id', creds.franchiseId ? String(creds.franchiseId) : null],
      [sessionStorage, 'mfl_api_key_context_v1', creds.apiKey ? JSON.stringify({ owner, leagueKey }) : null],
      [sessionStorage, 'mfl_api_key', creds.apiKey || null], [localStorage, 'mfl_api_key', null],
    ];
    const before = updates.map(([storage, key]) => storage.getItem(key));
    let attempted = 0;
    try {
      for (const [storage, key, value] of updates) {
        attempted++;
        if (value === null) storage.removeItem(key); else storage.setItem(key, value);
        if (storage.getItem(key) !== value) throw new Error('write failed');
      }
      return true;
    } catch (_) {
      // Synchronous transaction: restore only the keys this call attempted.
      for (let i = attempted - 1; i >= 0; i--) {
        try { const [storage, key] = updates[i]; if (before[i] === null) storage.removeItem(key); else storage.setItem(key, before[i]); } catch (_) { /* report failure; never claim saved */ }
      }
      throw new Error('MFL connection could not be saved on this device. Keep your connection details and retry.');
    }
  },
  loadCredentials(leagueKey) {
    const owner = _mflOwner();
    const raw = localStorage.getItem(_mflOwnedKey(owner, leagueKey)) ?? localStorage.getItem('mfl_creds_' + leagueKey);
    if (raw !== null) {
      let creds;
      try { creds = JSON.parse(raw); } catch (_) { throw new Error('Saved MFL connection is unreadable. Reconnect this league.'); }
      if (!creds || Array.isArray(creds) || typeof creds !== 'object') throw new Error('Saved MFL connection is incomplete. Reconnect this league.');
      _mflRequireOwner(creds._mflOwner);
      const selected = _mflSelection(creds.leagueId, creds.year);
      if (selected.key !== leagueKey) throw new Error('Saved MFL connection does not match this league and season.');
      let keyContext;
      try { keyContext = JSON.parse(sessionStorage.getItem('mfl_api_key_context_v1') || 'null'); } catch (_) { /* unknown keys remain unused */ }
      const keyOwned = keyContext?.owner === creds._mflOwner && keyContext?.leagueKey === selected.key;
      return { ...creds, apiKey: keyOwned ? sessionStorage.getItem('mfl_api_key') || null : null };
    }
    const id = localStorage.getItem('mfl_league_id');
    if (!id) return null;
    _mflRequireOwner(localStorage.getItem('mfl_connection_owner_v1'));
    // New writes always include an owner-bound scoped record. Flat-only legacy
    // data has no reliable owner or key provenance and must not be adopted.
    throw new Error('This older MFL connection needs to be reconnected for the current account.');
  },
  loadConnection() {
    const ownedPointer = localStorage.getItem(_mflPointerKey(_mflOwner()));
    if (ownedPointer) return this.loadCredentials(ownedPointer);
    const id = localStorage.getItem('mfl_league_id');
    if (!id) return null;
    _mflRequireOwner(localStorage.getItem('mfl_connection_owner_v1'));
    const selected = _mflSelection(id, localStorage.getItem('mfl_year'));
    return this.loadCredentials(selected.key);
  },
  currentOwner() { return _mflOwner(); },
  isConnectionCurrent(connection) {
    try { return !!connection && !!connection._mflOwner && connection._mflOwner === _mflOwner(); } catch (_) { return false; }
  },
  clearCredentials(leagueKey) {
    try {
      const owner = _mflOwner();
      localStorage.removeItem(_mflOwnedKey(owner, leagueKey));
      if (localStorage.getItem(_mflPointerKey(owner)) === leagueKey) localStorage.removeItem(_mflPointerKey(owner));
      const legacy = localStorage.getItem('mfl_creds_' + leagueKey);
      try { if (legacy && JSON.parse(legacy)._mflOwner === owner) localStorage.removeItem('mfl_creds_' + leagueKey); } catch (_) { /* preserve unowned unreadable metadata; still clear volatile secrets */ }
      sessionStorage.removeItem('mfl_api_key');
      sessionStorage.removeItem('mfl_api_key_context_v1');
      localStorage.removeItem('mfl_api_key');
    } catch (e) {}
  },

  // ── Phase 1: CONNECT ────────────────────────────────────────────
  async connect(creds, options) {
    const { leagueId, year, apiKey } = creds || {};
    if (!leagueId) throw new Error('MFL league ID required');
    const selected = _mflSelection(leagueId, year || String(new Date().getFullYear()));
    const yr = selected.year, id = selected.id;
    const owner = _mflOwner(true);
    const raw = await fetchLeague(id, yr, apiKey || null, options);
    if (!raw?.leagueData?.league) {
      throw new Error('Invalid MFL league data. Check your League ID and year.');
    }
    // Cache the raw payload so hydrate() can reuse it without re-fetching
    // fetchLeague already saved a validated account/credential-scoped cache.


    const franchises = raw.leagueData.league.franchises?.franchise || [];
    const franchiseArr = Array.isArray(franchises) ? franchises : [franchises];

    return {
      leagues: [{
        id: selected.key,
        name: raw.leagueData.league.name || 'MFL League ' + leagueId,
        season: String(yr),
        _platform: 'mfl',
        _mfl: true,                    // legacy flag for back-compat
        _mflLeagueId: id,
        _platformCreds: { leagueId: id, year: String(yr), apiKey: apiKey || null, _mflOwner: owner },
        _franchises: franchiseArr.map(f => ({
          id: f.id,
          name: f.name || ('Team ' + f.id),
          owner: f.owner_name || '',
        })),
      }],
      needsFranchisePicker: true,
    };
  },

  // ── Phase 2: HYDRATE ────────────────────────────────────────────
  async hydrate(league, ctx) {
    const context = ctx || {};
    const match = /^mfl_(\d+)_(\d{4})$/.exec(String(league.id || league.league_id || ''));
    const selected = _mflSelection(league._mflLeagueId || match?.[1], league.season || match?.[2]);
    if ((match && (match[1] !== selected.id || match[2] !== selected.year))) throw new Error('MFL identifiers do not match the selected league and season.');
    const scope = _mflContext(selected.key, context);
    const creds = league._platformCreds || this.loadCredentials(selected.key) || {};
    if (league._platformCreds) _mflRequireOwner(creds._mflOwner);
    if ((creds.leagueId && _mflSelection(creds.leagueId, selected.year).id !== selected.id)
        || (creds.year && String(creds.year) !== selected.year)) throw new Error('MFL credentials do not match the selected league and season. Reconnect this league.');
    const leagueId = selected.id, year = selected.year, apiKey = creds.apiKey || null;
    const sleeperPlayers = context.sleeperPlayers || {};
    const raw = await fetchLeague(leagueId, year, apiKey, scope);
    scope.assertCurrent();

    const mflPlayerArr = raw.playersData?.players?.player || [];
    const allMflPlayers = Array.isArray(mflPlayerArr) ? mflPlayerArr : [mflPlayerArr];

    // Clear any stale (possibly empty) crosswalk cache and rebuild against the
    // real Sleeper player DB. This is the whole reason connect→hydrate is a
    // two-phase split — at connect time the Sleeper DB isn't loaded yet.
    try { localStorage.removeItem('mfl_crosswalk_' + year); } catch (e) {}
    const crosswalk = buildCrosswalk(sleeperPlayers, allMflPlayers, year);

    scope.crosswalk = crosswalk;
    const mapped = mapToSleeperState(raw, leagueId, year, crosswalk);
    if (league._mflFranchiseId && !mapped.rosters.some(row => String(row.roster_id) === String(league._mflFranchiseId))) throw new Error('The selected MFL franchise is not in this league. Select your team again.');

    // Fetch transactions + future draft picks (non-blocking — a private league
    // without an API key can still render rosters even if these fail). Drafts
    // already came back from mapToSleeperState as status-bearing objects.
    const [txns, futureRaw] = await Promise.all([
      fetchTransactions(leagueId, year, apiKey, scope).catch(e => {
        scope.assertCurrent();
        console.warn('[MFL] transactions fetch failed:', e?.message || e);
        return [];
      }),
      fetchFutureDraftPicks(leagueId, year, apiKey, scope).catch(() => { scope.assertCurrent(); return null; }),
    ]);

    // MFL supplies timestamps but no verified NFL-week classification here.
    // Keep history in w0 rather than claim every historical row happened now.
    scope.assertCurrent();
    const wkKey = 'w0'; // MFL does not supply a verified transaction week here.
    const transactionsByWeek = txns.length ? { [wkKey]: txns } : {};

    // Real, post-trade pick ownership from TYPE=futureDraftPicks — each entry is
    // a pick a franchise currently owns that originally belonged to another team.
    // The Trade Center's buildPicksByOwner reconstructs ownership from these.
    const tradedPicks = mapTradedPicks(futureRaw);

    return {
      league: mapped.league,
      rosters: mapped.rosters,
      leagueUsers: mapped.leagueUsers,
      players: mapped.players || {},
      transactions: transactionsByWeek,
      tradedPicks,
      drafts: mapped.drafts || [],
      matchups: [],
      nflState: {},
      _extras: { mflFuturePicks: mapFuturePicksByOwner(futureRaw) },
    };
  },
};

// Register with the unified platform registry (if loaded)
if (window.App?.Platforms?.register) {
  window.App.Platforms.register(MflProvider);
} else {
  console.warn('[MFL] platform-provider.js not loaded — provider will not be registered');
}

// ── Lineup WRITE (set starters) ──────────────────────────────────
// MFL is the only supported platform with a public lineup-write API. Requires
// the franchise owner's MFL API key (write scope). Sleeper has no equivalent.
//
//   POST /{year}/import?TYPE=lineup&L={league}&W={week}&STARTERS={mflIds}&APIKEY={key}
//
// Params live in the query string so a shard 302 that downgrades POST→GET still
// carries them. Player ids are mapped Sleeper → MFL via the crosswalk.

// Reverse of the mfl→sleeper crosswalk, rebuilt if the crosswalk swaps identity.
let _reverseCw = null, _reverseCwSrc = null;
function _reverseCrosswalk() {
  const cw = _crosswalk || {};
  if (_reverseCw && _reverseCwSrc === cw) return _reverseCw;
  const rev = {};
  for (const mflId in cw) { const sid = cw[mflId]; if (sid != null) rev[String(sid)] = String(mflId); }
  _reverseCw = rev; _reverseCwSrc = cw;
  return rev;
}

// Sleeper player id → MFL player id. Handles crosswalked ids and the
// 'mfl_<id>' passthrough form used when no Sleeper match exists.
function sleeperToMflId(pid) {
  const s = String(pid);
  if (s.startsWith('mfl_')) return s.slice(4);
  return _reverseCrosswalk()[s] || null;
}

function _mflProxyHeaders(scope) {
  const anonKey = window.App?.CONFIG?.supabaseAnon || window.OD?.CONFIG?.supabaseAnon || window.OD?.SUPABASE_ANON || window.App?.SUPABASE_ANON;
  const headers = { 'Content-Type': 'application/json' };
  if (anonKey) { headers.Authorization = 'Bearer ' + (scope.token || anonKey); headers.apikey = anonKey; }
  return { headers, anonKey };
}

// A timeout after a write started has an unknown outcome: never call it a
// confirmed failure or automatically repeat the write.
async function _mflWriteTransport(url, extra, scope) {
  scope.assertCurrent();
  const proxyUrl = _getProxyUrl(), { headers, anonKey } = _mflProxyHeaders(scope);
  if (!proxyUrl || !anonKey) throw new Error('MFL proxy unavailable. Reconnect before continuing.');
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const res = await fetch(proxyUrl, { method: 'POST', headers,
          body: JSON.stringify({ url, ...extra }), signal: controller.signal });
        scope.assertCurrent();
        const text = await res.text();
        scope.assertCurrent();
        let data;
        try { data = JSON.parse(text); } catch (_) { throw new Error('MFL returned an unreadable response. Check MyFantasyLeague before retrying.'); }
        if (!res.ok || data?.error) throw new Error(typeof data?.error === 'string' ? data.error : 'MFL did not confirm this request. Check MyFantasyLeague before retrying.');
        return data;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('MFL did not respond in time. The outcome is unknown; check MyFantasyLeague before retrying.')); }, scope.timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
const _mflLoginScopes = new Map();
function _mflLoginHost(host) {
  if (typeof host !== 'string' || !/^(?:api|www\d*)\.myfantasyleague\.com$/i.test(host)) throw new Error('MFL returned an unsupported login host. Reconnect before submitting a lineup.');
  return host.toLowerCase();
}

// Log in to MFL to obtain a write-scoped session cookie. MFL's lineup import is
// authorized via cookie (not the API key), so this is the auth path for pushing
// lineups. The proxy POSTs the credentials as a form body (password never in a
// URL) and returns the MFL_USER_ID token + the resolved shard host; we keep only
// the cookie, never the raw password.
//   → { cookie: 'MFL_USER_ID=…', host: 'wwwNN.myfantasyleague.com', mflUserId }
async function mflLogin(opts) {
  opts = opts || {};
  const { username, password } = opts;
  const year = String(opts.year || new Date().getFullYear());
  if (!/^(19|20|21)\d{2}$/.test(year)) throw new Error('Select the MFL season before logging in.');
  if (!username || !password) throw new Error('MFL username and password are required.');
  const scope = _mflContext(opts.leagueId ? _mflSelection(opts.leagueId, year).key : null, opts);
  const loginUrl = `${MFL_BASE}/${year}/login?XML=1`;
  const form = 'USERNAME=' + encodeURIComponent(username) + '&PASSWORD=' + encodeURIComponent(password) + '&XML=1';
  const data = await _mflWriteTransport(loginUrl, { login: true, form }, scope);
  scope.assertCurrent();
  if (!data?.ok || typeof data.mflUserId !== 'string' || !data.mflUserId || /[\s;]/.test(data.mflUserId)) throw new Error('MFL did not confirm login. Check your username and password.');
  const host = _mflLoginHost(data.host), cookie = 'MFL_USER_ID=' + data.mflUserId;
  _mflLoginScopes.set(cookie, { scope, year, host });
  return { cookie, host, mflUserId: data.mflUserId };
}

// Submit a starting lineup to MFL.
//   { leagueId, year, week, franchiseId, starterIds (Sleeper ids), mflByPid, apiKey }
// FRANCHISE_ID is sent explicitly (an MFL API key is account-scoped and may own more
// than one franchise, so we must name the target). mflByPid is the franchise's
// own pid→MFL-id map (roster._mflPlayerIds) — preferred over the global crosswalk
// reverse so we submit the exact id THIS franchise rosters.
async function submitLineup(opts) {
  opts = opts || {};
  const { leagueId, year, week, apiKey, franchiseId, mflByPid, cookie, host } = opts;
  const selected = _mflSelection(leagueId, year);
  const scope = _mflContext(selected.key, opts);
  if (!/^\d{1,2}$/.test(String(week)) || Number(week) < 1) throw new Error('Select a valid MFL lineup week.');
  if (!/^\d{1,4}$/.test(String(franchiseId || '')) || !Number(franchiseId)) throw new Error('Select your exact MFL franchise before submitting a lineup.');
  if (!cookie && !apiKey) throw new Error('Connect your MFL login to push lineups (MFL requires a login cookie for lineup changes).');
  if (cookie && !/^MFL_USER_ID=[^\s;]+$/.test(cookie)) throw new Error('Reconnect your MFL login before submitting a lineup.');
  const login = cookie && _mflLoginScopes.get(cookie);
  if (login) {
    login.scope.assertCurrent();
    if (login.year !== selected.year || login.host !== host) throw new Error('The MFL login season or host changed. Reconnect before submitting a lineup.');
  }
  const resolve = pid => (mflByPid && mflByPid[pid]) || (/^mfl_\d+$/.test(String(pid)) ? String(pid).slice(4) : String(_crosswalkYear) === selected.year ? sleeperToMflId(pid) : null);
  const starters = opts.starterIds;
  if (!Array.isArray(starters) || !starters.length) throw new Error('Select your starting lineup before submitting it.');
  const ids = starters.map(resolve);
  if (ids.some(id => !/^\d+$/.test(String(id || ''))) || new Set(ids.map(String)).size !== ids.length) throw new Error('Some starters could not be uniquely matched to MFL players. Check this franchise on MyFantasyLeague.');
  const base = cookie ? ('https://' + _mflLoginHost(host)) : MFL_BASE;
  let url = `${base}/${selected.year}/import?TYPE=lineup&L=${selected.id}&W=${encodeURIComponent(week)}`
    + `&STARTERS=${ids.join(',')}&JSON=1&FRANCHISE_ID=${String(franchiseId).padStart(4, '0')}`;
  if (apiKey && !cookie) url += `&APIKEY=${encodeURIComponent(apiKey)}`;
  const data = await _mflWriteTransport(url, { method: 'POST', ...(cookie ? { cookie } : {}) }, scope);
  scope.assertCurrent();
  // MFL reports hard errors in { error } and the import OUTCOME in { status }.
  // Do NOT treat "no error key" as success — a soft rejection (locked/invalid
  // player, past deadline) returns HTTP 200 with a status message. Require an
  // affirmative confirmation, and surface anything else so we never claim a
  // rejected write succeeded.
  if (data && data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.$t || 'MFL rejected the lineup.'));
  const statusMsg = (data && data.status)
    ? (typeof data.status === 'string' ? data.status : (data.status.$t || ''))
    : ((data && data.raw) ? String(data.raw) : '');
  if (/not\s*(saved|set|submitted|import|allow)|invalid|error|denied|fail|could\s*not|unable|deadline|locked|too\s*late|rejected/i.test(statusMsg)) {
    throw new Error(statusMsg.slice(0, 180) || 'MFL rejected the lineup.');
  }
  if (!/success|imported|saved|updated|accepted|submitted|has been|complete|\bok\b/i.test(statusMsg)) {
    throw new Error('MFL did not confirm the lineup was set — verify on MyFantasyLeague.' + (statusMsg ? ' (' + statusMsg.slice(0, 120) + ')' : ''));
  }
  return data;
}

// ── Expose on window.MFL ──────────────────────────────────────────
window.MFL = {
  BASE_URL: MFL_BASE,
  MFL_EVENT_MAP,
  MFL_TEAM_MAP,

  // Fetch
  fetchLeague,
  fetchTransactions,
  fetchDraftResults,
  fetchDraftStatus,
  fetchFutureDraftPicks,

  // Mappers
  mapMFLPlayer,
  mapMFLRoster,
  mapMFLSettings,
  mapDraftStatus,
  mapTradedPicks,
  mapFuturePicksByOwner,
  mapToSleeperState,

  // Crosswalk
  buildCrosswalk,
  lookupSleeperPlayerId,
  sleeperToMflId,

  // Lineup write (MFL-only)
  mflLogin,
  submitLineup,

  // Main connect (legacy — prefer .provider for new code)
  connectLeague,

  // Unified PlatformProvider interface
  provider: MflProvider,
};

// Expose the current crosswalk via a getter so dhq-providers.js can read
// window.MFL._crosswalk regardless of call order.
Object.defineProperty(window.MFL, '_crosswalk', {
  get: () => _crosswalk,
  configurable: true,
});

})();

// ── Module global exports (Vite migration) ───────────────────────────────────
window.MFLProvider = window.MFL.provider;
window.mflBuildCrosswalk = window.MFL.buildCrosswalk;
window.mflLookupSleeperPlayerId = window.MFL.lookupSleeperPlayerId;
window.mflMapToSleeperState = window.MFL.mapToSleeperState;
