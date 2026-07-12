// shared/rookie-data.js
// Canonical rookie/prospect data source for ReconAI and War Room.

(function() {
  window.App = window.App || {};

  // Same-origin by default. The rookie CSVs are vendored from dhq-shared into each
  // app's own deploy (War Room: draft-war-room/; ReconAI: public/draft-war-room/ →
  // served at <base>/draft-war-room/), so neither app fetches them cross-repo at
  // runtime. A bare relative base resolves against the page's baseURI, which is the
  // app root for both apps' top-level pages. War Room sets window.ROOKIE_DATA_BASE
  // (shared-loader) and ReconAI sets it (main.js) for explicit, page-independent
  // resolution; this default is the fallback.
  const DEFAULT_DATA_BASE = 'draft-war-room';
  const POS_MAP = {
    ED: 'DL', EDGE: 'DL', DE: 'DL', DT: 'DL', IDL: 'DL', NT: 'DL',
    ILB: 'LB', OLB: 'LB', MLB: 'LB',
    CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB',
    OT: 'OL', IOL: 'OL', OG: 'OL', G: 'OL', C: 'OL', T: 'OL',
  };
  const FANTASY_MULT = {
    QB: 2.0, RB: 1.9, WR: 1.75, TE: 1.5, K: 0.5,
    DE: 0.35, ED: 0.35, EDGE: 0.35, OLB: 0.35,
    LB: 0.30, ILB: 0.30, MLB: 0.30,
    DB: 0.25, S: 0.25, CB: 0.25, FS: 0.25, SS: 0.25,
    DL: 0.2, DT: 0.2, IDL: 0.2, NT: 0.2,
    OT: 0.15, T: 0.15, IOL: 0.15, OG: 0.15, G: 0.15, C: 0.15, OL: 0.15,
    P: 0.2,
  };
  const DRAFT_POS_VALUES = {
    QB: 1.5, EDGE: 1.3, ED: 1.3, DE: 1.3, OT: 1.25, T: 1.25, WR: 1.2,
    CB: 1.15, DT: 1.1, DL: 1.1, IDL: 1.1, LB: 1.05, ILB: 1.05,
    OLB: 1.05, S: 1.0, TE: 0.95, IOL: 0.9, OG: 0.9, G: 0.9,
    C: 0.9, RB: 0.85, K: 0.5, P: 0.5,
  };
  const VET_OFFSETS = {
    QB: 15, RB: 6, WR: 12, TE: 7, K: 3,
    DL: 12, LB: 10, DB: 12, OL: 20,
  };
  const VET_OFFSETS_ONE_QB = { ...VET_OFFSETS, QB: 24 };
  // IDP rookie value (DL/LB/DB): post-draft, blend a draft-capital cohort with the
  // scouting cohort. The defensive ladders are deep (hundreds rostered), so mapping a
  // rookie by in-class scouting rank alone let late-round defenders inherit rosterable-
  // veteran value (a R7 DL was landing ~1,450, ~93% of a R1). Anchoring the capital
  // cohort to the league's startable pool (teams × starters) maps R1 to the top of the
  // pool and steps each later round deeper; the scouting weight keeps a well-scouted
  // faller ahead of a same-round reach. Pre-draft (no round/pick) IDP fall back to 100%
  // scouting, so the Big Board still works before the NFL draft happens.
  const IDP_LADDER_POSITIONS = new Set(['DL', 'LB', 'DB']);
  const IDP_ROUND_POOL_MULT = { 1: 0.3, 2: 0.6, 3: 1.0, 4: 1.4, 5: 1.9, 6: 2.5, 7: 3.2 };
  const IDP_CAPITAL_WEIGHT = 0.8; // 80% draft capital / 20% scouting, post-draft
  // OFFENSE rookie ceiling (QB/RB/WR/TE), post-draft only. The veteran scoutVal maps a
  // rookie onto the position ladder by in-class posRank, which on thin/shallow offense
  // classes lets a late-round rookie land on a rosterable veteran's score (a R7 QB was
  // getting ~3,900 ≈ QB18). Cap scoutVal at a ceiling implied by NFL draft capital: each
  // round maps to a fraction of the position ladder's depth (R1 ≈ top → never binds on
  // elites; R7 ≈ deep → collapses toward base). Floored by the capital-aware
  // baseDynastyValue so a well-scouted faller never drops below its own base. Strictly
  // increasing in round → the ceiling is monotone non-increasing by capital. This is the
  // offense analog of the IDP capital cohort, tuned to the SHALLOW offense ladders (a
  // depth fraction rather than teams×starters×mult). Pre-draft and IDP are untouched.
  const OFFENSE_ROUND_CEIL_FRAC = { 1: 0.05, 2: 0.12, 3: 0.22, 4: 0.35, 5: 0.52, 6: 0.72, 7: 0.95 };

  const cache = {
    loaded: false,
    loading: null,
    count: 0,
    prospects: {},
    byName: {},
    order: [],
    sourceBase: '',
  };

  function normPos(pos) {
    const upper = String(pos || '').trim().toUpperCase();
    if (!upper) return '';
    if (typeof window.App?.normPos === 'function') return window.App.normPos(upper);
    return POS_MAP[upper] || upper;
  }

  function normName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function stripSuffix(name) {
    return String(name || '').replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '').trim();
  }

  function aliasKeys(name) {
    const key = normName(name);
    if (!key) return [];
    const noSuffix = stripSuffix(key);
    const keys = new Set([key, noSuffix]);
    const parts = noSuffix.split(' ').filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      keys.add(`${first} ${last}`);
      keys.add(`${first[0]} ${last}`);
    }
    return [...keys].filter(Boolean);
  }

  function parseNum(value, fallback = null) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function parseIntSafe(value, fallback = null) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function parseCSV(text) {
    const rows = [];
    const source = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!source) return rows;
    const lines = source.split('\n');
    const headers = splitCSVLine(lines.shift()).map(h => h.trim());
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const vals = splitCSVLine(line);
      const obj = { _rowIndex: index + 1 };
      headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
      rows.push(obj);
    });
    return rows;
  }

  function splitCSVLine(line) {
    const vals = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (ch === '"' && quoted && next === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        vals.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    vals.push(cur);
    return vals;
  }

  function resolveDataBase() {
    const params = new URLSearchParams(window.location.search || '');
    const explicit = params.get('rookieDataBase') || window.ROOKIE_DATA_BASE;
    if (explicit) return String(explicit).replace(/\/$/, '');
    return DEFAULT_DATA_BASE;
  }

  async function fetchText(pathOptions) {
    const options = Array.isArray(pathOptions) ? pathOptions : [pathOptions];
    for (const url of options) {
      try {
        const res = await fetch(url);
        if (res.ok) return await res.text();
      } catch (_err) {
        // Try the next source.
      }
    }
    return '';
  }

  function calcTier(rank) {
    if (rank <= 10) return 1;
    if (rank <= 32) return 2;
    if (rank <= 64) return 3;
    if (rank <= 100) return 4;
    if (rank <= 150) return 5;
    if (rank <= 224) return 6;
    return 7;
  }

  function calcTierLabel(rank) {
    if (rank <= 5) return 'ELITE';
    if (rank <= 15) return 'BLUE_CHIP';
    if (rank <= 32) return 'R1';
    if (rank <= 64) return 'R2';
    if (rank <= 100) return 'R3';
    if (rank <= 160) return 'DAY3';
    return 'UDFA';
  }

  function calcGrade(rank) {
    if (rank <= 5) return +(9.0 + (6 - rank) * 0.2).toFixed(1);
    if (rank <= 10) return +(8.5 + (11 - rank) * 0.1).toFixed(1);
    if (rank <= 32) return +(7.0 + (33 - rank) * 0.07).toFixed(1);
    if (rank <= 64) return +(6.0 + (65 - rank) * 0.03).toFixed(1);
    if (rank <= 100) return +(5.0 + (101 - rank) * 0.03).toFixed(1);
    if (rank <= 224) return +(3.0 + (225 - rank) * 0.016).toFixed(1);
    return +Math.max(1.0, 3.0 - (rank - 224) * 0.01).toFixed(1);
  }

  function calcDraftScore(rank, pos) {
    const posValue = DRAFT_POS_VALUES[String(pos || '').toUpperCase()] || 1.0;
    const baseScore = Math.max(0, (250 - rank) / 25);
    return Math.round(baseScore * posValue * 100) / 100;
  }

  function rankToTierBase(rank) {
    if (!rank || rank > 250) return 0.5;
    if (rank <= 5) return 95 - (rank - 1) * 4;
    if (rank <= 10) return 75 - (rank - 6) * 4;
    if (rank <= 20) return 55 - (rank - 11) * 2.5;
    if (rank <= 32) return 30 - (rank - 21) * 1.5;
    if (rank <= 50) return 12 - (rank - 33) * 0.4;
    if (rank <= 100) return 5 - (rank - 51) * 0.07;
    if (rank <= 150) return 1.5 - (rank - 101) * 0.02;
    if (rank <= 224) return Math.max(0.1, 0.5 - (rank - 151) * 0.005);
    return 0.1;
  }

  function pickToBase(pick, isUDFA, hasTeam) {
    if (pick) {
      if (pick <= 5) return 100;
      if (pick <= 15) return 80 - (pick - 6) * 1.5;
      if (pick <= 32) return 60 - (pick - 16) * 2;
      if (pick <= 64) return 28 - (pick - 33) * 0.5;
      if (pick <= 100) return 12 - (pick - 65) * 0.15;
      if (pick <= 140) return 6 - (pick - 101) * 0.07;
      if (pick <= 180) return 3 - (pick - 141) * 0.04;
      if (pick <= 220) return 1.3 - (pick - 181) * 0.02;
      return 0.4;
    }
    if (isUDFA && hasTeam) return 0.6;
    return 0.1;
  }

  function valueRankToDraftCapital(rank, pos) {
    return calcDraftScore(Number(rank) || 999, pos || '');
  }

  function valueRankToDynastyBase(rank, pos, customMult) {
    const rawPos = String(pos || '').toUpperCase();
    const mult = customMult || FANTASY_MULT[rawPos] || FANTASY_MULT[normPos(rawPos)] || 0.3;
    return Math.min(10000, Math.round(rankToTierBase(Number(rank) || 999) * mult * 60));
  }

  function getPhotoUrl(name, enrichment) {
    if (enrichment.photoUrl) return enrichment.photoUrl;
    if (enrichment.espnId) return `https://a.espncdn.com/i/headshots/college-football/players/full/${enrichment.espnId}.png`;
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=ca8a04&color=1e293b&size=128&bold=true`;
  }

  function getInitials(name) {
    return String(name || '').split(/\s+/).map(part => part[0] || '').join('').toUpperCase().slice(0, 2);
  }

  function getHighlightUrl(name, school) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} ${school || ''} football highlights 2025`)}`;
  }

  function buildEnrichmentMap(rows) {
    const map = {};
    rows.forEach(row => {
      const key = normName(row.name || row.Name);
      if (!key) return;
      const roundRaw = String(row.draft_round || '').trim();
      const draftRound = roundRaw && roundRaw.toUpperCase() !== 'UDFA' ? parseIntSafe(roundRaw) : null;
      const draftPick = parseIntSafe(row.draft_pick);
      map[key] = {
        displayName: row.name || row.Name || '',
        previousRank: parseIntSafe(row.Rank),
        school: row.school || row.College || '',
        espnId: row.espn_id || '',
        photoUrl: row.photo_url || '',
        summary: row.summary || '',
        year: row.year || '',
        size: row.size || '',
        weight: row.weight || '',
        speed: row.speed || '',
        fantasyMultiplier: parseNum(row.fantasyMultiplier),
        nflTeam: String(row.nfl_team || '').trim(),
        draftRound,
        draftPick: draftPick && draftPick > 0 ? draftPick : null,
        isUDFA: roundRaw.toUpperCase() === 'UDFA',
        pos: String(row.pos || '').trim().toUpperCase(),
      };
    });
    return map;
  }

  function buildMockMap(rows) {
    const map = {};
    rows.forEach(row => {
      const key = normName(row['Player Name'] || row.Name || row.name);
      if (!key) return;
      map[key] = {
        rank: parseIntSafe(row.Rank),
        pos: String(row.Position || row.Pos || row.pos || '').trim().toUpperCase(),
        school: row.College || row.school || '',
      };
    });
    return map;
  }

  // Only sources we've confirmed the provenance of feed the consensus. The
  // dropped columns (BR, DT, SIS, SD) were unverified abbreviations. ATH is
  // The Athletic / Dane Brugler's "The Beast".
  const VERIFIED_SOURCES = new Set(['ath', 'cbs', 'espn', 'pff', 'pfn', 'tank']);

  function sourceColumns(rows) {
    if (!rows.length) return [];
    return Object.keys(rows[0]).filter(col => VERIFIED_SOURCES.has(col.toLowerCase()));
  }

  function buildSourceRanks(row, cols) {
    const sources = [];
    cols.forEach(col => {
      const val = parseIntSafe(row[col]);
      if (val && val > 0) sources.push({ source: col, rank: val, weight: 1.0 });
    });
    return sources;
  }

  function buildProspect(row, index, sourceCols, enrichMap, mockMap) {
    const name = (row.Name || row.name || row.Player || row.player || row['Player Name'] || '').trim();
    if (!name) return null;
    const key = normName(name);
    const enrich = enrichMap[key] || {};
    const mock = mockMap[key] || {};
    const rawPos = String(row.Pos || row.pos || row.Position || row.position || mock.pos || enrich.pos || '').trim().toUpperCase();
    const mappedPos = normPos(rawPos);
    const rank = parseIntSafe(row.Rank || row.rank || row.RANK || mock.rank, index + 1);
    const sources = buildSourceRanks(row, sourceCols);
    const sourceRanks = {};
    sources.forEach(src => { sourceRanks[src.source] = src.rank; });
    // Recompute the consensus from the verified sources only. Do NOT trust the
    // precomputed Avg column — it was averaged across the dropped sources too.
    let consensusRank;
    if (sources.length) {
      const totalWeight = sources.reduce((sum, src) => sum + (src.weight || 1), 0);
      consensusRank = sources.reduce((sum, src) => sum + src.rank * (src.weight || 1), 0) / totalWeight;
    } else {
      consensusRank = parseNum(row.Avg) || rank;
    }
    consensusRank = Math.round((consensusRank || rank) * 10) / 10;
    const school = enrich.school || row.School || row.school || row.College || row.college || mock.school || '';
    const fantasyMultiplier = enrich.fantasyMultiplier || FANTASY_MULT[rawPos] || FANTASY_MULT[mappedPos] || 0.3;
    const rankValue = Math.min(10000, Math.round(rankToTierBase(rank) * fantasyMultiplier * 60));
    const draftCapitalValue = Math.min(10000, Math.round(pickToBase(enrich.draftPick, enrich.isUDFA, !!enrich.nflTeam) * fantasyMultiplier * 60));
    const baseDynastyValue = Math.min(10000, Math.round(rankValue * 0.6 + draftCapitalValue * 0.4));
    const previousRank = enrich.previousRank || null;
    const rankChange = previousRank && previousRank !== rank ? previousRank - rank : 0;
    const grade = calcGrade(rank);

    return {
      id: parseIntSafe(row.id, index + 1),
      pid: `csv_${key.replace(/[^a-z0-9]/g, '_')}`,
      name,
      pos: mappedPos || rawPos,
      rawPos,
      mappedPos,
      position: mappedPos || rawPos,
      college: school,
      school,
      rank,
      previousRank,
      rankChange,
      consensusRank,
      avgRank: consensusRank,
      fantasyRank: Math.max(1, Math.round(rank / fantasyMultiplier)),
      rookiePosRank: null,
      tier: calcTier(rank),
      tierLabel: calcTierLabel(consensusRank),
      tierNum: calcTier(rank),
      grade,
      isGenerational: rank <= 5 && grade >= 9,
      draftScore: calcDraftScore(rank, rawPos),
      fantasyMultiplier,
      fantasyMult: fantasyMultiplier,
      rankValue,
      draftCapitalValue,
      dynastyValue: baseDynastyValue,
      baseDynastyValue,
      sources,
      sourceRanks,
      sourceCount: sources.length || 1,
      photoUrl: getPhotoUrl(name, enrich),
      espnId: enrich.espnId || '',
      summary: enrich.summary || '',
      year: enrich.year || '',
      size: enrich.size || '',
      weight: enrich.weight || '',
      speed: enrich.speed || '',
      nflTeam: enrich.nflTeam || '',
      draftRound: enrich.draftRound || null,
      draftPick: enrich.draftPick || null,
      isUDFA: !!enrich.isUDFA,
      experience: row.Exp || row.exp || '',
      highlightUrl: getHighlightUrl(name, school),
      initials: getInitials(name),
      source: 'rookie-data',
    };
  }

  function applyPostDraftEnrichment(prospect, enrich) {
    if (!prospect || !enrich) return;
    if (!prospect.nflTeam) prospect.nflTeam = enrich.nflTeam || '';
    if (!prospect.draftRound) prospect.draftRound = enrich.draftRound || null;
    if (!prospect.draftPick) prospect.draftPick = enrich.draftPick || null;
    const hasDraftCapital = !!(prospect.draftRound || prospect.draftPick);
    if (hasDraftCapital) {
      prospect.isUDFA = false;
    } else if (!prospect.isUDFA) {
      prospect.isUDFA = !!enrich.isUDFA;
    }
    prospect.draftCapitalValue = Math.min(10000, Math.round(pickToBase(prospect.draftPick, prospect.isUDFA, !!prospect.nflTeam) * prospect.fantasyMultiplier * 60));
    prospect.baseDynastyValue = Math.min(10000, Math.round(prospect.rankValue * 0.6 + prospect.draftCapitalValue * 0.4));
    prospect.dynastyValue = prospect.baseDynastyValue;
  }

  function mergeSyntheticProspects(prospects, enrichMap) {
    const aliasIndex = {};
    prospects.forEach(p => {
      aliasKeys(p.name).forEach(alias => {
        const existing = aliasIndex[alias];
        if (!existing || (p.rank || 999) < (existing.rank || 999)) aliasIndex[alias] = p;
      });
    });

    Object.entries(enrichMap).forEach(([key, e]) => {
      // Same identity rule as findProspect: a FULL first name must never take
      // the single-initial alias path — "Dominic Bailey" enrichment must not
      // attach to David Bailey via "d bailey". Initial aliases stay available
      // for genuinely abbreviated names ("K.C."/"KC" ↔ "Kevin").
      const qFirst = stripSuffix(normName(e.displayName || key)).split(' ').filter(Boolean)[0] || '';
      const aliasMatch = aliasKeys(e.displayName || key)
        .filter(alias => !((alias.split(' ')[0] || '').length === 1 && qFirst.length > 2))
        .map(alias => aliasIndex[alias]).find(Boolean);
      if (aliasMatch) {
        applyPostDraftEnrichment(aliasMatch, e);
        return;
      }
      if (!e.nflTeam && !e.draftRound && !e.isUDFA) return;
      const rawPos = e.pos || '';
      const mappedPos = normPos(rawPos);
      const fantasyMultiplier = e.fantasyMultiplier || FANTASY_MULT[rawPos] || FANTASY_MULT[mappedPos] || 0.3;
      const draftCapitalValue = Math.min(10000, Math.round(pickToBase(e.draftPick, e.isUDFA, !!e.nflTeam) * fantasyMultiplier * 60));
      const name = e.displayName || key.replace(/\b\w/g, c => c.toUpperCase());
      prospects.push({
        id: prospects.length + 1,
        pid: `csv_${key.replace(/[^a-z0-9]/g, '_')}`,
        name,
        pos: mappedPos || rawPos,
        rawPos,
        mappedPos,
        position: mappedPos || rawPos,
        college: e.school || '',
        school: e.school || '',
        rank: 999,
        previousRank: e.previousRank || null,
        rankChange: 0,
        consensusRank: 999,
        avgRank: 999,
        fantasyRank: 999,
        rookiePosRank: null,
        tier: 7,
        tierLabel: 'UDFA',
        tierNum: 7,
        grade: 1.0,
        isGenerational: false,
        draftScore: e.draftRound ? Math.max(0.1, 10 - e.draftRound) : 0.1,
        fantasyMultiplier,
        fantasyMult: fantasyMultiplier,
        rankValue: 0,
        draftCapitalValue,
        dynastyValue: draftCapitalValue,
        baseDynastyValue: draftCapitalValue,
        sources: [],
        sourceRanks: {},
        sourceCount: 0,
        photoUrl: getPhotoUrl(name, e),
        espnId: e.espnId || '',
        summary: e.summary || '',
        year: e.year || '',
        size: e.size || '',
        weight: e.weight || '',
        speed: e.speed || '',
        nflTeam: e.nflTeam || '',
        draftRound: e.draftRound || null,
        draftPick: e.draftPick || null,
        isUDFA: !!e.isUDFA,
        experience: '',
        highlightUrl: getHighlightUrl(name, e.school),
        initials: getInitials(name),
        source: 'rookie-data',
        isCSVOnly: true,
      });
    });
  }

  function indexProspects(prospects) {
    const byName = {};
    prospects.forEach(p => {
      aliasKeys(p.name).forEach(key => {
        const existing = byName[key];
        if (!existing || p.rank < existing.rank) byName[key] = p;
      });
    });
    return byName;
  }

  function assignRookiePositionRanks(prospects) {
    const byPos = {};
    prospects.forEach(p => {
      const pos = p.mappedPos || p.pos;
      if (!pos) return;
      byPos[pos] = byPos[pos] || [];
      byPos[pos].push(p);
    });
    Object.values(byPos).forEach(group => {
      // Rank within position by the (verified-source) consensus, falling back to
      // the board rank — so position ranks track the cleaned consensus.
      group.sort((a, b) => (a.consensusRank || 999) - (b.consensusRank || 999) || (a.rank || 999) - (b.rank || 999));
      group.forEach((p, index) => { p.rookiePosRank = index + 1; });
    });
  }

  async function loadRookieProspects(options = {}) {
    if (cache.loaded && !options.force) return cache;
    if (cache.loading && !options.force) return cache.loading;

    cache.loading = (async function() {
      const base = resolveDataBase();
      const [playerText, mockText, enrichmentText] = await Promise.all([
        fetchText([`${base}/player.csv`, `${base}/players.csv`]),
        fetchText(`${base}/data/mock_draft_db.csv`),
        fetchText(`${base}/player-enrichment.csv`),
      ]);
      const playerRows = parseCSV(playerText || mockText);
      const mockRows = parseCSV(mockText);
      const enrichmentRows = parseCSV(enrichmentText);
      const enrichMap = buildEnrichmentMap(enrichmentRows);
      const mockMap = buildMockMap(mockRows);
      const cols = sourceColumns(playerRows);
      const prospects = playerRows
        .map((row, index) => buildProspect(row, index, cols, enrichMap, mockMap))
        .filter(Boolean);

      mergeSyntheticProspects(prospects, enrichMap);
      assignRookiePositionRanks(prospects);
      prospects.sort((a, b) => a.rank - b.rank || a.consensusRank - b.consensusRank);

      cache.prospects = {};
      prospects.forEach(p => { cache.prospects[normName(p.name)] = p; });
      cache.byName = indexProspects(prospects);
      cache.order = prospects;
      cache.count = prospects.length;
      cache.loaded = true;
      cache.sourceBase = base;
      cache.loading = null;
      console.log(`[RookieData] Loaded ${cache.count} prospects from ${base}`);
      return cache;
    })().catch(err => {
      cache.loaded = true;
      cache.loading = null;
      console.warn('[RookieData] Failed to load:', err);
      return cache;
    });

    return cache.loading;
  }

  // Position-ladder cache. computeStartupValue is called once per prospect, and
  // each call used to re-sort the entire score table (~85ms cold for a rookie
  // class). Build every position's ladder in a single pass and cache it per
  // playerScores/playerMeta identity — the same identity the dynasty cache keys on,
  // so it invalidates together when the engine reloads. ~85ms → <1ms.
  let _ladderCache = { scores: null, meta: null, byPos: {} };
  function getPositionLadder(pos) {
    const scores = window.App?.LI?.playerScores;
    const meta = window.App?.LI?.playerMeta;
    if (!scores || !meta) return [];
    if (_ladderCache.scores !== scores || _ladderCache.meta !== meta) {
      const byPos = {};
      for (const pid in scores) {
        const v = scores[pid];
        if (!(v > 0)) continue;
        const p = meta[pid] && meta[pid].pos;
        if (!p) continue;
        (byPos[p] = byPos[p] || []).push(v);
      }
      for (const p in byPos) byPos[p].sort((a, b) => b - a);
      _ladderCache = { scores, meta, byPos };
    }
    return _ladderCache.byPos[pos] || [];
  }

  function isSuperflexLeague() {
    const S = window.App?.S || window.S;
    const rp = S?.leagues?.find(l => l.league_id === S?.currentLeagueId)?.roster_positions || [];
    return rp.some(slot => ['SUPER_FLEX', 'QB_FLEX', 'OP'].includes(String(slot).toUpperCase()));
  }

  function leagueTeamCount() {
    const S = window.App?.S || window.S;
    return S?.leagues?.find(l => l.league_id === S?.currentLeagueId)?.total_rosters
      || S?.rosters?.length || 12;
  }

  // Veteran-ladder value at a 1-based slot (clamped to the ladder).
  function ladderValueAt(ladder, slot) {
    if (!ladder.length) return 0;
    return ladder[Math.min(Math.max(0, Math.round(slot) - 1), ladder.length - 1)] || 0;
  }

  // True once NFL draft results are loaded (any prospect carries a round/pick).
  // Latches, so the per-prospect scan only runs until the draft is in. Lets us tell
  // "pre-draft, capital unknown for everyone" (→ rank on scouting) apart from
  // "post-draft, this player has no capital" (→ went undrafted, treat as UDFA).
  let _draftResultsLoaded = false;
  function draftResultsLoaded() {
    if (_draftResultsLoaded) return true;
    _draftResultsLoaded = !!(cache.order && cache.order.some(p => Number(p.draftRound) > 0 || Number(p.draftPick) > 0));
    return _draftResultsLoaded;
  }

  function computeStartupValue(prospect) {
    // Undrafted → uniformly near-zero regardless of position: use the capital-aware
    // baseDynastyValue instead of the veteran ladder (which ignores capital and, on the
    // deep IDP ladders, would hand an undrafted player a rosterable value). "Undrafted"
    // = flagged UDFA, OR no NFL draft capital once draft results are in (a "Capital TBD"
    // player who went undrafted). Pre-draft (no capital anywhere yet) we do NOT floor —
    // fall through to the scouting cohort so the board still ranks the class.
    const noCapital = !(prospect.draftRound || prospect.draftPick);
    if (noCapital && (prospect.isUDFA || draftResultsLoaded())) {
      return prospect.baseDynastyValue || prospect.draftScore || 0;
    }

    const pos = prospect.mappedPos || prospect.pos;
    const posRank = prospect.rookiePosRank || 999;
    const offsets = isSuperflexLeague() ? VET_OFFSETS : VET_OFFSETS_ONE_QB;
    const ladder = getPositionLadder(pos);
    if (!ladder.length) return prospect.baseDynastyValue || prospect.dynastyValue || prospect.draftScore || 0;

    // Scouting cohort: in-class position rank nudged down the veteran ladder.
    const scoutVal = ladderValueAt(ladder, posRank + (offsets[pos] || 10));

    // IDP, post-draft: blend the scouting cohort with a draft-capital cohort anchored
    // to the league's startable pool (see IDP_* constants above). Pre-draft (no
    // round/pick) and every non-IDP position keep the pure scouting cohort.
    const draftPick = Number(prospect.draftPick) || 0;
    const draftRound = Number(prospect.draftRound) || (draftPick ? Math.min(7, Math.ceil(draftPick / 32)) : 0);
    if (IDP_LADDER_POSITIONS.has(pos) && draftRound) {
      const starters = (window.App?.LI?.starterCounts || {})[pos] || 4;
      const poolSlot = leagueTeamCount() * starters * (IDP_ROUND_POOL_MULT[Math.min(7, Math.max(1, draftRound))] || 3.2);
      const capitalVal = ladderValueAt(ladder, poolSlot);
      return Math.round(IDP_CAPITAL_WEIGHT * capitalVal + (1 - IDP_CAPITAL_WEIGHT) * scoutVal)
        || prospect.baseDynastyValue || prospect.draftScore || 0;
    }

    // OFFENSE (QB/RB/WR/TE), post-draft (capital known): clamp scoutVal to a draft-capital
    // ceiling so a late-round rookie can't inherit a startable veteran's score off a thin
    // position class. Pre-draft (draftRound === 0) is skipped → pure scouting, ranks the
    // class as before. The ceiling is floored by the capital-aware base so a great scout on
    // a faller keeps scout-driven ordering BELOW the ceiling and never drops under its base.
    if (draftRound) {
      const ceilFrac = OFFENSE_ROUND_CEIL_FRAC[Math.min(7, Math.max(1, draftRound))] || 0.95;
      const ceilSlot = Math.round(ladder.length * ceilFrac);
      const capitalCeiling = Math.max(ladderValueAt(ladder, ceilSlot), prospect.baseDynastyValue || 0);
      const cappedVal = Math.min(scoutVal, capitalCeiling);
      return cappedVal || prospect.baseDynastyValue || prospect.draftScore || 0;
    }

    return scoutVal || prospect.baseDynastyValue || prospect.draftScore || 0;
  }

  function enrichWithDynastyValue(prospect) {
    if (!prospect) return prospect;
    if (!window.App?.LI?.playerScores) return prospect;
    if (prospect._dynastyComputedFor === window.App.LI.playerScores) return prospect;
    prospect.dynastyValue = computeStartupValue(prospect);
    prospect._dynastyComputedFor = window.App.LI.playerScores;
    return prospect;
  }

  function findProspect(name) {
    if (!name || !cache.loaded) return null;
    const direct = cache.byName[normName(name)];
    if (direct) return enrichWithDynastyValue(direct);
    // The single-initial alias ("d bailey") exists for abbreviated queries
    // ("D. Bailey", "KC Concepcion"). A FULL first name must never take that
    // path — "Dominic Bailey" used to fuzzy-match David Bailey via "d bailey"
    // and inherit his consensus rank (and from there a first-round DHQ seed).
    const qFirst = stripSuffix(normName(name)).split(' ').filter(Boolean)[0] || '';
    for (const key of aliasKeys(name)) {
      const kFirst = key.split(' ')[0] || '';
      if (kFirst.length === 1 && qFirst.length > 2) continue;
      if (cache.byName[key]) return enrichWithDynastyValue(cache.byName[key]);
    }
    return null;
  }

  function getProspects(pos) {
    if (!cache.loaded) return [];
    const mapped = pos ? normPos(pos) : null;
    return cache.order
      .map(enrichWithDynastyValue)
      .filter(p => !mapped || p.mappedPos === mapped || p.pos === mapped || p.rawPos === String(pos).toUpperCase())
      .slice()
      .sort((a, b) => a.rank - b.rank || a.consensusRank - b.consensusRank);
  }

  function getIDPProspects() {
    return getProspects().filter(p => ['DL', 'LB', 'DB'].includes(p.mappedPos || p.pos));
  }

  const api = {
    loadRookieProspects,
    findProspect,
    getProspects,
    getIDPProspects,
    rankToTierBase,
    pickToBase,
    draftCapitalValue: valueRankToDraftCapital,
    baseDynastyValue: valueRankToDynastyBase,
    mergeSyntheticProspects,
    _cache: cache,
    _internals: { normPos, normName, parseCSV, rankToTierBase, pickToBase },
  };

  window.RookieData = api;
  Object.assign(window.App, api);
  window.loadRookieProspects = loadRookieProspects;
  window.findProspect = findProspect;
  window.getProspects = getProspects;
  window.getIDPProspects = getIDPProspects;
})();
