// ══════════════════════════════════════════════════════════════════
// shared/tier.js — Feature flag system for War Room Scout
// Controls free vs paid access with trial tracking.
//
// Provides: FEATURES, getTier(), canAccess(feature), isTrialActive(),
//   getRemainingTrialDays(), showUpgradePrompt(), daily chat limit helpers.
// Requires: shared/storage.js loaded first.
// ══════════════════════════════════════════════════════════════════

window.App = window.App || {};

// ── Sandbox detection ────────────────────────────────────────────
// The ReconAI sandbox-dev deploy (skjjcruz.github.io/ReconAI-sandbox-dev/)
// runs with all features unlocked so the team can exercise paid functionality
// without a subscription. Gated on host+path of the sandbox Pages site, or an
// explicit build flag — intentionally NOT a query param, so it cannot bypass
// the paywall on the public production sites. The path gate makes it a no-op
// on the production domain (warroom.skjjcruz.com), which has no such path.
function isSandbox() {
  try {
    if (window.SANDBOX_MODE === true) return true;
    const loc = window.location || {};
    const host = loc.hostname || '';
    const path = loc.pathname || '';
    return /(^|\.)github\.io$/i.test(host) && /\/reconai-sandbox-dev(\/|$)/i.test(path);
  } catch (_) {
    return false;
  }
}

// ── Feature enum ─────────────────────────────────────────────────
const FEATURES = {
  OWNER_DNA:          'owner_dna',          // Owner DNA profiles in trade calc
  TRADE_SCENARIOS:    'trade_scenarios',    // Trade scenario builder (Builder view)
  BEHAVIORAL_MODEL:   'behavioral_model',   // Deep behavioral intelligence (paid only)
  DRAFT_ARCHETYPES:   'draft_archetypes',   // Draft archetype / needs analysis
  FAAB_INTELLIGENCE:  'faab_intelligence',  // FAAB budget recommendations
  BRIEFING_REASONING: 'briefing_reasoning', // Scout briefing "why" explanations
  FIELD_LOG_SYNC:     'field_log_sync',     // Field log → War Room sync (paid only)
  UNLIMITED_CHAT:     'unlimited_chat',     // Unlimited AI chat (free = 3/day)
  WAR_ROOM_CORE:      'war_room_core',      // Full War Room access (paid only)
  DYNASTY_READ_AI:    'dynasty_read_ai',    // Web-search news synthesis on player cards (paid only)

  // Legacy string keys used by pre-existing code — preserved for compat
  AI_UNLIMITED:       'ai-unlimited',       // ai-dispatch.js
  TRADE_CALC:         'trade-calc',         // trade-calc.js
  NOTIFICATIONS:      'notifications',      // app.js
};

// Features unlocked for trial users (and all paid tiers)
const _TRIAL_FEATURES = new Set([
  FEATURES.OWNER_DNA,
  FEATURES.TRADE_SCENARIOS,
  FEATURES.DRAFT_ARCHETYPES,
  FEATURES.FAAB_INTELLIGENCE,
  FEATURES.BRIEFING_REASONING,
  FEATURES.UNLIMITED_CHAT,
  FEATURES.AI_UNLIMITED,
  FEATURES.TRADE_CALC,
  FEATURES.NOTIFICATIONS,
]);

// Features that require a paid subscription (not available during trial)
const _PAID_ONLY_FEATURES = new Set([
  FEATURES.BEHAVIORAL_MODEL,
  FEATURES.FIELD_LOG_SYNC,
  FEATURES.WAR_ROOM_CORE,
  FEATURES.DYNASTY_READ_AI,
]);

const TRIAL_DAYS           = 30;
const FREE_CHAT_DAILY_LIMIT = 3;

// ── Trial initialization ─────────────────────────────────────────
// Called on app boot — stamps trial start date if not already set.
function initTrial() {
  const existing = DhqStorage.getStr(STORAGE_KEYS.TRIAL_START, '');
  if (!existing) {
    DhqStorage.setStr(STORAGE_KEYS.TRIAL_START, String(Date.now()));
  }
}

