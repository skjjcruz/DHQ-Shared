// ══════════════════════════════════════════════════════════════════
// js/shared/weekly-proj.js — window.App.WeeklyProj
// Client accessor that turns whatever weekly context we have into
// league-scored start/sit projections via the shared App.StartSit engine.
//
// PROGRESSIVE ENHANCEMENT: works TODAY off local data (season stats +
// recent weekly-points form), with neutral matchup/Vegas. When the
// refresh-projections edge function + player_week_projections table land,
// setContext() feeds real DvP/Vegas/injury and the same code path lights up.
//
// All scoring flows through calcFantasyPts(statLine, scoring) so every
// league's exact rules (PPR / SF / IDP / yardage bonuses) are honored.
// ══════════════════════════════════════════════════════════════════
(function (root) {
    'use strict';
    const App = root.App = root.App || {};
    const SS = () => App.StartSit;

    // External weekly context, keyed by `${nflTeam}|${week}`: { dvpMult, vegas:{impliedTotal,spread,opp}, injury:{pid:status} }.
    // Empty until the edge function populates it — projections stay neutral.
    const _ctx = { byTeamWeek: {}, byPid: {} };

    function setContext(ctx) {
        if (!ctx) return;
        if (ctx.byTeamWeek) Object.assign(_ctx.byTeamWeek, ctx.byTeamWeek);
        if (ctx.byPid) Object.assign(_ctx.byPid, ctx.byPid);
    }
    function teamWeekCtx(team, week) {
        return _ctx.byTeamWeek[`${String(team || '').toUpperCase()}|${week}`] || null;
    }

    function currentWeek() {
        const s = root.S || {};
        const w = Number(s.currentWeek || s.nflState?.display_week || s.nflState?.week || 0);
        return w > 0 ? w : 1;
    }

    // Weekly actuals are stored league-scored as weeklyPlayerPoints[week][pid].
    // Returns [{week, pts}] ascending for a player (only weeks with a value).
    function weeklyHistory(pid) {
        const wpp = (root.S && root.S.weeklyPlayerPoints) || {};
        const out = [];
        for (const k of Object.keys(wpp)) {
            const w = Number(k); if (!(w > 0)) continue;
            const pts = wpp[k] && wpp[k][pid];
            if (pts != null) out.push({ week: w, pts: Number(pts) });
        }
        out.sort((a, b) => a.week - b.week);
        return out;
    }

    // Rolling PPG over the last `lastN` PLAYED weeks (>0 pts), plus season
    // high/low. lastN === 'season' (or huge) → full-season average.
    function formStats(pid, lastN) {
        const hist = weeklyHistory(pid);
        if (!hist.length) return null;
        const played = hist.filter(g => g.pts > 0.1);
        const pool = played.length ? played : hist;
        const n = (lastN === 'season' || !lastN) ? pool.length : Math.max(1, Number(lastN));
        const recent = [...pool].sort((a, b) => b.week - a.week).slice(0, n);
        const avg = recent.reduce((s, g) => s + g.pts, 0) / (recent.length || 1);
        return {
            rollingPPG: +avg.toFixed(1),
            high: +Math.max(...pool.map(g => g.pts)).toFixed(1),
            low: +Math.min(...pool.map(g => g.pts)).toFixed(1),
            games: pool.length,
            recentCount: recent.length,
        };
    }

    // Recent-form points average over the last `lookback` completed weeks.
    function recentPPG(pid, week, lookback) {
        const wpp = (root.S && root.S.weeklyPlayerPoints) || null;
        if (!wpp) return null;
        const weeks = Object.keys(wpp).map(Number).filter(w => w > 0 && w < week).sort((a, b) => b - a).slice(0, lookback || 3);
        if (!weeks.length) return null;
        const vals = weeks.map(w => Number(wpp[w] && wpp[w][pid]) || 0).filter(v => v > 0);
        if (!vals.length) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length;
    }

    // Build a per-game baseline STAT LINE for a player: blend current-season
    // and prior-season per-game lines, then nudge by recent-form ratio.
    function buildBaseline(pid, season, prior, scoring, week) {
        const ss = SS();
        const seasonGp = Number(season && season.gp) || 0;
        const seasonLine = ss.perGameLine(season, seasonGp);
        const priorLine = ss.perGameLine(prior, Number(prior && prior.gp) || 0);

        // Lean on prior early in the year; lean on this season as games accrue.
        const seasonW = Math.min(seasonGp, 6) / 6 * 0.75 + (seasonGp > 0 ? 0.05 : 0);
        const priorW = 0.35;
        let line = ss.blendLines([{ line: seasonLine, weight: seasonW }, { line: priorLine, weight: priorW }]);
        if (!line) return null;

        // Recent-form multiplier (hot/cold) from weekly points vs season PPG.
        if (App.calcPPG && season) {
            const seasonPPG = App.calcPPG(season, scoring);
            const recent = recentPPG(pid, week, 3);
            if (seasonPPG > 2 && recent != null) {
                const factor = Math.max(0.7, Math.min(1.4, recent / seasonPPG));
                line = ss.scaleLine(line, factor);
            }
        }
        return line;
    }

    function isByeOrOut(player, ctx, pid, week) {
        const sleeperStatus = (player && player.injury_status) || '';
        const ctxStatus = ctx && ctx.injury && ctx.injury[pid];
        if (Number(player && player.bye_week) === week) return 'BYE';
        return ctxStatus || sleeperStatus || '';
    }

    // Project one player for a given week, scored through `scoring`.
    function projectPlayer(pid, { playersData, statsData, priorData, scoring, week }) {
        const ss = SS();
        if (!ss || !pid) return null;
        const player = (playersData && playersData[pid]) || null;
        const pos = (App.normPos && App.normPos(player && player.position)) || (player && player.position) || '';
        const season = (statsData && statsData[pid]) || null;
        const prior = (priorData && priorData[pid]) || null;
        const baseline = buildBaseline(pid, season, prior, scoring, week);

        const team = player && player.team;
        const ctx = teamWeekCtx(team, week);
        const injuryStatus = isByeOrOut(player, ctx, pid, week);

        const proj = ss.projectPlayerWeek({
            pid, week, position: pos, baseline,
            dvpMult: ctx ? ctx.dvpMult : 1,
            vegas: ctx ? ctx.vegas : null,
            weather: ctx ? ctx.weather : null,
            opponent: ctx ? { abbr: ctx.opp, home: ctx.home, impliedTotal: ctx.vegas && ctx.vegas.impliedTotal, spread: ctx.vegas && ctx.vegas.spread } : null,
            injuryStatus,
            roleNote: ctx ? ctx.roleNote : '',
        });
        return ss.scoreProjection(proj, scoring);
    }

    function projectRoster(playerIds, opts) {
        const out = {};
        (playerIds || []).forEach(pid => { const p = projectPlayer(pid, opts); if (p) out[pid] = p; });
        return out;
    }

    // GM mode → optimization objective. win_now plays it safe (floor),
    // rebuild chases upside (ceiling), everyone else optimizes the median.
    function objectiveForMode(mode) {
        if (mode === 'win_now') return 'floor';
        if (mode === 'rebuild') return 'ceiling';
        return 'median';
    }
    function modeFor(leagueId) {
        try { return (App.WR && App.WR.GmMode && App.WR.GmMode.effects(leagueId).mode) || (root.WR && root.WR.GmMode && root.WR.GmMode.effects(leagueId).mode) || 'compete'; }
        catch (e) { return 'compete'; }
    }

    // Optimal weekly lineup for a roster + the delta vs current starters.
    // roster: { players:[], starters:[], reserve:[], taxi:[] }
    function optimalForRoster(roster, currentLeague, opts) {
        const ss = SS();
        opts = opts || {};
        const scoring = (currentLeague && currentLeague.scoring_settings) || {};
        const rosterPositions = (currentLeague && currentLeague.roster_positions) || [];
        const week = opts.week || currentWeek();
        const leagueId = (currentLeague && (currentLeague.league_id || currentLeague.id)) || '';
        const mode = opts.mode || modeFor(leagueId);
        const objective = opts.objective || objectiveForMode(mode);

        const resSet = new Set((roster && roster.reserve) || []);
        const taxiSet = new Set((roster && roster.taxi) || []);
        const ids = ((roster && roster.players) || []).filter(id => id && !resSet.has(id) && !taxiSet.has(id));

        const projections = projectRoster(ids, { playersData: opts.playersData, statsData: opts.statsData, priorData: opts.priorData, scoring, week });
        const scoreOf = pid => { const p = projections[pid]; return p && p.available ? (p.points[objective] || 0) : 0; };

        const players = ids.map(pid => {
            const p = projections[pid];
            const pl = opts.playersData && opts.playersData[pid];
            return { pid, pos: (App.normPos && App.normPos(pl && pl.position)) || (pl && pl.position) || '', available: !!(p && p.available), pts: scoreOf(pid) };
        });

        const optimal = ss.optimalLineupWeekly(players, rosterPositions);
        const delta = ss.lineupDelta((roster && roster.starters) || [], optimal, scoreOf);
        return { week, mode, objective, scoring, projections, optimal, delta };
    }

    App.WeeklyProj = App.WeeklyProj || {
        setContext, currentWeek, recentPPG, weeklyHistory, formStats, buildBaseline,
        projectPlayer, projectRoster, optimalForRoster,
        objectiveForMode, modeFor,
        _ctx,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = App.WeeklyProj;
})(typeof window !== 'undefined' ? window : globalThis);
