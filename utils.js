// ══════════════════════════════════════════════════════════════════
// shared/utils.js — Shared utility functions for Dynasty HQ
// Used by both War Room Scout and War Room
// Requires: shared/constants.js loaded first
// ══════════════════════════════════════════════════════════════════

window.App = window.App || {};

// ── Position normalization ───────────────────────────────────────
// Collapses granular NFL positions into fantasy-relevant groups.
// DE/DT/NT/IDL/EDGE → DL,  CB/S/SS/FS → DB,  OLB/ILB/MLB → LB
function normPos(pos) {
    if (!pos) return null;
    const raw = String(pos).trim().toUpperCase();
    if (!raw) return null;
    if (raw === 'PK')                                         return 'K';   // MFL codes kickers as PK
    if (['DB', 'CB', 'S', 'SS', 'FS'].includes(raw))          return 'DB';
    if (['DL', 'DE', 'DT', 'NT', 'IDL', 'EDGE', 'ED'].includes(raw)) return 'DL'; // 'ED' = scouting CSVs' edge code
    if (['LB', 'OLB', 'ILB', 'MLB'].includes(raw))            return 'LB';
    if (['DEF', 'DST', 'D/ST'].includes(raw))                 return 'DEF';
    return raw; // QB, RB, WR, TE, K, etc.
}

function posLabel(pos) {
    const raw = pos == null ? '' : String(pos);
    const normalized = normPos(pos);
    if (normalized === 'DEF') return 'D/ST';
    return POS_ORDER[normalized] != null ? normalized : raw;
}

// ── Position colors ─────────────────────────────────────────────
// Delegates to App.POS_COLORS (owned by constants.js) so there is
// a single source of truth for position colors across both apps.
// constants.js MUST load before utils.js.
function posColor(pos) {
    return (window.App?.POS_COLORS?.[pos]) || 'var(--silver)';
}

// ── Position sort order ─────────────────────────────────────────
const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DEF: 5, DL: 6, LB: 7, DB: 8 };

// ── Depth chart position list ───────────────────────────────────
const DEPTH_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];

// ── Raw fantasy points from a stats row ─────────────────────────
// If a custom scoring map is provided, dot-product stats × weights.
// Otherwise fall back to pre-computed columns (half → ppr → std).
function calcRawPts(stats, scoring) {
    if (!stats) return null;
    if (scoring) {
        let t = 0;
        for (const [f, w] of Object.entries(scoring)) {
            if (typeof w !== 'number') continue;
            if (stats[f] != null) t += Number(stats[f]) * w;
        }
        return t;
    }
    const p = stats.pts_half_ppr ?? stats.pts_ppr ?? stats.pts_std ?? null;
    return p !== null ? Number(p) : null;
}

// ── Elite player detection (7000+ DHQ OR top-5-at-position) ────
function isElitePlayer(pid) {
  const scores = window.App?.LI?.playerScores || {};
  const meta = window.App?.LI?.playerMeta || {};
  const id = String(pid);
  const score = Number(scores[id] ?? scores[pid] ?? 0);
  if (score >= 7000) return true;
  const pos = normPos(meta[id]?.pos || meta[pid]?.pos || '');
  if (!pos || !score) return false;
  // Get all players at this position, sorted by DHQ.
  const atPos = Object.entries(scores)
    .filter(([p]) => normPos(meta[p]?.pos || '') === pos)
    .sort((a, b) => b[1] - a[1]);
  const rank = atPos.findIndex(([p]) => String(p) === id);
  return rank >= 0 && rank < 5;
}

function countElitePlayers(pids) {
  return (pids || []).filter(pid => isElitePlayer(String(pid))).length;
}

// ── dhqLog — structured error logging ────────────────────────────
// Replaces empty catch(e){} blocks with visible, filterable output.
// Always uses console.warn so errors surface in DevTools without crashing.
function dhqLog(context, err, extra) {
  const tag = `[DHQ:${context}]`;
  if (err instanceof Error) {
    console.warn(tag, err.message, extra !== undefined ? extra : '');
  } else {
    console.warn(tag, err !== undefined ? err : '', extra !== undefined ? extra : '');
  }
  window.DHQBugCapture?.captureError?.(
    err instanceof Error ? err : new Error(String(err || context || 'DHQ log')),
    { source: 'dhqLog', context: String(context || 'unknown') },
    extra
  );
}

// ── Expose on App namespace ─────────────────────────────────────
window.App.normPos            = normPos;
window.App.posLabel           = posLabel;
window.App.posColor           = posColor;
window.App.POS_ORDER          = POS_ORDER;
window.App.DEPTH_POSITIONS    = DEPTH_POSITIONS;
window.App.calcRawPts         = calcRawPts;
window.App.isElitePlayer      = isElitePlayer;
window.App.countElitePlayers  = countElitePlayers;

// ── Expose as bare globals for inline handlers / legacy code ────
window.normPos            = normPos;
window.posLabel           = posLabel;
window.posColor           = posColor;
window.POS_ORDER          = POS_ORDER;
window.DEPTH_POSITIONS    = DEPTH_POSITIONS;
window.calcRawPts         = calcRawPts;
window.isElitePlayer      = isElitePlayer;
window.countElitePlayers  = countElitePlayers;
window.dhqLog             = dhqLog;
window.App.dhqLog         = dhqLog;

