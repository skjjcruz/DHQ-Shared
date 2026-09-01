// ══════════════════════════════════════════════════════════════════
// shared/nfl-roles.js — fresh NFL depth-chart roles (owner build 2026-08-31).
//
// Sleeper's depth_chart_order lags real roles by days (it listed the
// Chargers' starting TE as TE3), so situational advice punished exactly the
// players whose stock just rose. This loads ESPN's editorial depth charts
// via the nfl-depth-charts edge proxy on every app open, joins them to
// Sleeper players by team + normalized name, and answers one question:
//
//   App.NflRoles.starterRole(player) → 'QB1' / 'RB2' / 'WR3' / 'LB1' / null
//
// Non-null means "listed with a starting-caliber role" — drop advice must
// never fire on these players (owner rule). Starter thresholds:
//   QB/TE/K + every defensive sub-slot: rank 1
//   RB: rank ≤ 2 (committees)      WR: rank ≤ 3 (three start)
//
// Fails soft everywhere: no fetch / no match → null → callers behave as
// before. Cached 3h in localStorage (janitor-purgeable, rebuildable).
// ══════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';
  const App = root.App = root.App || {};

  const CACHE_KEY = 'dhq_nfl_roles_v1';
  const TTL_MS = 3 * 60 * 60 * 1000;
  const STARTER_RANK = { QB: 1, RB: 2, WR: 3, TE: 1, K: 1, DL: 1, LB: 1, DB: 1 };

  let _roles = null;    // { 'TEAM|norm name': { pos, rank } }
  let _loading = null;
  let _settled = false; // load finished (with data OR failed) — consumers that
                        // must not freeze half-loaded verdicts wait on this.

  function normName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/\b(jr|sr|ii|iii|iv|v)\.?$/g, '')
      .replace(/[^a-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const ESPN_TO_SLEEPER = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR' };
  function normTeam(t) { t = String(t || '').toUpperCase(); return ESPN_TO_SLEEPER[t] || t; }

  function endpoint() {
    try {
      const base = (App.CONFIG && App.CONFIG.functionsBase) || 'https://sxshiqyxhhifvtfqawbq.supabase.co/functions/v1';
      return base + '/nfl-depth-charts';
    } catch (e) { return 'https://sxshiqyxhhifvtfqawbq.supabase.co/functions/v1/nfl-depth-charts'; }
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || !c.ts || !c.roles) return null;
      if (Date.now() - c.ts > TTL_MS) return null;
      return c.roles;
    } catch (e) { return null; }
  }

  function load() {
    if (_roles) return Promise.resolve(_roles);
    if (_loading) return _loading;
    const cached = readCache();
    if (cached) {
      _roles = cached;
      _settled = true;
      try { root.dispatchEvent(new Event('wr:roles-loaded')); } catch (e) {}
      return Promise.resolve(_roles);
    }
    _loading = fetch(endpoint())
      .then(r => r.ok ? r.json() : null)
      .then(doc => {
        const roles = doc && doc.roles;
        if (roles && typeof roles === 'object' && Object.keys(roles).length > 50) {
          _roles = roles;
          try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), roles })); } catch (e) { /* cache is a bonus */ }
          try { root.dispatchEvent(new Event('wr:roles-loaded')); } catch (e) {}
        }
        return _roles;
      })
      .catch(() => null)
      .finally(() => { _loading = null; _settled = true; });
    return _loading;
  }

  // Sleeper player object → { pos, rank } from the freshest depth chart.
  function roleFor(p) {
    if (!_roles || !p) return null;
    const team = normTeam(p.team);
    if (!team) return null;
    const nm = normName(p.full_name || ((p.first_name || '') + ' ' + (p.last_name || '')));
    if (!nm) return null;
    const hit = _roles[team + '|' + nm];
    if (!hit) return null;
    // Position guard — same-name teammate at another position must not match.
    const pPos = (App.normPos && App.normPos(p.position)) || p.position;
    if (pPos && hit.pos && pPos !== hit.pos && !(pPos === 'RB' && hit.pos === 'RB')) {
      if (String(pPos) !== String(hit.pos)) return null;
    }
    return hit;
  }

  // 'TE1' / 'RB2' when the player holds a starting-caliber role, else null.
  function starterRole(p) {
    const r = roleFor(p);
    if (!r) return null;
    const limit = STARTER_RANK[r.pos];
    if (!limit || r.rank > limit) return null;
    return r.pos + r.rank;
  }

  App.NflRoles = {
    load, roleFor, starterRole, _normName: normName,
    settled: () => _settled,
    count: () => (_roles ? Object.keys(_roles).length : 0),
  };
  // Check the depth charts on every app open (owner rule 2026-08-31).
  try { load(); } catch (e) { /* soft */ }
})(typeof window !== 'undefined' ? window : globalThis);
