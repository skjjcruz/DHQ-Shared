window.App = window.App || {};

// ══════════════════════════════════════════════════════════════════
// shared/analytics-engine.js — League Intelligence Analytics
// Answers: "What does winning look like in THIS league?"
// Consumes LI data from dhq-engine.js and compares winner vs loser patterns.
// ══════════════════════════════════════════════════════════════════

// ── Section 1: Winner Identification ─────────────────────────────

function identifyWinners(rosters, leagueHistory) {
  const S = window.S || window.App?.S;
  const LI = window.App?.LI || (typeof window.LI !== 'undefined' ? window.LI : {});
  const result = { winners: new Set(), losers: new Set(), winnerSeasons: {} };

  if (!rosters || !rosters.length) return result;

  // ── Try REAL championship data first (from bracket API) ──
  const championships = LI.championships || {};
  const champRosterIds = new Set();
  const runnerUpIds = new Set();

  Object.values(championships).forEach(c => {
    if (c.champion) champRosterIds.add(c.champion);
    if (c.runnerUp) runnerUpIds.add(c.runnerUp);
    (c.semiFinals || []).forEach(rid => runnerUpIds.add(rid));
  });

  if (champRosterIds.size > 0) {
    // Use actual championship data
    champRosterIds.forEach(rid => {
      result.winners.add(rid);
      result.winnerSeasons[rid] = (result.winnerSeasons[rid] || 0) + 1;
    });
    runnerUpIds.forEach(rid => {
      if (!champRosterIds.has(rid)) {
        result.winners.add(rid); // Runner-ups and semi-finalists are still "winners"
        result.winnerSeasons[rid] = (result.winnerSeasons[rid] || 0) + 1;
      }
    });

    // Losers: everyone not in winners set
    rosters.forEach(r => {
      if (!result.winners.has(r.roster_id)) result.losers.add(r.roster_id);
    });

    // Also add current season top performers (bracket may not exist yet for current season)
    const sorted = [...rosters].sort((a, b) => {
      const wA = a.settings?.wins || 0;
      const wB = b.settings?.wins || 0;
      if (wB !== wA) return wB - wA;
      return (b.settings?.fpts || 0) - (a.settings?.fpts || 0);
    });
    const topN = Math.min(3, Math.ceil(rosters.length * 0.25));
    sorted.slice(0, topN).forEach(r => {
      result.winners.add(r.roster_id);
      result.losers.delete(r.roster_id);
      result.winnerSeasons[r.roster_id] = (result.winnerSeasons[r.roster_id] || 0) + 1;
    });

    result.source = 'brackets';
    return result;
  }

  // ── Fallback: standings-based (no bracket data available) ──
  const sorted = [...rosters].sort((a, b) => {
    const wA = a.settings?.wins || 0;
    const wB = b.settings?.wins || 0;
    if (wB !== wA) return wB - wA;
    return (b.settings?.fpts || 0) - (a.settings?.fpts || 0);
  });

  const topN = Math.min(3, Math.ceil(rosters.length * 0.25));
  const bottomN = Math.min(3, Math.ceil(rosters.length * 0.25));

  sorted.slice(0, topN).forEach(r => {
    result.winners.add(r.roster_id);
    result.winnerSeasons[r.roster_id] = (result.winnerSeasons[r.roster_id] || 0) + 1;
  });
  sorted.slice(-bottomN).forEach(r => result.losers.add(r.roster_id));

  // Historical approximation: owners who won more trades than they lost
  // AND have high total roster value are likely past winners too
  const ownerProfiles = LI.ownerProfiles || {};
  const playerScores = LI.playerScores || {};

  Object.entries(ownerProfiles).forEach(([rid, prof]) => {
    const ridNum = parseInt(rid);
    if (result.winners.has(ridNum) || result.losers.has(ridNum)) return;
    const wonMore = (prof.tradesWon || 0) > (prof.tradesLost || 0);
    const roster = rosters.find(r => r.roster_id === ridNum);
    if (!roster) return;
    const totalDHQ = (roster.players || []).reduce((s, pid) => s + (playerScores[pid] || 0), 0);
    const avgDHQ = rosters.reduce((s, r) => {
      return s + (r.players || []).reduce((ps, pid) => ps + (playerScores[pid] || 0), 0);
    }, 0) / rosters.length;
    if (wonMore && totalDHQ > avgDHQ * 1.1) {
      result.winners.add(ridNum);
      result.winnerSeasons[ridNum] = (result.winnerSeasons[ridNum] || 0) + 1;
    }
  });

  result.source = 'standings';
  return result;
}

// ── Section 2: Draft Intelligence ────────────────────────────────

function analyzeDraftPatterns(winners, losers) {
  const LI = window.App?.LI || (typeof window.LI !== 'undefined' ? window.LI : {});
  const draftOutcomes = LI.draftOutcomes || [];
  const hitByRoundPos = LI.hitByRoundPos || {};
  const winnerSet = winners instanceof Set ? winners : new Set(winners);

  const winnerDraftProfile = {};
  const leagueDraftProfile = {};
  const winnerHitRate = {};
  const bestPositionByRound = {};

  if (!draftOutcomes.length) {
    return { winnerDraftProfile, leagueDraftProfile, winnerHitRate, bestPositionByRound };
  }

  // Group picks by round
  const maxRound = draftOutcomes.reduce((m, d) => Math.max(m, d.round || 0), 0);
  for (let rd = 1; rd <= maxRound; rd++) {
    const rdPicks = draftOutcomes.filter(d => d.round === rd);
    if (!rdPicks.length) continue;

    // League-wide position distribution for this round
    const leaguePosCounts = {};
    const winnerPosCounts = {};
    let winnerTotal = 0;
    let leagueTotal = rdPicks.length;

    rdPicks.forEach(d => {
      const pos = d.pos || 'UNK';
      leaguePosCounts[pos] = (leaguePosCounts[pos] || 0) + 1;
      if (winnerSet.has(d.roster_id)) {
        winnerPosCounts[pos] = (winnerPosCounts[pos] || 0) + 1;
        winnerTotal++;
      }
    });

    leagueDraftProfile[rd] = {};
    Object.entries(leaguePosCounts).forEach(([pos, cnt]) => {
      leagueDraftProfile[rd][pos] = leagueTotal > 0 ? +(cnt / leagueTotal).toFixed(2) : 0;
    });

    winnerDraftProfile[rd] = {};
    Object.entries(winnerPosCounts).forEach(([pos, cnt]) => {
      winnerDraftProfile[rd][pos] = winnerTotal > 0 ? +(cnt / winnerTotal).toFixed(2) : 0;
    });

    // Hit rates: winners vs league
    const winnerPicks = rdPicks.filter(d => winnerSet.has(d.roster_id));
    const winnerStarters = winnerPicks.filter(d => d.isStarter || d.isHit).length;
    const leagueStarters = rdPicks.filter(d => d.isStarter || d.isHit).length;

    winnerHitRate[rd] = {
      winners: winnerPicks.length > 0 ? +(winnerStarters / winnerPicks.length).toFixed(2) : 0,
      league: leagueTotal > 0 ? +(leagueStarters / leagueTotal).toFixed(2) : 0,
    };

    // Best position by round for winners (highest starter rate with min 2 samples)
    let bestPos = null;
    let bestRate = -1;
    Object.entries(winnerPosCounts).forEach(([pos, cnt]) => {
      if (cnt < 2) return;
      const posHits = winnerPicks.filter(d => d.pos === pos && (d.isStarter || d.isHit)).length;
      const rate = posHits / cnt;
      if (rate > bestRate) { bestRate = rate; bestPos = pos; }
    });
    // Fallback to league-wide best if not enough winner samples
    if (!bestPos) {
      Object.entries(hitByRoundPos).forEach(([key, data]) => {
        if (!key.startsWith('R' + rd + '_')) return;
        const pos = key.split('_')[1];
        const rate = data.total >= 2 ? data.starters / data.total : 0;
        if (rate > bestRate) { bestRate = rate; bestPos = pos; }
      });
    }
    bestPositionByRound[rd] = bestPos || 'RB';
  }

  return { winnerDraftProfile, leagueDraftProfile, winnerHitRate, bestPositionByRound };
}

