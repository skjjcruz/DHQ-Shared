// ══════════════════════════════════════════════════════════════════
// shared/supabase-client.js — Dynasty HQ Supabase Data Layer
// Shared by War Room Scout and War Room
//
// Requires: Supabase CDN loaded before this script
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// ══════════════════════════════════════════════════════════════════

window.App = window.App || {};
window.OD = window.OD || {};

const APP_CONFIG = window.App.CONFIG || window.OD.CONFIG || {};
const SUPABASE_URL  = APP_CONFIG.supabaseUrl || 'https://sxshiqyxhhifvtfqawbq.supabase.co';
const SUPABASE_ANON = APP_CONFIG.supabaseAnon || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN4c2hpcXl4aGhpZnZ0ZnFhd2JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MTExMzAsImV4cCI6MjA4ODI4NzEzMH0.zJi9W986ZLaANiZN6pt6ReFwaQU6yPeidsERIWo2ibI';
const BACKEND_ENDPOINTS = {
    getSessionToken: APP_CONFIG.endpoints?.getSessionToken || `${SUPABASE_URL}/functions/v1/get-session-token`,
    aiAnalyze: APP_CONFIG.endpoints?.aiAnalyze || `${SUPABASE_URL}/functions/v1/ai-analyze`,
    setPassword: APP_CONFIG.endpoints?.setPassword || `${SUPABASE_URL}/functions/v1/set-password`,
    fwProfile: APP_CONFIG.endpoints?.fwProfile || `${SUPABASE_URL}/functions/v1/fw-profile`,
    fwRefreshSession: APP_CONFIG.endpoints?.fwRefreshSession || `${SUPABASE_URL}/functions/v1/fw-refresh-session`,
    fwDeleteAccount: APP_CONFIG.endpoints?.fwDeleteAccount || `${SUPABASE_URL}/functions/v1/fw-delete-account`,
};

// ── Session token storage ─────────────────────────────────────
const SESSION_LS_KEY = 'od_session_v1';
const FW_SESSION_KEY = 'fw_session_v1';

function getSessionToken() {
    // New email-based session (Dynasty HQ landing)
    try {
        const raw = localStorage.getItem(FW_SESSION_KEY);
        if (raw) {
            const s = JSON.parse(raw);
            // Reject clearly-expired JWTs so "has a token" means "has a usable
            // token". The server validates exp too, but this keeps the client
            // from issuing requests that RLS will reject and falling through to
            // a confusing empty state instead of the localStorage fallback.
            if (s?.token && !_jwtExpired(s.token)) return s.token;
        }
    } catch {}
    // Legacy Sleeper session
    try {
        const raw = localStorage.getItem(SESSION_LS_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s?.token || !s?.expiresAt) return null;
        if (Date.now() >= new Date(s.expiresAt).getTime() - 5 * 60 * 1000) return null;
        return s.token;
    } catch { return null; }
}

// Best-effort JWT expiry check. Returns true only when we can decode an `exp`
// claim that is in the past (30s skew). Non-JWT / undecodable tokens are
// treated as not-expired so we never reject a token we don't understand.
function _jwtExpired(token) {
    try {
        const part = String(token).split('.')[1];
        if (!part) return false;
        const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
        const claims = JSON.parse(json);
        if (typeof claims?.exp !== 'number') return false;
        return Date.now() >= (claims.exp * 1000) - 30 * 1000;
    } catch { return false; }
}

function getAppSession() {
    try {
        const raw = localStorage.getItem(FW_SESSION_KEY);
        const session = raw ? JSON.parse(raw) : null;
        // Expired tokens are rejected here for the same reason as in
        // getSessionToken(): "has a session" must mean "has a usable session",
        // otherwise callers fire doomed requests, hit 401, and silently
        // resolve the account to the free tier instead of re-authing.
        if (session?.token && session?.user?.id && !_jwtExpired(session.token)) return session;
    } catch {}
    return null;
}

// A dead session (expired locally, or revoked/rejected by the server) must
// not linger in storage: every gate that sees a token treats the user as
// signed in, so a rotten token reads as "signed in but free tier" forever.
// Clearing it routes the user through the normal sign-in recovery path on
// the next gate check. Apps that want to show a "session expired" notice
// can listen for the event.
function _clearDeadAppSession(reason) {
    let email = null;
    try {
        const raw = localStorage.getItem(FW_SESSION_KEY);
        email = raw ? (JSON.parse(raw)?.user?.email || null) : null;
    } catch {}
    try { localStorage.removeItem(FW_SESSION_KEY); } catch {}
    _supabase = null;
    _supabaseToken = null;
    try {
        window.dispatchEvent(new CustomEvent('dhq:session-expired', { detail: { reason, email } }));
    } catch {}
}

// Age of the token's `iat` claim in hours; null when undecodable.
function _jwtAgeHours(token) {
    try {
        const part = String(token).split('.')[1];
        if (!part) return null;
        const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
        if (typeof claims?.iat !== 'number') return null;
        return (Date.now() - claims.iat * 1000) / 3600000;
    } catch { return null; }
}

