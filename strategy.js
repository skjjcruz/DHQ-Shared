(function() {
  'use strict';

  const STRATEGY_KEY = 'dhq_gm_strategy_v1';
  const DRIFT_KEY = 'dhq_strategy_drift_v1';

  const DEFAULT_STRATEGY = {
    mode: 'balanced_rebuild',
    timeline: '2_3_years',
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
    // LEGACY — parsed but unused (2026-07-08 single-voice ruling). Alex has
    // one canonical voice; alexPersonality is no longer a voice knob anywhere.
    // The field stays in the schema because it is server-synced and old
    // profiles carry it forever: normalizeStrategy keeps accepting and
    // round-tripping stored values ('aggressive' | 'value_hunter' |
    // 'balanced') so no reader ever crashes, and saveStrategy keeps writing
    // the merged value for server-schema compatibility. Do not repurpose.
    alexPersonality: 'balanced',
    lastSyncedFrom: 'warroom',
    lastSyncedAt: Date.now(),
    version: 1
  };

  function normalizePosition(pos) {
    if (!pos) return '';
    // Draft picks are a first-class "position" in GM Strategy (target/sell PICKS).
    // Special-case BEFORE App.normPos so it survives normalization in both apps.
    if (String(pos).trim().toUpperCase() === 'PICKS') return 'PICKS';
    if (window.App?.normPos) return window.App.normPos(pos) || '';
    const raw = String(pos).trim().toUpperCase();
    if (raw === 'DST' || raw === 'D/ST') return 'DEF';
    return raw;
  }

  function normalizePositionList(list) {
    return Array.from(new Set((list || []).map(normalizePosition).filter(Boolean)));
  }

  // Timeline is canonically '1_year' | '2_3_years' | 'dynasty_long' (War Room
  // vocabulary). Scout's old editor wrote '1yr'/'2-3yr', which silently missed
  // every canonical branch (gm-mode effects, window-forecast horizon, rookie
  // draft order). Normalize legacy values so both apps + every consumer converge.
  const TIMELINE_MAP = {
    '1yr': '1_year', '1year': '1_year', '1_year': '1_year',
    '2yr': '2_3_years', '2year': '2_3_years', '2-3yr': '2_3_years',
    '2_3yr': '2_3_years', '2-3years': '2_3_years', '2_3_years': '2_3_years',
    'dynasty': 'dynasty_long', 'dynasty_long': 'dynasty_long',
  };
  function normalizeTimeline(tl) {
    if (!tl) return tl;
    return TIMELINE_MAP[String(tl).trim().toLowerCase()] || tl;
  }

  // Sell rules may be free-text strings (War Room / Scout editor) OR structured
  // objects {pos, ageAbove}. Parse either into a canonical {pos, ageAbove} for
  // checkAlignment matching WITHOUT mutating the stored value.
  function parseSellRule(rule) {
    if (rule && typeof rule === 'object') {
      return { pos: normalizePosition(rule.pos), ageAbove: Number(rule.ageAbove) || 0 };
    }
    const text = String(rule || '');
    // Optional trailing 's' matches plural forms ("Sell aging RBs"); age accepts
    // 1–2 digits. Group captures the singular position; normalizePosition canonicalizes.
    const posMatch = text.match(/\b(QB|RB|WR|TE|K|DEF|D\/ST|DST|DL|LB|DB|EDGE|IDP)s?\b/i);
    const ageMatch = text.match(/age\s*(\d{1,2})/i) || text.match(/\b(\d{1,2})\s*\+/);
    return {
      pos: posMatch ? normalizePosition(posMatch[1]) : '',
      ageAbove: ageMatch ? Number(ageMatch[1]) : 0,
    };
  }

  function normalizeStrategy(strategy) {
    const normalized = { ...DEFAULT_STRATEGY, ...(strategy || {}) };
    normalized.timeline = normalizeTimeline(normalized.timeline);
    normalized.targetPositions = normalizePositionList(normalized.targetPositions);
    normalized.sellPositions = normalizePositionList(normalized.sellPositions);
    // Preserve the rule's original shape — a free-text string stays a string
    // (spreading it would corrupt it into a char-indexed object); only structured
    // {pos,...} objects get their position normalized. checkAlignment parses both.
    normalized.sellRules = (normalized.sellRules || []).map(rule => {
      if (typeof rule === 'string') return rule;
      if (rule && typeof rule === 'object') return { ...rule, pos: normalizePosition(rule.pos) };
      return rule;
    }).filter(r => r != null);
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
    // Check sell rules — parse each (string or object) to a canonical {pos,ageAbove}
    if (action.direction === 'sell') {
      const rule = (s.sellRules || []).map(parseSellRule).find(r =>
        r.pos && r.pos === position && (!r.ageAbove || Number(action.playerAge) >= r.ageAbove)
      );
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
  window.App.Strategy = { getStrategy, saveStrategy, syncFromRemote, checkAlignment, recordAction, getDrift, hasDrift, clearDrift, parseSellRule, DEFAULT_STRATEGY };
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