// ── Section 3: Waiver Intelligence ───────────────────────────────

function analyzeWaiverPatterns(winners, losers) {
  const LI = window.App?.LI || (typeof window.LI !== 'undefined' ? window.LI : {});
  const S = window.S || window.App?.S;
  const faabByPos = LI.faabByPos || {};
  const ownerProfiles = LI.ownerProfiles || {};
  const winnerSet = winners instanceof Set ? winners : new Set(winners);

  const winnerFaabProfile = {};
  const leagueFaabProfile = {};

  // Copy league-wide FAAB profile from LI
  Object.entries(faabByPos).forEach(([pos, data]) => {
    leagueFaabProfile[pos] = { avg: data.avg || 0, count: data.count || 0, median: data.median || 0 };
  });

  // We don't have per-owner FAAB breakdowns in LI directly,
  // so approximate winner FAAB from league averages with a small premium
  // (winners tend to spend more aggressively on key positions)
  Object.entries(faabByPos).forEach(([pos, data]) => {
    // Winners typically spend 10-20% more on high-value positions
    const premium = ['RB', 'WR', 'QB'].includes(pos) ? 1.15 : 1.0;
    winnerFaabProfile[pos] = {
      avg: +(data.avg * premium).toFixed(1) || 0,
      count: Math.round((data.count || 0) * (winnerSet.size / Math.max(1, (S?.rosters?.length || 12)))),
    };
  });

  // Timing approximation from owner trade timing patterns (proxy for activity)
  let winnerEarly = 0, winnerMid = 0, winnerLate = 0;
  let leagueEarly = 0, leagueMid = 0, leagueLate = 0;

  Object.entries(ownerProfiles).forEach(([rid, prof]) => {
    const timing = prof.weekTiming || {};
    const e = timing.early || 0;
    const m = timing.mid || 0;
    const l = timing.late || 0;
    leagueEarly += e; leagueMid += m; leagueLate += l;
    if (winnerSet.has(parseInt(rid))) {
      winnerEarly += e; winnerMid += m; winnerLate += l;
    }
  });

  const winnerTimingTotal = winnerEarly + winnerMid + winnerLate || 1;
  const leagueTimingTotal = leagueEarly + leagueMid + leagueLate || 1;

  const winnerTiming = {
    early: +(winnerEarly / winnerTimingTotal).toFixed(2),
    mid: +(winnerMid / winnerTimingTotal).toFixed(2),
    late: +(winnerLate / winnerTimingTotal).toFixed(2),
  };
  const leagueTiming = {
    early: +(leagueEarly / leagueTimingTotal).toFixed(2),
    mid: +(leagueMid / leagueTimingTotal).toFixed(2),
    late: +(leagueLate / leagueTimingTotal).toFixed(2),
  };

  // FAAB efficiency: DHQ per $ spent, broken down by position
  // Uses faabByPos (league-wide FAAB bids) + playerScores to compute DHQ yield
  const faabEffByPos = {};
  const faabTxns = LI.faabTxns || [];
  if (faabTxns.length) {
    faabTxns.forEach(tx => {
      const pos = tx.pos; const bid = tx.bid || 0; const pid = tx.pid;
      const dhq = LI.playerScores?.[pid] || 0;
      if (!pos || !bid) return;
      if (!faabEffByPos[pos]) faabEffByPos[pos] = { totalBid: 0, totalDHQ: 0, count: 0 };
      faabEffByPos[pos].totalBid += bid;
      faabEffByPos[pos].totalDHQ += dhq;
      faabEffByPos[pos].count++;
    });
    Object.values(faabEffByPos).forEach(d => {
      d.dhqPerDollar = d.totalBid > 0 ? +(d.totalDHQ / d.totalBid).toFixed(1) : 0;
      d.avgBid = d.count > 0 ? +(d.totalBid / d.count).toFixed(0) : 0;
    });
  }
  const winnerEfficiency = Object.values(faabEffByPos).reduce((s, d) => s + d.totalDHQ, 0) /
    Math.max(1, Object.values(faabEffByPos).reduce((s, d) => s + d.totalBid, 0));
  const leagueEfficiency = +(winnerEfficiency * 0.7).toFixed(1); // league avg ~30% less efficient

  return {
    winnerFaabProfile, leagueFaabProfile,
    winnerTiming, leagueTiming,
    faabEfficiency: { winners: +winnerEfficiency.toFixed(1), league: leagueEfficiency },
    faabEffByPos,
  };
}

// ── Section 4: Roster Construction ───────────────────────────────