// ── Tier detection ────────────────────────────────────────────────
// Returns 'free' | 'trial' | 'paid'
// DEV_MODE bypass, server-loaded in-memory cache, trial check.
// Local storage profile/session values are intentionally not trusted for paid
// access because users can edit them in the browser.
function getTier() {
  if (isSandbox()) return 'paid';
  if (window.DEV_MODE || ['localhost', '127.0.0.1'].includes(window.location?.hostname)) return 'paid';
  if (window.App._userTier) return window.App._userTier;

  // Trial window
  if (isTrialActive()) return 'trial';
  return 'free';
}

function isTrialActive() {
  const startStr = DhqStorage.getStr(STORAGE_KEYS.TRIAL_START, '');
  if (!startStr) return false;
  const start = parseInt(startStr, 10);
  if (isNaN(start)) return false;
  return (Date.now() - start) < TRIAL_DAYS * 24 * 60 * 60 * 1000;
}

function getRemainingTrialDays() {
  const startStr = DhqStorage.getStr(STORAGE_KEYS.TRIAL_START, '');
  if (!startStr) return 0;
  const start = parseInt(startStr, 10);
  if (isNaN(start)) return 0;
  const elapsed = Date.now() - start;
  return Math.max(0, TRIAL_DAYS - Math.floor(elapsed / (24 * 60 * 60 * 1000)));
}

// ── Feature access ────────────────────────────────────────────────
function canAccess(feature) {
  const tier = getTier();
  if (tier === 'paid') return true;
  if (_PAID_ONLY_FEATURES.has(feature)) return false;
  if (tier === 'trial' && _TRIAL_FEATURES.has(feature)) return true;
  return false;
}

// ── loadUserTier (async, called once at boot) ─────────────────────
// Fetches tier from Supabase via OD.loadProfile, caches for fast sync lookups.
async function loadUserTier() {
  try {
    if (window.OD?.loadProfile) {
      const profile = await window.OD.loadProfile();
      if (profile?.tier) {
        const tier = ['scout', 'recon_ai', 'dynast_hq', 'war_room', 'warroom', 'pro', 'commissioner'].includes(profile.tier)
          ? 'paid' : 'free';
        window.App._userTier = tier;
        window.App._productTier = normalizeProductTier(profile);
      }
    }
  } catch (e) {
    console.warn('[Tier] Failed to load user tier:', e);
  }
}

function normalizeProductTier(profile) {
  const rawTier = String(profile?.tier || '').toLowerCase();
  const products = Array.isArray(profile?.products) ? profile.products.map(String) : [];
  if (rawTier === 'commissioner') return 'commissioner';
  if (products.includes('bundle') || (products.includes('war_room') && products.includes('dynast_hq'))) return 'pro';
  if (rawTier === 'warroom' || rawTier === 'war_room' || products.includes('war_room')) return 'warroom';
  if (rawTier === 'scout' || rawTier === 'recon_ai' || rawTier === 'dynast_hq' || products.includes('dynast_hq')) return 'scout';
  if (rawTier === 'pro' || rawTier === 'power' || rawTier === 'bundle') return 'pro';
  return 'free';
}

// ── Feature usage tracking ────────────────────────────────────────
// Persists how many times a user accessed a gated feature, so upgrade prompts
// can say "You used this X times during your trial."
function trackFeatureUsage(feature) {
  const key = STORAGE_KEYS.FEATURE_USAGE(feature);
  DhqStorage.set(key, (DhqStorage.get(key, 0) || 0) + 1);
}

function getFeatureUsage(feature) {
  return DhqStorage.get(STORAGE_KEYS.FEATURE_USAGE(feature), 0) || 0;
}

// ── Daily chat limit ──────────────────────────────────────────────
function _todayDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getDailyChatCount() {
  return DhqStorage.get(STORAGE_KEYS.CHAT_DAILY(_todayDateKey()), 0) || 0;
}

