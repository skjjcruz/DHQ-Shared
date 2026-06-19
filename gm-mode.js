// ══════════════════════════════════════════════════════════════════
// gm-mode.js — Canonical GM Mode system (Phase 1)
//
// Three first-class presets: Rebuild / Compete / Win Now. Selecting a preset
// auto-bundles every downstream variable (aggression, draftStyle,
// marketPosture, timeline, personality). Custom mode unlocks individual
// sliders in the Strategy Editor.
//
// This module is the single source of truth for mode. It:
//   - Normalizes legacy mode labels from both my-team.js and strategy-editor.js
//   - Bundles preset configurations
//   - Persists to BOTH the GMStrategy CDN store AND the local WrStorage key
//     so existing consumers (my-team panel, strategy editor) both see it
//   - Exposes a descriptor consumable by engines (Alex prompts, trade
//     proposer, CPU draft) via window.WR.GmMode.describe(mode)
//
// Exposes: window.WR.GmMode
// ══════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    const WR_KEYS = window.App && window.App.WR_KEYS;
    const WrStorage = window.App && window.App.WrStorage;

    // ── Canonical presets ─────────────────────────────────────────
    const PRESETS = {
        rebuild: {
            id: 'rebuild',
            label: 'Rebuild',
            badgeColor: 'var(--k-3498db, #3498db)',
            tagline: 'Youth, picks, and patience. Tear it down to build the next dynasty.',
            config: {
                aggression: 'conservative',
                draftStyle: 'accumulate',
                marketPosture: 'sell_high',
                timeline: 'dynasty_long',
                alexPersonality: 'value_hunter',
                targetPositions: [],
                sellPositions: [],
            },
            prompt: 'You are in REBUILD mode: prioritize youth, accumulate picks, sell aging veterans for picks and 24-and-under assets. Decline short-term win-now trades. Push back on panic moves.',
            tradeWeights: { futureYearBias: 1.35, vetPenalty: 0.75, ageCutoff: 27 },
            draftWeights: { bpaBias: 0.85, youthPremium: 1.2, needBias: 0.7 },
        },
        compete: {
            id: 'compete',
            label: 'Compete',
            badgeColor: 'var(--k-d4af37, #d4af37)',
            tagline: 'Build for long-term success while staying competitive.',
            config: {
                aggression: 'medium',
                draftStyle: 'bpa',
                marketPosture: 'hold',
                timeline: '2_3_years',
                alexPersonality: 'balanced',
                targetPositions: [],
                sellPositions: [],
            },
            prompt: 'You are in COMPETE mode: balance present and future. Prioritize players ages 24-27 with 3+ peak years left. Trade aging assets only at peak value. Take the best player available in drafts.',
            tradeWeights: { futureYearBias: 1.0, vetPenalty: 1.0, ageCutoff: 30 },
            draftWeights: { bpaBias: 1.0, youthPremium: 1.0, needBias: 1.0 },
        },
        win_now: {
            id: 'win_now',
            label: 'Win Now',
            badgeColor: 'var(--k-e74c3c, #e74c3c)',
            tagline: 'Championship window is open. Spend everything to win this year.',
            config: {
                aggression: 'aggressive',
                draftStyle: 'consolidate',
                marketPosture: 'buy_low',
                timeline: '1_year',
                alexPersonality: 'aggressive',
                targetPositions: [],
                sellPositions: [],
            },
            prompt: 'You are in WIN NOW mode: trade away future picks and young depth for proven starters. Target immediate upgrades. Accept short-term wins over long-term balance. Push aggressive trades that move the needle in the next 1-2 years.',
            tradeWeights: { futureYearBias: 0.65, vetPenalty: 1.35, ageCutoff: 32 },
            draftWeights: { bpaBias: 0.8, youthPremium: 0.6, needBias: 1.3 },
        },
        custom: {
            id: 'custom',
            label: 'Custom',
            badgeColor: 'var(--k-7c6bf8, #7c6bf8)',
            tagline: 'Hand-tuned — every variable set manually.',
            config: null, // caller keeps existing settings
            prompt: 'You are running a CUSTOM strategy — follow the user-defined aggression, draft style, market posture, and timeline as configured.',
            tradeWeights: { futureYearBias: 1.0, vetPenalty: 1.0, ageCutoff: 30 },
            draftWeights: { bpaBias: 1.0, youthPremium: 1.0, needBias: 1.0 },
        },
    };

    // Map legacy mode strings from existing stores to canonical ids.
    const LEGACY_MAP = {
        'rebuild':           'rebuild',
        'balanced_rebuild':  'rebuild',
        'retool':            'compete',
        'balanced':          'compete',
        'compete':           'compete',
        'contend':           'win_now',
        'win_now':           'win_now',
        'custom':            'custom',
    };

    function normalize(mode) {
        return LEGACY_MAP[mode] || 'compete';
    }

    function getMode(leagueId) {
        // Priority: shared global store (ONLY if it actually exists — see
        // sharedStrategyStoreExists; getStrategy() otherwise returns a default
        // that shadows the per-league value) → per-league WrStorage → default.
        try {
            if (sharedStrategyStoreExists() && window.GMStrategy && typeof window.GMStrategy.getStrategy === 'function') {
                const s = window.GMStrategy.getStrategy(leagueId);
                if (s && s.mode) return normalize(s.mode);
            }
        } catch (e) { /* ignore */ }
        try {
            const keys = (window.App && window.App.WR_KEYS) || WR_KEYS;
            const storage = (window.App && window.App.WrStorage) || WrStorage;
            if (storage && keys && typeof keys.GM_STRATEGY === 'function') {
                const s = storage.get(keys.GM_STRATEGY(leagueId));
                if (s && s.mode) return normalize(s.mode);
            }
        } catch (e) { /* ignore */ }
        return 'compete';
    }

    function describe(mode) {
        const id = normalize(mode);
        const preset = PRESETS[id] || PRESETS.compete;
        return {
            id,
            label: preset.label,
            badgeColor: preset.badgeColor,
            tagline: preset.tagline,
            prompt: preset.prompt,
            tradeWeights: preset.tradeWeights,
            draftWeights: preset.draftWeights,
        };
    }

    function getPreset(mode) {
        return PRESETS[normalize(mode)] || PRESETS.compete;
    }

    // Apply a preset to the canonical strategy object. Persists to both stores.
    function applyPreset(leagueId, mode, extras) {
        const preset = getPreset(mode);
        // Merge preset.config into the existing strategy so user's custom fields
        // (untouchable, sellRules, targetPositions/sellPositions if set) survive.
        let existing = {};
        try {
            if (window.GMStrategy && typeof window.GMStrategy.getStrategy === 'function') {
                existing = window.GMStrategy.getStrategy(leagueId) || {};
            }
        } catch (e) { /* ignore */ }
        const merged = {
            ...existing,
            ...(preset.config || {}),
            ...(extras || {}),
            mode: preset.id,
            lastSyncedFrom: 'warroom',
            leagueId,
        };
        // Persist — best-effort, swallow errors
        try {
            if (window.GMStrategy && typeof window.GMStrategy.saveStrategy === 'function') {
                window.GMStrategy.saveStrategy(merged);
            }
        } catch (e) { /* ignore */ }
        try {
            if (WrStorage && WR_KEYS && typeof WR_KEYS.GM_STRATEGY === 'function') {
                WrStorage.set(WR_KEYS.GM_STRATEGY(leagueId), merged);
            }
        } catch (e) { /* ignore */ }
        window._wrGmStrategy = merged;
        window.dispatchEvent(new CustomEvent('wr:gm-mode-changed', { detail: { mode: preset.id, strategy: merged } }));
        return merged;
    }

    // Subscribe convenience: returns unsubscribe fn
    function onChange(fn) {
        const h = (e) => fn(e.detail);
        window.addEventListener('wr:gm-mode-changed', h);
        return () => window.removeEventListener('wr:gm-mode-changed', h);
    }

    // ══════════════════════════════════════════════════════════════════
    // effects(leagueId) — THE single GM-Strategy resolver.
    //
    // Every surface in the app turns the persisted GM Strategy object into
    // concrete tuning by calling this (or the useGmEffects hook below). It
    // reads ONLY the GM Strategy store — never WR.AlexSettings — so GM
    // Strategy is the single source of truth.
    //
    // GUARDRAIL: the values here (acceptanceFloor, aggression, overpay) drive
    // YOUR acceptance bar / package width / what surfaces / framing. They must
    // NEVER be fed into the OPPONENT's displayed "Likelihood of Acceptance %"
    // (that stays computed from their DNA/posture/value via
    // calcAcceptanceLikelihood). Floor/viability COMPARE against the opponent
    // likelihood; they never edit it.
    // ══════════════════════════════════════════════════════════════════

    // 0..1 package-width / overpay scalar per aggression band (promoted from
    // the constant that used to live inline in trade-calc getDealHqTuning).
    const AGGRESSION_MAP = { conservative: 0.28, medium: 0.52, aggressive: 0.78 };

    // Acceptance-floor anchors per aggression band. Chosen for numeric
    // continuity with the retired Alex "Trade aggression" slider, whose
    // actionableTradeAcceptanceFloor produced ~82/75/55 at slider 15/50/100.
    const AGGR_FLOOR = { conservative: 82, medium: 75, aggressive: 58 };
    // Mode nudges the floor: rebuild is pickier (higher bar), win_now is
    // looser (lower bar, willing to act on thinner deals).
    const MODE_FLOOR_SHIFT = { rebuild: 5, compete: 0, win_now: -5, custom: 0 };

    function clampNum(value, min, max, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    // The one canonical aggression+mode → acceptance-floor map (55..90).
    function acceptanceFloorFor(aggression, mode) {
        const base = AGGR_FLOOR[aggression] != null ? AGGR_FLOOR[aggression] : 75;
        const shift = MODE_FLOOR_SHIFT[normalize(mode)] || 0;
        return clampNum(base + shift, 55, 90, 75);
    }

    // True only when the shared (ReconAI) global strategy store actually has a
    // saved value. GMStrategy.getStrategy() returns a DEFAULT object even when
    // the key is absent, which would otherwise shadow the per-league WrStorage
    // value — so we gate on existence, matching league-detail's loadGmStrategy.
    function sharedStrategyStoreExists() {
        try { return !!localStorage.getItem('dhq_gm_strategy_v1'); } catch (e) { return false; }
    }

    // Resolve the persisted strategy with the SAME precedence league-detail uses
    // for the header/badge: shared global store (only if it exists) → per-league
    // WrStorage → last-active strategy. Reads App fresh (load-order safe).
    function resolveStrategy(leagueId) {
        try {
            if (sharedStrategyStoreExists() && window.GMStrategy && window.GMStrategy.getStrategy) {
                const s = window.GMStrategy.getStrategy(leagueId);
                if (s && typeof s === 'object') return s;
            }
        } catch (e) { /* ignore */ }
        try {
            const keys = (window.App && window.App.WR_KEYS) || WR_KEYS;
            const storage = (window.App && window.App.WrStorage) || WrStorage;
            const key = keys && keys.GM_STRATEGY && keys.GM_STRATEGY(leagueId);
            const s = key && storage && storage.get && storage.get(key);
            if (s && typeof s === 'object') return s;
        } catch (e) { /* ignore */ }
        return window._wrGmStrategy || {};
    }

    function effects(leagueId) {
        const strategy = resolveStrategy(leagueId) || {};
        const mode = normalize(strategy.mode) || getMode(leagueId) || 'compete';
        const preset = getPreset(mode);
        const desc = describe(mode);
        const cfg = (preset && preset.config) || {};
        const aggressionKey = strategy.aggression || cfg.aggression || 'medium';
        const aggression = AGGRESSION_MAP[aggressionKey] != null ? AGGRESSION_MAP[aggressionKey] : 0.52;
        const timeline = strategy.timeline || cfg.timeline || '2_3_years';
        const marketPosture = strategy.marketPosture || cfg.marketPosture || 'hold';
        const toSet = (arr) => new Set((arr || []).map(String));
        // The acceptance floor is an explicit, user-editable GM Strategy field
        // (set via the "Trade Acceptance Floor" control in the GM Strategy editor).
        // When unset, it derives from aggression + mode.
        const explicitFloor = Number(strategy.acceptanceFloor);
        const acceptanceFloor = Number.isFinite(explicitFloor)
            ? clampNum(explicitFloor, 55, 90, 75)
            : acceptanceFloorFor(aggressionKey, mode);
        return {
            strategy,
            mode,
            modeLabel: desc.label,
            badgeColor: desc.badgeColor,
            prompt: desc.prompt,
            aggressionKey,                 // 'conservative' | 'medium' | 'aggressive'
            aggression,                    // 0..1 package-width / overpay scalar
            acceptanceFloor,               // 55..90 (explicit field or aggression-derived)
            maxUserGainPct: 0.14 + aggression * 0.26,
            maxOverpayPct: (timeline === '1_year' || mode === 'win_now') ? 0.20 : mode === 'rebuild' ? 0.07 : 0.12,
            pickHorizon: timeline === '1_year' ? 1 : timeline === 'dynasty_long' ? 3 : 2,
            horizonYears: timeline === '1_year' ? 1 : timeline === 'dynasty_long' ? 7 : 2.5,
            tradeWeights: desc.tradeWeights,
            draftWeights: desc.draftWeights,
            draftStyle: strategy.draftStyle || cfg.draftStyle || 'bpa',
            targetPositions: toSet(strategy.targetPositions),
            sellPositions: toSet(strategy.sellPositions),
            untouchable: toSet(strategy.untouchable || strategy.untouchables),
            sellRules: strategy.sellRules || [],
            faFilters: strategy.faFilters || null,
            marketPosture,
            timeline,
            alexPersonality: strategy.alexPersonality || cfg.alexPersonality || 'balanced',
            hasStrategy: !!(strategy && strategy.mode),
        };
    }

    // React hook: resolves effects(leagueId) and live-updates on GM Strategy
    // save. Generalizes the proven free-agency tick+listener pattern. Depends
    // on BOTH leagueId (league switch) and an internal tick (in-place save),
    // and re-reads the store fresh each tick (never trusts event.detail).
    function useGmEffects(currentLeagueOrId) {
        const R = window.React;
        const leagueId = (currentLeagueOrId && typeof currentLeagueOrId === 'object')
            ? (currentLeagueOrId.league_id || currentLeagueOrId.id)
            : currentLeagueOrId;
        const [tick, setTick] = R.useState(0);
        R.useEffect(() => {
            const h = () => setTick((t) => t + 1);
            window.addEventListener('wr:gm-mode-changed', h);
            return () => window.removeEventListener('wr:gm-mode-changed', h);
        }, []);
        return R.useMemo(() => effects(leagueId), [leagueId, tick]);
    }

    window.WR = window.WR || {};
    window.WR.GmMode = {
        PRESETS,
        AGGRESSION_MAP,
        normalize,
        getMode,
        getPreset,
        describe,
        applyPreset,
        onChange,
        acceptanceFloorFor,
        effects,
        useGmEffects,
        // List of mode ids excluding custom — for the preset picker
        list: () => ['rebuild', 'compete', 'win_now'],
    };
})();
