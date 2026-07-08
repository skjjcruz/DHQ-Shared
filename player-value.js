// ══════════════════════════════════════════════════════════════════
// js/utils/player-value.js — Shared player valuation constants and functions
// Single source of truth for: aging curves, pick values, roster construction
// targets, and the projectPlayerValue projection engine.
//
// Consumed by: league-detail.js, trade-calc.js
// Exposed as: window.App.PlayerValue
// ══════════════════════════════════════════════════════════════════

window.App.PlayerValue = (function () {

    // ── Roster construction targets ──────────────────────────────────
    const IDEAL_ROSTER = { QB:3, RB:7, WR:7, TE:4, K:2, DL:7, LB:6, DB:6 };
    const DRAFT_ROUNDS  = 7;
    const PICK_HORIZON  = 3;
    const PICK_IDEAL    = DRAFT_ROUNDS * PICK_HORIZON;

    const LINEUP_STARTERS    = { QB:1, RB:2, WR:3, TE:1, K:1, DL:3, LB:2, DB:3 };
    const MIN_STARTER_QUALITY = { QB:2, RB:3, WR:3, TE:2, K:1, DL:4, LB:5, DB:4 };
    const NFL_STARTER_POOL    = { QB:32, RB:40, WR:64, TE:32, K:32, DL:64, LB:64, DB:64 };
    const POS_PT_TARGETS      = { QB:20, RB:36, WR:36, TE:10, K:9, DL:24, LB:16, DB:24 };
    const POS_WEIGHTS         = { QB:14, RB:14, WR:14, TE:8, K:3, DL:13, LB:10, DB:12 };
    const TOTAL_WEIGHT        = Object.values(POS_WEIGHTS).reduce((a,b)=>a+b,0); // 88

    // ── Draft pick values (DHQ equivalent, used as fallback when DHQ engine absent) ──
    const PICK_VALUES = { 1:6250, 2:3150, 3:1650, 4:850, 5:450, 6:225, 7:125 };
    const PICK_COLORS = { 1:'var(--k-d4af37, #d4af37)', 2:'var(--k-5dade2, #5dade2)', 3:'var(--k-2ecc71, #2ecc71)', 4:'var(--k-bb8fce, #bb8fce)', 5:'var(--k-95a5a6, #95a5a6)', 6:'var(--k-7f8c8d, #7f8c8d)', 7:'var(--k-6c7a7d, #6c7a7d)' };

    // Slot-specific values (16-team × 7-round = 112 picks).
    // Dynamically generated from pick-value-model.js (industry consensus) when available.
    // Falls back to hardcoded table only if CDN script fails to load.
    const PICK_VALUES_BY_SLOT = (function() {
        if (typeof window.getIndustryPickValue === 'function') {
            const table = {};
            for (let pick = 1; pick <= 112; pick++) {
                table[pick] = window.getIndustryPickValue(pick, 16, 7);
            }
            return table;
        }
        // Emergency fallback — aligned with pick-value-model.js output
        return {
            1:7500, 2:6718, 3:6018, 4:5391, 5:4830, 6:4327, 7:3878, 8:3474,
            9:3113, 10:2789, 11:2499, 12:2240, 13:2007, 14:1799, 15:1612, 16:1445,
            17:1395, 18:1347, 19:1300, 20:1255, 21:1212, 22:1170, 23:1130, 24:1091,
            25:1053, 26:1017, 27:982, 28:948, 29:916, 30:884, 31:854, 32:824,
            33:796, 34:748, 35:703, 36:661, 37:621, 38:584, 39:549, 40:516,
            41:485, 42:456, 43:429, 44:403, 45:379, 46:356, 47:335, 48:315,
            49:296, 50:279, 51:262, 52:247, 53:232, 54:218, 55:205, 56:193,
            57:182, 58:171, 59:161, 60:151, 61:142, 62:134, 63:126, 64:119,
            65:112, 66:105, 67:99, 68:93, 69:88, 70:83, 71:78, 72:73,
            73:69, 74:65, 75:61, 76:58, 77:54, 78:51, 79:48, 80:45,
            81:43, 82:40, 83:38, 84:36, 85:34, 86:32, 87:30, 88:28,
            89:27, 90:25, 91:24, 92:22, 93:21, 94:20, 95:19, 96:18,
            97:17, 98:16, 99:15, 100:14, 101:13, 102:13, 103:12, 104:11,
            105:11, 106:10, 107:10, 108:9, 109:9, 110:8, 111:8, 112:7,
        };
    })();

    // Compute overall draft slot from slot_to_roster_id maps
    // draftSlotMaps = { year: { rosterId: slotInRound } }
    function getPickOverallSlot(year, round, fromRosterId, allRosters, draftSlotMaps) {
        if (!fromRosterId || !allRosters?.length) return null;
        const numTeams = allRosters.length;
        // Primary: Sleeper's authoritative slot_to_roster_id
        const yearMap = draftSlotMaps?.[Number(year)];
        if (yearMap) {
            const slotInRound = yearMap[String(fromRosterId)];
            if (slotInRound >= 1) return (round - 1) * numTeams + slotInRound;
        }
        // Fallback: waiver_position (set by Sleeper post-season as draft-order proxy)
        const roster = allRosters.find(r => String(r.roster_id) === String(fromRosterId));
        if (!roster) return null;
        const slotInRound = roster.settings?.waiver_position;
        if (slotInRound >= 1 && slotInRound <= numTeams) return (round - 1) * numTeams + slotInRound;
        return null;
    }

    // Resolve pick value — prefers shared/pick-value-model.js when available,
    // then slot-specific table, then round-average fallback.
    function resolvePickValue(year, round, fromRosterId, allRosters, draftSlotMaps) {
        const slot = getPickOverallSlot(year, round, fromRosterId, allRosters, draftSlotMaps);
        let value = PICK_VALUES[round] || 100;
        let resolvedSlot = null;
        if (slot) {
            if (window.getIndustryPickValue) {
                const numTeams = allRosters?.length || 12;
                const val = window.getIndustryPickValue(slot, numTeams, DRAFT_ROUNDS);
                if (val > 0) { value = val; resolvedSlot = slot; }
            }
            if (!resolvedSlot && PICK_VALUES_BY_SLOT[slot]) { value = PICK_VALUES_BY_SLOT[slot]; resolvedSlot = slot; }
        }
        // Future year discount: 12% per year (matches dhq-engine.js)
        const curYear = parseInt(window.S?.season) || new Date().getFullYear();
        const pickYear = parseInt(year) || curYear;
        const yearsAhead = Math.max(0, pickYear - curYear);
        if (yearsAhead > 0) value = Math.round(value * Math.pow(0.88, yearsAhead));
        return { value, slot: resolvedSlot };
    }

    // ── Aging curves ─────────────────────────────────────────────────
    // Max achievable DHQ per position (caps projection ceiling)
    const POS_CEILINGS = { QB:12000, RB:9000, WR:10500, TE:8500, DL:7000, LB:7000, DB:7000 };

    // Age curves and decay rates are owned by reconai/shared/constants.js.
    // Provide fallbacks with CDN-matching values in case constants.js hasn't loaded.
    window.App.ageCurveWindows = window.App.ageCurveWindows || {
        QB:{build:[23,27],peak:[28,34],decline:[35,38]},
        RB:{build:[21,22],peak:[23,25],decline:[26,28]},
        WR:{build:[22,24],peak:[25,28],decline:[29,31]},
        TE:{build:[23,25],peak:[26,29],decline:[30,32]},
        DL:{build:[22,24],peak:[25,29],decline:[30,32]},
        EDGE:{build:[22,24],peak:[25,29],decline:[30,32]},
        LB:{build:[22,23],peak:[24,28],decline:[29,31]},
        DB:{build:[21,23],peak:[24,27],decline:[28,30]},
        K:{build:[23,27],peak:[28,35],decline:[36,40]},
    };
    window.App.peakWindows = window.App.peakWindows || Object.fromEntries(
        Object.entries(window.App.ageCurveWindows).map(([pos, curve]) => [pos, curve.peak])
    );
    window.App.decayRates = window.App.decayRates || { QB:0.12, RB:0.22, WR:0.18, TE:0.16, K:0.08, DL:0.15, EDGE:0.15, LB:0.16, DB:0.18 };

    function pickValueBySlot(round, slotInRound, totalTeams, draftRounds) {
        const rd = Math.max(1, Number(round) || 1);
        const teams = Math.max(1, Number(totalTeams) || 12);
        const slot = Math.max(1, Number(slotInRound) || Math.ceil(teams / 2));
        const rounds = Math.max(1, Number(draftRounds) || DRAFT_ROUNDS);
        const overall = (rd - 1) * teams + slot;
        if (window.getPickValueBySlot) {
            const val = window.getPickValueBySlot(rd, slot, teams, rounds);
            if (val > 0) return val;
        }
        if (window.getIndustryPickValue) {
            const val = window.getIndustryPickValue(overall, teams, rounds);
            if (val > 0) return val;
        }
        if (PICK_VALUES_BY_SLOT[overall]) return PICK_VALUES_BY_SLOT[overall];
        return PICK_VALUES[rd] || 100;
    }

    // ── getPickValue ─────────────────────────────────────────────────
    // Returns DHQ-equivalent value for a draft pick. Delegates to DHQ engine when available.
    function getPickValue(season, round, totalTeams, slotInRound, draftRounds) {
        const teams = totalTeams || 12;
        const slot = Number(slotInRound) || null;
        // dhqPickValueFn already applies year discount internally
        if (window.App?.LI?.dhqPickValueFn) {
            const val = window.App.LI.dhqPickValueFn(season, round, slot || Math.ceil(teams / 2));
            if (val > 0) return val;
        }
        let value = slot ? pickValueBySlot(round, slot, teams, draftRounds) : (PICK_VALUES[round] || 100);
        // Future year discount: 12% per year (matches dhq-engine.js)
        const curYear = parseInt(window.S?.season) || new Date().getFullYear();
        const pickYear = parseInt(season) || curYear;
        const yearsAhead = Math.max(0, pickYear - curYear);
        if (yearsAhead > 0) value = Math.round(value * Math.pow(0.88, yearsAhead));
        return value;
    }

    // ── Usage signal helpers ─────────────────────────────────────────
    // Reads from window.S.playerStats[pid].prevRawStats (Sleeper season totals).
    // Returns a multiplier on the base decay rate.  > 1 = faster decline, < 1 = slower.
    function computeUsageDecayMultiplier(pid, nPos) {
        const raw = window.S?.playerStats?.[pid]?.prevRawStats;
        if (!raw) return 1.0;
        const gp = raw.gp || 0;
        if (gp < 4) return 1.0; // too few games for a reliable signal

        if (nPos === 'RB') {
            const cpg = (raw.rush_att || 0) / gp;
            if (cpg >= 20) return 1.10;  // workhorse — tread wears faster
            if (cpg < 12)  return 0.90;  // pass-catching back — lighter load
            return 1.0;
        }
        if (nPos === 'WR' || nPos === 'TE') {
            const tpg = (raw.rec_tgt || raw.rec_att || 0) / gp;
            const hiThreshold = nPos === 'TE' ? 7 : 8;
            if (tpg >= hiThreshold) return 0.93; // featured target — established role, more stable
            return 1.0;
        }
        if (nPos === 'QB') {
            const rapg = (raw.rush_att || 0) / gp;
            if (rapg >= 7) return 1.05; // mobile QB — physical wear from running
            return 1.0;
        }
        return 1.0;
    }

    // Returns a one-time additive DHQ adjustment for WR/TE based on target share trend.
    // Positive trend (rising share) → positive bonus; negative → penalty.
    // Applied only in year 1 of the projection; dampened to avoid over-weighting one signal.
    function computeUsageTrendBonus(nPos, baseDhq, trend) {
        if (nPos !== 'WR' && nPos !== 'TE') return 0;
        if (Math.abs(trend) < 0.10) return 0;  // below noise threshold
        // Cap trend influence at ±50%; scale to ±5% of base DHQ
        const capped = Math.min(Math.max(trend, -0.50), 0.50);
        return Math.round(baseDhq * capped * 0.10);
    }

    // ── projectPlayerValue ───────────────────────────────────────────
    // Projects (or retro-jects) a player's DHQ value `delta` seasons away.
    // Uses position-specific peak windows, usage-adjusted decay rates, and
    // a confidence half-life to produce calibrated multi-year projections.
    //
    // Parameters:
    //   pid      — player id (used for isElitePlayer lookup + usage stat read)
    //   baseDhq  — current DHQ score
    //   baseAge  — player's current age
    //   pos      — position string (may be variant like 'DE', 'CB', 'OLB')
    //   delta    — years offset; positive = future, negative = past
    //   meta     — optional { trend: Number } where trend ≈ YoY PPG change fraction
    //
    // Usage signals (read from window.S.playerStats[pid].prevRawStats):
    //   RB carries/game  ≥20 → decay ×1.10 (workhorse ages faster)
    //   RB carries/game  <12 → decay ×0.90 (pass-catcher ages slower)
    //   WR/TE targets/game ≥8/7 → decay ×0.93 (featured role, more stable)
    //   QB rush att/game  ≥7  → decay ×1.05 (mobile QB wear)
    //   WR/TE rising target share (meta.trend >10%) → year-1 value bonus
    //   WR/TE declining target share (meta.trend <-10%) → year-1 value penalty
    function projectPlayerValue(pid, baseDhq, baseAge, pos, delta, meta) {
        if (!baseDhq || baseDhq <= 0 || delta === 0) return baseDhq;
        const ageCurveWindows = window.App.ageCurveWindows;
        const peakWindows = window.App.peakWindows;
        const decayRates  = window.App.decayRates;
        const nPos = pos === 'DE' || pos === 'DT'   ? 'DL'
                   : pos === 'CB' || pos === 'S'    ? 'DB'
                   : pos === 'OLB' || pos === 'ILB' ? 'LB'
                   : pos;
        const curve = ageCurveWindows[nPos] || { build:[22,24], peak:peakWindows[nPos] || [24,29], decline:[30,32] };
        const [pLo, pHi] = curve.peak;
        const declineHi = curve.decline[1];
        const decay = decayRates[nPos] || 0.12;
        const ceiling = POS_CEILINGS[nPos] || 10000;

        if (!baseAge || baseAge <= 0) return baseDhq;

        const trend = meta?.trend || 0;        // e.g. +0.15 = trending up 15%
        const trendBoost = 1 + (trend * 0.5);  // dampen raw trend for projection

        // Offseason projections decay slower (less in-season noise)
        const month = new Date().getMonth(); // 0-indexed
        const inSeason = month >= 8 || month <= 1; // Sep–Feb
        const halfLife = inSeason ? 1.5 : 3.0;

        const isElite  = typeof window.App?.isElitePlayer === 'function'
                         ? window.App.isElitePlayer(pid) : baseDhq >= 7000;
        const isProven = baseDhq >= 4000;
        const peakMid  = Math.floor((pLo + pHi) / 2);

        // ── Usage-adjusted decay rate ──────────────────────────────
        const usageMult    = computeUsageDecayMultiplier(pid, nPos);
        const effectiveDecay = decay * usageMult;

        // ── Target share trend bonus (WR/TE only, year 1) ──────────
        const trendBonus = computeUsageTrendBonus(nPos, baseDhq, trend);

        let val = baseDhq;

        if (delta > 0) {
            // ── Future projection ─────────────────────────────────────
            for (let yr = 1; yr <= delta; yr++) {
                const ageAtYr   = baseAge + yr;
                const confidence = Math.pow(0.5, yr / halfLife);
                if (ageAtYr <= pLo) {
                    // Pre-peak: larger growth window
                    const growthRate = isElite ? 0.18 : isProven ? 0.14 : 0.08;
                    const projected  = val * (1 + growthRate * trendBoost);
                    val = projected * confidence + val * (1 - confidence);
                } else if (ageAtYr <= peakMid) {
                    // Early-peak: still appreciating
                    const rate = isElite ? 0.06 : isProven ? 0.03 : 0.0;
                    val *= (1 + rate * trendBoost);
                } else if (ageAtYr <= pHi) {
                    // Late-peak: holding or starting to decline
                    val *= isElite ? 1.0 : isProven ? (1 - effectiveDecay * 0.1) : (1 - effectiveDecay * 0.25);
                } else if (ageAtYr <= declineHi) {
                    // Valuable decline band: reduce gradually, not like a cliff.
                    const declineFloor = { QB:0.78, RB:0.62, WR:0.68, TE:0.70, K:0.82, DL:0.70, LB:0.68, DB:0.66 }[nPos] || 0.68;
                    const progress = (ageAtYr - pHi) / Math.max(1, declineHi - pHi);
                    const target = declineFloor + (1 - declineFloor) * (1 - Math.max(0, Math.min(1, progress)));
                    val *= target;
                } else {
                    // Post-decline: steeper decline, 0.25 acceleration per year beyond the valuable band.
                    const yearsPast = ageAtYr - declineHi;
                    const accel = 1 + yearsPast * 0.25;
                    val *= (1 - effectiveDecay * accel);
                }
                // Apply target share trend pressure in year 1 only (signal fades quickly)
                if (yr === 1 && trendBonus !== 0) val += trendBonus;
                // SOS adjustment: year 1 only, current season projections (not dynasty multi-year)
                // Easy schedule (rank 25-32) → small positive; Hard (rank 1-8) → small negative
                // Range: ±5% max; uses last completed season's average opponent defense rank
                if (yr === 1 && window.App?.SOS?.ready) {
                    const pd = window.App?.SOS?.defenseRankings; // existence check only
                    if (pd) {
                        const playerTeam = window.App?._playersCache?.[pid]?.team;
                        const sos = playerTeam
                            ? window.App.SOS.getPlayerSOS(pid, nPos, playerTeam)
                            : null;
                        if (sos?.avgRank != null) {
                            // rank 16.5 = league average; ±16.5 range → ±5% adjustment
                            const sosAdj = (sos.avgRank - 16.5) / 16.5 * 0.05;
                            val = val * (1 + sosAdj);
                        }
                    }
                }
                val = Math.min(val, ceiling);
            }
        } else {
            // ── Historical retrojection ───────────────────────────────
            for (let yr = 1; yr <= Math.abs(delta); yr++) {
                const ageAtYr = (baseAge || 25) - yr;
                if (ageAtYr < pLo - 2) {
                    val *= (1 - 0.15);                // worth less when very young
                } else if (ageAtYr <= pHi) {
                    val *= (1 + effectiveDecay * 0.1); // in window, similar value
                } else {
                    val *= (1 + effectiveDecay * 0.5); // worth more when younger past value window
                }
            }
        }

        return Math.max(0, Math.round(val));
    }

    // ── Rest-of-Season (ROS) value — redraft only ────────────────────
    // Format-aware player value: redraft leagues value players by projected
    // points over the remaining fantasy regular season (league-scored via the
    // projection engine), scaled into the DHQ range so Trade Center math, pick
    // values, tiers, and coloring all keep working unchanged. Dynasty/keeper
    // fall through to DHQ (App.LI.playerScores). Built once per (league, week).
    let _ros = null; // { leagueId, week, remainingWeeks, points:{pid}, values:{pid}, scale }

    // ROS value = gross-points share + value-over-replacement share (mirrors the dynasty
    // engine's lineupValuePPGFor 0.35/0.65 split). Tune toward pure VOR (e.g. 0.25/0.75)
    // if gross-points players — backup QBs/streamers — still rank above flex starters.
    const ROS_GROSS_WT = 0.35, ROS_VOR_WT = 0.65;

    function _currentLeagueId() {
        return String(window.S?.currentLeagueId
            || window.App?.LeagueSkin?.getCurrent?.()?.leagueId || '');
    }
    function _isRedraft(skin) {
        const s = skin || window.App?.LeagueSkin?.getCurrent?.() || null;
        return !!s && s.type === 'redraft';
    }

    // Healthy, neutral-matchup per-week median for a player, league-scored.
    // Ignores transient injury_status — ROS is a season-long estimate.
    function _perWeekMedian(pid, ctx) {
        const WP = window.App?.WeeklyProj, SS = window.App?.StartSit;
        if (!WP || !SS || !WP.buildBaseline) return 0;
        const player = ctx.playersData?.[pid];
        if (!player) return 0;
        const baseline = WP.buildBaseline(pid, ctx.statsData?.[pid] || null, ctx.priorData?.[pid] || null, ctx.scoring, ctx.week);
        if (!baseline) return 0;
        const pos = (window.App?.normPos?.(player.position)) || player.position || '';
        const proj = SS.projectPlayerWeek({ pid, week: ctx.week, position: pos, baseline, dvpMult: 1, vegas: null, injuryStatus: '' });
        const scored = SS.scoreProjection(proj, ctx.scoring);
        return (scored && scored.points && scored.points.median) || 0;
    }

    // Replacement-rank (1-indexed) for a position = the last startable player at that
    // position across the league. Reuses the dynasty engine's flex-aware per-team slot
    // count (lineupContext.perTeamSlots) when available; falls back to league starter
    // counts, then a sane per-position default. Used to compute value-over-replacement.
    function _replacementRank(pos, totalTeams) {
        const lc = window.App?.LI?.lineupContext?.position?.[pos];
        const sc = window.App?.LI?.starterCounts?.[pos];
        const slotsPerTeam = (lc && lc.perTeamSlots > 0) ? lc.perTeamSlots
                           : (sc > 0 ? sc : ({ QB:1, RB:2, WR:3, TE:1, K:1, DL:3, LB:2, DB:3 }[pos] || 1));
        return Math.max(1, Math.round(totalTeams * slotsPerTeam));
    }

    // Build + cache the ROS value map. No-op (leaves _ros null → getValue
    // falls back to DHQ) when not redraft, projections/DHQ unavailable, or no
    // weeks remain. ctx = { leagueId, league, playersData, statsData, priorData, skin }.
    function ensureRos(ctx) {
        ctx = ctx || {};
        const skin = ctx.skin || window.App?.LeagueSkin?.getCurrent?.() || null;
        if (!_isRedraft(skin)) { _ros = null; return null; }
        const league = ctx.league || skin?.league || {};
        const leagueId = String(ctx.leagueId || league.league_id || league.id || _currentLeagueId());
        const WP = window.App?.WeeklyProj;
        const week = WP && WP.currentWeek ? WP.currentWeek() : 1;
        if (_ros && _ros.leagueId === leagueId && _ros.week === week) return _ros; // cached

        const playerScores = window.App?.LI?.playerScores || null;
        if (!playerScores) return null; // DHQ is the scale anchor — need it loaded
        const scoring = ctx.scoring || league.scoring_settings || {};
        const pws = Number(league.settings?.playoff_week_start) || 15;
        const remainingWeeks = Math.max(0, (pws - 1) - week);
        if (remainingWeeks <= 0) { _ros = null; return null; } // season over → DHQ

        const projWeek = week + 1;
        const totalTeams = Number(league.total_rosters) || (window.S?.rosters?.length) || 12;

        // ── Pass 1: project each player's healthy per-week points + record position ──
        const perWkByPid = {}, posByPid = {};
        let bestDHQ = 0;
        for (const pid in playerScores) {
            const dhq = playerScores[pid] || 0;
            if (dhq > bestDHQ) bestDHQ = dhq;
            const perWk = _perWeekMedian(pid, { playersData: ctx.playersData, statsData: ctx.statsData, priorData: ctx.priorData, scoring, week: projWeek });
            if (perWk <= 0) continue;
            perWkByPid[pid] = perWk;
            const player = ctx.playersData?.[pid];
            posByPid[pid] = (window.App?.normPos?.(player?.position)) || player?.position || '';
        }

        // ── Value-over-replacement baseline per position ──────────────────
        // Redraft value must reward SCARCITY, not gross points — otherwise QBs (who put up
        // the most raw points) dominate the board and a top passer ranks #1 overall, which
        // diverges from market consensus. Mirror the dynasty engine's lineupValuePPGFor:
        // value = 35% gross + 65% edge-above-replacement, where replacement = the last
        // startable player at that position (so a 22-PPG QB whose replacement scores 18 has
        // a small edge, while a 16-PPG RB whose replacement scores 8 has a large one).
        const byPos = {};
        for (const pid in perWkByPid) (byPos[posByPid[pid]] = byPos[posByPid[pid]] || []).push(perWkByPid[pid]);
        const replacementPerWk = {};
        for (const pos in byPos) {
            if (!pos) continue; // unknown-position bucket gets no replacement baseline (handled in pass 2)
            const arr = byPos[pos].sort((a, b) => b - a);
            const rank = _replacementRank(pos, totalTeams);
            replacementPerWk[pos] = arr[Math.min(rank, arr.length) - 1] || 0;
        }

        // ── Pass 2: raw ROS points (display) + VOR-weighted value (ranking/scaling) ──
        const points = {}, values = {}, vor = {};
        let maxVor = 0;
        for (const pid in playerScores) {
            const perWk = perWkByPid[pid] || 0;
            const pos = posByPid[pid] || '';
            // Unprojectable (rostered rookie/no NFL stats) or unknown position → no demonstrated
            // ROS value. Pin to 0 EXPLICITLY so getValue returns 0 in redraft rather than leaking
            // the player's full DYNASTY DHQ score (the value-vs-"0 pts" contradiction from review).
            if (perWk <= 0 || !pos) { points[pid] = 0; values[pid] = 0; continue; }
            const player = ctx.playersData?.[pid];
            const bye = player ? Number(player.bye_week) : 0;
            const byeInWindow = bye > week && bye < pws;
            const effWeeks = remainingWeeks - (byeInWindow ? 1 : 0);
            points[pid] = Math.max(0, Math.round(perWk * effWeeks * 10) / 10); // raw projected ROS pts (display)
            const repl = replacementPerWk[pos] || 0;
            const lineupVal = perWk * ROS_GROSS_WT + Math.max(0, perWk - repl) * ROS_VOR_WT; // scarcity-weighted per-week value
            vor[pid] = Math.max(0, lineupVal * effWeeks);
            if (vor[pid] > maxVor) maxVor = vor[pid];
        }
        if (bestDHQ <= 0 || maxVor <= 0) { _ros = null; return null; }
        const scale = bestDHQ / maxVor;   // anchor the top VOR asset to the dynasty-scale ceiling
        for (const pid in vor) values[pid] = Math.min(10000, Math.round(vor[pid] * scale));
        _ros = { leagueId, week, remainingWeeks, points, values, scale, bestDHQ, maxVor, replacementPerWk };
        return _ros;
    }

    // Format-aware value: redraft (with ROS built for the current league) →
    // scaled ROS; otherwise → dynasty DHQ. Drop-in for App.LI.playerScores[pid].
    function getValue(pid, opts) {
        opts = opts || {};
        if (_isRedraft(opts.skin) && _ros && _ros.leagueId === _currentLeagueId() && _ros.values[pid] != null) {
            return _ros.values[pid];
        }
        return (window.App?.LI?.playerScores?.[pid]) || 0;
    }
    // Raw projected ROS points for display (null when not built for this league).
    function getRosPoints(pid) {
        if (_ros && _ros.leagueId === _currentLeagueId()) return _ros.points[pid] != null ? _ros.points[pid] : null;
        return null;
    }
    function rosState() { return _ros; }
    // A drop-in replacement for App.LI.playerScores: a Proxy over the real map
    // so Object.keys/enumeration still see every player id, but value lookups
    // (map[pid]) route through getValue (ROS for redraft, DHQ otherwise).
    function valueMap(opts) {
        const raw = window.App?.LI?.playerScores || {};
        if (typeof getValue !== 'function') return raw;
        return new Proxy(raw, { get: (t, k) => (typeof k === 'string' && k in t) ? getValue(k, opts) : t[k] });
    }

    return {
        IDEAL_ROSTER,
        DRAFT_ROUNDS,
        PICK_HORIZON,
        PICK_IDEAL,
        LINEUP_STARTERS,
        MIN_STARTER_QUALITY,
        NFL_STARTER_POOL,
        POS_PT_TARGETS,
        POS_WEIGHTS,
        TOTAL_WEIGHT,
        PICK_VALUES,
        PICK_VALUES_BY_SLOT,
        PICK_COLORS,
        POS_CEILINGS,
        getPickValue,
        pickValueBySlot,
        getPickOverallSlot,
        resolvePickValue,
        projectPlayerValue,
        ensureRos,
        getValue,
        getRosPoints,
        rosState,
        valueMap,
    };
})();