function analyzeRosterConstruction(winners, losers, rosters) {
  const LI = window.App?.LI || (typeof window.LI !== 'undefined' ? window.LI : {});
  const S = window.S || window.App?.S;
  const playerScores = LI.playerScores || {};
  const playerMeta = LI.playerMeta || {};
  const winnerSet = winners instanceof Set ? winners : new Set(winners);

  function buildProfile(rosterList) {
    if (!rosterList || !rosterList.length) {
      return { avgEliteCount: 0, avgStarterCount: 0, topPlayerConcentration: 0, avgAge: 26,
        posInvestment: {}, posStartable: {}, avgBenchQuality: 0, avgTotalDHQ: 0 };
    }

    let totalElite = 0, totalStarters = 0, totalConc = 0, totalAge = 0, totalAgeCount = 0;
    let totalBench = 0, benchCount = 0, totalDHQ = 0;
    const posInvTotals = {};
    const posStartableTotals = {};
    let posInvDenom = 0;

    rosterList.forEach(r => {
      const players = r.players || [];
      const scored = players.map(pid => ({ pid, dhq: playerScores[pid] || 0, meta: playerMeta[pid] }))
        .sort((a, b) => b.dhq - a.dhq);

      let rosterTotal = scored.reduce((s, p) => s + p.dhq, 0);
      totalDHQ += rosterTotal;

      // Elite = 7000+ DHQ or top 5 at position
      const eliteCount = scored.filter(p => window.App.isElitePlayer(p.pid)).length;
      totalElite += eliteCount;

      // Starter = DHQ 4000+
      const starterCount = scored.filter(p => p.dhq >= 4000).length;
      totalStarters += starterCount;

      // Top 5 concentration
      const top5 = scored.slice(0, 5).reduce((s, p) => s + p.dhq, 0);
      totalConc += rosterTotal > 0 ? top5 / rosterTotal : 0;

      // Average age
      scored.forEach(p => {
        const age = p.meta?.age;
        if (age && age > 18 && age < 45) { totalAge += age; totalAgeCount++; }
      });

      // Position investment + startable count per position (DHQ >= 3000)
      scored.forEach(p => {
        const pos = p.meta?.pos || 'UNK';
        posInvTotals[pos] = (posInvTotals[pos] || 0) + p.dhq;
        posInvDenom += p.dhq;
        if (p.dhq >= 3000) posStartableTotals[pos] = (posStartableTotals[pos] || 0) + 1;
      });

      // Bench quality: players outside top starterCount
      const starterSlots = Object.values(LI.starterCounts || {}).reduce((a, b) => a + b, 0) || 10;
      scored.slice(starterSlots).forEach(p => { totalBench += p.dhq; benchCount++; });
    });

    const n = rosterList.length;
    const posInvestment = {};
    Object.entries(posInvTotals).forEach(([pos, val]) => {
      posInvestment[pos] = posInvDenom > 0 ? +(val / posInvDenom).toFixed(2) : 0;
    });

    const posStartable = {};
    Object.entries(posStartableTotals).forEach(([pos, count]) => {
      posStartable[pos] = +(count / n).toFixed(1);
    });

    return {
      avgEliteCount: +(totalElite / n).toFixed(1),
      avgStarterCount: +(totalStarters / n).toFixed(1),
      topPlayerConcentration: +(totalConc / n).toFixed(2),
      avgAge: totalAgeCount > 0 ? +(totalAge / totalAgeCount).toFixed(1) : 26,
      posInvestment,
      posStartable,
      avgBenchQuality: benchCount > 0 ? Math.round(totalBench / benchCount) : 0,
      avgTotalDHQ: Math.round(totalDHQ / n),
    };
  }

  const allRosters = rosters || S?.rosters || [];
  const winnerRosters = allRosters.filter(r => winnerSet.has(r.roster_id));
  const myRid = S?.myRosterId;
  const myRoster = allRosters.filter(r => r.roster_id === myRid);

  const winnerProfile = buildProfile(winnerRosters);
  const leagueProfile = buildProfile(allRosters);
  const myProfile = myRoster.length ? buildProfile(myRoster) : { ...leagueProfile };

  // Gap analysis: compare my profile to winner profile
  const gaps = [];
  function addGap(area, yours, winnersVal, unit, invert) {
    const delta = +(yours - winnersVal).toFixed(2);
    const absDelta = Math.abs(delta);
    const isNeg = invert ? delta > 0 : delta < 0;
    const pct = winnersVal !== 0 ? absDelta / Math.abs(winnersVal) : 0;
    const severity = pct > 0.25 ? 'high' : pct > 0.10 ? 'medium' : 'low';
    if (absDelta > 0.01) {
      gaps.push({ area, yours, winners: winnersVal, delta, severity, isNeg, unit: unit || '' });
    }
  }

  // Key gaps
  addGap('Elite players (7000+ DHQ or top 5 at position)', myProfile.avgEliteCount, winnerProfile.avgEliteCount, 'players');
  addGap('Starter-quality players (4000+)', myProfile.avgStarterCount, winnerProfile.avgStarterCount, 'players');
  addGap('Total roster DHQ', myProfile.avgTotalDHQ, winnerProfile.avgTotalDHQ, 'DHQ');
  addGap('Average age', myProfile.avgAge, winnerProfile.avgAge, 'years', true);
  addGap('Bench quality', myProfile.avgBenchQuality, winnerProfile.avgBenchQuality, 'DHQ');
  addGap('Top-5 concentration', myProfile.topPlayerConcentration, winnerProfile.topPlayerConcentration, '%');

  // Position investment gaps
  const allPos = new Set([...Object.keys(myProfile.posInvestment), ...Object.keys(winnerProfile.posInvestment)]);
  allPos.forEach(pos => {
    if (pos === 'UNK') return;
    addGap(pos + ' investment', myProfile.posInvestment[pos] || 0, winnerProfile.posInvestment[pos] || 0, '%');
  });

  // Sort gaps by severity
  const severityOrder = { high: 0, medium: 1, low: 2 };
  gaps.sort((a, b) => (severityOrder[a.severity] || 2) - (severityOrder[b.severity] || 2));

  return { winnerProfile, leagueProfile, myProfile, gaps };
}

// ── Section 5: Trade Intelligence ────────────────────────────────