// ── League-Aware Position Helper ──
// ONE function that EVERY filter, button list, and pool builder calls.
// No more hardcoded position arrays anywhere.
function getLeaguePositions(opts) {
  opts = opts || {};
  const league = opts.league || window.S?.leagues?.find(l => l.league_id === window.S?.currentLeagueId) || window.S?.league;
  const rp = league?.roster_positions || [];

  // Base offensive positions (always present in fantasy)
  const positions = ['QB', 'RB', 'WR', 'TE'];

  // K — only if league rosters kickers
  if (rp.some(s => normPos(s) === 'K')) positions.push('K');

  // D/ST — Sleeper stores this as DEF; normalize common platform aliases.
  if (rp.some(s => normPos(s) === 'DEF')) positions.push('DEF');

  // IDP — only if league has IDP slots
  if (rp.some(s => ['DL','LB','DB','IDP'].includes(normPos(s)) || String(s || '').toUpperCase() === 'IDP_FLEX')) {
    positions.push('DL', 'LB', 'DB');
  }

  // Return formats based on opts
  if (opts.asSet) return new Set(positions);
  if (opts.withAll) return ['All', ...positions]; // for filter button lists
  if (opts.withBlank) return ['', ...positions];  // for filter with blank = ALL
  return positions;
}

// ── NFL draft-capital position label ────────────────────────────
// Formats a prospect's REAL NFL draft slot as "R{round}.{pickInRound}".
// CSV/Sleeper data store the OVERALL pick (e.g. 33). The in-round slot is
// derived against the 32-team NFL draft — NOT the fantasy league size — so
// pick 33 → R2.01, not "R2.33". The authoritative `round` always fixes the
// round; the ×32 convention is exact for rounds 1-2 (where dynasty capital
// matters) and drifts by the comp-pick count in deep rounds.
// NOTE: this is the NFL draft-capital domain. Fantasy-league draft picks
// (Sleeper pick_no) use league `totalTeams` instead — see league-detail.js.
const NFL_PICKS_PER_ROUND = 32;
function formatNFLDraftSlot(round, overallPick) {
  const rd = Number(round) || 0;
  const overall = Number(overallPick) || 0;
  if (rd <= 0) return overall > 0 ? '#' + overall : '';
  if (overall <= 0) return 'R' + rd;
  const pickInRound = Math.max(1, overall - (rd - 1) * NFL_PICKS_PER_ROUND);
  return 'R' + rd + '.' + String(pickInRound).padStart(2, '0');
}

window.formatNFLDraftSlot = formatNFLDraftSlot;
window.App.formatNFLDraftSlot = formatNFLDraftSlot;

// Also expose a normPos-safe check
function isValidLeaguePosition(pos) {
  const np = typeof normPos === 'function' ? normPos(pos) : pos;
  if (!np) return false;
  return getLeaguePositions({ asSet: true }).has(np);
}

window.getLeaguePositions = getLeaguePositions;
window.isValidLeaguePosition = isValidLeaguePosition;
window.App.getLeaguePositions = getLeaguePositions;
window.App.isValidLeaguePosition = isValidLeaguePosition;

// ── Position GROUP filters (owner ask 2026-07-12) ───────────────
// League-derived flex groupings selectable anywhere positions filter
// (Trade Center asset browser, Free Agency, draft boards). A group only
// exists when the league actually rosters that slot. Group KEYS double as
// their display strings so existing chip renderers need no label map, and
// they can never collide with the 9 normPos position strings.
const FLEX_GROUP_POSITIONS = {
  'FLEX':     ['RB', 'WR', 'TE'],
  'SFLEX':    ['QB', 'RB', 'WR', 'TE'],
  'REC FLEX': ['WR', 'TE'],
  'W/R FLEX': ['RB', 'WR'],
  'IDP FLEX': ['DL', 'LB', 'DB'],
};
function getLeagueFlexGroups(opts) {
  opts = opts || {};
  const league = opts.league || window.S?.leagues?.find(l => l.league_id === window.S?.currentLeagueId) || window.S?.league;
  const up = (league?.roster_positions || league?.rosterPositions || []).map(s => String(s || '').toUpperCase());
  const has = (...names) => names.some(n => up.includes(n));
  const groups = [];
  if (has('FLEX', 'WRRBTE_FLEX', 'WR_RB_TE_FLEX', 'W/R/T')) groups.push('FLEX');
  if (has('SUPER_FLEX', 'SUPERFLEX', 'SF', 'QB_FLEX', 'OP', 'WRTQ')) groups.push('SFLEX');
  if (has('REC_FLEX', 'WR_TE', 'W/T')) groups.push('REC FLEX');
  if (has('WRRB_FLEX', 'WR_RB_FLEX', 'W/R')) groups.push('W/R FLEX');
  if (has('IDP_FLEX', 'IDP')) groups.push('IDP FLEX');
  return groups;
}
// Predicate twin: does a normPos'd position satisfy a filter value that may
// be a plain position OR a flex-group key? Drop-in for `pos === filter`.
function posMatchesFilter(pos, filter) {
  if (!filter || filter === 'ALL' || filter === 'All') return true;
  const group = FLEX_GROUP_POSITIONS[filter];
  return group ? group.indexOf(pos) !== -1 : pos === filter;
}

window.getLeagueFlexGroups = getLeagueFlexGroups;
window.posMatchesFilter = posMatchesFilter;
window.App.FLEX_GROUP_POSITIONS = FLEX_GROUP_POSITIONS;
window.App.getLeagueFlexGroups = getLeagueFlexGroups;
window.App.posMatchesFilter = posMatchesFilter;
