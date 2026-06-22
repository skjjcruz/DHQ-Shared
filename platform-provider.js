// ══════════════════════════════════════════════════════════════════
// shared/platform-provider.js — Unified fantasy platform provider
//
// Defines the PlatformProvider interface and the registry that War
// Room + Scout use to load leagues from any supported fantasy platform
// (Sleeper, MFL, ESPN, Yahoo) through a single, normalized API.
//
// Each platform's shared/*-api.js module registers its own provider
// on load via window.App.Platforms.register(). Consumers look up
// providers with window.App.Platforms.getForLeague(league) and call
// provider.hydrate(league, ctx) to get a fully-populated league state.
//
// See /Users/jacobc/.claude/plans/hidden-whistling-octopus.md for the
// full design rationale.
// ══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  window.App = window.App || {};

  // ── Default capability flags (providers override what they support) ──
  const DEFAULT_CAPABILITIES = {
    hasTransactions: false,     // fetches adds/drops/trades/waivers
    hasDrafts: false,           // fetches past draft results
    hasTradedPicks: false,      // fetches future traded picks
    hasMatchups: false,         // fetches weekly matchups
    hasBracket: false,          // fetches playoff bracket
    hasYearChain: false,        // supports multi-year history via previous_league_id
    hasFaab: false,             // structured FAAB bid data
    hasTrending: false,         // trending adds/drops (platform-wide)
    hasPlayerStats: false,      // fantasy stats/projections per player
    requiresOAuth: false,       // needs OAuth handshake
    requiresFranchisePicker: false, // user must pick franchise after connect
  };

  // ── The PlatformProvider interface (documentation only) ─────────────
  // Each provider object must conform to:
  //
  //   {
  //     id: 'sleeper' | 'mfl' | 'espn' | 'yahoo',
  //     displayName: string,
  //     capabilities: { ...DEFAULT_CAPABILITIES, ...overrides },
  //
  //     // Credential management — uniform per-league localStorage schema
  //     saveCredentials(leagueKey, creds),
  //     loadCredentials(leagueKey) → creds | null,
  //     clearCredentials(leagueKey),
  //
  //     // Phase 1: user-initiated connect. Returns:
  //     //   { leagues: [stub], needsFranchisePicker: bool, needsAuth?: bool,
  //     //     authUrl?: string }
  //     async connect(creds),
  //
  //     // Phase 2: called by LeagueDetail after Sleeper player DB loads.
  //     // ctx = { sleeperPlayers, currentWeek, currentSeason }.
  //     // Returns a fully-populated normalized league state:
  //     //   {
  //     //     league: {},         // Sleeper-shaped league settings
  //     //     rosters: [],        // rosters with Sleeper-resolved player IDs
  //     //     leagueUsers: [],    // owners
  //     //     players: {},        // platform-specific extras to merge into S.players
  //     //     transactions: { wK: [] },
  //     //     tradedPicks: [],
  //     //     drafts: [],
  //     //     matchups: [],
  //     //     nflState: {},
  //     //     _extras: {}         // platform-specific enrichment (Sleeper stats, etc.)
  //     //   }
  //     async hydrate(league, ctx),
  //   }
  //
  // Legacy league objects may not have `_platform` — the registry's
  // getForLeague() also sniffs the old `_mfl` / `_espn` / `_yahoo`
  // boolean flags for backwards compat.

  // ── Provider registry ──────────────────────────────────────────
  const _providers = {};

  function register(provider) {
    if (!provider || !provider.id) {
      console.warn('[Platforms] register() called with invalid provider', provider);
      return;
    }
    // Fill in any missing capabilities with defaults
    provider.capabilities = { ...DEFAULT_CAPABILITIES, ...(provider.capabilities || {}) };
    _providers[provider.id] = provider;
  }

  function get(id) {
    return _providers[id] || null;
  }

  function getAll() {
    return Object.values(_providers);
  }

  /**
   * Determine which provider owns a given league object.
   *
   * Checks `league._platform` first (canonical), then falls back to
   * legacy boolean flags (`_mfl`, `_espn`, `_yahoo`). Returns the
   * Sleeper provider if no platform marker is found (native Sleeper
   * leagues don't have one).
   */
  function getForLeague(league) {
    if (!league) return null;
    // Canonical
    if (league._platform && _providers[league._platform]) {
      return _providers[league._platform];
    }
    // Legacy flags
    if (league._mfl && _providers.mfl) return _providers.mfl;
    if (league._espn && _providers.espn) return _providers.espn;
    if (league._yahoo && _providers.yahoo) return _providers.yahoo;
    // Default to Sleeper (native, no marker)
    return _providers.sleeper || null;
  }

  // ── Expose the registry on window.App.Platforms ─────────────────
  window.App.Platforms = {
    register,
    get,
    getAll,
    getForLeague,
    DEFAULT_CAPABILITIES,
    // Back-compat shorthand for callers that want to iterate
    get _providers() { return _providers; },
  };

  // Also expose as a bare global for convenience (matches window.MFL, etc.)
  window.Platforms = window.App.Platforms;

  console.log('[Platforms] Registry initialized');

  // ── Module global exports (Vite migration) ─────────────────────
  window.platformRegister    = register;
  window.platformGet         = get;
  window.platformGetAll      = getAll;
  window.platformGetForLeague = getForLeague;

})();