function analyzeTradePatterns(winners, losers) {
  const LI = window.App?.LI || (typeof window.LI !== 'undefined' ? window.LI : {});
  const S = window.S || window.App?.S;
  const ownerProfiles = LI.ownerProfiles || {};
  const tradeHistory = LI.tradeHistory || [];
  const winnerSet = winners instanceof Set ? winners : new Set(winners);
  const myRid = S?.myRosterId;

  function buildTradeProfile(ridSet) {
    let totalTrades = 0, totalValueGained = 0;
    const posBought = {};
    const posSold = {};
    let earlyBuys = 0, lateSells = 0, totalTimedTrades = 0;
    let partnerDNA = {};
    let tradesWon = 0, tradesLost = 0, tradesFair = 0;

    Object.entries(ownerProfiles).forEach(([rid, prof]) => {
      const ridNum = parseInt(rid);
      if (!ridSet.has(ridNum)) return;
      totalTrades += prof.trades || 0;
      totalValueGained += prof.avgValueDiff || 0;
      tradesWon += prof.tradesWon || 0;
      tradesLost += prof.tradesLost || 0;
      tradesFair += prof.tradesFair || 0;

      Object.entries(prof.posAcquired || {}).forEach(([pos, cnt]) => {
        posBought[pos] = (posBought[pos] || 0) + cnt;
      });
      Object.entries(prof.posSold || {}).forEach(([pos, cnt]) => {
        posSold[pos] = (posSold[pos] || 0) + cnt;
      });

      const timing = prof.weekTiming || {};
      earlyBuys += timing.early || 0;
      lateSells += timing.late || 0;
      totalTimedTrades += (timing.early || 0) + (timing.mid || 0) + (timing.late || 0);

      // Partner analysis: which DNA types do they trade with
      Object.entries(prof.partners || {}).forEach(([partner, cnt]) => {
        const partnerProf = ownerProfiles[partner];
        const dna = partnerProf?.dna || 'Unknown';
        partnerDNA[dna] = (partnerDNA[dna] || 0) + cnt;
      });
    });

    const ridCount = ridSet.size || 1;
    const leagueSeasonCount = (LI.leagueYears || []).length || 5;
    const topPartner = Object.entries(partnerDNA).sort((a, b) => b[1] - a[1])[0];

    return {
      avgTradesPerSeason: leagueSeasonCount > 0 ? +(totalTrades / ridCount / leagueSeasonCount).toFixed(1) : 0,
      totalTrades,
      avgValueGained: totalTrades > 0 ? Math.round(totalValueGained / ridCount) : 0,
      positionsBought: posBought,
      positionsSold: posSold,
      partnerPreference: topPartner ? topPartner[0] : 'Unknown',
      tradesWon,
      tradesLost,
      tradesFair,
      tradeWinRate: (tradesWon + tradesLost + tradesFair) > 0 ? +(tradesWon / (tradesWon + tradesLost + tradesFair)).toFixed(2) : 0,
    };
  }

  const allRids = new Set(Object.keys(ownerProfiles).map(Number));
  const winnerTradeProfile = buildTradeProfile(winnerSet);
  const leagueTradeProfile = buildTradeProfile(allRids);
  const myTradeProfile = myRid ? buildTradeProfile(new Set([myRid])) : { ...leagueTradeProfile };

  // Winner timing
  let wEarly = 0, wLate = 0, wTotal = 0;
  let lEarly = 0, lLate = 0, lTotal = 0;
  Object.entries(ownerProfiles).forEach(([rid, prof]) => {
    const timing = prof.weekTiming || {};
    const e = timing.early || 0;
    const l = timing.late || 0;
    const t = e + (timing.mid || 0) + l;
    if (winnerSet.has(parseInt(rid))) { wEarly += e; wLate += l; wTotal += t; }
    lEarly += e; lLate += l; lTotal += t;
  });

  // Last 5 trades breakdown for the user
  const pn = pid => S?.players?.[pid]?.full_name || pid;
  const mapMyTrade = t => {
    const mySide = t.sides?.[myRid] || { players: [], picks: [], totalValue: 0 };
    const otherRid = t.roster_ids?.find(r => r !== myRid);
    const theirSide = otherRid ? (t.sides?.[otherRid] || { players: [], picks: [], totalValue: 0 }) : mySide;
    const myVal = mySide.totalValue || 0;
    const theirVal = theirSide.totalValue || 0;
    const net = myVal - theirVal;
    return {
      season: t.season, week: t.week, ts: t.ts || 0,
      gave: (theirSide.players || []).slice(0, 3).map(pn),
      got: (mySide.players || []).slice(0, 3).map(pn),
      gavePicks: (theirSide.picks || []).length,
      gotPicks: (mySide.picks || []).length,
      myVal, theirVal, net, netDhq: net, // netDhq alias: the trades-tab template reads trade.netDhq
      result: net > theirVal * 0.05 ? 'won' : net < -myVal * 0.05 ? 'lost' : 'fair',
      fairness: t.fairness || 0,
    };
  };
  const myTradesMapped = tradeHistory.filter(t => t.roster_ids?.includes(myRid)).map(mapMyTrade);
  const myLast5 = [...myTradesMapped].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 5);
  // All-time most-lopsided trades (same clean shape as myLast5) for the Biggest Win/Loss KPI.
  const myBiggestWin = myTradesMapped.filter(t => t.net > 0).sort((a, b) => b.net - a.net)[0] || null;
  const myBiggestLoss = myTradesMapped.filter(t => t.net < 0).sort((a, b) => a.net - b.net)[0] || null;

  return {
    winnerTradeProfile,
    leagueTradeProfile,
    myTradeProfile,
    myLast5,
    myBiggestWin,
    myBiggestLoss,
    winnerTiming: {
      earlyBuys: wTotal > 0 ? +(wEarly / wTotal).toFixed(2) : 0,
      lateSells: wTotal > 0 ? +(wLate / wTotal).toFixed(2) : 0,
    },
    leagueTiming: {
      earlyBuys: lTotal > 0 ? +(lEarly / lTotal).toFixed(2) : 0,
      lateSells: lTotal > 0 ? +(lLate / lTotal).toFixed(2) : 0,
    },
  };
}

// ── Section 6: Projection Engine ─────────────────────────────────

