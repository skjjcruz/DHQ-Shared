// ══════════════════════════════════════════════════════════════════
// shared/storage.js — localStorage key registry and typed wrapper
// Requires: shared/utils.js (dhqLog) loaded first.
// ══════════════════════════════════════════════════════════════════

window.App = window.App || {};

// ── dhqLog — structured error logging ────────────────────────────
// Defined here (storage.js loads fresh as a new file) so it's guaranteed
// available to all subsequent scripts regardless of HTTP cache state.
// Also defined in shared/utils.js — whichever runs first wins.
if (typeof window.dhqLog !== 'function') {
  window.dhqLog = function dhqLog(context, err, extra) {
    const tag = `[DHQ:${context}]`;
    if (err instanceof Error) {
      console.warn(tag, err.message, extra !== undefined ? extra : '');
    } else {
      console.warn(tag, err !== undefined ? err : '', extra !== undefined ? extra : '');
    }
  };
  window.App.dhqLog = window.dhqLog;
}

// Internal alias — uses the now-guaranteed global.
const _log = (ctx, e, x) => window.dhqLog(ctx, e, x);

// ── STORAGE_KEYS — canonical registry of all localStorage keys ───
// Static keys: plain strings. Dynamic keys: functions returning strings.
// Owners listed in comments — only that module should write the key.
const STORAGE_KEYS = {
  // ── Auth / Identity (owner: app.js) ─────────────────────────
  USERNAME:        'dynastyhq_username',    // Sleeper username for auto-connect
  LEAGUE:          'dynastyhq_league',      // Last active league ID
  API_KEY:         'dynastyhq_apikey',      // OpenAI / Anthropic API key
  API_PROVIDER:    'dynastyhq_provider',    // AI provider name ('anthropic', 'openai', etc.)
  API_MODEL:       'dynastyhq_model',       // AI model override string
  XAI_KEY:         'dynastyhq_xai_key',    // xAI API key
  // ── Session (owner: supabase-client.js) ──────────────────────
  FW_SESSION:      'fw_session_v1',         // Dynasty HQ email session JWT
  OD_PROFILE:      'od_profile_v1',         // Owner Dashboard onboarding profile
  OD_AUTH:         'od_auth_v1',            // OD legacy auth state
  // ── League Intel (owner: dhq-engine.js) ──────────────────────
  HIST_PREFIX:     'dhq_hist_',             // Prefix used for bulk-clear
  HIST_KEY:        lid => `dhq_hist_${lid}`, // Per-league trade/draft history cache
  OWNER_DNA:       lid => `od_owner_dna_v1_${lid}`, // Owner DNA map from War Room
  // ── Strategy walkthrough (owner: ui.js) ──────────────────────
  STRATEGY:        'dhq_strategy',          // AI-generated strategy blob (JSON)
  STRATEGY_DONE:   'dhq_strategy_done',     // '1' once walkthrough complete
  // ── Roster health timeline (owner: ui.js) ────────────────────
  HEALTH_TIMELINE: lid => `dhq_health_timeline_${lid}`,
  // ── Notifications (owner: app.js) ────────────────────────────
  NOTIF_PERM:      'dhq_notif_perm',        // Notification permission state string
  LAST_ALERTS:     'dhq_last_alerts',       // { [alertKey]: 1 } last-seen map
  // ── Conversation memory (owner: app.js) ──────────────────────
  MEMORY:          'dynastyhq_memory',      // AI memory blob (JSON)
  // ── Conversation sessions (owner: ai-chat.js) ───────────────
  CONV_SESSIONS:   'dhq_sessions',               // Cross-league conversation memory summaries
  // ── Tier / Trial (owner: tier.js) ────────────────────────────
  TIER:            'dhq_user_tier_v1',                    // Cached tier string ('free', 'scout', 'warroom', …)
  TRIAL_START:             'dhq_trial_start',                     // Trial start timestamp (ms)
  TRIAL_BANNER_DISMISSED:  'dhq_trial_banner_dismissed',           // YYYY-MM-DD last dismissed
  TRIAL_EXPIRED_SEEN:      'dhq_trial_expired_seen',               // '1' once expiration modal shown
  TRIAL_USAGE:             'dhq_trial_usage',                      // JSON { counter: count } usage map
  CHAT_DAILY:              date => `dhq_chat_daily_${date}`,       // Daily chat message count key by YYYY-MM-DD
  FEATURE_USAGE:           feat => `dhq_feat_usage_${feat}`,       // Per-feature trial usage count
};

