// ══════════════════════════════════════════════════════════════════
// shared/yahoo-api.js — Yahoo Fantasy Football connector
// Fetches Yahoo league data via OAuth 2.0 and maps it to Sleeper-
// equivalent format so all existing ReconAI/WarRoom features work.
//
// window.Yahoo exposes:
//   startAuth()                → redirects to Yahoo OAuth consent screen
//   handleCallback()           → completes callback using same-tab browser proof
//   apiRequest(endpoint)       → authenticated Yahoo API request via proxy
//   fetchUserLeagues()         → all NFL leagues for the authenticated user
//   fetchLeague(leagueKey)     → league settings + teams
//   fetchRosters(leagueKey)    → all team rosters (batch)
//   fetchTransactions(leagueKey) → trade history
//   mapYahooPlayer(p)          → Sleeper format
//   mapYahooRoster(team, cw)   → Sleeper format
//   mapYahooSettings(...)      → Sleeper format with scoring mapped
//   mapYahooTrade(tx)          → Sleeper format
//   buildCrosswalk(sleeperPlayers, yahooPlayers, year) → Yahoo ID → Sleeper ID
//   connectLeague(leagueKey, teamKey) → populates window.S
// ══════════════════════════════════════════════════════════════════

window.App = window.App || {};

(function () {
'use strict';

const YAHOO_BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';
const CONFIG = window.App?.CONFIG || window.OD?.CONFIG || {};
const FUNCTIONS_BASE = CONFIG.functionsBase || 'https://sxshiqyxhhifvtfqawbq.supabase.co/functions/v1';
const PROXY_URL = CONFIG.endpoints?.yahooProxy || `${FUNCTIONS_BASE}/yahoo-proxy`;
const SUPABASE_ANON = CONFIG.supabaseAnon
  || window.OD?.SUPABASE_ANON
  || window.App?.SUPABASE_ANON
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN4c2hpcXl4aGhpZnZ0ZnFhd2JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MTExMzAsImV4cCI6MjA4ODI4NzEzMH0.zJi9W986ZLaANiZN6pt6ReFwaQU6yPeidsERIWo2ibI';

// ── Yahoo numeric stat ID → Sleeper scoring key ───────────────────
// Source: Yahoo Fantasy API stat IDs (community-verified)
const YAHOO_STAT_MAP = {
  4:  'pass_yd',        // Passing yards
  5:  'pass_td',        // Passing touchdowns
  6:  'pass_int',       // Interceptions thrown
  8:  'rec_yd',         // Receiving yards
  9:  'rec_td',         // Receiving touchdowns
  12: 'rec',            // Receptions (PPR)
  18: 'fum_lost',       // Fumbles lost (negative)
  24: 'rush_yd',        // Rushing yards
  25: 'rush_td',        // Rushing touchdowns
  19: 'bonus_2pt_off',  // 2-point conversions
  // IDP
  45: 'idp_solo',   76: 'idp_sack',
  46: 'idp_ast',    77: 'idp_int',
  78: 'idp_fum_rec', 80: 'idp_def_td',
  82: 'idp_safe',   83: 'idp_pass_def',
};

// Yahoo roster position string → Sleeper roster position string
const YAHOO_POS_MAP = {
  'QB':      'QB',
  'WR':      'WR',
  'RB':      'RB',
  'TE':      'TE',
  'K':       'K',
  'DEF':     'DEF',
  'W/R':     'FLEX',   // WR/RB flex
  'W/R/T':   'FLEX',   // WR/RB/TE flex
  'W/T':     'FLEX',
  'W/R/T/Q': 'OP',     // Superflex / OP
  'Q/W/R/T': 'OP',
  'BN':      'BN',
  'IR':      'IR',
};

// Yahoo NFL team abbreviations that differ from Sleeper
const YAHOO_TEAM_MAP = {
  'LA':  'LAR',
  'OAK': 'LV',
  'LVR': 'LV',
  'JAX': 'JAC',
  'WAS': 'WSH',
};

function _normTeam(abbr) {
  if (!abbr) return 'FA';
  const u = abbr.toUpperCase();
  return YAHOO_TEAM_MAP[u] || u;
}

// ── Crosswalk cache ───────────────────────────────────────────────
let _crosswalk = null;
let _crosswalkYear = null;

// ── Session management ────────────────────────────────────────────
function _getSessionId() {
  return sessionStorage.getItem('yahoo_session_id') || localStorage.getItem('yahoo_session_id') || '';
}

function _setSessionId(id) {
  sessionStorage.setItem('yahoo_session_id', id);
  try { localStorage.removeItem('yahoo_session_id'); } catch (e) {}
}

// ── Proxy helper ──────────────────────────────────────────────────
const FLOW_VERSION = 'browser-verifier-v2';
const PENDING_KEY = 'dhq_yahoo_pending_v2';
let _authPending = false;
let _identityEpoch = 0;
window.addEventListener('storage', event => {
  if (!event.key || ['fw_session_v1', 'od_session_v1'].includes(event.key)) _identityEpoch++;
});
function _captureIdentity() {
  try {
    const token = window.OD?.getSessionToken?.();
    if (!token) return null;
    const claims = JSON.parse(window.atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const meta = claims.app_metadata || {};
    let ownerKey, sessionVersion = null;
    if (meta.user_id || meta.session_version || /^[0-9a-f-]{36}$/i.test(claims.sub || '')) {
      if (typeof meta.user_id !== 'string' || meta.user_id !== claims.sub || !Number.isInteger(meta.session_version) || meta.session_version < 1) return null;
      const cached = JSON.parse(localStorage.getItem('fw_session_v1') || 'null');
      if (cached?.user?.id !== meta.user_id || cached.token !== token) return null;
      ownerKey = 'app:' + meta.user_id; sessionVersion = meta.session_version;
    } else {
      const name = meta.sleeper_username || claims.sleeper_username;
      if (typeof name !== 'string' || !name.trim()) return null;
      ownerKey = 'sleeper:' + name.toLowerCase();
    }
    return { token, ownerKey, sessionVersion, epoch: _identityEpoch };
  } catch { return null; }
}
function _sameIdentity(context) {
  const now = _captureIdentity();
  return !!context && !!now && now.token === context.token && now.ownerKey === context.ownerKey && now.epoch === context.epoch;
}
async function _proxyPost(body, context) {
  const token = context?.token || window.OD?.getSessionToken?.();
  if (context && !_sameIdentity(context)) throw new Error('Your account changed. Start Yahoo connection again.');
  const controller = new AbortController();
  let timer;
  try {
    // Bound body parsing as well as fetch. Never replay consumed OAuth codes.
    return await Promise.race([(async () => {
      const res = await fetch(PROXY_URL, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || SUPABASE_ANON}`, apikey: SUPABASE_ANON },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (context && !_sameIdentity(context)) throw new Error('Your account changed. Start Yahoo connection again.');
      if (!res.ok) throw new Error(data.auth_required ? 'Sign in again before connecting Yahoo.' : data.error || 'Yahoo proxy error ' + res.status);
      return data;
    })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Yahoo connection was not confirmed. Start a new connection from this tab.')); }, 20000); })]);
  } finally { clearTimeout(timer); }
}
function _randomProof() {
  return Array.from(window.crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function _proofHash(value) {
  return Array.from(new Uint8Array(await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function _savePending(value) {
  const raw = JSON.stringify(value);
  try { sessionStorage.setItem(PENDING_KEY, raw); if (sessionStorage.getItem(PENDING_KEY) !== raw) throw new Error('not saved'); }
  catch { throw new Error('This browser could not save connection recovery. Enable storage for this site, then try again.'); }
}
function _clearPending() { try { sessionStorage.removeItem(PENDING_KEY); } catch { /* A consumed server state cannot be replayed. */ } }

// ── Auth ──────────────────────────────────────────────────────────
async function startAuth() {
  if (_authPending) throw new Error('A Yahoo connection is already starting.');
  const context = _captureIdentity();
  if (!context) throw new Error('Sign in again before connecting Yahoo.');
  _authPending = true;
  try {
    const returnUrl = new URL(window.location.href);
    returnUrl.searchParams.delete('yahoo_session');
    const verifier = _randomProof();
    const pending = { ownerKey: context.ownerKey, sessionVersion: context.sessionVersion, returnUrl: returnUrl.href, verifier, createdAt: Date.now() };
    _savePending(pending); // Prove storage works before any server or provider request.
    const challenge = await _proofHash(verifier);
    const data = await _proxyPost({ action: 'auth_url', flow_version: FLOW_VERSION, browser_challenge: challenge, return_url: pending.returnUrl }, context);
    if (!_sameIdentity(context)) throw new Error('Your account changed. Start Yahoo connection again.');
    const authUrl = new URL(data.auth_url);
    if (data.flow_version !== FLOW_VERSION || !/^[a-f0-9]{64}$/.test(data.state || '') || authUrl.origin !== 'https://api.login.yahoo.com' || authUrl.pathname !== '/oauth2/request_auth' || authUrl.searchParams.get('state') !== data.state || authUrl.username || authUrl.password) {
      throw new Error('Yahoo connection needs the updated app and service. Refresh and try again.');
    }
    _savePending({ ...pending, state: data.state });
    window.location.href = authUrl.href;
  } catch (error) { _clearPending(); throw error; }
  finally { _authPending = false; }
}
function hasCallback() { return !!window.__DHQ_YAHOO_CALLBACK; }

// The app's first inline head script captures the callback fragment and removes
// it before any other script, image or stylesheet. It never persists the code.
async function handleCallback() {
  if (_authPending) throw new Error('Yahoo connection is already being checked.');
  const callback = window.__DHQ_YAHOO_CALLBACK;
  delete window.__DHQ_YAHOO_CALLBACK;
  if (!callback || callback.error === 'legacy_restart') throw new Error('This Yahoo connection needs to be restarted from the updated app.');
  const context = _captureIdentity();
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); } catch { /* Visible retry below. */ }
  if (!context || !pending || pending.state !== callback.state || pending.ownerKey !== context.ownerKey || pending.sessionVersion !== context.sessionVersion ||
      !/^[a-f0-9]{64}$/.test(pending.verifier || '') || !Number.isFinite(pending.createdAt) || Date.now() - pending.createdAt > 600000 || pending.createdAt > Date.now()) {
    throw new Error('Return to the tab and account that started Yahoo connection, or start a new connection here.');
  }
  const destination = new URL(pending.returnUrl), here = new URL(window.location.href);
  if (destination.origin !== here.origin || destination.pathname !== here.pathname || destination.search !== here.search) throw new Error('Return to the app page that started Yahoo connection.');
  window.history.replaceState(null, '', destination.href);
  if (callback.error || typeof callback.code !== 'string' || !callback.code) { _clearPending(); throw new Error('Yahoo connection was not approved. You can start again.'); }
  _authPending = true;
  // Any uncertain acknowledgement needs a fresh flow; do not replay provider codes.
  _clearPending();
  try {
    const data = await _proxyPost({ action: 'complete_auth', flow_version: FLOW_VERSION, state: pending.state, browser_verifier: pending.verifier, code: callback.code, return_url: pending.returnUrl }, context);
    if (!_sameIdentity(context)) throw new Error('Your account changed. Start Yahoo connection again.');
    if (data.flow_version !== FLOW_VERSION || typeof data.session_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(data.session_id)) throw new Error('Yahoo connection was not confirmed. Start again.');
    try { _setSessionId(data.session_id); if (_getSessionId() !== data.session_id) throw new Error('not saved'); }
    catch { throw new Error('Yahoo connection could not be saved in this browser. Enable storage, then connect again.'); }
    return data.session_id;
  } finally { _authPending = false; }
}

// One private-data journey keeps its app identity, provider session, and optional
// caller selection throughout every request, cache lookup, and state publish.
function _connectionContext(options = {}) {
  const identity = _captureIdentity();
  const sessionId = _getSessionId();
  if (!identity || !sessionId) throw new Error('Sign in and reconnect Yahoo before continuing.');
  const scope = { ...identity, sessionId,
    assertCurrent() {
      if (!_sameIdentity(scope) || _getSessionId() !== sessionId ||
          (typeof options.isCurrent === 'function' && !options.isCurrent())) {
        const error = new Error('Your account or Yahoo connection changed. Reload before continuing.');
        error.code = 'YAHOO_CONTEXT_CHANGED';
        throw error;
      }
    },
  };
  scope.assertCurrent();
  return scope;
}

// ── API request ───────────────────────────────────────────────────

/**
 * Makes an authenticated Yahoo Fantasy API request through the proxy.
 * Appends ?format=json so Yahoo returns JSON instead of XML.
 */
async function apiRequest(endpoint, scope = _connectionContext()) {
  scope.assertCurrent();
  const sessionId = scope.sessionId;
  const sep = endpoint.includes('?') ? '&' : '?';
  const data = await _proxyPost({
    action:     'api',
    endpoint:   endpoint + sep + 'format=json',
    session_id: sessionId,
  }, scope);
  scope.assertCurrent();
  return data;
}

function _dataMismatch(message) {
  const error = new Error('Yahoo data could not be confirmed for this league: ' + message);
  error.code = 'YAHOO_DATA_MISMATCH';
  return error;
}
function _checkedLeagueKey(value) {
  if (typeof value !== 'string' || !/^(?:\d+|nfl)\.l\.\d+$/.test(value)) throw _dataMismatch('invalid league key. Reconnect the selected league.');
  return value;
}
function _checkedSeason(value) {
  if (!/^\d{4}$/.test(String(value || '')) || Number(value) < 1900) throw _dataMismatch('season is missing or invalid.');
  return String(value);
}
async function _resolvedLeagueKey(value, scope, season) {
  _checkedLeagueKey(value);
  if (!value.startsWith('nfl.l.')) return value;
  if (!scope.nflGame) {
    const raw = await apiRequest('/game/nfl', scope);
    const meta = _yahooMeta(raw?.fantasy_content?.game);
    if (!meta || meta.code !== 'nfl' || !/^\d+$/.test(String(meta.game_key || ''))) throw _dataMismatch('Yahoo could not confirm the NFL game for this alias.');
    scope.nflGame = { key: String(meta.game_key), season: _checkedSeason(meta.season) };
  }
  scope.assertCurrent();
  if (season != null && scope.nflGame.season !== _checkedSeason(season)) throw _dataMismatch('NFL alias belongs to a different season. Use the selected season’s league key.');
  return scope.nflGame.key + value.slice(3);
}
function _selectedLeague(league, context) {
  const keys = [league?._platformCreds?.leagueKey, league?._yahooLeagueKey, league?._yahoo_key];
  for (const field of ['id', 'league_id']) {
    if (league?.[field] != null) {
      if (typeof league[field] !== 'string' || !league[field].startsWith('yahoo_')) throw _dataMismatch('selected league identity is invalid.');
      keys.push(league[field].slice(6));
    }
  }
  const present = keys.filter(value => value != null && value !== '').map(_checkedLeagueKey);
  if (!present.length || present.some(value => value !== present[0])) throw _dataMismatch('selected league identifiers disagree. Reconnect it.');
  const seasons = [league?.season, context.currentSeason].filter(value => value != null && value !== '').map(_checkedSeason);
  if (seasons.some(value => value !== seasons[0])) throw _dataMismatch('selected seasons disagree.');
  return { key: present[0], season: seasons[0] };
}
function _leagueReply(raw, key, season) {
  _checkedLeagueKey(key);
  const row = raw?.fantasy_content?.league;
  const meta = _yahooMeta(row), data = _yahooData(row);
  if (!Array.isArray(row) || !meta || typeof meta !== 'object' || Array.isArray(meta) || meta.league_key !== key ||
      !data || typeof data !== 'object' || Array.isArray(data)) throw _dataMismatch('provider league identity or content is missing or different.');
  const actualSeason = _checkedSeason(meta.season);
  if (season != null && actualSeason !== _checkedSeason(season)) throw _dataMismatch('provider season differs from the selected season.');
  return { meta, data, season: actualSeason };
}
function _collectionCount(value) {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return /^\d+$/.test(text) ? Number(text) : NaN;
}
function _resourceMetadata(meta) {
  return Array.isArray(meta) ? Object.assign({}, ...meta.filter(value => value && typeof value === 'object')) : meta;
}
function _settingsObject(value) {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}
function _validateSettings(value) {
  const settings = _settingsObject(value);
  const positions = settings?.roster_positions?.roster_position;
  const modifiers = settings?.stat_modifiers?.stats?.stat;
  if (!settings || Array.isArray(settings) || typeof settings !== 'object' || positions == null || modifiers == null) throw _dataMismatch('scoring or roster settings are incomplete.');
  const rows = Array.isArray(positions) ? positions : [positions];
  let slots = 0;
  for (const row of rows) {
    const count = _collectionCount(row?.count);
    if (typeof row?.position !== 'string' || !row.position.trim() || !Number.isInteger(count) || count > 1000) throw _dataMismatch('roster position settings are incomplete.');
    slots += count;
  }
  if (!slots) throw _dataMismatch('roster position settings are incomplete.');
  const statRows = Array.isArray(modifiers) ? modifiers : [modifiers];
  if (!statRows.length) throw _dataMismatch('scoring modifier settings are incomplete.');
  const seen = new Set();
  for (const stat of statRows) {
    const id = _collectionCount(stat?.stat_id), amount = stat?.value;
    if (!Number.isInteger(id) || seen.has(id) || !['number', 'string'].includes(typeof amount) || String(amount).trim() === '' || !Number.isFinite(Number(amount))) throw _dataMismatch('scoring modifier settings are incomplete.');
    seen.add(id);
  }
}
function _checkedTeamCollection(data, key, count, withRoster) {
  const teams = data.teams;
  if (!teams || _collectionCount(teams.count) !== count || Object.keys(teams).filter(k => /^\d+$/.test(k)).length !== count) throw _dataMismatch('team collection is incomplete.');
  const keys = new Set();
  for (let i = 0; i < count; i++) {
    const row = teams[String(i)]?.team, first = _yahooMeta(row);
    const meta = _resourceMetadata(first);
    if (!Array.isArray(row) || !meta || typeof meta.team_key !== 'string' || !meta.team_key.startsWith(key + '.t.') || !/^\d+$/.test(meta.team_key.slice(key.length + 3)) || keys.has(meta.team_key)) throw _dataMismatch('team identity is missing, duplicated or belongs to another league.');
    if (meta.team_id != null && String(meta.team_id) !== meta.team_key.slice(key.length + 3)) throw _dataMismatch('team key and ID disagree.');
    keys.add(meta.team_key);
    if (withRoster) {
      const roster = _yahooData(row)?.roster;
      const players = (roster?.['0'] || roster)?.players;
      const n = _collectionCount(players?.count);
      if (!players || !Number.isInteger(n) || n < 0 || n > 1000 || Object.keys(players).filter(k => /^\d+$/.test(k)).length !== n || Array.from({ length: n }, (_, j) => players[String(j)]?.player).some(value => !value)) throw _dataMismatch('roster player collection is incomplete.');
      const playerIds = new Set();
      for (let j = 0; j < n; j++) {
        const entry = players[String(j)], meta = _resourceMetadata(_yahooMeta(entry.player));
        const mapped = mapYahooPlayer(entry);
        if (!mapped || !/^\d+$/.test(mapped._yahoo_id || '') || !mapped.full_name.trim() || !mapped.position || playerIds.has(mapped._yahoo_id)) throw _dataMismatch('roster player identity or mapping is incomplete.');
        if (meta?.player_key != null && meta.player_key !== key.split('.l.')[0] + '.p.' + mapped._yahoo_id) throw _dataMismatch('roster player key and identity disagree.');
        playerIds.add(mapped._yahoo_id);
      }
    }
  }
  return keys;
}
function _validatedBundle(leagueData, teamsData, rostersData, key, season) {
  const base = _leagueReply(leagueData, key, season);
  const teams = _leagueReply(teamsData, key, base.season), rosters = _leagueReply(rostersData, key, base.season);
  const count = _collectionCount(base.meta.num_teams), settings = base.data.settings || base.meta.settings;
  if (typeof base.meta.name !== 'string' || !base.meta.name.trim() || !Number.isInteger(count) || count < 1 || count > 1000 || !settings || typeof settings !== 'object' || !Object.keys(settings).length) throw _dataMismatch('league settings or team count are incomplete.');
  _validateSettings(settings);
  const teamKeys = _checkedTeamCollection(teams.data, key, count, false);
  const rosterKeys = _checkedTeamCollection(rosters.data, key, count, true);
  if ([...teamKeys].some(value => !rosterKeys.has(value))) throw _dataMismatch('teams and rosters describe different memberships.');
  return Number(base.season);
}

// ── Fetch helpers ─────────────────────────────────────────────────

/** All NFL leagues for the authenticated Yahoo user. */
async function fetchUserLeagues(scope = _connectionContext()) {
  return apiRequest('/users;use_login=1/games;game_keys=nfl/leagues', scope);
}

/** League settings + all teams (parallel). */
async function fetchLeague(leagueKey, scope = _connectionContext(), season) {
  leagueKey = await _resolvedLeagueKey(leagueKey, scope, season);
  const [leagueData, teamsData] = await Promise.all([
    apiRequest(`/league/${leagueKey}/settings`, scope),
    apiRequest(`/league/${leagueKey}/teams`, scope),
  ]);
  scope.assertCurrent();
  const verified = _leagueReply(leagueData, leagueKey, season);
  _leagueReply(teamsData, leagueKey, verified.season);
  return { leagueData, teamsData };
}

/** All team rosters in one batch request via ;out=roster sub-resource. */
async function fetchRosters(leagueKey, scope = _connectionContext(), season) {
  leagueKey = await _resolvedLeagueKey(leagueKey, scope, season);
  const raw = await apiRequest(`/league/${leagueKey}/teams;out=roster`, scope);
  _leagueReply(raw, leagueKey, season);
  return raw;
}

/** Trade transactions for a league. */
async function fetchTransactions(leagueKey, scope = _connectionContext(), season) {
  leagueKey = await _resolvedLeagueKey(leagueKey, scope, season);
  const raw = await apiRequest(`/league/${leagueKey}/transactions;type=trade`, scope);
  _leagueReply(raw, leagueKey, season);
  return raw;
}

// ── Yahoo JSON parsing helpers ────────────────────────────────────
// Yahoo returns mixed array/object structures. Arrays are represented as
// numeric-keyed objects: { "0": ..., "1": ..., "count": N }
// Resources come back as 2-element arrays: [ metadata, data ]

/**
 * Convert Yahoo's numeric-keyed object to a real array.
 * { "0": a, "1": b, "count": 2 } → [a, b]
 */
function _yahooArr(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const count = parseInt(obj.count || 0);
  const arr = [];
  for (let i = 0; i < count; i++) {
    if (obj[String(i)] !== undefined) arr.push(obj[String(i)]);
  }
  return arr;
}

/** First element of Yahoo's [meta, data] pair — the metadata object. */
function _yahooMeta(twoArr) {
  return Array.isArray(twoArr) ? (twoArr[0] || {}) : (twoArr || {});
}

/** Second element of Yahoo's [meta, data] pair — the resource/data object. */
function _yahooData(twoArr) {
  return Array.isArray(twoArr) ? (twoArr[1] || {}) : {};
}

// ── Data mappers ──────────────────────────────────────────────────

/**
 * Map a Yahoo player entry → Sleeper-compatible player object.
 * Accepts the player entry as returned from the roster endpoint.
 */
function mapYahooPlayer(entry) {
  const pArr  = entry?.player || entry;
  const pMeta = _yahooMeta(pArr);
  // In roster context pMeta is another array: [[field_obj, ...], selected_pos_obj]
  const pInfo = _resourceMetadata(pMeta);
  if (!pInfo) return null;

  const yahooId   = String(pInfo.player_id || pInfo.player_key?.split('.p.').pop() || '');
  const fullName  = pInfo.full_name || pInfo.name?.full || '';
  const nameParts = fullName.split(' ');
  const team      = _normTeam(pInfo.editorial_team_abbr || '');
  // display_position can be "WR,RB" — take first
  const pos = ((pInfo.display_position || pInfo.primary_position || '').split(',')[0]).toUpperCase();

  return {
    player_id:     'yahoo_' + yahooId,
    _yahoo_id:     yahooId,
    full_name:     fullName,
    first_name:    nameParts[0] || '',
    last_name:     nameParts.slice(1).join(' ') || '',
    position:      pos,
    team,
    age:           parseInt(pInfo.age || 0) || 0,
    years_exp:     parseInt(pInfo.experience_years || pInfo.experience || 0) || 0,
    injury_status: pInfo.status || '',
  };
}

/**
 * Map a Yahoo team entry (with embedded roster) → Sleeper-compatible roster object.
 */
function mapYahooRoster(teamEntry, crosswalk) {
  const tArr  = teamEntry?.team || teamEntry;
  const tMeta = _yahooMeta(tArr);
  const tData = _yahooData(tArr);
  const tInfo = _resourceMetadata(tMeta);

  const teamId  = String(tInfo?.team_id || tInfo?.team_key?.split('.t.').pop() || '');
  const teamKey = tInfo?.team_key || '';

  // Manager info
  const mgrs    = tInfo?.managers || [];
  const mgArr   = Array.isArray(mgrs) ? mgrs : [mgrs];
  const mgr     = mgArr[0]?.manager || mgArr[0] || {};
  const ownerName = mgr.nickname || mgr.guid || ('Team ' + teamId);

  // Standings
  const standings = tInfo?.team_standings || {};
  const totals    = standings.outcome_totals || {};

  const players  = [];
  const starters = [];
  const reserve  = [];

  // Roster lives in tData.roster["0"].players
  const rosterObj = tData?.roster || {};
  const rPart     = rosterObj['0'] || rosterObj;
  const rPlayers  = rPart?.players || {};
  const playerArr = _yahooArr(rPlayers);

  playerArr.forEach(pEntry => {
    const pData   = pEntry?.player;
    if (!pData) return;
    const pMeta   = _yahooMeta(pData);
    const pInfo   = _resourceMetadata(pMeta);
    const pSelObj = _yahooData(pData); // { selected_position: [...] }
    const yahooId = String(pInfo?.player_id || pInfo?.player_key?.split('.p.').pop() || '');
    if (!yahooId) return;

    const pid = (crosswalk && crosswalk[yahooId]) ? crosswalk[yahooId] : 'yahoo_' + yahooId;
    players.push(pid);

    const selPosArr = pSelObj?.selected_position || [];
    const selPos    = (Array.isArray(selPosArr) ? selPosArr[0] : selPosArr)?.position || 'BN';
    const slot      = selPos.toUpperCase();

    if (slot === 'IR') {
      reserve.push(pid);
    } else if (slot !== 'BN') {
      starters.push(pid);
    }
  });

  return {
    roster_id:             teamId,
    owner_id:              mgr.guid || teamId,
    players,
    starters,
    reserve,
    taxi:                  [],
    settings: {
      wins:                  parseInt(totals.wins || 0),
      losses:                parseInt(totals.losses || 0),
      ties:                  parseInt(totals.ties || 0),
      fpts:                  parseFloat(standings.points_for || 0),
      fpts_decimal:          0,
      fpts_against:          parseFloat(standings.points_against || 0),
      fpts_against_decimal:  0,
    },
    _owner_name:           ownerName,
    _team_name:            tInfo?.name || ('Team ' + teamId),
    _team_abbrev:          teamKey,
    _yahoo_team_key:       teamKey,
  };
}

/**
 * Map Yahoo league settings response → Sleeper-compatible league settings object.
 */
function mapYahooSettings(leagueData, teamsData, leagueKey, year) {
  const lgArr  = leagueData?.fantasy_content?.league || [];
  const lgMeta = _yahooMeta(lgArr);
  const lgData = _yahooData(lgArr);
  const settings = _settingsObject(lgData?.settings || lgMeta?.settings || {});

  // ── Scoring settings ──
  const scoring_settings = {};
  const statMods = settings?.stat_modifiers?.stats?.stat || [];
  const modArr   = Array.isArray(statMods) ? statMods : [statMods];
  modArr.forEach(mod => {
    if (!mod) return;
    const statId = parseInt(mod.stat_id);
    const key    = YAHOO_STAT_MAP[statId];
    if (key) scoring_settings[key] = parseFloat(mod.value || 0);
  });
  if (scoring_settings.pass_int > 0) scoring_settings.pass_int = -scoring_settings.pass_int;
  if (scoring_settings.fum_lost > 0) scoring_settings.fum_lost = -scoring_settings.fum_lost;

  // ── Roster positions ──
  const roster_positions = [];
  const posSrc = settings?.roster_positions?.roster_position || [];
  const posArr = Array.isArray(posSrc) ? posSrc : [posSrc];
  posArr.forEach(rp => {
    if (!rp) return;
    const posKey = (rp.position || '').toUpperCase();
    const mapped = YAHOO_POS_MAP[posKey] || posKey;
    const count  = parseInt(rp.count == null ? 1 : rp.count);
    for (let i = 0; i < count; i++) roster_positions.push(mapped);
  });

  // ── Team count ──
  const teamsLgArr = teamsData?.fantasy_content?.league || [];
  const teamsD     = _yahooData(Array.isArray(teamsLgArr) ? teamsLgArr : [teamsLgArr]);
  const numTeams   = parseInt(lgMeta?.num_teams || teamsD?.teams?.count || 10);

  const leagueId = (leagueKey || '').split('.l.').pop();

  return {
    league_id:     'yahoo_' + leagueKey,
    name:          lgMeta?.name || ('Yahoo League ' + leagueKey),
    total_rosters: numTeams,
    season:        String(year || lgMeta?.season || new Date().getFullYear()),
    status:        'in_season',
    settings:      { type: 0 },
    scoring_settings,
    roster_positions,
    avatar:        lgMeta?.logo_url || null,
    _source:       'yahoo',
    _yahoo_key:    leagueKey,
    _yahoo_id:     leagueId || leagueKey,
  };
}

/**
 * Map a Yahoo transaction → Sleeper-compatible trade object.
 */
function mapYahooTrade(tx, crosswalk = {}) {
  if (!tx || tx.type !== 'trade' || tx.status !== 'successful') return null;
  const sides = {}, adds = {}, drops = {}, owners = new Set();
  _yahooArr(tx.players || {}).forEach(entry => {
    const meta = _resourceMetadata(_yahooMeta(entry?.player));
    const move = _resourceMetadata(_yahooData(entry?.player)?.transaction_data);
    const yahooId = String(meta?.player_id || meta?.player_key?.split('.p.').pop() || '');
    const from = move?.source_team_key?.split('.t.').pop(), to = move?.destination_team_key?.split('.t.').pop();
    if (!yahooId || !from || !to) return;
    const id = crosswalk[yahooId] || 'yahoo_' + yahooId;
    owners.add(from); owners.add(to);
    sides[from] ||= { players: [], picks: [] };
    sides[to] ||= { players: [], picks: [] };
    sides[to].players.push(id); adds[id] = to; drops[id] = from;
  });
  const timestamp = Number(tx.timestamp) * 1000;
  return { transaction_id: tx.transaction_key, type: 'trade', status: 'complete',
    timestamp, created: timestamp, status_updated: timestamp,
    // Yahoo transaction IDs are not NFL weeks. The documented timestamp does
    // not establish a scoring period; retain unknown week 0, never today's week.
    week: 0, roster_ids: [...owners], adds, drops, sides, _source: 'yahoo' };
}
function _transactionRows(raw, leagueKey, season, crosswalk, rosters) {
  const collection = _leagueReply(raw, leagueKey, season).data.transactions;
  const count = _collectionCount(collection?.count);
  const incomplete = message => new Error('Yahoo did not return a usable completed trade feed: ' + message);
  if (!collection || !Number.isInteger(count) || count > 10000 ||
      Object.keys(collection).filter(key => /^\d+$/.test(key)).length !== count) throw incomplete('transaction collection is incomplete.');
  const owners = new Set(rosters.map(roster => String(roster.roster_id))), keys = new Set(), rows = [];
  let excludedTradeCount = 0;
  const tradePlayers = {};
  for (let i = 0; i < count; i++) {
    const resource = collection[i]?.transaction;
    const tx = { ..._resourceMetadata(_yahooMeta(resource)), ..._yahooData(resource) };
    if (!resource || typeof tx.type !== 'string' || !tx.type.trim() || typeof tx.status !== 'string' || !tx.status.trim()) throw incomplete('transaction type or completion status is missing.');
    if (!['trade', 'pending_trade'].includes(tx.type)) throw incomplete('unexpected transaction type.');
    if (tx.type !== 'trade' || tx.status !== 'successful') { excludedTradeCount++; continue; }
    const key = tx.transaction_key;
    if (typeof key !== 'string' || !key.startsWith(leagueKey + '.tr.')) throw _dataMismatch('trade identity belongs to another league or is missing.');
    if (!/^\d+$/.test(key.slice(leagueKey.length + 4)) || keys.has(key) ||
        (tx.transaction_id != null && String(tx.transaction_id) !== key.slice(leagueKey.length + 4)) ||
        !['number', 'string'].includes(typeof tx.timestamp) || !/^\d+$/.test(String(tx.timestamp)) || !Number.isSafeInteger(Number(tx.timestamp)) || Number(tx.timestamp) <= 0) throw incomplete('trade ID or timestamp is invalid.');
    keys.add(key);
    const players = tx.players, n = _collectionCount(players?.count), seen = new Set(), teams = new Set();
    if (!players || !Number.isInteger(n) || n < 1 || n > 1000 || Object.keys(players).filter(k => /^\d+$/.test(k)).length !== n) throw incomplete('trade players are incomplete.');
    for (let j = 0; j < n; j++) {
      const player = players[j]?.player, meta = _resourceMetadata(_yahooMeta(player));
      const move = _resourceMetadata(_yahooData(player)?.transaction_data);
      const id = String(meta?.player_id || meta?.player_key?.split('.p.').pop() || '');
      if (!/^\d+$/.test(id) || seen.has(id) || !move || move.type !== 'trade') throw incomplete('trade player or movement is missing.');
      if (meta.player_key != null && meta.player_key !== leagueKey.split('.l.')[0] + '.p.' + id) throw _dataMismatch('trade player identity belongs to another game.');
      const from = move.source_team_key, to = move.destination_team_key;
      for (const team of [from, to]) {
        if (typeof team !== 'string' || !team.startsWith(leagueKey + '.t.')) throw _dataMismatch('trade team identity belongs to another league or is missing.');
        const owner = team.slice(leagueKey.length + 3);
        if (!owners.has(owner)) throw incomplete('trade refers to an unconfirmed team.');
        teams.add(owner);
      }
      if (from === to) throw incomplete('trade source and destination are identical.');
      seen.add(id);
      const mappedPlayer = mapYahooPlayer({ player });
      if (mappedPlayer) {
        const mappedId = crosswalk[id] || 'yahoo_' + id;
        tradePlayers[mappedId] = { ...mappedPlayer, player_id: mappedId };
      }
    }
    if (teams.size < 2) throw incomplete('trade sides are incomplete.');
    rows.push(mapYahooTrade(tx, crosswalk));
  }
  return { rows, excludedTradeCount, players: tradePlayers };
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
 * Build Yahoo playerId → Sleeper playerId crosswalk.
 * Matches by normalized full name + NFL team. Cached in localStorage per year.
 */
function buildCrosswalk(sleeperPlayers, yahooPlayers, year) {
  const cacheKey = 'yahoo_crosswalk_' + year;

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

  const nameTeamIndex = {};
  const nameOnlyIndex = {};
  Object.entries(sleeperPlayers || {}).forEach(([sid, p]) => {
    const name = _normalizeName(p.full_name || ((p.first_name || '') + ' ' + (p.last_name || '')));
    if (!name) return;
    const team = (p.team || 'FA').toUpperCase();
    nameTeamIndex[name + '|' + team] = sid;
    if (!nameOnlyIndex[name]) nameOnlyIndex[name] = [];
    nameOnlyIndex[name].push(sid);
  });

  const map = {};
  (yahooPlayers || []).forEach(yp => {
    if (!yp) return;
    const yahooId = String(yp._yahoo_id || yp.player_id || '');
    if (!yahooId) return;
    const name = _normalizeName(yp.full_name);
    const team = (yp.team || 'FA').toUpperCase();

    let sleeperPid = nameTeamIndex[name + '|' + team];
    if (!sleeperPid && nameOnlyIndex[name]) sleeperPid = nameOnlyIndex[name][0];
    if (sleeperPid) map[yahooId] = sleeperPid;
  });

  // Skip caching empty maps — callers sometimes pass an empty sleeperPlayers
  // dict. Caching would poison the cache for 24h and prevent rebuild.
  try {
    if (Object.keys(map).length > 0) {
      localStorage.setItem(cacheKey, JSON.stringify({ map, _ts: Date.now() }));
    }
  } catch (e) {}

  _crosswalk = map;
  _crosswalkYear = year;
  return map;
}

function lookupSleeperPlayerId(yahooId) {
  const id = String(yahooId);
  if (_crosswalk && _crosswalk[id]) return _crosswalk[id];
  return 'yahoo_' + id;
}

// ── Parse user leagues ────────────────────────────────────────────

/**
 * Extract league list from /users;use_login=1/games;.../leagues response.
 * Returns [{ leagueKey, name, numTeams, season }]
 */
function parseUserLeagues(raw) {
  const fc      = raw?.fantasy_content || {};
  const users   = fc.users || {};
  const userArr = _yahooArr(users);
  if (!userArr.length) return [];

  const userEntry = userArr[0]?.user || [];
  const userData  = _yahooData(Array.isArray(userEntry) ? userEntry : [userEntry]);
  const gameArr   = _yahooArr(userData?.games || {});
  if (!gameArr.length) return [];

  const gameEntry = gameArr[0]?.game || [];
  const gameData  = _yahooData(Array.isArray(gameEntry) ? gameEntry : [gameEntry]);
  const lgArr     = _yahooArr(gameData?.leagues || {});

  return lgArr.map(lEntry => {
    const lg     = lEntry?.league || [];
    const lgMeta = _yahooMeta(Array.isArray(lg) ? lg : [lg]);
    return {
      leagueKey: lgMeta.league_key || '',
      name:      lgMeta.name || 'Yahoo League',
      numTeams:  parseInt(lgMeta.num_teams || 0),
      season:    String(lgMeta.season || new Date().getFullYear()),
    };
  }).filter(l => l.leagueKey);
}

// ── Full state population ─────────────────────────────────────────

function mapToSleeperState(leagueData, teamsData, rostersData, leagueKey, year, crosswalk) {
  const cw = crosswalk || _crosswalk || {};

  const league = mapYahooSettings(leagueData, teamsData, leagueKey, year);

  const rostersFC = rostersData?.fantasy_content || {};
  const rostersLg = rostersFC.league || [];
  const rostersD  = _yahooData(Array.isArray(rostersLg) ? rostersLg : [rostersLg]);
  const rTeamsArr = _yahooArr(rostersD?.teams || {});

  const players     = {};
  const rosters     = [];
  const leagueUsers = [];

  rTeamsArr.forEach(tEntry => {
    if (!tEntry?.team) return;

    const tArr  = tEntry.team;
    const tMeta = _yahooMeta(tArr);
    const tInfo = _resourceMetadata(tMeta);
    const teamId = String(tInfo?.team_id || tInfo?.team_key?.split('.t.').pop() || '');

    const roster = mapYahooRoster(tEntry, cw);
    rosters.push(roster);

    // Build league user entry
    const mgrs  = tInfo?.managers || [];
    const mgArr = Array.isArray(mgrs) ? mgrs : [mgrs];
    const mgr   = mgArr[0]?.manager || mgArr[0] || {};
    leagueUsers.push({
      user_id:      mgr.guid || teamId,
      display_name: mgr.nickname || ('Team ' + teamId),
      username:     (mgr.nickname || '').toLowerCase().replace(/\s+/g, '_'),
      avatar:       null,
      metadata:     {},
    });

    // Collect players into players dict
    const tData     = _yahooData(tArr);
    const rosterObj = tData?.roster || {};
    const rPart     = rosterObj['0'] || rosterObj;
    const rPlayers  = rPart?.players || {};
    _yahooArr(rPlayers).forEach(pEntry => {
      const pData = pEntry?.player;
      if (!pData) return;
      const pMeta = _yahooMeta(pData);
      const pInfo = _resourceMetadata(pMeta);
      const yahooId = String(pInfo?.player_id || pInfo?.player_key?.split('.p.').pop() || '');
      if (!yahooId) return;

      const sleeperPid = cw[yahooId] || ('yahoo_' + yahooId);
      if (!players[sleeperPid]) {
        const mapped = mapYahooPlayer({ player: pData });
        if (mapped) {
          mapped.player_id = sleeperPid;
          players[sleeperPid] = mapped;
        }
      }
    });
  });

  return { players, rosters, league, leagueUsers };
}

// ── Main connect function ─────────────────────────────────────────

/**
 * Connect to a Yahoo league and populate window.S.
 *
 * @param {string} leagueKey  Yahoo league key e.g. "423.l.12345"
 * @param {string} teamKey    Optional: Yahoo team key for current user
 */
let _connectGeneration = 0;
const _legacyYahooContexts = new WeakMap();
function captureStateContext(state) {
  const scope = state && _legacyYahooContexts.get(state);
  let retired = !scope;
  return { isCurrent() {
    if (retired || _legacyYahooContexts.get(state) !== scope) return false;
    try { scope.assertCurrent(); return true; }
    catch { retired = true; if (_legacyYahooContexts.get(state) === scope) _legacyYahooContexts.delete(state); return false; }
  } };
}
function isStateCurrent(state) { return captureStateContext(state).isCurrent(); }
async function connectLeague(leagueKey, teamKey, options = {}) {
  const S = window.S || window.App?.S;
  if (!S) throw new Error('window.S not initialized');
  const activeId = S.currentLeagueId, generation = ++_connectGeneration;
  const scope = _connectionContext({ isCurrent: () => generation === _connectGeneration &&
    (window.S || window.App?.S) === S && S.currentLeagueId === activeId &&
    (typeof options.isCurrent !== 'function' || options.isCurrent()) });

  leagueKey = await _resolvedLeagueKey(leagueKey, scope, options.season || options.currentSeason);

  // Legacy Scout uses the same validated hydration/feed path as the newer
  // provider consumer. No second transaction implementation or empty success.
  const hydrated = await YahooProvider.hydrate({ id: 'yahoo_' + leagueKey, _yahoo: true,
    _yahooLeagueKey: leagueKey, ...(options.season || options.currentSeason ? { season: String(options.season || options.currentSeason) } : {}) }, {
    sleeperPlayers: S.players || {}, currentWeek: S.currentWeek,
    isCurrent: () => { scope.assertCurrent(); return true; },
  });
  scope.assertCurrent();
  const { players, rosters, league, leagueUsers } = hydrated;
  const year = Number(league.season);

  // ── 5. Populate window.S ──
  S.platform        = 'yahoo';
  S.yahooLeagueKey  = leagueKey;
  S.yahooYear       = year;

  Object.assign(S.players, players);
  S.rosters         = rosters;
  S.leagueUsers     = leagueUsers;
  S.tradedPicks     = [];
  S.drafts          = [];
  S.bracket         = { w: [], l: [] };
  S.matchups        = {};
  S.transactions    = hydrated.transactions;
  S.transactionStatus = hydrated.transactionStatus;
  S.season          = String(year);
  S.leagues         = [league];
  S.currentLeagueId = league.league_id;

  // ── 6. Find my roster ──
  if (teamKey) {
    const myTeamId = teamKey.split('.t.').pop();
    const myRoster = rosters.find(r => r.roster_id === myTeamId);
    S.myRosterId = myRoster?.roster_id || null;
  }

  _legacyYahooContexts.set(S, _connectionContext({ isCurrent: () => generation === _connectGeneration &&
    (window.S || window.App?.S) === S && S.currentLeagueId === league.league_id &&
    S.yahooLeagueKey === leagueKey && String(S.yahooYear) === String(year) }));
  return { ...hydrated };
}

// ── PlatformProvider adapter ──────────────────────────────────────
// Implements the unified PlatformProvider interface (see
// shared/platform-provider.js). Yahoo OAuth initiation still lives
// in Scout — the War Room connect card redirects there for initial
// auth. Once the session token is in shared localStorage
// (yahoo_session_id), War Room's provider can list leagues and
// hydrate them directly.

function _hasYahooSession() {
  return !!_getSessionId();
}

let _yahooRawStash = new Map();
let _yahooTransactionStash = new Map();
let _yahooCacheBoundary = '';
function _rawCache(scope) {
  scope.assertCurrent();
  const boundary = JSON.stringify([scope.ownerKey, scope.sessionVersion, scope.sessionId, scope.token, scope.epoch]);
  if (boundary !== _yahooCacheBoundary) {
    _yahooRawStash = new Map();
    _yahooTransactionStash = new Map();
    _yahooCacheBoundary = boundary;
  }
  return _yahooRawStash;
}
function _stashYahooRaw(leagueKey, raw, scope) {
  _rawCache(scope).set(leagueKey, { raw, ts: Date.now() });
}
function _getYahooStashedRaw(leagueKey, scope) {
  const entry = _rawCache(scope).get(leagueKey);
  if (!entry || Date.now() - entry.ts > 5 * 60 * 1000) return null;
  return entry.raw;
}

const YahooProvider = {
  id: 'yahoo',
  displayName: 'Yahoo',
  // A mounted consumer captures this once, rather than adopting a different
  // account/provider session when the user presses retry later.
  captureContext(league) {
    const selected = _selectedLeague(league, {}), scope = _connectionContext();
    let active = true;
    return { isCurrent() {
      if (!active) return false;
      try {
        scope.assertCurrent();
        const now = _selectedLeague(league, {});
        if (now.key === selected.key && now.season === selected.season) return true;
      } catch { /* Changed account/league requires reopening the view. */ }
      active = false;
      return false;
    } };
  },
  capabilities: {
    hasTransactions: true,
    hasDrafts: false,
    hasTradedPicks: false,
    hasMatchups: false,
    hasBracket: false,
    hasYearChain: false,
    hasFaab: false,
    hasTrending: false,
    hasPlayerStats: false,
    requiresOAuth: true,
    requiresFranchisePicker: false,
  },

  // ── Credentials ─────────────────────────────────────────────────
  // Yahoo uses a single shared session token (yahoo_session_id) rather
  // than per-league credentials. saveCredentials is a no-op; the
  // session lives in localStorage and is shared with Scout.
  saveCredentials(leagueKey, creds) {
    if (creds?.sessionId) {
      try { _setSessionId(creds.sessionId); } catch (e) {}
    }
  },
  loadCredentials(_leagueKey) {
    const sessionId = _getSessionId();
    return sessionId ? { sessionId } : null;
  },
  clearCredentials(_leagueKey) {
    try { sessionStorage.removeItem('yahoo_session_id'); localStorage.removeItem('yahoo_session_id'); } catch (e) {}
  },

  isAuthenticated: _hasYahooSession,

  // ── Phase 1: CONNECT ────────────────────────────────────────────
  async connect(_creds) {
    // Initial OAuth lives in Scout — if no session, return a sentinel
    // so the War Room connect card can render "Sign in via Scout".
    if (!_hasYahooSession()) {
      return {
        leagues: [],
        needsAuth: true,
        authUrl: 'https://c2-football.github.io/ReconAI/?yahoo_auth=1',
        needsFranchisePicker: false,
      };
    }

    // Session exists — fetch the user's leagues
    const scope = _connectionContext();
    const rawList = await fetchUserLeagues(scope);
    scope.assertCurrent();
    const stubs = parseUserLeagues(rawList);

    return {
      leagues: stubs.map(s => ({
        id: 'yahoo_' + s.leagueKey,
        name: s.name,
        season: s.season,
        _platform: 'yahoo',
        _yahoo: true,                    // legacy flag
        _yahooLeagueKey: s.leagueKey,
        _platformCreds: { leagueKey: s.leagueKey },
      })),
      needsFranchisePicker: false,
    };
  },

  // ── Phase 2: HYDRATE ────────────────────────────────────────────
  async hydrate(league, ctx) {
    if (!_hasYahooSession()) {
      throw new Error('Yahoo session expired — please re-authenticate via Scout');
    }
    const context = ctx || {};
    const selection = _selectedLeague(league, context);
    const scope = _connectionContext(context);
    const leagueKey = await _resolvedLeagueKey(selection.key, scope, selection.season);
    const sleeperPlayers = context.sleeperPlayers || {};

    // Reuse stashed raw if connect() was just called
    let leagueData, teamsData, rostersData;
    const stashed = _getYahooStashedRaw(leagueKey, scope);
    if (stashed) {
      ({ leagueData, teamsData, rostersData } = stashed);
    } else {
      const [lgRes, rostersRes] = await Promise.all([
        fetchLeague(leagueKey, scope, selection.season),
        fetchRosters(leagueKey, scope, selection.season),
      ]);
      leagueData = lgRes.leagueData;
      teamsData = lgRes.teamsData;
      rostersData = rostersRes;
      _validatedBundle(leagueData, teamsData, rostersData, leagueKey, selection.season);
      _stashYahooRaw(leagueKey, { leagueData, teamsData, rostersData }, scope);
    }

    scope.assertCurrent();

    // Validate cached data too; never infer a missing season from today's date.
    const year = _validatedBundle(leagueData, teamsData, rostersData, leagueKey, selection.season);

    // Extract Yahoo players for crosswalk
    const rostersFC = rostersData?.fantasy_content || {};
    const rostersLg = rostersFC.league || [];
    const rostersD  = _yahooData(Array.isArray(rostersLg) ? rostersLg : [rostersLg]);
    const rTeamsArr = _yahooArr(rostersD?.teams || {});

    const yahooPlayersForCW = [];
    rTeamsArr.forEach(tEntry => {
      if (!tEntry?.team) return;
      const tData     = _yahooData(tEntry.team);
      const rosterObj = tData?.roster || {};
      const rPart     = rosterObj['0'] || rosterObj;
      _yahooArr(rPart?.players || {}).forEach(pEntry => {
        const mapped = mapYahooPlayer({ player: pEntry?.player });
        if (mapped && mapped._yahoo_id) yahooPlayersForCW.push(mapped);
      });
    });

    // Rebuild crosswalk against real Sleeper DB
    try { localStorage.removeItem('yahoo_crosswalk_' + year); } catch (e) {}
    const crosswalk = buildCrosswalk(sleeperPlayers, yahooPlayersForCW, year);

    const mapped = mapToSleeperState(leagueData, teamsData, rostersData, leagueKey, year, crosswalk);

    // This endpoint is a completed trade feed, not add/drop/waiver history.
    let txns = [], tradePlayers = {}, transactionStatus;
    const transactionKey = leagueKey + ':' + year, checkedAt = Date.now();
    try {
      const txRaw = await fetchTransactions(leagueKey, scope, year);
      scope.assertCurrent();
      const feed = _transactionRows(txRaw, leagueKey, year, crosswalk, mapped.rosters);
      txns = feed.rows;
      tradePlayers = feed.players;
      const lastSuccessAt = Date.now();
      _rawCache(scope); // Revalidate the account/session boundary before caching.
      _yahooTransactionStash.set(transactionKey, { rows: JSON.stringify(txns), players: JSON.stringify(tradePlayers), lastSuccessAt, excludedTradeCount: feed.excludedTradeCount });
      transactionStatus = { status: 'ready', lastSuccessAt, excludedTradeCount: feed.excludedTradeCount };
    } catch (error) {
      scope.assertCurrent();
      if (error?.code === 'YAHOO_DATA_MISMATCH') throw error;
      _rawCache(scope);
      const saved = _yahooTransactionStash.get(transactionKey);
      if (saved) { txns = JSON.parse(saved.rows); tradePlayers = JSON.parse(saved.players || '{}'); }
      transactionStatus = { status: saved ? 'stale' : 'unavailable', lastSuccessAt: saved?.lastSuccessAt || null,
        excludedTradeCount: saved?.excludedTradeCount || 0,
        message: saved ? 'Yahoo trades could not refresh. Showing the last confirmed feed.' : 'Yahoo trades are unavailable. This does not mean there were no trades.' };
      console.warn('[Yahoo] transactions fetch failed:', error?.message || error);
    }
    scope.assertCurrent();
    const transactionsByWeek = txns.length ? { w0: txns } : {};

    return {
      league: mapped.league,
      rosters: mapped.rosters,
      leagueUsers: mapped.leagueUsers,
      players: { ...tradePlayers, ...(mapped.players || {}) },
      transactions: transactionsByWeek,
      transactionStatus: { ...transactionStatus, provider: 'yahoo', leagueId: mapped.league.league_id, season: String(year), scope: 'executed_trades', checkedAt },
      tradedPicks: [],
      drafts: [],
      matchups: [],
      nflState: {},
      _extras: {},
    };
  },
};

if (window.App?.Platforms?.register) {
  window.App.Platforms.register(YahooProvider);
} else {
  console.warn('[Yahoo] platform-provider.js not loaded — provider will not be registered');
}

// ── Expose on window.Yahoo ────────────────────────────────────────
window.Yahoo = {
  BASE_URL: YAHOO_BASE,
  YAHOO_STAT_MAP,
  YAHOO_POS_MAP,
  YAHOO_TEAM_MAP,

  // Auth
  startAuth,
  handleCallback,
  hasCallback,
  hasSession: _hasYahooSession,

  // Fetch
  apiRequest,
  fetchUserLeagues,
  fetchLeague,
  fetchRosters,
  fetchTransactions,

  // Parse helpers
  parseUserLeagues,
  _yahooArr,

  // Mappers
  mapYahooPlayer,
  mapYahooRoster,
  mapYahooSettings,
  mapYahooTrade,
  mapToSleeperState,

  // Crosswalk
  buildCrosswalk,
  lookupSleeperPlayerId,

  // Main connect (legacy — prefer .provider for new code)
  connectLeague,
  isStateCurrent,
  captureStateContext,

  // Unified PlatformProvider interface
  provider: YahooProvider,
};

})();

// ── Module global exports (Vite migration) ───────────────────────────────────
window.YahooProvider = window.Yahoo.provider;
window.yahooBuildCrosswalk = window.Yahoo.buildCrosswalk;
window.yahooLookupSleeperPlayerId = window.Yahoo.lookupSleeperPlayerId;
window.yahooMapToSleeperState = window.Yahoo.mapToSleeperState;
