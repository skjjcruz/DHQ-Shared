// shared/dhq-providers.js — Platform-agnostic data providers for DHQ engine
// Each provider normalizes platform-specific API data into a common shape
// so the DHQ valuation engine works identically across Sleeper, MFL, ESPN, Yahoo.
window.App = window.App || {};

(function() {
'use strict';

const SLEEPER_BASE = 'https://api.sleeper.app/v1';

// ══════════════════════════════════════════════════════════════════
// PROVIDER INTERFACE — every provider returns data in this shape
// ══════════════════════════════════════════════════════════════════
//
// getLeagueChain(leagueId, currentSeason)
//   → [{ id, season, draft_id }]
//
// getDraftPicks(chainEntry)
//   → [{ season, round, pick_no, roster_id, pid, name, pos, team }]
//
// getTransactions(chainEntry)
//   → { trades: [{ season, week, roster_ids, sides, ts }], faab: [{ season, pid, pos, bid }] }
//
// getBracket(chainEntry)
//   → { winners: [...], losers: [...] } | null
//
// getLeagueUsers(chainEntry)
//   → [{ user_id, display_name, avatar }]
//
// refreshTrades(chainEntry)
//   → [{ season, week, roster_ids, sides, ts }]  (current season only)

// ══════════════════════════════════════════════════════════════════
// SLEEPER PROVIDER — full feature support
// ══════════════════════════════════════════════════════════════════

const SleeperProvider = {
  name: 'sleeper',

  async getLeagueChain(leagueId, currentSeason) {
    const chain = [];
    let lid = leagueId;
    while (lid) {
      const l = await fetch(`${SLEEPER_BASE}/league/${lid}`).then(r => r.json()).catch(() => null);
      if (!l) break;
      chain.push({ id: l.league_id, season: l.season, draft_id: l.draft_id, prev: l.previous_league_id });
      lid = l.previous_league_id;
    }
    return chain;
  },

  async getDraftPicks(chainEntry) {
    const S = window.App.S || window.S;
    const posMapLocal = p => { if (['DE','DT'].includes(p)) return 'DL'; if (['CB','S'].includes(p)) return 'DB'; return p; };
    const drafts = await fetch(`${SLEEPER_BASE}/league/${chainEntry.id}/drafts`).then(r => r.json()).catch(() => []);
    const completed = (drafts || []).filter(d => d.draft_id && d.status === 'complete');
    // Fetch every completed draft's picks concurrently — was awaited one draft
    // at a time, serializing the round-trips on the DHQ cold path. Each draft is
    // independent; flatten in chain order, so output is unchanged.
    const perDraft = await Promise.all(completed.map(async d => {
      const dpicks = await fetch(`${SLEEPER_BASE}/draft/${d.draft_id}/picks`).then(r => r.ok ? r.json() : []).catch(() => []);
      const rounds = d.settings?.rounds || dpicks.reduce((m, p) => Math.max(m, p.round), 0);
      if (rounds >= 20) return []; // startup draft
      const veteranCount = dpicks.filter(p => { const pl = S?.players?.[p.player_id]; return pl && (pl.years_exp || 0) >= 2; }).length;
      if (veteranCount > dpicks.length * 0.5) return []; // startup
      return dpicks.filter(p => p.metadata?.position).map(p => ({
        season: chainEntry.season, round: p.round, pick_no: p.pick_no,
        roster_id: p.roster_id, pid: p.player_id,
        name: (p.metadata.first_name || '') + ' ' + (p.metadata.last_name || ''),
        pos: posMapLocal(p.metadata.position), rawPos: p.metadata.position,
        team: p.metadata.team,
      }));
    }));
    return perDraft.flat();
  },

  async getTransactions(chainEntry, currentSeason) {
    const S = window.App.S || window.S;
    const pPos = window.App.pPos || window.pPos || (id => S?.players?.[id]?.position || '');
    const posMapLocal = p => { if (['DE','DT'].includes(p)) return 'DL'; if (['CB','S'].includes(p)) return 'DB'; return p; };
    const positions = ['QB','RB','WR','TE','DL','LB','DB'];
    const trades = [];
    const faab = [];
    const seasonNum = parseInt(chainEntry.season);
    const isFaabSeason = seasonNum >= currentSeason - 2;
    const weeks = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18];

    await Promise.all(weeks.map(w =>
      fetch(`${SLEEPER_BASE}/league/${chainEntry.id}/transactions/${w}`)
        .then(r => r.ok ? r.json() : []).catch(() => [])
        .then(txns => txns.forEach(t => {
          if (t.status === 'failed') return;
          if (isFaabSeason && t.type === 'waiver' && (t.settings?.waiver_bid || 0) > 0) {
            Object.keys(t.adds || {}).forEach(pid => {
              const pos = posMapLocal(pPos(pid) || S?.players?.[pid]?.position || '');
              if (positions.includes(pos)) faab.push({ season: chainEntry.season, pid, pos, bid: t.settings.waiver_bid });
            });
          }
          if (t.type === 'trade') {
            const rids = t.roster_ids || [];
            const sides = {};
            rids.forEach(rid => sides[rid] = { players: [], picks: [] });
            Object.entries(t.adds || {}).forEach(([pid, rid]) => { if (sides[rid]) sides[rid].players.push(pid); });
            (t.draft_picks || []).forEach(pk => { if (sides[pk.owner_id]) sides[pk.owner_id].picks.push({ season: pk.season, round: pk.round }); });
            trades.push({ season: chainEntry.season, week: w, roster_ids: rids, sides, ts: t.created || t.status_updated || 0 });
          }
        }))
    ));
    return { trades, faab };
  },

  async getBracket(chainEntry) {
    const [winners, losers] = await Promise.all([
      fetch(`${SLEEPER_BASE}/league/${chainEntry.id}/winners_bracket`).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`${SLEEPER_BASE}/league/${chainEntry.id}/losers_bracket`).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    return { winners: winners || [], losers: losers || [] };
  },

  async getLeagueUsers(chainEntry) {
    const users = await fetch(`${SLEEPER_BASE}/league/${chainEntry.id}/users`).then(r => r.ok ? r.json() : []).catch(() => []);
    return (users || []).map(u => ({ user_id: u.user_id, display_name: u.display_name || u.username, avatar: u.avatar }));
  },

  async refreshTrades(chainEntry) {
    const trades = [];
    const weeks = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18];
    await Promise.all(weeks.map(w =>
      fetch(`${SLEEPER_BASE}/league/${chainEntry.id}/transactions/${w}`)
        .then(r => r.ok ? r.json() : []).catch(() => [])
        .then(txns => txns.forEach(t => {
          if (t.status === 'failed' || t.type !== 'trade') return;
          const rids = t.roster_ids || [];
          const sides = {};
          rids.forEach(rid => sides[rid] = { players: [], picks: [] });
          Object.entries(t.adds || {}).forEach(([pid, rid]) => { if (sides[rid]) sides[rid].players.push(pid); });
          (t.draft_picks || []).forEach(pk => { if (sides[pk.owner_id]) sides[pk.owner_id].picks.push({ season: pk.season, round: pk.round }); });
          trades.push({ season: chainEntry.season, week: w, roster_ids: rids, sides, ts: t.created || t.status_updated || 0 });
        }))
    ));
    return trades;
  },
};

// ══════════════════════════════════════════════════════════════════
// MFL PROVIDER — league history via same ID across years
// ══════════════════════════════════════════════════════════════════

const MFLProvider = {
  name: 'mfl',

  _getMflConfig() {
    const S = window.App.S || window.S;
    // Extract raw MFL league ID from our prefixed ID (mfl_41969_2026 → 41969)
    // Also handles hash fragments like mfl_41969#0_2026
    const rawId = (S?.mflLeagueId || '').replace(/^mfl_/, '').replace(/#.*$/, '') || S?.currentLeagueId?.replace(/^mfl_(\d+)[#_].*$/, '$1') || '';
    const apiKey = S?._mflApiKey || '';
    return { rawId, apiKey };
  },

  _mflUrl(year, type, leagueId, apiKey, extra) {
    let url = `https://api.myfantasyleague.com/${year}/export?TYPE=${type}&L=${leagueId}&JSON=1`;
    if (apiKey) url += '&APIKEY=' + encodeURIComponent(apiKey);
    if (extra) url += '&' + extra;
    return url;
  },

  async _mflGet(url) {
    // MFL blocks all cross-origin requests — route through our Edge Function proxy.
    // Supabase's gateway requires Authorization + apikey headers even for public
    // functions (verify_jwt defaults to true) — pass the anon key when there's
    // no user session, same pattern as shared/mfl-api.js _mflGet and ai-analyze.
    const config  = window.App?.CONFIG || window.OD?.CONFIG || {};
    const supabaseBase = window.OD?.SUPABASE_URL || window.App?.SUPABASE_URL || '';
    const base    = config.functionsBase || (supabaseBase ? supabaseBase + '/functions/v1' : '');
    const endpoint = config.endpoints?.mflProxy || (base ? base + '/mfl-proxy' : null);
    const anonKey = config.supabaseAnon || window.OD?.SUPABASE_ANON || window.App?.SUPABASE_ANON;
    const token   = window.OD?.getSessionToken?.() || null;
    if (endpoint && anonKey) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token || anonKey}`,
            'apikey': anonKey,
          },
          body: JSON.stringify({ url }),
        });
        if (!res.ok) return null;
        return res.json();
      } catch (e) {
        console.warn('[MFL] Proxy fetch error:', e);
        return null;
      }
    }
    // Fallback: direct fetch (same-origin only)
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  },

  async getLeagueChain(leagueId, currentSeason) {
    const { rawId, apiKey } = this._getMflConfig();
    if (!rawId) return [{ id: leagueId, season: String(currentSeason) }];
    const chain = [];
    // MFL uses the same league ID across years — query each year
    for (let yr = currentSeason; yr >= currentSeason - 4; yr--) {
      try {
        const data = await this._mflGet(this._mflUrl(yr, 'league', rawId, apiKey));
        if (data?.league?.name) {
          chain.push({ id: `mfl_${rawId}_${yr}`, season: String(yr), _mflId: rawId, _mflYear: yr });
        }
      } catch (e) { /* year doesn't exist for this league */ }
    }
    return chain.length ? chain : [{ id: leagueId, season: String(currentSeason), _mflId: rawId, _mflYear: currentSeason }];
  },

  async getDraftPicks(chainEntry) {
    const { apiKey } = this._getMflConfig();
    const mflId = chainEntry._mflId;
    const yr = chainEntry._mflYear || parseInt(chainEntry.season);
    if (!mflId) return [];
    try {
      const data = await this._mflGet(this._mflUrl(yr, 'draftResults', mflId, apiKey));
      const units = data?.draftResults?.draftUnit;
      if (!units) return [];
      const unitArr = Array.isArray(units) ? units : [units];
      const cw = window.MFL?._crosswalk || {};
      const S = window.App.S || window.S;
      const picks = [];
      unitArr.forEach(unit => {
        const dpicks = unit?.draftPick || [];
        const pickArr = Array.isArray(dpicks) ? dpicks : [dpicks];
        pickArr.forEach(pick => {
          if (!pick?.player) return; // undrafted slot
          const sid = cw[pick.player] || ('mfl_' + pick.player);
          const pl = S?.players?.[sid];
          const pos = pl?.position || '';
          const posMapLocal = p => { if (['DE','DT'].includes(p)) return 'DL'; if (['CB','S'].includes(p)) return 'DB'; return p; };
          picks.push({
            season: chainEntry.season, round: parseInt(pick.round) || 1, pick_no: parseInt(pick.pick) || 1,
            roster_id: pick.franchise, pid: sid,
            name: pl?.full_name || sid,
            pos: posMapLocal(pos), rawPos: pos, team: pl?.team || '',
          });
        });
      });
      return picks;
    } catch (e) { console.warn('[MFL] Draft fetch error:', e); return []; }
  },

  async getTransactions(chainEntry, currentSeason) {
    const { apiKey } = this._getMflConfig();
    const mflId = chainEntry._mflId;
    const yr = chainEntry._mflYear || parseInt(chainEntry.season);
    if (!mflId) return { trades: [], faab: [] };
    try {
      const data = await this._mflGet(this._mflUrl(yr, 'transactions', mflId, apiKey));
      const txnArr = data?.transactions?.transaction || [];
      const txns = Array.isArray(txnArr) ? txnArr : [txnArr];
      const cw = window.MFL?._crosswalk || {};
      const trades = [];

      txns.filter(t => t?.type === 'TRADE').forEach(t => {
        const rids = [t.franchise, t.franchise2].filter(Boolean);
        const sides = {};
        rids.forEach(rid => sides[rid] = { players: [], picks: [] });
        // Parse franchise1 gave up → franchise2 acquired
        (t.franchise1_gave_up || '').split(',').map(s => s.trim()).filter(s => s && !s.startsWith('FP_') && !s.startsWith('DP_')).forEach(pid => {
          const sid = cw[pid] || ('mfl_' + pid);
          if (sides[t.franchise2]) sides[t.franchise2].players.push(sid);
        });
        // Parse franchise2 gave up → franchise1 acquired
        (t.franchise2_gave_up || '').split(',').map(s => s.trim()).filter(s => s && !s.startsWith('FP_') && !s.startsWith('DP_')).forEach(pid => {
          const sid = cw[pid] || ('mfl_' + pid);
          if (sides[t.franchise]) sides[t.franchise].players.push(sid);
        });
        // Parse pick trades by WHICH SIDE gave the pick up (the gave_up field is
        // unambiguous). Do NOT infer direction from a pick's original-owner id —
        // a pick can change hands multiple times, so original-owner != giver.
        // Handle BOTH future picks (FP_<owner>_<year>_<round>, round 1-indexed) and
        // current-year draft picks (DP_<round>_<pickInRound>, round 0-indexed).
        const addPicks = (giveStr, receiverRid) => {
          if (!sides[receiverRid]) return;
          (giveStr || '').split(',').map(s => s.trim()).forEach(item => {
            if (item.startsWith('FP_')) {
              const p = item.split('_'); // FP_<owner>_<year>_<round>
              if (p.length >= 4) sides[receiverRid].picks.push({ season: p[2], round: parseInt(p[3]) || 1 });
            } else if (item.startsWith('DP_')) {
              const p = item.split('_'); // DP_<round0>_<pickInRound>  (round is 0-indexed)
              if (p.length >= 2) sides[receiverRid].picks.push({ season: String(chainEntry.season), round: (parseInt(p[1]) || 0) + 1 });
            }
          });
        };
        addPicks(t.franchise1_gave_up, t.franchise2); // franchise1 gave → franchise2 received
        addPicks(t.franchise2_gave_up, t.franchise);  // franchise2 gave → franchise1 received
        trades.push({ season: chainEntry.season, week: 0, roster_ids: rids, sides, ts: parseInt(t.timestamp || 0) * 1000 });
      });

      // MFL doesn't expose FAAB bid amounts in structured form
      return { trades, faab: [] };
    } catch (e) { console.warn('[MFL] Transaction fetch error:', e); return { trades: [], faab: [] }; }
  },

  async getBracket(chainEntry) {
    // MFL doesn't expose bracket data via public API
    return null;
  },

  async getLeagueUsers(chainEntry) {
    const { apiKey } = this._getMflConfig();
    const mflId = chainEntry._mflId;
    const yr = chainEntry._mflYear || parseInt(chainEntry.season);
    if (!mflId) return [];
    try {
      const data = await this._mflGet(this._mflUrl(yr, 'league', mflId, apiKey));
      const franchises = data?.league?.franchises?.franchise || [];
      const fArr = Array.isArray(franchises) ? franchises : [franchises];
      return fArr.map(f => ({
        user_id: f.id,
        display_name: f.owner_name || f.name || ('Team ' + f.id),
        avatar: null,
      }));
    } catch (e) { return []; }
  },

  async refreshTrades(chainEntry) {
    const result = await this.getTransactions(chainEntry);
    return result.trades;
  },
};

// ══════════════════════════════════════════════════════════════════
// ESPN PROVIDER — single-season stub
// ══════════════════════════════════════════════════════════════════

const ESPNProvider = {
  name: 'espn',
  async getLeagueChain(leagueId, currentSeason) {
    return [{ id: leagueId, season: String(currentSeason) }];
  },
  async getDraftPicks() { return []; },
  async getTransactions() { return { trades: [], faab: [] }; },
  async getBracket() { return null; },
  async getLeagueUsers() { return []; },
  async refreshTrades() { return []; },
};

// ══════════════════════════════════════════════════════════════════
// YAHOO PROVIDER — single-season stub
// ══════════════════════════════════════════════════════════════════

const YahooProvider = {
  name: 'yahoo',
  async getLeagueChain(leagueId, currentSeason) {
    return [{ id: leagueId, season: String(currentSeason) }];
  },
  async getDraftPicks() { return []; },
  async getTransactions() { return { trades: [], faab: [] }; },
  async getBracket() { return null; },
  async getLeagueUsers() { return []; },
  async refreshTrades() { return []; },
};

// ══════════════════════════════════════════════════════════════════
// PROVIDER REGISTRY
// ══════════════════════════════════════════════════════════════════

const providers = {
  sleeper: SleeperProvider,
  mfl: MFLProvider,
  espn: ESPNProvider,
  yahoo: YahooProvider,
};

function getProvider(platform) {
  return providers[(platform || 'sleeper').toLowerCase()] || SleeperProvider;
}

window.DhqProviders = { getProvider, SleeperProvider, MFLProvider, ESPNProvider, YahooProvider };

})();

// ── Module global exports (Vite migration) ───────────────────────────────────
window.getProvider = window.DhqProviders.getProvider;
window.SleeperProvider = window.DhqProviders.SleeperProvider;
window.MFLProvider = window.DhqProviders.MFLProvider;
window.ESPNProvider = window.DhqProviders.ESPNProvider;
window.YahooProvider = window.DhqProviders.YahooProvider;