// ── Session self-repair + sliding renewal ─────────────────────
// App JWTs live 7 days. This runs once per page load (memoized) before the
// first profile read and calls fw-refresh-session when the stored session
// either (a) is missing its user record — the pre-fix Google OAuth pages
// saved sessions without user.id, permanently locking those accounts to the
// free tier — or (b) carries a token more than a day old, so any visit
// inside the 7-day window slides the session forward and re-stamps
// tier/products from the live subscription. Expired tokens are cleared —
// refresh cannot resurrect them, and leaving them in storage strands the
// user in a signed-in-but-free limbo — so sign-in becomes the recovery path.
//
// Memoized per stored token, not per page load: SPA-style sign-in (or an
// OAuth callback that lands after boot already ran) swaps the stored session
// without a reload, and a page-load memo would keep serving the stale
// pre-sign-in result — every profile read would resolve free until a manual
// refresh.
let _sessionSyncPromise = null;
let _sessionSyncToken = null;
function _storedSessionToken() {
    try {
        const raw = localStorage.getItem(FW_SESSION_KEY);
        return raw ? (JSON.parse(raw)?.token || null) : null;
    } catch { return null; }
}
function ensureFreshAppSession() {
    const currentToken = _storedSessionToken();
    if (_sessionSyncPromise && _sessionSyncToken === currentToken) return _sessionSyncPromise;
    _sessionSyncToken = currentToken;
    _sessionSyncPromise = (async () => {
        try {
            const raw = localStorage.getItem(FW_SESSION_KEY);
            const session = raw ? JSON.parse(raw) : null;
            if (!session?.token) return null;
            if (_jwtExpired(session.token)) {
                _clearDeadAppSession('expired');
                _sessionSyncToken = null;
                return null;
            }
            const needsRepair = !session?.user?.id;
            const age = _jwtAgeHours(session.token);
            const stale = age === null || age > 24;
            if (!needsRepair && !stale) return getAppSession();
            const resp = await fetch(BACKEND_ENDPOINTS.fwRefreshSession, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${session.token}`,
                    'apikey': SUPABASE_ANON,
                },
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data?.token && data?.user?.id) {
                    const next = Object.assign({}, session, {
                        token: data.token,
                        user: Object.assign({}, session.user || {}, data.user),
                    });
                    localStorage.setItem(FW_SESSION_KEY, JSON.stringify(next));
                    // Re-key the memo to the token we just wrote, so the next
                    // caller in this page load hits the cache instead of
                    // treating the slide itself as a session change.
                    _sessionSyncToken = data.token;
                    _supabase = null;
                    _supabaseToken = null;
                }
            } else if (resp.status === 401) {
                // Revoked (session_version bump) or otherwise rejected: the
                // token can never work again, so clear it — a lingering dead
                // token reads as "signed in but free" at every gate.
                _clearDeadAppSession('revoked');
                _sessionSyncToken = null;
                return null;
            }
        } catch { /* network hiccup — try again next page load */ }
        return getAppSession();
    })();
    return _sessionSyncPromise;
}

// ── Bootstrap Supabase client ─────────────────────────────────
let _supabase = null;
let _supabaseToken = null;

function getClient() {
    if (typeof window.supabase === 'undefined') {
        console.warn('[FW] Supabase CDN not loaded — falling back to localStorage only');
        return null;
    }
    const token = getSessionToken();
    if (_supabase && _supabaseToken === token) return _supabase;
    const opts = token
        ? { global: { headers: { Authorization: `Bearer ${token}` } } }
        : {};
    _supabase      = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, opts);
    _supabaseToken = token;
    return _supabase;
}

function isConfigured() {
    return SUPABASE_URL !== 'YOUR_SUPABASE_URL' &&
           SUPABASE_ANON !== 'YOUR_SUPABASE_ANON_KEY';
}

// ── Username helper ───────────────────────────────────────────
// Works for both War Room (od_auth_v1) and War Room Scout (dynastyhq_username)
function getCurrentUsername() {
    // War Room auth
    try {
        const raw = localStorage.getItem('od_auth_v1');
        if (raw) {
            const auth = JSON.parse(raw);
            if (auth?.sleeperUsername || auth?.username) return auth.sleeperUsername || auth.username;
        }
    } catch {}
    // War Room Scout auth
    try {
        return localStorage.getItem('dynastyhq_username') || null;
    } catch { return null; }
}

function getAnalyticsUsername() {
    const username = getCurrentUsername();
    return getSessionToken() && username ? username : null;
}

// ── Account (app_users) identity ──────────────────────────────
// Email/password accounts mint a JWT keyed on app_users.id (stored in
// fw_session_v1.user.id). This is the security principal for direct DB
// writes; the Sleeper username is non-security "which league" metadata.
function getCurrentUserId() {
    try {
        const raw = localStorage.getItem(FW_SESSION_KEY);
        if (raw) {
            const s = JSON.parse(raw);
            if (s?.user?.id) return s.user.id;
        }
    } catch {}
    return null;
}

// Which owner columns a row should carry. Account session wins and forces
// username = null (RLS account policy requires it, to block username spoof).
// Legacy Sleeper session falls back to username.
function getOwnerIdentity() {
    // SECURITY: a cloud identity requires a valid (unexpired) session token.
    // The token is the only thing the server trusts — RLS keys on JWT claims,
    // not on these localStorage strings. Without a token, getClient() would
    // fall back to the anon key, so any "authenticated" read/write would go
    // out as the anon role (denied by RLS, but a footgun). Gating identity on
    // the token guarantees every user-scoped call carries Authorization:
    // Bearer <token> and never proceeds anon-only. A bare username/user-id in
    // localStorage is not a credential.
    if (!getSessionToken()) return { userId: null, username: null };
    const userId = getCurrentUserId();
    if (userId) return { userId, username: null };
    const username = getCurrentUsername();
    if (username) return { userId: null, username };
    return { userId: null, username: null };
}

function hasOwnerIdentity() {
    const o = getOwnerIdentity();
    return !!(o.userId || o.username);
}

// Owner columns to stamp on an insert/upsert row (exactly one is set).
function ownerCols(owner) {
    return owner.userId ? { user_id: owner.userId } : { username: owner.username };
}

// Constrain a select/delete to the current principal's rows.
function applyOwnerFilter(query, owner) {
    return owner.userId ? query.eq('user_id', owner.userId) : query.eq('username', owner.username);
}

// Pick the ON CONFLICT arbiter for an upsert based on principal type.
function ownerConflict(owner, legacyTarget, accountTarget) {
    return owner.userId ? accountTarget : legacyTarget;
}

// ── Ensure user row exists ────────────────────────────────────
// Legacy-only: the public.users row is keyed on sleeper_username. Account
// principals live in app_users (FK target for user_id) and must never write
// a users row, so this is a no-op for account sessions.
async function ensureUser(username) {
    if (getCurrentUserId()) return;
    const db = getClient();
    if (!db || !username) return;
    await db.from('users').upsert(
        { sleeper_username: username },
        { onConflict: 'sleeper_username', ignoreDuplicates: true }
    );
}

// ══════════════════════════════════════════════════════════════════
// AUTH — Session token acquisition
// Sleeper username → JWT via Edge Function → RLS enforced
// ══════════════════════════════════════════════════════════════════

window.OD.acquireSessionToken = async function(username, password) {
    if (!isConfigured() || !username) return null;
    try {
        const resp = await fetch(BACKEND_ENDPOINTS.getSessionToken, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON,
            },
            body: JSON.stringify({ username, password: password || undefined }),
        });
        if (!resp.ok) return null;
        const session = await resp.json();
        if (!session?.token) return null;
        localStorage.setItem(SESSION_LS_KEY, JSON.stringify(session));
        _supabase = null;
        _supabaseToken = null;
        return session;
    } catch { return null; }
};

// ══════════════════════════════════════════════════════════════════
// AI ANALYSIS — Server-side AI via Edge Function
// ══════════════════════════════════════════════════════════════════

// Free-tier tripwire (belt-and-suspenders — the per-surface trigger gates are
// the real guarantee): free users' server AI is limited to explicit
// user-initiated chat types; any other type reaching here is an ambient leak
// whose surface gate failed. No-op for paid tiers; fails open when tier
// plumbing isn't loaded (local preview, standalone pages).
// 'draft-chat' = warroom draft-room Ask Alex (explicit, rides the same daily
// allowance); 'memory-summary' only fires as a rider on an already-allowed
// free chat, so its cost is bounded by the chat quota.
const FREE_AI_TYPE_ALLOWLIST = ['recon-chat', 'home-chat', 'rookie-scout', 'trade-scout', 'draft-chat', 'memory-summary'];

window.OD.callAI = async function({ type, context }) {
    if (typeof window.isScoutPro === 'function' && !window.isScoutPro()
        && !FREE_AI_TYPE_ALLOWLIST.includes(type || 'recon-chat')) {
        console.warn('[FW] free-tier AI call blocked:', type);
        const error = new Error('This AI analysis requires an upgrade');
        error.status = 402;
        error.blockedFreeTier = true;
        throw error;
    }
    const token = getSessionToken();
    let aiContext = context;
    if (typeof context === 'string') {
        try {
            JSON.parse(context);
        } catch {
            aiContext = JSON.stringify({
                callType: type || 'recon-chat',
                userMessage: context,
                messages: [{ role: 'user', content: context }],
            });
        }
    }
    const response = await fetch(BACKEND_ENDPOINTS.aiAnalyze, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token || SUPABASE_ANON}`,
            'apikey': SUPABASE_ANON,
        },
        body: JSON.stringify({ type, context: aiContext }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const error = new Error(err.error || `AI call failed (${response.status})`);
        error.status = response.status;
        if (err.usage) error.usage = err.usage;
        if (err.limit) error.limit = err.limit;
        if (err.used) error.used = err.used;
        throw error;
    }
    return response.json();
};

window.OD.saveAIAnalysis = async function(leagueId, type, contextSummary, analysis) {
    const owner = getOwnerIdentity();
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity()) return null;
    await ensureUser(owner.username);
    const { data, error } = await db.from('ai_analysis').insert({
        ...ownerCols(owner), league_id: leagueId, type,
        context_summary: contextSummary || '',
        analysis,
    }).select('id').maybeSingle();
    if (error) { console.warn('[FW] ai_analysis save error', error); return null; }
    return data?.id || null;
};

window.OD.loadAIHistory = async function(leagueId) {
    const owner = getOwnerIdentity();
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity()) return [];
    const { data, error } = await applyOwnerFilter(
        db.from('ai_analysis').select('id, type, context_summary, analysis, created_at'),
        owner
    )
        .eq('league_id', leagueId)
        .order('created_at', { ascending: false })
        .limit(20);
    if (error) return [];
    return data || [];
};

window.OD.deleteAIAnalysis = async function(id) {
    const owner = getOwnerIdentity();
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity() || !id) return false;
    const { error } = await applyOwnerFilter(db.from('ai_analysis').delete(), owner).eq('id', id);
    if (error) { console.warn('[FW] ai_analysis delete error', error); return false; }
    return true;
};

// ══════════════════════════════════════════════════════════════════
// USER PROFILE
// ══════════════════════════════════════════════════════════════════

window.OD.ensureUser = ensureUser;

window.OD.saveProfile = async function(profile) {
    const username = getCurrentUsername();
    const db = getClient();
    if (!db || !isConfigured() || !username) return;
    await ensureUser(username);
    const { error } = await db.from('users').update({
        tier:                profile.tier               || 'free',
        fantasy_platforms:   profile.platforms          || ['sleeper'],
        onboarding_complete: profile.onboardingComplete || false,
    }).eq('sleeper_username', username);
    if (error) console.warn('[FW] profile save error', error);
};

window.OD.loadProfile = async function() {
    // Repair/renew the stored session first: pre-fix Google OAuth sessions
    // lack user.id (getAppSession() rejects them → silent free-tier fallback),
    // and week-old tokens need sliding before fw-profile will accept them.
    const appSession = isConfigured() ? await ensureFreshAppSession() : getAppSession();
    if (appSession?.token && isConfigured()) {
        try {
            const resp = await fetch(BACKEND_ENDPOINTS.fwProfile, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${appSession.token}`,
                    'apikey': SUPABASE_ANON,
                },
            });
            if (resp.ok) {
                const data = await resp.json();
                const user = data?.user || {};
                return {
                    tier: user.tier || 'free',
                    products: Array.isArray(user.products) ? user.products : [],
                    platforms: data?.platformUsernames || {},
                    onboardingComplete: true,
                };
            }
            if (resp.status === 401) {
                // The server rejected a token that passed the local expiry
                // check — revoked or signed with a rotated secret. Dead either
                // way; clear it so the user is routed to sign-in instead of
                // being silently resolved to the free tier on every load.
                _clearDeadAppSession('revoked');
            }
        } catch {}
    }

    const username = getCurrentUsername();
    const db = getClient();
    if (!db || !isConfigured() || !username) return null;
    const { data, error } = await db
        .from('users')
        .select('tier, fantasy_platforms, onboarding_complete')
        .eq('sleeper_username', username)
        .maybeSingle();
    if (error || !data) return null;
    return {
        tier:               data.tier               || 'free',
        platforms:          data.fantasy_platforms  || ['sleeper'],
        onboardingComplete: data.onboarding_complete || false,
    };
};

window.OD.savePlatformUsernames = async function(platformUsernames) {
    const appSession = getAppSession();
    if (!appSession?.token || !isConfigured()) return false;
    try {
        const resp = await fetch(BACKEND_ENDPOINTS.fwProfile, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${appSession.token}`,
                'apikey': SUPABASE_ANON,
            },
            body: JSON.stringify({ platformUsernames }),
        });
        return resp.ok;
    } catch {
        return false;
    }
};