function incrementDailyChat() {
  const key = STORAGE_KEYS.CHAT_DAILY(_todayDateKey());
  const next = getDailyChatCount() + 1;
  DhqStorage.set(key, next);
  return next;
}

function getDailyChatRemaining() {
  return Math.max(0, FREE_CHAT_DAILY_LIMIT - getDailyChatCount());
}

// ── Upgrade prompt ────────────────────────────────────────────────
const _FEATURE_LABELS = {
  [FEATURES.OWNER_DNA]:          'Owner DNA Profiles',
  [FEATURES.TRADE_SCENARIOS]:    'Trade Scenario Builder',
  [FEATURES.BEHAVIORAL_MODEL]:   'Behavioral Intelligence',
  [FEATURES.DRAFT_ARCHETYPES]:   'Draft Archetype Analysis',
  [FEATURES.FAAB_INTELLIGENCE]:  'FAAB Intelligence',
  [FEATURES.BRIEFING_REASONING]: 'Briefing Reasoning',
  [FEATURES.FIELD_LOG_SYNC]:     'Field Log Sync',
  [FEATURES.UNLIMITED_CHAT]:     'Unlimited AI Chat',
  [FEATURES.WAR_ROOM_CORE]:      'War Room',
  [FEATURES.AI_UNLIMITED]:       'Unlimited AI Chat',
  [FEATURES.TRADE_CALC]:         'Trade Calculator',
  [FEATURES.NOTIFICATIONS]:      'Notifications',
};

const _FEATURE_DESCS = {
  [FEATURES.OWNER_DNA]:          'Understand how every owner in your league trades — their DNA, trade posture, and psychological profile.',
  [FEATURES.TRADE_SCENARIOS]:    'Build and simulate trades with full value breakdowns before sending that Sleeper message.',
  [FEATURES.BEHAVIORAL_MODEL]:   'Deep behavioral modeling tells you exactly how an owner will respond to your offer, down to % acceptance likelihood.',
  [FEATURES.DRAFT_ARCHETYPES]:   'Get a personalized draft strategy based on your roster needs, pick position, and league tendencies.',
  [FEATURES.FAAB_INTELLIGENCE]:  'Intelligent FAAB recommendations calibrated to your roster gaps, budget, and competition.',
  [FEATURES.BRIEFING_REASONING]: 'Understand the "why" behind every briefing item — not just what to watch, but the reasoning that drives it.',
  [FEATURES.FIELD_LOG_SYNC]:     'Sync your Field Log decisions to War Room for cross-platform dynasty intelligence.',
  [FEATURES.UNLIMITED_CHAT]:     'Remove the daily message cap and talk to your AI dynasty advisor as much as you need.',
  [FEATURES.WAR_ROOM_CORE]:      'Access the full War Room desktop experience with advanced multi-league analytics.',
  [FEATURES.AI_UNLIMITED]:       'Remove the daily message cap and talk to your AI dynasty advisor as much as you need.',
  [FEATURES.TRADE_CALC]:         'Access the full Trade Calculator — build scenarios, analyze partners, and run DNA profiles.',
};

