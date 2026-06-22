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

async function _mflGet(url) {
  const proxyUrl = _getProxyUrl();
  const anonKey  = window.App?.CONFIG?.supabaseAnon || window.OD?.CONFIG?.supabaseAnon || window.OD?.SUPABASE_ANON || window.App?.SUPABASE_ANON;
  const token    = window.OD?.getSessionToken?.() || null;

  // Primary path: Supabase Edge Function proxy. Supabase's gateway requires
  // an Authorization header (verify_jwt defaults to true) — pass the anon
  // key if there's no user session, same pattern as ai-analyze.
  if (proxyUrl && anonKey) {
    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token || anonKey}`,
        'apikey': anonKey,
      },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'MFL proxy error ' + res.status);
    }
    return res.json();
  }

  // Fallback: direct fetch (works on localhost or same-origin)
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('This MFL league is private. Provide your API key to connect.');
    }
    throw new Error('MFL API error ' + res.status + '. Check your League ID and year.');
  }
  return res.json();
}

/**
 * Fetch all data needed to populate window.S.
 * Returns { leagueData, rostersData, playersData }
 */
async function fetchLeague(leagueId, year, apiKey) {
  const [leagueData, rostersData, playersData, rulesData, draftResultsData] = await Promise.all([
    _mflGet(_mflUrl(year, 'league', leagueId, apiKey)),
    _mflGet(_mflUrl(year, 'rosters', leagueId, apiKey)),
    _mflGet(_mflUrl(year, 'players', leagueId, apiKey, 'DETAILS=1')),
    // Scoring rules live in their own export — the league export has none.
    // Non-fatal: a rules failure just leaves scoring_settings sparse.
    _mflGet(_mflUrl(year, 'rules', leagueId, apiKey)).catch(() => null),
    // Draft results carry the seeded board (round1DraftOrder + every slot) even
    // before a single pick is made. We infer pre_draft|drafting|complete from it
    // so the rookie-waiver lock and the live-draft tool both light up for MFL.
    // Non-fatal: a draft fetch failure just means no draft signal.
    _mflGet(_mflUrl(year, 'draftResults', leagueId, apiKey)).catch(() => null),
  ]);
  return { leagueData, rostersData, playersData, rulesData, draftResultsData };
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

  (rosterEntries || []).forEach(entry => {
    const mflId = entry.id;
    if (!mflId) return;
    const pid = (crosswalk && crosswalk[mflId]) ? crosswalk[mflId] : 'mfl_' + mflId;
    players.push(pid);
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

  return {
    league_id: 'mfl_' + leagueId + '_' + year,
    name: lg.name || ('MFL League ' + leagueId),
    total_rosters: franchises.length || parseInt(lg.franchises?.count || 12),
    season: String(year),
    status: 'in_season', // overwritten by mapToSleeperState from the draft state
    settings: { type: 2, player_copies: playerCopies }, // MFL is dynasty-first
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
async function fetchTransactions(leagueId, year, apiKey) {
  try {
    const data = await _mflGet(_mflUrl(year, 'transactions', leagueId, apiKey));
    const txnArr = data?.transactions?.transaction || [];
    const txns = Array.isArray(txnArr) ? txnArr : [txnArr];
    const cw = _crosswalk || {};

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
    console.warn('[MFL] Transaction fetch error:', e);
    return [];
  }
}

/**
 * Fetch MFL draft results and map to Sleeper-compatible format.
 * Handles large drafts (100+ picks for mega-leagues).
 */
async function fetchDraftResults(leagueId, year, apiKey) {
  try {
    const data = await _mflGet(_mflUrl(year, 'draftResults', leagueId, apiKey));
    const units = data?.draftResults?.draftUnit;
    if (!units) return [];
    const unitArr = Array.isArray(units) ? units : [units];
    const cw = _crosswalk || {};
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
  const cw = crosswalk || _crosswalk || {};
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
async function fetchDraftStatus(leagueId, year, apiKey, league, crosswalk) {
  try {
    const data = await _mflGet(_mflUrl(year, 'draftResults', leagueId, apiKey));
    return mapDraftStatus(data, leagueId, year, league, crosswalk) || [];
  } catch (e) {
    console.warn('[MFL] Draft status fetch error:', e);
    return [];
  }
}

// ── Future draft picks (authoritative pick ownership) ─────────────
// TYPE=futureDraftPicks lists, per franchise, the future picks it CURRENTLY owns
// with the pick's round/year and `originalPickFor` (the franchise it started with).
// This is the real, post-trade pick-ownership source — far better than inferring
// from trade transactions (which don't say which round/season/pick moved).
async function fetchFutureDraftPicks(leagueId, year, apiKey) {
  try {
    return await _mflGet(_mflUrl(year, 'futureDraftPicks', leagueId, apiKey));
  } catch (e) {
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
  const cw = crosswalk || _crosswalk || {};
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
async function connectLeague(leagueId, year, apiKey, myFranchiseId) {
  const S = window.S || window.App?.S;
  if (!S) throw new Error('window.S not initialized');

  // ── 1. Fetch MFL data ──
  const raw = await fetchLeague(leagueId, year, apiKey);
  if (!raw?.leagueData?.league) throw new Error('Invalid MFL league data. Check your League ID and year.');

  // ── 2. Build player crosswalk against Sleeper player DB ──
  const mflPlayerArr = raw.playersData?.players?.player || [];
  const allMflPlayers = Array.isArray(mflPlayerArr) ? mflPlayerArr : [mflPlayerArr];
  const crosswalk = buildCrosswalk(S.players || {}, allMflPlayers, year);

  // ── 3. Map MFL data → Sleeper-equivalent format ──
  const { players, rosters, league, leagueUsers, drafts } = mapToSleeperState(raw, leagueId, year, crosswalk);

  // ── 4. Populate window.S ──
  S.platform = 'mfl';
  S.mflLeagueId = String(leagueId);
  S.mflYear = year;
  if (apiKey) S._mflApiKey = apiKey;

  // Merge MFL players into S.players (Sleeper players already present take precedence)
  Object.assign(S.players, players);

  S.rosters = rosters;
  S.leagueUsers = leagueUsers;
  S.bracket = { w: [], l: [] };
  S.matchups = {};
  S.season = String(year);

  // Fetch transactions (non-blocking — don't fail connect). Drafts already came
  // through mapToSleeperState as status-bearing objects (incl. their made picks).
  const txns = await fetchTransactions(leagueId, year, apiKey).catch(() => []);

  // Store transactions keyed by week (consistent with Sleeper format).
  // MFL doesn't expose which week a transaction belongs to, so we bucket
  // every MFL transaction under the current week — that's the key the
  // League screen (ui.js) reads via `S.transactions['w'+S.currentWeek]`.
  const txnsByWeek = {};
  const curWeekKey = 'w' + (S.currentWeek != null ? S.currentWeek : 0);
  txns.forEach(t => { if (!txnsByWeek[curWeekKey]) txnsByWeek[curWeekKey] = []; txnsByWeek[curWeekKey].push(t); });
  S.transactions = txnsByWeek;

  // Real pick ownership from TYPE=futureDraftPicks (post-trade), not inferred
  // from trade transactions.
  const futureRaw = await fetchFutureDraftPicks(leagueId, year, apiKey).catch(() => null);
  S.tradedPicks = mapTradedPicks(futureRaw);
  // Complete future-pick ownership (exact years/rounds) for the Trade Center.
  S._mflFuturePicks = mapFuturePicksByOwner(futureRaw);

  // Status-bearing drafts (pre_draft/drafting/complete) so the live-draft tool
  // and the rookie-waiver lock both engage. Empty array if no draft exists.
  S.drafts = drafts || [];

  S.leagues = [league];
  S.currentLeagueId = league.league_id;

  // ── 5. Find my roster ──
  if (myFranchiseId) {
    const myRoster = rosters.find(r => r.roster_id === String(myFranchiseId));
    S.myRosterId = myRoster?.roster_id || null;
  }

  return { players, rosters, league, leagueUsers, raw };
}

// ── PlatformProvider adapter ──────────────────────────────────────
// Implements the unified PlatformProvider interface (see
// shared/platform-provider.js). War Room's LeagueDetail calls
// provider.hydrate() uniformly across all four platforms instead of
// hand-rolled platform branches.

// Per-session cache of raw fetchLeague payloads keyed by leagueId+year
// so that connect() → hydrate() doesn't re-fetch the same data.
const _rawLeagueStash = {};
function _stashRaw(leagueId, year, raw) {
  _rawLeagueStash[leagueId + '_' + year] = { raw, ts: Date.now() };
}
function _getStashedRaw(leagueId, year) {
  const entry = _rawLeagueStash[leagueId + '_' + year];
  if (!entry) return null;
  // Stale after 5 minutes — force a re-fetch to ensure transactions etc. are fresh
  if (Date.now() - entry.ts > 5 * 60 * 1000) return null;
  return entry.raw;
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
    try {
      const safeCreds = { ...creds };
      delete safeCreds.apiKey;
      localStorage.setItem('mfl_creds_' + leagueKey, JSON.stringify(safeCreds));
      // Legacy keys for backward compat until Phase 3 unification
      if (creds.leagueId) localStorage.setItem('mfl_league_id', String(creds.leagueId));
      if (creds.year) localStorage.setItem('mfl_year', String(creds.year));
      if (creds.apiKey) { sessionStorage.setItem('mfl_api_key', creds.apiKey); localStorage.removeItem('mfl_api_key'); }
    } catch (e) {}
  },
  loadCredentials(leagueKey) {
    try {
      const raw = localStorage.getItem('mfl_creds_' + leagueKey);
      if (raw) {
        const creds = JSON.parse(raw);
        return {
          ...creds,
          apiKey: sessionStorage.getItem('mfl_api_key') || localStorage.getItem('mfl_api_key') || creds.apiKey || null,
        };
      }
    } catch (e) {}
    // Legacy fallback — read the old flat keys
    const id = localStorage.getItem('mfl_league_id');
    if (!id) return null;
    return {
      leagueId: id,
      year: localStorage.getItem('mfl_year') || String(new Date().getFullYear()),
      apiKey: sessionStorage.getItem('mfl_api_key') || localStorage.getItem('mfl_api_key') || null,
    };
  },
  clearCredentials(leagueKey) {
    try {
      localStorage.removeItem('mfl_creds_' + leagueKey);
      sessionStorage.removeItem('mfl_api_key');
      localStorage.removeItem('mfl_api_key');
    } catch (e) {}
  },

  // ── Phase 1: CONNECT ────────────────────────────────────────────
  async connect(creds) {
    const { leagueId, year, apiKey } = creds || {};
    if (!leagueId) throw new Error('MFL league ID required');
    const yr = year || String(new Date().getFullYear());
    const raw = await fetchLeague(leagueId, yr, apiKey || null);
    if (!raw?.leagueData?.league) {
      throw new Error('Invalid MFL league data. Check your League ID and year.');
    }
    // Cache the raw payload so hydrate() can reuse it without re-fetching
    _stashRaw(leagueId, yr, raw);

    const franchises = raw.leagueData.league.franchises?.franchise || [];
    const franchiseArr = Array.isArray(franchises) ? franchises : [franchises];

    return {
      leagues: [{
        id: 'mfl_' + leagueId + '_' + yr,
        name: raw.leagueData.league.name || 'MFL League ' + leagueId,
        season: String(yr),
        _platform: 'mfl',
        _mfl: true,                    // legacy flag for back-compat
        _mflLeagueId: String(leagueId),
        _platformCreds: { leagueId: String(leagueId), year: String(yr), apiKey: apiKey || null },
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
    const creds = league._platformCreds || this.loadCredentials(league.id) || {};
    const leagueId = creds.leagueId || league._mflLeagueId;
    const year = creds.year || league.season || String(new Date().getFullYear());
    const apiKey = creds.apiKey || null;
    if (!leagueId) throw new Error('MFL league credentials missing');

    const context = ctx || {};
    const sleeperPlayers = context.sleeperPlayers || {};
    const currentWeek = context.currentWeek != null ? context.currentWeek : 0;

    // Reuse stashed raw payload if connect() was just called, else fetch fresh
    const raw = _getStashedRaw(leagueId, year) || await fetchLeague(leagueId, year, apiKey);
    if (!raw?.leagueData?.league) throw new Error('MFL league fetch returned no data');

    const mflPlayerArr = raw.playersData?.players?.player || [];
    const allMflPlayers = Array.isArray(mflPlayerArr) ? mflPlayerArr : [mflPlayerArr];

    // Clear any stale (possibly empty) crosswalk cache and rebuild against the
    // real Sleeper player DB. This is the whole reason connect→hydrate is a
    // two-phase split — at connect time the Sleeper DB isn't loaded yet.
    try { localStorage.removeItem('mfl_crosswalk_' + year); } catch (e) {}
    const crosswalk = buildCrosswalk(sleeperPlayers, allMflPlayers, year);

    const mapped = mapToSleeperState(raw, leagueId, year, crosswalk);

    // Fetch transactions + future draft picks (non-blocking — a private league
    // without an API key can still render rosters even if these fail). Drafts
    // already came back from mapToSleeperState as status-bearing objects.
    const [txns, futureRaw] = await Promise.all([
      fetchTransactions(leagueId, year, apiKey).catch(e => {
        console.warn('[MFL] transactions fetch failed:', e?.message || e);
        return [];
      }),
      fetchFutureDraftPicks(leagueId, year, apiKey).catch(() => null),
    ]);

    // Bucket all transactions under the current week key — matches the
    // Sleeper shape that LeagueDetail + free-agency.js + flash-brief.js read.
    const wkKey = 'w' + currentWeek;
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
