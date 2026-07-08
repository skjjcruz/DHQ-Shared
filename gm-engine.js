// ══════════════════════════════════════════════════════════════════
// shared/gm-engine.js — GM Intelligence Engines v1
// Phase 2: generates specific, data-driven War Room Brief content
// ══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ── Helpers ────────────────────────────────────────────────────

  function _S()  { return window.S  || {}; }
  function _LI() { return window.LI || {}; }

  function _myRoster() {
    return typeof myR === 'function' ? myR() : null;
  }

  function _assess(rosterId) {
    return typeof window.assessTeamFromGlobal === 'function'
      ? window.assessTeamFromGlobal(rosterId) : null;
  }

  function _allAssess() {
    return typeof window.assessAllTeamsFromGlobal === 'function'
      ? window.assessAllTeamsFromGlobal() : [];
  }

  function _dhq(pid) {
    return typeof dynastyValue === 'function' ? dynastyValue(pid) : 0;
  }

  function _name(pid) {
    if (!pid) return '—';
    const S = _S();
    const p = S.players?.[pid];
    if (!p) return pid;
    return p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || pid;
  }

  function _pos(pid) {
    return _S().players?.[pid]?.position || '';
  }

  function _strategy() {
    return (window.GMStrategy?.getStrategy) ? window.GMStrategy.getStrategy() : {};
  }

  // Normalize position to fantasy-relevant canonical (RB, WR, QB, TE, DL, LB, DB)
  function _normPos(pos) {
    if (!pos) return '';
    const map = {
      FLEX: '', SUPER_FLEX: '', IDP_FLEX: '', BN: '', IR: '', TAXI: '',
      DE: 'DL', DT: 'DL', NT: 'DL', IDL: 'DL', EDGE: 'DL',
      CB: 'DB', S: 'DB', SS: 'DB', FS: 'DB',
    };
    return map[pos] !== undefined ? map[pos] : pos;
  }

  // Get top N players on a roster at a specific position, sorted by DHQ desc
  function _rosterPlayersAtPos(playerIds, pos) {
    return (playerIds || [])
      .filter(pid => _normPos(_pos(pid)) === pos)
      .map(pid => ({ pid, name: _name(pid), dhq: _dhq(pid) }))
      .sort((a, b) => b.dhq - a.dhq);
  }

  function _currentLeague() {
    const S = _S();
    return (S.leagues || []).find(l => l.league_id === S.currentLeagueId) || (S.leagues || [])[0] || null;
  }

  function _calendarContext() {
    const league = _currentLeague();
    const cal = window.SeasonCalendar;
    if (cal?.describe) return cal.describe(league);
    return { phase: cal?.getPhase?.(league) || 'offseason', label: 'Offseason', weeksToNext: null, nextMilestone: null };
  }

  function _bestAvailableAtPos(pos) {
    if (typeof window.getAvailablePlayers !== 'function') return null;
    try {
      return (window.getAvailablePlayers() || [])
        .map(a => {
          const pid = a.id || a.pid || a.player_id;
          const p = a.p || _S().players?.[pid] || {};
          return {
            pid,
            name: _name(pid),
            dhq: Math.round(Number(a.val || _dhq(pid) || 0)),
            pos: _normPos(p.position || _pos(pid)),
          };
        })
        .filter(a => a.pid && a.pos === pos && a.dhq > 0)
        .sort((a, b) => b.dhq - a.dhq)[0] || null;
    } catch {
      return null;
    }
  }

  function _strategyContextText(strategy, topNeed) {
    const targets = strategy.targetPositions || [];
    const mode = (strategy.mode || 'balanced_rebuild').replace(/_/g, ' ');
    const targetNote = targets.includes(topNeed) ? `${topNeed} is already a War Room target position.` : `War Room strategy is ${mode}.`;
    const healthNote = strategy.aggression === 'conservative'
      ? ' Conservative posture raises the bar for forced adds.'
      : strategy.aggression === 'aggressive'
        ? ' Aggressive posture still needs an asset worth buying.'
        : '';
    return targetNote + healthNote;
  }

  function _phaseAwareFallbackMove(topNeed, myAssess, strategy) {
    const cal = _calendarContext();
    const bestWaiver = _bestAvailableAtPos(topNeed);
    const phase = cal.phase || 'offseason';
    const phaseLabel = cal.label || 'Offseason';
    const waiverFloor = ['regular_season', 'playoffs'].includes(phase) ? 900 : 1200;
    const bestWaiverText = bestWaiver
      ? ` Best available ${topNeed} is ${bestWaiver.name} at ${bestWaiver.dhq.toLocaleString()} DHQ, below the ${waiverFloor.toLocaleString()} DHQ action floor.`
      : ` No usable ${topNeed} waiver target is visible.`;
    const healthText = myAssess?.healthScore ? ` Health ${Math.round(myAssess.healthScore)}.` : '';
    const strategyText = _strategyContextText(strategy, topNeed);
    const milestoneText = cal.nextMilestone
      ? ` ${cal.nextMilestone}${cal.weeksToNext != null ? ` in ${cal.weeksToNext}w` : ''}.`
      : '';

    if (bestWaiver && bestWaiver.dhq >= waiverFloor) {
      const alignment = window.GMStrategy?.checkAlignment
        ? window.GMStrategy.checkAlignment({ type: 'waiver', direction: 'acquire', position: topNeed, playerId: bestWaiver.pid })
        : { alignment: 'partial' };
      return {
        type: 'waiver',
        action: `Add ${bestWaiver.name} only if the price stays modest`,
        targetPlayer: { pid: bestWaiver.pid, name: bestWaiver.name },
        targetOwner: null,
        confidence: bestWaiver.dhq >= waiverFloor + 600 ? 'medium' : 'low',
        urgency: phase === 'regular_season' ? 'this_week' : '2_weeks',
        alignment,
        reasoning: `${phaseLabel}.${milestoneText} ${topNeed} is your biggest roster gap, and ${bestWaiver.name} is the top available option at ${bestWaiver.dhq.toLocaleString()} DHQ. ${strategyText}${healthText}`,
      };
    }

    if (phase === 'pre_draft' || phase === 'draft_week') {
      return {
        type: 'draft',
        action: `Build the rookie board around ${topNeed} before chasing waivers`,
        targetPlayer: null,
        targetOwner: null,
        confidence: 'high',
        urgency: phase === 'draft_week' ? 'this_week' : 'before_draft',
        alignment: { alignment: 'aligned' },
        reasoning: `${phaseLabel}.${milestoneText}${bestWaiverText} ${strategyText}${healthText} Use draft capital or trade-down planning to solve the room instead of spending on replacement-level depth.`,
      };
    }

    if (phase === 'early_offseason' || phase === 'post_draft') {
      return {
        type: 'hold',
        action: `Hold waiver spend and map ${topNeed} trade/draft options`,
        targetPlayer: null,
        targetOwner: null,
        confidence: 'high',
        urgency: 'no_rush',
        alignment: { alignment: 'aligned' },
        reasoning: `${phaseLabel}.${milestoneText}${bestWaiverText} ${strategyText}${healthText} This is a planning window, not a forced-add window.`,
      };
    }

    if (phase === 'preseason') {
      return {
        type: 'hold',
        action: `Wait for camp cuts before buying ${topNeed} depth`,
        targetPlayer: null,
        targetOwner: null,
        confidence: 'medium',
        urgency: '2_weeks',
        alignment: { alignment: 'partial' },
        reasoning: `${phaseLabel}.${milestoneText}${bestWaiverText} ${strategyText}${healthText} Let roster churn create a better pool before spending.`,
      };
    }

    if (phase === 'playoffs') {
      return {
        type: 'hold',
        action: `Protect starters; skip low-value ${topNeed} depth adds`,
        targetPlayer: null,
        targetOwner: null,
        confidence: 'medium',
        urgency: 'this_week',
        alignment: { alignment: 'partial' },
        reasoning: `${phaseLabel}.${bestWaiverText} ${strategyText}${healthText} Playoff moves should improve a lineup spot, not just fill a depth label.`,
      };
    }

    return {
      type: 'trade',
      action: `Shop for a real ${topNeed} upgrade, not waiver filler`,
      targetPlayer: null,
      targetOwner: null,
      confidence: 'medium',
      urgency: phase === 'regular_season' ? '2_weeks' : 'no_rush',
      alignment: { alignment: 'partial' },
      reasoning: `${phaseLabel}.${milestoneText}${bestWaiverText} ${strategyText}${healthText} If no trade price clears that bar, holding is better than adding low-DHQ depth.`,
    };
  }

  // Get owner display name from roster_id
  function _ownerName(rosterId) {
    const S = _S();
    const roster = (S.rosters || []).find(r => r.roster_id === rosterId);
    if (!roster) return 'Unknown';
    const user = (S.leagueUsers || []).find(u => u.user_id === roster.owner_id);
    return user?.display_name || user?.username || `Team ${rosterId}`;
  }

  // Score how willing an owner is to trade (based on DNA)
  function _tradingWillingness(dna) {
    if (!dna) return 0.5;
    if (dna.includes('Active')) return 1.0;
    if (dna.includes('Win-now')) return 0.85;
    if (dna.includes('Rebuilder')) return 0.75;
    if (dna.includes('Holds firm')) return 0.2;
    return 0.5; // Balanced
  }

  // ── Strategy helpers ────────────────────────────────────────────
  // 2026-07-08 single-voice ruling: the persona style machinery — the dead
  // _alexStyle() reader and the _styleObs() wr_alex_style-keyed suffix/word
  // swaps — is gone. One canonical Alex voice; the template strings below are
  // authored in that voice directly (seeded variation elsewhere is untouched).

  function _gmStrategy() {
    return window.GMStrategy?.getStrategy?.() || {
      mode: 'balanced_rebuild', targetPositions: [], sellPositions: [],
      aggression: 'medium', untouchables: [],
    };
  }

  function _urgencyText(strat) {
    if (strat.aggression === 'high' || strat.aggression === 'aggressive') return "Move now — don't wait for the perfect deal.";
    if (strat.aggression === 'low' || strat.aggression === 'conservative') return 'Be patient — only act if the deal is clearly in your favor.';
    return 'Act before values shift.';
  }

  function _modeLabelMap(label, mode) {
    if (mode === 'rebuild' || mode === 'balanced_rebuild') {
      const map = {
        'Target QB': 'Acquire QB Asset', 'Shop Veterans': 'Convert to Picks',
        'Mock Draft': 'Map Draft Board', 'Target RB': 'Acquire RB Asset',
        'Target WR': 'Acquire WR Asset', 'Target TE': 'Acquire TE Asset',
        'Target DL': 'Acquire DL Asset', 'Target LB': 'Acquire LB Asset',
        'Target DB': 'Acquire DB Asset',
      };
      return map[label] || label;
    }
    if (mode === 'win_now' || mode === 'compete') {
      const map = {
        'Mock Draft': 'Scout Rookies', 'Target QB': 'Upgrade QB Now',
        'Target RB': 'Upgrade RB Now', 'Target WR': 'Upgrade WR Now',
        'Target TE': 'Upgrade TE Now', 'Target DL': 'Upgrade DL Now',
        'Target LB': 'Upgrade LB Now', 'Target DB': 'Upgrade DB Now',
      };
      return map[label] || label;
    }
    return label;
  }

  // ════════════════════════════════════════════════════════════════
  // 1. NEXT MOVE ENGINE
  // ════════════════════════════════════════════════════════════════

  function generateNextMove() {
    const S = _S();
    const myRoster = _myRoster();
    if (!myRoster) return _defaultNextMove();

    const myAssess = _assess(myRoster.roster_id);
    if (!myAssess) return _defaultNextMove();

    const strategy = _strategy();
    const ownerProfiles = _LI().ownerProfiles || {};

    // My biggest need
    const myNeeds = (myAssess.needs || []).map(n => typeof n === 'string' ? n : n.pos).filter(Boolean);
    const myStrengths = (myAssess.strengths || []).map(s => typeof s === 'string' ? s : s?.pos).filter(Boolean);
    const topNeed = myNeeds[0];
    const topSurplus = myStrengths[0];

    if (!topNeed) {
      // No pressing need — check if hold is appropriate
      if (myAssess.healthScore >= 80) {
        return {
          type: 'hold',
          action: 'Hold your core — roster health is elite',
          targetPlayer: null,
          targetOwner: null,
          confidence: 'high',
          urgency: 'no_rush',
          alignment: strategy.mode === 'win_now' ? { alignment: 'aligned' } : { alignment: 'partial' },
          reasoning: `Health score ${myAssess.healthScore} puts you in championship-caliber territory. Protect depth over the next 2 weeks.`,
        };
      }
      return _defaultNextMove();
    }

    // Find best trade target: scan all other rosters
    let bestMatch = null;
    let bestScore = -1;

    (S.rosters || []).forEach(r => {
      if (r.roster_id === myRoster.roster_id) return;

      const theirProfile = ownerProfiles[r.roster_id] || {};
      const willingness = _tradingWillingness(theirProfile.dna);
      if (willingness < 0.2) return; // Holds firm — skip

      // Their best player at my need position
      const theirCandidates = _rosterPlayersAtPos(r.players, topNeed);
      if (!theirCandidates.length) return;
      const theirTarget = theirCandidates[0];
      if (theirTarget.dhq < 500) return; // Not worth targeting

      // Their top need (from assessment)
      const theirAssess = _assess(r.roster_id);
      const theirNeeds = theirAssess
        ? (theirAssess.needs || []).map(n => typeof n === 'string' ? n : n.pos).filter(Boolean)
        : [];

      // Can I fill their need from my surplus?
      const overlapPos = theirNeeds.find(np => myStrengths.includes(np));
      let matchScore = theirTarget.dhq * willingness;
      if (overlapPos) matchScore *= 1.5; // Bonus for mutual need

      // What I'd give: my best player at their top need, or my surplus
      let myAssetPos = overlapPos || topSurplus;
      const myAssets = myAssetPos ? _rosterPlayersAtPos(myRoster.players, myAssetPos) : [];
      const myAsset = myAssets[0];
      if (!myAsset && !overlapPos) return; // Nothing to offer

      if (matchScore > bestScore) {
        bestScore = matchScore;
        const ownerName = _ownerName(r.roster_id);
        const assetLabel = myAsset ? myAsset.name : (myAssetPos ? `your ${myAssetPos}` : 'assets');
        const dnaNote = theirProfile.dna
          ? ` ${ownerName} trends ${theirProfile.dna.toLowerCase()}.`
          : '';

        // Confidence: high if mutual need + willing trader, else medium
        const confidence = (overlapPos && willingness >= 0.75) ? 'high'
          : willingness >= 0.5 ? 'medium' : 'low';

        // Urgency: based on strategy mode and health
        const urgency = strategy.mode === 'win_now' ? 'this_week'
          : myAssess.healthScore < 60 ? '2_weeks'
          : 'before_draft';

        const alignment = window.GMStrategy?.checkAlignment
          ? window.GMStrategy.checkAlignment({ type: 'trade', direction: 'acquire', position: topNeed, playerId: theirTarget.pid })
          : { alignment: 'partial' };

        bestMatch = {
          type: 'trade',
          action: `Trade ${assetLabel} → ${ownerName} for ${theirTarget.name}`,
          targetPlayer: { pid: theirTarget.pid, name: theirTarget.name },
          targetOwner: { name: ownerName, rosterId: r.roster_id },
          confidence,
          urgency,
          alignment,
          reasoning: `Your ${topNeed} room is your biggest gap.${dnaNote}${overlapPos ? ` They need ${overlapPos} — which you have.` : ''}`,
        };
      }
    });

    if (bestMatch) return bestMatch;

    // Fallback: do not force low-value waiver adds. The no-trade path is
    // calendar-aware and only recommends waivers when the pool clears a
    // meaningful DHQ floor.
    if (topNeed) {
      return _phaseAwareFallbackMove(topNeed, myAssess, strategy);
    }

    return _defaultNextMove();
  }

  function _defaultNextMove() {
    return {
      type: 'hold',
      action: 'Connect your league to get your personalized next move',
      targetPlayer: null,
      targetOwner: null,
      confidence: 'low',
      urgency: 'no_rush',
      alignment: { alignment: 'partial' },
      reasoning: 'Awaiting league data.',
    };
  }

  // ════════════════════════════════════════════════════════════════
  // 2. PRIORITY GENERATOR
  // ════════════════════════════════════════════════════════════════

  function generatePriorities() {
    const myRoster = _myRoster();
    if (!myRoster) return _defaultPriorities();

    const assess = _assess(myRoster.roster_id);
    if (!assess) return _defaultPriorities();

    const strategy = _strategy();
    const mode = strategy.mode || 'balanced_rebuild';
    const hs = assess.healthScore || 0;

    // Roster snapshot for data-grounded priority text. If unavailable,
    // the priorities fall through to the old position-label-only behavior
    // (still useful, just less specific).
    const snap = typeof window.buildRosterSnapshot === 'function' ? window.buildRosterSnapshot() : null;
    const posGroups = snap?.positionGroups || {};
    const needs = (assess.needs || []).map(n => typeof n === 'string' ? n : n.pos).filter(Boolean);

    // Strategy + personality integration
    const strat = _gmStrategy();
    const targetPositions = strat.targetPositions || [];
    const sellPositions = strat.sellPositions || [];
    const stratUntouchables = strat.untouchables || [];
    const stratMode = strat.mode || mode;
    const S = _S();
    const curYear = parseInt(S.season) || new Date().getFullYear();

    // Phase-aware offseason detection (Phase 2 v2). Falls back to the
    // month heuristic if SeasonCalendar isn't available yet.
    const calPhase = window.SeasonCalendar?.getPhase ? window.SeasonCalendar.getPhase() : null;
    const _nowMonth = new Date().getMonth();
    const isOffseason = calPhase
      ? ['early_offseason', 'pre_draft', 'draft_week', 'post_draft', 'preseason', 'offseason'].includes(calPhase)
      : (_nowMonth >= 1 && _nowMonth <= 7);
    const isPreDraft = calPhase === 'pre_draft' || calPhase === 'draft_week';

    // Premium positions by dynasty value (DHQ-weighted)
    const _PREMIUM_POS = ['QB', 'RB', 'WR', 'TE'];
    const _scoringSettings = S.leagues?.find?.(l => l.league_id === S.currentLeagueId)?.scoring_settings || {};
    const _isPPR = (_scoringSettings.rec || 0) >= 0.5;
    // In PPR, WR/pass-catching RBs are elevated; otherwise RB premium is higher
    const _topPremium = _PREMIUM_POS.filter(p => needs.includes(p));

    const priorities = [];

    if (isOffseason) {
      // ── OFFSEASON priorities: dynasty asset accumulation, not weekly output ──

      // Priority 1: Biggest positional gap — data-grounded, strategy-aware
      if (_topPremium.length > 0) {
        // Honor targetPositions from GM Strategy — if the user has flagged
        // a position as a target AND it's also a need, prioritize it.
        let pos = _topPremium[0];
        if (targetPositions.length > 0) {
          const targetNeed = _topPremium.find(p => targetPositions.includes(p));
          if (targetNeed) pos = targetNeed;
        }
        const pg = posGroups[pos];
        const gapDetail = pg
          ? ` Your ${pos} group is ${pg.groupDHQ.toLocaleString()} DHQ (${pg.gapPct > 0 ? '+' : ''}${pg.gapPct}% vs league avg of ${pg.leagueAvgDHQ.toLocaleString()}).`
          : '';
        const topPlayer = pg?.players?.[0];
        const topDetail = topPlayer ? ` Best: ${topPlayer.name} (${topPlayer.dhq.toLocaleString()}).` : '';
        priorities.push({
          problem: pg?.count >= 4
            ? `${pos} has ${pg.count} players but group DHQ is below league average`
            : `${pos} room needs a foundational piece before the season`,
          consequence: (gapDetail + topDetail || (_isPPR && pos === 'WR'
            ? 'PPR leagues reward deep WR rooms. Build now while prices are lower.'
            : `${pos} is the engine of dynasty rosters. Lock in your piece now.`)),
          actionLabel: _modeLabelMap(`Target ${pos}`, stratMode),
          actionType: 'trade',
        });
      } else if (needs.length > 0) {
        const pos = needs[0];
        const pg = posGroups[pos];
        const gapDetail = pg ? ` ${pg.groupDHQ.toLocaleString()} DHQ — ${Math.abs(pg.gapPct)}% below league avg.` : '';
        priorities.push({
          problem: `${pos} is your thinnest position heading into the season`,
          consequence: (gapDetail || 'Offseason is when roster construction shapes your year. Address now.'),
          actionLabel: _modeLabelMap(`Find ${pos}`, stratMode),
          actionType: 'trade',
        });
      }

      // Priority 2: Offseason trade window
      if (mode === 'rebuild' || mode === 'balanced_rebuild') {
        // Check draft capital
        const allTP = S.tradedPicks || [];
        let futurePicks = 0;
        for (let yr = curYear; yr <= curYear + 2; yr++) {
          const league = (S.leagues || []).find(l => l.league_id === S.currentLeagueId);
          const draftRounds = league?.settings?.draft_rounds || 4;
          for (let rd = 1; rd <= draftRounds; rd++) {
            const tradedAway = allTP.find(p => parseInt(p.season) === yr && p.round === rd && p.roster_id === myRoster.roster_id && p.owner_id !== myRoster.roster_id);
            if (!tradedAway) futurePicks++;
            futurePicks += allTP.filter(p => parseInt(p.season) === yr && p.round === rd && p.owner_id === myRoster.roster_id && p.roster_id !== myRoster.roster_id).length;
          }
        }
        if (futurePicks < 6) {
          priorities.push({
            problem: 'Draft capital is below rebuild minimum',
            consequence: ('Rookie drafts are the core of a rebuild. Stack picks before the window closes.'),
            actionLabel: _modeLabelMap('Acquire Picks', stratMode),
            actionType: 'trade',
          });
        } else {
          const sellStr = sellPositions.length > 0
            ? `You've flagged ${sellPositions.join(', ')} as sell positions. Win-now teams are buying — move now.`
            : 'Win-now teams are buying. Convert veterans into youth or picks before values drop.';
          priorities.push({
            problem: 'Trade window is open — move aging assets now',
            consequence: (_urgencyText(strat) + ' ' + sellStr),
            actionLabel: _modeLabelMap('Shop Veterans', stratMode),
            actionType: 'trade',
          });
        }
      } else {
        // Win-now: offseason is for shoring up weaknesses
        priorities.push({
          problem: 'Trade window is open — upgrade before rosters lock in',
          consequence: ('Offseason is prime trading time. Contenders who wait pay a premium in-season.'),
          actionLabel: _modeLabelMap('Build Trade', stratMode),
          actionType: 'trade',
        });
      }

      // Priority 3: Draft prep
      priorities.push({
        problem: isPreDraft
          ? 'Your rookie draft is approaching — lock your target board now'
          : 'Map your rookie draft targets before ADP firms up',
        consequence: (isPreDraft
          ? 'ADP is firming up fast. Every week you wait is a week less to spot steals.'
          : 'Early prep lets you identify steals and avoid reaches. Start your board now.'),
        actionLabel: _modeLabelMap(isPreDraft ? 'Open Big Board' : 'Mock Draft', stratMode),
        actionType: 'draft',
      });

      // Priority 4: secondary positional gap — skip if it duplicates
      // a position already covered by an earlier priority's action label.
      if (needs.length > 1) {
        const pos2 = needs.find((p, i) => i > 0 && !priorities.some(pr => pr.actionLabel?.includes(p)));
        if (pos2) {
          priorities.push({
            problem: `${pos2} is a secondary gap that'll bite mid-season`,
            consequence: ('Secondary gaps compound when injuries hit. Fix now while prices are calm.'),
            actionLabel: _modeLabelMap(`Target ${pos2}`, stratMode),
            actionType: 'trade',
          });
        }
      }

      // Priority 5: strategy hygiene — untouchables list or market posture
      if (stratUntouchables.length < 3) {
        priorities.push({
          problem: 'Untouchables list is thin — you haven\'t told Alex who\'s off-limits',
          consequence: ('Without an untouchables list, Alex may float your core in trade analysis.'),
          actionLabel: 'Set Untouchables',
          actionType: 'hold',
        });
      } else if (strategy.marketPosture === 'hold') {
        priorities.push({
          problem: 'Your market posture is "hold" — no buy or sell direction set',
          consequence: ('Offseason is the best trade window. Pick a posture so Alex knows what to pitch.'),
          actionLabel: 'Pick Posture',
          actionType: 'hold',
        });
      }

    } else {
      // ── IN-SEASON priorities: weekly output and matchup-based ──

      // Priority 1: Top positional deficit
      if (needs.length > 0) {
        const pos = needs[0];
        const isDeficit = (assess.needs || []).find(n => (typeof n === 'string' ? n : n.pos) === pos)?.urgency === 'deficit';
        const consequence = isDeficit
          ? (`Fix within 2 weeks or you're leaving wins on the table.`)
          : (`Address before your next tough matchup.`);
        priorities.push({
          problem: `${pos} is your weakest position group`,
          consequence,
          actionLabel: _modeLabelMap(`Fix ${pos}`, stratMode),
          actionType: 'trade',
        });
      }

      // Priority 2: Mode-specific structural priority
      if (mode === 'rebuild' || mode === 'balanced_rebuild') {
        const allTP = S.tradedPicks || [];
        let futurePicks = 0;
        for (let yr = curYear; yr <= curYear + 2; yr++) {
          const league = (S.leagues || []).find(l => l.league_id === S.currentLeagueId);
          const draftRounds = league?.settings?.draft_rounds || 4;
          for (let rd = 1; rd <= draftRounds; rd++) {
            const tradedAway = allTP.find(p => parseInt(p.season) === yr && p.round === rd && p.roster_id === myRoster.roster_id && p.owner_id !== myRoster.roster_id);
            if (!tradedAway) futurePicks++;
            futurePicks += allTP.filter(p => parseInt(p.season) === yr && p.round === rd && p.owner_id === myRoster.roster_id && p.roster_id !== myRoster.roster_id).length;
          }
        }
        if (futurePicks < 6) {
          priorities.push({
            problem: 'Draft capital is below rebuild minimum',
            consequence: ('Rebuilds stall without enough future picks. Every week costs you.'),
            actionLabel: _modeLabelMap('Acquire Picks', stratMode),
            actionType: 'trade',
          });
        } else {
          priorities.push({
            problem: 'Deploy your pick capital — don\'t let it sit idle',
            consequence: (`You have ${futurePicks} picks. Map a target list now or trade up.`),
            actionLabel: _modeLabelMap('Plan Draft', stratMode),
            actionType: 'draft',
          });
        }
      } else {
        const pos2 = needs[1];
        if (pos2) {
          priorities.push({
            problem: `${pos2} depth is thin for a deep playoff run`,
            consequence: ('One injury ends your season. Depth is championship insurance.'),
            actionLabel: _modeLabelMap(`Find ${pos2}`, stratMode),
            actionType: needs.length > 1 ? 'trade' : 'waiver',
          });
        } else {
          priorities.push({
            problem: 'Sell your surplus into the market now',
            consequence: ('Peak window means buyers are aggressive. Convert excess into wins.'),
            actionLabel: _modeLabelMap('Build Trade', stratMode),
            actionType: 'trade',
          });
        }
      }

      // Priority 3: Health-based or urgency catch-all
      if (hs < 65 && hs > 0) {
        priorities.push({
          problem: 'Overall roster health is below contender threshold',
          consequence: ('Competing teams are pulling ahead every week you wait.'),
          actionLabel: _modeLabelMap('Full Rebuild', stratMode),
          actionType: 'trade',
        });
      } else if (hs >= 80) {
        priorities.push({
          problem: 'Protect your franchise players from trade pressure',
          consequence: ('Elite rosters get picked apart if you\'re not careful about what you trade.'),
          actionLabel: 'Set Untouchables',
          actionType: 'hold',
        });
      } else if (needs.length > 2) {
        const pos3 = needs[2];
        priorities.push({
          problem: `${pos3} is a secondary gap worth monitoring`,
          consequence: ('Secondary gaps compound. Fix when the right deal appears.'),
          actionLabel: _modeLabelMap(`Monitor ${pos3}`, stratMode),
          actionType: 'waiver',
        });
      }

      // Priority 4: trade deadline proximity
      const weeksToDeadline = window.SeasonCalendar?.weeksUntil?.('deadline');
      if (weeksToDeadline != null && weeksToDeadline > 0 && weeksToDeadline <= 3) {
        priorities.push({
          problem: `Trade deadline is ${weeksToDeadline} week${weeksToDeadline === 1 ? '' : 's'} out`,
          consequence: (_urgencyText(strat) + ' After the deadline, your roster is locked for the playoff run.'),
          actionLabel: _modeLabelMap('Deadline Moves', stratMode),
          actionType: 'trade',
        });
      }

      // Priority 5: secondary gap from needs array if not already used
      if (needs.length > 1 && priorities.length < 5) {
        const pos2 = needs[1];
        const already = priorities.some(p => p.actionLabel?.includes(pos2));
        if (!already) {
          priorities.push({
            problem: `${pos2} depth is thin for the stretch run`,
            consequence: ('One injury at a thin position can cost you a playoff week.'),
            actionLabel: _modeLabelMap(`Find ${pos2}`, stratMode),
            actionType: 'trade',
          });
        }
      }
    }

    return priorities.slice(0, 5);
  }

  function _defaultPriorities() {
    return [
      { problem: 'Connect your league to see priorities', consequence: 'Your personalized plan will appear here.', actionLabel: 'Connect', actionType: 'hold' },
    ];
  }

  // ════════════════════════════════════════════════════════════════
  // 3. OPPORTUNITY GENERATOR
  // ════════════════════════════════════════════════════════════════

  function generateOpportunities() {
    const S = _S();
    const myRoster = _myRoster();
    if (!myRoster || !S.rosters?.length) return _defaultOpportunities();

    const myAssess = _assess(myRoster.roster_id);
    const myStrengths = myAssess
      ? (myAssess.strengths || []).map(s => typeof s === 'string' ? s : s?.pos).filter(Boolean)
      : [];
    const myNeeds = myAssess
      ? (myAssess.needs || []).map(n => typeof n === 'string' ? n : n.pos).filter(Boolean)
      : [];

    const ownerProfiles = _LI().ownerProfiles || {};

    const scored = (S.rosters || [])
      .filter(r => r.roster_id !== myRoster.roster_id)
      .map(r => {
        const profile = ownerProfiles[r.roster_id] || {};
        const theirAssess = _assess(r.roster_id);
        const theirNeeds = theirAssess
          ? (theirAssess.needs || []).map(n => typeof n === 'string' ? n : n.pos).filter(Boolean)
          : [];
        const theirStrengths = theirAssess
          ? (theirAssess.strengths || []).map(s => typeof s === 'string' ? s : s?.pos).filter(Boolean)
          : [];

        // Exploitability score
        const iHaveWhatTheyNeed = theirNeeds.some(p => myStrengths.includes(p));
        const theyHaveWhatINeed = myNeeds.some(p => theirStrengths.includes(p));
        const willingness = _tradingWillingness(profile.dna);
        const theirHealth = theirAssess?.healthScore || 50;

        let exploitScore = willingness * 50;
        if (iHaveWhatTheyNeed) exploitScore += 25;
        if (theyHaveWhatINeed) exploitScore += 25;
        if (theirHealth < 60) exploitScore += 10; // Desperate seller

        const ownerName = _ownerName(r.roster_id);

        // Build insight text
        let insight = '';
        if (iHaveWhatTheyNeed && theyHaveWhatINeed) {
          const theirNeedPos = theirNeeds.find(p => myStrengths.includes(p));
          const myNeedPos = myNeeds.find(p => theirStrengths.includes(p));
          insight = `Needs ${theirNeedPos}, has ${myNeedPos} you want`;
        } else if (iHaveWhatTheyNeed) {
          const theirNeedPos = theirNeeds.find(p => myStrengths.includes(p));
          insight = `Needs ${theirNeedPos} — you have the supply`;
        } else if (theyHaveWhatINeed) {
          const myNeedPos = myNeeds.find(p => theirStrengths.includes(p));
          insight = `Has ${myNeedPos} depth you need`;
        } else if (profile.dna) {
          insight = profile.dna;
        } else {
          insight = theirHealth < 60 ? 'Roster in trouble — motivated seller' : 'Potential partner';
        }

        const suggestedAction = exploitScore >= 75 ? 'Attack'
          : exploitScore >= 50 ? 'View Targets'
          : 'Buy Low';

        return { ownerName, insight, exploitScore: Math.round(exploitScore), suggestedAction, rosterId: r.roster_id };
      })
      .sort((a, b) => b.exploitScore - a.exploitScore);

    return scored.slice(0, 3).length ? scored.slice(0, 3) : _defaultOpportunities();
  }

  function _defaultOpportunities() {
    return [
      { ownerName: 'Best Trade Partner', insight: 'Connect your league to see opponent intel', exploitScore: 0, suggestedAction: 'Attack', rosterId: null },
    ];
  }

  // ════════════════════════════════════════════════════════════════
  // 4. TEAM DIAGNOSIS GENERATOR
  // ════════════════════════════════════════════════════════════════

  function generateDiagnosis() {
    const myRoster = _myRoster();
    if (!myRoster) return { line1: 'Connect your league for a team diagnosis.', line2: '' };

    const assess = _assess(myRoster.roster_id);
    if (!assess) return { line1: 'Loading team data...', line2: '' };

    const strategy = _strategy();
    const mode = strategy.mode || 'balanced_rebuild';
    const hs = assess.healthScore || 0;
    const needs = (assess.needs || []).map(n => typeof n === 'string' ? n : n.pos).filter(Boolean);
    const strengths = (assess.strengths || []).map(s => typeof s === 'string' ? s : s?.pos).filter(Boolean);

    // Line 1: biggest weakness and its cost
    let line1;
    if (needs.length > 0) {
      const pos = needs[0];
      const isDeficit = (assess.needs || []).find(n => (typeof n === 'string' ? n : n.pos) === pos)?.urgency === 'deficit';
      if (mode === 'rebuild' || mode === 'balanced_rebuild') {
        line1 = isDeficit
          ? `Your ${pos} room is a critical hole — costing ~1 win/season until fixed.`
          : `${pos} depth is your biggest rebuild gap — thin but addressable.`;
      } else {
        line1 = isDeficit
          ? `Your ${pos} room is costing ~1 win/season. Fix it before the deadline.`
          : `${pos} is your most exploitable gap — opponents will target your lineup.`;
      }
    } else if (hs < 60) {
      line1 = 'Roster is below contender threshold — overall health limits your ceiling.';
    } else {
      line1 = `Health score ${hs} — roster is competitive across the board.`;
    }

    // Line 2: biggest opportunity/asset
    let line2;
    if (strengths.length > 0) {
      const pos = strengths[0];
      if (mode === 'win_now' || mode === 'compete') {
        line2 = `You have excess ${pos} value — convert it into your missing piece before the deadline.`;
      } else {
        line2 = `${pos} is your biggest tradeable asset — use it to accelerate your rebuild.`;
      }
    } else if (hs >= 80) {
      line2 = 'Championship-caliber roster — protect your core and target depth upgrades.';
    } else {
      const S = _S();
      const allTP = S.tradedPicks || [];
      const myId = myRoster.roster_id;
      const futurePicks = allTP.filter(p => p.owner_id === myId && p.roster_id !== myId).length;
      if (futurePicks >= 3) {
        line2 = `You hold ${futurePicks} future picks — strong leverage heading into the draft.`;
      } else {
        line2 = 'Draft capital is your path to upgrades — prioritize pick acquisition.';
      }
    }

    return { line1, line2 };
  }

  // ════════════════════════════════════════════════════════════════
  // 5. FIELD INTEL GENERATOR
  // ════════════════════════════════════════════════════════════════

  function generateFieldIntel() {
    const strategy = _strategy();
    const mode = strategy.mode || 'balanced_rebuild';
    const obs = [];

    // Strategy + personality integration
    const strat = _gmStrategy();
    const targetPositions = strat.targetPositions || [];
    const sellPositions = strat.sellPositions || [];
    const isAggressive = strat.aggression === 'high' || strat.aggression === 'aggressive';
    const isConservative = strat.aggression === 'low' || strat.aggression === 'conservative';

    // ── Roster snapshot — every observation below is data-grounded ──
    const snap = typeof window.buildRosterSnapshot === 'function' ? window.buildRosterSnapshot() : null;
    const myRoster = _myRoster();

    // ── 1. Calendar-phase context (always first) ──────────────────
    const cal = window.SeasonCalendar;
    if (cal?.describe) {
      const { phase, weeksToNext, nextMilestone } = cal.describe();
      const hasDraftDate = !!cal.getKeyDates?.()?.draftDate;
      const pickCount = snap?.pickInventory?.totalPicks;
      const pickStr = pickCount != null ? ` You hold ${pickCount} pick${pickCount === 1 ? '' : 's'}.` : '';

      if (phase === 'pre_draft' && hasDraftDate) {
        obs.push((`Rookie draft is ${weeksToNext}w away.${pickStr} Focus: prospect scouting, not waivers.`));
      } else if (phase === 'draft_week') {
        obs.push((`Rookie draft is this week.${pickStr} Lock your board and trade-up/down decisions.`));
      } else if (phase === 'early_offseason' && hasDraftDate) {
        obs.push((`Early offseason — rookie draft in ${weeksToNext}w.${pickStr} Start building your board.`));
      } else if (phase === 'early_offseason') {
        obs.push(('No rookie draft date set. Ask your commissioner to schedule it so Alex can plan ahead.'));
      } else if (phase === 'preseason' && weeksToNext != null) {
        obs.push((`NFL Week 1 in ${weeksToNext}w. Audit your bench and finalize starter order.`));
      } else if (phase === 'regular_season' && nextMilestone) {
        obs.push((`${nextMilestone} in ${weeksToNext}w. ${weeksToNext <= 3 ? 'Execute now.' : 'Let the market form.'}`));
      } else if (phase === 'playoffs') {
        obs.push(('Playoff week — lineup decisions matter more than any trade.'));
      }
    }

    if (!snap) {
      return obs.length ? obs : ['Connect your league to see roster-specific intel.'];
    }

    // ── 2. Strategy-driven observations ─────────────────────────
    // Inject target + sell position signals from GM Strategy before
    // the generic position-group analysis so strategy intel comes first.
    if (targetPositions.length > 0 && myRoster) {
      const tp = targetPositions[0];
      const posPlayers = _rosterPlayersAtPos(myRoster.players, tp);
      const groupDHQ = posPlayers.reduce((s, p) => s + p.dhq, 0);
      if (groupDHQ > 0) {
        obs.push((
          `You've flagged ${tp} as a target position. Current group DHQ: ${groupDHQ.toLocaleString()} (best: ${posPlayers[0]?.name || '—'} at ${posPlayers[0]?.dhq?.toLocaleString() || '—'}).`
        ));
      } else {
        obs.push((
          `You've flagged ${tp} as a target position but have no established players there. Priority acquisition.`
        ));
      }
    }

    if (sellPositions.length > 0 && myRoster) {
      const sp = sellPositions[0];
      const posPlayers = _rosterPlayersAtPos(myRoster.players, sp);
      const topPlayer = posPlayers[0];
      if (topPlayer) {
        obs.push((
          `Sell signal active for ${sp}: ${topPlayer.name} (${topPlayer.dhq.toLocaleString()} DHQ) is your most tradeable asset at this position.`
        ));
      }
    }

    // ── 3. Position group observations — cite real data ──────────
    const posGroups = snap.positionGroups || {};
    const weakest = Object.entries(posGroups)
      .filter(([, g]) => g.gap === 'weakness')
      .sort((a, b) => a[1].gapPct - b[1].gapPct)[0];
    if (weakest) {
      const [pos, g] = weakest;
      const topPlayer = g.players[0];
      obs.push((`${pos} group (${g.groupDHQ.toLocaleString()} DHQ) is ${Math.abs(g.gapPct)}% below league avg (${g.leagueAvgDHQ.toLocaleString()}).${topPlayer ? ' Best: ' + topPlayer.name + ' at ' + topPlayer.dhq.toLocaleString() + '.' : ''}`));
    }

    const strongest = Object.entries(posGroups)
      .filter(([, g]) => g.gap === 'strength')
      .sort((a, b) => b[1].gapPct - a[1].gapPct)[0];
    if (strongest) {
      const [pos, g] = strongest;
      obs.push((`${pos} is a strength (${g.groupDHQ.toLocaleString()} DHQ, +${g.gapPct}% vs league). Consider selling depth here for needs.`));
    }

    // ── 4. Pick capital ──────────────────────────────────────────
    const picks = snap.pickInventory;
    if (picks) {
      if (picks.pickStrength === 'above average') {
        obs.push((`You hold ${picks.totalPicks} picks (~${picks.totalPickDHQ.toLocaleString()} DHQ) — above league average. Strong draft capital.`));
      } else if (picks.pickStrength === 'below average') {
        obs.push((`Pick inventory is thin: ${picks.totalPicks} picks, ${picks.totalPickDHQ.toLocaleString()} DHQ — below league avg of ${picks.leagueAvgPickDHQ.toLocaleString()}.`));
      }
    }

    // ── 5. Aging risks — cite specific players ───────────────────
    if (snap.agingRisks?.length) {
      const top2 = snap.agingRisks.slice(0, 2);
      const names = top2.map(p => `${p.name} (${p.position}, age ${p.age}, ${p.dhq.toLocaleString()} DHQ)`).join(' and ');
      obs.push((`Aging risk: ${names}${top2.length < snap.agingRisks.length ? ` + ${snap.agingRisks.length - top2.length} more` : ''}.`));
    }

    // ── 6. Sell candidates ───────────────────────────────────────
    if (snap.sellCandidates?.length) {
      const top = snap.sellCandidates[0];
      obs.push((`Sell window: ${top.name} (${top.position}, ${top.dhq.toLocaleString()} DHQ) — ${top.reason}.`));
    }

    // ── 7. League standing — aggression-aware framing ────────────
    if (snap.leagueRank && snap.leagueSize) {
      const pct = Math.round((snap.leagueRank / snap.leagueSize) * 100);
      if (pct <= 25) {
        obs.push((
          isAggressive
            ? `Ranked #${snap.leagueRank} of ${snap.leagueSize} — attack the market now. You're in position to win, don't wait.`
            : `Ranked #${snap.leagueRank} of ${snap.leagueSize} by total DHQ. You're in the top tier — protect your core.`
        ));
      } else if (pct >= 75) {
        obs.push((
          isAggressive
            ? `Ranked #${snap.leagueRank} of ${snap.leagueSize}. Rebuild aggressively — target picks that project as starters in 1-2 years.`
            : isConservative
            ? `Ranked #${snap.leagueRank} of ${snap.leagueSize}. Rebuild is a patience game — stack picks, develop youth, let the market come to you.`
            : `Ranked #${snap.leagueRank} of ${snap.leagueSize} by total DHQ (${snap.totalDHQ.toLocaleString()}). Aggressive rebuilding moves are justified.`
        ));
      }
    }

    return obs.slice(0, 6);
  }

  // ════════════════════════════════════════════════════════════════
  // EXPOSE
  // ════════════════════════════════════════════════════════════════

  window.GMEngine = {
    generateNextMove,
    generatePriorities,
    generateOpportunities,
    generateDiagnosis,
    generateFieldIntel,
  };

  window.App = window.App || {};
  window.App.GMEngine = window.GMEngine;

  // ── Module global exports (Vite migration) ─────────────────────
  window.generateNextMove      = generateNextMove;
  window.generatePriorities    = generatePriorities;
  window.generateOpportunities = generateOpportunities;
  window.generateDiagnosis     = generateDiagnosis;
  window.generateFieldIntel    = generateFieldIntel;

})();