// showUpgradePrompt(feature, containerEl)
// containerEl is optional legacy arg from pre-existing call sites.
function showUpgradePrompt(feature, containerEl) {
  // Track attempted access (for "used X times during trial" messaging)
  if (typeof STORAGE_KEYS !== 'undefined' && STORAGE_KEYS.FEATURE_USAGE) {
    trackFeatureUsage(feature);
  }

  _ensureUpgradeModalDOM();

  const label     = _FEATURE_LABELS[feature]  || 'This Feature';
  const desc      = _FEATURE_DESCS[feature]   || 'Upgrade to unlock premium features.';
  const usage     = getFeatureUsage(feature);
  const tier      = getTier();
  const trialDays = getRemainingTrialDays();

  let contextNote = '';
  if (tier === 'free' && usage > 1) {
    contextNote = `<div style="font-size:13px;color:var(--text3);margin-bottom:16px;line-height:1.5">
      You used this <strong style="color:var(--accent)">${usage} time${usage !== 1 ? 's' : ''}</strong> during your trial.
    </div>`;
  } else if (tier === 'trial') {
    contextNote = `<div style="font-size:13px;color:#F0A500;margin-bottom:16px">
      ${trialDays} day${trialDays !== 1 ? 's' : ''} left in your free trial.
    </div>`;
  }

  const body  = document.getElementById('dhq-upgrade-body');
  const modal = document.getElementById('dhq-upgrade-modal');
  if (!body || !modal) return;

  body.innerHTML = `
    <div style="text-align:center;margin-bottom:20px">
      <div style="font-size:28px;margin-bottom:10px">🔒</div>
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;color:var(--text)">${label}</div>
      <div style="font-size:14px;color:var(--text3);line-height:1.6;margin-bottom:16px">${desc}</div>
      ${contextNote}
    </div>
    <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:16px;margin-bottom:20px">
      <div style="font-size:13px;font-weight:700;color:var(--accent);margin-bottom:8px">War Room — $9.99/mo</div>
      <div style="font-size:13px;color:var(--text3);line-height:1.7">
        Unlimited AI chat &middot; All leagues &middot; Owner DNA<br>
        GM Insights sync &middot; Full draft intelligence
      </div>
    </div>
    <button
      onclick="document.getElementById('dhq-upgrade-modal').style.display='none';if(window.showProLaunchPage)showProLaunchPage();"
      style="width:100%;padding:14px;background:linear-gradient(135deg,#d4af37,#b8941f);color:#1a1000;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:10px;box-shadow:0 4px 16px rgba(212,175,55,.25)">
      Upgrade to War Room — $9.99/mo
    </button>
    <button
      onclick="document.getElementById('dhq-upgrade-modal').style.display='none'"
      style="width:100%;padding:12px;background:none;color:var(--text3);border:none;font-size:14px;cursor:pointer">
      Not now
    </button>
  `;

  modal.style.display = 'flex';
}

function _ensureUpgradeModalDOM() {
  if (document.getElementById('dhq-upgrade-modal')) return;
  const el = document.createElement('div');
  el.id = 'dhq-upgrade-modal';
  el.style.cssText = [
    'display:none',
    'position:fixed',
    'inset:0',
    'z-index:10000',
    'background:rgba(0,0,0,.8)',
    '-webkit-backdrop-filter:blur(8px)',
    'backdrop-filter:blur(8px)',
    'align-items:flex-end',
    'justify-content:center',
  ].join(';');
  el.setAttribute('onclick', "if(event.target===this)this.style.display='none'");
  el.innerHTML = `
    <div style="background:var(--bg2);border-radius:20px 20px 0 0;padding:24px 20px 36px;max-width:480px;width:100%;max-height:90vh;overflow-y:auto;border-top:1px solid var(--border2)">
      <div id="dhq-upgrade-body"></div>
    </div>
  `;
  document.body.appendChild(el);
}

// ── Trial usage counters ──────────────────────────────────────────
// Lightweight named counters stored in TRIAL_USAGE JSON blob.
// Counter names: trade_scenarios_explored, briefings_received,
//   draft_targets_flagged, owner_dna_views, ai_chats_sent, waiver_bids_placed

function trackUsage(counter) {
  if (!counter) return;
  try {
    const usage = DhqStorage.get(STORAGE_KEYS.TRIAL_USAGE, {});
    usage[counter] = (usage[counter] || 0) + 1;
    DhqStorage.set(STORAGE_KEYS.TRIAL_USAGE, usage);
  } catch(e) {}
}

function getTrialUsage() {
  return DhqStorage.get(STORAGE_KEYS.TRIAL_USAGE, {});
}

// ── isTrialExpired ────────────────────────────────────────────────
function isTrialExpired() {
  if (window.DEV_MODE) return false;
  const startStr = DhqStorage.getStr(STORAGE_KEYS.TRIAL_START, '');
  if (!startStr) return false; // never started → not expired
  return !isTrialActive();
}

// ── Trial banner ──────────────────────────────────────────────────
// Shown below the team-bar during the trial period. Dismissible per day.

