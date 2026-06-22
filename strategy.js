(function() {
  'use strict';

  const STRATEGY_KEY = 'dhq_gm_strategy_v1';
  const DRIFT_KEY = 'dhq_strategy_drift_v1';

  const DEFAULT_STRATEGY = {
    mode: 'balanced_rebuild',
    timeline: '2-3yr',
    targetPositions: [],
    sellPositions: [],
    sellRules: [],
    untouchables: [],
    // War Room writes the singular `untouchable`; kept here so the field is
    // recognized and reconciled with `untouchables` in normalizeStrategy.
    untouchable: [],
    // War Room free-agency filters — first-classed so they survive normalize
    // and reach Scout instead of being dropped as an opaque pass-through.
    faFilters: null,
    targetList: [],
    blockList: [],
    aggression: 'medium',
    draftStyle: 'bpa',
    marketPosture: 'hold',
    alexPersonality: 'balanced',
    lastSyncedFrom: 'warroom',
    lastSyncedAt: Date.now(),
    version: 1
  };

  function normalizePosition(pos) {
    if (!pos) return '';
    if (window.App?.normPos) return window.App.normPos(pos) || '';
    const raw = String(pos).trim().toUpperCase();
    if (raw === 'DST' || raw === 'D/ST') return 'DEF';
    return raw;
  }

  function normalizePositionList(list) {
    return Array.from(new Set((list || []).map(normalizePosition).filter(Boolean)));
  }

  function normalizeStrategy(strategy) {
    const normalized = { ...DEFAULT_STRATEGY, ...(strategy || {}) };
    normalized.targetPositions = normalizePositionList(normalized.targetPositions);
    normalized.sellPositions = normalizePositionList(normalized.sellPositions);
    normalized.sellRules = (normalized.sellRules || []).map(rule => ({
      ...rule,
      pos: normalizePosition(rule?.pos)
    }));
    // Reconcile the singular `untouchable` (War Room) with the plural
    // `untouchables` (Scout / this module). Keep BOTH in sync so every consumer
    // — gm-engine, player-modal, ai-chat — sees the same protected-player list
    // regardless of which app saved it.
    const untouchSrc = (Array.isArray(normalized.untouchables) && normalized.untouchables.length)
      ? normalized.untouchables
      : (normalized.untouchable || []);
    normalized.untouchables = Array.from(new Set((untouchSrc || []).map(String)));
    normalized.untouchable = normalized.untouchables;
    return normalized;
  }

  function getStrategy() {
    try {
      const raw = localStorage.getItem(STRATEGY_KEY);
      return normalizeStrategy(raw ? JSON.parse(raw) : null);
    } catch(e) { return normalizeStrategy(); }
  }

  function saveStrategy(updates) {
    const current = getStrategy();
    // War Room owns GM Strategy; Scout edits the same shared strategy surface.
    const merged = normalizeStrategy({ ...current, lastSyncedFrom: 'warroom', ...updates, version: (current.version || 0) + 1, lastSyncedAt: Date.now() });
    localStorage.setItem(STRATEGY_KEY, JSON.stringify(merged));
    if (window.DhqEvents) window.DhqEvents.emit('strategy:changed', merged);
    // Fire-and-forget cross-device sync via Supabase. Failures are silent —
    // localStorage is the authoritative path and feels instant.
    if (window.OD?.saveStrategy) {
      try { window.OD.saveStrategy(merged); } catch (e) { /* ignore */ }
    }
    return merged;
  }

  // Pull the latest strategy from Supabase and reconcile with local. Called
  // on DOMContentLoaded and window focus so cross-device edits propagate
  // without requiring a full reload cycle on either app.
  let _syncInFlight = false;
  async function syncFromRemote() {
    if (_syncInFlight) return;
    if (!window.OD?.loadStrategy) return;
    _syncInFlight = true;
    try {
      const remote = await window.OD.loadStrategy();
      const local = getStrategy();
      const localVersion = local.version || 0;
      if (!remote) {
        // No remote row yet — push local up to seed the table (only if local has ever been saved)
        if (localVersion > 0 && window.OD?.saveStrategy) {
          window.OD.saveStrategy(local);
        }
        return;
      }
      const remoteVersion = remote.version || 0;
      if (remoteVersion > localVersion) {
        // Remote wins — adopt it and emit a change event so subscribers refresh
        const adopted = normalizeStrategy({
          ...remote.strategy,
          version: remoteVersion,
          lastSyncedAt: remote.lastSyncedAt,
          lastSyncedFrom: remote.lastSyncedFrom,
        });
        localStorage.setItem(STRATEGY_KEY, JSON.stringify(adopted));
        if (window.DhqEvents) window.DhqEvents.emit('strategy:changed', adopted);
      } else if (localVersion > remoteVersion && window.OD?.saveStrategy) {
        // Local is newer — push it up to catch the server up
        window.OD.saveStrategy(local);
      }
      // Version tie: no-op
    } catch (e) { /* silent — localStorage is authoritative */ }
    finally { _syncInFlight = false; }
  }

  // Check alignment of an action against the strategy
  function checkAlignment(action) {
    // action = { type: 'trade'|'waiver'|'draft', position, playerAge, direction: 'acquire'|'sell' }
    const s = getStrategy();
    const position = normalizePosition(action.position || action.pos || '');
    let score = 0;
    let reasons = [];

    if (action.direction === 'acquire' && s.targetPositions.includes(position)) {
      score += 2; reasons.push('Target position');
    }
    if (action.direction === 'sell' && s.sellPositions.includes(position)) {
      score += 2; reasons.push('Sell position');
    }
    // Check sell rules
    if (action.direction === 'sell') {
      const rule = s.sellRules.find(r => r.pos === position && action.playerAge >= r.ageAbove);
      if (rule) { score += 1; reasons.push('Matches sell rule'); }
    }
    // Check untouchables
    if (action.direction === 'sell' && s.untouchables.includes(action.playerId)) {
      score = -10; reasons = ['Player is untouchable'];
    }
    // Check block list
    if (action.direction === 'acquire' && s.blockList.includes(action.playerId)) {
      score = -10; reasons = ['Player is blocked'];
    }

    if (score >= 2) return { alignment: 'aligned', reasons };
    if (score >= 0) return { alignment: 'partial', reasons: reasons.length ? reasons : ['Neutral to strategy'] };
    return { alignment: 'conflicts', reasons };
  }

  // Track drift
  function recordAction(action) {
    const alignment = checkAlignment(action);
    if (alignment.alignment === 'conflicts') {
      const drift = getDrift();
      drift.conflicts.push({ ...action, timestamp: Date.now(), reasons: alignment.reasons });
      // Keep last 10
      if (drift.conflicts.length > 10) drift.conflicts = drift.conflicts.slice(-10);
      localStorage.setItem(DRIFT_KEY, JSON.stringify(drift));
      if (window.DhqEvents) window.DhqEvents.emit('strategy:drift', drift);
    }
    return alignment;
  }

  function getDrift() {
    try {
      return JSON.parse(localStorage.getItem(DRIFT_KEY) || '{"conflicts":[]}');
    } catch(e) { return { conflicts: [] }; }
  }

  function hasDrift() {
    const drift = getDrift();
    const recent = drift.conflicts.filter(c => Date.now() - c.timestamp < 7 * 24 * 60 * 60 * 1000);
    return recent.length >= 2;
  }

  function clearDrift() {
    localStorage.setItem(DRIFT_KEY, JSON.stringify({ conflicts: [] }));
  }

  window.App = window.App || {};
  window.App.Strategy = { getStrategy, saveStrategy, syncFromRemote, checkAlignment, recordAction, getDrift, hasDrift, clearDrift, DEFAULT_STRATEGY };
  window.GMStrategy = window.App.Strategy;

  // ── Module global exports (Vite migration) ─────────────────────
  window.getStrategy     = getStrategy;
  window.saveStrategy    = saveStrategy;
  window.syncFromRemote  = syncFromRemote;
  window.checkAlignment  = checkAlignment;
  window.recordAction    = recordAction;
  window.getDrift        = getDrift;
  window.hasDrift        = hasDrift;
  window.clearDrift      = clearDrift;

  // ── Cross-device sync hooks ─────────────────────────────────────
  // Wait ~800ms after DOM ready so Supabase client + session token are up.
  function _bootSync() { setTimeout(syncFromRemote, 800); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootSync, { once: true });
  } else {
    _bootSync();
  }

  // Refresh when the window regains focus — throttled to 1/5s so rapid tab
  // switches don't hammer Supabase.
  let _lastFocusSync = 0;
  window.addEventListener('focus', () => {
    const now = Date.now();
    if (now - _lastFocusSync < 5000) return;
    _lastFocusSync = now;
    syncFromRemote();
  });
})();