// ══════════════════════════════════════════════════════════════════
// ASSISTANT TUTORIAL STATE
// App account is authoritative when fw_session_v1 exists. Legacy Sleeper
// profile sync is a fallback; localStorage fallback lives in the tutorial engine.
// ══════════════════════════════════════════════════════════════════

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeTutorialRecord(productKey, record) {
    if (!isPlainObject(record)) return null;
    const product = String(record.product || productKey || '').trim();
    if (!product) return null;
    return {
        product,
        version: String(record.version || 'gm-brief-v1').slice(0, 40),
        completedAt: String(record.completedAt || new Date().toISOString()).slice(0, 80),
        skipped: !!record.skipped,
    };
}

function sanitizeTutorialState(state) {
    const out = {};
    if (!isPlainObject(state)) return out;
    ['scout', 'warroom'].forEach(productKey => {
        const record = sanitizeTutorialRecord(productKey, state[productKey]);
        if (record) out[productKey] = record;
    });
    return out;
}

async function loadAppTutorialState() {
    const session = getAppSession();
    if (!session?.token || !isConfigured()) return null;
    try {
        const resp = await fetch(BACKEND_ENDPOINTS.fwProfile, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${session.token}`,
                'apikey': SUPABASE_ANON,
            },
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return sanitizeTutorialState(data?.tutorialState || {});
    } catch {
        return null;
    }
}

async function saveAppTutorialState(tutorialState) {
    const session = getAppSession();
    if (!session?.token || !isConfigured()) return false;
    try {
        const resp = await fetch(BACKEND_ENDPOINTS.fwProfile, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.token}`,
                'apikey': SUPABASE_ANON,
            },
            body: JSON.stringify({ tutorialState: sanitizeTutorialState(tutorialState) }),
        });
        return resp.ok;
    } catch {
        return false;
    }
}

async function loadLegacyTutorialState() {
    const username = getCurrentUsername();
    const db = getClient();
    if (!db || !isConfigured() || !username) return null;
    try {
        const { data, error } = await db
            .from('users')
            .select('tutorial_state')
            .eq('sleeper_username', username)
            .maybeSingle();
        if (error || !data) return null;
        return sanitizeTutorialState(data.tutorial_state || {});
    } catch {
        return null;
    }
}

async function saveLegacyTutorialState(tutorialState) {
    const username = getCurrentUsername();
    const db = getClient();
    if (!db || !isConfigured() || !username) return false;
    try {
        await ensureUser(username);
        const { error } = await db
            .from('users')
            .update({ tutorial_state: sanitizeTutorialState(tutorialState) })
            .eq('sleeper_username', username);
        if (error) throw error;
        return true;
    } catch (e) {
        console.warn('[FW] tutorial_state save error', e);
        return false;
    }
}

window.OD.loadTutorialState = async function(productKey) {
    const state = await loadAppTutorialState() || await loadLegacyTutorialState() || {};
    const clean = sanitizeTutorialState(state);
    return productKey ? clean[productKey] || null : clean;
};

window.OD.saveTutorialState = async function(productKey, record) {
    const safeRecord = sanitizeTutorialRecord(productKey, record);
    if (!safeRecord) return false;
    const current = sanitizeTutorialState(await window.OD.loadTutorialState());
    const next = { ...current, [productKey]: safeRecord };
    if (await saveAppTutorialState(next)) return true;
    return saveLegacyTutorialState(next);
};

// ══════════════════════════════════════════════════════════════════
// DISPLAY NAME
// ══════════════════════════════════════════════════════════════════

window.OD.loadDisplayName = async function() {
    const username = getCurrentUsername();
    if (isConfigured() && username) {
        const db = getClient();
        const { data } = await db.from('users').select('display_name').eq('sleeper_username', username).maybeSingle();
        if (data && data.display_name) {
            localStorage.setItem('od_display_name', data.display_name);
            return data.display_name;
        }
    }
    return localStorage.getItem('od_display_name') || '';
};

window.OD.saveDisplayName = function(name) {
    localStorage.setItem('od_display_name', name);
    const username = getCurrentUsername();
    if (isConfigured() && username) {
        const db = getClient();
        ensureUser(username).then(() => {
            db.from('users').update({ display_name: name || null }).eq('sleeper_username', username).then(({ error }) => {
                if (error) console.warn('[FW] display_name save error', error);
            });
        }).catch(console.warn);
    }
};

// ══════════════════════════════════════════════════════════════════
// MFL CONNECTION — cross-device sync of the connected MFL league + team
// ══════════════════════════════════════════════════════════════════
// Mirrors display-name sync: stored on the legacy `users` row (keyed by
// sleeper_username) as a jsonb blob so a connected MFL league + team pick
// follows the account across devices, the way Sleeper leagues do via the
// username. Shape: { leagueId, year, franchiseId }. NEVER stores the private-
// league API key — secrets stay client-side (sessionStorage) only.

window.OD.loadMflConnection = async function() {
    const username = getCurrentUsername();
    if (isConfigured() && username) {
        const db = getClient();
        if (db) {
            const { data } = await db.from('users').select('mfl_connection').eq('sleeper_username', username).maybeSingle();
            const conn = data && data.mfl_connection;
            if (conn && conn.leagueId) return conn;
        }
    }
    return null;
};

window.OD.saveMflConnection = function(conn) {
    const username = getCurrentUsername();
    if (!isConfigured() || !username) return;
    const db = getClient();
    if (!db) return;
    const safe = (conn && conn.leagueId)
        ? { leagueId: String(conn.leagueId), year: conn.year ? String(conn.year) : null, franchiseId: conn.franchiseId ? String(conn.franchiseId) : null }
        : {};
    ensureUser(username).then(() => {
        db.from('users').update({ mfl_connection: safe }).eq('sleeper_username', username).then(({ error }) => {
            if (error) console.warn('[FW] mfl_connection save error', error);
        });
    }).catch(console.warn);
};

// ══════════════════════════════════════════════════════════════════
// OWNER DNA PROFILES
// ══════════════════════════════════════════════════════════════════

window.OD.loadDNA = async function(leagueId) {
    let local = {};
    try {
        const raw = localStorage.getItem(`od_owner_dna_v1_${leagueId}`);
        if (raw) local = JSON.parse(raw);
    } catch {}
    const owner = getOwnerIdentity();
    if (isConfigured() && hasOwnerIdentity()) {
        const db = getClient();
        if (db) {
            const { data } = await applyOwnerFilter(
                db.from('owner_dna').select('dna_map'), owner
            ).eq('league_id', leagueId).maybeSingle();
            if (data) {
                const merged = { ...local, ...(data.dna_map || {}) };
                localStorage.setItem(`od_owner_dna_v1_${leagueId}`, JSON.stringify(merged));
                return merged;
            }
        }
    }
    return local;
};

window.OD.saveDNA = function(leagueId, dnaMap) {
    localStorage.setItem(`od_owner_dna_v1_${leagueId}`, JSON.stringify(dnaMap));
    const owner = getOwnerIdentity();
    if (isConfigured() && hasOwnerIdentity()) {
        const db = getClient();
        if (db) {
            ensureUser(owner.username).then(() => {
                db.from('owner_dna').upsert(
                    { ...ownerCols(owner), league_id: leagueId, dna_map: dnaMap, updated_at: new Date().toISOString() },
                    { onConflict: ownerConflict(owner, 'username,league_id', 'user_id,league_id') }
                );
            }).catch(console.warn);
        }
    }
};

// ══════════════════════════════════════════════════════════════════
// STATUS + HELPERS
// ══════════════════════════════════════════════════════════════════

window.OD.getSessionToken = getSessionToken;
window.OD.getAppSession = getAppSession;
window.OD.ensureFreshAppSession = ensureFreshAppSession;
window.OD.getClient = getClient;
window.OD.isConfigured = isConfigured;
window.OD.getCurrentUsername = getCurrentUsername;
window.OD.getCurrentUserId = getCurrentUserId;
window.OD.SUPABASE_URL = SUPABASE_URL;
window.OD.SUPABASE_ANON = SUPABASE_ANON;
window.OD.BACKEND_ENDPOINTS = BACKEND_ENDPOINTS;

