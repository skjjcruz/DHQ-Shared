// ══════════════════════════════════════════════════════════════════
// shared/identity.js — who the user is on this device (owner-stamped)
//
// Loaded by EVERY page — landing.html, connect-sleeper.html and login.html
// load it on its own (they don't need the rest of the shared client); the
// app shell loads it right before supabase-client.js. Side-effect-free at
// load: it only defines window.OD.identity.
//
// The model (sign-in lifecycle fix, 2026-09-28):
//   • For a signed-in ACCOUNT the server is the source of truth for the
//     Sleeper handle (app_users.platform_usernames.sleeper via fw-profile).
//   • The device holds a cache of the identity (handle, ESPN/MFL league
//     pointers, display name, club) stamped with its owner in
//     dhq_identity_owner_v1 = 'account:<app_user_id>' | 'legacy:<handle>' |
//     'guest'.
//   • reconcileAfterSignIn() runs after EVERY successful sign-in: a
//     different owner's cache is cleared, the new owner is stamped, and the
//     server handle wins; a handle only this device knew is uploaded.
//   • Sign-out (signOutClear) removes credentials only. The owner stamp
//     makes the kept cache safe: the next sign-in by someone else clears it.
//   • Gates never destroy the identity cache (a token is a credential; a
//     Sleeper handle is not).
//
// Server shape (fw-profile GET, and — once deployed — the fw-signin /
// fw-oauth-sync / fw-refresh-session responses as `platformUsernames`):
//   { sleeper?, sleeperUserId?, espn?: [{leagueId,year,teamId}],
//     mfl?: [{leagueId,year,franchiseId}] }   ({} none on file, null unknown)
// fw-profile POST merges; espn/mfl are complete lists (≤10, [] clears), so
// this module only ever sends the server's list plus this device's league,
// never a bare local list and never []. Pointers only — never espn_s2, SWID
// or an MFL API key. An older fw-profile keeps only `sleeper` and ignores the
// rest, so sending the pointers early is harmless.

