// ══════════════════════════════════════════════════════════════════
// shared/nfl-fit.js — "Alex NFL Fit": real-situation scouting signals
// Used by both ReconAI (Scout) and War Room.
// Requires: dhq-engine.js (App.LI.playerScores / playerMeta) and
// constants.js/utils.js loaded first. Loads AFTER dhq-engine.js.
//
// PURPOSE
// The per-player "Alex NFL Fit" blurb used to be generic template prose
// divorced from a player's actual NFL situation. This module turns the
// signals the DHQ engine ALREADY computes — depth-chart role, the specific
// teammates blocking a player and their PPG, injury status, production
// trend — plus NFL draft capital / landing spot, into:
//   1. a DETERMINISTIC, player-specific narrative (no LLM needed), and
//   2. a compact context block the premium web-search AI path can enrich.
//
// The numeric SitMult "clear path" nudge lives in dhq-engine.js
// (_dhqNflFitAdjustment); this module is the narrative/context surface.
// ══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  window.App = window.App || {};
  const App = window.App;

  // ── small helpers ────────────────────────────────────────────────
  function S() { return window.S || {}; }
  function meta(pid) { return App.LI?.playerMeta?.[String(pid)] || null; }
  function dhqOf(pid) { return Number(App.LI?.playerScores?.[String(pid)] || 0); }
  function playerOf(pid, fallback) {
    return fallback || S().players?.[String(pid)] || null;
  }
  function pName(pid, p) {
    p = p || playerOf(pid);
    if (!p) return 'this player';
    return p.full_name
      || [p.first_name, p.last_name].filter(Boolean).join(' ')
      || p.name || 'this player';
  }
  function blockerPPG(bpid) {
    const m = meta(bpid);
    const v = m ? (m.lastYearPPG ?? m.ppg) : null;
    return v != null && Number(v) > 0 ? +Number(v).toFixed(1) : null;
  }
  function isOffseason() {
    const t = S().nflState?.season_type;
    return !(t === 'regular' || t === 'post');
  }

  // Resolve the elite teammates blocking this player into {name, ppg}.
  function resolveCompetition(m) {
    const out = [];
    (m?.opportunityBlockers || []).forEach((bpid) => {
      const bp = playerOf(bpid);
      out.push({ pid: bpid, name: pName(bpid, bp), ppg: blockerPPG(bpid) });
    });
    return out;
  }

  // Human phrase for the depth-chart role label ("WR3" → "the WR3").
  function rolePhrase(label) {
    if (!label) return '';
    return 'the ' + label;
  }

  // ── computeNFLFit ────────────────────────────────────────────────
  // opts: { player, capital:{round,pick,nflTeam,isUDFA}, dhq, isRookie }
  // Returns a structured fit object, or a safe minimal object on any error.
  function computeNFLFit(pid, opts) {
    opts = opts || {};
    const id = String(pid);
    try {
      const m = opts.meta || meta(id) || {};
      const p = playerOf(id, opts.player);
      const pos = window.normPos?.(opts.pos || m.pos || p?.position) || m.pos || p?.position || '';
      const team = opts.capital?.nflTeam || p?.team || '';
      const dhq = Number(opts.dhq != null ? opts.dhq : dhqOf(id)) || 0;
      const name = pName(id, p);

      const depthRank = parseDepthRank(m.roleLabel);
      const roleLabel = m.roleLabel || '';
      const roleMult = Number(m.roleMult || 1);
      const opportunityMult = Number(m.opportunityMult || 1);
      const competition = resolveCompetition(m);
      const status = m.statusCode || (p?.status || 'active');
      const statusReason = m.statusReason || '';
      const trend = Number(m.trend || 0);
      const tier = (App.tradeValueTier?.(dhq) || {}).tier || '';

      // NFL draft capital / landing spot (mostly rookies).
      const cap = opts.capital || {};
      const capitalLabel = cap.round
        ? (window.formatNFLDraftSlot?.(cap.round, cap.pick) || ('R' + cap.round))
        : cap.isUDFA ? 'UDFA' : '';
      const capitalRound = Number(cap.round) || 0;

      // ── classify fit tier ──
      const isSkill = ['RB', 'WR', 'TE'].includes(pos);
      const clearRole = roleLabel && (pos === 'QB' ? depthRank === 0 : depthRank != null && depthRank <= 1);
      const buried = roleLabel && depthRank != null && (pos === 'QB' ? depthRank >= 1 : depthRank >= 2);
      const contested = isSkill && competition.length > 0;
      const inactive = ['inactive', 'retired'].includes(status) || /\b(out|ir|pup|suspend)\b/i.test(String(status));

      let fitTier, fitScore;
      if (inactive) { fitTier = 'Unavailable'; fitScore = 8; }
      else if (!roleLabel && !competition.length) { fitTier = 'Unsettled'; fitScore = 50; }
      else if (clearRole && !contested) { fitTier = 'Clear path'; fitScore = 84; }
      else if (contested && !buried) { fitTier = 'Contested'; fitScore = 60; }
      else if (buried && contested) { fitTier = 'Blocked'; fitScore = 38; }
      else if (buried) { fitTier = 'Buried'; fitScore = 34; }
      else { fitTier = 'Settled'; fitScore = 66; }

      // Nudge score by trend + capital.
      if (trend >= 15) fitScore += 6; else if (trend <= -15) fitScore -= 6;
      if (capitalRound === 1) fitScore += 5; else if (capitalRound && capitalRound <= 3) fitScore += 2;
      fitScore = Math.max(0, Math.min(100, Math.round(fitScore)));

      const signals = {
        pos, team, dhq, tier,
        depthRole: roleLabel, depthRank, roleMult,
        competition, opportunityMult,
        status, statusReason, trend,
        capital: capitalLabel ? { label: capitalLabel, round: capitalRound } : null,
        landingSpot: team || null,
      };

      const confidence = computeConfidence(signals);
      const narrative = buildNarrative(name, signals, { clearRole, buried, contested, inactive, isSkill, isRookie: !!opts.isRookie });
      const contextString = buildContextString(name, signals);
      const sources = ['dhq', 'sleeper'];
      if (capitalLabel) sources.push('rookie_capital');

      return { pid: id, pos, team, fitTier, fitScore, signals, narrative, contextString, confidence, sources };
    } catch (e) {
      window.dhqLog?.('nfl-fit.compute', e, id);
      return { pid: id, fitTier: 'Unknown', fitScore: 50, signals: {}, narrative: '', contextString: '', confidence: 0, sources: [] };
    }
  }

  // Recover the 0-indexed depth rank from the role label. The engine stores
  // roleLabel like "WR3"/"QB1" (position + (rank+1)); the trailing number is
  // rank+1, so depthRank = N-1. Returns null when no role is known.
  function parseDepthRank(label) {
    if (!label) return null;
    const mtch = String(label).match(/(\d+)\s*$/);
    if (!mtch) return null;
    const n = parseInt(mtch[1], 10);
    return Number.isFinite(n) && n >= 1 ? n - 1 : null;
  }

  // ── deterministic narrative ──────────────────────────────────────
  function fmtCompetition(comp) {
    const named = comp.filter((c) => c.name && c.name !== 'this player').slice(0, 2);
    if (!named.length) return '';
    return named
      .map((c) => c.ppg != null ? `${c.name} (${c.ppg} PPG)` : c.name)
      .join(' and ');
  }

  function buildNarrative(name, s, flags) {
    const parts = [];
    const team = s.team || 'his NFL team';

    // Capital / landing-spot lead (rookies).
    if (s.capital?.label && s.capital.label !== 'UDFA') {
      const capTone = s.capital.round === 1 ? 'the staff invested premium capital'
        : s.capital.round && s.capital.round <= 3 ? 'a real day-two investment'
        : 'a late-round dart';
      parts.push(`Lands in ${team} at ${s.capital.label} — ${capTone}.`);
    } else if (s.capital?.label === 'UDFA') {
      parts.push(`Undrafted into ${team} — has to earn the role on a camp body's path.`);
    }

    if (flags.inactive) {
      parts.push(`Currently ${s.statusReason || s.status} — value is on hold until that clears.`);
    } else if (flags.clearRole && !flags.contested) {
      const compClean = `no elite competition for ${s.pos === 'RB' ? 'touches' : s.pos === 'QB' ? 'the job' : 'targets'}`;
      parts.push(`He's ${rolePhrase(s.depthRole)} in ${team} with ${compClean} — about as clean a path as the spot offers.`);
    } else if (flags.contested) {
      const comp = fmtCompetition(s.competition);
      const role = s.depthRole ? rolePhrase(s.depthRole) : 'in the mix';
      parts.push(comp
        ? `He's ${role} behind ${comp}, so ${s.pos === 'RB' ? 'the workload is' : 'targets are'} contested until usage shifts or someone moves.`
        : `He's ${role} with real competition for the role.`);
    } else if (flags.buried) {
      parts.push(`Currently ${rolePhrase(s.depthRole)} — until the depth chart changes this is an upside hold, not a weekly starter.`);
    } else if (s.depthRole) {
      parts.push(`Settled as ${rolePhrase(s.depthRole)} in ${team}.`);
    } else {
      parts.push(`Role in ${team} isn't settled yet — I'd trust the value tier over the situation until it clears.`);
    }

    // Trend read.
    if (s.trend >= 15) parts.push(`Production is trending up (+${s.trend}% YoY) — the arrow points the right way.`);
    else if (s.trend <= -15) parts.push(`Production is sliding (${s.trend}% YoY) — watch whether it's role or skill.`);

    return parts.join(' ');
  }

  // Compact, factual context block for the AI prompt (signals, not prose).
  function buildContextString(name, s) {
    const lines = [`[NFL FIT SIGNALS for ${name}]`];
    if (s.pos) lines.push(`Position: ${s.pos}${s.team ? ' · ' + s.team : ''}`);
    if (s.dhq) lines.push(`DHQ value: ${s.dhq.toLocaleString()}${s.tier ? ' (' + s.tier + ')' : ''}`);
    if (s.depthRole) lines.push(`Depth-chart role: ${s.depthRole} (role mult ${s.roleMult})`);
    if (s.competition?.length) {
      lines.push('Blocked by: ' + s.competition.map((c) => c.name + (c.ppg != null ? ` (${c.ppg} PPG)` : '')).join(', '));
    } else if (['RB', 'WR', 'TE'].includes(s.pos)) {
      lines.push('Blocked by: none — clear path for the role');
    }
    if (s.capital?.label) lines.push(`NFL draft capital: ${s.capital.label}`);
    if (s.status && s.status !== 'active') lines.push(`Status: ${s.statusReason || s.status}`);
    if (s.trend) lines.push(`Production trend YoY: ${s.trend > 0 ? '+' : ''}${s.trend}%`);
    lines.push('Use these signals as ground truth; verify current depth chart, snap/target share, scheme fit, QB situation, coaching changes, and injury news before writing the fit read.');
    return lines.join('\n');
  }

  function computeConfidence(s) {
    let c = 0.4;
    if (s.depthRole) c += 0.25;
    if (s.competition?.length) c += 0.1;
    if (s.capital?.label) c += 0.1;
    if (s.dhq) c += 0.1;
    if (isOffseason()) c -= 0.15; // stale team/depth data in the offseason
    return Math.max(0.1, Math.min(1, +c.toFixed(2)));
  }

  // ── fetchNFLFitNews ──────────────────────────────────────────────
  // Premium, web-search-enriched fit read. Non-blocking; cached per pid for
  // the session. Returns the AI text, or null on free tier / failure (the
  // caller should render the deterministic narrative as the baseline).
  const _newsCache = {};
  async function fetchNFLFitNews(pid, opts) {
    opts = opts || {};
    const id = String(pid);
    const cacheKey = id + ':' + (S().nflState?.week || '');
    if (_newsCache[cacheKey] !== undefined) return _newsCache[cacheKey];
    _newsCache[cacheKey] = null; // mark in-flight so we don't double-fire

    try {
      const fit = opts.fit || computeNFLFit(id, opts);
      const name = pName(id, opts.player);
      const dhqAI = window.dhqAI || App.dhqAI;
      if (typeof dhqAI !== 'function') return null;

      const message = `Give me a tight, current "NFL fit" read on ${name}${fit.signals.team ? ' (' + fit.signals.team + ')' : ''}: `
        + `his real role, depth-chart competition, scheme/coaching fit, and the latest news that changes the dynasty outlook. `
        + `2-3 sentences, specific, no fluff.`;

      const text = await dhqAI('player-scout', message, fit.contextString, { useWebSearch: true });
      const out = (text && String(text).trim()) || null;
      _newsCache[cacheKey] = out;
      return out;
    } catch (e) {
      window.dhqLog?.('nfl-fit.news', e, id);
      _newsCache[cacheKey] = null;
      return null;
    }
  }

  // ── expose ───────────────────────────────────────────────────────
  App.computeNFLFit = computeNFLFit;
  App.fetchNFLFitNews = fetchNFLFitNews;
  window.computeNFLFit = computeNFLFit;
  window.fetchNFLFitNews = fetchNFLFitNews;
})();