window.OD.status = function() {
    if (!isConfigured()) return console.log('[FW] Supabase not configured — using localStorage only');
    const db = getClient();
    if (!db) return console.log('[FW] Supabase CDN not loaded');
    const token = getSessionToken();
    console.log('[FW] Supabase connected:', SUPABASE_URL);
    console.log('[FW] Account user_id:', getCurrentUserId() || '(none)');
    console.log('[FW] Sleeper username:', getCurrentUsername() || '(none)');
    console.log('[FW] Session token:', token ? 'valid' : 'none — DB writes will be blocked by RLS');
};

// ══════════════════════════════════════════════════════════════════
// CALENDAR EVENTS (War Room)
// ══════════════════════════════════════════════════════════════════
const CALENDAR_LS_KEY = 'od_calendar_events';

async function dbLoadCalendarEvents(owner) {
    const db = getClient();
    if (!db || !isConfigured() || !(owner.userId || owner.username)) return null;
    const { data, error } = await applyOwnerFilter(db.from('calendar_events').select('*'), owner);
    if (error) { console.warn('[FW] calendar load error', error); return null; }
    return data.map(row => ({ id: row.id, title: row.title, date: row.date, time: row.time, league: row.league, details: row.details }));
}

async function dbSaveCalendarEvents(owner, events) {
    const db = getClient();
    if (!db || !isConfigured() || !(owner.userId || owner.username)) return;
    await ensureUser(owner.username);
    const rows = events.map(e => ({ id: e.id, ...ownerCols(owner), title: e.title, date: e.date, time: e.time || '', league: e.league || '', details: e.details || '' }));
    if (rows.length > 0) {
        const { error } = await db.from('calendar_events').upsert(rows, { onConflict: 'id' });
        if (error) console.warn('[FW] calendar save error', error);
    }
    const { data: existing } = await applyOwnerFilter(db.from('calendar_events').select('id'), owner);
    const keepIds = new Set(events.map(e => e.id));
    const toDelete = (existing || []).map(r => r.id).filter(id => !keepIds.has(id));
    if (toDelete.length > 0) await db.from('calendar_events').delete().in('id', toDelete);
}

window.OD.loadCalendarEvents = async function(defaultEvents) {
    let local = null;
    try { const raw = localStorage.getItem(CALENDAR_LS_KEY); if (raw) local = JSON.parse(raw); } catch {}
    const owner = getOwnerIdentity();
    if (isConfigured() && hasOwnerIdentity()) {
        const remote = await dbLoadCalendarEvents(owner);
        if (remote !== null) {
            const remoteIds = new Set(remote.map(e => e.id));
            const missingDefaults = (defaultEvents || []).filter(d => !remoteIds.has(d.id));
            const merged = [...remote, ...missingDefaults];
            localStorage.setItem(CALENDAR_LS_KEY, JSON.stringify(merged));
            return merged;
        }
    }
    if (local) {
        const localIds = new Set(local.map(e => e.id));
        const missing = (defaultEvents || []).filter(d => !localIds.has(d.id));
        if (missing.length > 0) { const merged = [...local, ...missing]; localStorage.setItem(CALENDAR_LS_KEY, JSON.stringify(merged)); return merged; }
        return local;
    }
    localStorage.setItem(CALENDAR_LS_KEY, JSON.stringify(defaultEvents || []));
    return defaultEvents || [];
};

window.OD.saveCalendarEvents = function(events) {
    localStorage.setItem(CALENDAR_LS_KEY, JSON.stringify(events));
    const owner = getOwnerIdentity();
    if (isConfigured() && hasOwnerIdentity()) dbSaveCalendarEvents(owner, events).catch(console.warn);
};

// ══════════════════════════════════════════════════════════════════
// EARNINGS (War Room)
// ══════════════════════════════════════════════════════════════════
const EARNINGS_LS_KEY = 'od_earnings_entries';

async function dbLoadEarnings(owner) {
    const db = getClient();
    if (!db || !isConfigured() || !(owner.userId || owner.username)) return null;
    const { data, error } = await applyOwnerFilter(db.from('earnings').select('*'), owner);
    if (error) { console.warn('[FW] earnings load error', error); return null; }
    return data.map(row => ({ id: row.id, year: row.year, league: row.league, description: row.description, amount: row.amount }));
}

async function dbSaveEarnings(owner, entries) {
    const db = getClient();
    if (!db || !isConfigured() || !(owner.userId || owner.username)) return;
    await ensureUser(owner.username);
    if (entries.length > 0) {
        const rows = entries.map(e => ({ id: e.id, ...ownerCols(owner), year: e.year, league: e.league || '', description: e.description || '', amount: e.amount }));
        const { error } = await db.from('earnings').upsert(rows, { onConflict: 'id' });
        if (error) console.warn('[FW] earnings save error', error);
    }
    const { data: existing } = await applyOwnerFilter(db.from('earnings').select('id'), owner);
    const keepIds = new Set(entries.map(e => e.id));
    const toDelete = (existing || []).map(r => r.id).filter(id => !keepIds.has(id));
    if (toDelete.length > 0) await db.from('earnings').delete().in('id', toDelete);
}

window.OD.loadEarnings = async function() {
    let local = null;
    try { const raw = localStorage.getItem(EARNINGS_LS_KEY); if (raw) local = JSON.parse(raw); } catch {}
    const owner = getOwnerIdentity();
    if (isConfigured() && hasOwnerIdentity()) {
        const remote = await dbLoadEarnings(owner);
        if (remote !== null) { localStorage.setItem(EARNINGS_LS_KEY, JSON.stringify(remote)); return remote; }
    }
    return local || [];
};

window.OD.saveEarnings = function(entries) {
    localStorage.setItem(EARNINGS_LS_KEY, JSON.stringify(entries));
    const owner = getOwnerIdentity();
    if (isConfigured() && hasOwnerIdentity()) dbSaveEarnings(owner, entries).catch(console.warn);
};

// ══════════════════════════════════════════════════════════════════
// FREE AGENCY TARGETS (War Room)
// ══════════════════════════════════════════════════════════════════
const FA_LS_KEY = id => `od_fa_targets_v1_${id}`;

async function dbLoadTargets(owner, leagueId) {
    const db = getClient();
    if (!db || !isConfigured() || !(owner.userId || owner.username)) return null;
    const { data, error } = await applyOwnerFilter(db.from('fa_targets').select('*'), owner)
        .eq('league_id', leagueId).maybeSingle();
    if (error) { console.warn('[FW] fa load error', error); return null; }
    if (!data) return null;
    return { startingBudget: data.starting_budget, targets: data.targets || [] };
}

async function dbSaveTargets(owner, leagueId, faData) {
    const db = getClient();
    if (!db || !isConfigured() || !(owner.userId || owner.username)) return;
    await ensureUser(owner.username);
    const { error } = await db.from('fa_targets').upsert(
        { ...ownerCols(owner), league_id: leagueId, starting_budget: faData.startingBudget, targets: faData.targets, updated_at: new Date().toISOString() },
        { onConflict: ownerConflict(owner, 'username,league_id', 'user_id,league_id') }
    );
    if (error) console.warn('[FW] fa save error', error);
}

window.OD.loadTargets = async function(leagueId) {
    let local = null;
    try { const raw = localStorage.getItem(FA_LS_KEY(leagueId)); if (raw) local = JSON.parse(raw); } catch {}
    const owner = getOwnerIdentity();
    if (isConfigured() && hasOwnerIdentity()) { const remote = await dbLoadTargets(owner, leagueId); if (remote !== null) return remote; }
    return local || { startingBudget: 1000, targets: [] };
};

window.OD.saveTargets = function(leagueId, data) {
    localStorage.setItem(FA_LS_KEY(leagueId), JSON.stringify(data));
    try {
        (data?.targets || []).forEach(target => {
            const pid = target.pid || target.playerId || target.id || target.name || null;
            window.OD.trackWaiverTargetSaved?.(pid, {
                leagueId,
                metadata: {
                    bid: target.bid || target.faab || target.amount || null,
                    priority: target.priority || target.tier || null,
                },
            });
        });
    } catch (_err) {}
    const owner = getOwnerIdentity();
    if (isConfigured() && hasOwnerIdentity()) dbSaveTargets(owner, leagueId, data).catch(console.warn);
};

// ══════════════════════════════════════════════════════════════════
// DIRECT MESSAGES (War Room)
// ══════════════════════════════════════════════════════════════════

window.OD.sendDM = async function(toUsername, body) {
    const from = getCurrentUsername();
    const db = getClient();
    if (!db || !isConfigured() || !from) throw new Error('Not configured');
    await ensureUser(from);
    const { error } = await db.from('messages').insert({ from_username: from, to_username: toUsername, body });
    if (error) throw error;
};

window.OD.loadDMs = async function({ limit = 100, offset = 0 } = {}) {
    const username = getCurrentUsername();
    const db = getClient();
    if (!db || !isConfigured() || !username) return [];
    const { data, error } = await db.from('messages').select('*')
        .or(`from_username.eq.${username},to_username.eq.${username}`)
        .order('created_at', { ascending: true })
        .range(offset, offset + limit - 1);
    if (error) return [];
    return data || [];
};