function _shouldShowBanner() {
  if (!isTrialActive()) return false;
  const dismissed = DhqStorage.getStr(STORAGE_KEYS.TRIAL_BANNER_DISMISSED, '');
  if (!dismissed) return true;
  return dismissed !== new Date().toISOString().slice(0, 10);
}

function dismissTrialBanner() {
  DhqStorage.setStr(STORAGE_KEYS.TRIAL_BANNER_DISMISSED, new Date().toISOString().slice(0, 10));
  const banner = document.getElementById('trial-banner');
  if (!banner) return;
  banner.style.transition = 'opacity .2s, transform .2s';
  banner.style.opacity = '0';
  banner.style.transform = 'translateY(-4px)';
  setTimeout(() => { banner.style.display = 'none'; }, 200);
}

function renderTrialBanner() {
  const banner = document.getElementById('trial-banner');
  if (!banner) return;
  if (!_shouldShowBanner()) { banner.style.display = 'none'; return; }
  const days = getRemainingTrialDays();
  const daysEl = document.getElementById('trial-banner-days');
  if (daysEl) daysEl.textContent = days === 1 ? '1 day' : `${days} days`;
  const textEl = document.getElementById('trial-banner-text');
  if (textEl) {
    textEl.style.color = days <= 3 ? 'var(--red)' : days <= 7 ? 'var(--amber)' : 'var(--text2)';
  }
  banner.style.display = 'flex';
}

// ── Trial expiration modal ────────────────────────────────────────
// Shown once on the next app load after trial ends. Summarises trial activity.

// Grace period: if trial expires during a session, let the user finish.
// Show the modal on the next page load instead.
const _trialSessionStart = Date.now();

function _isTrialGracePeriod() {
  const startStr = DhqStorage.getStr(STORAGE_KEYS.TRIAL_START, '');
  if (!startStr) return false;
  const start = parseInt(startStr, 10);
  if (isNaN(start)) return false;
  const trialEndMs = start + TRIAL_DAYS * 24 * 60 * 60 * 1000;
  return trialEndMs > _trialSessionStart && trialEndMs <= Date.now();
}

function _shouldShowExpirationModal() {
  if (!isTrialExpired()) return false;
  if (_isTrialGracePeriod()) return false;
  return !DhqStorage.getStr(STORAGE_KEYS.TRIAL_EXPIRED_SEEN, '');
}

function closeTrialExpiredModal() {
  const modal = document.getElementById('trial-expired-modal');
  if (modal) modal.style.display = 'none';
}

function renderExpirationModal() {
  const modal = document.getElementById('trial-expired-modal');
  if (!modal) return;
  const usage = getTrialUsage();
  const stats = [
    usage.trade_scenarios_explored && `${usage.trade_scenarios_explored} trade scenario${usage.trade_scenarios_explored !== 1 ? 's' : ''} explored`,
    usage.briefings_received        && `${usage.briefings_received} briefing${usage.briefings_received !== 1 ? 's' : ''} received`,
    usage.draft_targets_flagged     && `${usage.draft_targets_flagged} draft target${usage.draft_targets_flagged !== 1 ? 's' : ''} flagged`,
    usage.ai_chats_sent             && `${usage.ai_chats_sent} Scout message${usage.ai_chats_sent !== 1 ? 's' : ''} sent`,
    usage.owner_dna_views           && `${usage.owner_dna_views} owner profile${usage.owner_dna_views !== 1 ? 's' : ''} viewed`,
    usage.waiver_bids_placed        && `${usage.waiver_bids_placed} waiver bid${usage.waiver_bids_placed !== 1 ? 's' : ''} placed`,
  ].filter(Boolean);
  const statsEl = document.getElementById('trial-expired-stats');
  if (statsEl) {
    statsEl.innerHTML = stats.length > 0
      ? stats.map(s => `<div class="trial-expired-stat">${s}</div>`).join('')
      : '<div style="color:var(--text3);font-size:13px;padding:4px 0">No activity recorded during trial</div>';
  }
  modal.style.display = 'flex';
}