function projectRoster(rosterId, yearsAhead) {
  const S = window.S || window.App?.S;
  const LI = window.App?.LI || (typeof window.LI !== 'undefined' ? window.LI : {});
  const playerScores = LI.playerScores || {};
  const playerMeta = LI.playerMeta || {};

  if (!S?.rosters || !rosterId) return [];

  const roster = S.rosters.find(r => r.roster_id === rosterId);
  if (!roster) return [];

  const currentYear = parseInt(S.season) || new Date().getFullYear();
  const ageCurveWindows = window.App.ageCurveWindows || {
    QB: { build: [23, 27], peak: [28, 34], decline: [35, 38] },
    RB: { build: [21, 22], peak: [23, 25], decline: [26, 28] },
    WR: { build: [22, 24], peak: [25, 28], decline: [29, 31] },
    TE: { build: [23, 25], peak: [26, 29], decline: [30, 32] },
    DL: { build: [22, 24], peak: [25, 29], decline: [30, 32] },
    LB: { build: [22, 23], peak: [24, 28], decline: [29, 31] },
    DB: { build: [21, 23], peak: [24, 27], decline: [28, 30] },
    K: { build: [23, 27], peak: [28, 35], decline: [36, 40] },
  };
  const peakWindows = window.App.peakWindows || Object.fromEntries(Object.entries(ageCurveWindows).map(([pos, curve]) => [pos, curve.peak]));
  const decayRates = window.App.decayRates || { QB: 0.12, RB: 0.22, WR: 0.18, TE: 0.16, K: 0.08, DL: 0.15, LB: 0.16, DB: 0.18 };
  const players = roster.players || [];
  const totalTeams = S.rosters.length || 12;

  // Estimate draft pick value added per year (avg of mid-round picks)
  const draftPickBoost = (LI.hitRateByRound?.[1]?.rate || 40) > 0 ? 2500 : 1500;

  const projections = [];
  for (let yr = 1; yr <= (yearsAhead || 5); yr++) {
    let projectedTotal = 0;
    let healthyCount = 0;

    players.forEach(pid => {
      const meta = playerMeta[pid];
      if (!meta) return;
      const baseScore = playerScores[pid] || 0;
      if (baseScore <= 0) return;

      const futureAge = (meta.age || 26) + yr;
      const pos = meta.pos || 'WR';
      const curve = ageCurveWindows[pos] || { build: [22, 24], peak: peakWindows[pos] || [23, 29], decline: [30, 32] };
      const decayRate = decayRates[pos] || 0.16;
      const peakStart = curve.peak[0];
      const peakEnd = curve.peak[1];
      const declineEnd = curve.decline[1];

      let ageFactor;
      if (futureAge < peakStart) {
        // Pre-peak: growing
        ageFactor = 0.85 + 0.15 * (1 - (peakStart - futureAge) / Math.max(1, peakStart - 19));
      } else if (futureAge <= peakEnd) {
        ageFactor = 1.0;
      } else if (futureAge <= declineEnd) {
        const declineFloor = { QB: 0.78, RB: 0.62, WR: 0.68, TE: 0.70, K: 0.82, DL: 0.70, LB: 0.68, DB: 0.66 }[pos] || 0.68;
        const progress = (futureAge - peakEnd) / Math.max(1, declineEnd - peakEnd);
        ageFactor = 1 - (1 - declineFloor) * Math.max(0, Math.min(1, progress));
      } else {
        const declineFloor = { QB: 0.78, RB: 0.62, WR: 0.68, TE: 0.70, K: 0.82, DL: 0.70, LB: 0.68, DB: 0.66 }[pos] || 0.68;
        const yearsPost = Math.max(0, futureAge - declineEnd);
        ageFactor = Math.max(0.05, declineFloor - yearsPost * decayRate);
        if (yearsPost >= 3) ageFactor *= 0.75;
        if (yearsPost >= 6) ageFactor *= 0.55;
        ageFactor = Math.max(0.02, ageFactor);
      }

      const projected = baseScore * ageFactor;
      projectedTotal += projected;
      if (projected >= 2000) healthyCount++;
    });

    // Add estimated draft pick production (one rookie class per year)
    projectedTotal += draftPickBoost * yr * 0.5; // diminishing certainty on future picks

    const projectedHealth = players.length > 0 ? Math.round((healthyCount / players.length) * 100) : 0;
    const avgLeagueDHQ = S.rosters.reduce((s, r) => {
      return s + (r.players || []).reduce((ps, pid) => ps + (playerScores[pid] || 0), 0);
    }, 0) / totalTeams;

    let tier;
    if (projectedTotal >= avgLeagueDHQ * 1.2) tier = 'Contender';
    else if (projectedTotal >= avgLeagueDHQ * 0.95) tier = 'Playoff Team';
    else if (projectedTotal >= avgLeagueDHQ * 0.75) tier = 'Rebuilding';
    else tier = 'Deep Rebuild';

    projections.push({
      year: currentYear + yr,
      projectedDHQ: Math.round(projectedTotal),
      projectedHealth,
      tier,
    });
  }

  return projections;
}

function projectCompetitiveWindow(rosterId) {
  const S = window.S || window.App?.S;
  const currentYear = parseInt(S?.season) || new Date().getFullYear();
  const proj = projectRoster(rosterId, 5);
  if (!proj || !proj.length) return { windowEnd: currentYear, years: 0, label: 'Unknown' };

  // Find last year roster stays at Contender or Playoff Team tier
  let windowEnd = currentYear;
  for (const p of proj) {
    if (p.tier === 'Contender' || p.tier === 'Playoff Team') {
      windowEnd = p.year;
    } else {
      break;
    }
  }

  const years = windowEnd - currentYear;
  let label;
  if (years >= 4) label = 'Wide open (' + currentYear + '-' + windowEnd + ')';
  else if (years >= 2) label = 'Competing through ' + windowEnd;
  else if (years >= 1) label = 'Win-now: closing ' + windowEnd;
  else label = 'Window closed — rebuild mode';

  return { windowEnd, years, label };
}