// ── Storage janitor (owner ruling 2026-08-27) ────────────────────
// A device whose localStorage fills up fails EVERY later save (14
// QuotaExceededError rows from one device that morning). The heavyweight
// is dhq_hist_<lid> — a league's full multi-season history, several
// hundred KB per league and fully rebuildable from Sleeper. On a quota
// error, evict only the rebuildable caches below, then retry the write
// once. Never touches auth, prefs, boards, strategies, or custom events.
const PURGEABLE_CACHE_PREFIXES = [
  'dhq_hist_',           // per-league history cache (the whale; refetched on demand)
  'wr_compare_h2h_v3_',  // compare tab H2H meetings cache
  'wr_adp_market_v2_',   // ADP market cache (18h TTL)
  'fw_stats_',           // legacy season-stats blobs (superseded by IndexedDB)
  'dhq_nfl_roles_',      // ESPN depth-chart snapshot (refetched every app open)
];
// Orphaned draft recaps (2026-08-28 deep dive): every saved recap also wrote a
// wr_draft_recap_<timestamp> copy that NOTHING reads — the real record lives in
// wr_draft_recap_archive_<lid> (capped at 25, read by post-draft). The writer
// is fixed, but devices carry years of these; the digit-only suffix keeps the
// archive keys untouchable by construction.
const PURGEABLE_KEY_PATTERNS = [
  /^wr_draft_recap_\d+$/,
];
let _janitorLastRun = 0;
function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014
    || /quota/i.test(String(e.message || '')));
}
function storageJanitor(trigger) {
  const now = Date.now();
  if (now - _janitorLastRun < 60000) return 0; // never thrash
  _janitorLastRun = now;
  let removed = 0, freedChars = 0;
  try {
    Object.keys(localStorage).forEach(k => {
      if (PURGEABLE_CACHE_PREFIXES.some(p => k.indexOf(p) === 0) || PURGEABLE_KEY_PATTERNS.some(rx => rx.test(k))) {
        try {
          freedChars += (localStorage.getItem(k) || '').length;
          localStorage.removeItem(k);
          removed++;
        } catch (e) { /* keep sweeping */ }
      }
    });
  } catch (e) { /* storage unreadable — nothing to free */ }
  // The sweep report is GOOD news — routing it through dhqLog filed it in
  // the admin error table as "Error: cleaned 3 items…" and inflated the
  // client-error count (owner ruling 2026-09-01). Console + Sentry info
  // only now; a retry that still fails logs its own storage.set error row.
  const sweepReport = 'cleaned ' + removed + ' items, freed ~' + Math.round(freedChars / 1024) + 'KB (' + (trigger || 'quota') + ')';
  try { console.info('[DHQ:storage.janitor]', sweepReport); } catch (e) { /* console gone — nothing to do */ }
  window.DHQBugCapture?.captureMessage?.(sweepReport, 'info', { source: 'storage.janitor' });
  return removed;
}
window.DhqStorageJanitor = { run: storageJanitor, isQuotaError };

// ── DhqStorage — typed wrapper with error handling ───────────────
// Centralizes JSON parsing, quota-exceeded handling, and error logging.
// All methods are synchronous and safe to call in any context.
const DhqStorage = {
  // Get a JSON-parsed value. Returns fallback on missing key or parse error.
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      _log('storage.get:' + key, e);
      return fallback;
    }
  },

  // Get a raw string value (no JSON parsing). Returns fallback if missing.
  getStr(key, fallback = '') {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch (e) {
      _log('storage.getStr:' + key, e);
      return fallback;
    }
  },

  // Set a JSON-serialized value. Returns true on success, false on quota error.
  // A quota failure runs the janitor and retries once before giving up.
  set(key, value) {
    const payload = JSON.stringify(value);
    try {
      localStorage.setItem(key, payload);
      return true;
    } catch (e) {
      if (isQuotaError(e) && storageJanitor('quota:set')) {
        try { localStorage.setItem(key, payload); return true; } catch (e2) { _log('storage.set:' + key, e2); return false; }
      }
      _log('storage.set:' + key, e);
      return false;
    }
  },

  // Set a raw string value. Returns true on success.
  setStr(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      if (isQuotaError(e) && storageJanitor('quota:setStr')) {
        try { localStorage.setItem(key, value); return true; } catch (e2) { _log('storage.setStr:' + key, e2); return false; }
      }
      _log('storage.setStr:' + key, e);
      return false;
    }
  },

  // Remove a key from localStorage.
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      _log('storage.remove:' + key, e);
    }
  },

  // Remove all keys matching a prefix (e.g. STORAGE_KEYS.HIST_PREFIX).
  removeByPrefix(prefix) {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith(prefix))
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {
      _log('storage.removeByPrefix', e, { prefix });
    }
  },

  // Get a JSON value with TTL check. Stored format: { _ts, _data }.
  // Returns fallback if the entry is missing, malformed, or expired.
  getTtl(key, maxAgeMs, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed._ts) return parsed ?? fallback;
      if (Date.now() - parsed._ts > maxAgeMs) {
        localStorage.removeItem(key);
        return fallback;
      }
      return parsed._data ?? fallback;
    } catch (e) {
      _log('storage.getTtl', e, { key });
      return fallback;
    }
  },

  // Set a value with TTL metadata. Retrieve with getTtl().
  setTtl(key, value) {
    return DhqStorage.set(key, { _ts: Date.now(), _data: value });
  },
};

window.App.STORAGE_KEYS = STORAGE_KEYS;
window.App.DhqStorage   = DhqStorage;
window.STORAGE_KEYS     = STORAGE_KEYS;
window.DhqStorage       = DhqStorage;