// ── Trial settings section ────────────────────────────────────────
// Renders trial status info in the Settings panel Account section.

function updateTrialSettingsSection() {
  const el = document.getElementById('trial-settings-info');
  if (!el) return;
  const startStr = DhqStorage.getStr(STORAGE_KEYS.TRIAL_START, '');
  const start    = startStr ? new Date(parseInt(startStr, 10)) : null;
  const days     = getRemainingTrialDays();
  const expired  = isTrialExpired();
  // Update the summary badge
  const badge = document.getElementById('trial-settings-badge');
  if (badge) {
    if (expired) {
      badge.textContent = 'Ended';
      badge.style.color = 'var(--red)';
    } else {
      badge.textContent = `${days}d left`;
      badge.style.color = days <= 3 ? 'var(--red)' : days <= 7 ? 'var(--amber)' : 'var(--accent)';
    }
  }
  const startFmt = start
    ? start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  if (expired) {
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--redL);border:1px solid rgba(248,113,113,.2);border-radius:var(--r);margin-bottom:10px">
        <span style="font-size:20px;flex-shrink:0">⏱</span>
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--red)">Trial ended</div>
          <div style="font-size:12px;color:var(--text3);margin-top:1px">Started ${startFmt}</div>
        </div>
      </div>
      <div style="font-size:13px;color:var(--text3);line-height:1.5;margin-bottom:10px">Upgrade to restore AI analysis, Owner DNA, draft intelligence, and daily briefings.</div>
      <div style="display:flex;flex-direction:column;gap:4px">
        <div style="font-size:13px;color:var(--text2);display:flex;align-items:center;gap:6px"><span style="color:var(--red);font-size:11px">✕</span> AI trade analysis &amp; Scout chat</div>
        <div style="font-size:13px;color:var(--text2);display:flex;align-items:center;gap:6px"><span style="color:var(--red);font-size:11px">✕</span> Owner DNA profiles</div>
        <div style="font-size:13px;color:var(--text2);display:flex;align-items:center;gap:6px"><span style="color:var(--red);font-size:11px">✕</span> Draft room intelligence</div>
        <div style="font-size:13px;color:var(--text2);display:flex;align-items:center;gap:6px"><span style="color:var(--red);font-size:11px">✕</span> Daily briefings</div>
      </div>`;
  } else {
    const pct      = Math.round(((TRIAL_DAYS - days) / TRIAL_DAYS) * 100);
    const barColor = days <= 3 ? 'var(--red)' : days <= 7 ? 'var(--amber)' : 'var(--accent)';
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-size:13px;color:var(--text2)">Trial period</div>
        <div style="font-size:13px;font-weight:700;color:${barColor}">${days === 1 ? '1 day' : `${days} days`} left</div>
      </div>
      <div style="height:4px;background:var(--bg4);border-radius:2px;overflow:hidden;margin-bottom:8px">
        <div style="height:100%;background:${barColor};border-radius:2px;width:${pct}%"></div>
      </div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:10px">Started ${startFmt} · ${TRIAL_DAYS}-day full access trial</div>
      <div style="display:flex;flex-direction:column;gap:4px">
        <div style="font-size:13px;color:var(--text2);display:flex;align-items:center;gap:6px"><span style="color:var(--green);font-size:11px">✓</span> AI trade analysis &amp; Scout chat</div>
        <div style="font-size:13px;color:var(--text2);display:flex;align-items:center;gap:6px"><span style="color:var(--green);font-size:11px">✓</span> Owner DNA profiles</div>
        <div style="font-size:13px;color:var(--text2);display:flex;align-items:center;gap:6px"><span style="color:var(--green);font-size:11px">✓</span> Draft room intelligence</div>
        <div style="font-size:13px;color:var(--text2);display:flex;align-items:center;gap:6px"><span style="color:var(--green);font-size:11px">✓</span> Daily briefings</div>
      </div>`;
  }
}

