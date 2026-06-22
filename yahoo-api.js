// ══════════════════════════════════════════════════════════════════
// shared/yahoo-api.js — Yahoo Fantasy Football connector
// Fetches Yahoo league data via OAuth 2.0 and maps it to Sleeper-
// equivalent format so all existing ReconAI/WarRoom features work.
//
// window.Yahoo exposes:
//   startAuth()                → redirects to Yahoo OAuth consent screen
//   handleCallback(sessionId)  → stores OAuth session from Edge Function callback
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
async function _proxyPost(body) {
  const token = window.OD?.getSessionToken ? window.OD.getSessionToken() : null;
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token || SUPABASE_ANON}`,
      'apikey': SUPABASE_ANON,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (err.auth_required) throw new Error('Yahoo auth expired — please reconnect.');
    throw new Error(err.error || 'Yahoo proxy error ' + res.status);
  }
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────

/**
 * Initiates Yahoo OAuth flow. Gets the auth URL from the edge function
 * (keeps YAHOO_CLIENT_ID server-side), then redirects to Yahoo consent screen.
 */
async function startAuth() {
  const returnUrl = window.location.href.split('?')[0];
  const data = await _proxyPost({ action: 'auth_url', return_url: returnUrl });
  if (!data.auth_url) {
    throw new Error('Failed to get Yahoo auth URL — check Supabase secrets (YAHOO_CLIENT_ID)');
  }
  window.location.href = data.auth_url;
}

/**
 * Stores the session ID received from the OAuth callback redirect.
 * Called by app.js after detecting ?yahoo_session= in the URL.
 */
function handleCallback(sessionId) {
  if (!sessionId) throw new Error('No Yahoo session ID in callback');
  _setSessionId(sessionId);
  return sessionId;
}

// ── API request ───────────────────────────────────────────────────

/**
 * Makes an authenticated Yahoo Fantasy API request through the proxy.
 * Appends ?format=json so Yahoo returns JSON instead of XML.
 */
async function apiRequest(endpoint) {
  const sessionId = _getSessionId();
  if (!sessionId) throw new Error('Not authenticated with Yahoo — please connect first.');
  const sep = endpoint.includes('?') ? '&' : '?';
  return _proxyPost({
    action:     'api',
    endpoint:   endpoint + sep + 'format=json',
    session_id: sessionId,
  });
}

// ── Fetch helpers ─────────────────────────────────────────────────

/** All NFL leagues for the authenticated Yahoo user. */
async function fetchUserLeagues() {
  return apiRequest('/users;use_login=1/games;game_keys=nfl/leagues');
}

/** League settings + all teams (parallel). */
async function fetchLeague(leagueKey) {
  const [leagueData, teamsData] = await Promise.all([
    apiRequest(`/league/${leagueKey}/settings`),
    apiRequest(`/league/${leagueKey}/teams`),
  ]);
  return { leagueData, teamsData };
}

/** All team rosters in one batch request via ;out=roster sub-resource. */
async function fetchRosters(leagueKey) {
  return apiRequest(`/league/${leagueKey}/teams;out=roster`);
}

/** Trade transactions for a league. */
async function fetchTransactions(leagueKey) {
  return apiRequest(`/league/${leagueKey}/transactions;type=trade`);
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
  const pInfo = Array.isArray(pMeta) ? pMeta[0] : pMeta;
  if (!pInfo) return null;

  const yahooId   = String(pInfo.player_id || pInfo.player_key?.split('.p.').pop() || '');
  const fullName  = pInfo.full_name || '';
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
  const tInfo = Array.isArray(tMeta) ? tMeta[0] : tMeta;

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
    const pInfo   = Array.isArray(pMeta) ? pMeta[0] : pMeta;
    const pSelObj = _yahooData(pData); // { selected_position: [...] }
    const yahooId = String(pInfo?.player_id || '');
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
  const settings = lgData?.settings || lgMeta?.settings || {};

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
    const count  = parseInt(rp.count || 1);
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
function mapYahooTrade(tx) {
  if (!tx || tx.type !== 'trade') return null;
  const pArr    = _yahooArr(tx.players || {});
  const sideMap = {};

  pArr.forEach(pEntry => {
    const pData   = pEntry?.player;
    if (!pData) return;
    const pMeta   = _yahooMeta(pData);
    const pInfo   = Array.isArray(pMeta) ? pMeta[0] : pMeta;
    const pSelObj = _yahooData(pData);
    const yahooId = String(pInfo?.player_id || '');
    const destKey = pSelObj?.transaction_data?.destination_team_key || '';
    if (!yahooId || !destKey) return;

    const destId = destKey.split('.t.').pop();
    if (!sideMap[destId]) sideMap[destId] = { roster_id: destId, adds: [], drops: [] };
    sideMap[destId].adds.push('yahoo_' + yahooId);
  });

  return {
    type:      'trade',
    status:    tx.status === 'successful' ? 'complete' : 'pending',
    timestamp: parseInt(tx.timestamp || 0) * 1000,
    week:      parseInt((tx.transaction_key || '').split('.').pop() || 0),
    sides:     Object.values(sideMap),
    _source:   'yahoo',
  };
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
    const tInfo = Array.isArray(tMeta) ? tMeta[0] : tMeta;
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
      const pInfo = Array.isArray(pMeta) ? pMeta[0] : pMeta;
      const yahooId = String(pInfo?.player_id || '');
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
async function connectLeague(leagueKey, teamKey) {
  const S = window.S || window.App?.S;
  if (!S) throw new Error('window.S not initialized');

  // ── 1. Fetch league settings + rosters in parallel ──
  const [{ leagueData, teamsData }, rostersData] = await Promise.all([
    fetchLeague(leagueKey),
    fetchRosters(leagueKey),
  ]);

  // ── 2. Extract Yahoo players for crosswalk ──
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

  const lgMeta = _yahooMeta(leagueData?.fantasy_content?.league || []);
  const year   = parseInt(lgMeta?.season || new Date().getFullYear());

  // ── 3. Build crosswalk against Sleeper player DB ──
  const crosswalk = buildCrosswalk(S.players || {}, yahooPlayersForCW, year);

  // ── 4. Map Yahoo data → Sleeper-equivalent format ──
  const { players, rosters, league, leagueUsers } = mapToSleeperState(
    leagueData, teamsData, rostersData, leagueKey, year, crosswalk
  );

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
  S.transactions    = {};
  S.season          = String(year);
  S.leagues         = [league];
  S.currentLeagueId = league.league_id;

  // ── 6. Find my roster ──
  if (teamKey) {
    const myTeamId = teamKey.split('.t.').pop();
    const myRoster = rosters.find(r => r.roster_id === myTeamId);
    S.myRosterId = myRoster?.roster_id || null;
  }

  return { players, rosters, league, leagueUsers };
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

const _yahooRawStash = {};
function _stashYahooRaw(leagueKey, raw) {
  _yahooRawStash[leagueKey] = { raw, ts: Date.now() };
}
function _getYahooStashedRaw(leagueKey) {
  const entry = _yahooRawStash[leagueKey];
  if (!entry) return null;
  if (Date.now() - entry.ts > 5 * 60 * 1000) return null;
  return entry.raw;
}

const YahooProvider = {
  id: 'yahoo',
  displayName: 'Yahoo',
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
    const rawList = await fetchUserLeagues();
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
    const creds = league._platformCreds || this.loadCredentials(league.id) || {};
    const leagueKey = creds.leagueKey || league._yahooLeagueKey;
    if (!leagueKey) throw new Error('Yahoo league key missing');

    const context = ctx || {};
    const sleeperPlayers = context.sleeperPlayers || {};
    const currentWeek = context.currentWeek != null ? context.currentWeek : 0;

    // Reuse stashed raw if connect() was just called
    let leagueData, teamsData, rostersData;
    const stashed = _getYahooStashedRaw(leagueKey);
    if (stashed) {
      ({ leagueData, teamsData, rostersData } = stashed);
    } else {
      const [lgRes, rostersRes] = await Promise.all([
        fetchLeague(leagueKey),
        fetchRosters(leagueKey),
      ]);
      leagueData = lgRes.leagueData;
      teamsData = lgRes.teamsData;
      rostersData = rostersRes;
      _stashYahooRaw(leagueKey, { leagueData, teamsData, rostersData });
    }

    // Extract year from league metadata
    const lgMeta = _yahooMeta(leagueData?.fantasy_content?.league || []);
    const year = parseInt(lgMeta?.season || context.currentSeason || new Date().getFullYear(), 10);

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

    // Transactions — trade-only from Yahoo
    let txns = [];
    try {
      const txRaw = await fetchTransactions(leagueKey);
      const txFc  = txRaw?.fantasy_content || {};
      const txLg  = txFc.league || [];
      const txD   = _yahooData(Array.isArray(txLg) ? txLg : [txLg]);
      const txArr = _yahooArr(txD?.transactions || {});
      txns = txArr
        .map(tEntry => {
          const tx = tEntry?.transaction;
          if (!tx) return null;
          const tMeta = _yahooMeta(Array.isArray(tx) ? tx : [tx]);
          const tData = _yahooData(Array.isArray(tx) ? tx : [tx]);
          return mapYahooTrade({ ...tMeta, ...tData });
        })
        .filter(Boolean);
    } catch (e) {
      console.warn('[Yahoo] transactions fetch failed:', e?.message || e);
    }

    const wkKey = 'w' + currentWeek;
    const transactionsByWeek = txns.length ? { [wkKey]: txns } : {};

    return {
      league: mapped.league,
      rosters: mapped.rosters,
      leagueUsers: mapped.leagueUsers,
      players: mapped.players || {},
      transactions: transactionsByWeek,
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

  // Unified PlatformProvider interface
  provider: YahooProvider,
};

})();

// ── Module global exports (Vite migration) ───────────────────────────────────
window.YahooProvider = window.Yahoo.provider;
window.yahooBuildCrosswalk = window.Yahoo.buildCrosswalk;
window.yahooLookupSleeperPlayerId = window.Yahoo.lookupSleeperPlayerId;
window.yahooMapToSleeperState = window.Yahoo.mapToSleeperState;