// ══════════════════════════════════════════════════════════════════
(function (root) {
    'use strict';
    root.OD = root.OD || {};
    if (root.OD.identity && root.OD.identity.version >= 1) return;

    var OWNER_KEY = 'dhq_identity_owner_v1';
    var FW_SESSION_KEY = 'fw_session_v1';
    var LEGACY_SESSION_KEY = 'od_session_v1';
    var GUEST_KEY = 'wr_guest_v1';
    var AUTH_KEY = 'od_auth_v1';
    var PROFILE_KEY = 'od_profile_v1';
    var LOCKED_KEY = 'od_locked_username_v2';
    var CREDENTIAL_OWNER_KEY = 'dhq_credentials_owner_v1';
    var DEFAULT_SUPABASE_URL = 'https://sxshiqyxhhifvtfqawbq.supabase.co';
    var DEFAULT_SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN4c2hpcXl4aGhpZnZ0ZnFhd2JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MTExMzAsImV4cCI6MjA4ODI4NzEzMH0.zJi9W986ZLaANiZN6pt6ReFwaQU6yPeidsERIWo2ibI';

    // The identity cache: who this device's user is, never a credential.
    // Cleared only when a DIFFERENT owner signs in (or a new account starts
    // on a used device). Same list resetDeviceOnboardingForNewAccount used on
    // landing.html, plus the presentation keys and the guest flag.
    var DEVICE_IDENTITY_KEYS = [
        AUTH_KEY, PROFILE_KEY, LOCKED_KEY,
        'dynastyhq_username',                          // Scout's handle (same origin as the native app)
        'od_display_name', 'od_avatar_emoji', 'dhq_owner_club_v1',
        'mfl_league_id', 'mfl_year', 'mfl_franchise_id',
        'espn_league_id', 'espn_year', 'espn_team_id',
        GUEST_KEY,
    ];
    // Per-league connector records (league pointers + team; secrets are
    // stripped by the connectors). Keyed by league, so a clean prefix sweep.
    var DEVICE_IDENTITY_PREFIXES = ['espn_creds_', 'mfl_creds_'];

    // Platform logins + personal AI keys. Keep in lockstep with
    // DEVICE_SECRET_KEYS in supabase-client.js (a test pins it).
    var DEVICE_SECRET_KEYS = [
        'espn_s2', 'espn_swid',
        'mfl_api_key',
        'mfl_write_cookie', 'mfl_write_host',
        'yahoo_session_id',
        'dynastyhq_ai_key', 'dynastyhq_xai_key', 'dynastyhq_gemini_key',
        'dynastyhq_anthropic_key', 'dynastyhq_apikey',
        'dynastyhq_ai_provider', 'dynastyhq_ai_model',
    ];
    // What sign-out removes (besides the secrets and sb-*-auth-token*).
    var CREDENTIAL_KEYS = [FW_SESSION_KEY, LEGACY_SESSION_KEY, GUEST_KEY, CREDENTIAL_OWNER_KEY];

    // ── storage helpers (every access guarded: private mode / blocked) ──
    function ls() { try { return root.localStorage || null; } catch (e) { return null; } }
    function ss() { try { return root.sessionStorage || null; } catch (e) { return null; } }
    function get(key) { try { var s = ls(); return s ? s.getItem(key) : null; } catch (e) { return null; } }
    function set(key, value) { try { var s = ls(); if (s) s.setItem(key, value); } catch (e) {} }
    function del(key) { try { var s = ls(); if (s) s.removeItem(key); } catch (e) {} }
    function readJSON(key) { try { var raw = get(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
    function keysOf(store) {
        var out = [];
        try { for (var i = 0; i < store.length; i++) { var k = store.key(i); if (k) out.push(k); } } catch (e) {}
        return out;
    }

    function config() {
        var cfg = (root.App && root.App.CONFIG) || (root.OD && root.OD.CONFIG) || {};
        var url = cfg.supabaseUrl || DEFAULT_SUPABASE_URL;
        return {
            url: url,
            anon: cfg.supabaseAnon || DEFAULT_SUPABASE_ANON,
            fwProfile: (cfg.endpoints && cfg.endpoints.fwProfile) || (url + '/functions/v1/fw-profile'),
        };
    }

    // ── JWT (decode only — never trusted, only to tell sessions apart) ──
    function jwtClaims(token) {
        try {
            var part = String(token || '').split('.')[1];
            if (!part) return null;
            var b64 = part.replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            var bin = root.atob(b64);
            var json = bin;
            try { json = decodeURIComponent(bin.split('').map(function (c) { return '%' + c.charCodeAt(0).toString(16).padStart(2, '0'); }).join('')); } catch (e) {}
            var claims = JSON.parse(json);
            return claims && typeof claims === 'object' ? claims : null;
        } catch (e) { return null; }
    }
    function jwtExpired(token) {
        var c = jwtClaims(token);
        return !!(c && typeof c.exp === 'number' && Date.now() >= c.exp * 1000 - 30 * 1000);
    }

    // ── handles (od_auth_v1 has two shapes: {username} and {sleeperUsername}) ──
    function clean(h) { return typeof h === 'string' && h.trim() ? h.trim() : null; }
    function handleOf(auth) {
        if (!auth || typeof auth !== 'object') return null;
        return clean(auth.sleeperUsername) || clean(auth.username);
    }
    function same(a, b) { return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase(); }
    // The handle this device holds: od_auth_v1 (either shape), then the
    // connect page's profile copy.
    function localHandle() {
        var h = handleOf(readJSON(AUTH_KEY));
        if (h) return h;
        var prof = readJSON(PROFILE_KEY);
        return (prof && clean(prof.sleeperUsername)) || null;
    }
    // Any league source bound on this device (Sleeper handle, MFL or ESPN
    // league) or an explicit completed-onboarding flag.
    function localOnboarded() {
        if (localHandle()) return true;
        var prof = readJSON(PROFILE_KEY);
        if (prof && prof.onboardingComplete === true) return true;
        return !!(get('mfl_league_id') || get('espn_league_id'));
    }
    // A league source actually bound (no flag): what routing trusts after a
    // reconcile, so a stale onboardingComplete never skips the connect page.
    function hasLeagueSource() {
        return !!(localHandle() || get('mfl_league_id') || get('espn_league_id'));
    }

    // Write the handle where every reader looks, in BOTH od_auth_v1 shapes.
    // A different previous handle's extras (sleeperUserId, a legacy local
    // password hash) are dropped, never carried onto the new handle.
    function writeHandle(handle, extra) {
        handle = clean(handle);
        if (!handle) return null;
        var prev = readJSON(AUTH_KEY);
        if (!prev || typeof prev !== 'object' || (handleOf(prev) && !same(handleOf(prev), handle))) prev = {};
        var next = Object.assign({}, prev, extra || {}, { username: handle, sleeperUsername: handle });
        set(AUTH_KEY, JSON.stringify(next));
        var prof = readJSON(PROFILE_KEY);
        if (!prof || typeof prof !== 'object') prof = {};
        if (prof.sleeperUsername && !same(prof.sleeperUsername, handle)) delete prof.sleeperUserId;
        prof.sleeperUsername = handle;
        if (extra && extra.sleeperUserId) prof.sleeperUserId = extra.sleeperUserId;
        prof.onboardingComplete = true;
        set(PROFILE_KEY, JSON.stringify(prof));
        set(LOCKED_KEY, handle);
        return handle;
    }

    // ── owners ──
    function currentSession() {
        var s = readJSON(FW_SESSION_KEY);
        return s && s.token ? s : null;
    }
    // 'account:<id>' | 'legacy:<handle lowercased>' | null
    function sessionOwner(session) {
        if (!session || !session.token) return null;
        var claims = jwtClaims(session.token) || {};
        var meta = claims.app_metadata || {};
        if (meta.user_id) return 'account:' + meta.user_id;
        if (typeof meta.sleeper_username === 'string' && meta.sleeper_username) return 'legacy:' + meta.sleeper_username.toLowerCase();
        if (session.user && session.user.id) return 'account:' + session.user.id;
        if (session.user && clean(session.user.sleeperUsername)) return 'legacy:' + session.user.sleeperUsername.trim().toLowerCase();
        return null;
    }
    function legacyHandleOf(session) {
        var meta = ((jwtClaims(session && session.token) || {}).app_metadata) || {};
        return clean(meta.sleeper_username) || clean(session && session.user && session.user.sleeperUsername);
    }
    // Who is using this device right now: the session's owner, 'guest' in the
    // guest lane, else null (signed out).
    function currentOwner() {
        var o = sessionOwner(currentSession());
        if (o) return o;
        return get(GUEST_KEY) === '1' ? 'guest' : null;
    }
    function getStamp() { return get(OWNER_KEY) || null; }
    function setStamp(owner) { if (owner) set(OWNER_KEY, owner); }
    // True when the identity cache on this device belongs to the current
    // session's owner. No stamp = a device from before stamping: trusted
    // (first-run migration), matching what the app did before.
    function cacheIsMine() {
        var stamp = getStamp();
        if (!stamp) return true;
        return stamp === currentOwner();
    }
    // A usable app-account token (not legacy, not expired) or null.
    function accountToken(session) {
        var s = session || currentSession();
        if (!s || !s.token) return null;
        var o = sessionOwner(s);
        if (!o || o.indexOf('account:') !== 0) return null;
        if (jwtExpired(s.token)) return null;
        return s.token;
    }

    function clearDeviceIdentity() {
        DEVICE_IDENTITY_KEYS.forEach(del);
        var stores = [ls(), ss()].filter(Boolean);
        stores.forEach(function (store) {
            keysOf(store).forEach(function (k) {
                if (DEVICE_IDENTITY_PREFIXES.some(function (p) { return k.indexOf(p) === 0; })) {
                    try { store.removeItem(k); } catch (e) {}
                }
            });
            // Another person's platform logins go with their identity.
            DEVICE_SECRET_KEYS.forEach(function (k) { try { store.removeItem(k); } catch (e) {} });
        });
    }

    // The guest lane. A device whose cache belongs to someone else is
    // cleared first, so a guest never inherits an account's leagues.
    function beginGuest() {
        var stamp = getStamp();
        if (stamp && stamp !== 'guest') clearDeviceIdentity();
        setStamp('guest');
        set(GUEST_KEY, '1');
    }

    // ── server (fw-profile) ──
    function withTimeout(promise, ms, fallback) {
        var timer = null;
        return Promise.race([
            Promise.resolve(promise).catch(function () { return fallback; }),
            new Promise(function (resolve) { timer = setTimeout(function () { resolve(fallback); }, ms); }),
        ]).then(function (v) { if (timer) clearTimeout(timer); return v; });
    }
    // ── platform pointers (client-side mirror of _shared/platforms.ts) ──
    var MAX_LEAGUES = 10;
    function digits(v, max) {
        if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) v = String(v);
        if (typeof v !== 'string') return null;
        v = v.trim();
        return new RegExp('^\\d{1,' + max + '}$').test(v) ? v : null;
    }
    function yearOf(v) {
        var n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{4}$/.test(v.trim()) ? Number(v.trim()) : NaN);
        var max = new Date().getUTCFullYear() + 1;
        return Number.isInteger(n) && n >= 2000 && n <= max ? n : null;
    }
    function optId(v, max) {
        if (v === undefined || v === null || v === '') return { ok: true, v: null };
        var d = digits(v, max);
        return d === null ? { ok: false } : { ok: true, v: d };
    }
    function espnEntry(e) {
        if (!e || typeof e !== 'object') return null;
        var id = digits(e.leagueId, 12), y = yearOf(e.year), t = optId(e.teamId, 4);
        return id && y !== null && t.ok ? { leagueId: id, year: y, teamId: t.v } : null;
    }
    function mflEntry(e) {
        if (!e || typeof e !== 'object') return null;
        var id = digits(e.leagueId, 10), y = yearOf(e.year), f = optId(e.franchiseId, 4);
        return id && y !== null && f.ok ? { leagueId: id, year: y, franchiseId: f.v === null ? null : f.v.padStart(4, '0') } : null;
    }
    function listOf(raw, parse) {
        return (Array.isArray(raw) ? raw : []).map(parse).filter(Boolean).slice(0, MAX_LEAGUES);
    }
    // Server platforms → {sleeper, sleeperUserId, espn[], mfl[]}; null when
    // the value is not an object (null = "unknown, ask fw-profile").
    function normalizePlatforms(p) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
        var s = p.sleeper;
        var handle = s && typeof s === 'object' ? (clean(s.username) || clean(s.sleeperUsername)) : (clean(s) || clean(p.sleeperUsername));
        var uid = (s && typeof s === 'object' && s.userId) || p.sleeperUserId;
        return {
            sleeper: handle || null,
            sleeperUserId: handle ? digits(uid, 32) : null,
            espn: listOf(p.espn, espnEntry),
            mfl: listOf(p.mfl, mflEntry),
        };
    }
    function serverPlatformsOf(data) {
        if (!data || typeof data !== 'object') return null;
        if (data.platformUsernames !== undefined) return normalizePlatforms(data.platformUsernames);
        if (data.profile && data.profile.platforms) return normalizePlatforms(data.profile.platforms);
        return normalizePlatforms(data.platforms);
    }
    // This device's own league pointers (one per platform), in server shape.
    function localPointers() {
        return {
            espn: espnEntry({ leagueId: get('espn_league_id'), year: get('espn_year') || String(new Date().getUTCFullYear()), teamId: get('espn_team_id') }),
            mfl: mflEntry({ leagueId: get('mfl_league_id'), year: get('mfl_year') || String(new Date().getUTCFullYear()), franchiseId: get('mfl_franchise_id') }),
        };
    }
    function localSleeperUserId() {
        var a = readJSON(AUTH_KEY), p = readJSON(PROFILE_KEY);
        return digits((a && a.sleeperUserId) || (p && p.sleeperUserId) || '', 32);
    }
    var keyOf = function (e) { return e.leagueId + ':' + e.year; };
    // The server's list with this device's league in it (replaced in place
    // when the same league+season is there, else put first); capped.
    function withLocal(list, entry) {
        list = (list || []).slice();
        if (!entry) return list;
        var i = list.findIndex(function (e) { return keyOf(e) === keyOf(entry); });
        if (i >= 0) { list[i] = entry; return list; }
        return [entry].concat(list).slice(0, MAX_LEAGUES);
    }
    function sameList(a, b) { return JSON.stringify(a || []) === JSON.stringify(b || []); }
    // The best server pointer to restore: the latest season, first listed.
    function pick(list) {
        var best = null;
        (list || []).forEach(function (e) { if (!best || e.year > best.year) best = e; });
        return best;
    }
    // Server pointers → the mfl_* / espn_* keys, only where this device has none.
    function restorePointers(P) {
        var restored = [];
        if (!P) return restored;
        if (!get('espn_league_id')) {
            var e = pick(P.espn);
            if (e) {
                set('espn_league_id', e.leagueId); set('espn_year', String(e.year));
                if (e.teamId) set('espn_team_id', e.teamId); else del('espn_team_id');
                restored.push('espn');
            }
        }
        if (!get('mfl_league_id')) {
            var m = pick(P.mfl);
            if (m) {
                set('mfl_league_id', m.leagueId); set('mfl_year', String(m.year));
                if (m.franchiseId) set('mfl_franchise_id', m.franchiseId); else del('mfl_franchise_id');
                restored.push('mfl');
            }
        }
        return restored;
    }
    // What this device knows that the server doesn't: {} when nothing.
    function patchFor(P, handle) {
        P = P || { sleeper: null, espn: [], mfl: [] };
        var patch = {};
        handle = clean(handle);
        if (handle && !same(P.sleeper, handle)) {
            patch.sleeper = handle;
            var uid = localSleeperUserId();
            if (uid) patch.sleeperUserId = uid;
        }
        var lp = localPointers();
        var espn = withLocal(P.espn, lp.espn);
        if (!sameList(espn, P.espn)) patch.espn = espn;
        var mfl = withLocal(P.mfl, lp.mfl);
        if (!sameList(mfl, P.mfl)) patch.mfl = mfl;
        return patch;
    }

    // GET the account's server platforms. {ok, status, platforms}; ok:false
    // on a network error, a timeout (ms, default 6s) or a non-2xx answer.
    function fetchServerPlatforms(token, ms) {
        if (!token || typeof root.fetch !== 'function') return Promise.resolve({ ok: false, status: 0, platforms: null });
        var cfg = config();
        var ctrl = typeof root.AbortController === 'function' ? new root.AbortController() : null;
        var req = root.fetch(cfg.fwProfile, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token, 'apikey': cfg.anon },
            signal: ctrl ? ctrl.signal : undefined,
        }).then(function (resp) {
            if (!resp.ok) return { ok: false, status: resp.status, platforms: null };
            return resp.json().then(function (data) {
                return { ok: true, status: resp.status, platforms: serverPlatformsOf(data) || normalizePlatforms({}) };
            }, function () { return { ok: false, status: resp.status, platforms: null }; });
        });
        return withTimeout(req, ms || 6000, { ok: false, status: 0, platforms: null, timedOut: true })
            .then(function (r) { if (r && r.timedOut && ctrl) { try { ctrl.abort(); } catch (e) {} } return r; });
    }
    function fetchServerHandle(token, ms) {
        return fetchServerPlatforms(token, ms).then(function (r) {
            return { ok: r.ok, status: r.status, handle: r.platforms ? r.platforms.sleeper : null };
        });
    }
    // POST a platforms patch (merge on the server). keepalive, so a
    // navigation or reload right after cannot cancel it (the hub's reload
    // used to). Resolves true/false; never rejects. Callers that navigate
    // await it through settle(p, ms).
    function savePlatforms(token, patch) {
        if (!token || !patch || !Object.keys(patch).length || typeof root.fetch !== 'function') return Promise.resolve(false);
        var cfg = config();
        try {
            return root.fetch(cfg.fwProfile, {
                method: 'POST',
                keepalive: true,
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'apikey': cfg.anon },
                body: JSON.stringify({ platformUsernames: patch }),
            }).then(function (r) { return !!(r && r.ok); }, function () { return false; });
        } catch (e) { return Promise.resolve(false); }
    }
    function saveServerHandle(token, handle) {
        handle = clean(handle);
        return handle ? savePlatforms(token, { sleeper: handle }) : Promise.resolve(false);
    }
    // After a connect (connect page, hub): record this device's handle and
    // league pointers on the signed-in account. Reads the server list first so
    // a league connected on another device is kept (espn/mfl are complete
    // lists); if that read fails only the handle is sent. No account → false.
    function pushIdentity(opts) {
        opts = opts || {};
        var token = accountToken();
        if (!token) return Promise.resolve(false);
        var handle = localHandle();
        return fetchServerPlatforms(token, opts.timeoutMs || 3000).then(function (r) {
            var patch = r.ok ? patchFor(r.platforms, handle) : (handle ? { sleeper: handle } : {});
            if (!r.ok && handle) { var uid = localSleeperUserId(); if (uid) patch.sleeperUserId = uid; }
            if (!Object.keys(patch).length) return true;
            return savePlatforms(token, patch);
        });
    }
    function settle(promise, ms) { return withTimeout(promise, ms || 4000, false); }

    // ── the reconcile ─────────────────────────────────────────────
    // Call after EVERY successful sign-in (email, Google/Apple, handoff,
    // repaired session, legacy login, new account) and at app boot when the
    // stamp doesn't match the session. `session` defaults to fw_session_v1.
    // opts.isNew: the account was just created. opts.timeoutMs: server read.
    // Resolves (never rejects) to
    //   { owner, handle, source: 'server'|'local'|'offline'|'legacy'|'none',
    //     onboarded, cleared, uploaded }
    // Route on `onboarded` (a league source is bound), never on a stale
    // onboardingComplete another owner left behind.
    function reconcileAfterSignIn(session, opts) {
        opts = opts || {};
        var s = session || currentSession();
        var owner = sessionOwner(s);
        var result = { owner: owner, handle: null, source: 'none', onboarded: false, cleared: false, uploaded: false };
        if (!owner) {
            result.handle = localHandle();
            result.onboarded = hasLeagueSource();
            return Promise.resolve(result);
        }
        var prior = getStamp();
        var fromGuest = prior === 'guest' || (!prior && get(GUEST_KEY) === '1');
        var credOwner = null;
        try { credOwner = (ss() && ss().getItem(CREDENTIAL_OWNER_KEY)) || null; } catch (e) {}
        if (credOwner && !/^(account|legacy):/.test(credOwner)) credOwner = null;
        var mine;
        if (prior === owner) mine = true;
        else if (fromGuest) mine = true;                          // a guest adopting their leagues
        else if (!prior) mine = !(credOwner && credOwner !== owner); // first run on this build
        else mine = false;                                        // someone else's cache
        if (opts.isNew && !fromGuest) mine = false;               // a new account starts clean
        if (!mine) { clearDeviceIdentity(); result.cleared = true; }
        del(GUEST_KEY);
        setStamp(owner);

        if (owner.indexOf('legacy:') === 0) {
            var lh = legacyHandleOf(s);
            result.handle = writeHandle(lh);
            result.source = 'legacy';
            result.onboarded = hasLeagueSource();
            return Promise.resolve(result);
        }

        var token = s.token;
        // A sign-in response that already carries the account's platforms
        // (fw-signin / fw-oauth-sync / fw-refresh-session) saves the GET.
        // Only for a session handed in by the caller — a copy sitting in
        // storage could be stale. Absent or null → ask fw-profile.
        var embedded = session && session.platformUsernames !== undefined ? normalizePlatforms(session.platformUsernames) : null;
        var read = embedded
            ? Promise.resolve({ ok: true, status: 200, platforms: embedded })
            : fetchServerPlatforms(token, opts.timeoutMs || 6000);
        return read.then(function (server) {
            var local = localHandle();
            if (!server.ok) {
                // Server unreachable: this owner's device copy stands in.
                result.handle = local ? writeHandle(local) : null;
                result.source = local ? 'offline' : 'none';
                result.onboarded = hasLeagueSource();
                return result;
            }
            var P = server.platforms || normalizePlatforms({});
            if (P.sleeper) {
                // Server wins. A guest's own handle that disagrees with the
                // account they signed in to was the guest's, not the account's.
                if (fromGuest && !opts.isNew && local && !same(local, P.sleeper)) {
                    clearDeviceIdentity(); result.cleared = true;
                    setStamp(owner);
                }
                result.handle = writeHandle(P.sleeper, P.sleeperUserId ? { sleeperUserId: P.sleeperUserId } : null);
                result.source = 'server';
            } else if (local) {
                result.handle = writeHandle(local);
                result.source = 'local';
            }
            result.restored = restorePointers(P);
            // What only this device knows (it is this owner's — same stamp,
            // first run, or an adopted guest): upload it.
            var patch = patchFor(P, result.handle);
            result.onboarded = hasLeagueSource();
            if (!Object.keys(patch).length) return result;
            result.uploaded = true;
            result.patch = patch;
            return settle(savePlatforms(token, patch), 3000).then(function () { return result; });
        }).catch(function () {
            result.handle = localHandle();
            result.onboarded = hasLeagueSource();
            return result;
        });
    }

    // ── the one sign-out clear ────────────────────────────────────
    // Removes credentials: both session tokens, the guest flag, the device-
    // owner marker, the Supabase Google/Apple session and the platform
    // logins + personal AI keys. KEEPS the owner-stamped identity cache (the
    // stamp makes it safe: someone else's next sign-in clears it).
    function supabaseAuthKeys(store) {
        var ref = '';
        try { ref = config().url.replace(/^https?:\/\//, '').split('.')[0]; } catch (e) {}
        var fixed = ref ? ['sb-' + ref + '-auth-token', 'sb-' + ref + '-auth-token-code-verifier', 'sb-' + ref + '-auth-token-user'] : [];
        var swept = keysOf(store).filter(function (k) { return /^sb-.+-auth-token/.test(k); });
        return fixed.concat(swept);
    }
    function clearCredentials() {
        [ls(), ss()].filter(Boolean).forEach(function (store) {
            CREDENTIAL_KEYS.concat(DEVICE_SECRET_KEYS).concat(supabaseAuthKeys(store)).forEach(function (k) {
                try { store.removeItem(k); } catch (e) {}
            });
            // Per-league connector records keep their pointers; strip any
            // secret an older build embedded.
            keysOf(store).forEach(function (k) {
                if (!/^(?:espn|mfl)_creds_/.test(k)) return;
                try {
                    var v = JSON.parse(store.getItem(k));
                    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('bad');
                    if (!('apiKey' in v || 'espnS2' in v || 'swid' in v)) return;
                    delete v.apiKey; delete v.espnS2; delete v.swid;
                    store.setItem(k, JSON.stringify(v));
                } catch (e) { try { store.removeItem(k); } catch (e2) {} }
            });
        });
        try { if (root.S) { delete root.S._mflApiKey; delete root.S.apiKey; } } catch (e) {}
    }
    // RevenueCat identity follows the account, not the device: log it out
    // when the bridge exposes logOut (native app only). Guarded, capped.
    function revenueCatLogOut() {
        try {
            var P = (root.Capacitor && root.Capacitor.Plugins && root.Capacitor.Plugins.Purchases) || root.Purchases || null;
            if (P && typeof P.logOut === 'function') return settle(Promise.resolve().then(function () { return P.logOut(); }), 1500);
        } catch (e) {}
        return Promise.resolve(false);
    }
    // opts.supabase: an existing supabase-js client to sign out of (local
    // scope — never revoke the provider session on the user's other devices).
    function signOutClear(opts) {
        opts = opts || {};
        var steps = [revenueCatLogOut()];
        var client = opts.supabase || null;
        if (client && client.auth && typeof client.auth.signOut === 'function') {
            steps.push(settle(Promise.resolve().then(function () { return client.auth.signOut({ scope: 'local' }); }), 1500));
        }
        // Credentials go now (synchronously), so a caller that navigates
        // without awaiting still leaves nothing signed in behind.
        clearCredentials();
        return Promise.all(steps).then(function () { clearCredentials(); return true; }, function () { clearCredentials(); return true; });
    }

    root.OD.identity = {
        version: 1,
        OWNER_KEY: OWNER_KEY,
        DEVICE_IDENTITY_KEYS: DEVICE_IDENTITY_KEYS.slice(),
        DEVICE_SECRET_KEYS: DEVICE_SECRET_KEYS.slice(),
        CREDENTIAL_KEYS: CREDENTIAL_KEYS.slice(),
        handleOf: handleOf,
        localHandle: localHandle,
        localOnboarded: localOnboarded,
        hasLeagueSource: hasLeagueSource,
        writeHandle: writeHandle,
        sessionOwner: sessionOwner,
        currentSession: currentSession,
        currentOwner: currentOwner,
        getStamp: getStamp,
        setStamp: setStamp,
        cacheIsMine: cacheIsMine,
        accountToken: accountToken,
        clearDeviceIdentity: clearDeviceIdentity,
        beginGuest: beginGuest,
        normalizePlatforms: normalizePlatforms,
        localPointers: localPointers,
        fetchServerPlatforms: fetchServerPlatforms,
        fetchServerHandle: fetchServerHandle,
        savePlatforms: savePlatforms,
        saveServerHandle: saveServerHandle,
        pushIdentity: pushIdentity,
        settle: settle,
        reconcileAfterSignIn: reconcileAfterSignIn,
        clearCredentials: clearCredentials,
        signOutClear: signOutClear,
    };
})(typeof window !== 'undefined' ? window : globalThis);
