// ══════════════════════════════════════════════════════════════════
// lab/intent-reads.js — owner intent, read from behavior (TRADE LAB ONLY)
//
// Four classes, inferred from receipts alone — roster strength (points
// ledger), premium pick capital (1sts+2nds owned for the next three
// drafts; 6 = your own set), FAAB spent, and completed transactions
// across last season plus this one. The exact rule set the paper run
// validated (2026-09-03: Steve WIN NOW, BigLoco REBUILDING with 8
// premium picks, KevinAudio CARETAKER on 19 txns vs median 111).
//
// Rulings honored here:
//  - Classes NEVER appear in the UI. softLine is the only outward text —
//    plain behavioral phrasing ("their eyes are on the future"), no
//    banners, no system vocabulary. (below-the-radar ruling)
//  - The owner's own declared strategy always beats the inferred class
//    for their own advice — consumers must read declarations first;
//    this module only describes RIVALS' behavior. (declaration wins)
//
// Loaded only by trade-lab.html. Nothing in production references it.
// ══════════════════════════════════════════════════════════════════
(function (root) {
    'use strict';

    var SOFT_LINE = {
        win_now: 'pushing all-in this season',
        rebuilding: 'eyes on the future, stacking picks',
        competing: 'active, but no clear lean',
        caretaker: 'quiet lately — simple offers travel best',
    };

    function defaultFetchJson(url) {
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
            return r.json();
        });
    }

    var _cache = {};

    // ctx: { league, rosters, ledger (WrLabPointsLedger model), fetchJson? }
    function read(ctx) {
        var league = ctx.league || {};
        var lid = String(league.league_id || '');
        if (!lid) return Promise.reject(new Error('intent-reads: no league_id'));
        if (_cache[lid]) return _cache[lid];
        var fetchJson = ctx.fetchJson || defaultFetchJson;
        var rosters = ctx.rosters || [];
        var ledger = ctx.ledger || null;
        var season = Number(league.season) || new Date().getFullYear();

        // Premium capital: 1sts + 2nds owned for the next three draft seasons.
        function capitalByRoster(tradedPicks) {
            var cap = {};
            rosters.forEach(function (r) { cap[r.roster_id] = 0; });
            for (var y = season + 1; y <= season + 3; y++) {
                [1, 2].forEach(function (round) {
                    rosters.forEach(function (orig) {
                        var owner = orig.roster_id;
                        (tradedPicks || []).forEach(function (p) {
                            if (String(p.season) === String(y) && p.round === round && p.roster_id === orig.roster_id) owner = p.owner_id;
                        });
                        if (cap[owner] !== undefined) cap[owner]++;
                    });
                });
            }
            return cap;
        }

        // Activity: completed transactions per roster, this season (weeks 1-3 so
        // far) plus ALL of last season via previous_league_id — early-season
        // reads need last year's baseline to mean anything.
        function fetchActivity() {
            var weeks = function (l, from, to) {
                var urls = [];
                for (var w = from; w <= to; w++) urls.push('https://api.sleeper.app/v1/league/' + l + '/transactions/' + w);
                return urls;
            };
            var urls = weeks(lid, 1, 3);
            var prevReady = league.previous_league_id
                ? fetchJson('https://api.sleeper.app/v1/league/' + league.previous_league_id + '/rosters').catch(function () { return null; })
                : Promise.resolve(null);
            return prevReady.then(function (prevRosters) {
                var prevUrls = league.previous_league_id ? weeks(league.previous_league_id, 1, 18) : [];
                return Promise.all(urls.concat(prevUrls).map(function (u) {
                    return fetchJson(u).catch(function () { return []; });
                })).then(function (all) {
                    // Map roster_id -> user, per league generation (ids differ across seasons).
                    var uidOf = {};      // 'cur:rid' / 'prev:rid' -> user_id
                    rosters.forEach(function (r) { uidOf['cur:' + r.roster_id] = String(r.owner_id); });
                    (prevRosters || []).forEach(function (r) { uidOf['prev:' + r.roster_id] = String(r.owner_id); });
                    var txns = {}, trades = {};
                    all.forEach(function (weekTxns, i) {
                        var gen = i < urls.length ? 'cur' : 'prev';
                        (weekTxns || []).forEach(function (t) {
                            if (!t || t.status !== 'complete') return;
                            (t.roster_ids || []).forEach(function (rid) {
                                var uid = uidOf[gen + ':' + rid];
                                if (!uid) return;
                                txns[uid] = (txns[uid] || 0) + 1;
                                if (t.type === 'trade') trades[uid] = (trades[uid] || 0) + 1;
                            });
                        });
                    });
                    return { txns: txns, trades: trades };
                });
            });
        }

        _cache[lid] = Promise.all([
            fetchJson('https://api.sleeper.app/v1/league/' + lid + '/traded_picks').catch(function () { return []; }),
            fetchActivity(),
        ]).then(function (parts) {
            var capital = capitalByRoster(parts[0]);
            var act = parts[1];
            var budget = (league.settings && league.settings.waiver_budget) || 100;
            var counts = rosters.map(function (r) { return act.txns[String(r.owner_id)] || 0; }).sort(function (a, b) { return a - b; });
            var medianTx = counts[Math.floor(counts.length / 2)] || 0;

            var byRosterId = {};
            rosters.forEach(function (r) {
                var uid = String(r.owner_id);
                var team = ledger && ledger.teams ? ledger.teams[r.roster_id] : null;
                var strength = team ? Math.round(team.pctOfBar * 100) : 0;
                var cap = capital[r.roster_id] || 0;
                var tx = act.txns[uid] || 0;
                var tr = act.trades[uid] || 0;
                var faabUsed = Math.round(((r.settings && r.settings.waiver_budget_used) || 0) / budget * 100);
                var cls, receipts;
                if (tx <= Math.max(3, medianTx * 0.25)) {
                    cls = 'caretaker';
                    receipts = [tx + ' transactions vs league median ' + medianTx, faabUsed + '% FAAB used'];
                } else if (strength >= 77 && cap <= 6) {
                    cls = 'win_now';
                    receipts = ['roster at ' + strength + '% of pace (top tier)', cap + '/6 premium picks — capital spent or level', faabUsed + '% FAAB used'];
                } else if (strength < 70 && cap >= 7) {
                    cls = 'rebuilding';
                    receipts = ['roster at ' + strength + '% of pace (bottom tier)', cap + '/6 premium picks — stockpiling', tx + ' txns, ' + tr + ' trades'];
                } else {
                    cls = 'competing';
                    receipts = ['roster at ' + strength + '% of pace', cap + '/6 premium picks (holding)', tx + ' txns, ' + tr + ' trades, ' + faabUsed + '% FAAB'];
                }
                byRosterId[r.roster_id] = {
                    cls: cls,
                    softLine: SOFT_LINE[cls],
                    receipts: receipts,
                    strength: strength, capital: cap, txns: tx, trades: tr, faabUsedPct: faabUsed,
                };
            });
            return { byRosterId: byRosterId, medianTx: medianTx };
        }).catch(function (e) {
            delete _cache[lid];
            throw e;
        });
        return _cache[lid];
    }

    root.WrLabIntentReads = { read: read, SOFT_LINE: SOFT_LINE };
})(typeof window !== 'undefined' ? window : globalThis);
