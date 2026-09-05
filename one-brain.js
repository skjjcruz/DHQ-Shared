// ══════════════════════════════════════════════════════════════════
// lab/one-brain.js — the one team-truth engine (TRADE LAB ONLY)
//
// Computes every team's assessment ONCE from the ratified method of
// record (owner rulings 2026-09-04, all five calls):
//
//   HEALTH (0-100) = 60 pace + 25 starter quality + 15 draft picks
//     • pace          — % of the championship bar, per game played
//                       (ledger v3 weekly feeds)
//     • starter qual  — quality starters filled vs the starter template
//                       auto-derived from the league lineup (hard slots
//                       + flex shares; kicker floor 2). "It's all about
//                       the quality, not roster construction."
//     • draft picks   — premium ammo (1sts ×2 + 2nds) vs the standard
//                       set of 3 + 3 over the tradeable pick years
//
//   QUALITY STARTER — "top whatever per position": a player counts only
//   if his per-game projection ranks inside the league's total demand
//   for the position (teams × template need). Everyone else is simply
//   A PLAYER — tradeable, handcuff-able, but zero toward the template.
//   ELITES COUNT AS ONE. Pure and simple — no offsets anywhere.
//
//   POWER RANK — preseason: best-lineup projected weekly points, 1-16,
//   nothing mixed in. In-season: (wins + 0.5×ties) × 10,000 + points
//   scored — record is the boss, points sort within a record. Health
//   rides alongside and is allowed to disagree.
//
// Loaded only by trade-lab.html. Nothing in production references it.
// ══════════════════════════════════════════════════════════════════
(function (root) {
    'use strict';

    var TIER_BANDS = [
        // Same four names + colors every surface already speaks. Bands sit
        // higher than the old assessor's 90/80/70 (full-roster preseason
        // grades cluster high), and each carries a PACE GATE: no amount of
        // depth-and-picks health makes a team a contender if its lineup
        // can't score — pace is the price of the label.
        { min: 97, pace: 1.00, tier: 'ELITE', color: '#D4AF37', bg: 'rgba(212,175,55,0.15)' },
        { min: 85, pace: 0.90, tier: 'CONTENDER', color: '#2ECC71', bg: 'rgba(46,204,113,0.12)' },
        { min: 75, pace: 0.75, tier: 'CROSSROADS', color: '#F0A500', bg: 'rgba(240,165,0,0.12)' },
        { min: -1, pace: 0, tier: 'REBUILDING', color: '#E74C3C', bg: 'rgba(231,76,60,0.12)' },
    ];

    function normPos(p) {
        var L = root.WrLabPointsLedger;
        return L ? L.normPos(p) : String(p || '').toUpperCase();
    }

    // Starter template: hard slots count whole, flex slots split by who
    // usually fills them (same shares the production assessor uses), then
    // rounded. Kicker floor of 2 (owner ruling: one K is a bye-week trap).
    function starterTemplate(rosterPositions) {
        var shares = {};
        (rosterPositions || []).forEach(function (s) {
            if (s === 'BN' || s === 'IR' || s === 'TAXI') return;
            var n = normPos(s);
            if (['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'].indexOf(n) >= 0) {
                shares[n] = (shares[n] || 0) + 1;
            } else if (s === 'FLEX' || s === 'WRRB_FLEX') {
                shares.RB = (shares.RB || 0) + 0.4; shares.WR = (shares.WR || 0) + 0.4; shares.TE = (shares.TE || 0) + 0.2;
            } else if (s === 'SUPER_FLEX' || s === 'OP') {
                shares.QB = (shares.QB || 0) + 0.5; shares.RB = (shares.RB || 0) + 0.25; shares.WR = (shares.WR || 0) + 0.25;
            } else if (s === 'IDP_FLEX' || s === 'IDP') {
                shares.DL = (shares.DL || 0) + 0.35; shares.LB = (shares.LB || 0) + 0.35; shares.DB = (shares.DB || 0) + 0.3;
            } else if (s === 'REC_FLEX') {
                shares.WR = (shares.WR || 0) + 0.5; shares.TE = (shares.TE || 0) + 0.5;
            }
        });
        var tpl = {};
        Object.keys(shares).forEach(function (pos) {
            tpl[pos] = Math.max(1, Math.round(shares[pos]));
        });
        if (tpl.K) tpl.K = Math.max(tpl.K, 2);
        return tpl;
    }

    // compute(ctx) → { byRosterId, template, cutoffs, powerOrder }
    //   ctx: { ledger (v3 load result), leagueInfo (raw Sleeper league),
    //          rosters, posOf(pid), picksByOwner ({ownerUserId: [{year,round}]}) }
    function compute(ctx) {
        var ledger = ctx.ledger;
        var rosters = ctx.rosters || [];
        var posOf = ctx.posOf || function () { return null; };
        var picksByOwner = ctx.picksByOwner || {};
        var league = ctx.leagueInfo || {};
        if (!ledger || !ledger.playersPpg || !rosters.length) return null;

        var template = starterTemplate(league.roster_positions);
        var positions = Object.keys(template);
        var teamCount = rosters.length;

        // ── Quality cutoffs: top (teams × template need) per position ──
        // Pool = every rostered player with a real projection. The Nth
        // best per-game number IS the quality bar; ties on it count in.
        var byPos = {};
        rosters.forEach(function (r) {
            (r.players || []).forEach(function (pid) {
                var pos = normPos(posOf(pid));
                if (positions.indexOf(pos) < 0) return;
                var ppg = ledger.playersPpg[String(pid)] || 0;
                if (ppg <= 0) return;
                (byPos[pos] = byPos[pos] || []).push(ppg);
            });
        });
        var cutoffs = {};
        positions.forEach(function (pos) {
            var list = (byPos[pos] || []).sort(function (a, b) { return b - a; });
            var n = teamCount * template[pos];
            cutoffs[pos] = list.length ? list[Math.min(n, list.length) - 1] : Infinity;
        });

        // ── Per-team pass ────────────────────────────────────────────
        var templateTotal = 0;
        positions.forEach(function (pos) { templateTotal += template[pos]; });

        var byRosterId = {};
        var anyGames = false;
        rosters.forEach(function (r) {
            var t = ledger.teams[r.roster_id] || {};
            // Taxi and IR bodies can't take the field — they never count
            // toward the starter template (they still trade fine).
            var benchable = {};
            (r.taxi || []).concat(r.reserve || []).forEach(function (pid) { benchable[String(pid)] = 1; });

            var qualityCount = {}, qualityPids = {};
            positions.forEach(function (pos) { qualityCount[pos] = 0; qualityPids[pos] = []; });
            (r.players || []).forEach(function (pid) {
                pid = String(pid);
                if (benchable[pid]) return;
                var pos = normPos(posOf(pid));
                if (positions.indexOf(pos) < 0) return;
                var ppg = ledger.playersPpg[pid] || 0;
                if (ppg > 0 && ppg >= cutoffs[pos]) {
                    qualityCount[pos]++;
                    qualityPids[pos].push(pid);
                }
            });

            var filled = 0;
            var needs = [], strengths = [];
            positions.forEach(function (pos) {
                var need = template[pos];
                var have = qualityCount[pos];
                filled += Math.min(have, need);
                if (have < need) {
                    needs.push({ pos: pos, urgency: (need - have) >= 2 ? 'deficit' : 'thin', have: have, need: need });
                } else if (have > need) {
                    strengths.push({ pos: pos, extra: have - need });
                }
            });
            needs.sort(function (a, b) { return (b.need - b.have) - (a.need - a.have); });
            strengths.sort(function (a, b) { return b.extra - a.extra; });

            // ── The three ruled pieces ───────────────────────────────
            var paceScore = 60 * Math.min(1, t.pctOfBar || 0);
            var qualityScore = 25 * (templateTotal > 0 ? filled / templateTotal : 0);
            var picks = picksByOwner[String(r.owner_id)] || [];
            var firsts = 0, seconds = 0;
            picks.forEach(function (p) {
                if (p.round === 1) firsts++;
                else if (p.round === 2) seconds++;
            });
            var capitalScore = 15 * Math.min(1, (firsts * 2 + seconds) / 9);
            var health = Math.round(paceScore + qualityScore + capitalScore);

            var pct = t.pctOfBar || 0;
            var band = TIER_BANDS.filter(function (b) { return health >= b.min && pct >= b.pace; })[0];

            var s = r.settings || {};
            var wins = s.wins || 0, losses = s.losses || 0, ties = s.ties || 0;
            var pf = Number(s.fpts || 0) + Number(s.fpts_decimal || 0) / 100;
            if (wins + losses + ties > 0) anyGames = true;

            byRosterId[String(r.roster_id)] = {
                rosterId: r.roster_id,
                health: health,
                paceScore: Math.round(paceScore * 10) / 10,
                pctOfBar: t.pctOfBar || 0,
                weeklyPts: Math.round((t.total || 0) * 10) / 10,
                barTotal: ledger.barTotal,
                qualityScore: Math.round(qualityScore * 10) / 10,
                qualityFilled: filled,
                qualityTotal: templateTotal,
                qualityCount: qualityCount,
                qualityPids: qualityPids,
                capitalScore: Math.round(capitalScore * 10) / 10,
                firsts: firsts, seconds: seconds,
                tier: band.tier, tierColor: band.color, tierBg: band.bg,
                needs: needs, strengths: strengths,
                wins: wins, losses: losses, ties: ties, pf: pf,
            };
        });

        // ── Power rank (ruled #2) ────────────────────────────────────
        var order = rosters.map(function (r) { return byRosterId[String(r.roster_id)]; });
        order.forEach(function (t2) {
            t2.powerScore = anyGames
                ? (t2.wins + 0.5 * t2.ties) * 10000 + t2.pf
                : t2.weeklyPts;
        });
        order.sort(function (a, b) { return b.powerScore - a.powerScore; });
        order.forEach(function (t2, i) { t2.powerRank = i + 1; });

        return {
            byRosterId: byRosterId,
            template: template,
            templateTotal: templateTotal,
            cutoffs: cutoffs,
            inSeason: anyGames,
            powerOrder: order.map(function (t2) { return t2.rosterId; }),
        };
    }

    root.WrLabOneBrain = {
        compute: compute,
        starterTemplate: starterTemplate, // exposed for tests
        TIER_BANDS: TIER_BANDS,
    };
})(typeof window !== 'undefined' ? window : globalThis);
