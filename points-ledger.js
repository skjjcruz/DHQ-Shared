// ══════════════════════════════════════════════════════════════════
// lab/points-ledger.js — the 243-points roster model (TRADE LAB ONLY)
//
// The Why behind every recommendation is one number: the championship
// weekly pace, split across the starting groups. Bars below are the
// owner-ruled table (2026-09-03): offense bars match what champion
// lineups actually score, defense bars trimmed to what winners average
// — the paper-run backtest held a 95%+ win rate above the total.
//
// Every roster is optimal-filled into the league's real starting slots
// using Sleeper WEEKLY projections scored under the LEAGUE'S OWN
// scoring settings, on a PER-GAME basis (fallback: last season's
// actuals per game played). v3 (owner rulings 2026-09-04): the weekly
// feeds are what Sleeper's app itself displays — the season-total feed
// disagrees with them (badly on IDP) — and dividing by games projected
// instead of 17 stops bye weeks from diluting the pace. Consumers still
// speak in RELATIVE terms (percent of bar, rank vs the league) — never
// absolute point gaps (owner ruling: relative, not absolute).
//
// Loaded only by trade-lab.html. Nothing in production references it.
// ══════════════════════════════════════════════════════════════════
(function (root) {
    'use strict';

    // Owner-ruled bars, 2026-09-03 (defensive trim). Sum = 243.
    var BARS = { QB: 22, RB: 39, WR: 40, TE: 10, FLEX: 28, SF: 20, K: 9, DL: 22, LB: 14, DB: 21, IDP: 18 };

    // Plain-English group names for Why copy — the UI never says "bar",
    // "model" or a class label (owner ruling: below the radar).
    var GROUP_LABEL = {
        QB: 'quarterback slot', RB: 'running back room', WR: 'receiver room',
        TE: 'tight end slot', FLEX: 'flex spots', SF: 'superflex slot',
        K: 'kicker slot', DL: 'defensive line', LB: 'linebacker slots',
        DB: 'secondary', IDP: 'defensive flex',
    };
    // Plural labels take "rank"; the rest take "ranks" (copy must read human).
    var GROUP_PLURAL = { FLEX: true, LB: true };

    // Which roster positions can fill a group (targeting: soft group → shop list).
    var GROUP_POSITIONS = {
        QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'],
        DL: ['DL'], LB: ['LB'], DB: ['DB'],
        FLEX: ['RB', 'WR', 'TE'], SF: ['QB'], IDP: ['DL', 'LB', 'DB'],
    };

    var FLEX_OK = { RB: 1, WR: 1, TE: 1 };
    var SF_OK = { QB: 1, RB: 1, WR: 1, TE: 1 };
    var IDP_OK = { DL: 1, LB: 1, DB: 1 };

    function normPos(p) {
        p = String(p || '').toUpperCase();
        if (p === 'DE' || p === 'DT' || p === 'NT') return 'DL';
        if (p === 'CB' || p === 'S' || p === 'FS' || p === 'SS') return 'DB';
        return p;
    }

    function slotShape(rosterPositions) {
        var dedicated = {}, flexN = 0, sfN = 0, idpN = 0;
        (rosterPositions || []).forEach(function (s) {
            if (s === 'BN' || s === 'IR' || s === 'TAXI') return;
            if (s === 'FLEX' || s === 'WRRB_FLEX' || s === 'REC_FLEX') flexN++;
            else if (s === 'SUPER_FLEX' || s === 'OP') sfN++;
            else if (s === 'IDP_FLEX' || s === 'IDP') idpN++;
            else dedicated[normPos(s)] = (dedicated[normPos(s)] || 0) + 1;
        });
        return { dedicated: dedicated, flexN: flexN, sfN: sfN, idpN: idpN };
    }

    function scoreStats(stats, scoring) {
        var t = 0;
        for (var k in scoring) if (stats[k]) t += scoring[k] * stats[k];
        return t;
    }

    function defaultFetchJson(url) {
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
            return r.json();
        });
    }

    // One in-flight/settled load per league+season — the projection feeds are
    // multi-MB, so they are fetched at most once per page session.
    var _cache = {};

    function load(ctx) {
        var league = ctx.league || {};
        var season = Number(ctx.season || league.season) || new Date().getFullYear();
        var key = String(league.league_id || 'lg') + ':' + season;
        if (_cache[key]) return _cache[key];
        var fetchJson = ctx.fetchJson || defaultFetchJson;
        var scoring = league.scoring_settings || {};
        var rosters = ctx.rosters || [];
        var posOf = ctx.posOf || function () { return null; };
        var shape = slotShape(league.roster_positions);

        // v3: the 18 weekly feeds, not the season-total one. Sleeper's own
        // app scores the weekly feeds under the league's settings, so this is
        // the only source that matches what the owner sees inside Sleeper.
        var weekReqs = [];
        for (var w = 1; w <= 18; w++) {
            weekReqs.push(
                fetchJson('https://api.sleeper.app/v1/projections/nfl/regular/' + season + '/' + w)
                    .catch(function () { return {}; }) // a missing week never sinks the load
            );
        }
        _cache[key] = Promise.all([
            Promise.all(weekReqs),
            fetchJson('https://api.sleeper.app/v1/stats/nfl/regular/' + (season - 1)).catch(function () { return {}; }),
        ]).then(function (feeds) {
            var weeks = feeds[0] || [], prev = feeds[1] || {};
            // Per player: total projected points across the season and the
            // number of weeks with a real game projection (bye weeks project
            // zero, so per-game pace is total ÷ projected games — the ruled
            // per-game basis).
            var wkAgg = {};
            weeks.forEach(function (wk) {
                for (var pid in wk) {
                    var pts = scoreStats(wk[pid], scoring);
                    if (pts <= 0) continue;
                    var a = wkAgg[pid] || (wkAgg[pid] = { total: 0, games: 0 });
                    a.total += pts; a.games++;
                }
            });
            var IDP_POS = { DL: 1, LB: 1, DB: 1 };
            function ppgOf(pid, pos) {
                var a = wkAgg[pid];
                var proj = (a && a.games) ? a.total / a.games : 0;
                var st = prev[pid];
                var act = (st && st.gp) ? scoreStats(st, scoring) / st.gp : 0;
                if (!proj) return act; // no projection at all → last season's pace
                // v4 (owner ruling 2026-09-05): Sleeper's DEFENSIVE projections
                // run ~80% of actual pace and scramble the ranks (Devin Bush:
                // LB6 by 2025 actuals, LB28 projected). A proven defender keeps
                // his proven pace — unless the projection says his role
                // collapsed (under half his old pace), then the projection wins.
                if (IDP_POS[pos] && act > 0 && proj >= act * 0.5) return Math.max(proj, act);
                return proj;
            }

            var teams = {};
            var playersPpg = {}; // LAB v2: every rostered player's projected PPG
            rosters.forEach(function (r) {
                var pool = (r.players || []).map(function (pid) {
                    var pos = normPos(posOf(pid));
                    var p = { pid: String(pid), pos: pos, ppg: ppgOf(pid, pos) };
                    playersPpg[p.pid] = Math.round(p.ppg * 100) / 100;
                    return p;
                }).sort(function (a, b) { return b.ppg - a.ppg; });
                // LAB v2: keep the fill itself — which player sits in which
                // group — so the finder can reason about slot upgrades and
                // 2-for-1 consolidation (weakest starter per group, bench).
                var starters = {};
                var taken = {}, groupPts = {};
                var add = function (g, p) {
                    taken[p.pid] = 1;
                    groupPts[g] = (groupPts[g] || 0) + p.ppg;
                    (starters[g] = starters[g] || []).push({ pid: p.pid, pos: p.pos, ppg: Math.round(p.ppg * 100) / 100 });
                };
                Object.keys(shape.dedicated).forEach(function (pos) {
                    var need = shape.dedicated[pos];
                    for (var i = 0; i < pool.length && need > 0; i++) {
                        if (!taken[pool[i].pid] && pool[i].pos === pos) { add(pos, pool[i]); need--; }
                    }
                });
                var fill = function (n, ok, g) {
                    for (var i = 0; i < pool.length && n > 0; i++) {
                        if (!taken[pool[i].pid] && ok[pool[i].pos]) { add(g, pool[i]); n--; }
                    }
                };
                fill(shape.flexN, FLEX_OK, 'FLEX');
                fill(shape.sfN, SF_OK, 'SF');
                fill(shape.idpN, IDP_OK, 'IDP');
                var total = 0;
                Object.keys(groupPts).forEach(function (g) { total += groupPts[g]; });
                // LAB v2: weakest starter per group (the slot a trade would
                // upgrade) and the full starter pid set (everything else on
                // the roster is bench — consolidation currency).
                var weakest = {};
                Object.keys(starters).forEach(function (g) {
                    var w = starters[g].reduce(function (a, b) { return (b.ppg < a.ppg ? b : a); });
                    weakest[g] = w;
                });
                teams[r.roster_id] = {
                    rosterId: r.roster_id, groupPts: groupPts, total: total,
                    starters: starters, weakestStarter: weakest,
                    starterPids: Object.keys(taken),
                };
            });

            var groups = Object.keys(BARS).filter(function (g) {
                return shape.dedicated[g] || (g === 'FLEX' && shape.flexN) || (g === 'SF' && shape.sfN) || (g === 'IDP' && shape.idpN);
            });
            var n = rosters.length || 1;
            var leagueAvg = {};
            groups.forEach(function (g) {
                var s = 0;
                rosters.forEach(function (r) { s += (teams[r.roster_id].groupPts[g] || 0); });
                leagueAvg[g] = s / n;
            });
            var barTotal = 0;
            groups.forEach(function (g) { barTotal += BARS[g]; });

            rosters.forEach(function (r) {
                var t = teams[r.roster_id];
                t.pctOfBar = barTotal > 0 ? t.total / barTotal : 0;
                t.rel = {}; t.rank = {};
                groups.forEach(function (g) {
                    var mine = t.groupPts[g] || 0;
                    t.rel[g] = leagueAvg[g] > 0 ? mine / leagueAvg[g] : 1;
                    var better = 0;
                    rosters.forEach(function (o) { if ((teams[o.roster_id].groupPts[g] || 0) > mine) better++; });
                    t.rank[g] = better + 1;
                });
                // Soft spots: the two groups furthest below the league — the
                // scale-free read (projections run cool on IDP league-wide, so
                // rank/relative is the trustworthy signal, not points-to-bar).
                t.soft = groups.slice().sort(function (a, b) { return t.rel[a] - t.rel[b]; }).slice(0, 2);
                t.softDetail = t.soft.map(function (g) {
                    return { group: g, label: GROUP_LABEL[g] || g, rank: t.rank[g], of: n, relPct: Math.round(t.rel[g] * 100) };
                });
                // Strong groups (top-3 by rank) — the sell-from side of a Why.
                t.strong = groups.slice().sort(function (a, b) { return t.rank[a] - t.rank[b]; }).slice(0, 3)
                    .filter(function (g) { return t.rank[g] <= Math.ceil(n / 4); });
            });

            // v4 guard: a load where every lineup filled empty means the
            // caller's position lookup wasn't ready (player DB race). Hand the
            // result back but do NOT cache it — the next call must retry.
            var anyPoints = rosters.some(function (r) { return (teams[r.roster_id] || {}).total > 0; });
            var hasBodies = rosters.some(function (r) { return (r.players || []).length > 0; });
            if (!anyPoints && hasBodies) delete _cache[key];

            return {
                season: season, bars: BARS, barTotal: barTotal, groups: groups,
                teams: teams, leagueAvg: leagueAvg, teamCount: n,
                playersPpg: playersPpg, // LAB v2
            };
        }).catch(function (e) {
            delete _cache[key]; // a failed load must not poison the session
            throw e;
        });
        return _cache[key];
    }

    root.WrLabPointsLedger = {
        load: load,
        BARS: BARS,
        GROUP_LABEL: GROUP_LABEL,
        GROUP_PLURAL: GROUP_PLURAL,
        GROUP_POSITIONS: GROUP_POSITIONS,
        normPos: normPos,
        _slotShape: slotShape, // exposed for tests
    };
})(typeof window !== 'undefined' ? window : globalThis);