window.OD.markDMsRead = async function(fromUsername) {
    const username = getCurrentUsername();
    const db = getClient();
    if (!db || !isConfigured() || !username) return;
    await db.from('messages').update({ read: true })
        .eq('to_username', username).eq('from_username', fromUsername).eq('read', false);
};

// ══════════════════════════════════════════════════════════════════
// GIFT USERS + PASSWORD (War Room)
// ══════════════════════════════════════════════════════════════════

window.OD.createGiftUser = async function({ sleeperUsername, password, displayName }) {
    if (!isConfigured()) throw new Error('Supabase not configured');
    const token = getSessionToken();
    if (!token) throw new Error('You must be logged in to gift a dashboard');
    const resp = await fetch(BACKEND_ENDPOINTS.setPassword, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON },
        body: JSON.stringify({ username: sleeperUsername, password, displayName: displayName || undefined }),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || 'Failed to create gift user');
};

window.OD.checkUsersAccess = async function(usernames) {
    const db = getClient();
    if (!db || !isConfigured() || !usernames || usernames.length === 0) return new Set();
    const { data } = await db.from('users').select('sleeper_username').in('sleeper_username', usernames);
    return new Set((data || []).map(u => u.sleeper_username));
};

async function hashPassword(password) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(password));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

window.OD.verifySupabasePassword = async function(username, password) {
    const db = getClient();
    if (!db || !isConfigured()) return false;
    const { data, error } = await db.from('users').select('password_hash, is_gifted').eq('sleeper_username', username).maybeSingle();
    if (error || !data || !data.password_hash) return false;
    const inputHash = await hashPassword(password);
    return { match: data.password_hash === inputHash, isGifted: data.is_gifted || false };
};

window.OD.updatePassword = async function(username, newPassword) {
    if (!isConfigured()) throw new Error('Supabase not configured');
    const token = getSessionToken();
    if (!token) throw new Error('You must be logged in to change your password');
    const resp = await fetch(BACKEND_ENDPOINTS.setPassword, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON },
        body: JSON.stringify({ username, password: newPassword }),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || 'Failed to update password');
};

// Permanently delete the signed-in user's account and all their data.
// Required for App Store / Play Store compliance. After success the caller
// should sign the user out and return them to the landing screen.
window.OD.deleteAccount = async function() {
    if (!isConfigured()) throw new Error('Supabase not configured');
    const token = getSessionToken();
    if (!token) throw new Error('You must be logged in to delete your account');
    const resp = await fetch(BACKEND_ENDPOINTS.fwDeleteAccount, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON },
        body: JSON.stringify({ confirm: true }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(result.error || 'Failed to delete account');
    return result;
};

// ══════════════════════════════════════════════════════════════════
// PLAYER TAGS (Trade Block, Cut, Untouchable, Watch)
// Syncs between War Room Scout and War Room via Supabase
// Falls back to localStorage when Supabase is unavailable
// ══════════════════════════════════════════════════════════════════

// Run this SQL in Supabase to create the player_tags table:
// create table if not exists public.player_tags (
//   id uuid primary key default gen_random_uuid(),
//   username text not null references public.users(sleeper_username) on delete cascade,
//   league_id text not null,
//   tags jsonb not null default '{}'::jsonb,
//   updated_at timestamptz default now(),
//   unique(username, league_id)
// );

const TAGS_LS_KEY = (leagueId) => 'player_tags_' + (leagueId || '');

window.OD.savePlayerTags = async function(leagueId, tags) {
    // Always save to localStorage first (instant)
    try { localStorage.setItem(TAGS_LS_KEY(leagueId), JSON.stringify(tags)); } catch {}

    // Then sync to Supabase (async, non-blocking)
    const owner = getOwnerIdentity();
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity()) return;
    try {
        await ensureUser(owner.username);
        const { error } = await db.from('player_tags').upsert({
            ...ownerCols(owner),
            league_id: leagueId,
            tags: tags, // JSON object: { "pid": "trade"|"cut"|"untouchable"|"watch" }
            updated_at: new Date().toISOString(),
        }, { onConflict: ownerConflict(owner, 'username,league_id', 'user_id,league_id') });
        if (error) console.warn('[FW] player_tags save error', error);
    } catch (e) { console.warn('[FW] player_tags save failed:', e); }
};

window.OD.loadPlayerTags = async function(leagueId) {
    // Try localStorage first (fast)
    let local = {};
    try {
        const raw = localStorage.getItem(TAGS_LS_KEY(leagueId));
        if (raw) local = JSON.parse(raw);
    } catch {}

    // Try Supabase (may have newer data from the other app)
    const owner = getOwnerIdentity();
    const db = getClient();
    if (db && isConfigured() && hasOwnerIdentity()) {
        try {
            const { data, error } = await applyOwnerFilter(
                db.from('player_tags').select('tags, updated_at'), owner
            )
                .eq('league_id', leagueId)
                .maybeSingle();
            if (!error && data?.tags) {
                // Merge: Supabase wins for conflicts (it's the sync source)
                const merged = { ...local, ...data.tags };
                try { localStorage.setItem(TAGS_LS_KEY(leagueId), JSON.stringify(merged)); } catch {}
                return merged;
            }
        } catch (e) { console.warn('[FW] player_tags load failed:', e); }
    }
    return local;
};

// ══════════════════════════════════════════════════════════════════
// DRAFT BOARD — the user's custom board built in War Room
// (manual ranks, tiers, notes, targets). Read-only in Scout so the
// board you prepped in War Room shows up live on your phone.
// Syncs via Supabase; falls back to localStorage. Graceful no-op if
// the draft_boards table / data does not exist yet.
//
// Expected table (created/owned by War Room):
// create table if not exists public.draft_boards (
//   id uuid primary key default gen_random_uuid(),
//   username text references public.users(sleeper_username) on delete cascade,
//   user_id uuid,
//   league_id text not null,
//   board jsonb not null default '{}'::jsonb,
//   updated_at timestamptz default now(),
//   unique(username, league_id)
// );
//
// `board` shape is tolerated flexibly — a map keyed by player_id, an
// array of entries, or { players: [...] } — and normalized to:
//   { "<player_id>": { rank, tier, note, target } }
// ══════════════════════════════════════════════════════════════════

const DRAFT_BOARD_LS_KEY = (leagueId) => 'draft_board_' + (leagueId || '');

function _normalizeDraftBoard(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    const entries = Array.isArray(raw) ? raw
        : Array.isArray(raw.players) ? raw.players
        : null;
    const put = (pid, e) => {
        if (pid == null) return;
        out[String(pid)] = {
            rank: e.rank != null ? Number(e.rank) : (e.overall != null ? Number(e.overall) : null),
            tier: e.tier != null ? e.tier : (e.tier_label || null),
            note: e.note || e.notes || '',
            target: e.target === true || e.is_target === true || e.starred === true,
        };
    };
    if (entries) {
        entries.forEach(e => { if (e && typeof e === 'object') put(e.player_id ?? e.pid ?? e.id, e); });
    } else {
        // Map keyed by player_id. Values may be objects or a bare rank number.
        Object.keys(raw).forEach(pid => {
            const v = raw[pid];
            if (v && typeof v === 'object') put(pid, v);
            else if (typeof v === 'number') out[String(pid)] = { rank: v, tier: null, note: '', target: false };
        });
    }
    return out;
}

window.OD.loadDraftBoard = async function(leagueId) {
    // localStorage first (instant)
    let local = {};
    try {
        const raw = localStorage.getItem(DRAFT_BOARD_LS_KEY(leagueId));
        if (raw) local = JSON.parse(raw);
    } catch {}

    const owner = getOwnerIdentity();
    const db = getClient();
    if (db && isConfigured() && hasOwnerIdentity()) {
        try {
            const { data, error } = await applyOwnerFilter(
                db.from('draft_boards').select('board, updated_at'), owner
            )
                .eq('league_id', leagueId)
                .maybeSingle();
            if (!error && data?.board) {
                const norm = _normalizeDraftBoard(data.board);
                try { localStorage.setItem(DRAFT_BOARD_LS_KEY(leagueId), JSON.stringify(norm)); } catch {}
                return norm;
            }
        } catch (e) {
            // Table may not exist yet — that's fine, fall back silently.
            console.warn('[FW] draft_board load skipped:', e?.message || e);
        }
    }
    return local;
};
// Run this SQL in Supabase to create the field_log table:
//
// create table if not exists public.field_log (
//   id uuid primary key default gen_random_uuid(),
//   client_id text unique,
//   username text not null references public.users(sleeper_username) on delete cascade,
//   league_id text,
//   ts bigint not null,
//   category text not null default 'note',
//   action_type text,
//   players jsonb,
//   context text,
//   icon text default '📋',
//   text text not null,
//   source text default 'scout',
//   created_at timestamptz default now()
// );
// create index if not exists field_log_username_ts_idx on public.field_log(username, ts desc);
// ══════════════════════════════════════════════════════════════════

const FL_LS_KEY = 'scout_field_log_v1';

