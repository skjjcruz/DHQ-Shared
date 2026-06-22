// shared/intelligence-context.js
// Canonical context contracts for grounded app-wide recommendations.
(function(root) {
  'use strict';

  const App = root.App = root.App || {};
  const VERSION = 'intelligence-context-v1';

  const IDP_SLOTS = new Set(['IDP', 'IDP_FLEX', 'DL', 'DE', 'DT', 'EDGE', 'LB', 'DB', 'CB', 'S', 'SS', 'FS']);
  const BENCH_SLOTS = new Set(['BN', 'BE', 'BENCH', 'IR', 'TAXI']);
  const DST_SLOTS = new Set(['DEF', 'DST', 'D/ST']);
  const QB_PREMIUM_SLOTS = new Set(['SUPER_FLEX', 'QB_FLEX', 'OP', 'WRTQ', 'WILDCARD']);
  const FLEX_SLOTS = new Set(['FLEX', 'REC_FLEX', 'WR_RB_FLEX', 'WR_TE']);
  const IDP_POSITIONS = new Set(['DL', 'DE', 'DT', 'EDGE', 'LB', 'DB', 'CB', 'S', 'SS', 'FS']);
  const LEAGUE_TYPE_ALIASES = {
    0: 'redraft',
    1: 'keeper',
    2: 'dynasty',
    re_draft: 'redraft',
    season_long: 'redraft',
    bestball: 'best_ball',
  };

  const REASON_LABELS = {
    format_qb_premium: 'Format premium',
    format_te_premium: 'TE premium',
    format_rb_premium: 'RB premium',
    format_idp: 'IDP scoring',
    format_custom_scoring: 'Custom scoring',
    roster_need: 'Roster need',
    roster_surplus: 'Roster surplus',
    market_rising: 'Market rising',
    market_falling: 'Market falling',
    value_edge: 'Value edge',
    deal_balance: 'Deal balance',
    acceptance_fit: 'Acceptance fit',
    faab_efficiency: 'FAAB efficiency',
    positional_scarcity: 'Positional scarcity',
    age_window: 'Age window',
    production_signal: 'Production signal',
    schedule_signal: 'Schedule signal',
    behavioral_fit: 'Manager fit',
    owner_behavior: 'Owner behavior',
    behavioral_pattern: 'Behavior pattern',
    decision_history: 'Decision history',
    trade_tendency: 'Trade tendency',
    historical_baseline: 'League baseline',
    pick_behavior: 'Pick behavior',
    draft_history: 'Draft history',
    waiver_behavior: 'Waiver behavior',
    partner_liquidity: 'Partner liquidity',
    price_behavior: 'Price behavior',
    contender_fit: 'Contender fit',
    rebuilder_fit: 'Rebuilder fit',
    evidence_gap: 'Evidence gap',
    stale_data: 'Stale data',
    confidence_penalty: 'Lower confidence',
    deep_lineup: 'Deep lineup',
    first_down_bonus: 'First-down bonus',
    yardage_bonus: 'Yardage bonus',
  };

  const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };
  const recommendationStore = {};
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  const SOURCE_REGISTRY = {
    dhq: {
      key: 'dhq',
      label: 'DHQ',
      owner: 'Dynasty HQ',
      category: 'internal_model',
      accessMethod: 'computed',
      refreshCadence: 'live',
      maxAgeMs: 6 * HOUR_MS,
      licensePosture: 'owned',
      productionStatus: 'production_safe',
      surfaces: ['player_value', 'team_context', 'trade', 'waiver', 'draft'],
    },
    sleeper: {
      key: 'sleeper',
      label: 'Sleeper API',
      owner: 'Sleeper',
      category: 'platform',
      accessMethod: 'public_api',
      refreshCadence: 'live',
      maxAgeMs: 6 * HOUR_MS,
      licensePosture: 'official_public_api',
      productionStatus: 'production_safe',
      surfaces: ['league_profile', 'rosters', 'transactions', 'drafts', 'trending'],
    },
    fantasycalc: {
      key: 'fantasycalc',
      label: 'FantasyCalc',
      owner: 'FantasyCalc',
      category: 'market',
      accessMethod: 'public_json',
      refreshCadence: 'daily',
      maxAgeMs: 36 * HOUR_MS,
      licensePosture: 'public_endpoint_cache_with_attribution',
      productionStatus: 'production_safe_monitor',
      surfaces: ['market_value', 'trade', 'waiver', 'draft'],
    },
    nfl_fit: {
      key: 'nfl_fit',
      label: 'NFL Fit',
      owner: 'Dynasty HQ',
      category: 'situation',
      accessMethod: 'computed_from_dhq_signals',
      refreshCadence: 'live',
      maxAgeMs: 6 * HOUR_MS,
      licensePosture: 'derived_user_league_data',
      productionStatus: 'production_safe',
      surfaces: ['player_context', 'scouting', 'player_value'],
    },
    league_scoring: {
      key: 'league_scoring',
      label: 'League scoring',
      owner: 'League platform',
      category: 'league_context',
      accessMethod: 'platform_payload',
      refreshCadence: 'live',
      maxAgeMs: 7 * DAY_MS,
      licensePosture: 'user_league_data',
      productionStatus: 'production_safe',
      surfaces: ['league_profile', 'player_context', 'recommendations'],
    },
    league_roster: {
      key: 'league_roster',
      label: 'League roster',
      owner: 'League platform',
      category: 'league_context',
      accessMethod: 'platform_payload',
      refreshCadence: 'live',
      maxAgeMs: 6 * HOUR_MS,
      licensePosture: 'user_league_data',
      productionStatus: 'production_safe',
      surfaces: ['team_context', 'waiver', 'trade'],
    },
    league_behavior: {
      key: 'league_behavior',
      label: 'League behavior',
      owner: 'Dynasty HQ',
      category: 'derived_behavior',
      accessMethod: 'computed_from_league_history',
      refreshCadence: 'live',
      maxAgeMs: 24 * HOUR_MS,
      licensePosture: 'derived_user_league_data',
      productionStatus: 'production_safe',
      surfaces: ['owner_profiles', 'trade', 'alex'],
    },
    owner_behavior: {
      key: 'owner_behavior',
      label: 'Owner behavior',
      owner: 'Dynasty HQ',
      category: 'derived_behavior',
      accessMethod: 'computed_from_league_history',
      refreshCadence: 'live',
      maxAgeMs: 24 * HOUR_MS,
      licensePosture: 'derived_user_league_data',
      productionStatus: 'production_safe',
      surfaces: ['owner_profiles', 'trade', 'alex'],
    },
    decision_history: {
      key: 'decision_history',
      label: 'Decision history',
      owner: 'Dynasty HQ',
      category: 'user_history',
      accessMethod: 'app_storage',
      refreshCadence: 'live',
      maxAgeMs: 7 * DAY_MS,
      licensePosture: 'user_generated',
      productionStatus: 'production_safe',
      surfaces: ['alex', 'behavioral_recommendations'],
    },
    player_stats: {
      key: 'player_stats',
      label: 'Player stats',
      owner: 'League/stat provider',
      category: 'production',
      accessMethod: 'platform_or_cache',
      refreshCadence: 'weekly',
      maxAgeMs: 10 * DAY_MS,
      licensePosture: 'provider_payload',
      productionStatus: 'production_safe',
      surfaces: ['player_context', 'waiver', 'roster'],
    },
    player_meta: {
      key: 'player_meta',
      label: 'Player metadata',
      owner: 'Dynasty HQ',
      category: 'derived_model',
      accessMethod: 'computed',
      refreshCadence: 'live',
      maxAgeMs: 7 * DAY_MS,
      licensePosture: 'derived',
      productionStatus: 'production_safe',
      surfaces: ['player_context', 'roster'],
    },
    age_curve: {
      key: 'age_curve',
      label: 'Age curve',
      owner: 'Dynasty HQ',
      category: 'static_model',
      accessMethod: 'static_model',
      refreshCadence: 'versioned',
      maxAgeMs: 365 * DAY_MS,
      licensePosture: 'owned_model',
      productionStatus: 'production_safe',
      surfaces: ['player_context', 'roster'],
    },
    dynastyprocess: {
      key: 'dynastyprocess',
      label: 'DynastyProcess',
      owner: 'DynastyProcess',
      category: 'market',
      accessMethod: 'open_data',
      refreshCadence: 'weekly',
      maxAgeMs: 10 * DAY_MS,
      licensePosture: 'open_data_attribution_required',
      productionStatus: 'production_safe_monitor',
      surfaces: ['market_value', 'trade', 'draft'],
    },
    nflverse: {
      key: 'nflverse',
      label: 'nflverse',
      owner: 'nflverse',
      category: 'football_data',
      accessMethod: 'open_data',
      refreshCadence: 'weekly',
      maxAgeMs: 10 * DAY_MS,
      licensePosture: 'open_data_attribution_required',
      productionStatus: 'production_safe_monitor',
      surfaces: ['player_context', 'team_context', 'analytics'],
    },
    cfbd: {
      key: 'cfbd',
      label: 'CollegeFootballData',
      owner: 'CollegeFootballData',
      category: 'college_data',
      accessMethod: 'api_key',
      refreshCadence: 'weekly',
      maxAgeMs: 14 * DAY_MS,
      licensePosture: 'api_terms',
      productionStatus: 'production_safe_with_key',
      surfaces: ['rookies', 'draft'],
    },
    pff_csv: {
      key: 'pff_csv',
      label: 'PFF CSV import',
      owner: 'PFF',
      category: 'premium_manual',
      accessMethod: 'manual_csv_import',
      refreshCadence: 'manual',
      maxAgeMs: 14 * DAY_MS,
      licensePosture: 'user_subscription_personal_use_or_b2b_license',
      productionStatus: 'licensing_review',
      surfaces: ['player_context', 'rookies', 'idp'],
    },
    odds_api: {
      key: 'odds_api',
      label: 'The Odds API',
      owner: 'The Odds API',
      category: 'market_lines',
      accessMethod: 'api_key',
      refreshCadence: 'hourly',
      maxAgeMs: 3 * HOUR_MS,
      licensePosture: 'api_terms',
      productionStatus: 'production_safe_with_key',
      surfaces: ['schedule', 'dst', 'survivor', 'dfs'],
    },
    manual_import: {
      key: 'manual_import',
      label: 'Manual import',
      owner: 'User',
      category: 'manual',
      accessMethod: 'csv_or_paste',
      refreshCadence: 'manual',
      maxAgeMs: 30 * DAY_MS,
      licensePosture: 'user_supplied_review_required',
      productionStatus: 'manual_only',
      surfaces: ['premium_enrichment'],
    },
  };

  const SOURCE_ALIASES = {
    'dhq engine': 'dhq',
    'dhq_fc_blend': 'fantasycalc',
    'fc_rookie': 'fantasycalc',
    fc: 'fantasycalc',
    fantasy_calc: 'fantasycalc',
    'league.scoring_settings': 'league_scoring',
    'league scoring': 'league_scoring',
    'league.roster': 'league_roster',
    'league.rosters': 'league_roster',
    roster: 'league_roster',
    team_assessment: 'league_roster',
    ownerprofiles: 'owner_behavior',
    'ownerprofiles.partners': 'owner_behavior',
    'owner dna': 'owner_behavior',
    'owner behavior': 'owner_behavior',
    'league baselines': 'league_behavior',
    draftoutcomes: 'league_behavior',
    tradehistory: 'league_behavior',
    'decision-history': 'decision_history',
    stats: 'player_stats',
    player_stats: 'player_stats',
    player_master: 'sleeper',
    'player master': 'sleeper',
    'sleeper api': 'sleeper',
    player_meta: 'player_meta',
    'draft-board': 'manual_import',
    market: 'manual_import',
    'trade-engine': 'dhq',
    'alex-insights': 'decision_history',
  };

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function normalizeSlot(slot) {
    return String(slot || '').trim().toUpperCase();
  }

  function unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, num(value, lo)));
  }

  function pct(part, total) {
    const n = num(total, 0);
    return n > 0 ? num(part, 0) / n : 0;
  }

  function round(value, digits) {
    const p = Math.pow(10, digits || 0);
    return Math.round(num(value, 0) * p) / p;
  }

  function countSlots(rosterPositions, predicate) {
    return (rosterPositions || []).reduce((sum, slot) => sum + (predicate(normalizeSlot(slot)) ? 1 : 0), 0);
  }

  function pprLabel(ppr) {
    if (ppr >= 1.45) return 'premium-ppr';
    if (ppr >= 0.9) return 'full-ppr';
    if (ppr >= 0.4) return 'half-ppr';
    if (ppr > 0) return 'custom-ppr';
    return 'standard';
  }

  function scoringHasAny(scoring, keys) {
    return keys.some(key => Math.abs(num(scoring[key], 0)) > 0.001);
  }

  function firstNonNull(values, fallback) {
    for (const value of values) {
      if (value != null && value !== '') return value;
    }
    return fallback;
  }

  function normalizeSourceKey(source) {
    const raw = String(source || 'unknown').trim();
    const lower = raw.toLowerCase();
    if (SOURCE_ALIASES[lower]) return SOURCE_ALIASES[lower];
    const key = lower.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return SOURCE_ALIASES[key] || key || 'unknown';
  }

  function getSourceRegistry() {
    return Object.keys(SOURCE_REGISTRY).sort().reduce((out, key) => {
      out[key] = { ...SOURCE_REGISTRY[key], surfaces: (SOURCE_REGISTRY[key].surfaces || []).slice() };
      return out;
    }, {});
  }

  function getSourceDefinition(source) {
    const key = normalizeSourceKey(source);
    const def = SOURCE_REGISTRY[key];
    if (def) return { ...def, surfaces: (def.surfaces || []).slice() };
    return {
      key,
      label: source && source !== 'unknown' ? String(source) : 'Unknown source',
      owner: 'Unknown',
      category: 'unknown',
      accessMethod: 'unknown',
      refreshCadence: 'unknown',
      maxAgeMs: 0,
      licensePosture: 'unknown',
      productionStatus: 'review_required',
      surfaces: [],
    };
  }

  function parseTimestamp(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 100000000000 ? value : value * 1000;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatAge(ageMs) {
    if (!Number.isFinite(ageMs) || ageMs < 0) return '';
    if (ageMs < HOUR_MS) return `${Math.max(1, Math.round(ageMs / 60000))}m`;
    if (ageMs < DAY_MS * 2) return `${Math.round(ageMs / HOUR_MS)}h`;
    return `${Math.round(ageMs / DAY_MS)}d`;
  }

  function sourceFreshness(source, options) {
    const opts = options || {};
    const def = getSourceDefinition(source);
    const nowMs = parseTimestamp(opts.now) || Date.now();
    const updatedMs = parseTimestamp(opts.updatedAt || opts.refreshedAt || (typeof opts.freshness === 'number' ? opts.freshness : null));
    const freshnessText = typeof opts.freshness === 'string' && opts.freshness
      ? opts.freshness
      : def.refreshCadence || 'unknown';
    const explicitStale = /stale|old|expired/i.test(String(opts.freshness || ''));
    const explicitMissing = /missing|unknown/i.test(String(opts.freshness || ''));
    const ageMs = updatedMs ? Math.max(0, nowMs - updatedMs) : null;
    const staleByAge = !!(updatedMs && def.maxAgeMs && ageMs > def.maxAgeMs);
    const stale = !!(explicitStale || staleByAge || (explicitMissing && opts.present === false));
    return {
      sourceKey: def.key,
      label: freshnessText,
      status: stale ? 'stale' : updatedMs ? 'fresh' : freshnessText,
      stale,
      ageMs,
      ageLabel: ageMs == null ? '' : formatAge(ageMs),
      maxAgeMs: def.maxAgeMs || 0,
      updatedAt: updatedMs ? new Date(updatedMs).toISOString() : '',
      refreshCadence: def.refreshCadence,
    };
  }

  function buildSourceEvidence(input) {
    const data = input || {};
    const def = getSourceDefinition(data.sourceKey || data.source);
    const freshness = sourceFreshness(def.key, data);
    const value = data.value;
    const present = data.present != null ? !!data.present : value != null && value !== '';
    return {
      source: data.source || def.label,
      sourceKey: def.key,
      sourceLabel: def.label,
      owner: def.owner,
      category: def.category,
      accessMethod: def.accessMethod,
      licensePosture: def.licensePosture,
      productionStatus: def.productionStatus,
      signal: data.signal || '',
      value,
      freshness: data.freshness || freshness.label,
      freshnessStatus: freshness.status,
      refreshedAt: data.refreshedAt || data.updatedAt || freshness.updatedAt || '',
      present,
      stale: data.stale != null ? !!data.stale : freshness.stale,
      detail: data.detail || '',
      entityId: data.entityId || '',
    };
  }

  const FEED_CACHE = {};
  const FANTASYCALC_BASE_URL = 'https://api.fantasycalc.com/values/current';
  const FANTASYCALC_TTL_MS = 30 * 60 * 1000;

  function fantasyCalcPprParam(profile) {
    const ppr = num(profile?.scoring?.ppr, 0.5);
    if (ppr >= 0.9) return 1;
    if (ppr >= 0.4) return 0.5;
    return 0;
  }

  function fantasyCalcNumQbs(profile) {
    return (num(profile?.roster?.superflexSlots, 0) > 0 || num(profile?.roster?.qbSlots, 0) >= 2) ? 2 : 1;
  }

  function fantasyCalcIsDynasty(profile) {
    const type = String(profile?.type || '').toLowerCase();
    return !['redraft', 'best_ball', 'dfs', 'survivor', 'pickem'].includes(type);
  }

  function buildFantasyCalcRequest(input) {
    const data = input || {};
    const profile = data.profile?.schemaVersion === VERSION ? data.profile : buildLeagueProfile(data);
    const params = {
      isDynasty: data.isDynasty != null ? String(!!data.isDynasty) : String(fantasyCalcIsDynasty(profile)),
      numQbs: String(data.numQbs || fantasyCalcNumQbs(profile)),
      numTeams: String(data.numTeams || data.teams || profile.teams || 12),
      ppr: String(data.ppr != null ? data.ppr : fantasyCalcPprParam(profile)),
    };
    const query = new URLSearchParams(params).toString();
    const url = `${data.baseUrl || FANTASYCALC_BASE_URL}?${query}`;
    return {
      schemaVersion: VERSION,
      sourceKey: 'fantasycalc',
      url,
      params,
      profile: {
        leagueId: profile.leagueId,
        formatTags: profile.formatTags || [],
        compatibility: profile.market?.fantasyCalcCompatibility || buildMarketCompatibility(profile),
      },
      evidence: [
        buildSourceEvidence({
          sourceKey: 'fantasycalc',
          source: 'FantasyCalc',
          signal: 'query',
          value: params,
          freshness: 'live',
          detail: `FantasyCalc request built for ${params.numQbs}QB, ${params.numTeams} teams, ${params.ppr} PPR.`,
        }),
      ],
    };
  }

  function normalizeFantasyCalcRow(row, options) {
    const opts = options || {};
    const player = row?.player || row || {};
    const sleeperId = firstNonNull([
      row?.sleeper_id,
      row?.sleeperId,
      player.sleeperId,
      player.maybeSleeperID,
      player.sleeper_id,
    ], '');
    const position = String(row?.position || player.position || '').toUpperCase();
    const assetType = position === 'PICK' ? 'pick' : 'player';
    const value = num(firstNonNull([row?.value, row?.fc_value, row?.marketValue], 0), 0);
    const id = sleeperId ? String(sleeperId) : String(player.id || row?.id || row?.player_id || '');
    const normalized = {
      sourceKey: 'fantasycalc',
      assetType,
      id,
      sleeperId: sleeperId ? String(sleeperId) : '',
      fantasyCalcId: String(player.id || row?.id || ''),
      name: row?.name || player.name || player.full_name || String(id || 'Asset'),
      position,
      team: row?.team || row?.nfl_team || player.maybeTeam || player.team || '',
      age: num(firstNonNull([row?.age, player.maybeAge, player.age], 0), 0),
      value,
      overallRank: num(firstNonNull([row?.overallRank, row?.rank, row?.fc_rank], 0), 0),
      positionRank: num(firstNonNull([row?.positionRank, row?.position_rank, row?.fc_pos_rank], 0), 0),
      trend30Day: num(firstNonNull([row?.trend30Day, row?.fc_trend_30d], 0), 0),
      redraftValue: num(row?.redraftValue, 0),
      combinedValue: num(row?.combinedValue, 0),
      tradeFrequency: num(row?.maybeTradeFrequency, 0),
      tier: row?.maybeTier || null,
    };
    normalized.evidence = [
      buildSourceEvidence({
        sourceKey: 'fantasycalc',
        source: 'FantasyCalc',
        signal: assetType === 'pick' ? 'pick_market_value' : 'market_value',
        value,
        freshness: opts.freshness || 'daily',
        updatedAt: opts.fetchedAt,
        present: value > 0,
        entityId: normalized.sleeperId || normalized.name,
      }),
    ];
    return normalized;
  }

  function buildFantasyCalcSnapshot(input) {
    const data = input || {};
    const rawRows = Array.isArray(data.rows) ? data.rows : (Array.isArray(data.rawRows) ? data.rawRows : []);
    const request = data.request || buildFantasyCalcRequest(data);
    const fetchedAt = data.fetchedAt || new Date().toISOString();
    const rows = rawRows.map(row => normalizeFantasyCalcRow(row, { fetchedAt })).filter(row => row.value > 0);
    const valuesBySleeperId = {};
    const pickValues = [];
    rows.forEach(row => {
      if (row.assetType === 'pick') pickValues.push(row);
      else if (row.sleeperId) valuesBySleeperId[row.sleeperId] = row;
    });
    const evidence = [
      buildSourceEvidence({
        sourceKey: 'fantasycalc',
        source: 'FantasyCalc',
        signal: 'snapshot_rows',
        value: rows.length,
        freshness: 'live',
        updatedAt: fetchedAt,
        present: rows.length > 0,
        detail: `FantasyCalc snapshot loaded ${rows.length} assets for ${request.params.numQbs}QB/${request.params.numTeams}-team/${request.params.ppr} PPR context.`,
      }),
    ];
    return {
      schemaVersion: VERSION,
      sourceKey: 'fantasycalc',
      sourceLabel: 'FantasyCalc',
      url: request.url,
      params: request.params,
      profile: request.profile,
      fetchedAt,
      refreshedAt: fetchedAt,
      count: rows.length,
      playerCount: Object.keys(valuesBySleeperId).length,
      pickCount: pickValues.length,
      rows,
      rawRows,
      valuesBySleeperId,
      pickValues,
      evidence,
    };
  }

  async function fetchFantasyCalcSnapshot(input) {
    const data = input || {};
    const request = buildFantasyCalcRequest(data);
    const ttlMs = data.ttlMs == null ? FANTASYCALC_TTL_MS : num(data.ttlMs, FANTASYCALC_TTL_MS);
    const cached = FEED_CACHE[request.url];
    if (!data.force && cached && Date.now() - cached.ts < ttlMs) return cached.snapshot;
    const fetchFn = data.fetch || root.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) {
      if (cached?.snapshot) return cached.snapshot;
      throw new Error('FantasyCalc fetch unavailable in this runtime.');
    }
    try {
      const res = await fetchFn(request.url);
      if (!res.ok) throw new Error(`FantasyCalc HTTP ${res.status}`);
      const rows = await res.json();
      const snapshot = buildFantasyCalcSnapshot({
        ...data,
        rows: Array.isArray(rows) ? rows : [],
        request,
        fetchedAt: data.fetchedAt || new Date().toISOString(),
      });
      FEED_CACHE[request.url] = { ts: Date.now(), snapshot };
      return snapshot;
    } catch (err) {
      if (cached?.snapshot) return cached.snapshot;
      return {
        schemaVersion: VERSION,
        sourceKey: 'fantasycalc',
        sourceLabel: 'FantasyCalc',
        url: request.url,
        params: request.params,
        profile: request.profile,
        fetchedAt: '',
        refreshedAt: '',
        count: 0,
        playerCount: 0,
        pickCount: 0,
        rows: [],
        rawRows: [],
        valuesBySleeperId: {},
        pickValues: [],
        error: err?.message || String(err),
        evidence: [
          buildSourceEvidence({
            sourceKey: 'fantasycalc',
            source: 'FantasyCalc',
            signal: 'snapshot_rows',
            value: 0,
            freshness: 'missing',
            present: false,
            detail: `FantasyCalc snapshot failed: ${err?.message || err}`,
          }),
        ],
      };
    }
  }

  function normalizeScoring(input) {
    const scoring = input?.scoring_settings || input?.scoring || input || {};
    const ppr = num(firstNonNull([scoring.rec, scoring.receptions, scoring.reception, scoring.recpt], 0), 0);
    const teBonus = num(firstNonNull([
      scoring.bonus_rec_te, scoring.rec_te_bonus, scoring.te_rec_bonus, scoring.rec_te, scoring.te_premium,
    ], 0), 0);
    const rbBonus = num(firstNonNull([
      scoring.bonus_rec_rb, scoring.rec_rb_bonus, scoring.rb_rec_bonus, scoring.rec_rb,
    ], 0), 0);
    const firstDownBonus = scoringHasAny(scoring, ['pass_fd', 'rush_fd', 'rec_fd', 'pass_first_down', 'rush_first_down', 'rec_first_down']);
    const yardageBonuses = scoringHasAny(scoring, [
      'bonus_pass_300', 'bonus_pass_400', 'bonus_rush_100', 'bonus_rush_200',
      'bonus_rec_100', 'bonus_rec_200', 'bonus_rush_rec_100', 'bonus_rush_rec_200',
    ]);
    const kickerScoring = scoringHasAny(scoring, ['fgm', 'fgm_40_49', 'fgm_50p', 'fgm_50_59', 'fgm_60p', 'xpm']);
    const idpScoring = Object.keys(scoring).some(key => key.indexOf('idp_') === 0 && Math.abs(num(scoring[key], 0)) > 0.001);

    return {
      raw: scoring,
      ppr,
      label: pprLabel(ppr),
      passTd: num(firstNonNull([scoring.pass_td, scoring.passing_td, scoring.pass_tds], 4), 4),
      passInt: num(firstNonNull([scoring.pass_int, scoring.passing_int, scoring.interception], -1), -1),
      tePremium: +(ppr + teBonus).toFixed(2),
      teBonus,
      rbPremium: +(ppr + rbBonus).toFixed(2),
      rbBonus,
      firstDownBonus,
      yardageBonuses,
      idpScoring,
      kickerScoring,
    };
  }

  function normalizeLeagueType(value) {
    if (value == null || value === '') return '';
    const raw = String(value).trim().toLowerCase();
    return LEAGUE_TYPE_ALIASES[raw] || raw;
  }

  function detectLeagueType(league, fallback) {
    const explicit = normalizeLeagueType(firstNonNull([
      league?.type,
      league?.league_type,
      league?.settings?.type,
      fallback,
    ], ''));
    if (explicit) return explicit;
    if (league?.metadata?.keeper_count || league?.settings?.keeper_count) return 'keeper';
    if (Array.isArray(league?.draft_order) && league.draft_order.length) return 'dynasty';
    return 'unknown';
  }

  function buildMarketCompatibility(profile) {
    const p = profile || {};
    const core = App.DhqCore || root.App?.DhqCore;
    if (typeof core?.fantasyCalcCompatibility === 'function') {
      return {
        ...core.fantasyCalcCompatibility({
          mode: p.type || 'dynasty',
          teams: p.teams,
          ppr: p.scoring?.ppr,
          rosterPositions: p.roster?.positions || [],
          scoring: p.scoring?.raw || {},
        }),
        source: 'App.DhqCore.fantasyCalcCompatibility',
      };
    }
    const reasons = [];
    if (p.scoring?.firstDownBonus) reasons.push('first_down_bonus');
    if (p.scoring?.yardageBonuses) reasons.push('yardage_bonus');
    if (p.scoring?.idp) reasons.push('idp');
    if (p.scoring?.kicker) reasons.push('kicker_scoring');
    const score = Math.max(0.35, +(1 - reasons.length * 0.12).toFixed(2));
    return {
      score,
      supported: score >= 0.7,
      custom: score < 0.7,
      extremeCustom: score < 0.35,
      reasons,
      source: 'App.Intelligence.fallbackCompatibility',
    };
  }

  function buildLeagueProfile(input) {
    const data = input || {};
    const league = data.league || data.currentLeague || {};
    const scoring = league.scoring_settings || data.scoring || {};
    const normalizedScoring = normalizeScoring(scoring);
    const rosterPositions = league.roster_positions || data.rosterPositions || [];
    const normalizedRosterPositions = rosterPositions.map(normalizeSlot);
    const rosters = data.rosters || league.rosters || [];
    const ppr = normalizedScoring.ppr;
    const idpSlots = countSlots(rosterPositions, slot => IDP_SLOTS.has(slot));
    const dstSlots = countSlots(rosterPositions, slot => DST_SLOTS.has(slot));
    const superflexSlots = countSlots(rosterPositions, slot => QB_PREMIUM_SLOTS.has(slot));
    const qbSlots = countSlots(rosterPositions, slot => slot === 'QB');
    const starterSlots = countSlots(rosterPositions, slot => !BENCH_SLOTS.has(slot));

    const customFlags = [];
    if (superflexSlots || qbSlots >= 2) customFlags.push('qb_premium');
    if (normalizedScoring.teBonus || ppr >= 1.45) customFlags.push('te_premium');
    if (normalizedScoring.rbBonus) customFlags.push('rb_premium');
    if (idpSlots || normalizedScoring.idpScoring) customFlags.push('idp');
    if (normalizedScoring.firstDownBonus) customFlags.push('first_down_bonus');
    if (normalizedScoring.yardageBonuses) customFlags.push('yardage_bonus');
    if (normalizedScoring.kickerScoring) customFlags.push('kicker_scoring');

    const confidenceReasons = [];
    let confidenceScore = 1;
    if (!league.league_id && !league.id) {
      confidenceScore -= 0.2;
      confidenceReasons.push('missing_league_id');
    }
    if (!rosterPositions.length) {
      confidenceScore -= 0.25;
      confidenceReasons.push('missing_roster_positions');
    }
    if (!Object.keys(scoring).length) {
      confidenceScore -= 0.2;
      confidenceReasons.push('missing_scoring_settings');
    }
    if (!rosters.length && !data.teams) {
      confidenceScore -= 0.15;
      confidenceReasons.push('missing_rosters');
    }

    const formatTags = unique([
      detectLeagueType(league, data.type),
      pprLabel(ppr),
      superflexSlots || qbSlots >= 2 ? 'superflex' : '1qb',
      idpSlots || normalizedScoring.idpScoring ? 'idp' : 'non-idp',
      dstSlots ? 'dst' : '',
      customFlags.length ? 'custom-scoring' : 'standard-ish-scoring',
    ]);

    const profile = {
      schemaVersion: VERSION,
      leagueId: String(league.league_id || league.id || ''),
      name: league.name || data.name || '',
      platform: data.platform || league._platform || (league._mfl ? 'mfl' : league._espn ? 'espn' : league._yahoo ? 'yahoo' : 'sleeper'),
      type: detectLeagueType(league, data.type),
      teams: rosters.length || num(data.teams || league.total_rosters || league.settings?.num_teams, 0),
      scoring: {
        raw: normalizedScoring.raw,
        ppr,
        label: normalizedScoring.label,
        passTd: normalizedScoring.passTd,
        passInt: normalizedScoring.passInt,
        tePremium: normalizedScoring.tePremium,
        teBonus: normalizedScoring.teBonus,
        rbPremium: normalizedScoring.rbPremium,
        rbBonus: normalizedScoring.rbBonus,
        firstDownBonus: normalizedScoring.firstDownBonus,
        yardageBonuses: normalizedScoring.yardageBonuses,
        idp: idpSlots > 0 || normalizedScoring.idpScoring,
        dst: dstSlots > 0,
        kicker: normalizedRosterPositions.includes('K') || normalizedScoring.kickerScoring,
        customFlags,
      },
      roster: {
        positions: rosterPositions.slice(),
        starters: starterSlots,
        qbSlots,
        superflexSlots,
        flexSlots: countSlots(rosterPositions, slot => FLEX_SLOTS.has(slot)),
        idpSlots,
        dstSlots,
      },
      formatTags,
      confidence: {
        score: +Math.max(0, Math.min(1, confidenceScore)).toFixed(2),
        reasons: confidenceReasons,
      },
      evidence: [
        buildSourceEvidence({ sourceKey: 'league_scoring', source: 'league.scoring_settings', signal: 'scoring', value: normalizedScoring.label, present: Object.keys(scoring).length > 0 }),
        buildSourceEvidence({ sourceKey: 'league_scoring', source: 'league.roster_positions', signal: 'roster_slots', value: starterSlots, present: rosterPositions.length > 0 }),
        buildSourceEvidence({ sourceKey: 'league_roster', source: 'league.rosters', signal: 'team_count', value: rosters.length || data.teams || league.total_rosters, present: rosters.length > 0 }),
      ],
    };
    profile.market = {
      fantasyCalcCompatibility: buildMarketCompatibility(profile),
    };
    return profile;
  }

  function buildFormatBadges(profileOrInput) {
    const profile = profileOrInput?.schemaVersion === VERSION ? profileOrInput : buildLeagueProfile(profileOrInput);
    const badges = [];
    const add = (code, label, detail, impact) => badges.push({ code, label, detail, impact: impact || 'context' });
    const pprLabelText = profile.scoring?.label === 'full-ppr' ? 'Full PPR'
      : profile.scoring?.label === 'half-ppr' ? 'Half PPR'
        : profile.scoring?.label === 'standard' ? 'Standard'
          : 'Custom PPR';
    add('format_ppr', pprLabelText, `${pprLabelText} changes target and reception value.`, 'scoring');
    if (profile.formatTags?.includes('superflex')) add('format_qb_premium', 'SF QB premium', 'Superflex/2QB roster rules raise QB scarcity and replacement value.', 'major');
    if ((profile.scoring?.teBonus || 0) > 0 || profile.scoring?.tePremium >= 1.45) add('format_te_premium', 'TE premium', 'TE receptions carry extra scoring weight.', 'major');
    if ((profile.scoring?.rbBonus || 0) > 0) add('format_rb_premium', 'RB premium', 'RB receptions carry extra scoring weight.', 'scoring');
    if (profile.scoring?.idp) add('format_idp', 'IDP active', 'Defensive players must be valued from league IDP scoring and snap opportunity.', 'major');
    if (profile.scoring?.firstDownBonus) add('first_down_bonus', 'First-down bonus', 'Players earning first downs get extra value beyond yardage and touchdowns.', 'scoring');
    if (profile.scoring?.yardageBonuses) add('yardage_bonus', 'Yardage bonuses', 'Big weekly yardage outcomes are more valuable than baseline projections imply.', 'scoring');
    if ((profile.roster?.starters || 0) >= 11) add('deep_lineup', 'Deep lineup', 'More starters increases replacement-level pressure and depth value.', 'roster');
    if (profile.market?.fantasyCalcCompatibility?.custom) add('format_custom_scoring', 'Custom market fit', 'Market values need a confidence haircut because this format is outside common trade-value profiles.', 'confidence');
    return badges;
  }

  function buildPlayerFormatReasons(input) {
    const data = input || {};
    const profile = data.profile?.schemaVersion === VERSION ? data.profile : buildLeagueProfile(data);
    const rawPos = data.pos || data.player?.position || data.subject?.pos || '';
    const pos = String(rawPos).toUpperCase();
    const reasons = [];
    const add = (code, detail, weight) => reasons.push(normalizeReason({ code, detail, weight }));
    if (profile.formatTags?.includes('superflex') && pos === 'QB') add('format_qb_premium', 'Superflex/2QB format raises QB value and makes startable depth more important.', 1.4);
    if (((profile.scoring?.teBonus || 0) > 0 || profile.scoring?.tePremium >= 1.45) && pos === 'TE') add('format_te_premium', 'TE premium scoring boosts reception volume for this position.', 1.25);
    if ((profile.scoring?.rbBonus || 0) > 0 && pos === 'RB') add('format_rb_premium', 'RB premium scoring boosts reception volume for this position.', 1.1);
    if (['RB', 'WR', 'TE'].includes(pos) && profile.scoring?.label === 'full-ppr') add('production_signal', 'Full PPR makes target volume more valuable than standard scoring.', 0.75);
    if (IDP_POSITIONS.has(pos) && profile.scoring?.idp) add('format_idp', 'IDP scoring is active, so defensive value should follow this league scoring and snap opportunity.', 1.1);
    if (profile.scoring?.firstDownBonus && ['QB', 'RB', 'WR', 'TE'].includes(pos)) add('first_down_bonus', 'First-down bonuses reward role stability and chain-moving usage.', 0.7);
    if (profile.market?.fantasyCalcCompatibility?.custom) add('format_custom_scoring', 'Custom scoring lowers confidence in generic market values; league-specific scoring should drive the read.', 0.5);
    return reasons;
  }

  function playerDisplayName(player, fallback) {
    const p = player || {};
    return p.full_name || p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') || fallback || 'Player';
  }

  function buildPlayerContext(input) {
    const data = input || {};
    const player = data.player || data.subject || {};
    const profile = data.profile?.schemaVersion === VERSION
      ? data.profile
      : (data.league || data.currentLeague || data.scoring ? buildLeagueProfile(data) : null);
    const id = String(data.pid || data.playerId || player.player_id || player.id || data.id || '');
    const meta = data.meta || data.playerMeta || (id ? App.LI?.playerMeta?.[id] : null) || {};
    const name = playerDisplayName(player, data.name || id);
    const pos = String(data.pos || player.position || player.pos || '').toUpperCase();
    const age = data.age != null ? num(data.age, 0) : num(player.age, 0);
    const dhq = num(firstNonNull([data.dhq, data.value, player.dhq, player.value], 0), 0);
    const ppg = num(firstNonNull([data.ppg, player.ppg], 0), 0);
    const trend = num(firstNonNull([data.trend, player.trend], 0), 0);
    const peakYrs = data.peakYrs != null ? num(data.peakYrs, 0) : null;
    const valueYrs = data.valueYrs != null ? num(data.valueYrs, 0) : null;
    const rosterFit = data.fit || data.rosterFit || null;
    const formatReasons = data.formatReasons || (profile ? buildPlayerFormatReasons({ player, pos, profile }) : []);
    const reasons = [];

    if (rosterFit?.need) {
      reasons.push(normalizeReason({
        code: 'roster_need',
        detail: `Addresses ${pos || 'a roster'} ${rosterFit.need.urgency || 'need'} in this league context.`,
        weight: 1.2,
      }));
    } else if (rosterFit?.short || rosterFit?.label) {
      reasons.push(normalizeReason({
        code: 'roster_surplus',
        detail: `${rosterFit.label || rosterFit.short} roster fit for this team.`,
        weight: 0.6,
      }));
    }
    if (peakYrs != null || valueYrs != null) {
      reasons.push(normalizeReason({
        code: 'age_window',
        detail: `${peakYrs == null ? '?' : peakYrs} peak years and ${valueYrs == null ? '?' : valueYrs} value years remain by the current age curve.`,
        weight: 0.8,
      }));
    }
    if (trend >= 15) reasons.push(normalizeReason({ code: 'market_rising', detail: `Production or market trend is up ${Math.round(trend)}%.`, weight: 0.7 }));
    if (trend <= -15) reasons.push(normalizeReason({ code: 'market_falling', detail: `Production or market trend is down ${Math.abs(Math.round(trend))}%.`, weight: 0.7 }));
    (formatReasons || []).forEach(reason => reasons.push(normalizeReason(reason)));

    const evidence = [
      buildSourceEvidence({ sourceKey: 'sleeper', source: 'player_master', signal: 'identity', value: name, freshness: 'live', present: !!name, entityId: id }),
      buildSourceEvidence({ sourceKey: 'dhq', source: 'DHQ', signal: 'player_value', value: dhq, freshness: data.valueFreshness || 'live', present: dhq > 0, entityId: id }),
      buildSourceEvidence({ sourceKey: 'player_stats', source: 'stats', signal: 'ppg', value: ppg || null, freshness: data.statsFreshness || (ppg ? 'season' : 'missing'), present: ppg > 0, entityId: id }),
      buildSourceEvidence({ sourceKey: 'player_meta', source: 'player_meta', signal: 'trend', value: trend, freshness: data.trendFreshness || (trend ? 'season' : 'missing'), present: trend !== 0, entityId: id }),
      buildSourceEvidence({ sourceKey: 'league_scoring', source: 'league.scoring_settings', signal: 'format_context', value: profile?.formatTags || [], freshness: 'live', present: !!profile }),
    ];
    if (meta.fcValue != null || data.marketValue != null) {
      const marketSnapshot = App.LI?.sourceSnapshots?.fantasycalc || {};
      evidence.push(buildSourceEvidence({
        sourceKey: 'fantasycalc',
        source: 'FantasyCalc',
        signal: meta.source === 'FC_ROOKIE' ? 'rookie_market_value' : 'market_value',
        value: firstNonNull([data.marketValue, meta.fcValue], null),
        freshness: data.marketFreshness || 'daily',
        updatedAt: data.marketUpdatedAt || meta.fcUpdatedAt || marketSnapshot.fetchedAt,
        present: firstNonNull([data.marketValue, meta.fcValue], null) != null,
        entityId: id,
        detail: meta.fcWeight != null
          ? `FantasyCalc market anchor blended at ${meta.fcWeight}% because DHQ and market disagreed.`
          : '',
      }));
    }

    const score = data.score != null
      ? num(data.score, 0)
      : clamp(Math.round(Math.min(55, dhq / 120) + Math.min(20, ppg * 1.3) + Math.max(-15, Math.min(15, trend / 2)) + (rosterFit?.score || 0) * 5), 0, 100);

    return {
      schemaVersion: VERSION,
      type: 'player_context',
      player: {
        id,
        name,
        pos,
        team: player.team || data.team || '',
        age,
        status: player.status || '',
      },
      leagueProfile: profile,
      formatReasons: (formatReasons || []).map(normalizeReason),
      rosterFit,
      value: {
        dhq,
        ppg,
        trend,
        peakYrs,
        valueYrs,
      },
      reasons,
      reasonCodes: reasons.map(reason => reason.code),
      evidence,
      confidence: data.confidence || confidenceFromScore(score, evidence, reasons),
      score,
      explain: {
        lines: unique(reasons.map(r => r.detail || r.label).concat(evidence.filter(ev => ev.present !== false).map(evidenceLabel))).slice(0, data.limit || 5),
      },
    };
  }

  function buildTeamContext(input) {
    const data = input || {};
    const roster = data.roster || data.team || {};
    const assessment = data.assessment || data.teamAssessment || {};
    const profile = data.profile?.schemaVersion === VERSION
      ? data.profile
      : (data.league || data.currentLeague || data.scoring ? buildLeagueProfile(data) : null);
    const playersById = data.playersById || data.playersData || {};
    const playerScores = data.playerScores || App.LI?.playerScores || {};
    const rosterPlayers = data.players || roster.players || [];
    const rosterId = String(data.rosterId ?? roster.roster_id ?? assessment.rosterId ?? '');
    const ownerName = data.ownerName || assessment.ownerName || roster.ownerName || roster.owner_name || '';
    const teamName = data.teamName || assessment.teamName || roster.teamName || roster.name || ownerName || (rosterId ? `Roster ${rosterId}` : 'Team');
    const needs = (assessment.needs || data.needs || []).map(n => ({
      pos: String(n.pos || n.position || '').toUpperCase(),
      urgency: n.urgency || n.label || 'need',
      detail: n.detail || '',
      value: n.value,
    })).filter(n => n.pos);
    const surplus = (assessment.strengths || data.surplus || data.strengths || []).map(pos => String(pos?.pos || pos).toUpperCase()).filter(Boolean);
    const posAssessment = assessment.posAssessment || data.posAssessment || {};
    const positionRooms = Object.entries(posAssessment).map(([pos, row]) => ({
      pos: String(pos).toUpperCase(),
      grade: row.grade || row.label || '',
      actual: num(row.actual, 0),
      required: num(firstNonNull([row.startingReq, row.minQuality, row.required], 0), 0),
      nflStarters: num(row.nflStarters, 0),
      detail: row.detail || '',
    }));
    const totalValue = data.totalValue != null
      ? num(data.totalValue, 0)
      : rosterPlayers.reduce((sum, pid) => sum + num(playerScores[String(pid)] || playerScores[pid], 0), 0);
    const topPlayers = rosterPlayers.map(pid => {
      const p = playersById[String(pid)] || playersById[pid] || {};
      return {
        id: String(pid),
        name: playerDisplayName(p, String(pid)),
        pos: String(p.position || p.pos || '').toUpperCase(),
        dhq: num(playerScores[String(pid)] || playerScores[pid], 0),
      };
    }).sort((a, b) => b.dhq - a.dhq).slice(0, data.topLimit || 8);
    const reasons = [];
    needs.slice(0, 4).forEach(need => reasons.push(normalizeReason({
      code: 'roster_need',
      detail: `${need.pos} is a ${need.urgency} for ${teamName}.`,
      weight: need.urgency === 'deficit' ? 1.2 : 0.8,
    })));
    surplus.slice(0, 4).forEach(pos => reasons.push(normalizeReason({
      code: 'roster_surplus',
      detail: `${pos} is a moveable strength or surplus room for ${teamName}.`,
      weight: 0.7,
    })));
    if (assessment.tier || assessment.window) {
      const contender = /elite|contend|prime/i.test(`${assessment.tier || ''} ${assessment.window || ''}`);
      reasons.push(normalizeReason({
        code: contender ? 'contender_fit' : 'rebuilder_fit',
        detail: `${teamName} profiles as ${assessment.tier || assessment.window}; recommendations should respect that window.`,
        weight: 0.8,
      }));
    }
    if (profile?.roster?.starters >= 11) {
      reasons.push(normalizeReason({
        code: 'deep_lineup',
        detail: 'Deep starter requirements make roster coverage and replacement level more important.',
        weight: 0.5,
      }));
    }
    const evidence = [
      buildSourceEvidence({ sourceKey: 'league_roster', source: 'team_assessment', signal: 'needs', value: needs.map(n => n.pos), freshness: 'live', present: needs.length > 0, entityId: rosterId }),
      buildSourceEvidence({ sourceKey: 'league_roster', source: 'team_assessment', signal: 'surplus', value: surplus, freshness: 'live', present: surplus.length > 0, entityId: rosterId }),
      buildSourceEvidence({ sourceKey: 'dhq', source: 'DHQ', signal: 'team_value', value: totalValue, freshness: data.valueFreshness || 'live', present: totalValue > 0, entityId: rosterId }),
      buildSourceEvidence({ sourceKey: 'league_scoring', source: 'league.roster_positions', signal: 'starter_slots', value: profile?.roster?.starters, freshness: 'live', present: !!profile?.roster?.starters }),
    ].map(normalizeEvidence);
    const score = data.score != null ? num(data.score, 0) : clamp(Math.round(totalValue / 1600 + topPlayers.length * 2 - needs.length * 4), 0, 100);

    return {
      schemaVersion: VERSION,
      type: 'team_context',
      team: {
        rosterId,
        ownerId: data.ownerId || roster.owner_id || assessment.ownerId || '',
        ownerName,
        teamName,
        tier: assessment.tier || '',
        window: assessment.window || '',
      },
      leagueProfile: profile,
      needs,
      surplus,
      positionRooms,
      topPlayers,
      value: { totalDhq: totalValue },
      reasons,
      reasonCodes: reasons.map(reason => reason.code),
      evidence,
      confidence: data.confidence || confidenceFromScore(score, evidence, reasons),
      score,
      explain: {
        lines: unique(reasons.map(r => r.detail || r.label).concat(evidence.filter(ev => ev.present !== false).map(evidenceLabel))).slice(0, data.limit || 5),
      },
    };
  }

  function describeLeagueProfile(profileOrInput) {
    const profile = profileOrInput?.schemaVersion === VERSION ? profileOrInput : buildLeagueProfile(profileOrInput);
    const badges = buildFormatBadges(profile);
    const summary = [
      profile.teams ? `${profile.teams}-team` : '',
      profile.type && profile.type !== 'unknown' ? profile.type : '',
      profile.scoring?.label,
      profile.formatTags?.includes('superflex') ? 'Superflex' : '1QB',
      profile.scoring?.idp ? 'IDP' : '',
      profile.scoring?.teBonus ? 'TE premium' : '',
    ].filter(Boolean).join(' | ');
    return {
      summary,
      badges,
      lines: badges.map(badge => `${badge.label}: ${badge.detail}`),
    };
  }

  function buildLeagueBehaviorBaselines(input) {
    const data = input || {};
    const LI = App.LI || {};
    const rosters = data.rosters || data.league?.rosters || App.S?.rosters || LI.rosters || [];
    const ownerProfiles = data.ownerProfiles || LI.ownerProfiles || {};
    const tradeHistory = data.tradeHistory || LI.tradeHistory || [];
    const draftOutcomes = data.draftOutcomes || LI.draftOutcomes || [];
    const faabTxns = data.faabTxns || LI.faabTxns || [];
    const rosterIds = new Set((rosters || []).map(r => String(r.roster_id)));
    Object.keys(ownerProfiles || {}).forEach(rid => rosterIds.add(String(rid)));
    (tradeHistory || []).forEach(t => (t.roster_ids || Object.keys(t.sides || {})).forEach(rid => rosterIds.add(String(rid))));
    const teamCount = Math.max(1, data.teams || rosterIds.size || rosters.length || 12);

    const ownerTradeCounts = {};
    Object.entries(ownerProfiles || {}).forEach(([rid, profile]) => {
      ownerTradeCounts[String(rid)] = num(profile.trades, 0);
    });
    (tradeHistory || []).forEach(t => {
      (t.roster_ids || Object.keys(t.sides || {})).forEach(rid => {
        const key = String(rid);
        ownerTradeCounts[key] = Math.max(ownerTradeCounts[key] || 0, 0);
      });
    });
    if (!Object.values(ownerTradeCounts).some(Boolean)) {
      (tradeHistory || []).forEach(t => (t.roster_ids || Object.keys(t.sides || {})).forEach(rid => {
        const key = String(rid);
        ownerTradeCounts[key] = (ownerTradeCounts[key] || 0) + 1;
      }));
    }

    const ownerCounts = Object.values(ownerTradeCounts);
    const avgTradesPerOwner = ownerCounts.length
      ? ownerCounts.reduce((s, v) => s + num(v, 0), 0) / Math.max(1, teamCount)
      : ((tradeHistory || []).length * 2) / teamCount;
    const valueDiffs = Object.values(ownerProfiles || {}).map(p => num(p.avgValueDiff, 0)).filter(v => v !== 0);
    const avgOwnerValueDiff = valueDiffs.length ? valueDiffs.reduce((s, v) => s + v, 0) / valueDiffs.length : 0;
    const tradeCount = (tradeHistory || []).length;
    const pickHeavy = (tradeHistory || []).filter(t => Object.values(t.sides || {}).some(side => (side.picks || []).length)).length;
    const fairTrades = (tradeHistory || []).filter(t => num(t.valueDiffPct, 100) <= 15 || num(t.fairness, 0) >= 85).length;
    let totalAssets = 0;
    let sideCount = 0;
    const timing = { early: 0, mid: 0, late: 0 };
    (tradeHistory || []).forEach(t => {
      Object.values(t.sides || {}).forEach(side => {
        totalAssets += (side.players || []).length + (side.picks || []).length;
        sideCount++;
      });
      const w = num(t.week, 0);
      if (w >= 1 && w <= 6) timing.early++;
      else if (w >= 7 && w <= 12) timing.mid++;
      else if (w > 0) timing.late++;
    });

    const draftHits = (draftOutcomes || []).filter(d => d.isHit || d.isStarter || num(d.dhq, 0) >= 3000).length;
    const draftByRound = {};
    (draftOutcomes || []).forEach(d => {
      const rd = num(d.round, 0);
      if (!rd) return;
      if (!draftByRound[rd]) draftByRound[rd] = { total: 0, hits: 0 };
      draftByRound[rd].total++;
      if (d.isHit || d.isStarter || num(d.dhq, 0) >= 3000) draftByRound[rd].hits++;
    });
    Object.values(draftByRound).forEach(row => {
      row.hitRate = round(pct(row.hits, row.total), 2);
    });

    return {
      schemaVersion: VERSION,
      sample: {
        teams: teamCount,
        tradeCount,
        ownersWithTrades: ownerCounts.filter(Boolean).length,
        draftPicks: (draftOutcomes || []).length,
        faabTransactions: (faabTxns || []).length || num(LI.totalFAABTxns, 0),
      },
      trade: {
        avgTradesPerOwner: round(avgTradesPerOwner, 1),
        avgOwnerValueDiff: Math.round(avgOwnerValueDiff),
        pickHeavyRate: round(pct(pickHeavy, tradeCount), 2),
        fairTradeRate: round(pct(fairTrades, tradeCount), 2),
        avgAssetsPerSide: sideCount ? round(totalAssets / sideCount, 1) : 0,
        timing,
      },
      draft: {
        hitRate: round(pct(draftHits, (draftOutcomes || []).length), 2),
        byRound: draftByRound,
      },
      confidence: tradeCount >= Math.max(6, teamCount / 2) ? 'high' : tradeCount >= 2 ? 'medium' : 'low',
    };
  }

  function buildOwnerBehaviorProfile(input) {
    const data = input || {};
    const rosterId = data.rosterId ?? data.roster_id ?? data.assessment?.rosterId;
    const ownerId = data.ownerId ?? data.owner_id ?? data.assessment?.ownerId;
    const ownerName = data.ownerName || data.assessment?.ownerName || `Owner ${rosterId || ''}`.trim();
    const LI = App.LI || {};
    const ownerProfiles = data.ownerProfiles || LI.ownerProfiles || {};
    const ownerProfile = data.ownerProfile || ownerProfiles[String(rosterId)] || {};
    const tradeHistory = data.tradeHistory || LI.tradeHistory || [];
    const baselines = data.baselines || buildLeagueBehaviorBaselines(data);
    const trades = (tradeHistory || []).filter(t => (t.roster_ids || Object.keys(t.sides || {})).some(rid => String(rid) === String(rosterId)));
    const tradeCount = num(ownerProfile.trades, trades.length);
    const totalGraded = num(ownerProfile.tradesWon, 0) + num(ownerProfile.tradesLost, 0) + num(ownerProfile.tradesFair, 0);
    const winRate = pct(ownerProfile.tradesWon, totalGraded);
    const lossRate = pct(ownerProfile.tradesLost, totalGraded);
    const fairRate = pct(ownerProfile.tradesFair, totalGraded);
    const avgTrades = Math.max(0.1, num(baselines.trade?.avgTradesPerOwner, 0.1));
    const activityRatio = tradeCount / avgTrades;
    const picksAcquired = num(ownerProfile.picksAcquired, 0);
    const picksSold = num(ownerProfile.picksSold, 0);
    const pickNet = picksAcquired - picksSold;
    const pickFlowTotal = picksAcquired + picksSold;
    const pickAppetite = pickFlowTotal ? round(pickNet / pickFlowTotal, 2) : 0;
    const avgValueDiff = num(ownerProfile.avgValueDiff, 0);
    const partners = ownerProfile.partners || {};
    const favoritePartner = Object.entries(partners).sort((a, b) => num(b[1], 0) - num(a[1], 0))[0] || null;
    const timing = ownerProfile.weekTiming || {};
    const timingRank = Object.entries({ early: timing.early || 0, mid: timing.mid || 0, late: timing.late || 0 }).sort((a, b) => b[1] - a[1])[0];
    const draftOutcomes = data.draftOutcomes || LI.draftOutcomes || [];
    const draftPicks = (draftOutcomes || []).filter(d => String(d.roster_id) === String(rosterId));
    const draftHits = draftPicks.filter(d => d.isHit || d.isStarter || num(d.dhq, 0) >= 3000).length;
    const draftHitRate = pct(draftHits, draftPicks.length);
    const dnaKey = data.dnaKey || data.dna?.key || ownerProfile.dnaKey || null;
    const dnaLabel = data.dnaLabel || data.dna?.label || ownerProfile.dna || dnaKey || 'Not set';
    const manualDna = !!data.manualDna;

    const observedFacts = [];
    observedFacts.push({
      code: 'trade_volume',
      label: 'Trade volume',
      detail: `${tradeCount} trades on file vs ${round(avgTrades, 1)} league average per owner.`,
      value: tradeCount,
      source: 'tradeHistory',
    });
    if (totalGraded > 0) {
      observedFacts.push({
        code: 'trade_results',
        label: 'Trade results',
        detail: `${Math.round(winRate * 100)}% won, ${Math.round(fairRate * 100)}% fair, ${Math.round(lossRate * 100)}% lost by DHQ value.`,
        value: { won: ownerProfile.tradesWon || 0, fair: ownerProfile.tradesFair || 0, lost: ownerProfile.tradesLost || 0 },
        source: 'ownerProfiles',
      });
    }
    observedFacts.push({
      code: 'trade_value',
      label: 'Average trade value',
      detail: `Average trade result: ${avgValueDiff >= 0 ? '+' : ''}${Math.round(avgValueDiff).toLocaleString()} DHQ.`,
      value: avgValueDiff,
      source: 'ownerProfiles',
    });
    if (pickFlowTotal > 0) {
      observedFacts.push({
        code: 'pick_flow',
        label: 'Pick flow',
        detail: `${picksAcquired} picks acquired / ${picksSold} picks sold.`,
        value: { acquired: picksAcquired, sold: picksSold },
        source: 'ownerProfiles',
      });
    }
    if (timingRank && timingRank[1] > 0) {
      observedFacts.push({
        code: 'timing',
        label: 'Trade timing',
        detail: `${timingRank[0][0].toUpperCase() + timingRank[0].slice(1)}-season mover (${timingRank[1]} trades).`,
        value: timing,
        source: 'ownerProfiles',
      });
    }
    if (draftPicks.length >= 3) {
      observedFacts.push({
        code: 'draft_hit_rate',
        label: 'Draft hit rate',
        detail: `${Math.round(draftHitRate * 100)}% draft hit rate across ${draftPicks.length} tracked picks.`,
        value: round(draftHitRate, 2),
        source: 'draftOutcomes',
      });
    }
    if (favoritePartner) {
      observedFacts.push({
        code: 'partner_concentration',
        label: 'Frequent partner',
        detail: `Most frequent partner is roster ${favoritePartner[0]} (${favoritePartner[1]} trades).`,
        value: { rosterId: favoritePartner[0], count: favoritePartner[1] },
        source: 'ownerProfiles.partners',
      });
    }

    const tags = [];
    if (activityRatio >= 1.6) tags.push('active-trader');
    if (activityRatio <= 0.55 && tradeCount > 0) tags.push('low-liquidity');
    if (winRate >= 0.5 && totalGraded >= 3) tags.push('value-hunter');
    if (fairRate >= 0.5 && totalGraded >= 3) tags.push('fair-dealer');
    if (lossRate >= 0.45 && totalGraded >= 3) tags.push('soft-market');
    if (pickAppetite >= 0.35) tags.push('pick-collector');
    if (pickAppetite <= -0.35) tags.push('pick-spender');
    if ((timing.late || 0) > Math.max(timing.early || 0, timing.mid || 0) && tradeCount >= 2) tags.push('late-season-mover');

    const liquidityScore = clamp(Math.round(35 + activityRatio * 32), 5, 95);
    const valueDemandScore = clamp(Math.round(50 + winRate * 35 - lossRate * 25 + avgValueDiff / 120), 5, 95);
    const confidence = tradeCount >= 6 ? 'high' : tradeCount >= 3 ? 'medium' : tradeCount > 0 ? 'low' : 'low';
    const offerFrame = tags.includes('pick-collector')
      ? 'Lead with picks or young assets; asking for picks back fights their observed behavior.'
      : tags.includes('pick-spender')
        ? 'Frame proven-player upgrades as the point; picks are spendable for this manager.'
        : tags.includes('fair-dealer')
          ? 'Keep the math clean and show why both sides improve.'
          : tags.includes('value-hunter')
            ? 'Do not lowball; they historically need visible surplus to move.'
            : tags.includes('low-liquidity')
              ? 'Expect slow movement; make one clean offer with a clear need fit.'
              : 'Use roster need and value clarity; no strong behavioral constraint dominates.';

    return {
      schemaVersion: VERSION,
      rosterId,
      ownerId,
      ownerName,
      sample: { trades: tradeCount, gradedTrades: totalGraded, draftPicks: draftPicks.length },
      observedFacts,
      inferences: tags,
      scores: {
        activityRatio: round(activityRatio, 2),
        liquidity: liquidityScore,
        valueDemand: valueDemandScore,
        pickAppetite,
        winRate: round(winRate, 2),
        fairRate: round(fairRate, 2),
        lossRate: round(lossRate, 2),
        draftHitRate: round(draftHitRate, 2),
      },
      dna: { key: dnaKey, label: dnaLabel, source: manualDna ? 'manual' : 'observed', confidence },
      strategy: { offerFrame },
      confidence,
    };
  }

  function buildOwnerBehaviorProfiles(input) {
    const data = input || {};
    const rosters = data.rosters || data.league?.rosters || App.S?.rosters || [];
    const baselines = data.baselines || buildLeagueBehaviorBaselines(data);
    const out = {};
    (rosters || []).forEach(roster => {
      const rosterId = roster.roster_id;
      out[String(rosterId)] = buildOwnerBehaviorProfile({
        ...data,
        rosterId,
        ownerId: roster.owner_id,
        baselines,
      });
    });
    return out;
  }

  function evaluateBehaviorTradeFit(input) {
    const data = input || {};
    const profile = data.behaviorProfile || data.profile || {};
    const tags = new Set(profile.inferences || []);
    const givePicks = data.givePicks || [];
    const receivePicks = data.receivePicks || [];
    const givePlayers = data.givePlayers || [];
    const receivePlayers = data.receivePlayers || [];
    const userGain = num(data.userGain, 0);
    let acceptanceDelta = 0;
    let scoreDelta = 0;
    const reasons = [];
    const evidence = [];
    const addReason = (code, detail, weight) => reasons.push(normalizeReason({ code, detail, weight }));

    if (tags.has('active-trader')) {
      acceptanceDelta += 6; scoreDelta += 5;
      addReason('partner_liquidity', `${profile.ownerName || 'This manager'} trades more than the league baseline, so outreach friction is lower.`, 0.9);
    }
    if (tags.has('low-liquidity')) {
      acceptanceDelta -= 10; scoreDelta -= 6;
      addReason('partner_liquidity', `${profile.ownerName || 'This manager'} trades below the league baseline; acceptance needs a cleaner offer.`, -0.8);
    }
    if (tags.has('pick-collector')) {
      if (givePicks.length > receivePicks.length) {
        acceptanceDelta += 8; scoreDelta += 7;
        addReason('pick_behavior', 'They historically collect picks; this offer leans into that preference.', 1);
      } else if (receivePicks.length > givePicks.length) {
        acceptanceDelta -= 9; scoreDelta -= 7;
        addReason('pick_behavior', 'They historically collect picks, so asking for picks back creates behavior friction.', -1);
      }
    }
    if (tags.has('pick-spender')) {
      if (givePlayers.length > receivePlayers.length && receivePicks.length >= givePicks.length) {
        acceptanceDelta += 6; scoreDelta += 5;
        addReason('pick_behavior', 'They historically spend picks for players; proven-player framing fits their pattern.', 0.8);
      }
    }
    if ((tags.has('value-hunter') || num(profile.scores?.valueDemand, 0) >= 70) && userGain > 0) {
      acceptanceDelta -= Math.min(12, Math.max(4, Math.round(userGain / 350)));
      scoreDelta -= 5;
      addReason('price_behavior', 'Their trade history shows value discipline, so a user-favorable deal needs extra justification.', -0.9);
    }
    if (tags.has('fair-dealer') && Math.abs(userGain) <= 500) {
      acceptanceDelta += 5; scoreDelta += 4;
      addReason('trade_tendency', 'Their history favors fair deals; this proposal stays inside that comfort zone.', 0.7);
    }
    if (tags.has('late-season-mover')) {
      addReason('trade_tendency', 'They have a late-season trade pattern; timing can matter as deadline pressure builds.', 0.4);
    }

    evidence.push(buildSourceEvidence({
      sourceKey: 'owner_behavior',
      source: 'Owner behavior',
      signal: 'observed_tags',
      value: profile.inferences || [],
      freshness: 'derived',
      present: !!(profile.inferences || []).length,
      detail: (profile.observedFacts || []).slice(0, 2).map(f => f.detail).join(' '),
    }));
    evidence.push(buildSourceEvidence({
      sourceKey: 'league_behavior',
      source: 'League baselines',
      signal: 'activity_ratio',
      value: profile.scores?.activityRatio,
      freshness: 'derived',
      present: profile.scores?.activityRatio != null,
    }));

    return {
      acceptanceDelta: clamp(acceptanceDelta, -18, 18),
      scoreDelta: clamp(scoreDelta, -12, 12),
      reasons,
      evidence,
      framing: profile.strategy?.offerFrame || '',
      confidence: profile.confidence || 'low',
    };
  }

  function normalizeReason(reason) {
    if (typeof reason === 'string') {
      return { code: reason, label: REASON_LABELS[reason] || reason, detail: '', weight: 1 };
    }
    const next = reason || {};
    const code = String(next.code || 'evidence_gap');
    return {
      code,
      label: next.label || REASON_LABELS[code] || code,
      detail: next.detail || '',
      weight: num(next.weight, 1),
    };
  }

  function normalizeEvidence(item) {
    const next = item || {};
    const def = getSourceDefinition(next.sourceKey || next.source);
    const source = next.source || def.label || 'unknown';
    const signal = next.signal || '';
    const freshness = next.freshness || '';
    const value = next.value;
    const present = next.present != null ? !!next.present : value != null && value !== '';
    const freshnessInfo = sourceFreshness(def.key, {
      freshness,
      updatedAt: next.updatedAt || next.refreshedAt,
      now: next.now,
      present,
    });
    let stale = next.stale != null ? !!next.stale : !!freshnessInfo.stale;
    if (typeof freshness === 'number') stale = freshness > 1000 * 60 * 60 * 24 * 7;
    if (typeof freshness === 'string' && /stale|old|unknown|missing/i.test(freshness)) stale = true;
    return {
      source,
      sourceKey: def.key,
      sourceLabel: next.sourceLabel || def.label,
      owner: next.owner || def.owner,
      category: next.category || def.category,
      accessMethod: next.accessMethod || def.accessMethod,
      licensePosture: next.licensePosture || def.licensePosture,
      productionStatus: next.productionStatus || def.productionStatus,
      signal,
      value,
      freshness: freshness || freshnessInfo.label,
      freshnessStatus: next.freshnessStatus || freshnessInfo.status,
      refreshedAt: next.refreshedAt || next.updatedAt || freshnessInfo.updatedAt || '',
      present,
      stale,
      detail: next.detail || '',
      entityId: next.entityId || '',
    };
  }

  function evidenceLabel(item) {
    const ev = normalizeEvidence(item);
    if (ev.detail) return ev.detail;
    const value = Array.isArray(ev.value) ? ev.value.join(', ') : ev.value;
    return [ev.signal || ev.source, value != null && value !== '' ? String(value) : 'present'].filter(Boolean).join(': ');
  }

  function applyConfidencePenalties(score, reasons, evidence) {
    let adjusted = num(score, 0);
    const nextReasons = (reasons || []).slice();
    const normalizedEvidence = (evidence || []).map(normalizeEvidence);
    const missingEvidence = normalizedEvidence.filter(ev => ev.present === false || ev.source === 'unknown').length;
    const staleEvidence = normalizedEvidence.filter(ev => ev.stale).length;
    if (!normalizedEvidence.length || missingEvidence) {
      adjusted -= !normalizedEvidence.length ? 18 : Math.min(18, missingEvidence * 8);
      nextReasons.push(normalizeReason({
        code: 'evidence_gap',
        detail: !normalizedEvidence.length ? 'No supporting evidence was attached to this recommendation.' : 'One or more expected evidence signals is missing.',
        weight: -1,
      }));
    }
    if (staleEvidence) {
      adjusted -= Math.min(14, staleEvidence * 7);
      nextReasons.push(normalizeReason({
        code: 'stale_data',
        detail: 'At least one supporting signal may be stale, so confidence is reduced.',
        weight: -0.75,
      }));
    }
    return {
      score: Math.max(0, Math.min(100, Math.round(adjusted))),
      reasons: nextReasons,
      evidence: normalizedEvidence,
    };
  }

  function confidenceFromScore(score, evidence, reasons) {
    const n = num(score, 0);
    const hasEvidence = Array.isArray(evidence) && evidence.length > 0;
    const hasPenalty = (reasons || []).some(reason => reason.code === 'evidence_gap' || reason.code === 'confidence_penalty');
    if (!hasEvidence || hasPenalty || n < 45) return 'low';
    if (n < 70) return 'medium';
    return 'high';
  }

  function createRecommendation(input) {
    const data = input || {};
    const baseReasons = (data.reasons || []).map(normalizeReason);
    const baseEvidence = (data.evidence || []).map(normalizeEvidence);
    const adjusted = applyConfidencePenalties(data.score, baseReasons, baseEvidence);
    const score = Math.max(0, Math.min(100, num(adjusted.score, 0)));
    const reasons = adjusted.reasons;
    const evidence = adjusted.evidence;

    return {
      schemaVersion: VERSION,
      id: data.id || '',
      type: data.type || 'general',
      subject: data.subject || {},
      action: data.action || 'review',
      score,
      confidence: data.confidence || confidenceFromScore(score, evidence, reasons),
      reasons,
      reasonCodes: reasons.map(reason => reason.code),
      evidence,
      context: data.context || data.contexts || null,
      clickTarget: data.clickTarget || null,
      copy: data.copy || '',
      display: {
        headline: data.headline || '',
        detail: data.detail || '',
        badge: data.badge || '',
      },
      alex: {
        summary: data.alexSummary || '',
      },
    };
  }

  function buildWaiverRecommendation(input) {
    const data = input || {};
    const player = data.player || data.subject || {};
    const pos = String(data.pos || player.position || player.pos || '').toUpperCase();
    const name = data.name || player.full_name || player.name || [player.first_name, player.last_name].filter(Boolean).join(' ') || String(data.id || data.pid || 'Player');
    const fit = data.fit || {};
    const faab = data.faab || null;
    const playerContext = data.playerContext || buildPlayerContext({
      ...data,
      player,
      pos,
      fit,
      dhq: data.dhq || data.value,
    });
    const formatReasons = data.formatReasons || playerContext.formatReasons || buildPlayerFormatReasons({ player, pos, profile: data.profile });
    const ppg = num(data.ppg, 0);
    const dhq = num(data.dhq || data.value, 0);
    const score = data.score != null
      ? data.score
      : Math.min(100, Math.round((num(fit.score, 2) * 18) + Math.min(35, dhq / 180) + Math.min(15, ppg * 1.2)));
    const needDetail = fit.need
      ? `Addresses your ${pos || 'roster'} ${fit.need.urgency || 'need'} and keeps the bid disciplined.`
      : data.windowDetail || 'Adds depth without forcing a major FAAB commitment.';
    const reasons = [
      { code: fit.need ? 'roster_need' : 'age_window', detail: needDetail, weight: fit.need ? 1.3 : 0.8 },
    ].concat(formatReasons || []);
    if (faab) reasons.push({ code: 'faab_efficiency', detail: `Suggested bid range ${faab.lo != null ? `$${faab.lo}-${faab.hi}` : 'is controlled'} against remaining FAAB.`, weight: 0.8 });
    if (ppg > 0) reasons.push({ code: 'production_signal', detail: `${ppg.toFixed ? ppg.toFixed(1) : ppg} PPG adds a production floor to the recommendation.`, weight: 0.7 });
    const evidence = [
      buildSourceEvidence({ sourceKey: 'league_roster', source: 'league.roster', signal: 'fit', value: fit.short || fit.label || (fit.need ? 'need' : 'depth'), freshness: 'live' }),
      buildSourceEvidence({ sourceKey: 'dhq', source: 'DHQ', signal: 'player_value', value: dhq, freshness: data.valueFreshness || 'live', present: dhq > 0, entityId: data.pid || player.id || '' }),
      buildSourceEvidence({ sourceKey: 'player_stats', source: 'stats', signal: 'ppg', value: ppg || null, freshness: data.statsFreshness || (ppg ? 'season' : 'missing'), present: ppg > 0, entityId: data.pid || player.id || '' }),
      buildSourceEvidence({ sourceKey: 'league_scoring', source: 'league.scoring_settings', signal: 'format_context', value: data.profile?.formatTags || [], freshness: 'live', present: !!data.profile }),
    ];
    if (faab) evidence.push(buildSourceEvidence({ sourceKey: 'league_roster', source: 'league.faab', signal: 'bid_range', value: `${faab.lo}-${faab.hi}`, freshness: 'live' }));
    return createRecommendation({
      id: data.id || `waiver_${data.pid || player.id || name}`,
      type: 'waiver',
      subject: { id: data.pid || player.id || data.id || '', name, pos },
      action: data.action || 'add',
      score,
      reasons,
      evidence,
      headline: name,
      detail: data.detail || [needDetail, (formatReasons || [])[0]?.detail].filter(Boolean).join(' '),
      badge: data.badge || fit.short || fit.label || 'Add',
      alexSummary: data.alexSummary || `${name} is a ${pos || 'roster'} add candidate because ${needDetail}`,
      clickTarget: data.clickTarget || null,
      context: {
        player: playerContext,
        leagueProfile: data.profile || playerContext.leagueProfile || null,
      },
    });
  }

  function buildTradeRecommendation(input) {
    const data = input || {};
    const partner = data.partner || {};
    const partnerName = data.partnerName || partner.ownerName || partner.teamName || 'trade partner';
    const userGain = num(data.userGain, 0);
    const likelihood = num(data.likelihood, 0);
    const fit = num(data.fit, 0);
    const confidenceScore = data.confidenceScore != null
      ? data.confidenceScore
      : Math.round(Math.max(0, Math.min(100, likelihood * 0.45 + fit * 0.25 + (50 + Math.max(-35, Math.min(35, userGain / 120))) * 0.30)));
    const formatReasons = data.formatReasons || [];
    const behaviorFit = data.behaviorFit || {};
    const behaviorProfile = data.behaviorProfile || {};
    const posture = data.posture || {};
    const reasons = [
      { code: userGain >= 0 ? 'value_edge' : 'deal_balance', detail: userGain >= 0 ? `You gain ${Math.round(userGain).toLocaleString()} DHQ in value.` : `You pay ${Math.abs(Math.round(userGain)).toLocaleString()} DHQ for fit or window leverage.` },
      { code: 'acceptance_fit', detail: `${likelihood}% modeled acceptance based on value, fit, and manager posture.` },
    ].concat(formatReasons, behaviorFit.reasons || data.behaviorReasons || []);
    if (posture.label || data.dnaLabel) reasons.push({ code: 'owner_behavior', detail: `${partnerName} profiles as ${posture.label || data.dnaLabel}; adjust offer framing accordingly.` });
    if (behaviorFit.framing) reasons.push({ code: 'trade_tendency', detail: behaviorFit.framing });
    if (data.whyAccept) reasons.push({ code: 'roster_need', detail: data.whyAccept });
    if (data.whyYou) reasons.push({ code: 'roster_surplus', detail: data.whyYou });
    const evidence = [
      buildSourceEvidence({ sourceKey: 'dhq', source: 'DHQ', signal: 'give_total', value: data.totals?.give?.total, freshness: 'live', present: data.totals?.give?.total > 0 }),
      buildSourceEvidence({ sourceKey: 'dhq', source: 'DHQ', signal: 'receive_total', value: data.totals?.receive?.total, freshness: 'live', present: data.totals?.receive?.total > 0 }),
      buildSourceEvidence({ sourceKey: 'owner_behavior', source: 'Owner DNA', signal: 'posture', value: posture.label || data.dnaLabel || null, freshness: 'derived', present: !!(posture.label || data.dnaLabel) }),
      buildSourceEvidence({ sourceKey: 'dhq', source: 'trade-engine', signal: 'acceptance_likelihood', value: likelihood, freshness: 'live', present: likelihood > 0 }),
      buildSourceEvidence({ sourceKey: 'league_scoring', source: 'league.scoring_settings', signal: 'format_context', value: data.profile?.formatTags || [], freshness: 'live', present: !!data.profile }),
    ].concat(behaviorFit.evidence || data.behaviorEvidence || []);
    if (behaviorProfile.sample?.trades != null) {
      evidence.push(buildSourceEvidence({
        sourceKey: 'owner_behavior',
        source: 'Owner behavior',
        signal: 'trade_sample',
        value: behaviorProfile.sample.trades,
        freshness: 'derived',
        present: behaviorProfile.sample.trades > 0,
        detail: (behaviorProfile.observedFacts || []).slice(0, 2).map(f => f.detail).join(' '),
      }));
    }
    return createRecommendation({
      id: data.id || `trade_${String(partnerName).replace(/\W+/g, '_').toLowerCase()}`,
      type: 'trade',
      subject: { id: data.partnerRosterId || data.partnerOwnerId || '', name: partnerName, label: `Trade with ${partnerName}` },
      action: data.action || 'propose',
      score: data.score != null ? data.score : confidenceScore,
      confidence: data.confidence ? String(data.confidence).toLowerCase() : undefined,
      reasons,
      evidence,
      headline: `Trade with ${partnerName}`,
      detail: data.detail || data.whyYou || data.whyAccept || 'Structured trade idea from DHQ and owner-fit signals.',
      badge: data.badge || `${likelihood}% accept`,
      alexSummary: data.alexSummary || `Trade with ${partnerName}: ${data.whyAccept || data.whyYou || 'value and fit are close enough to explore.'}`,
      clickTarget: data.clickTarget || null,
      context: {
        leagueProfile: data.profile || null,
        partnerBehavior: behaviorProfile || null,
        partnerTeam: data.partnerContext || null,
        userTeam: data.userContext || null,
      },
    });
  }

  function buildRosterRecommendation(input) {
    const data = input || {};
    const player = data.player || {};
    const pos = String(data.pos || player.position || '').toUpperCase();
    const name = data.name || player.full_name || player.name || [player.first_name, player.last_name].filter(Boolean).join(' ') || 'Player';
    const dhq = num(data.dhq, 0);
    const trend = num(data.trend, 0);
    const peakYrs = num(data.peakYrs, 0);
    const valueYrs = num(data.valueYrs, 0);
    const playerContext = data.playerContext || buildPlayerContext({
      ...data,
      player,
      pos,
      dhq,
      trend,
      peakYrs,
      valueYrs,
    });
    const formatReasons = data.formatReasons || playerContext.formatReasons || buildPlayerFormatReasons({ player, pos, profile: data.profile });
    let action = data.action || 'hold';
    if (!data.action) {
      if (valueYrs <= 0 || (peakYrs <= 1 && dhq >= 3000)) action = 'sell';
      else if (peakYrs >= 4 && dhq < 4000) action = 'target';
      else if (dhq >= 6500 && peakYrs >= 2) action = 'hold';
    }
    const reasons = [
      { code: 'age_window', detail: data.windowDetail || `${peakYrs} peak years and ${valueYrs} value years remain by the current age curve.` },
    ].concat(formatReasons);
    if (trend >= 15) reasons.push({ code: 'market_rising', detail: `Production trend is up ${Math.round(trend)}%.` });
    if (trend <= -15) reasons.push({ code: 'market_falling', detail: `Production trend is down ${Math.abs(Math.round(trend))}%.` });
    const evidence = [
      buildSourceEvidence({ sourceKey: 'dhq', source: 'DHQ', signal: 'player_value', value: dhq, freshness: 'live', present: dhq > 0, entityId: data.pid || player.id || '' }),
      buildSourceEvidence({ sourceKey: 'age_curve', source: 'age_curve', signal: 'peak_years', value: peakYrs, freshness: 'static', entityId: data.pid || player.id || '' }),
      buildSourceEvidence({ sourceKey: 'player_meta', source: 'player_meta', signal: 'trend', value: trend, freshness: data.trendFreshness || (trend ? 'season' : 'missing'), present: trend !== 0, entityId: data.pid || player.id || '' }),
      buildSourceEvidence({ sourceKey: 'league_scoring', source: 'league.scoring_settings', signal: 'format_context', value: data.profile?.formatTags || [], freshness: 'live', present: !!data.profile }),
    ];
    return createRecommendation({
      id: data.id || `roster_${data.pid || player.id || name}`,
      type: 'roster',
      subject: { id: data.pid || player.id || '', name, pos },
      action,
      score: data.score != null ? data.score : Math.min(100, Math.max(35, Math.round((dhq / 90) + peakYrs * 4 + (trend > 0 ? trend / 3 : 0)))),
      reasons,
      evidence,
      headline: name,
      detail: data.detail || reasons[0].detail,
      badge: data.badge || action,
      alexSummary: data.alexSummary || `${name}: ${action} based on value window, DHQ, and league format.`,
      clickTarget: data.clickTarget || null,
      context: {
        player: playerContext,
        leagueProfile: data.profile || playerContext.leagueProfile || null,
      },
    });
  }

  function buildDraftRecommendation(input) {
    const data = input || {};
    const sourceKey = normalizeSourceKey(data.sourceKey || data.source || 'manual_import');
    const sourceDef = getSourceDefinition(sourceKey);
    return createRecommendation({
      id: data.id || `draft_${data.pick || data.subject?.id || Date.now()}`,
      type: 'draft',
      subject: data.subject || { id: data.pick || '', name: data.playerName || data.pick || 'Draft recommendation' },
      action: data.action || 'target',
      score: data.score != null ? data.score : 60,
      reasons: data.reasons || [{ code: 'value_edge', detail: data.detail || 'Draft value is favorable relative to roster need.' }],
      evidence: data.evidence || [buildSourceEvidence({ sourceKey, source: data.source || sourceDef.label || 'draft-board', signal: data.signal || 'rank', value: data.rank, freshness: data.freshness || 'live', present: data.rank != null })],
      headline: data.headline || data.playerName || String(data.pick || 'Draft target'),
      detail: data.detail || '',
      badge: data.badge || 'Draft',
      clickTarget: data.clickTarget || null,
    });
  }

  function buildMarketAlertRecommendation(input) {
    const data = input || {};
    const rising = num(data.trend, 0) >= 0;
    const sourceKey = normalizeSourceKey(data.sourceKey || data.source || 'fantasycalc');
    const sourceDef = getSourceDefinition(sourceKey);
    return createRecommendation({
      id: data.id || `market_${data.subject?.id || data.name || Date.now()}`,
      type: 'market',
      subject: data.subject || { id: data.id || '', name: data.name || 'Market alert' },
      action: data.action || (rising ? 'target' : 'shop'),
      score: data.score != null ? data.score : Math.min(100, Math.max(30, 55 + Math.abs(num(data.trend, 0)))),
      reasons: data.reasons || [{ code: rising ? 'market_rising' : 'market_falling', detail: data.detail || `Market trend moved ${num(data.trend, 0)}.` }],
      evidence: data.evidence || [buildSourceEvidence({ sourceKey, source: data.source || sourceDef.label || 'market', signal: data.signal || 'trend', value: data.trend, freshness: data.freshness || 'daily', updatedAt: data.updatedAt, present: data.trend != null })],
      headline: data.headline || data.name || 'Market alert',
      detail: data.detail || '',
      badge: data.badge || (rising ? 'Rising' : 'Falling'),
      clickTarget: data.clickTarget || null,
    });
  }

  function buildBehavioralRecommendation(input) {
    const data = input || {};
    const focus = data.focus || data.insight?.focus || 'gmStyle';
    const severity = String(data.severity || data.insight?.severity || 'pattern').toLowerCase();
    const confidenceScore = data.score != null ? data.score : num(data.confidence || data.insight?.confidence, 65);
    const title = data.title || data.insight?.title || 'Behavioral read';
    const body = data.body || data.insight?.body || data.detail || '';
    const actionBySeverity = {
      warning: 'review',
      edge: 'exploit',
      pattern: 'monitor',
      opportunity: 'act',
    };
    const focusLabel = {
      trades: 'trade behavior',
      waivers: 'waiver behavior',
      draft: 'draft behavior',
      startSit: 'lineup behavior',
      injury: 'injury behavior',
      streaming: 'streaming behavior',
      gmStyle: 'GM style',
    }[focus] || 'manager behavior';
    const reasons = data.reasons || [
      { code: 'behavioral_pattern', detail: body || `${title} reflects a repeatable ${focusLabel} signal.` },
      { code: 'decision_history', detail: `Based on ${focusLabel} and available decision history.` },
    ];
    const evidence = data.evidence || [
      buildSourceEvidence({ sourceKey: 'decision_history', source: 'decision-history', signal: focus, value: data.value || title, freshness: data.freshness || 'live', present: true, detail: data.evidenceDetail || `${focusLabel} signal from available decision history.` }),
      buildSourceEvidence({ sourceKey: 'decision_history', source: 'alex-insights', signal: 'confidence', value: confidenceScore, freshness: 'derived', present: confidenceScore > 0 }),
      buildSourceEvidence({ sourceKey: 'league_scoring', source: 'league.scoring_settings', signal: 'format_context', value: data.profile?.formatTags || [], freshness: 'live', present: !!data.profile }),
    ];

    return createRecommendation({
      id: data.id || `behavior_${String(focus).toLowerCase()}_${String(title).replace(/\W+/g, '_').toLowerCase().slice(0, 48)}`,
      type: 'behavioral',
      subject: data.subject || { id: focus, name: title, label: focusLabel },
      action: data.action || actionBySeverity[severity] || 'review',
      score: confidenceScore,
      reasons,
      evidence,
      headline: title,
      detail: body,
      badge: data.badge || severity,
      alexSummary: data.alexSummary || `${title}: ${body}`,
      clickTarget: data.clickTarget || null,
    });
  }

  function recommendationWhyLines(rec, limit) {
    const item = rec || {};
    const reasonLines = (item.reasons || [])
      .map(reason => reason.detail || reason.label)
      .filter(Boolean);
    const evidenceLines = (item.evidence || [])
      .filter(ev => ev.present !== false)
      .map(evidenceLabel)
      .filter(Boolean);
    return unique(reasonLines.concat(evidenceLines)).slice(0, limit || 4);
  }

  function buildWhyView(input, options) {
    const opts = options || {};
    const item = input?.recommendation || input?.intelligence || input || {};
    const lines = recommendationWhyLines(item, opts.limit || 4);
    const reasons = (item.reasons || []).map(normalizeReason);
    const evidence = (item.evidence || []).map(normalizeEvidence);
    const primaryReason = reasons.find(reason => reason.detail || reason.label) || null;
    const confidence = item.confidence || confidenceFromScore(item.score, evidence, reasons);
    return {
      schemaVersion: VERSION,
      title: opts.title || 'Why this?',
      subject: item.subject || {},
      action: item.action || '',
      score: item.score,
      confidence,
      badge: item.display?.badge || item.badge || confidence,
      headline: item.display?.headline || item.subject?.name || item.subject?.label || '',
      summary: item.alex?.summary || summarizeRecommendation(item),
      reasonCodes: item.reasonCodes || reasons.map(reason => reason.code),
      primary: primaryReason,
      chips: reasons.slice(0, opts.chipLimit || 4).map(reason => ({
        code: reason.code,
        label: reason.label,
        detail: reason.detail,
        tone: reason.weight < 0 ? 'caution' : reason.weight >= 1 ? 'strong' : 'context',
      })),
      lines,
      evidence: evidence.filter(ev => ev.present !== false).slice(0, opts.evidenceLimit || 4),
      missingEvidence: evidence.filter(ev => ev.present === false).map(ev => ev.signal || ev.source),
      sources: sourceSummaryForEvidence(evidence),
      stale: evidence.some(ev => ev.stale),
      ariaLabel: [
        opts.title || 'Why this recommendation',
        item.subject?.name || item.subject?.label,
        lines[0],
      ].filter(Boolean).join(': '),
    };
  }

  function chipLabel(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  function leagueProfileFromRecommendation(item, opts) {
    return opts.profile
      || item.context?.leagueProfile
      || item.context?.player?.leagueProfile
      || item.context?.team?.leagueProfile
      || item.context?.userTeam?.leagueProfile
      || item.context?.partnerTeam?.leagueProfile
      || null;
  }

  function buildRecommendationContract(input, options) {
    const opts = options || {};
    const item = input?.recommendation || input?.intelligence || input || {};
    const why = buildWhyView(item, opts);
    const evidence = (item.evidence || []).map(normalizeEvidence);
    const presentEvidence = evidence.filter(ev => ev.present !== false);
    const missingEvidence = evidence.filter(ev => ev.present === false);
    const profile = leagueProfileFromRecommendation(item, opts);
    const formatTags = profile?.formatTags || item.context?.formatTags || [];
    const visibleFormatTags = (formatTags || []).map(chipLabel).filter(label => label && !/^\d+$/.test(label));
    const scoreLabel = Number.isFinite(num(item.score, NaN)) ? `${Math.round(num(item.score, 0))} score` : '';
    const contextChips = unique([
      item.type ? chipLabel(item.type) : '',
      item.action ? chipLabel(item.action) : '',
      why.confidence ? `${chipLabel(why.confidence)} confidence` : '',
      scoreLabel,
      ...visibleFormatTags.slice(0, 4),
      profile?.leagueId ? 'League profile' : '',
    ].filter(Boolean)).slice(0, opts.contextChipLimit || 6);
    const sources = why.sources || sourceSummaryForEvidence(evidence);
    const clickTarget = opts.clickTarget || item.clickTarget || item.context?.clickTarget || null;

    return {
      schemaVersion: VERSION,
      type: 'recommendation_contract',
      recommendationId: item.id || '',
      subject: why.subject,
      action: why.action,
      score: why.score,
      confidence: why.confidence,
      badge: why.badge,
      headline: why.headline,
      summary: why.summary,
      lines: why.lines,
      chips: why.chips,
      contextChips,
      evidence: presentEvidence.slice(0, opts.evidenceLimit || 4),
      missingEvidence: missingEvidence.map(ev => ev.signal || ev.source || ev.sourceKey).filter(Boolean),
      sources,
      stale: why.stale,
      clickTarget,
      truth: {
        grounded: presentEvidence.length > 0 && why.lines.length > 0,
        hasLeagueContext: !!profile,
        hasEvidence: presentEvidence.length > 0,
        hasClickTarget: !!clickTarget,
        sourceCount: sources.length,
        missingEvidenceCount: missingEvidence.length,
      },
      ariaLabel: why.ariaLabel,
    };
  }

  function publishRecommendations(scope, recommendations, options) {
    const key = String(scope || 'global');
    const ranked = rankRecommendations((recommendations || []).filter(Boolean));
    recommendationStore[key] = {
      scope: key,
      updatedAt: new Date().toISOString(),
      recommendations: ranked,
      meta: options || {},
    };
    App.IntelligenceRecommendations = recommendationStore;
    return ranked;
  }

  function getRecommendations(scope) {
    if (scope) return (recommendationStore[String(scope)]?.recommendations || []).slice();
    return Object.values(recommendationStore).flatMap(entry => entry.recommendations || []);
  }

  function topRecommendations(options) {
    const opts = options || {};
    return rankRecommendations(getRecommendations(opts.scope)).slice(0, opts.limit || 8);
  }

  function sourceSummaryForEvidence(evidence) {
    return unique((evidence || [])
      .map(normalizeEvidence)
      .filter(ev => ev.present !== false)
      .map(ev => ev.sourceLabel || ev.source)
      .filter(Boolean))
      .slice(0, 6);
  }

  function buildAlexRecommendationDigest(options) {
    return topRecommendations(options).map(rec => ({
      type: rec.type,
      action: rec.action,
      subject: rec.subject?.name || rec.subject?.label || '',
      score: rec.score,
      confidence: rec.confidence,
      summary: rec.alex?.summary || summarizeRecommendation(rec),
      why: recommendationWhyLines(rec, 3),
      sources: sourceSummaryForEvidence(rec.evidence),
      stale: (rec.evidence || []).map(normalizeEvidence).some(ev => ev.stale),
    }));
  }

  function summarizeRecommendation(rec) {
    const item = rec || {};
    const subject = item.subject?.name || item.subject?.label || item.subject?.id || 'Recommendation';
    const reason = (item.reasons || [])[0];
    const detail = reason?.detail || reason?.label || item.display?.detail || '';
    return detail ? `${subject}: ${detail}` : String(subject);
  }

  function rankRecommendations(recommendations) {
    return (recommendations || []).slice().sort((a, b) => {
      const scoreDiff = num(b.score, 0) - num(a.score, 0);
      if (scoreDiff) return scoreDiff;
      return (CONFIDENCE_RANK[b.confidence] || 0) - (CONFIDENCE_RANK[a.confidence] || 0);
    });
  }

  function buildContextBlock(input) {
    const data = input || {};
    const leagueProfile = data.leagueProfile || buildLeagueProfile(data);
    const recommendations = rankRecommendations(data.recommendations || []).slice(0, data.limit || 8);
    const block = {
      schemaVersion: VERSION,
      leagueProfile,
      recommendations,
      summaries: recommendations.map(summarizeRecommendation),
      sourceSummary: unique(recommendations.flatMap(rec => sourceSummaryForEvidence(rec.evidence))).slice(0, 10),
    };
    if (data.includeSourceRegistry) block.sourceRegistry = getSourceRegistry();
    return block;
  }

  App.IntelligenceSources = SOURCE_REGISTRY;
  App.Intelligence = {
    VERSION,
    REASON_LABELS,
    SOURCE_REGISTRY,
    recommendationStore,
    getSourceRegistry,
    getSourceDefinition,
    normalizeSourceKey,
    sourceFreshness,
    buildSourceEvidence,
    sourceSummaryForEvidence,
    buildFantasyCalcRequest,
    normalizeFantasyCalcRow,
    buildFantasyCalcSnapshot,
    fetchFantasyCalcSnapshot,
    normalizeScoring,
    buildLeagueProfile,
    buildMarketCompatibility,
    buildFormatBadges,
    buildPlayerFormatReasons,
    buildPlayerContext,
    buildTeamContext,
    describeLeagueProfile,
    buildLeagueBehaviorBaselines,
    buildOwnerBehaviorProfile,
    buildOwnerBehaviorProfiles,
    evaluateBehaviorTradeFit,
    createRecommendation,
    buildWaiverRecommendation,
    buildTradeRecommendation,
    buildRosterRecommendation,
    buildDraftRecommendation,
    buildMarketAlertRecommendation,
    buildBehavioralRecommendation,
    recommendationWhyLines,
    buildWhyView,
    buildRecommendationContract,
    publishRecommendations,
    getRecommendations,
    topRecommendations,
    buildAlexRecommendationDigest,
    rankRecommendations,
    summarizeRecommendation,
    buildContextBlock,
  };

  root.IntelligenceContext = App.Intelligence;
})(typeof window !== 'undefined' ? window : globalThis);