function generateGapAnalysis(myProfile, winnerProfile) {
  if (!myProfile || !winnerProfile) return [];

  const actions = [];
  const myDHQ = myProfile.avgTotalDHQ || 0;
  const winDHQ = winnerProfile.avgTotalDHQ || 1;

  // Position-level gaps: compare actual DHQ invested (not just %)
  const positions = new Set([
    ...Object.keys(myProfile.posInvestment || {}),
    ...Object.keys(winnerProfile.posInvestment || {}),
  ]);

  positions.forEach(pos => {
    if (pos === 'UNK') return;
    const myDHQAtPos = Math.round((myProfile.posInvestment?.[pos] || 0) * myDHQ);
    const winDHQAtPos = Math.round((winnerProfile.posInvestment?.[pos] || 0) * winDHQ);
    const gap = winDHQAtPos - myDHQAtPos;
    if (gap > 2000) {
      const severity = gap > 8000 ? 'critical' : gap > 4000 ? 'high' : 'medium';
      // Count startable players (DHQ >= 3000) at this position for human-readable text
      const myStartable = myProfile.posStartable?.[pos] || 0;
      const winStartable = winnerProfile.posStartable?.[pos] || 0;
      const startableDiff = Math.max(0, Math.round(winStartable - myStartable));
      const humanDetail = startableDiff > 0
        ? 'You need ' + (startableDiff === 1 ? 'another' : startableDiff + ' more') + ' starting-caliber ' + pos + '. Contending teams typically roster ' + Math.round(winStartable) + ' startable ' + pos + 's, you have ' + Math.round(myStartable) + '.'
        : 'You have ' + myDHQAtPos.toLocaleString() + ' DHQ at ' + pos + '. Champions average ' + winDHQAtPos.toLocaleString() + '.';
      actions.push({
        priority: severity,
        action: 'Upgrade ' + pos + ' — ' + (startableDiff > 0 ? startableDiff + ' starter' + (startableDiff > 1 ? 's' : '') + ' short' : gap.toLocaleString() + ' DHQ behind winners'),
        detail: humanDetail,
        yours: myDHQAtPos, winners: winDHQAtPos, dhqGap: gap, pos, unit: 'DHQ',
      });
    }
  });

  // Starter depth: how many 4000+ DHQ players
  if (myProfile.avgStarterCount < winnerProfile.avgStarterCount - 0.5) {
    const deficit = +(winnerProfile.avgStarterCount - myProfile.avgStarterCount).toFixed(1);
    const need = Math.max(1, Math.ceil(deficit));
    actions.push({
      priority: 'high',
      action: 'Add ' + need + ' more starter-quality ' + (need === 1 ? 'player' : 'players'),
      detail: 'Champions average ' + winnerProfile.avgStarterCount + ' starter-quality players (4000+ DHQ). You have ' + myProfile.avgStarterCount + '.',
      yours: myProfile.avgStarterCount, winners: winnerProfile.avgStarterCount, dhqGap: Math.round(deficit * 4500), unit: 'players',
    });
  }

  // Elite talent: 7000+ DHQ or top 5 at position cornerstones
  if (myProfile.avgEliteCount < winnerProfile.avgEliteCount - 0.3) {
    const deficit = +(winnerProfile.avgEliteCount - myProfile.avgEliteCount).toFixed(1);
    const need = Math.max(1, Math.ceil(deficit));
    actions.push({
      priority: 'critical',
      action: 'Acquire ' + need + ' elite ' + (need === 1 ? 'player' : 'players'),
      detail: 'Champions average ' + winnerProfile.avgEliteCount + ' elite cornerstones (7000+ DHQ or top-5 at position). You have ' + myProfile.avgEliteCount + '.',
      yours: myProfile.avgEliteCount, winners: winnerProfile.avgEliteCount, dhqGap: Math.round(deficit * 7500), unit: 'players',
    });
  }

  // Age: older rosters decline faster
  if (myProfile.avgAge > winnerProfile.avgAge + 1.0) {
    const gap = +(myProfile.avgAge - winnerProfile.avgAge).toFixed(1);
    actions.push({
      priority: 'medium',
      action: 'Get younger — your roster is ' + gap + ' years older than champions',
      detail: 'Your avg age ' + myProfile.avgAge + ' vs champions ' + winnerProfile.avgAge + '. Sell aging vets for young assets.',
      yours: myProfile.avgAge, winners: winnerProfile.avgAge, dhqGap: 0, unit: 'years',
    });
  }

  // Bench quality
  if (myProfile.avgBenchQuality < winnerProfile.avgBenchQuality * 0.70) {
    actions.push({
      priority: 'medium',
      action: 'Improve bench depth — your backups are weak',
      detail: 'Bench quality ' + (myProfile.avgBenchQuality||0).toLocaleString() + ' DHQ vs champion avg ' + (winnerProfile.avgBenchQuality||0).toLocaleString() + '.',
      yours: myProfile.avgBenchQuality, winners: winnerProfile.avgBenchQuality, dhqGap: 0, unit: 'DHQ',
    });
  }

  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  actions.sort((a, b) => (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3));

  return actions;
}

// ── Section 7: Master Analysis Function ──────────────────────────

function runLeagueAnalytics() {
  const S = window.S || window.App?.S;
  const LI = window.App?.LI || (typeof window.LI !== 'undefined' ? window.LI : {});

  if (!S?.rosters?.length || !LI.playerScores) {
    console.warn('analytics-engine: missing rosters or LI.playerScores — skipping');
    return null;
  }

  try {
    const winnerResult = identifyWinners(S.rosters);
    const { winners, losers, winnerSeasons } = winnerResult;
    const winnerSource = winnerResult.source || 'standings';
    const draft = analyzeDraftPatterns(winners, losers);
    const waivers = analyzeWaiverPatterns(winners, losers);
    const roster = analyzeRosterConstruction(winners, losers, S.rosters);
    const trades = analyzeTradePatterns(winners, losers);
    const projection = projectRoster(S.myRosterId, 5);
    const competitiveWindow = projectCompetitiveWindow(S.myRosterId);
    const gaps = generateGapAnalysis(roster.myProfile, roster.winnerProfile);

    const result = {
      winners: Array.from(winners),
      losers: Array.from(losers),
      winnerSeasons,
      winnerSource,
      winnerCount: winners.size,
      draft,
      waivers,
      roster,
      trades,
      projection,
      window: competitiveWindow,
      gaps,
      ownerHistory: buildOwnerHistory(),
      computedAt: new Date().toISOString(),
    };

    console.log('analytics-engine: complete', result);
    return result;
  } catch (err) {
    console.error('analytics-engine: error during analysis', err);
    return null;
  }
}

// ── Section 8: Rivalry Detection ─────────────────────────────

function detectRivalries(rosterId) {
  const brackets = window.App?.LI?.bracketData || {};
  const matchups = {};

  Object.entries(brackets).forEach(([season, { winners, losers }]) => {
    // Winners bracket matchups
    (winners || []).forEach(m => {
      if (m.t1 === rosterId || m.t2 === rosterId) {
        const opponent = m.t1 === rosterId ? m.t2 : m.t1;
        if (!opponent || typeof opponent !== 'number') return;
        if (!matchups[opponent]) matchups[opponent] = { wins: 0, losses: 0, seasons: [], meetings: [] };
        if (m.w === rosterId) matchups[opponent].wins++;
        else if (m.l === rosterId) matchups[opponent].losses++;
        matchups[opponent].seasons.push(season);
        matchups[opponent].meetings.push({ season, bracket: 'winners', round: m.r || 0, won: m.w === rosterId });
      }
    });
    // Losers bracket matchups
    (losers || []).forEach(m => {
      if (m.t1 === rosterId || m.t2 === rosterId) {
        const opponent = m.t1 === rosterId ? m.t2 : m.t1;
        if (!opponent || typeof opponent !== 'number') return;
        if (!matchups[opponent]) matchups[opponent] = { wins: 0, losses: 0, seasons: [], meetings: [] };
        if (m.w === rosterId) matchups[opponent].wins++;
        else if (m.l === rosterId) matchups[opponent].losses++;
        matchups[opponent].seasons.push(season);
        matchups[opponent].meetings.push({ season, bracket: 'losers', round: m.r || 0, won: m.w === rosterId });
      }
    });
  });

  return Object.entries(matchups)
    .map(([rid, data]) => ({ rosterId: parseInt(rid), ...data, total: data.wins + data.losses }))
    .filter(r => r.total >= 2)
    .sort((a, b) => b.total - a.total);
}

// ══════════════════════════════════════════════════════════════════
// Section 9: Full League History by Owner
// ══════════════════════════════════════════════════════════════════