// Save a single entry to Supabase, updating sync status in localStorage
let _fieldLogDbDisabled = false;

window.OD.saveFieldLogEntry = async function(entry) {
    if (_fieldLogDbDisabled) return false;

    const owner = getOwnerIdentity();
    const db = getClient();

    function updateLocalSyncStatus(status) {
        try {
            const raw = localStorage.getItem(FL_LS_KEY);
            const log = raw ? JSON.parse(raw) : [];
            const idx = log.findIndex(e => e.id === entry.id);
            if (idx !== -1) { log[idx].syncStatus = status; localStorage.setItem(FL_LS_KEY, JSON.stringify(log)); }
        } catch {}
    }

    if (!db || !isConfigured() || !hasOwnerIdentity()) {
        updateLocalSyncStatus('pending');
        return false;
    }
    try {
        await ensureUser(owner.username);
        const { error } = await db.from('field_log').upsert({
            client_id: entry.id,
            ...ownerCols(owner),
            league_id: entry.leagueId || null,
            ts: entry.ts,
            category: entry.category || 'note',
            action_type: entry.actionType || null,
            players: entry.players?.length ? entry.players : null,
            context: entry.context || null,
            icon: entry.icon || '📋',
            text: entry.text,
            source: entry.source || 'scout',
        }, { onConflict: 'client_id' });
        if (error) {
            // Disable DB writes on auth/RLS errors to stop spamming
            if (error.code === '42501' || error.message?.includes('row-level security') || error.code === '401') {
                _fieldLogDbDisabled = true;
            }
            updateLocalSyncStatus('failed');
            return false;
        }
        updateLocalSyncStatus('synced');
        return true;
    } catch {
        _fieldLogDbDisabled = true;
        updateLocalSyncStatus('failed');
        return false;
    }
};

// Bulk sync any pending/failed entries from localStorage
window.OD.syncPendingFieldLog = async function() {
    if (_fieldLogDbDisabled) return 0;
    try {
        const raw = localStorage.getItem(FL_LS_KEY);
        if (!raw) return 0;
        const log = JSON.parse(raw);
        const pending = log.filter(e => e.syncStatus === 'pending' || e.syncStatus === 'failed');
        if (!pending.length) return 0;
        let synced = 0;
        for (const entry of pending) {
            const ok = await window.OD.saveFieldLogEntry(entry);
            if (ok) synced++;
        }
        return synced;
    } catch (e) { console.warn('[FW] syncPendingFieldLog failed:', e); return 0; }
};

// Load field log entries from Supabase (used by War Room)
window.OD.loadFieldLog = async function(leagueId, limit) {
    limit = limit || 50;
    const owner = getOwnerIdentity();
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity()) return null;
    try {
        let query = applyOwnerFilter(
            db.from('field_log')
                .select('id, client_id, league_id, ts, category, action_type, players, context, icon, text, source, created_at'),
            owner
        )
            .order('ts', { ascending: false })
            .limit(limit);
        if (leagueId) query = query.eq('league_id', leagueId);
        const { data, error } = await query;
        if (error) { console.warn('[FW] field_log load error', error); return null; }
        return (data || []).map(row => ({
            id: row.client_id || row.id,
            icon: row.icon || '📋',
            text: row.text,
            category: row.category || 'note',
            actionType: row.action_type || null,
            players: row.players || [],
            context: row.context || null,
            leagueId: row.league_id || null,
            ts: row.ts,
            syncStatus: 'synced',
            source: row.source || 'scout',
            createdAt: row.created_at,
        }));
    } catch (e) { console.warn('[FW] field_log load failed:', e); return null; }
};

// ══════════════════════════════════════════════════════════════════
// AI CHAT MEMORY — shared between War Room Scout and War Room (Phase 7B)
// Run this SQL in Supabase to create the ai_chat_memory table:
//
// create table if not exists public.ai_chat_memory (
//   id uuid primary key default gen_random_uuid(),
//   username text not null references public.users(sleeper_username) on delete cascade,
//   league_id text,
//   ts bigint not null,
//   session_label text,
//   summary text not null,
//   source text default 'scout',
//   created_at timestamptz default now()
// );
// create index if not exists ai_chat_memory_username_ts_idx on public.ai_chat_memory(username, ts desc);
// ══════════════════════════════════════════════════════════════════

let _chatMemoryDbDisabled = false;

// Save a rolling chat memory summary to Supabase. Non-blocking; failures
// do not interrupt the in-memory / localStorage path in ai-chat.js.
window.OD.saveChatMemory = async function(entry) {
    if (_chatMemoryDbDisabled) return false;
    const owner = getOwnerIdentity();
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity() || !entry?.summary) return false;
    try {
        await ensureUser(owner.username);
        const { error } = await db.from('ai_chat_memory').insert({
            ...ownerCols(owner),
            league_id: entry.leagueId || null,
            ts: entry.ts || Date.now(),
            session_label: entry.sessionLabel || null,
            summary: entry.summary,
            source: entry.source || 'scout',
        });
        if (error) {
            if (error.code === '42501' || error.message?.includes('row-level security') || error.code === '401') {
                _chatMemoryDbDisabled = true;
            }
            return false;
        }
        return true;
    } catch {
        _chatMemoryDbDisabled = true;
        return false;
    }
};

// Load the most recent chat memory summaries for the current user/league.
window.OD.loadChatMemory = async function(leagueId, limit) {
    if (_chatMemoryDbDisabled) return null;
    limit = limit || 6;
    const owner = getOwnerIdentity();
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity()) return null;
    try {
        let query = applyOwnerFilter(
            db.from('ai_chat_memory')
                .select('id, league_id, ts, session_label, summary, source, created_at'),
            owner
        )
            .order('ts', { ascending: false })
            .limit(limit);
        if (leagueId) query = query.eq('league_id', leagueId);
        const { data, error } = await query;
        if (error) {
            console.warn('[FW] ai_chat_memory load error:', error.message || error.code || JSON.stringify(error));
            // Kill switch — any error disables further attempts this session
            // (missing table, RLS denial, auth expired, network). localStorage
            // remains the authoritative source either way.
            _chatMemoryDbDisabled = true;
            return null;
        }
        return (data || []).map(row => ({
            ts: row.ts,
            sessionLabel: row.session_label || null,
            summary: row.summary,
            leagueId: row.league_id || null,
            source: row.source || 'scout',
        }));
    } catch (e) {
        console.warn('[FW] ai_chat_memory load failed:', e?.message || e);
        _chatMemoryDbDisabled = true;
        return null;
    }
};

// ══════════════════════════════════════════════════════════════════
// GM STRATEGY — shared global strategy, synced across devices + apps
// Run this SQL in Supabase to create the gm_strategy table:
//
// create table if not exists public.gm_strategy (
//   username         text        primary key references public.users(sleeper_username) on delete cascade,
//   strategy         jsonb       not null,
//   version          int         not null default 1,
//   last_synced_at   bigint      not null,
//   last_synced_from text        default 'scout',
//   updated_at       timestamptz default now()
// );
// alter table public.gm_strategy enable row level security;
// -- (policies in supabase/migrations/007_gm_strategy.sql)
// ══════════════════════════════════════════════════════════════════

let _strategyDbDisabled = false;

// Upsert the user's strategy row. Non-blocking — callers fire and forget.
window.OD.saveStrategy = async function(strategy) {
    if (_strategyDbDisabled) return false;
    const owner    = getOwnerIdentity();
    const token    = getSessionToken();
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity() || !strategy) return false;
    // RLS on gm_strategy authorizes by user_id (account) or username
    // (legacy). Without a session token we'd hit the anon client and get
    // 401 every time — skip silently and let localStorage stay authoritative.
    if (!token) return false;
    try {
        await ensureUser(owner.username);
        const { error } = await db.from('gm_strategy').upsert({
            ...ownerCols(owner),
            strategy,
            version: strategy.version || 1,
            last_synced_at: strategy.lastSyncedAt || Date.now(),
            last_synced_from: strategy.lastSyncedFrom || 'scout',
        }, { onConflict: ownerConflict(owner, 'username', 'user_id') });
        if (error) {
            if (error.code === '42501' || error.message?.includes('row-level security') || error.code === '401') {
                _strategyDbDisabled = true;
            }
            return false;
        }
        return true;
    } catch {
        _strategyDbDisabled = true;
        return false;
    }
};

// Load the user's strategy row. Returns null if no row exists yet.
window.OD.loadStrategy = async function() {
    if (_strategyDbDisabled) return null;
    const owner    = getOwnerIdentity();
    const token    = getSessionToken();
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity()) return null;
    // Same RLS requirement as saveStrategy — quietly return null for anon
    // users instead of hitting the server and flipping the kill switch.
    if (!token) return null;
    try {
        const { data, error } = await applyOwnerFilter(
            db.from('gm_strategy')
                .select('strategy, version, last_synced_at, last_synced_from, updated_at'),
            owner
        )
            .maybeSingle();
        if (error) {
            console.warn('[FW] gm_strategy load error:', error.message || error.code || JSON.stringify(error));
            // Kill switch — any error disables further attempts this session.
            // Expected cases: migration not yet run (42P01 relation does not
            // exist), RLS denial, auth expired, network. localStorage remains
            // the authoritative source either way.
            _strategyDbDisabled = true;
            return null;
        }
        if (!data) return null;
        return {
            strategy: data.strategy,
            version: data.version || 0,
            lastSyncedAt: data.last_synced_at,
            lastSyncedFrom: data.last_synced_from,
        };
    } catch (e) {
        console.warn('[FW] gm_strategy load failed:', e?.message || e);
        _strategyDbDisabled = true;
        return null;
    }
};

