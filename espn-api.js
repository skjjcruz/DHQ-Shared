// ══════════════════════════════════════════════════════════════════
// shared/espn-api.js — ESPN Fantasy Football connector
// Fetches ESPN league data and maps it to Sleeper-equivalent format
// so all existing ReconAI/WarRoom features work without modification.
//
// window.ESPN exposes:
//   fetchLeague(leagueId, year, espnS2, swid) → raw ESPN response
//   mapToSleeperState(rawData, leagueId, year) → { players, rosters, league, leagueUsers }
//   buildCrosswalk(sleeperPlayers, espnEntries) → ESPN playerId → Sleeper pid map
//   connectLeague(leagueId, year, espnS2, swid) → populates window.S, returns mapped data
// ══════════════════════════════════════════════════════════════════

window.App = window.App || {};

(function () {
'use strict';

// ── ESPN constants ────────────────────────────────────────────────
const ESPN_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

// ESPN Pro Team ID → NFL abbreviation used by Sleeper
const PRO_TEAM_MAP = {
  '-1': 'FA', '0': 'FA',
  '1': 'ATL',  '2': 'BUF',  '3': 'CHI',  '4': 'CIN',  '5': 'CLE',
  '6': 'DAL',  '7': 'DEN',  '8': 'DET',  '9': 'GB',  '10': 'TEN',
  '11': 'IND', '12': 'KC',  '13': 'LV',  '14': 'LAR', '15': 'MIA',
  '16': 'MIN', '17': 'NE',  '18': 'NO',  '19': 'NYG', '20': 'NYJ',
  '21': 'PHI', '22': 'ARI', '23': 'PIT', '24': 'LAC', '25': 'SF',
  '26': 'SEA', '27': 'TB',  '28': 'WSH', '29': 'CAR', '30': 'JAX',
  '33': 'BAL', '34': 'HOU', '35': 'LV',
};

// ESPN default position ID → Sleeper position string
const POSITION_MAP = {
  1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF',
  14: 'DB', 15: 'LB',
};

// ESPN lineup slot ID → position label (null = bench/IR, not starter)
const LINEUP_SLOT_MAP = {
  0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 23: 'FLEX', 24: 'OP',
  16: 'DEF', 17: 'K',
  20: null, // Bench
  21: null, // IR
};

// ESPN stat ID → Sleeper scoring key (community-documented stat IDs)
// Points values below are defaults; actual values come from ESPN settings
const ESPN_STAT_MAP = {
  3:  'pass_yd',    // Passing yards (pts per yard, typically 0.04)
  19: 'pass_td',    // Passing TDs
  20: 'pass_int',   // Passing INTs (negative)
  24: 'rush_yd',    // Rushing yards (pts per yard, typically 0.1)
  25: 'rush_td',    // Rushing TDs
  42: 'rec_yd',     // Receiving yards (pts per yard, typically 0.1)
  43: 'rec_td',     // Receiving TDs
  53: 'rec',        // Receptions (1.0 = PPR, 0.5 = half-PPR, 0 = standard)
  72: 'fum_lost',   // Fumbles lost (negative)
  74: 'bonus_2pt_off', // 2-point conversions
  // IDP
  45: 'idp_int',        47: 'idp_sack',
  46: 'idp_fum_rec',    48: 'idp_safe',
  49: 'idp_blk_kick',   51: 'idp_def_td',
  57: 'idp_solo',       58: 'idp_ast',
  55: 'idp_pass_def',
};

// ESPN lineup slot → Sleeper roster_positions string
const SLOT_TO_ROSTER_POS = {
  0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 23: 'FLEX', 24: 'OP',
  16: 'DEF', 17: 'K', 20: 'BN', 21: 'IR',
};

// ── Proxy URL (Supabase Edge Function) ───────────────────────────
// For authenticated (private) leagues: the proxy forwards requests
// to ESPN with the Cookie header — browsers can't set Cookie directly.
const CONFIG = window.App?.CONFIG || window.OD?.CONFIG || {};
const FUNCTIONS_BASE = CONFIG.functionsBase || 'https://sxshiqyxhhifvtfqawbq.supabase.co/functions/v1';
const PROXY_URL = CONFIG.endpoints?.espnProxy || `${FUNCTIONS_BASE}/espn-proxy`;
const SUPABASE_ANON = CONFIG.supabaseAnon
  || window.OD?.SUPABASE_ANON
  || window.App?.SUPABASE_ANON
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN4c2hpcXl4aGhpZnZ0ZnFhd2JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MTExMzAsImV4cCI6MjA4ODI4NzEzMH0.zJi9W986ZLaANiZN6pt6ReFwaQU6yPeidsERIWo2ibI';

// ── Crosswalk cache ───────────────────────────────────────────────
// Maps ESPN numeric player ID → Sleeper string player ID
let _crosswalk = null;
let _crosswalkYear = null;

// ── Fetch helpers ─────────────────────────────────────────────────

/**
 * Fetch ESPN league data. Routes through Supabase proxy when credentials
 * are provided (for private leagues). Falls back to direct fetch (works
 * when user is logged into ESPN in the same browser).
 */
async function fetchLeague(leagueId, year, espnS2, swid) {
  const views = ['mTeam', 'mRoster', 'mSettings'];
  const viewStr = views.map(v => 'view=' + v).join('&');
  const url = `${ESPN_BASE}/seasons/${year}/segments/0/leagues/${leagueId}?${viewStr}`;

  return _espnGet(url, espnS2, swid);
}

async function fetchTransactions(leagueId, year, espnS2, swid) {
  const url = `${ESPN_BASE}/seasons/${year}/segments/0/leagues/${leagueId}?view=mTransactions2`;
  return _espnGet(url, espnS2, swid);
}

async function _espnGet(url, espnS2, swid) {
  // With credentials: route through proxy
  if (espnS2 && swid) {
    const token = window.OD?.getSessionToken ? window.OD.getSessionToken() : null;
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token || SUPABASE_ANON}`,
        'apikey': SUPABASE_ANON,
      },
      body: JSON.stringify({ url, espnS2, swid }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'ESPN proxy error ' + res.status);
    }
    return res.json();
  }

  // Without credentials: direct fetch (works for public leagues or logged-in ESPN users)
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('This ESPN league is private. Provide your espn_s2 and SWID cookies to connect.');
    }
    throw new Error('ESPN API error ' + res.status + '. Make sure your League ID is correct.');
  }
  return res.json();
}

// ── Data mappers ──────────────────────────────────────────────────

/**
 * Map an ESPN roster entry → Sleeper-compatible player object.
 * Player will have player_id = Sleeper ID (if crosswalk found) or 'espn_{id}'.
 */
function mapESPNPlayer(entry) {
  const p = entry?.playerPoolEntry?.player;
  if (!p) return null;
  const espnId = p.id;
  const team = PRO_TEAM_MAP[String(p.proTeamId)] || 'FA';
  const pos = POSITION_MAP[p.defaultPositionId] || 'OL';
  const nameParts = (p.fullName || '').split(' ');
  return {
    player_id: 'espn_' + espnId,
    _espn_id: espnId,
    full_name: p.fullName || '',
    first_name: nameParts[0] || '',
    last_name: nameParts.slice(1).join(' ') || '',
    position: pos,
    team,
    age: p.age || 0,
    years_exp: p.experience || 0,
    injury_status: p.injuryStatus || '',
  };
}

/**
 * Map an ESPN team + roster entries → Sleeper-compatible roster object.
 * crosswalk: Map<espnId, sleeperId> — used to resolve player_ids.
 */
function mapESPNRoster(team, crosswalk) {
  const entries = team.roster?.entries || [];
  const players = [];
  const starters = [];
  const reserve = [];

  entries.forEach(entry => {
    const espnId = entry.playerId || entry.playerPoolEntry?.player?.id;
    if (!espnId) return;
    const pid = (crosswalk && crosswalk[espnId]) ? crosswalk[espnId] : 'espn_' + espnId;
    players.push(pid);
    const slotId = entry.lineupSlotId;
    if (slotId === 21) {
      reserve.push(pid); // IR slot
    } else if (LINEUP_SLOT_MAP[slotId] !== null && LINEUP_SLOT_MAP[slotId] !== undefined) {
      starters.push(pid); // Starting lineup slot
    }
    // slotId === 20 (Bench) → just in players[], not starters
  });

  const rec = team.record?.overall || {};
  return {
    roster_id: String(team.id),
    owner_id: team.primaryOwner || String(team.id),
    players,
    starters,
    reserve,
    taxi: [],
    settings: {
      wins: rec.wins || 0,
      losses: rec.losses || 0,
      ties: rec.ties || 0,
      fpts: Math.floor(rec.pointsFor || 0),
      fpts_decimal: Math.round(((rec.pointsFor || 0) % 1) * 100),
      fpts_against: Math.floor(rec.pointsAgainst || 0),
      fpts_against_decimal: Math.round(((rec.pointsAgainst || 0) % 1) * 100),
    },
  };
}

/**
 * Map ESPN transactions → array of Sleeper-compatible transaction objects.
 */
function mapESPNTrade(espnTx) {
  if (!espnTx || espnTx.type !== 'TRADE') return null;
  return {
    type: 'trade',
    status: espnTx.status === 'EXECUTED' ? 'complete' : 'pending',
    timestamp: espnTx.executionDate || espnTx.proposedDate || 0,
    week: espnTx.scoringPeriodId || 0,
    sides: (espnTx.teams || []).map(side => ({
      roster_id: String(side.fromTeamId),
      adds: (side.playersAdded || []).map(p => p.id),
      drops: (side.playersDropped || []).map(p => p.id),
    })),
    _source: 'espn',
  };
}

/**
 * Map ESPN settings → Sleeper-compatible league settings object.
 * Returns { scoring_settings, roster_positions, total_rosters, name }.
 */
function mapESPNSettings(raw, leagueId, year) {
  const settings = raw.settings || {};

  // ── Scoring settings ──
  const scoring_settings = {};
  (settings.scoringSettings?.scoringItems || []).forEach(item => {
    const key = ESPN_STAT_MAP[item.statId];
    if (key) scoring_settings[key] = item.points;
  });
  // Normalize pass_int to negative (ESPN stores as negative already, but ensure)
  if (scoring_settings.pass_int > 0) scoring_settings.pass_int = -scoring_settings.pass_int;
  if (scoring_settings.fum_lost > 0) scoring_settings.fum_lost = -scoring_settings.fum_lost;

  // ── Roster positions ──
  const slotCounts = settings.rosterSettings?.lineupSlotCounts || {};
  const roster_positions = [];
  Object.entries(slotCounts).forEach(([slotId, count]) => {
    const pos = SLOT_TO_ROSTER_POS[parseInt(slotId)];
    if (!pos || count <= 0) return;
    for (let i = 0; i < count; i++) roster_positions.push(pos);
  });

  return {
    league_id: 'espn_' + leagueId + '_' + year,
    name: settings.name || ('ESPN League ' + leagueId),
    total_rosters: settings.size || (raw.teams?.length || 12),
    season: String(year),
    status: 'in_season',
    settings: { type: 0 }, // 0 = redraft (ESPN fantasy is redraft by default)
    scoring_settings,
    roster_positions,
    avatar: null,
    _source: 'espn',
    _espn_id: String(leagueId),
  };
}

// ── Player crosswalk ──────────────────────────────────────────────

/**
 * Normalize a player name for crosswalk matching.
 * Strips suffixes (Jr., Sr., II, III, IV), lowercases, collapses spaces.
 */
function _normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build ESPN playerId → Sleeper playerId crosswalk.
 * Matches by normalized full name + NFL team abbreviation.
 * Falls back to name-only match if team doesn't match.
 * Result is cached in localStorage per year.
 */
function buildCrosswalk(sleeperPlayers, espnEntries, year) {
  const cacheKey = 'espn_crosswalk_' + year;

  // Load from cache if available and fresh
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
  const nameTeamIndex = {}; // `${normalizedName}|${team}` → sleeperId
  const nameOnlyIndex = {}; // `${normalizedName}` → [sleeperId, ...]

  Object.entries(sleeperPlayers || {}).forEach(([sid, p]) => {
    const name = _normalizeName(p.full_name || (p.first_name + ' ' + p.last_name));
    if (!name) return;
    const team = (p.team || 'FA').toUpperCase();
    nameTeamIndex[name + '|' + team] = sid;
    if (!nameOnlyIndex[name]) nameOnlyIndex[name] = [];
    nameOnlyIndex[name].push(sid);
  });

  // Match ESPN players → Sleeper IDs
  const map = {};
  (espnEntries || []).forEach(entry => {
    const p = entry?.playerPoolEntry?.player;
    if (!p || !p.id) return;
    const espnId = p.id;
    const name = _normalizeName(p.fullName);
    const team = (PRO_TEAM_MAP[String(p.proTeamId)] || 'FA').toUpperCase();

    // Try exact name + team match first
    let sleeperPid = nameTeamIndex[name + '|' + team];

    // Fall back to name-only match (takes first candidate)
    if (!sleeperPid && nameOnlyIndex[name]) {
      sleeperPid = nameOnlyIndex[name][0];
    }

    if (sleeperPid) map[espnId] = sleeperPid;
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

/**
 * Look up the Sleeper player ID for a given ESPN player ID.
 * Returns the Sleeper ID if crosswalk hit, otherwise 'espn_{espnId}'.
 */
function lookupSleeperPlayerId(espnId) {
  if (_crosswalk && _crosswalk[espnId]) return _crosswalk[espnId];
  return 'espn_' + espnId;
}

// ── Full state population ─────────────────────────────────────────

/**
 * Map raw ESPN API response to { players, rosters, league, leagueUsers }.
 * crosswalk: { [espnId]: sleeperId } — optional, built from Sleeper player DB.
 */
function mapToSleeperState(raw, leagueId, year, crosswalk) {
  const cw = crosswalk || _crosswalk || {};

  // ── League settings ──
  const league = mapESPNSettings(raw, leagueId, year);

  // ── Members (owners) ──
  const leagueUsers = (raw.members || []).map(m => ({
    user_id: m.id,
    display_name: m.displayName || (m.firstName + ' ' + m.lastName).trim() || m.id,
    username: (m.displayName || m.firstName || '').toLowerCase().replace(/\s+/g, '_'),
    avatar: null,
    metadata: {},
  }));

  // Build member id → display_name lookup
  const memberMap = {};
  leagueUsers.forEach(u => { memberMap[u.user_id] = u; });

  // ── Players + Rosters ──
  const players = {};
  const rosters = [];

  (raw.teams || []).forEach(team => {
    const entries = team.roster?.entries || [];

    // Collect players for this team's roster
    entries.forEach(entry => {
      const p = entry?.playerPoolEntry?.player;
      if (!p || !p.id) return;
      const espnId = p.id;
      const sleeperPid = cw[espnId] || ('espn_' + espnId);

      // Only add to players dict if not already present (Sleeper player DB takes precedence)
      if (!players[sleeperPid]) {
        const mapped = mapESPNPlayer(entry);
        if (mapped) {
          mapped.player_id = sleeperPid;
          players[sleeperPid] = mapped;
        }
      }
    });

    // Map roster
    const roster = mapESPNRoster(team, cw);
    // Attach display name from members
    const owner = memberMap[team.primaryOwner];
    if (owner) {
      roster._owner_name = owner.display_name;
    } else {
      // Fallback: use team location + nickname if available
      roster._owner_name = [team.location, team.nickname].filter(Boolean).join(' ') || ('Team ' + team.id);
    }
    roster._team_name = [team.location, team.nickname].filter(Boolean).join(' ') || ('Team ' + team.id);
    roster._team_abbrev = team.abbrev || '';
    rosters.push(roster);
  });

  return { players, rosters, league, leagueUsers };
}

// ── Main connect function ─────────────────────────────────────────

/**
 * Connect to an ESPN league and populate window.S.
 * Returns { players, rosters, league, leagueUsers } after populating state.
 *
 * @param {string|number} leagueId  ESPN league ID (from URL)
 * @param {number}        year      Season year (e.g. 2024)
 * @param {string}        espnS2    Optional: espn_s2 cookie for private leagues
 * @param {string}        swid      Optional: SWID cookie for private leagues
 * @param {number}        myTeamId  Optional: ESPN team ID (1–N) for the current user
 */
async function connectLeague(leagueId, year, espnS2, swid, myTeamId) {
  const S = window.S || window.App?.S;
  if (!S) throw new Error('window.S not initialized');

  // ── 1. Fetch ESPN data ──
  const raw = await fetchLeague(leagueId, year, espnS2, swid);
  if (!raw || !raw.teams) throw new Error('Invalid ESPN league data. Check your League ID.');

  // ── 2. Build player crosswalk against Sleeper player DB ──
  // Use whatever Sleeper player data is already in S.players (may be empty)
  const allEspnEntries = (raw.teams || []).flatMap(t => t.roster?.entries || []);
  const crosswalk = buildCrosswalk(S.players || {}, allEspnEntries, year);

  // ── 3. Map ESPN data → Sleeper-equivalent format ──
  const { players, rosters, league, leagueUsers } = mapToSleeperState(raw, leagueId, year, crosswalk);

  // ── 4. Populate window.S ──
  S.platform = 'espn';
  S.espnLeagueId = String(leagueId);
  S.espnYear = year;
  if (espnS2) S._espnS2 = espnS2;
  if (swid) S._espnSwid = swid;

  // Merge ESPN players into S.players (Sleeper players already in S.players take precedence)
  Object.assign(S.players, players);

  S.rosters = rosters;
  S.leagueUsers = leagueUsers;
  S.tradedPicks = [];
  S.drafts = [];
  S.bracket = { w: [], l: [] };
  S.matchups = {};
  S.transactions = {};
  S.season = String(year);

  // Build leagues array (Sleeper format expects an array)
  S.leagues = [league];
  S.currentLeagueId = league.league_id;

  // ── 5. Find my roster ──
  if (myTeamId) {
    const myRoster = rosters.find(r => r.roster_id === String(myTeamId));
    S.myRosterId = myRoster?.roster_id || null;
  }

  return { players, rosters, league, leagueUsers, raw };
}

// ── PlatformProvider adapter ──────────────────────────────────────
// Implements the unified PlatformProvider interface (see
// shared/platform-provider.js). Wraps the existing ESPN fetch/map
// functions and fills in transactions that connectLeague() historically
// left empty.

const _espnRawStash = {};
function _stashEspnRaw(leagueId, year, raw) {
  _espnRawStash[leagueId + '_' + year] = { raw, ts: Date.now() };
}
function _getEspnStashedRaw(leagueId, year) {
  const entry = _espnRawStash[leagueId + '_' + year];
  if (!entry) return null;
  if (Date.now() - entry.ts > 5 * 60 * 1000) return null;
  return entry.raw;
}

const EspnProvider = {
  id: 'espn',
  displayName: 'ESPN',
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
    requiresOAuth: false,
    requiresFranchisePicker: false,
  },

  // ── Credentials ─────────────────────────────────────────────────
  saveCredentials(leagueKey, creds) {
    try {
      const safeCreds = { ...creds };
      delete safeCreds.espnS2;
      delete safeCreds.swid;
      localStorage.setItem('espn_creds_' + leagueKey, JSON.stringify(safeCreds));
      // Legacy flat keys
      if (creds.espnS2) { sessionStorage.setItem('espn_s2', creds.espnS2); localStorage.removeItem('espn_s2'); }
      if (creds.swid) { sessionStorage.setItem('espn_swid', creds.swid); localStorage.removeItem('espn_swid'); }
    } catch (e) {}
  },
  loadCredentials(leagueKey) {
    try {
      const raw = localStorage.getItem('espn_creds_' + leagueKey);
      if (raw) {
        const creds = JSON.parse(raw);
        return {
          ...creds,
          espnS2: sessionStorage.getItem('espn_s2') || localStorage.getItem('espn_s2') || creds.espnS2 || null,
          swid: sessionStorage.getItem('espn_swid') || localStorage.getItem('espn_swid') || creds.swid || null,
        };
      }
    } catch (e) {}
    return {
      espnS2: sessionStorage.getItem('espn_s2') || localStorage.getItem('espn_s2') || null,
      swid: sessionStorage.getItem('espn_swid') || localStorage.getItem('espn_swid') || null,
    };
  },
  clearCredentials(leagueKey) {
    try {
      localStorage.removeItem('espn_creds_' + leagueKey);
      sessionStorage.removeItem('espn_s2');
      sessionStorage.removeItem('espn_swid');
      localStorage.removeItem('espn_s2');
      localStorage.removeItem('espn_swid');
    } catch (e) {}
  },

  // ── Phase 1: CONNECT ────────────────────────────────────────────
  async connect(creds) {
    const { leagueId, year, espnS2, swid } = creds || {};
    if (!leagueId) throw new Error('ESPN league ID required');
    const numericId = String(leagueId).replace(/\D/g, '');
    if (!numericId) throw new Error('ESPN league ID must be numeric');
    const yr = year || String(new Date().getFullYear());

    const raw = await fetchLeague(numericId, yr, espnS2 || null, swid || null);
    if (!raw || !raw.teams) {
      throw new Error('Invalid ESPN league data. Check your League ID.');
    }
    _stashEspnRaw(numericId, yr, raw);

    const settings = raw.settings || {};
    return {
      leagues: [{
        id: 'espn_' + numericId + '_' + yr,
        name: settings.name || 'ESPN League ' + numericId,
        season: String(yr),
        _platform: 'espn',
        _espn: true,                   // legacy flag
        _espnLeagueId: String(numericId),
        _platformCreds: {
          leagueId: String(numericId),
          year: String(yr),
          espnS2: espnS2 || null,
          swid: swid || null,
        },
      }],
      needsFranchisePicker: false,
    };
  },

  // ── Phase 2: HYDRATE ────────────────────────────────────────────
  async hydrate(league, ctx) {
    const creds = league._platformCreds || this.loadCredentials(league.id) || {};
    const leagueId = creds.leagueId || league._espnLeagueId;
    const year = creds.year || league.season || String(new Date().getFullYear());
    const espnS2 = creds.espnS2 || null;
    const swid = creds.swid || null;
    if (!leagueId) throw new Error('ESPN league credentials missing');

    const context = ctx || {};
    const sleeperPlayers = context.sleeperPlayers || {};
    const currentWeek = context.currentWeek != null ? context.currentWeek : 0;

    const raw = _getEspnStashedRaw(leagueId, year) || await fetchLeague(leagueId, year, espnS2, swid);
    if (!raw || !raw.teams) throw new Error('ESPN league fetch returned no data');

    // Rebuild crosswalk against the real Sleeper player DB
    try { localStorage.removeItem('espn_crosswalk_' + year); } catch (e) {}
    const allEspnEntries = (raw.teams || []).flatMap(t => t.roster?.entries || []);
    const crosswalk = buildCrosswalk(sleeperPlayers, allEspnEntries, year);

    const mapped = mapToSleeperState(raw, leagueId, year, crosswalk);

    // Fetch transactions — ESPN provides trades via mTransactions2 view.
    // connectLeague() historically left this empty; the provider fills it.
    let txns = [];
    try {
      const txnRaw = await fetchTransactions(leagueId, year, espnS2, swid);
      const topics = txnRaw?.topics || [];
      txns = topics
        .map(t => mapESPNTrade(t))
        .filter(Boolean);
    } catch (e) {
      console.warn('[ESPN] transactions fetch failed:', e?.message || e);
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
  window.App.Platforms.register(EspnProvider);
} else {
  console.warn('[ESPN] platform-provider.js not loaded — provider will not be registered');
}

// ── Expose on window.ESPN ─────────────────────────────────────────
window.ESPN = {
  BASE_URL: ESPN_BASE,
  PRO_TEAM_MAP,
  POSITION_MAP,
  LINEUP_SLOT_MAP,
  ESPN_STAT_MAP,

  // Fetch
  fetchLeague,
  fetchTransactions,

  // Mappers
  mapESPNPlayer,
  mapESPNRoster,
  mapESPNTrade,
  mapESPNSettings,
  mapToSleeperState,

  // Crosswalk
  buildCrosswalk,
  lookupSleeperPlayerId,

  // Main connect (legacy — prefer .provider for new code)
  connectLeague,

  // Unified PlatformProvider interface
  provider: EspnProvider,
};

})();

// ── Module global exports (Vite migration) ───────────────────────────────────
window.ESPNProvider = window.ESPN.provider;
window.espnBuildCrosswalk = window.ESPN.buildCrosswalk;
window.espnLookupSleeperPlayerId = window.ESPN.lookupSleeperPlayerId;
window.espnMapToSleeperState = window.ESPN.mapToSleeperState;
