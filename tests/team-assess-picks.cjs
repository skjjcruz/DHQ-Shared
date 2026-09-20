'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.ASSESS_SOURCE || path.join(__dirname, '..', 'team-assess.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const league = (extra = {}) => ({ league_id: 'league-a', season: '2026', status: 'pre_draft', total_rosters: 2, settings: { type: 2, draft_rounds: 4 }, roster_positions: ['QB', 'WR', 'BN'], ...extra });
const draft = (extra = {}) => ({ draft_id: 'draft-a', league_id: 'league-a', season: '2026', status: 'pre_draft', slot_to_roster_id: { 1: 1, 2: 2 }, ...extra });
function fixture({ ready = false, storage = new Map(), moduleSource = source } = {}) {
  const rosters = [
    { roster_id: 1, owner_id: 'a', players: ['qb1', 'wr1'], settings: { wins: 2, losses: 0 } },
    { roster_id: 2, owner_id: 'b', players: ['qb2', 'wr2'], settings: { wins: 0, losses: 2 } },
  ];
  const players = { qb1: { position: 'QB', team: 'KC', injury_status: 'IR' }, wr1: { position: 'WR', team: 'KC' }, qb2: { position: 'QB', team: 'BUF' }, wr2: { position: 'WR', team: 'BUF' } };
  const stats = { qb1: { seasonAvg: 20 }, wr1: { seasonAvg: 15 }, qb2: { seasonAvg: 17 }, wr2: { seasonAvg: 10 } };
  const ctx = { console, Date, Map, Set, Promise, JSON, dynastyValue: id => ({ qb1: 8000, wr1: 7000, qb2: 6000, wr2: 4000 })[id] || 0,
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    App: { LI: ready ? { builtAt: 1, playerScores: { qb1: 8000 } } : {} },
    S: { currentLeagueId: 'league-a', season: '2026', leagues: [league()], rosters, players, playerStats: stats, leagueUsers: [], tradedPicks: [] },
  };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'intelligence-context.js'), 'utf8'), ctx);
  vm.runInContext(moduleSource, ctx);
  return { ctx, storage, rosters, players, stats, holdings: (l, tp = []) => ctx.App.buildPicksByOwner(rosters, l, tp),
    assess: (l, tp) => ctx.App.assessAllTeams(rosters, players, stats, l, [], tp),
    global: () => ctx.App.assessAllTeamsFromGlobal(), reload: () => vm.runInContext(moduleSource, ctx) };
}
const tests = {
  completedDynastyKeepsAcceptedHorizon() {
    const x = fixture(), l = league({ drafts: [draft({ status: 'complete' })] });
    const p = x.holdings(l); assert.equal(p[1].length, 12); assert.deepEqual([...new Set(p[1].map(p => p.year))], [2027, 2028, 2029]);
    assert.equal(x.assess(l, [])[0].picksAssessment.idealTotal, 12);
  },
  seasonalCapitalIsOnlyUnspentCurrentYear() {
    for (const type of [0, 'redraft', 1, 'keeper', 'best_ball', 'dfs']) {
      const x = fixture(), l = league({ settings: { type, draft_rounds: 16 } });
      const picks = x.holdings(l); assert.equal(picks[1].length, 16, String(type)); assert(picks[1].every(p => p.year === 2026));
      const a = x.assess(l, [])[0].picksAssessment; assert.equal(a.idealTotal, 16); assert.equal(a.status, 'ok');
      l.drafts = [draft({ status: 'complete' })]; assert.equal(x.holdings(l)[1].length, 0);
      const done = x.assess(l, [])[0]; assert.equal(done.picksAssessment, null); assert.equal(done.pickCoverage.complete, true); assert.equal(done.pickCoverage.applicable, false);
    }
  },
  canonicalOverridesAndBlankFieldsRetainNumericZero() {
    const x = fixture(), l = league({ type: '', settings: { type: 0, draft_rounds: 4 } });
    assert.equal(x.holdings(l)[1].length, 4);
    x.ctx.App.Intelligence.setLeagueTypeOverride(l, 'dynasty'); assert.equal(x.holdings(l)[1].length, 12);
    l._dhq_type_override = 'keeper'; assert.equal(x.holdings(l)[1].length, 4);
    const unknown = league({ settings: { draft_rounds: 4 } }); assert.equal(x.assess({ ...unknown, league_id: 'unknown' }, [])[0].picksAssessment, null);
  },
  unrelatedGlobalDraftCannotRetireCurrentRights() {
    const x = fixture(); x.ctx.S.currentLeagueId = 'other'; x.ctx.S.drafts = [draft({ league_id: 'other', status: 'complete' })];
    assert.equal(x.holdings(league())[1][0].year, 2026);
    x.ctx.S.currentLeagueId = 'league-a'; x.ctx.S.draftsLeagueId = 'other';
    assert.equal(x.holdings(league())[1][0].year, 2026);
    x.ctx.S.drafts = [draft({ status: 'complete' })]; x.ctx.S.draftsLeagueId = 'league-a';
    assert.equal(x.holdings(league())[1][0].year, 2027);
    assert.equal(x.holdings(league({ drafts: [] }))[1][0].year, 2026, 'explicit league list wins over stale global list');
  },
  partialDraftConsumesOriginalSlotAfterTransfer() {
    const x = fixture(), l = league({ status: 'drafting', drafts: [draft({ status: 'drafting', picks: [
      { draft_id: 'draft-a', round: 1, draft_slot: 1, roster_id: 2, player_id: 'rookie' },
    ] })] });
    const picks = x.holdings(l, [{ season: '2026', round: 1, roster_id: 1, owner_id: 2 }]);
    assert.equal(picks[1].length, 11); assert.equal(picks[2].length, 12);
    assert(!picks[2].some(p => p.year === 2026 && p.round === 1 && String(p.originalOwnerRid) === '1'));
    assert(picks[2].some(p => p.year === 2026 && p.round === 1 && String(p.originalOwnerRid) === '2'));
    const a = x.assess(l, [{ season: '2026', round: 1, roster_id: 1, owner_id: 2 }]);
    assert.equal(a[0].picksAssessment.idealTotal, 11); assert.equal(a[0].picksAssessment.status, 'ok');
  },
  unavailableProgressIsNotFullCapitalOrDeficit() {
    const x = fixture();
    for (const drafts of [[draft({ status: 'drafting' })], [draft({ status: 'drafting', picks: [{ round: 1, draft_slot: 9, roster_id: 2, player_id: 'rookie' }] })], [draft({ status: 'complete' }), draft({ draft_id: 'supplemental', status: 'pre_draft' })]]) {
      const l = league({ status: 'drafting', drafts });
      const picks = x.holdings(l); assert.equal(picks.coverage.complete, false); assert(picks[1].every(p => p.year > 2026));
      assert.equal(x.assess(l, [])[0].picksAssessment, null);
    }
    const l = league({ status: 'in_season' }); assert.equal(x.assess(l, [])[0].picksAssessment, null);
  },
  failedOwnershipIsUnavailableRatherThanOriginalInventory() {
    const x = fixture(); for (const tp of [undefined, null, { error: 'unavailable' }]) assert.equal(x.assess(league(), tp)[0].picksAssessment, null);
    assert.equal(x.assess(league(), [null])[0].picksAssessment, null);
    assert.equal(x.assess(league(), [{season:'unknown',round:1,roster_id:1,owner_id:2}])[0].picksAssessment, null);
    assert.equal(x.assess(league(), [])[0].picksAssessment.totalPicks, 12);
  },
  roundEvidenceDistinguishesStartupFromFutureRookieDrafts() {
    const x = fixture(), l = league({ drafts: [draft({ settings: { rounds: 20 } })] });
    assert.equal(x.holdings(l)[1].length, 28); assert.equal(x.assess(l, [])[0].picksAssessment.idealTotal, 28);
    assert.equal(x.assess(l, [])[0].picksAssessment.pickCountByYear['2026'], 20);
    const missing = league({ settings: { type: 0 }, drafts: [draft({ settings: { rounds: 16 } })] });
    assert.equal(x.holdings(missing)[1].length, 16, 'actual current board determines redraft rounds');
    assert.equal(x.assess(league({ settings: { type: 2 } }), [])[0].picksAssessment, null, 'absent round setting cannot invent five future rounds');
    assert.equal(x.holdings(league({ settings: { type: 2, draft_rounds: 0 } }))[1].length, 0, 'zero rounds is not the five-round fallback');
    assert.equal(x.assess(league({ settings: { type: 2, draft_rounds: 100000 } }), [])[0].picksAssessment, null);
  },
  mixedIdentifiersAndDuplicateRowsDoNotInventRights() {
    const x = fixture(), p = { season: '2027', round: '1', roster_id: '1', owner_id: '2' };
    const picks = x.holdings(league(), [p, { ...p }, { ...p, league_id: 'other', owner_id: 1 }]);
    assert.equal(picks[1].length, 11); assert.equal(picks[2].length, 13);
    assert.equal(x.assess(league(), [p, { ...p, owner_id: 1 }])[0].picksAssessment, null);
    assert.equal(x.assess(league(), [{ ...p, owner_id: 'unresolved' }])[0].picksAssessment, null);
  },
  sameCountTradeAndDraftProgressInvalidateMemoAndPin() {
    for (const ready of [false, true]) {
      const x = fixture({ ready }); x.ctx.S.tradedPicks = [{ season: '2027', round: 1, roster_id: 1, owner_id: 1 }];
      assert.equal(x.global()[0].picksAssessment.totalPicks, 12);
      x.ctx.S.tradedPicks[0].owner_id = 2; assert.equal(x.global()[0].picksAssessment.totalPicks, 11);
      x.reload(); assert.equal(x.global()[0].picksAssessment.totalPicks, 11, 'reload must not adopt pre-transfer stable pin');
      x.ctx.S.drafts = [draft({ status: 'complete' })]; x.ctx.S.draftsLeagueId = 'league-a';
      assert.deepEqual(plain(x.global()[0].picksAssessment.pickYears), ['2027', '2028', '2029']);
    }
  },
  equivalentProviderOrderingKeepsTheStableAssessment() {
    const x = fixture({ ready: true });
    const p1 = { season: '2027', round: 1, roster_id: 1, owner_id: 2 }, p2 = { season: '2027', round: 2, roster_id: 2, owner_id: 1 };
    x.ctx.S.tradedPicks = [p1, p2]; const first = x.global();
    x.ctx.S.tradedPicks.reverse(); assert.equal(x.global(), first, 'array order alone does not invalidate daily stability');
  },
  async lateCloudPinCannotReplaceAnotherLeagueOrPickState() {
    const x = fixture({ ready: true }), waiting = [];
    x.ctx.OD = { loadLeagueDoc: () => new Promise(resolve => waiting.push(resolve)), saveLeagueDoc: () => { throw new Error('No fixture cloud publication expected'); } };
    x.global(); const [aKey, aRaw] = [...x.storage.entries()].find(([key]) => key.endsWith(':league-a'));
    assert(aKey); const a = JSON.parse(aRaw);
    x.ctx.S.currentLeagueId = 'league-b'; x.ctx.S.leagues = [league({ league_id: 'league-b' })];
    x.global(); const [bKey, bRaw] = [...x.storage.entries()].find(([key]) => key.endsWith(':league-b'));
    const revision = Number(aKey.match(/_v(\d+):/)[1]);
    waiting[0]({ rev: revision, fp: a.fp, data: a.data }); waiting[1]({ rev: revision, fp: a.fp, data: a.data });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(x.storage.get(bKey), bRaw, 'late A response cannot overwrite B stable snapshot');
  },
  currentGlobalSeasonIsUsedOnlyForTheSelectedLeague() {
    const x = fixture(); delete x.ctx.S.leagues[0].season; x.ctx.S.season = '2024';
    assert.deepEqual(plain(x.global()[0].picksAssessment.pickYears), ['2024', '2025', '2026']);
    assert.equal(x.assess({ ...league(), season: undefined }, [])[0].picksAssessment, null);
  },
  mflPartialBoardUsesCurrentSlotOwner() {
    const x = fixture(), l = league({ drafts: [draft({ _source: 'mfl', settings: { rounds: 1, teams: 2 }, status: 'drafting', _slots: [
      { round: 1, draft_slot: 1, roster_id: 2, player_id: 'rookie' },
      { round: 1, draft_slot: 2, roster_id: 2, player_id: '' },
    ] })] });
    const p = x.holdings(l); assert.equal(p[1].length, 8); assert.equal(p[2].length, 9);
    assert.equal(p.coverage.complete, true, 'explicit one-round board is complete');
    assert.equal(p[2].filter(p => p.year === 2026)[0].originalOwnerRid, null);
  },
  mflTruncatedGappedAndForeignBoardsStayUnavailable() {
    const x = fixture();
    const slots = Array.from({ length: 8 }, (_, i) => ({ round: Math.floor(i / 2) + 1, draft_slot: i % 2 + 1, roster_id: i % 2 + 1, player_id: i === 0 ? 'rookie' : '' }));
    for (const bad of [slots.slice(0, 2), slots.slice(0, 7), slots.filter((_, i) => i !== 3),
      slots.map((p, i) => i === 3 ? { ...p, draft_slot: 3 } : p),
      slots.map((p, i) => i === 3 ? { ...slots[2] } : p),
      slots.map((p, i) => i === 3 ? { ...p, draft_id: 'foreign-draft' } : p),
      slots.map((p, i) => i === 3 ? { ...p, league_id: 'foreign-league' } : p),
      slots.map((p, i) => i === 3 ? { ...p, roster_id: 'foreign-roster' } : p)]) {
      const l = league({ drafts: [draft({ _source: 'mfl', status: 'drafting', _slots: bad })] });
      assert.equal(x.holdings(l).coverage.complete, false, JSON.stringify(bad));
      assert.equal(x.assess(l, [])[0].picksAssessment, null);
    }
    const l = league({ drafts: [draft({ _source: 'mfl', status: 'drafting', _slots: slots })] });
    assert.equal(x.holdings(l).coverage.complete, true); assert.equal(x.holdings(l)[1].length, 11);
    l.drafts[0].status = 'complete';
    assert.equal(x.holdings(l).coverage.complete, false, 'complete status cannot consume an unfinished inferred MFL board');
    l.drafts[0]._slots = slots.map(p => ({ ...p, player_id: 'made-' + p.round + '-' + p.draft_slot }));
    const complete = x.holdings(l); assert.equal(complete.coverage.complete, true);
    assert.deepEqual([...new Set(complete[1].map(p => p.year))], [2027, 2028, 2029]); assert.equal(complete[1].length, 12);
    l.drafts[0]._slots = l.drafts[0]._slots.slice(0, 2);
    assert.equal(x.holdings(l).coverage.complete, false, 'truncated all-made board cannot trigger dynasty rollover');
  },
  mflAdapterInferredDimensionsCannotCertifyTheirOwnPayload() {
    const x = fixture();
    const mapper = fs.readFileSync(path.join(__dirname, '..', 'mfl-api.js'), 'utf8');
    const start = mapper.indexOf('function mapDraftStatus(');
    const run = vm.runInNewContext('(' + mapper.slice(start, mapper.indexOf('\n/**', start)).trim() + ')');
    const payload = { draftResults: { draftUnit: { draftPick: [
      { round: '1', pick: '1', franchise: '1', player: '100' },
      { round: '1', pick: '2', franchise: '2', player: '' },
    ] } } };
    const mapped = run(payload, '123', '2026', {}, {}); assert.equal(mapped[0]._dimensionsInferred, true);
    const l = league({ league_id: 'mfl_123_2026', drafts: mapped });
    assert.equal(mapped[0].settings.rounds, 1, 'adapter sees only the truncated first round');
    assert.equal(x.holdings(l).coverage.complete, false, 'four configured rounds cannot be certified by inferred one-round payload');
    l.settings.draft_rounds = 1;
    assert.equal(x.holdings(l).coverage.complete, true, 'independent one-round configuration resolves the same payload');
    delete l.settings.draft_rounds;
    assert.equal(x.holdings(l).coverage.complete, false, 'missing configured dimensions remain unknown');
  },
  sleeperMissingSlotMapDuplicateAndForeignProgressStayUnavailable() {
    const x = fixture(), made = { draft_id: 'draft-a', round: 1, draft_slot: 1, roster_id: 2, player_id: 'rookie' };
    for (const extra of [
      { slot_to_roster_id: { 1: 1 }, picks: [made] },
      { slot_to_roster_id: { 1: 1, 2: 1 }, picks: [made] },
      { slot_to_roster_id: { 1: 1, 3: 2 }, picks: [made] },
      { slot_to_roster_id: { 1: 1, '01': 2 }, picks: [made] },
      { picks: [made, { ...made }] },
      { picks: [made, { ...made, player_id: 'different-player' }] },
      { picks: [{ ...made, league_id: 'foreign-league' }] },
      { picks: [{ ...made, roster_id: 'foreign-roster' }] },
    ]) {
      const l = league({ drafts: [draft({ status: 'drafting', ...extra })] });
      assert.equal(x.holdings(l).coverage.complete, false, JSON.stringify(extra));
      assert.equal(x.assess(l, [])[0].picksAssessment, null);
    }
    assert.equal(x.holdings(league({ drafts: [draft({ status: 'drafting', picks: [made] })] })).coverage.complete, true);
  },
  mflBoardEvidenceRecoveryInvalidatesSavedAssessment() {
    for (const ready of [false, true]) {
      const x = fixture({ ready }), d = draft({ _source: 'mfl', settings: { rounds: 1, teams: 3 }, status: 'pre_draft', _slots: [
        { round: 1, draft_slot: 1, roster_id: 1, player_id: '' },
        { round: 1, draft_slot: 2, roster_id: 2, player_id: '' },
      ] });
      x.ctx.S.leagues[0].drafts = [d];
      assert.equal(x.global()[0].picksAssessment, null);
      d.settings.teams = 2; assert.equal(x.global()[0].picksAssessment.totalPicks, 9);
      delete d._slots[1].player_id; assert.equal(x.global()[0].picksAssessment, null);
      d._slots[1].player_id = ''; assert.equal(x.global()[0].picksAssessment.totalPicks, 9);
      d._dimensionsInferred = true; assert.equal(x.global()[0].picksAssessment, null);
      x.ctx.S.leagues[0].settings.draft_rounds = 1; assert.equal(x.global()[0].picksAssessment.totalPicks, 3);
      x.reload(); assert.equal(x.global()[0].picksAssessment.totalPicks, 3);
    }
  },
  nonPickHealthRankAndInjuryContractsAreStable() {
    const x = fixture(), before = plain(x.assess(league(), []));
    const after = plain(x.assess(league({ drafts: [draft({ status: 'complete' })] }), []));
    for (const rows of [before, after]) for (const row of rows) { delete row.picksAssessment; delete row.pickCoverage; }
    assert.deepEqual(after, before, 'pick rollover cannot alter player values, quality, health or ranks');
    if (process.env.ASSESS_BASELINE) {
      const old = fixture({ moduleSource: fs.readFileSync(process.env.ASSESS_BASELINE, 'utf8') });
      const prior = plain(old.assess(league(), []));
      for (const row of prior) { delete row.picksAssessment; delete row.pickCoverage; }
      assert.deepEqual(before, prior, 'current owner health/rank/injury contracts remain identical to dedbb16');
    }
  },
};
(async () => {
  let failed = 0;
  for (const [name, run] of Object.entries(tests)) {
    try { await run(); console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
  }
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