// ══════════════════════════════════════════════════════════════════
// LEAGUE DOCS — Commissioner document upload + AI context
// ══════════════════════════════════════════════════════════════════

/**
 * Upload a text document, chunk it, and store in league_docs table.
 * @param {string} leagueId
 * @param {string} docName - filename or title
 * @param {string} text - full document text
 * @param {string} category - 'bylaws'|'awards'|'calendar'|'scoring'|'general'
 */
window.OD.uploadLeagueDoc = async function(leagueId, docName, text, category) {
    const owner = getOwnerIdentity();
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity()) return false;
    try {
        await ensureUser(owner.username);
        // Chunk text into ~500 token (~2000 char) segments
        const CHUNK_SIZE = 2000;
        const chunks = [];
        for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            chunks.push(text.slice(i, i + CHUNK_SIZE));
        }
        // Delete existing chunks for this doc
        await db.from('league_docs').delete().match({ ...ownerCols(owner), league_id: leagueId, doc_name: docName });
        // Insert new chunks
        const rows = chunks.map((chunk, idx) => ({
            ...ownerCols(owner), league_id: leagueId, doc_name: docName,
            doc_type: 'text', chunk_idx: idx, chunk_text: chunk,
            category: category || 'general',
        }));
        const { error } = await db.from('league_docs').insert(rows);
        if (error) { console.warn('[FW] league_docs upload error:', error); return false; }
        return true;
    } catch (e) { console.warn('[FW] league_docs upload failed:', e); return false; }
};

/**
 * Fetch all doc chunks for a league, optionally filtered by category.
 * Returns concatenated text suitable for AI context injection.
 */
window.OD.getLeagueDocsContext = async function(leagueId, category) {
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity()) return '';
    try {
        let query = db.from('league_docs')
            .select('doc_name, chunk_idx, chunk_text, category')
            .eq('league_id', leagueId)
            .order('doc_name').order('chunk_idx');
        if (category) query = query.eq('category', category);
        const { data, error } = await query;
        if (error || !data?.length) return '';
        // Group by doc and reassemble
        const docs = {};
        data.forEach(row => {
            if (!docs[row.doc_name]) docs[row.doc_name] = { name: row.doc_name, category: row.category, chunks: [] };
            docs[row.doc_name].chunks.push(row.chunk_text);
        });
        return Object.values(docs).map(d =>
            `[${d.category.toUpperCase()}: ${d.name}]\n${d.chunks.join('')}`
        ).join('\n\n---\n\n');
    } catch (e) { console.warn('[FW] league_docs fetch failed:', e); return ''; }
};

/**
 * List all uploaded docs for a league (name + category, no content).
 */
window.OD.listLeagueDocs = async function(leagueId) {
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity()) return [];
    try {
        const { data, error } = await db.from('league_docs')
            .select('doc_name, category, created_at')
            .eq('league_id', leagueId)
            .eq('chunk_idx', 0) // only first chunk per doc
            .order('created_at', { ascending: false });
        if (error) return [];
        return (data || []).map(d => ({ name: d.doc_name, category: d.category, uploadedAt: d.created_at }));
    } catch { return []; }
};

/**
 * Delete all chunks for a specific doc.
 */
window.OD.deleteLeagueDoc = async function(leagueId, docName) {
    const owner = getOwnerIdentity();
    const db = getClient();
    if (!db || !isConfigured() || !hasOwnerIdentity()) return false;
    try {
        const { error } = await db.from('league_docs').delete().match({ ...ownerCols(owner), league_id: leagueId, doc_name: docName });
        return !error;
    } catch { return false; }
};

// ══════════════════════════════════════════════════════════════════
// PRODUCT ANALYTICS — behavior events, batched and privacy-light
// ══════════════════════════════════════════════════════════════════
const ANALYTICS_QUEUE_KEY = 'od_analytics_queue_v1';
const ANALYTICS_SESSION_KEY = 'od_analytics_session_v1';
let _analyticsFlushTimer = null;
let _analyticsInFlight = false;

function analyticsSessionId() {
    try {
        let sid = sessionStorage.getItem(ANALYTICS_SESSION_KEY);
        if (!sid) {
            sid = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
            sessionStorage.setItem(ANALYTICS_SESSION_KEY, sid);
        }
        return sid;
    } catch {
        return 'sess_' + Date.now().toString(36);
    }
}

