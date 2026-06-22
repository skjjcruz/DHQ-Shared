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
      _log('storage.get', e, { key });
      return fallback;
    }
  },

  // Get a raw string value (no JSON parsing). Returns fallback if missing.
  getStr(key, fallback = '') {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch (e) {
      _log('storage.getStr', e, { key });
      return fallback;
    }
  },

  // Set a JSON-serialized value. Returns true on success, false on quota error.
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      _log('storage.set', e, { key });
      return false;
    }
  },

  // Set a raw string value. Returns true on success.
  setStr(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      _log('storage.setStr', e, { key });
      return false;
    }
  },

  // Remove a key from localStorage.
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      _log('storage.remove', e, { key });
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