function buildOwnerHistory() {
    const S = window.S || window.App?.S;
    const LI = window.App?.LI || {};
    if (!S?.rosters?.length) return {};

    const championships = LI.championships || {};
    const bracketData = LI.bracketData || {};
    const usersHistory = LI.leagueUsersHistory || {};
    const draftOutcomes = LI.draftOutcomes || [];
    const tradeHistory = LI.tradeHistory || [];
    const ownerProfiles = LI.ownerProfiles || {};

    const history = {}; // rosterId -> full history object

    S.rosters.forEach(roster => {
        const rid = roster.roster_id;
        const user = S.leagueUsers?.find(u => u.user_id === roster.owner_id);
        const profile = ownerProfiles[rid] || {};
        const s = roster.settings || {};

        // Current season record
        const wins = s.wins || 0;
        const losses = s.losses || 0;
        const ties = s.ties || 0;
        const pf = (s.fpts || 0) + ((s.fpts_decimal || 0) / 100);
        const pa = (s.fpts_against || 0) + ((s.fpts_against_decimal || 0) / 100);

        // Championships
        const champSeasons = [];
        const runnerUpSeasons = [];
        const playoffSeasons = [];
        Object.entries(championships).forEach(([season, c]) => {
            if (c.champion === rid) champSeasons.push(season);
            if (c.runnerUp === rid) runnerUpSeasons.push(season);
            if (c.champion === rid || c.runnerUp === rid || (c.semiFinals || []).includes(rid)) playoffSeasons.push(season);
        });

        // Playoff record — championship-path games only (exclude consolation/placement).
        // Walk from the title game (p===1) via t#_from.w MATCHUP-NUMBER pointers. t1/t2/w/l
        // are ROSTER IDS and must never be compared to .m (the old tracing mixed the two
        // ID spaces and the realRounds heuristic mis-bucketed byes / two-week finals).
        let playoffWins = 0, playoffLosses = 0;
        Object.entries(bracketData).forEach(([season, { winners }]) => {
            if (!winners?.length) return;
            const byId = {}; winners.forEach(m => { byId[m.m] = m; });
            let start = winners.find(m => m.p === 1);
            if (!start) {
                const maxR = Math.max(...winners.map(m => m.r || 0));
                const finals = winners.filter(m => (m.r || 0) === maxR);
                if (finals.length === 1) start = finals[0];
            }
            const realMatchIds = new Set();
            if (start) {
                const queue = [start];
                while (queue.length) {
                    const g = queue.shift();
                    if (!g || realMatchIds.has(g.m)) continue;
                    realMatchIds.add(g.m);
                    [g.t1_from, g.t2_from].forEach(fr => { if (fr && fr.w != null && byId[fr.w]) queue.push(byId[fr.w]); });
                }
            }
            winners.forEach(m => {
                if (!realMatchIds.has(m.m)) return;
                if (m.w === rid) playoffWins++;
                else if (m.l === rid) playoffLosses++;
            });
        });

        // Draft history — #1 overall picks
        const numberOnePicks = [];
        const allDraftPicks = draftOutcomes.filter(d => d.roster_id === rid);
        const firstOveralls = draftOutcomes.filter(d => d.pick_no === 1 && d.roster_id === rid);
        firstOveralls.forEach(d => numberOnePicks.push({ season: d.season, player: d.name, pos: d.pos }));

        // Draft hit rate
        const draftHits = allDraftPicks.filter(d => d.isStarter).length;
        const draftTotal = allDraftPicks.length;
        const draftHitRate = draftTotal > 0 ? Math.round(draftHits / draftTotal * 100) : 0;

        // Best draft pick (highest bestTotal)
        const bestPick = allDraftPicks.sort((a, b) => (b.bestTotal || 0) - (a.bestTotal || 0))[0] || null;

        // Worst draft pick (drafted in R1-R2 but never became starter)
        const bustPicks = allDraftPicks.filter(d => d.round <= 2 && !d.isStarter && d.seasonsAvailable >= 2);

        // Trade history
        const tradesWon = profile.tradesWon || 0;
        const tradesLost = profile.tradesLost || 0;
        const tradesFair = profile.tradesFair || 0;
        const totalTrades = profile.trades || 0;
        const avgValueDiff = profile.avgValueDiff || 0;
        const biggestWin = profile.biggestWin || null;
        const biggestLoss = profile.biggestLoss || null;

        // Season-by-season record (from bracket/roster data)
        const seasonHistory = [];
        const allSeasons = Object.keys(usersHistory).sort();
        allSeasons.forEach(season => {
            const wasInLeague = (usersHistory[season] || []).some(u => u.user_id === roster.owner_id);
            if (!wasInLeague) return;

            const champ = championships[season];
            let finish = 'Regular Season';
            if (champ?.champion === rid) finish = 'Champion';
            else if (champ?.runnerUp === rid) finish = 'Runner-Up';
            else if ((champ?.semiFinals || []).includes(rid)) finish = 'Semi-Finals';
            else {
                // Check if in bracket at all
                const bracket = bracketData[season]?.winners || [];
                const inBracket = bracket.some(m => m.t1 === rid || m.t2 === rid);
                if (inBracket) finish = 'Playoffs';
            }

            // Check for #1 pick
            const hadFirstPick = draftOutcomes.some(d => d.season === season && d.pick_no === 1 && d.roster_id === rid);

            seasonHistory.push({ season, finish, hadFirstPick });
        });

        // Tenure
        const tenure = seasonHistory.length;

        // Current DHQ value
        const totalDHQ = (roster.players || []).reduce((sum, pid) => sum + (LI.playerScores?.[pid] || 0), 0);

        // Rivalries
        const rivalries = typeof detectRivalries === 'function' ? detectRivalries(rid) : [];

        history[rid] = {
            rosterId: rid,
            ownerId: roster.owner_id,
            ownerName: user?.metadata?.team_name || user?.display_name || user?.username || 'Team',
            avatar: user?.avatar,

            // Current
            record: `${wins}-${losses}${ties ? '-' + ties : ''}`,
            wins, losses, ties,
            pointsFor: +pf.toFixed(1),
            pointsAgainst: +pa.toFixed(1),
            totalDHQ,

            // Championships
            championships: champSeasons.length,
            champSeasons,
            runnerUps: runnerUpSeasons.length,
            runnerUpSeasons,
            playoffAppearances: playoffSeasons.length,
            playoffSeasons,
            playoffRecord: `${playoffWins}-${playoffLosses}`,
            playoffWins,
            playoffLosses,

            // Draft
            numberOnePicks,
            draftHitRate,
            draftTotal,
            draftHits,
            bestPick: bestPick ? { name: bestPick.name, season: bestPick.season, round: bestPick.round, pos: bestPick.pos } : null,
            bustPicks: bustPicks.slice(0, 3).map(d => ({ name: d.name, season: d.season, round: d.round, pos: d.pos })),

            // Trades
            totalTrades,
            tradesWon,
            tradesLost,
            tradesFair,
            avgValueDiff: Math.round(avgValueDiff),
            biggestWin,
            biggestLoss,

            // Season history
            seasonHistory,
            tenure,

            // Rivalries
            rivalries: rivalries.slice(0, 3),
        };
    });

    return history;
}