function loadAnalyticsQueue() {
    try {
        const raw = localStorage.getItem(ANALYTICS_QUEUE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

function saveAnalyticsQueue(queue) {
    try { localStorage.setItem(ANALYTICS_QUEUE_KEY, JSON.stringify(queue.slice(-250))); } catch {}
}

function safeAnalyticsMeta(meta) {
    const out = {};
    Object.entries(meta || {}).forEach(([key, value]) => {
        if (/prompt|message|body|text|doc|content/i.test(key)) return;
        if (value == null) return;
        if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
        else if (Array.isArray(value)) out[key] = value.slice(0, 10).map(v => ['string', 'number', 'boolean'].includes(typeof v) ? v : String(v).slice(0, 80));
        else out[key] = JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'string' ? v.slice(0, 120) : v));
    });
    return out;
}

function inferPlatform(payload) {
    if (payload?.platform) return payload.platform;
    if (location.pathname.includes('warroom') || document.getElementById('root')) return 'warroom';
    return 'reconai';
}

function currentAnalyticsModule() {
    return window.S?.activeTab || window.App?.activeTab || document.querySelector('.panel.active')?.id || null;
}

function safeAnalyticsRoute() {
    return (window.location.pathname || '/').replace(/[?#].*$/, '') || '/';
}

function describeAnalyticsTarget(el) {
    if (!el) return {};
    const className = typeof el.className === 'string' ? el.className : '';
    return {
        tag: el.tagName ? el.tagName.toLowerCase() : '',
        id: el.id || null,
        role: el.getAttribute?.('role') || null,
        track: el.dataset?.track || null,
        aria: el.getAttribute?.('aria-label') || null,
        title: el.getAttribute?.('title') || null,
        classes: className ? className.split(/\s+/).filter(Boolean).slice(0, 4) : [],
    };
}

function normalizeQueuedAnalyticsEvent(evt, username) {
    const eventId = evt?.event_id || 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    const eventName = evt?.event_name || evt?.eventName || evt?.name || 'unknown_event';
    const sessionId = evt?.session_id || evt?.sessionId || analyticsSessionId();
    const duration = Number(evt?.duration_ms ?? evt?.durationMs);
    const entityId = evt?.entity_id ?? evt?.entityId;
    const activeUsername = username || null;
    const rawTs = evt?.event_ts || evt?.eventTs;
    const parsedTs = rawTs != null
        ? (typeof rawTs === 'number' ? new Date(rawTs) : new Date(String(rawTs)))
        : null;
    return {
        event_id: String(eventId),
        username: activeUsername && (!evt?.username || evt.username === activeUsername) ? activeUsername : null,
        user_id: evt?.user_id || null,
        league_id: evt?.league_id || evt?.leagueId || null,
        session_id: String(sessionId),
        platform: evt?.platform || inferPlatform(evt || {}),
        module: evt?.module || null,
        widget: evt?.widget || null,
        event_name: String(eventName),
        event_ts: parsedTs && !Number.isNaN(parsedTs.getTime()) ? parsedTs.toISOString() : new Date().toISOString(),
        duration_ms: Number.isFinite(duration) ? duration : null,
        entity_type: evt?.entity_type || evt?.entityType || null,
        entity_id: entityId != null ? String(entityId) : null,
        metadata: safeAnalyticsMeta(evt?.metadata || {}),
    };
}

function describeDbError(error) {
    if (!error) return 'unknown error';
    if (typeof error === 'string') return error;
    return [
        error.code,
        error.message,
        error.details,
        error.hint,
    ].filter(Boolean).join(' | ') || JSON.stringify(error);
}

window.OD.flushAnalytics = async function() {
    if (_analyticsInFlight) return false;
    const username = getAnalyticsUsername();
    const db = getClient();
    if (!db || !isConfigured()) return false;
    const queue = loadAnalyticsQueue();
    if (!queue.length) return true;
    _analyticsInFlight = true;
    try {
        const batch = queue.slice(0, 25).map(evt => normalizeQueuedAnalyticsEvent(evt, username));
        const { error } = await db.from('analytics_events').insert(batch);
        if (error?.code === '23505') {
            const keep = [];
            for (let i = 0; i < batch.length; i++) {
                const { error: rowError } = await db.from('analytics_events').insert(batch[i]);
                if (rowError && rowError.code !== '23505') keep.push(queue[i]);
            }
            saveAnalyticsQueue(keep.concat(queue.slice(batch.length)));
            return keep.length === 0;
        }
        if (error) throw error;
        saveAnalyticsQueue(queue.slice(batch.length));
        return true;
    } catch (e) {
        console.warn('[FW] analytics flush error', describeDbError(e));
        return false;
    } finally {
        _analyticsInFlight = false;
    }
};

window.OD.track = function(eventName, payload = {}) {
    if (!eventName) return;
    try {
        const event = {
            event_id: 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10),
            username: getAnalyticsUsername(),
            user_id: getCurrentUserId(),
            league_id: payload.leagueId || payload.league_id || window.S?.currentLeagueId || null,
            session_id: analyticsSessionId(),
            platform: inferPlatform(payload),
            module: payload.module || payload.tab || currentAnalyticsModule(),
            widget: payload.widget || null,
            event_name: eventName,
            event_ts: new Date().toISOString(),
            duration_ms: Number.isFinite(Number(payload.durationMs)) ? Number(payload.durationMs) : null,
            entity_type: payload.entityType || null,
            entity_id: payload.entityId != null ? String(payload.entityId) : null,
            metadata: safeAnalyticsMeta({
                route: safeAnalyticsRoute(),
                ...payload.metadata,
            }),
        };
        const queue = loadAnalyticsQueue();
        queue.push(event);
        saveAnalyticsQueue(queue);
        if (queue.length >= 10) window.OD.flushAnalytics();
        else {
            clearTimeout(_analyticsFlushTimer);
            _analyticsFlushTimer = setTimeout(() => window.OD.flushAnalytics(), 15000);
        }
    } catch (e) {
        console.warn('[FW] analytics track error', e);
    }
};

window.OD.trackFunnelStep = function(step, payload = {}) {
    window.OD.track(String(step || '').trim(), {
        ...payload,
        module: payload.module || 'launch_funnel',
        entityType: payload.entityType || 'funnel',
        entityId: payload.entityId || step,
        metadata: {
            step,
            product: payload.product || payload.productSlug || null,
            outcome: payload.outcome || null,
            ...payload.metadata,
        },
    });
};

window.OD.trackFeatureGate = function(feature, payload = {}) {
    window.OD.track('feature_gate_shown', {
        ...payload,
        entityType: payload.entityType || 'feature',
        entityId: payload.entityId || feature,
        metadata: {
            feature,
            requiredTier: payload.requiredTier || payload.targetTier || null,
            currentTier: payload.currentTier || (typeof window.getTier === 'function' ? window.getTier() : null),
            ...payload.metadata,
        },
    });
};

window.OD.trackClientError = function(payload = {}) {
    window.OD.track('client_error', {
        platform: payload.platform,
        module: payload.module || currentAnalyticsModule(),
        entityType: 'error',
        entityId: payload.sentryEventId || payload.source || null,
        metadata: {
            source: payload.source || 'unknown',
            errorName: payload.errorName || 'Error',
            sentryEventId: payload.sentryEventId || null,
            handled: payload.handled !== false,
            ...payload.metadata,
        },
    });
};

window.OD.trackWidgetClick = function(widget, payload = {}) {
    window.OD.track('widget_clicked', {
        ...payload,
        widget,
        entityType: payload.entityType || 'widget',
        entityId: payload.entityId || widget,
    });
};

window.OD.trackPlayerModal = function(pid, payload = {}) {
    window.OD.track('player_modal_opened', {
        ...payload,
        entityType: 'player',
        entityId: pid,
    });
};

window.OD.trackTradeStarted = function(payload = {}) {
    window.OD.track('trade_started', {
        ...payload,
        entityType: payload.entityType || 'trade',
        entityId: payload.entityId || null,
    });
};

window.OD.trackTradeEvaluated = function(payload = {}) {
    window.OD.track('trade_evaluated', {
        ...payload,
        entityType: payload.entityType || 'trade',
        entityId: payload.entityId || null,
    });
};

window.OD.trackWaiverTargetSaved = function(pid, payload = {}) {
    window.OD.track('waiver_target_saved', {
        ...payload,
        entityType: 'player',
        entityId: pid,
    });
};

window.OD.trackDraftPlayerExpanded = function(pid, payload = {}) {
    window.OD.track('draft_player_expanded', {
        ...payload,
        entityType: 'player',
        entityId: pid,
    });
};

let _analyticsModuleDwell = {
    module: currentAnalyticsModule(),
    startedAt: Date.now(),
};

function flushModuleDwell(reason = 'change') {
    const now = Date.now();
    const durationMs = now - _analyticsModuleDwell.startedAt;
    if (_analyticsModuleDwell.module && durationMs >= 1000) {
        window.OD.track('module_dwell', {
            module: _analyticsModuleDwell.module,
            durationMs,
            metadata: { reason },
        });
    }
    _analyticsModuleDwell = { module: currentAnalyticsModule(), startedAt: now };
}

setInterval(() => {
    const current = currentAnalyticsModule();
    if (current !== _analyticsModuleDwell.module) flushModuleDwell('module_change');
}, 5000);

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        flushModuleDwell('visibility_hidden');
        window.OD.flushAnalytics();
    }
});
window.addEventListener('pagehide', () => {
    flushModuleDwell('pagehide');
    window.OD.flushAnalytics();
});

document.addEventListener('click', evt => {
    const target = evt.target?.closest?.('[data-track],button,a,[role="button"],.nav-item,.mnav-btn,.tab-btn,.widget-card,.wr-widget,[data-widget]');
    if (!target) return;
    const descriptor = describeAnalyticsTarget(target);
    window.OD.track('ui_clicked', {
        module: currentAnalyticsModule(),
        widget: descriptor.track || descriptor.id || descriptor.role || descriptor.tag,
        metadata: descriptor,
    });
    const widget = target.closest?.('[data-widget],.wr-widget,.widget-card');
    if (widget) {
        const widgetName = widget.dataset?.widget || widget.dataset?.track || widget.id || descriptor.track || 'widget';
        window.OD.trackWidgetClick(widgetName, {
            module: currentAnalyticsModule(),
            metadata: {
                ...descriptor,
                widgetClass: typeof widget.className === 'string' ? widget.className.split(/\s+/).slice(0, 4) : [],
            },
        });
    }
}, { capture: true });

setTimeout(() => {
    window.OD.track('app_loaded', {
        module: currentAnalyticsModule(),
        metadata: { route: safeAnalyticsRoute() },
    });
}, 0);

let _analyticsHeartbeatAt = Date.now();
setInterval(() => {
    const now = Date.now();
    const durationMs = now - _analyticsHeartbeatAt;
    _analyticsHeartbeatAt = now;
    if (document.visibilityState !== 'visible') return;
    window.OD.track('session_heartbeat', {
        module: currentAnalyticsModule(),
        durationMs,
        metadata: { visible: true },
    });
}, 60000);

// ══════════════════════════════════════════════════════════════════
// OAUTH SIGN-IN — Google & Apple
// Providers must be enabled in Supabase Dashboard:
//   Settings → Authentication → Providers
//   Google: requires Client ID + Secret from Google Cloud Console
//   Apple:  requires Service ID + Secret Key from Apple Developer Portal
// ══════════════════════════════════════════════════════════════════

// Expose raw Supabase client for OAuth calls (e.g. window.OD.supabase.auth.signInWithOAuth)
Object.defineProperty(window.OD, 'supabase', {
    get() { return getClient(); },
    configurable: true,
    enumerable: true,
});

window.OD.signInWithGoogle = function() {
    const client = getClient();
    if (!client) return;
    return client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + window.location.pathname },
    });
};

window.OD.signInWithApple = function() {
    const client = getClient();
    if (!client) return;
    return client.auth.signInWithOAuth({
        provider: 'apple',
        options: { redirectTo: window.location.origin + window.location.pathname },
    });
};

window.OD.signOut = async function() {
    const client = getClient();
    if (client) await client.auth.signOut().catch(() => {});
    localStorage.removeItem(SESSION_LS_KEY);
    localStorage.removeItem(FW_SESSION_KEY);
    window.location.reload();
};

window.OD.getOAuthSession = async function() {
    const client = getClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data?.session || null;
};

window.OD.getOAuthUser = async function() {
    const client = getClient();
    if (!client) return null;
    const { data } = await client.auth.getUser();
    return data?.user || null;
};

// Expose on App namespace too
window.App.OD = window.OD;
window.App.SUPABASE_URL = SUPABASE_URL;
window.App.SUPABASE_ANON = SUPABASE_ANON;
window.App.BACKEND_ENDPOINTS = BACKEND_ENDPOINTS;

// ── Module global exports (Vite migration) ───────────────────────────────────
window.getSessionToken = getSessionToken;
window.getClient = getClient;
window.isConfigured = isConfigured;
window.getCurrentUsername = getCurrentUsername;
