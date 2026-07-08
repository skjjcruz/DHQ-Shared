// ═══════════════════════════════════════════════════════════════
// team-assess.js — Shared Team Assessment Module
// Used by both War Room Scout and War Room
// Consolidates duplicated assessTeam() logic from trade-calc.js
// and the health-score calculation from ui.js
// ═══════════════════════════════════════════════════════════════

window.App = window.App || {};

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // Constants (defaults — overridden dynamically per league)
  // ─────────────────────────────────────────────────────────────

  const DEPTH_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];

  // ─────────────────────────────────────────────────────────────
  // Dynamic builders — derive from league roster_positions
  // ─────────────────────────────────────────────────────────────

  function buildIdealRoster(rosterPositions) {
    const rp = rosterPositions || [];
    const ideal = {};
    const posCount = {};
    rp.forEach(slot => {
      const norm = normPos(slot);
      if (['BN','IR','TAXI'].includes(slot)) return;
      if (!posCount[norm]) posCount[norm] = 0;
      posCount[norm]++;
    });
    Object.entries(posCount).forEach(([pos, count]) => {
      ideal[pos] = Math.max(count, Math.ceil(count * 1.5));
    });
    return ideal;
  }

  function buildMinStarterQuality(rosterPositions) {
    const rp = rosterPositions || [];
    const msq = {};
    const slots = {};
    rp.forEach(slot => {
      if (['BN','IR','TAXI'].includes(slot)) return;
      const n = normPos(slot);
      if (['QB','RB','WR','TE','K','DEF','DL','LB','DB'].includes(n)) {
        slots[n] = (slots[n] || 0) + 1;
      } else if (slot === 'FLEX') { slots.RB = (slots.RB||0)+0.4; slots.WR = (slots.WR||0)+0.4; slots.TE = (slots.TE||0)+0.2; }
      else if (slot === 'SUPER_FLEX') { slots.QB = (slots.QB||0)+0.5; slots.RB = (slots.RB||0)+0.25; slots.WR = (slots.WR||0)+0.25; }
      else if (slot === 'IDP_FLEX') { slots.DL = (slots.DL||0)+0.35; slots.LB = (slots.LB||0)+0.35; slots.DB = (slots.DB||0)+0.3; }
      else if (slot === 'REC_FLEX') { slots.WR = (slots.WR||0)+0.5; slots.TE = (slots.TE||0)+0.5; }
    });
    Object.entries(slots).forEach(([pos, count]) => {
      const rounded = Math.max(1, Math.round(count));
      msq[pos] = Math.max(rounded, Math.ceil(rounded * 1.3));
    });
    return msq;
  }

  function buildPosWeights(rosterPositions) {
    const base = { QB: 14, RB: 14, WR: 14, TE: 8, K: 3, DEF: 3, DL: 13, LB: 10, DB: 12 };
    const rp = rosterPositions || [];
    const hasPos = new Set();
    rp.forEach(slot => {
      const n = normPos(slot);
      if (['QB','RB','WR','TE','K','DEF','DL','LB','DB'].includes(n)) hasPos.add(n);
      if (slot === 'FLEX') { hasPos.add('RB'); hasPos.add('WR'); hasPos.add('TE'); }
      if (slot === 'SUPER_FLEX') { hasPos.add('QB'); hasPos.add('RB'); hasPos.add('WR'); hasPos.add('TE'); }
      if (slot === 'IDP_FLEX') { hasPos.add('DL'); hasPos.add('LB'); hasPos.add('DB'); }
    });
    const weights = {};
    hasPos.forEach(pos => { if (base[pos]) weights[pos] = base[pos]; });
    return weights;
  }

  function buildNflStarterPool(totalTeams) {
    const t = totalTeams || 12;
    return { QB: t, RB: Math.round(t*2.5), WR: Math.round(t*4), TE: t, K: t, DEF: t, DL: Math.round(t*4), LB: Math.round(t*4), DB: Math.round(t*4) };
  }

  const PICK_HORIZON = 3;
  const DRAFT_ROUNDS = 5;

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  /** Normalize position string — complete version matching shared/utils.js */
  function normPos(p) {
    if (!p) return '';
    const raw = String(p).trim().toUpperCase();
    if (['DB', 'CB', 'S', 'SS', 'FS'].includes(raw))          return 'DB';
    if (['DL', 'DE', 'DT', 'NT', 'IDL', 'EDGE'].includes(raw)) return 'DL';
    if (['LB', 'OLB', 'ILB', 'MLB'].includes(raw))            return 'LB';
    if (['DEF', 'DST', 'D/ST'].includes(raw))                 return 'DEF';
    return raw;
  }

  /** Get a player's normalized position from the players map */
  function playerPos(pid, players) {
    return normPos(players[pid]?.position || '');
  }

  /**
   * Get dynasty value for a player.
   * Uses the global dynastyValue() if available, otherwise returns 0.
   */
  function getDynastyValue(pid) {
    if (typeof dynastyValue === 'function') return dynastyValue(pid);
    return 0;
  }

  // ─────────────────────────────────────────────────────────────
  // buildNflStarterSet
  // ─────────────────────────────────────────────────────────────

  /**
   * Rank all players by dynasty value (or season pts), take top N per position.
   * @param {Object} players       - { pid: { position, team, ... } }
   * @param {Object} playerStats   - { pid: { seasonTotal, prevTotal, ... } }
   * @returns {Object}             - { pos: Set<pid> }
   */
  function buildNflStarterSet(players, playerStats, nflStarterPool) {
    const pool = nflStarterPool || buildNflStarterPool(12);
    const nflStarterSet = {};
    const scoreMap = window.App?.LI?.playerScores || window.LI?.playerScores || null;
    const sourceIds = scoreMap ? Object.keys(scoreMap) : Object.keys(players || {});
    // Single pass over the source list, bucketing by position — was 9 full scans
    // (one per DEPTH_POSITION), each re-walking the whole ~2k-12k list and re-
    // sorting. Eligibility/scoring/sort/slice are identical; just hoisted.
    const byPos = {};
    DEPTH_POSITIONS.forEach(pos => { byPos[pos] = []; });
    for (const pid of sourceIds) {
      const p = players[pid];
      if (!p || !p.team) continue; // skip missing / released-cut
      const bucket = byPos[normPos(p.position)];
      if (!bucket) continue;       // not a depth position we track
      // Prefer dynasty value; fall back to season stats
      const val = scoreMap?.[pid] || getDynastyValue(pid);
      const pts = val > 0 ? val : (playerStats?.[pid]?.seasonTotal || playerStats?.[pid]?.prevTotal || 0);
      if (pts > 0) bucket.push({ pid, pts });
    }
    DEPTH_POSITIONS.forEach(pos => {
      const poolSize = pool[pos] || 32;
      byPos[pos].sort((a, b) => b.pts - a.pts);
      nflStarterSet[pos] = new Set(byPos[pos].slice(0, poolSize).map(p => p.pid));
    });
    return nflStarterSet;
  }

  // ─────────────────────────────────────────────────────────────
  // calcOptimalPPG
  // ─────────────────────────────────────────────────────────────

  /**
   * Greedy lineup optimizer — calculates optimal weekly PPG for a roster.
   * @param {Array}  rosterPids      - array of player IDs on the roster
   * @param {Object} players         - { pid: { position, ... } }
   * @param {Object} playerStats     - { pid: { seasonAvg, prevAvg, ... } }
   * @param {Array}  rosterPositions - league roster_positions array (e.g. ['QB','RB','RB','WR','WR','FLEX',...])
   * @returns {number}               - optimal PPG rounded to 1 decimal
   */
  function calcOptimalPPG(rosterPids, players, playerStats, rosterPositions) {
    const rp = rosterPositions || [];
    const slotCounts = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPER_FLEX: 0, DL: 0, LB: 0, DB: 0, IDP_FLEX: 0 };
    rp.forEach(s => {
      if (s === 'DE' || s === 'DT') slotCounts.DL++;
      else if (s === 'CB' || s === 'S') slotCounts.DB++;
      else if (s in slotCounts) slotCounts[s]++;
      else if (s === 'REC_FLEX') slotCounts.FLEX++;
      else if (s === 'BN' || s === 'IR' || s === 'TAXI') { /* skip */ }
      else slotCounts.FLEX++;
    });

    const byPos = {};
    (rosterPids || []).forEach(pid => {
      const pos = playerPos(pid, players);
      const ppg = playerStats?.[pid]?.seasonAvg || playerStats?.[pid]?.prevAvg || 0;
      if (ppg <= 0) return;
      if (!byPos[pos]) byPos[pos] = [];
      byPos[pos].push({ pid, ppg, pos });
    });
    Object.values(byPos).forEach(arr => arr.sort((a, b) => b.ppg - a.ppg));

    const used = new Set();
    let total = 0;

    // Fill positional slots
    ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB', 'K', 'DEF'].forEach(pos => {
      const need = slotCounts[pos] || 0;
      const avail = byPos[pos] || [];
      for (let i = 0; i < need && i < avail.length; i++) {
        total += avail[i].ppg;
        used.add(avail[i].pid);
      }
    });

    // FLEX slots (RB/WR/TE)
    const flexPool = ['RB', 'WR', 'TE']
      .flatMap(pos => (byPos[pos] || []).filter(p => !used.has(p.pid)))
      .sort((a, b) => b.ppg - a.ppg);
    for (let i = 0; i < (slotCounts.FLEX || 0) && i < flexPool.length; i++) {
      total += flexPool[i].ppg;
      used.add(flexPool[i].pid);
    }

    // SUPER_FLEX slots (QB/RB/WR/TE)
    const sfPool = ['QB', 'RB', 'WR', 'TE']
      .flatMap(pos => (byPos[pos] || []).filter(p => !used.has(p.pid)))
      .sort((a, b) => b.ppg - a.ppg);
    for (let i = 0; i < (slotCounts.SUPER_FLEX || 0) && i < sfPool.length; i++) {
      total += sfPool[i].ppg;
      used.add(sfPool[i].pid);
    }

    // IDP_FLEX slots (DL/LB/DB)
    const idpPool = ['DL', 'LB', 'DB']
      .flatMap(pos => (byPos[pos] || []).filter(p => !used.has(p.pid)))
      .sort((a, b) => b.ppg - a.ppg);
    for (let i = 0; i < (slotCounts.IDP_FLEX || 0) && i < idpPool.length; i++) {
      total += idpPool[i].ppg;
      used.add(idpPool[i].pid);
    }

    return +total.toFixed(1);
  }

  // ─────────────────────────────────────────────────────────────
  // buildPicksByOwner (internal helper)
  // ─────────────────────────────────────────────────────────────

  /**
   * True once every draft for the given season has completed — i.e. "the draft
   * is over", so that season's picks are spent and must drop off the trade
   * calculator. Draft objects come from the league (MFL hydrates them) or the
   * global S state (Sleeper). Requires at least one draft so "no drafts yet" is
   * never read as complete, and every() so a rookie+supplemental pair doesn't
   * drop the year while one is still pending.
   */
  function seasonDraftComplete(leagueInfo, curYear) {
    const fromLeague = Array.isArray(leagueInfo?.drafts) ? leagueInfo.drafts : null;
    const globalS = (typeof S !== 'undefined' && S) || (typeof window !== 'undefined' && window.S) || null;
    const drafts = fromLeague || (Array.isArray(globalS?.drafts) ? globalS.drafts : []);
    const seasonDrafts = drafts.filter(d => parseInt(d?.season) === curYear);
    return seasonDrafts.length > 0 && seasonDrafts.every(d => String(d?.status || '').toLowerCase() === 'complete');
  }

  /**
   * The tradeable pick window — the next PICK_HORIZON draft seasons, rolled
   * forward past any season whose draft has already finished (e.g. after the
   * 2026 draft completes: 2027/2028/2029 instead of 2026/2027/2028).
   */
  function tradeablePickYears(leagueInfo, curYear) {
    const start = curYear + (seasonDraftComplete(leagueInfo, curYear) ? 1 : 0);
    return Array.from({ length: PICK_HORIZON }, (_, i) => start + i);
  }

  /**
   * Build picks owned by each roster.
   * @param {Array}  rosters     - league rosters array
   * @param {Object} leagueInfo  - league object (settings.draft_rounds, season)
   * @param {Array}  tradedPicks - traded picks array from Sleeper
   * @returns {Object}           - { rosterId: [{year, round, originalOwnerRid}] }
   */
  function buildPicksByOwner(rosters, leagueInfo, tradedPicks) {
    const draftRounds = leagueInfo?.settings?.draft_rounds || DRAFT_ROUNDS;
    const curYear = parseInt(leagueInfo?.season) || new Date().getFullYear();
    const years = tradeablePickYears(leagueInfo, curYear);
    const allTP = tradedPicks || [];
    const result = {};

    // Index traded picks ONCE instead of scanning allTP with .find + .filter for
    // every (roster × year × round) cell. A pick only matters when it changed
    // hands (owner_id !== roster_id) — that single guard feeds both lookups:
    //   awayKeys:     season|round|roster_id  → this owner dealt the pick away
    //   acquiredByKey season|round|owner_id   → [originalOwnerRid, ...] acquired
    // Rounds are matched strictly (=== a number) just as before, so non-numeric
    // rounds (which the old === never matched) are skipped here too.
    const awayKeys = new Set();
    const acquiredByKey = new Map();
    for (const p of allTP) {
      if (p.owner_id === p.roster_id) continue;
      if (typeof p.round !== 'number') continue;
      const season = parseInt(p.season);
      awayKeys.add(season + '|' + p.round + '|' + p.roster_id);
      const k = season + '|' + p.round + '|' + p.owner_id;
      let list = acquiredByKey.get(k);
      if (!list) { list = []; acquiredByKey.set(k, list); }
      list.push(p.roster_id);
    }

    (rosters || []).forEach(r => {
      const rid = r.roster_id;
      result[rid] = [];
      years.forEach(yr => {
        for (let rd = 1; rd <= draftRounds; rd++) {
          // Own original pick — unless it was dealt away
          if (!awayKeys.has(yr + '|' + rd + '|' + rid)) {
            result[rid].push({ year: yr, round: rd, originalOwnerRid: rid });
          }
          // Acquired picks for this slot
          const acq = acquiredByKey.get(yr + '|' + rd + '|' + rid);
          if (acq) {
            for (const originalOwnerRid of acq) {
              result[rid].push({ year: yr, round: rd, originalOwnerRid });
            }
          }
        }
      });
    });
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // assessTeam
  // ─────────────────────────────────────────────────────────────

  /**
   * Assess a single team. Returns a full assessment object.
   *
   * @param {Object} roster         - Sleeper roster object
   * @param {Object} players        - { pid: { position, team, ... } }
   * @param {Object} playerStats    - { pid: { seasonAvg, prevAvg, seasonTotal, prevTotal, ... } }
   * @param {Object} leagueInfo     - league object (settings, roster_positions, season)
   * @param {Array}  leagueUsers    - array of Sleeper user objects
   * @param {Object} nflStarterSet  - { pos: Set<pid> } from buildNflStarterSet()
   * @param {Array}  ownerPicks     - [{year, round, originalOwnerRid}] for this roster
   * @param {Array}  [allRosters]   - all rosters (reserved for future use)
   * @returns {Object}              - full assessment object
   */
  function assessTeam(roster, players, playerStats, leagueInfo, leagueUsers, nflStarterSet, ownerPicks, allRosters, dynamicConfig) {
    const _cfg = dynamicConfig || {};
    const IDEAL_ROSTER = _cfg.idealRoster || buildIdealRoster(leagueInfo?.roster_positions);
    const MIN_STARTER_QUALITY = _cfg.minStarterQuality || buildMinStarterQuality(leagueInfo?.roster_positions);
    const POS_WEIGHTS = _cfg.posWeights || buildPosWeights(leagueInfo?.roster_positions);
    const TOTAL_WEIGHT = Object.values(POS_WEIGHTS).reduce((a, b) => a + b, 0);
    const WEEKLY_TARGET = _cfg.weeklyTarget || 150;
    const leaguePositions = new Set(Object.keys(POS_WEIGHTS));
    const users = leagueUsers || [];
    const user = users.find(u => u.user_id === roster.owner_id);
    const teamName  = user?.metadata?.team_name || user?.display_name || `Team ${roster.roster_id}`;
    const ownerName = user?.display_name || `Owner ${roster.roster_id}`;
    const avatar    = user?.avatar || null;

    const wins   = roster.settings?.wins   || 0;
    const losses = roster.settings?.losses || 0;
    const ties   = roster.settings?.ties   || 0;
    const pf     = Number(roster.settings?.fpts || 0) + Number(roster.settings?.fpts_decimal || 0) / 100;

    const waiverBudget  = Number(leagueInfo?.settings?.waiver_budget || 100);
    const waiverUsed    = Number(roster.settings?.waiver_budget_used || 0);
    const faabRemaining = Math.max(0, waiverBudget - waiverUsed);
    const faabMinBid    = Number(leagueInfo?.settings?.waiver_budget_min || 0);

    // Group players by normalized position
    const posGroups = {};
    for (const id of (roster.players || [])) {
      const np = normPos(players[id]?.position);
      if (!np) continue;
      if (!posGroups[np]) posGroups[np] = [];
      posGroups[np].push(id);
    }

    // Assess each position — only positions that exist in the league
    const posAssessment = {};
    for (const [pos, ideal] of Object.entries(IDEAL_ROSTER)) {
      if (!leaguePositions.has(pos)) continue; // skip positions not in this league
      const playerIds   = posGroups[pos] || [];
      const startingReq = MIN_STARTER_QUALITY[pos] || 1;
      const actual      = playerIds.length;
      const diff        = actual - ideal;

      // NFL-starter count
      const posStarters   = nflStarterSet[pos] || new Set();
      const nflStarterIds = playerIds.filter(id => posStarters.has(id));
      const nflStarters   = nflStarterIds.length;
      const minQuality    = MIN_STARTER_QUALITY[pos] || startingReq;

      // Projected PPG from starters
      const withPPG = playerIds
        .map(id => ({ id, ppg: playerStats?.[id]?.seasonAvg || playerStats?.[id]?.prevAvg || 0 }))
        .sort((a, b) => b.ppg - a.ppg);
      const projectedPts = withPPG.slice(0, startingReq).reduce((s, p) => s + p.ppg, 0);

      // Status determination — dynamic based on minQuality from league config
      let status;
      if (nflStarters === 0) {
        status = 'deficit';
      } else if (nflStarters < minQuality) {
        status = 'thin';
      } else if (nflStarters >= minQuality && actual >= ideal) {
        status = 'surplus';
      } else {
        status = 'ok';
      }

      // Depth override
      if ((status === 'ok' || status === 'surplus') && actual < ideal) {
        status = 'thin';
      }

      // Sort display order by dynasty value
      const sortedIds = [...playerIds]
        .map(id => ({ id, score: getDynastyValue(id) }))
        .sort((a, b) => b.score - a.score)
        .map(p => p.id);

      posAssessment[pos] = { actual, ideal, diff, nflStarters, nflStarterIds, sortedIds, startingReq, minQuality, projectedPts, status };
    }

    // Draft picks assessment
    const leagueSeason = parseInt(leagueInfo?.season || new Date().getFullYear());
    const draftRounds  = leagueInfo?.settings?.draft_rounds || DRAFT_ROUNDS;
    const pickYears    = tradeablePickYears(leagueInfo, leagueSeason).map(String);

    const pickCountByRound     = {};
    const pickCountByYear      = {};
    const pickCountByYearRound = {};
    for (let r = 1; r <= draftRounds; r++) pickCountByRound[r] = 0;
    for (const year of pickYears) {
      pickCountByYear[year] = 0;
      pickCountByYearRound[year] = {};
      for (let r = 1; r <= draftRounds; r++) pickCountByYearRound[year][r] = 0;
    }
    const myPicks = ownerPicks || [];
    for (const { year, round } of myPicks) {
      const y = String(year);
      if (!pickYears.includes(y)) continue;
      if (round < 1 || round > draftRounds) continue;
      pickCountByRound[round] = (pickCountByRound[round] || 0) + 1;
      pickCountByYear[y] = (pickCountByYear[y] || 0) + 1;
      if (pickCountByYearRound[y]) pickCountByYearRound[y][round] = (pickCountByYearRound[y][round] || 0) + 1;
    }
    const totalPicks    = Object.values(pickCountByRound).reduce((a, b) => a + b, 0);
    const roundsMissing = Object.values(pickCountByRound).filter(c => c === 0).length;
    const pickIdeal     = PICK_HORIZON * draftRounds;
    let picksStatus;
    if      (totalPicks === 0)         picksStatus = 'deficit';
    else if (totalPicks < pickIdeal)   picksStatus = 'thin';
    else if (totalPicks === pickIdeal) picksStatus = 'ok';
    else                               picksStatus = 'surplus';
    const picksAssessment = { pickCountByRound, pickCountByYear, pickCountByYearRound, totalPicks, draftRounds, idealTotal: pickIdeal, pickYears, roundsMissing, status: picksStatus };

    // Optimal weekly scoring
    const rosterPositions = leagueInfo?.roster_positions || [];
    let weeklyPts = calcOptimalPPG(roster.players || [], players, playerStats, rosterPositions);

    // Offseason fallback: if no stats available, estimate weekly PPG from DHQ values
    // A roster with 87K total DHQ should project ~150+ PPG, not 0
    if (weeklyPts <= 0) {
      const totalDHQ = (roster.players || []).reduce((s, pid) => s + getDynastyValue(pid), 0);
      // Rough mapping: 80K DHQ ≈ 140 PPG, 100K DHQ ≈ 170 PPG (based on typical correlation)
      weeklyPts = totalDHQ > 0 ? Math.round(totalDHQ / 550) : 0;
    }

    // Health score: 60% scoring + 40% coverage
    const scoringScore = Math.min(60, (weeklyPts / WEEKLY_TARGET) * 60);
    let coverageScore  = 0;
    const hasValueData = Object.keys(nflStarterSet).length > 0;
    for (const [pos, data] of Object.entries(posAssessment)) {
      const ratio = hasValueData
        ? Math.min(1, data.nflStarters / (data.minQuality || data.startingReq || 1))
        : Math.min(1, data.actual / data.ideal);
      coverageScore += ratio * ((POS_WEIGHTS[pos] || 0) / TOTAL_WEIGHT) * 40;
    }
    const projBonus   = weeklyPts > WEEKLY_TARGET + 10 ? 3 : weeklyPts >= WEEKLY_TARGET ? 1 : 0;
    const healthScore = Math.min(100, Math.round(scoringScore + coverageScore + projBonus));

    // Tier classification — driven by health score for balanced distribution
    let tier, tierColor, tierBg;
    if (healthScore >= 90) { tier = 'ELITE';      tierColor = '#D4AF37'; tierBg = 'rgba(212,175,55,0.15)'; }
    else if (healthScore >= 80) { tier = 'CONTENDER';  tierColor = '#2ECC71'; tierBg = 'rgba(46,204,113,0.12)'; }
    else if (healthScore >= 70) { tier = 'CROSSROADS'; tierColor = '#F0A500'; tierBg = 'rgba(240,165,0,0.12)'; }
    else                         { tier = 'REBUILDING'; tierColor = '#E74C3C'; tierBg = 'rgba(231,76,60,0.12)'; }

    // Panic meter (0-5)
    let panic = 0;
    if      (weeklyPts > 0 && weeklyPts < WEEKLY_TARGET * 0.85) panic += 2;
    else if (weeklyPts > 0 && weeklyPts < WEEKLY_TARGET)        panic += 1;
    const criticals = Object.values(posAssessment).filter(p => p.status === 'deficit').length;
    if      (criticals >= 3) panic += 2;
    else if (criticals >= 1) panic += 1;
    const played = wins + losses + ties;
    if (played > 0 && losses / played > 0.6) panic += 1;
    panic = Math.min(5, panic);

    // Trade window
    let tradeWindow;
    if      (tier === 'ELITE' || (tier === 'CONTENDER' && panic <= 1)) tradeWindow = 'CONTENDING';
    else if (tier === 'REBUILDING')                                     tradeWindow = 'REBUILDING';
    else                                                                tradeWindow = 'TRANSITIONING';

    const needs = Object.entries(posAssessment)
      .filter(([, v]) => v.status === 'deficit' || v.status === 'thin')
      .sort((a, b) => {
        const aGap = a[1].nflStarters - a[1].startingReq;
        const bGap = b[1].nflStarters - b[1].startingReq;
        return aGap !== bGap ? aGap - bGap : a[1].diff - b[1].diff;
      })
      .map(([pos, v]) => ({ pos, urgency: v.status }));

    const strengths = Object.entries(posAssessment)
      .filter(([, v]) => v.status === 'surplus')
      .map(([pos]) => pos);

    return {
      rosterId: roster.roster_id, ownerId: roster.owner_id,
      teamName, ownerName, avatar,
      wins, losses, ties, pf,
      posGroups, posAssessment, picksAssessment,
      weeklyPts, healthScore,
      tier, tierColor, tierBg,
      panic, window: tradeWindow,
      needs, strengths,
      faabRemaining, waiverBudget, faabMinBid,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // assessAllTeams
  // ─────────────────────────────────────────────────────────────

  /**
   * Convenience wrapper — assess all teams in the league.
   *
   * @param {Array}  rosters      - all league rosters
   * @param {Object} players      - { pid: { position, team, ... } }
   * @param {Object} playerStats  - { pid: { seasonAvg, prevAvg, seasonTotal, prevTotal, ... } }
   * @param {Object} leagueInfo   - league object
   * @param {Array}  leagueUsers  - array of Sleeper user objects
   * @param {Array}  tradedPicks  - traded picks array
   * @returns {Array}             - array of assessment objects
   */
  function assessAllTeams(rosters, players, playerStats, leagueInfo, leagueUsers, tradedPicks) {
    const rosterPositions = leagueInfo?.roster_positions || [];
    const totalTeams = (rosters || []).length;
    const nflStarterPool = buildNflStarterPool(totalTeams);
    const nflStarterSet = buildNflStarterSet(players, playerStats, nflStarterPool);
    const picksByOwner  = buildPicksByOwner(rosters, leagueInfo, tradedPicks);

    // Compute WEEKLY_TARGET from league data — median of all teams' optimal PPG
    const allPPGs = (rosters || []).map(r => calcOptimalPPG(r.players || [], players, playerStats, rosterPositions)).filter(v => v > 0);
    const WEEKLY_TARGET_DYN = allPPGs.length ? allPPGs.sort((a,b) => a-b)[Math.floor(allPPGs.length/2)] * 1.05 : 150;

    // Build dynamic config from league settings
    const dynamicConfig = {
      idealRoster: buildIdealRoster(rosterPositions),
      minStarterQuality: buildMinStarterQuality(rosterPositions),
      posWeights: buildPosWeights(rosterPositions),
      weeklyTarget: WEEKLY_TARGET_DYN,
    };

    return (rosters || []).map(r => {
      const ownerPicks = picksByOwner[r.roster_id] || [];
      return assessTeam(r, players, playerStats, leagueInfo, leagueUsers, nflStarterSet, ownerPicks, rosters, dynamicConfig);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Convenience wrappers — read from War Room Scout globals
  // ─────────────────────────────────────────────────────────────

  /**
   * Build NFL starter set from War Room Scout globals.
   */
  // ── Memoization for the FromGlobal wrappers ──────────────────────
  // assessAllTeams rebuilds the NFL starter set, picks-by-owner, and the
  // league-median weekly target, then assesses every roster — all O(teams²·
  // players)-ish. The FromGlobal wrappers were re-running ALL of it on each
  // call: ReconAI's League Intel panel calls them ~4× per render and the Trade
  // Builder hits the baseline assessment on every asset toggle. Memoize on a
  // cheap signature of the inputs that actually change an assessment: the
  // league, the LI score build, traded-pick count, and each roster's player set
  // (so a 1-for-1 trade — which leaves counts unchanged — still invalidates).
  let _assessCache = { sig: null, all: null, byId: null };
  let _starterSetCache = { sig: null, set: null };

  function _assessSig() {
    const S = window.S || window.App?.S || {};
    const LI = window.App?.LI || window.LI || {};
    const rosters = S.rosters || [];
    let fp = '';
    for (const r of rosters) fp += r.roster_id + ':' + ((r.players || []).join('.')) + ';';
    return (S.currentLeagueId || '') + '|' + (LI.builtAt || '') + '|tp' + ((S.tradedPicks || []).length) + '|' + fp;
  }

  function buildNflStarterSetFromGlobal() {
    const S = window.S || window.App?.S;
    if (!S?.players) return {};
    const sig = _assessSig();
    if (_starterSetCache.sig === sig && _starterSetCache.set) return _starterSetCache.set;
    const totalTeams = (S.rosters || []).length;
    const nflStarterPool = buildNflStarterPool(totalTeams);
    const set = buildNflStarterSet(S.players, S.playerStats, nflStarterPool);
    _starterSetCache = { sig, set };
    return set;
  }

  /**
   * Assess all teams using War Room Scout globals.
   * @returns {Array} - array of assessment objects, or [] if data not loaded
   */
  function assessAllTeamsFromGlobal() {
    const S = window.S || window.App?.S;
    if (!S?.rosters?.length) return [];
    const sig = _assessSig();
    if (_assessCache.sig === sig && _assessCache.all) return _assessCache.all;
    const league = S.leagues?.find(l => l.league_id === S.currentLeagueId);
    const all = assessAllTeams(S.rosters, S.players, S.playerStats, league, S.leagueUsers, S.tradedPicks);
    const byId = new Map(all.map(a => [a.rosterId, a]));
    _assessCache = { sig, all, byId };
    return all;
  }

  /**
   * Assess a single team by roster ID using War Room Scout globals.
   * Served from the memoized all-teams pass — the per-roster inputs (starter
   * set, picks, weekly target) are identical, so the single-team result equals
   * that roster's entry in assessAllTeams. Avoids rebuilding the league-wide
   * intermediates on every call.
   * @param {number} rosterId - the roster_id to assess
   * @returns {Object|null}   - assessment object or null
   */
  function assessTeamFromGlobal(rosterId) {
    const S = window.S || window.App?.S;
    if (!S?.rosters?.length) return null;
    const sig = _assessSig();
    if (!(_assessCache.sig === sig && _assessCache.byId)) {
      assessAllTeamsFromGlobal(); // (re)builds and caches the full pass
    }
    return (_assessCache.byId && _assessCache.byId.get(rosterId)) || null;
  }

  // ─────────────────────────────────────────────────────────────
  // getPlayerAction — single source of truth for BUY/SELL/HOLD
  // ─────────────────────────────────────────────────────────────

  /**
   * Returns a dynasty action recommendation for a player.
   * Considers: age vs peak window, DHQ value, trend, positional surplus/deficit,
   * contender/rebuilder status, and ownership.
   *
   * @param {string} pid - player ID
   * @returns {{ action: string, label: string, reason: string, col: string, bg: string }}
   */
  function getPlayerAction(pid) {
    const S = window.S || window.App?.S || {};
    const LI = window.App?.LI || {};
    const meta = LI.playerMeta?.[pid];
    const val = (typeof getDynastyValue === 'function') ? getDynastyValue(pid) :
                (typeof dynastyValue === 'function') ? dynastyValue(pid) :
                (LI.playerScores?.[pid] || 0);

    if (!meta || val <= 0) return { action: 'HOLD', label: 'Hold', reason: 'Not enough data', col: 'var(--accent)', bg: 'var(--accentL)' };

    const peakYrsLeft = meta.peakYrsLeft || 0;
    const trend = meta.trend || 0;
    const pos = meta.pos || playerPos(pid, S.players || {});
    const curve = window.App?.ageCurveWindows?.[pos];
    const declineEnd = meta.declineEnd || curve?.decline?.[1] || (window.App?.peakWindows?.[pos]?.[1] || 29);
    const valueYrsLeft = meta.age ? Math.max(0, declineEnd - meta.age) : peakYrsLeft;

    // Ownership check
    const myRoster = S.rosters?.find(r =>
      r.owner_id === (S.myUserId || S.user?.user_id) ||
      (r.co_owners || []).includes(S.myUserId || S.user?.user_id)
    );
    const isOwned = (myRoster?.players || []).map(String).includes(String(pid));

    // Positional context (surplus/deficit)
    let posSurplus = 0;
    if (isOwned && myRoster && S.players) {
      const myPlayers = myRoster.players || [];
      const league = S.leagues?.find(l => l.league_id === S.currentLeagueId);
      const rp = league?.roster_positions || [];
      const posCount = myPlayers.filter(p => playerPos(p, S.players) === pos).length;
      const slotsNeeded = rp.filter(s =>
        normPos(s) === pos ||
        (s === 'FLEX' && ['RB','WR','TE'].includes(pos)) ||
        (s === 'SUPER_FLEX' && ['QB','RB','WR','TE'].includes(pos)) ||
        (s === 'IDP_FLEX' && ['DL','LB','DB'].includes(pos)) ||
        (s === 'REC_FLEX' && ['WR','TE'].includes(pos))
      ).length;
      posSurplus = posCount - Math.max(1, Math.round(slotsNeeded));
    }

    // Base verdict — the strategy-blind age/value/trend read (unchanged chain).
    function baseAction() {
      // Rookie stash
      if (meta.source === 'FC_ROOKIE') return { action: 'STASH', label: 'Stash', reason: 'Incoming rookie — hold and develop', col: 'var(--blue)', bg: 'var(--blueL)' };

      // Elite cornerstone
      const _isElite = typeof window.App?.isElitePlayer === 'function' ? window.App.isElitePlayer(pid) : val >= 7000;
      if (_isElite && peakYrsLeft >= 3) return { action: 'CORE', label: 'Build Around', reason: 'Elite value with ' + peakYrsLeft + ' peak years left', col: 'var(--green)', bg: 'var(--greenL)' };

      // Rising buy target
      if (peakYrsLeft >= 4 && trend >= 10 && !isOwned) return { action: 'BUY', label: 'Buy', reason: 'Trending up (+' + trend + '%) with ' + peakYrsLeft + ' peak years ahead', col: 'var(--green)', bg: 'var(--greenL)' };
      if (peakYrsLeft >= 4 && trend >= 10 && isOwned) return { action: 'HOLD', label: 'Hold', reason: 'Rising asset — keep and ride the wave', col: 'var(--green)', bg: 'var(--greenL)' };

      // Sell high window — near end of peak, still has value
      if (peakYrsLeft > 0 && peakYrsLeft <= 1 && val >= 3000) return { action: 'SELL_HIGH', label: 'Sell High', reason: '1 peak year left — sell while value holds', col: 'var(--amber)', bg: 'var(--amberL)' };

      // Past elite peak but still inside the valuable decline band
      if (peakYrsLeft <= 0 && valueYrsLeft > 0 && trend <= -10) return { action: 'SELL_HIGH', label: 'Sell High', reason: 'Veteran decline band and production slipping', col: 'var(--amber)', bg: 'var(--amberL)' };
      if (peakYrsLeft <= 0 && valueYrsLeft > 0) return { action: 'HOLD', label: 'Hold', reason: valueYrsLeft + ' value year' + (valueYrsLeft > 1 ? 's' : '') + ' left in veteran band', col: 'var(--amber)', bg: 'var(--amberL)' };

      // Past valuable window
      if (valueYrsLeft <= 0 && trend <= -10) return { action: 'SELL', label: 'Sell', reason: 'Past value window and declining (' + trend + '%)', col: 'var(--red)', bg: 'var(--redL)' };
      if (valueYrsLeft <= 0) return { action: 'SELL', label: 'Sell', reason: 'Past value window — trade while value remains', col: 'var(--red)', bg: 'var(--redL)' };

      // Near peak end with declining trend
      if (peakYrsLeft <= 2 && trend <= -10) return { action: 'SELL_HIGH', label: 'Sell High', reason: 'Window closing and production declining', col: 'var(--amber)', bg: 'var(--amberL)' };

      // Solid hold — in peak with good value
      if (peakYrsLeft >= 2 && val >= 4000) return { action: 'HOLD', label: 'Hold', reason: peakYrsLeft + ' peak years left at starter value', col: 'var(--accent)', bg: 'var(--accentL)' };

      // Low value stash with upside
      if (val < 2000 && peakYrsLeft >= 3) return { action: 'STASH', label: 'Stash', reason: 'Low value but ' + peakYrsLeft + ' peak years ahead', col: 'var(--blue)', bg: 'var(--blueL)' };

      // Buy candidate (not owned, has peak years)
      if (!isOwned && peakYrsLeft >= 2 && val < 5000) return { action: 'BUY', label: 'Buy', reason: 'Undervalued with ' + peakYrsLeft + ' peak years remaining', col: 'var(--green)', bg: 'var(--greenL)' };

      // Default hold
      if (peakYrsLeft >= 1) return { action: 'HOLD', label: 'Hold', reason: peakYrsLeft + ' peak year' + (peakYrsLeft > 1 ? 's' : '') + ' remaining', col: 'var(--accent)', bg: 'var(--accentL)' };

      return { action: 'SELL', label: 'Sell', reason: 'Past prime — move for future assets', col: 'var(--red)', bg: 'var(--redL)' };
    }

    const base = baseAction();

    // ── GM Strategy layer ─────────────────────────────────────────
    // Shifts the verdict at the SOURCE so every consumer (roster rows,
    // player quick-card, player modal) converges on one answer. Guarded:
    // team-assess also runs in embeds where gm-mode.js isn't loaded, and
    // it stays inert until a strategy has actually been saved. Tier-neutral
    // at the engine level — render seams keep their own Pro gates. Every
    // strategy-shifted verdict carries a 'GM plan: …' reason so surfaces
    // can show WHY the call moved.
    let gmFx = null;
    try {
      if (typeof window.WR?.GmMode?.effects === 'function') {
        const fx = window.WR.GmMode.effects(S.currentLeagueId);
        if (fx && fx.hasStrategy) gmFx = fx;
      }
    } catch (e) { /* gm-mode optional */ }
    if (!gmFx) return base;

    const age = meta.age || 0;
    const posKey = String(pos || '');

    // (a) Untouchable — never advise selling a protected player.
    if (isOwned && gmFx.untouchable && gmFx.untouchable.has(String(pid))) {
      if (/^SELL/.test(base.action)) {
        return { action: 'HOLD', label: 'Hold', reason: 'GM plan: untouchable — shielded from sell calls', col: 'var(--accent)', bg: 'var(--accentL)' };
      }
      return base;
    }

    // (b) Sell steer — sell positions and parsed sell rules flip soft
    // owned verdicts (Hold/Stash) to Sell. CORE/BUY/SELL* stay as-is.
    if (isOwned && (base.action === 'HOLD' || base.action === 'STASH')) {
      if (gmFx.sellPositions && gmFx.sellPositions.has(posKey)) {
        return { action: 'SELL', label: 'Sell', reason: 'GM plan: ' + posKey + ' is flagged to move', col: 'var(--red)', bg: 'var(--redL)' };
      }
      const parseRule = window.GMStrategy && window.GMStrategy.parseSellRule;
      const ruleHit = (gmFx.sellRules || []).map(r => {
        try { return parseRule ? parseRule(r) : null; } catch (e) { return null; }
      }).find(r => r && (r.pos || r.ageAbove) && (!r.pos || r.pos === posKey) && (!r.ageAbove || (age && age >= r.ageAbove)));
      if (ruleHit) {
        return { action: 'SELL', label: 'Sell', reason: 'GM plan: sell rule — ' + (ruleHit.pos || posKey) + (ruleHit.ageAbove ? ' age ' + ruleHit.ageAbove + '+' : ''), col: 'var(--red)', bg: 'var(--redL)' };
      }
    }

    // (c) Mode shifts — the chosen plan tilts borderline verdicts.
    if (gmFx.mode === 'rebuild') {
      // Lower the sell bar for aging / declining veterans.
      if (isOwned && base.action === 'HOLD' && peakYrsLeft <= 0 && (age >= 27 || trend <= -10)) {
        return { action: 'SELL_HIGH', label: 'Sell High', reason: 'GM plan: Rebuild — move veteran value while it holds', col: 'var(--amber)', bg: 'var(--amberL)' };
      }
      // Upgrade Stash weighting for young, still-cheap holds.
      if (isOwned && base.action === 'HOLD' && peakYrsLeft >= 3 && val < 4000) {
        return { action: 'STASH', label: 'Stash', reason: 'GM plan: Rebuild — develop ' + peakYrsLeft + ' peak years of upside', col: 'var(--blue)', bg: 'var(--blueL)' };
      }
    } else if (gmFx.mode === 'win_now') {
      // Proven producers become Buy targets.
      if (!isOwned && base.action === 'HOLD' && val >= 4000) {
        return { action: 'BUY', label: 'Buy', reason: 'GM plan: Win Now — proven production upgrades this lineup', col: 'var(--green)', bg: 'var(--greenL)' };
      }
      // Far-future development stashes become sell candidates (real rookies
      // keep their Stash — incoming picks aren't tradeable production yet).
      if (isOwned && base.action === 'STASH' && meta.source !== 'FC_ROOKIE') {
        return { action: 'SELL', label: 'Sell', reason: 'GM plan: Win Now — flip developmental stashes for immediate help', col: 'var(--red)', bg: 'var(--redL)' };
      }
    }

    return base;
  }

  // ─────────────────────────────────────────────────────────────
  // Expose on window.App and window
  // ─────────────────────────────────────────────────────────────

  // Constants & builders
  window.App.DEPTH_POSITIONS      = DEPTH_POSITIONS;
  window.App.PICK_HORIZON         = PICK_HORIZON;
  window.App.DRAFT_ROUNDS_DEFAULT = DRAFT_ROUNDS;
  window.App.buildIdealRoster         = buildIdealRoster;
  window.App.buildMinStarterQuality   = buildMinStarterQuality;
  window.App.buildPosWeights          = buildPosWeights;
  window.App.buildNflStarterPool      = buildNflStarterPool;

  // Generic functions (take data as parameters)
  window.App.buildNflStarterSet = buildNflStarterSet;
  window.App.calcOptimalPPG     = calcOptimalPPG;
  window.App.assessTeam         = assessTeam;
  window.App.assessAllTeams     = assessAllTeams;
  window.App.buildPicksByOwner  = buildPicksByOwner;

  // Convenience wrappers (read from War Room Scout globals)
  window.App.buildNflStarterSetFromGlobal = buildNflStarterSetFromGlobal;
  window.App.assessAllTeamsFromGlobal     = assessAllTeamsFromGlobal;
  window.App.assessTeamFromGlobal         = assessTeamFromGlobal;

  // Player action recommendation
  window.App.getPlayerAction = getPlayerAction;

  // Also expose on window for direct access
  window.getPlayerAction              = getPlayerAction;
  window.buildNflStarterSetShared     = buildNflStarterSet;
  window.calcOptimalPPGShared         = calcOptimalPPG;
  window.assessTeamShared             = assessTeam;
  window.assessAllTeamsShared         = assessAllTeams;
  window.assessAllTeamsFromGlobal     = assessAllTeamsFromGlobal;
  window.assessTeamFromGlobal         = assessTeamFromGlobal;
  window.buildNflStarterSetFromGlobal = buildNflStarterSetFromGlobal;

  // ── Module global exports (Vite migration) ─────────────────────
  window.normPos                  = normPos;
  window.assessTeam               = assessTeam;
  window.assessAllTeams           = assessAllTeams;
  window.buildPicksByOwner        = buildPicksByOwner;
  window.buildNflStarterSet       = buildNflStarterSet;
  window.calcOptimalPPG           = calcOptimalPPG;
  window.buildIdealRoster         = buildIdealRoster;
  window.buildMinStarterQuality   = buildMinStarterQuality;
  window.buildPosWeights          = buildPosWeights;
  window.buildNflStarterPool      = buildNflStarterPool;

})();
