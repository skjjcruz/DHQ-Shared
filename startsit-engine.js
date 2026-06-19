// ── Start/Sit Engine ─────────────────────────────────────────────
// Weekly projection + matchup-aware lineup solver for redraft (and any
// in-season format). Shared by War Room and ReconAI; also runnable in
// Node for unit tests + the refresh-projections edge function.
//
// LOAD-BEARING DESIGN: this engine projects STAT LINES, never points.
// Points are produced downstream by calcFantasyPts(statLine, scoring),
// which honors each league's exact scoring (PPR / TE-premium / SF / IDP /
// yardage bonuses) for free. The AI never invents numbers — it narrates
// this deterministic output only.
//
// NOTE: warroom-local copy (loaded via a direct <script> tag). The dev
// server regenerates warroom/reconai-shared/, so this engine lives under
// js/shared/ (hand-authored, persistent). Canonical twin for Node tests:
// reconai/shared/startsit-engine.js — keep them in sync.
(function (root) {
    'use strict';
    const App = root.App = root.App || {};

    // Production stat categories that scale with matchup/usage. Negative
    // events (INTs, fumbles) and binary kicker/DEF events are NOT scaled by
    // DvP/Vegas — only volume/efficiency is.
    const PASS_FIELDS = ['pass_yd', 'pass_td', 'pass_2pt', 'pass_cmp', 'pass_att'];
    const RUSH_FIELDS = ['rush_yd', 'rush_td', 'rush_2pt', 'rush_att', 'rush_fd'];
    const RECV_FIELDS = ['rec', 'rec_yd', 'rec_td', 'rec_2pt', 'rec_tgt', 'rec_fd'];
    const PRODUCTION_FIELDS = new Set([].concat(PASS_FIELDS, RUSH_FIELDS, RECV_FIELDS));

    // Flex slot eligibility (mirrors FLEX_ALLOWED in trade-calc.js).
    const FLEX_ALLOWED = {
        REC_FLEX: ['WR', 'TE'], FLEX: ['RB', 'WR', 'TE'], WRTQ: ['QB', 'RB', 'WR', 'TE'],
        SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], IDP_FLEX: ['DL', 'LB', 'DB'],
        WILDCARD: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'],
    };
    const BASE_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB']);
    const BENCH_SLOTS = new Set(['BN', 'BE', 'BENCH', 'IR', 'TAXI', 'RES']);

    // Default week-to-week relative variance by position (used to build the
    // floor↔ceiling band when we have no measured per-player variance yet).
    const DEFAULT_VARIANCE = { QB: 0.26, RB: 0.38, WR: 0.42, TE: 0.46, K: 0.45, DEF: 0.55, DL: 0.5, LB: 0.45, DB: 0.5 };
    const LEAGUE_AVG_IMPLIED = 22.5; // ~NFL average implied team total

    function normSlot(slot) {
        const raw = String(slot || '').trim().toUpperCase();
        if (raw === 'D/ST' || raw === 'DST') return 'DEF';
        if (raw === 'SUPERFLEX') return 'SUPER_FLEX';
        if (raw === 'WR/RB/TE' || raw === 'W/R/T') return 'FLEX';
        if (raw === 'WR/TE' || raw === 'W/T') return 'REC_FLEX';
        if (raw === 'Q/W/R/T' || raw === 'OP') return 'SUPER_FLEX';
        return raw;
    }

    function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

    // ── Baseline ─────────────────────────────────────────────────────
    // Per-game stat line from a cumulative season stat object.
    function perGameLine(seasonStats, gamesPlayed) {
        const gp = Number(gamesPlayed != null ? gamesPlayed : (seasonStats && seasonStats.gp)) || 0;
        if (!seasonStats || gp <= 0) return null;
        const out = {};
        for (const [k, v] of Object.entries(seasonStats)) {
            if (typeof v === 'number') out[k] = v / gp;
        }
        return out;
    }

    // Weighted blend of stat lines: [{ line, weight }]. Missing lines are
    // skipped and remaining weights renormalized.
    function blendLines(parts) {
        const live = (parts || []).filter(p => p && p.line && p.weight > 0);
        const wsum = live.reduce((s, p) => s + p.weight, 0);
        if (!wsum) return null;
        const out = {};
        for (const p of live) {
            const w = p.weight / wsum;
            for (const [k, v] of Object.entries(p.line)) {
                if (typeof v === 'number') out[k] = (out[k] || 0) + v * w;
            }
        }
        return out;
    }

    // ── Adjustments ──────────────────────────────────────────────────
    // Scale production categories by a single DvP multiplier (opponent
    // defense vs this position relative to league average; 1.0 = neutral).
    function applyMatchup(line, dvpMult) {
        const m = clamp(Number(dvpMult) || 1, 0.7, 1.35);
        if (m === 1 || !line) return line ? { ...line } : line;
        const out = { ...line };
        for (const f of PRODUCTION_FIELDS) if (out[f] != null) out[f] *= m;
        return out;
    }

    // Vegas: implied team total scales overall volume/scoring; spread sets
    // game script (favored → more rush; underdog → more pass/receiving).
    function applyVegas(line, position, vegas) {
        if (!line || !vegas) return line ? { ...line } : line;
        const out = { ...line };
        const implied = Number(vegas.impliedTotal);
        if (Number.isFinite(implied) && implied > 0) {
            const avg = Number(vegas.leagueAvgImplied) || LEAGUE_AVG_IMPLIED;
            const teamScale = clamp(implied / avg, 0.82, 1.22);
            for (const f of PRODUCTION_FIELDS) if (out[f] != null) out[f] *= teamScale;
        }
        const spread = Number(vegas.spread); // team spread: negative = favored
        if (Number.isFinite(spread)) {
            const shift = clamp(-spread * 0.012, -0.1, 0.1); // favored → +rush, -pass
            const passF = 1 - shift, rushF = 1 + shift;
            for (const f of PASS_FIELDS) if (out[f] != null) out[f] *= passF;
            for (const f of RECV_FIELDS) if (out[f] != null) out[f] *= passF;
            for (const f of RUSH_FIELDS) if (out[f] != null) out[f] *= rushF;
        }
        return out;
    }

    // Weather: wind/precip/cold trim passing + receiving (and kicking); rushing
    // is left alone. Indoor or no data → no change. Heuristic from ESPN's
    // scoreboard weather (condition text + temperature).
    function applyWeather(line, weather) {
        if (!line || !weather || weather.indoor) return line ? { ...line } : line;
        const d = String(weather.display || '').toLowerCase();
        let passF = 1, kickF = 1;
        if (/wind/.test(d)) { passF *= 0.93; kickF *= 0.9; }
        if (/rain|snow|shower|storm|sleet|flurr/.test(d)) { passF *= 0.95; }
        const t = Number(weather.temp);
        if (Number.isFinite(t) && t <= 20) { passF *= 0.97; kickF *= 0.96; }
        if (passF === 1 && kickF === 1) return { ...line };
        const out = { ...line };
        if (passF !== 1) [].concat(PASS_FIELDS, RECV_FIELDS).forEach(f => { if (out[f] != null) out[f] *= passF; });
        if (kickF !== 1) ['fgm', 'fgm_40_49', 'fgm_50p', 'fgm_50_59', 'fgm_60p', 'xpm'].forEach(f => { if (out[f] != null) out[f] *= kickF; });
        return out;
    }

    // Scale every numeric field uniformly (used to build floor/ceiling lines).
    function scaleLine(line, factor) {
        if (!line) return line;
        const out = {};
        for (const [k, v] of Object.entries(line)) out[k] = typeof v === 'number' ? v * factor : v;
        return out;
    }

    // ── Availability ─────────────────────────────────────────────────
    const OUT_STATUSES = new Set(['OUT', 'IR', 'PUP', 'SUS', 'NA', 'DNP', 'BYE', 'COV']);
    function availability(injuryStatus) {
        const s = String(injuryStatus || '').trim().toUpperCase();
        if (!s) return { available: true, mult: 1, floorPenalty: 0 };
        if (OUT_STATUSES.has(s)) return { available: false, mult: 0, floorPenalty: 0 };
        if (s === 'D' || s === 'DOUBTFUL') return { available: true, mult: 0.6, floorPenalty: 0.15 };
        if (s === 'Q' || s === 'QUESTIONABLE') return { available: true, mult: 0.92, floorPenalty: 0.1 };
        return { available: true, mult: 1, floorPenalty: 0 };
    }

    function matchupGrade(dvpMult, impliedTotal) {
        let m = clamp(Number(dvpMult) || 1, 0.7, 1.35);
        if (Number.isFinite(impliedTotal)) m *= clamp(impliedTotal / LEAGUE_AVG_IMPLIED, 0.85, 1.15);
        if (m >= 1.18) return 'A';
        if (m >= 1.08) return 'B';
        if (m >= 0.94) return 'C';
        if (m >= 0.85) return 'D';
        return 'F';
    }

    // ── Project a single player-week ─────────────────────────────────
    // input: { pid, position, baseline (per-game line), dvpMult, vegas,
    //          injuryStatus, variance, opponent, roleNote }
    // returns the projection MINUS league-scored points (scored downstream
    // via scoreProjection) and MINUS verdict (assigned by the solver).
    function projectPlayerWeek(input) {
        const pos = String(input.position || '').toUpperCase();
        const avail = availability(input.injuryStatus);
        const base = input.baseline || null;

        let median = base;
        if (median) {
            median = applyMatchup(median, input.dvpMult);
            median = applyVegas(median, pos, input.vegas);
            if (input.weather) median = applyWeather(median, input.weather);
            if (avail.mult !== 1) median = scaleLine(median, avail.mult);
        }

        const v = clamp(Number(input.variance) || DEFAULT_VARIANCE[pos] || 0.4, 0.1, 0.8);
        const floorMult = clamp(1 - v - avail.floorPenalty, 0.15, 1);
        const ceilMult = 1 + v;
        const floor = median ? scaleLine(median, floorMult) : null;
        const ceiling = median ? scaleLine(median, ceilMult) : null;

        const impliedTotal = input.vegas ? Number(input.vegas.impliedTotal) : NaN;
        return {
            pid: input.pid,
            week: input.week,
            position: pos,
            available: avail.available && !!median,
            statLine: { median, floor, ceiling },
            matchupGrade: median ? matchupGrade(input.dvpMult, impliedTotal) : 'C',
            opponent: input.opponent || (input.vegas ? { abbr: input.vegas.opp, impliedTotal: input.vegas.impliedTotal, spread: input.vegas.spread } : null),
            weather: input.weather || null,
            usageConfidence: input.usageConfidence != null ? input.usageConfidence : (base ? 0.7 : 0.4),
            roleNote: input.roleNote || '',
            injuryStatus: input.injuryStatus || '',
            variance: v,
        };
    }

    // Score a projection's three stat lines through the league scoring.
    // calcFn defaults to the global calcFantasyPts; pass one in Node tests.
    function scoreProjection(proj, scoring, calcFn) {
        const score = calcFn || root.calcFantasyPts || (App.Sleeper && App.Sleeper.calcFantasyPts);
        if (typeof score !== 'function') throw new Error('startsit: no calcFantasyPts available');
        const sl = (proj && proj.statLine) || {};
        const pts = {
            median: sl.median ? score(sl.median, scoring) : 0,
            floor: sl.floor ? score(sl.floor, scoring) : 0,
            ceiling: sl.ceiling ? score(sl.ceiling, scoring) : 0,
        };
        return { ...proj, points: pts };
    }

    // ── Lineup solver ────────────────────────────────────────────────
    // Exact optimal starting lineup for nested (laminar) slot eligibility —
    // i.e. every real fantasy roster. Process slots narrowest-eligibility
    // first, assigning the best unused eligible+available player. This is
    // provably optimal when eligibility sets are nested (QB ⊂ SUPER_FLEX,
    // RB/WR/TE ⊂ FLEX ⊂ SUPER_FLEX, …), which holds for standard formats.
    //
    // players: [{ pid, pos, available, pts }] (pts = objective score)
    // rosterPositions: raw slot array from the league (BN/IR/TAXI ignored)
    // returns { total, starters:[{pid,slot,pts,pos}], slots:[{slot,pid|null}] }
    function optimalLineupWeekly(players, rosterPositions) {
        const pool = (players || [])
            .filter(p => p && p.available !== false && Number.isFinite(p.pts))
            .map(p => ({ ...p, pos: String(p.pos || '').toUpperCase() }))
            .sort((a, b) => b.pts - a.pts);

        const slots = (rosterPositions || [])
            .map(normSlot)
            .filter(s => s && !BENCH_SLOTS.has(s))
            .map(s => {
                const elig = FLEX_ALLOWED[s] || (BASE_POSITIONS.has(s) ? [s] : null);
                return elig ? { slot: s, elig, size: elig.length } : null;
            })
            .filter(Boolean)
            // narrowest eligibility first; dedicated slots before flex on ties
            .sort((a, b) => a.size - b.size);

        const used = new Set();
        const starters = [];
        const filled = [];
        let total = 0;
        for (const sl of slots) {
            let best = null;
            for (const p of pool) {
                if (used.has(p.pid)) continue;
                if (sl.elig.includes(p.pos)) { best = p; break; } // pool is pre-sorted desc
            }
            if (best) {
                used.add(best.pid);
                total += best.pts;
                starters.push({ pid: best.pid, slot: sl.slot, pts: best.pts, pos: best.pos });
                filled.push({ slot: sl.slot, pid: best.pid });
            } else {
                filled.push({ slot: sl.slot, pid: null });
            }
        }
        return { total: Math.round(total * 10) / 10, starters, slots: filled, used };
    }

    // Diff the optimal lineup against the user's CURRENT starters. Returns
    // the point delta left on the bench + the concrete swaps to make.
    // scoreOf(pid) → objective points for a player id.
    function lineupDelta(currentStarterIds, optimal, scoreOf) {
        const optIds = new Set(optimal.starters.map(s => s.pid));
        const curIds = (currentStarterIds || []).filter(Boolean).map(String);
        const curTotal = curIds.reduce((s, pid) => s + (Number(scoreOf(pid)) || 0), 0);
        const benched = optimal.starters.filter(s => !curIds.includes(String(s.pid))); // should start, currently benched
        const sitters = curIds.filter(pid => !optIds.has(String(pid)));                // currently starting, should sit
        return {
            currentTotal: Math.round(curTotal * 10) / 10,
            optimalTotal: optimal.total,
            delta: Math.round((optimal.total - curTotal) * 10) / 10,
            startInstead: benched,   // [{pid,slot,pts,pos}]
            benchInstead: sitters,   // [pid]
            isOptimal: benched.length === 0,
        };
    }

    const StartSit = {
        FLEX_ALLOWED, BASE_POSITIONS, DEFAULT_VARIANCE, LEAGUE_AVG_IMPLIED,
        normSlot, perGameLine, blendLines,
        applyMatchup, applyVegas, applyWeather, scaleLine, availability, matchupGrade,
        projectPlayerWeek, scoreProjection,
        optimalLineupWeekly, lineupDelta,
    };

    App.StartSit = App.StartSit || StartSit;
    if (typeof module !== 'undefined' && module.exports) module.exports = StartSit;
})(typeof window !== 'undefined' ? window : globalThis);