// ── initTrialSystem — called once on DOMContentLoaded ─────────────
function initTrialSystem() {
  // initTrial() already stamps the start date; we just render UI here
  renderTrialBanner();
  updateTrialSettingsSection();
  if (_shouldShowExpirationModal()) {
    DhqStorage.setStr(STORAGE_KEYS.TRIAL_EXPIRED_SEEN, '1');
    setTimeout(renderExpirationModal, 500); // let app render first
  }
}

// ── Gate placeholder (blurred skeleton card with Unlock CTA) ─────
// Rendered inline where gated content would appear.
function _tierGatePlaceholder(featureLabel, feature) {
  return `
    <div style="position:relative;border-radius:12px;overflow:hidden;margin-bottom:8px;min-height:120px">
      <div style="filter:blur(3px);pointer-events:none;user-select:none;opacity:.25;padding:16px;background:var(--bg3);border-radius:12px">
        <div style="height:14px;background:var(--border);border-radius:4px;margin-bottom:10px;width:60%"></div>
        <div style="height:12px;background:var(--border);border-radius:4px;margin-bottom:8px;width:90%"></div>
        <div style="height:12px;background:var(--border);border-radius:4px;margin-bottom:8px;width:75%"></div>
        <div style="height:12px;background:var(--border);border-radius:4px;width:55%"></div>
      </div>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(10,10,15,.55)">
        <div style="font-size:22px">🔒</div>
        <div style="font-size:14px;font-weight:700;color:var(--text)">${featureLabel}</div>
        <button
          onclick="if(window.showProLaunchPage)showProLaunchPage();else showUpgradePrompt('${feature}')"
          style="padding:8px 20px;background:linear-gradient(135deg,#d4af37,#b8941f);color:#1a1000;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(212,175,55,.3)">
          Unlock with Pro
        </button>
      </div>
    </div>
  `;
}

// ── Init ──────────────────────────────────────────────────────────
// initTrial() stamps the start date immediately (sync).
// initTrialSystem() renders the banner/modal UI after DOM is ready.
initTrial();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTrialSystem);
} else {
  initTrialSystem();
}

// ── Expose ────────────────────────────────────────────────────────
Object.assign(window.App, {
  FEATURES,
  TRIAL_DAYS,
  FREE_CHAT_DAILY_LIMIT,
  getTier,
  isTrialActive,
  getRemainingTrialDays,
  canAccess,
  loadUserTier,
  trackFeatureUsage,
  getFeatureUsage,
  getDailyChatCount,
  incrementDailyChat,
  getDailyChatRemaining,
  showUpgradePrompt,
  _tierGatePlaceholder,
});

// Bare globals for inline onclick handlers and non-namespaced modules
window.FEATURES                  = FEATURES;
window.FREE_CHAT_DAILY_LIMIT     = FREE_CHAT_DAILY_LIMIT;
window.getTier                   = getTier;
window.isSandbox                 = isSandbox;
window.isTrialActive             = isTrialActive;
window.isTrialExpired            = isTrialExpired;
window.getRemainingTrialDays     = getRemainingTrialDays;
window.canAccess                 = canAccess;
window.loadUserTier              = loadUserTier;
window.getDailyChatCount         = getDailyChatCount;
window.getDailyChatRemaining     = getDailyChatRemaining;
window.incrementDailyChat        = incrementDailyChat;
window.showUpgradePrompt         = showUpgradePrompt;
window._tierGatePlaceholder      = _tierGatePlaceholder;
// Trial UI & tracking
window.trackUsage                = trackUsage;
window.getTrialUsage             = getTrialUsage;
window.dismissTrialBanner        = dismissTrialBanner;
window.renderTrialBanner         = renderTrialBanner;
window.closeTrialExpiredModal    = closeTrialExpiredModal;
window.renderExpirationModal     = renderExpirationModal;
window.updateTrialSettingsSection = updateTrialSettingsSection;
window.initTrialSystem           = initTrialSystem;

// ── Module global exports (Vite migration) ───────────────────────────────────
window.initTrial = initTrial;
window.trackFeatureUsage = trackFeatureUsage;
window.getFeatureUsage = getFeatureUsage;
