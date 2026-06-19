// ══════════════════════════════════════════════════════════════════
// js/shared/nfl-context.js — window.App.NflContext
// Loads the weekly NFL matchup context (opponent + home/away, Vegas
// implied total/spread, and weather) and feeds it to App.WeeklyProj so
// projections become matchup/weather-aware. Source: ESPN's public
// scoreboard (schedule + odds + weather in one call), fetched THROUGH a
// same-origin proxy (the browser is CORS-blocked from ESPN directly):
//   dev  → /api/nfl-scoreboard  (serve-static.cjs)
//   prod → a Supabase edge fn mirroring that proxy (DYNASTY_HQ_CONFIG).
// Degrades to a no-op (neutral projections) if the proxy is unavailable.
// ══════════════════════════════════════════════════════════════════
(function (root) {
    'use strict';
    const App = root.App = root.App || {};
    const _done = {}; // `${season}|${week}` already loaded

    // ESPN uses a few abbreviations that differ from Sleeper/MFL — normalize so
    // context keys match each player's team. (LAR/LAC/LV already align.)
    const ESPN_TO_SLEEPER = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR' };
    function normTeam(a) { a = String(a || '').toUpperCase(); return ESPN_TO_SLEEPER[a] || a; }

    function endpoint() {
        try { return (root.DYNASTY_HQ_CONFIG && root.DYNASTY_HQ_CONFIG.endpoints && root.DYNASTY_HQ_CONFIG.endpoints.nflScoreboard) || '/api/nfl-scoreboard'; }
        catch (e) { return '/api/nfl-scoreboard'; }
    }

    // ESPN scoreboard → { `${TEAM}|${week}`: { opp, home, vegas:{impliedTotal,spread,opp}, weather } }
    function parse(espn, week) {
        const out = {};
        const events = (espn && espn.events) || [];
        events.forEach(ev => {
            const comp = ev.competitions && ev.competitions[0];
            if (!comp) return;
            const cs = comp.competitors || [];
            const home = cs.find(c => c.homeAway === 'home');
            const away = cs.find(c => c.homeAway === 'away');
            const hAbbr = normTeam(home && home.team && home.team.abbreviation);
            const aAbbr = normTeam(away && away.team && away.team.abbreviation);
            if (!hAbbr || !aAbbr) return;

            const indoor = !!(comp.venue && comp.venue.indoor);
            const w = comp.weather;
            const weather = indoor ? { indoor: true }
                : (w ? { temp: (w.temperature != null ? Number(w.temperature) : (w.highTemperature != null ? Number(w.highTemperature) : null)), display: w.displayValue || '', condId: w.conditionId } : null);

            // Odds → game total + favorite/line (parse details, which names the favorite).
            const odds = comp.odds && comp.odds[0];
            let total = null, favAbbr = null, line = null;
            if (odds) {
                if (odds.overUnder != null) total = Number(odds.overUnder);
                const det = odds.details ? String(odds.details) : '';
                if (/\beven\b|\bpk\b|pick/i.test(det)) line = 0;
                const m = det.match(/([A-Z]{2,4})\s*(-?\d+(?:\.\d+)?)/);
                if (m) { favAbbr = m[1]; line = Math.abs(Number(m[2])); }
                if (line == null && odds.spread != null) { line = Math.abs(Number(odds.spread)); favAbbr = Number(odds.spread) < 0 ? hAbbr : aAbbr; }
            }

            function teamCtx(meAbbr, oppAbbr, isHome) {
                let impliedTotal = null, spread = null;
                if (total != null && line != null && favAbbr) {
                    const fav = meAbbr === favAbbr;
                    impliedTotal = total / 2 + (fav ? line / 2 : -line / 2);
                    spread = fav ? -line : line;
                } else if (total != null) {
                    impliedTotal = total / 2;
                }
                const vegas = impliedTotal != null
                    ? { impliedTotal: Math.round(impliedTotal * 10) / 10, spread: spread, opp: oppAbbr }
                    : (oppAbbr ? { opp: oppAbbr } : null);
                return { opp: oppAbbr, home: isHome, vegas: vegas, weather: weather };
            }
            out[hAbbr + '|' + week] = teamCtx(hAbbr, aAbbr, true);
            out[aAbbr + '|' + week] = teamCtx(aAbbr, hAbbr, false);
        });
        return out;
    }

    function fetchWeek(week, season) {
        let u = endpoint() + '?week=' + week + '&seasontype=2';
        if (season) u += '&season=' + season;
        return fetch(u).then(r => { if (!r.ok) throw new Error('scoreboard ' + r.status); return r.json(); });
    }

    // Load one or more weeks and feed App.WeeklyProj.setContext. Caches per
    // (season, week). Returns the merged byTeamWeek map (or {} on failure).
    async function load(weeks, season) {
        const WP = App.WeeklyProj;
        if (!WP) return {};
        season = Number(season || (root.S && root.S.season) || (root.S && root.S.nflState && root.S.nflState.season) || 0) || 0;
        const list = (Array.isArray(weeks) ? weeks : [weeks]).map(Number).filter(w => w > 0 && w <= 18);
        const byTeamWeek = {};
        for (const wk of list) {
            const key = season + '|' + wk;
            if (_done[key]) continue;
            try {
                const espn = await fetchWeek(wk, season);
                Object.assign(byTeamWeek, parse(espn, wk));
                _done[key] = true;
            } catch (e) { if (root.wrLog) root.wrLog('nflContext.load', e); }
        }
        if (Object.keys(byTeamWeek).length && WP.setContext) WP.setContext({ byTeamWeek });
        return byTeamWeek;
    }

    function loadCurrent(season) {
        const WP = App.WeeklyProj;
        const wk = WP && WP.currentWeek ? WP.currentWeek() : 1;
        return load([wk], season);
    }

    App.NflContext = App.NflContext || { load, loadCurrent, parse, endpoint, _done };
})(typeof window !== 'undefined' ? window : globalThis);