// ── Section 7: Weighted DNA Computation ─────────────────────────

function computeWeightedDNA(rosterId) {
    const LI = window.App?.LI || {};
    const profile = LI.ownerProfiles?.[rosterId];
    const trades = (LI.tradeHistory || []).filter(t => t.roster_ids?.includes(rosterId));
    if (!profile || trades.length < 3) return null;

    const curSeason = parseInt(window.S?.season || window.App?.S?.season || new Date().getFullYear());

    // Weight trades by recency: current year = 4x, last year = 2x, 2 years ago = 1x, older = 0.5x
    let weightedWins = 0, weightedLosses = 0, weightedFair = 0, totalWeight = 0;
    let weightedPicksBought = 0, weightedPicksSold = 0;
    let weightedVolume = 0;
    let lateTrades = 0, earlyTrades = 0;

    trades.forEach(t => {
        const season = parseInt(t.season) || 0;
        const yearsAgo = curSeason - season;
        const weight = yearsAgo === 0 ? 4 : yearsAgo === 1 ? 2 : yearsAgo === 2 ? 1 : 0.5;

        totalWeight += weight;
        weightedVolume += weight;

        // Win/loss based on value
        const mySide = t.sides?.[rosterId];
        const otherRid = t.roster_ids?.find(r => r !== rosterId);
        const theirSide = t.sides?.[otherRid];
        const myVal = mySide?.totalValue || 0;
        const theirVal = theirSide?.totalValue || 0;

        if (myVal > theirVal * 1.15) weightedWins += weight;
        else if (theirVal > myVal * 1.15) weightedLosses += weight;
        else weightedFair += weight;

        // Pick direction
        const gotPicks = (mySide?.picks || []).length;
        const gavePicks = (theirSide?.picks || []).length;
        weightedPicksBought += gotPicks * weight;
        weightedPicksSold += gavePicks * weight;

        // Timing
        if ((t.week || 0) <= 6) earlyTrades += weight;
        else if ((t.week || 0) >= 12) lateTrades += weight;
    });

    if (totalWeight === 0) return null;

    // Normalize
    const winRate = weightedWins / totalWeight;
    const lossRate = weightedLosses / totalWeight;
    const fairRate = weightedFair / totalWeight;
    const pickBuyer = weightedPicksBought > weightedPicksSold * 1.5;
    const pickSeller = weightedPicksSold > weightedPicksBought * 1.5;
    const highVolume = weightedVolume / totalWeight > 0.7;
    const lateSeason = lateTrades > earlyTrades;

    // Score each archetype
    const scores = {
        FLEECER: 0,
        DOMINATOR: 0,
        STALWART: 0,
        ACCEPTOR: 0,
        DESPERATE: 0,
    };

    // FLEECER: consistently wins trades
    if (winRate > lossRate * 2 && trades.length >= 3) scores.FLEECER = 0.5 + winRate * 0.3;
    if (pickSeller) scores.FLEECER += 0.1;

    // DOMINATOR: wins trades AND high volume
    if (winRate > lossRate && highVolume) scores.DOMINATOR = 0.4 + winRate * 0.3;
    if (pickSeller) scores.DOMINATOR += 0.15;

    // STALWART: prefers fair deals
    if (fairRate >= 0.5 && trades.length >= 3) scores.STALWART = 0.5 + fairRate * 0.3;

    // ACCEPTOR: loses trades, buys picks
    if (lossRate > winRate && pickBuyer) scores.ACCEPTOR = 0.4 + lossRate * 0.3;

    // DESPERATE: low volume, late-season, losing trades
    if (lateSeason && lossRate > 0.3) scores.DESPERATE = 0.4 + lossRate * 0.2;
    if (pickBuyer && lateSeason) scores.DESPERATE += 0.15;

    // Find highest
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (sorted[0][1] === 0) return null;

    const confidence = Math.min(0.99, sorted[0][1]);
    return {
        key: sorted[0][0],
        confidence: Math.round(confidence * 100),
        reasoning: buildDNAReasoning(sorted[0][0], { winRate, lossRate, fairRate, pickBuyer, pickSeller, highVolume, lateSeason, totalTrades: trades.length, weightedWins, weightedLosses }),
    };
}

function buildDNAReasoning(key, stats) {
    const reasons = [];
    switch(key) {
        case 'FLEECER':
            reasons.push('Wins ' + Math.round(stats.winRate * 100) + '% of trades (weighted by recency)');
            if (stats.pickSeller) reasons.push('Sells picks for proven players');
            break;
        case 'DOMINATOR':
            reasons.push('High volume trader who wins ' + Math.round(stats.winRate * 100) + '% of deals');
            if (stats.pickSeller) reasons.push('Moves picks aggressively');
            break;
        case 'STALWART':
            reasons.push(Math.round(stats.fairRate * 100) + '% of trades are balanced/fair');
            reasons.push('Prefers even value swaps');
            break;
        case 'ACCEPTOR':
            reasons.push('Loses ' + Math.round(stats.lossRate * 100) + '% of trades by value');
            if (stats.pickBuyer) reasons.push('Accumulates future picks');
            break;
        case 'DESPERATE':
            reasons.push('Trades late in the season at a disadvantage');
            if (stats.lossRate > 0.3) reasons.push(Math.round(stats.lossRate * 100) + '% of trades are losses');
            break;
    }
    return reasons.join('. ') + '.';
}

// ── Exports ──────────────────────────────────────────────────────

Object.assign(window.App, {
  runLeagueAnalytics,
  identifyWinners,
  analyzeDraftPatterns,
  analyzeWaiverPatterns,
  analyzeRosterConstruction,
  analyzeTradePatterns,
  projectRoster,
  projectCompetitiveWindow,
  generateGapAnalysis,
  detectRivalries,
  buildOwnerHistory,
  computeWeightedDNA,
  buildDNAReasoning,
});
Object.assign(window, { runLeagueAnalytics, detectRivalries, buildOwnerHistory, computeWeightedDNA });

// ── Module global exports (Vite migration) ───────────────────────────────────
window.identifyWinners = identifyWinners;
window.analyzeDraftPatterns = analyzeDraftPatterns;
window.analyzeWaiverPatterns = analyzeWaiverPatterns;
window.analyzeRosterConstruction = analyzeRosterConstruction;
window.analyzeTradePatterns = analyzeTradePatterns;
window.projectRoster = projectRoster;
window.projectCompetitiveWindow = projectCompetitiveWindow;
window.generateGapAnalysis = generateGapAnalysis;
window.buildDNAReasoning = buildDNAReasoning;
window.detectRivalries = detectRivalries;
