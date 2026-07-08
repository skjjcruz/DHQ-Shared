// ══════════════════════════════════════════════════════════════════
// shared/trade-engine.js — Trade psychology primitives
// Used by both Scout (reconai/) and War Room (warroom/).
// Loads after shared/utils.js, before any app-specific trade-calc.js.
// ══════════════════════════════════════════════════════════════════

(function () {
  'use strict';
  window.App = window.App || {};

  // ── Posture definitions ────────────────────────────────────────
  // Shared across both apps. Returned by calcOwnerPosture().
  // .key  — used for identity checks (theirPosture?.key === 'LOCKED')
  // .label — used for display (posture.label)
  // .color — used for badge styling (posture.color)
  const POSTURES = {
    DESPERATE: { key: 'DESPERATE', label: 'Desperate',     color: '#BB8FCE', desc: 'Panic-mode — will overpay for immediate help.' },
    BUYER:     { key: 'BUYER',     label: 'Active Buyer',  color: '#F0A500', desc: 'Contender upgrading — open to deals, fair value required.' },
    NEUTRAL:   { key: 'NEUTRAL',   label: 'Neutral',       color: '#95A5A6', desc: 'No strong directional push. Fair offers only.' },
    SELLER:    { key: 'SELLER',    label: 'Active Seller', color: '#5DADE2', desc: 'Moving assets for futures. Buy at a discount.' },
    LOCKED:    { key: 'LOCKED',    label: 'Locked In',     color: '#7F8C8D', desc: 'Satisfied roster, high attachment. Very hard to move.' },
  };

  // ── calcComplementarity ────────────────────────────────────────
  // How well two teams' needs/surpluses complement each other.
  // Returns 0–100. Higher = better natural trade partners.
  function calcComplementarity(mine, theirs) {
    if (!mine || !theirs) return 0;
    let score = 0;
    for (const n of mine.needs) {
      const t = theirs.posAssessment[n.pos];
      if (t?.status === 'surplus') score += n.urgency === 'deficit' ? 25 : 12;
      else if (t?.status === 'ok' && n.urgency === 'deficit') score += 6;
    }
    for (const n of theirs.needs) {
      const m = mine.posAssessment[n.pos];
      if (m?.status === 'surplus') score += n.urgency === 'deficit' ? 25 : 12;
      else if (m?.status === 'ok' && n.urgency === 'deficit') score += 6;
    }
    if (mine.window !== theirs.window) score += 15;
    return Math.min(100, score);
  }

  // ── calcOwnerPosture ───────────────────────────────────────────
  // Determine owner posture based on team assessment and DNA archetype.
  // Returns one of the POSTURES objects above.
  function calcOwnerPosture(assessment, dnaKey) {
    if (!assessment) return POSTURES.NEUTRAL;
    const { tier, panic } = assessment;
    if (panic >= 4)                                                      return POSTURES.DESPERATE;
    if (tier === 'REBUILDING' || dnaKey === 'ACCEPTOR')                  return POSTURES.SELLER;
    if (tier === 'ELITE' && panic <= 1)                                  return POSTURES.LOCKED;
    if ((tier === 'CONTENDER' || tier === 'CROSSROADS') && panic >= 2)   return POSTURES.BUYER;
    return POSTURES.NEUTRAL;
  }

  // ── calcPsychTaxes ─────────────────────────────────────────────
  // Calculate psychological tax modifiers (8 factors).
  // Returns array of { name, impact, type:'TAX'|'BONUS', desc }.
  function calcPsychTaxes(myAssessment, theirAssessment, theirDnaKey, theirPosture) {
    const taxes = [];

    // 1 - Endowment Effect
    const ePct = { FLEECER: 10, DOMINATOR: 28, STALWART: 20, ACCEPTOR: 5, DESPERATE: 15, NONE: 12 }[theirDnaKey] || 12;
    taxes.push({
      name: 'Endowment Effect', impact: -Math.round(ePct / 2), type: 'TAX',
      desc: `~${ePct}% mental inflation on their own players. Their side feels worth more than market.`
    });

    // 2 - Panic Premium
    if (theirAssessment?.panic >= 3) {
      taxes.push({
        name: 'Panic Premium', impact: 8 + (theirAssessment.panic - 2) * 6, type: 'BONUS',
        desc: `Panic ${theirAssessment.panic}/5 — urgency overrides normal caution.`
      });
    }

    // 3 - Status Tax (Dominator)
    if (theirDnaKey === 'DOMINATOR') {
      taxes.push({
        name: 'Status Tax', impact: -18, type: 'TAX',
        desc: 'Must visibly win the trade for ego/status. Frame it so they feel like the winner.'
      });
    }

    // 4 - Loss Aversion (Stalwart, Dominator)
    if (['STALWART', 'DOMINATOR'].includes(theirDnaKey)) {
      taxes.push({
        name: 'Loss Aversion', impact: -8, type: 'TAX',
        desc: 'Losing a familiar player hurts more than gaining a new one. Expect resistance.'
      });
    }

    // 5 - Rebuilding Discount (Acceptor)
    if (theirDnaKey === 'ACCEPTOR') {
      taxes.push({
        name: 'Rebuilding Discount', impact: +10, type: 'BONUS',
        desc: 'They mentally discount current starters. Buy at a discount in their mind.'
      });
    }

    // 6 - Need Fulfillment
    const myStrengths  = myAssessment?.strengths || [];
    const theirNeedPos = theirAssessment?.needs?.slice(0, 3).map(n => n.pos) || [];
    if (theirNeedPos.some(p => myStrengths.includes(p))) {
      taxes.push({
        name: 'Need Fulfillment', impact: +12, type: 'BONUS',
        desc: 'Your surplus fills their critical positional gap — strong deal motivation.'
      });
    }

    // 7 - Trade Window alignment
    if (myAssessment && theirAssessment) {
      if (myAssessment.window !== theirAssessment.window) {
        taxes.push({
          name: 'Window Alignment', impact: +8, type: 'BONUS',
          desc: 'Opposite windows (contender vs rebuilder) = natural asset exchange.'
        });
      } else {
        taxes.push({
          name: 'Window Friction', impact: -5, type: 'TAX',
          desc: 'Same trade window reduces natural motivation to exchange assets.'
        });
      }
    }

    // 8 - Posture
    if (theirPosture?.key === 'LOCKED') {
      taxes.push({
        name: 'Locked Roster Tax', impact: -12, type: 'TAX',
        desc: 'High satisfaction + attachment. Roster moves feel threatening to them.'
      });
    } else if (theirPosture?.key === 'SELLER') {
      taxes.push({
        name: 'Seller Momentum', impact: +10, type: 'BONUS',
        desc: 'Actively shopping. Trade conversations are welcomed.'
      });
    }

    return taxes;
  }

  // ── calcAcceptanceLikelihood ─────────────────────────────────
  // Canonical acceptance % for a trade offer.
  // myValue = DHQ total of what user GIVES, theirValue = what user RECEIVES.
  // Returns integer 5-95.
  //
  // DNA influences acceptance through psych taxes/posture only. The value curve
  // stays linear so every extra DHQ point always helps the other owner.
  function calcAcceptanceLikelihood(myValue, theirValue, theirDnaKey, psychTaxes, myAssessment, theirAssessment, opts) {
    let likelihood = 50;
    const totalA = Number(myValue) || 0;   // what I'm giving
    const totalB = Number(theirValue) || 0; // what I'm receiving
    if (totalA > 0 || totalB > 0) {
      const diff = totalA - totalB;
      const maxSide = Math.max(totalA, totalB, 1);
      const rawTax = (psychTaxes || []).reduce((s, t) => s + (Number(t.impact) || 0), 0);
      const complexityTax = Math.max(0, ((opts?.totalPieces) || 0) - 4) * 5;
      const taxValueAdjust = ((rawTax - complexityTax) / 200) * maxSide;
      const theirEffectiveSurplus = diff + taxValueAdjust;
      const normalizedSurplus = theirEffectiveSurplus / maxSide;
      likelihood = 50 + Math.round(normalizedSurplus * 200);
    }
    return Math.round(Math.max(5, Math.min(95, likelihood)));
  }

  // ── fairnessGrade ──────────────────────────────────────────────
  // Ratio-based fairness grade. myValue = what user gives, theirValue = what user gets.
  // Returns { grade, label, color, col } — `col` aliases `color` because War Room's
  // draft consumers read grade.col (the local fallback engine's key).
  function fairnessGrade(myValue, theirValue) {
    const graded = (grade, label, color) => ({ grade, label, color, col: color });
    if (myValue === 0 && theirValue === 0) return graded('--', '', '#95A5A6');
    const ratio = theirValue / Math.max(myValue, 1); // >1 = user gains
    if (ratio >= 1.30) return graded('A+', 'Steal',       '#2ECC71');
    if (ratio >= 1.15) return graded('A',  'Clear Win',   '#2ECC71');
    if (ratio >= 1.05) return graded('B+', 'Slight Win',  '#2ECC71');
    if (ratio >= 0.95) return graded('B',  'Fair',        '#D4AF37');
    if (ratio >= 0.85) return graded('C',  'Slight Loss', '#F0A500');
    if (ratio >= 0.75) return graded('D',  'Overpay',     '#E67E22');
    return graded('F', 'Bad Trade', '#E74C3C');
  }

  // ── Grudge types ───────────────────────────────────────────────
  // Canonical trade-interaction outcomes + their acceptance-tax impact (and DNA signal).
  // Single source of truth for both apps; calcGrudgeTax reads .impact. Exposed on
  // window.App.GRUDGE_TYPES — previously only a component-local const in War Room's
  // trade-calc.js, so the shared calcGrudgeTax silently returned 0 for every caller.
  const GRUDGE_TYPES = {
    ACCEPTED_FAIR:   { label: 'Accepted — Fair Trade',  impact: +5,  cat: 'accepted', dnaSignal: { STALWART: 3 } },
    ACCEPTED_WON:    { label: 'Accepted — Fleeced Them', impact: -8,  cat: 'accepted', dnaSignal: { FLEECER: 3, DOMINATOR: 1 } },
    ACCEPTED_LOST:   { label: 'Accepted — Got Fleeced',  impact: +10, cat: 'accepted', dnaSignal: { ACCEPTOR: 3, DESPERATE: 2 } },
    REJECTED:        { label: 'Rejected',                impact: -15, cat: 'rejected', dnaSignal: { DOMINATOR: 3, FLEECER: 1 } },
    COUNTER_FAIR:    { label: 'Counter — Fair',          impact: +3,  cat: 'counter',  dnaSignal: { STALWART: 2, FLEECER: 1 } },
    COUNTER_LOWBALL: { label: 'Counter — Lowball',       impact: -10, cat: 'counter',  dnaSignal: { FLEECER: 3, DOMINATOR: 2 } },
  };

  // ── calcGrudgeTax ──────────────────────────────────────────────
  // DNA-weighted grudge modifier from trade history between two owners.
  // grudgesList = [{ myOwnerId, theirOwnerId, type, date }]
  // Returns { total: Number, entries: Array }.
  function calcGrudgeTax(myOwnerId, theirOwnerId, grudgesList, theirDnaKey) {
    if (!myOwnerId || !theirOwnerId || !grudgesList?.length) return { total: 0, entries: [] };
    const relevant = grudgesList.filter(g => g.myOwnerId === myOwnerId && g.theirOwnerId === theirOwnerId);
    const dnaMult = { FLEECER: 0.7, DOMINATOR: 1.6, STALWART: 1.2, ACCEPTOR: 0.8, DESPERATE: 0.5, NONE: 1.0 }[theirDnaKey] || 1.0;
    const now = Date.now();
    const grudgeDecay = d => d < 30 ? 1.0 : d < 60 ? 0.6 : d < 90 ? 0.3 : 0.1;
    let total = 0;
    for (const g of relevant) {
      const ageDays = (now - new Date(g.date).getTime()) / 86400000;
      total += (GRUDGE_TYPES[g.type]?.impact || 0) * grudgeDecay(ageDays) * dnaMult;
    }
    return { total: Math.round(total), entries: relevant.sort((a, b) => new Date(b.date) - new Date(a.date)) };
  }

  // ── Expose ────────────────────────────────────────────────────
  window.App.TradeEngine = {
    POSTURES,
    calcComplementarity,
    calcOwnerPosture,
    calcPsychTaxes,
    calcAcceptanceLikelihood,
    fairnessGrade,
    calcGrudgeTax,
    GRUDGE_TYPES,
  };
  window.App.GRUDGE_TYPES = GRUDGE_TYPES;
})();

// ── Module global exports (Vite migration) ───────────────────────────────────
window.POSTURES = window.App.TradeEngine.POSTURES;
window.calcComplementarity = window.App.TradeEngine.calcComplementarity;
window.calcOwnerPosture = window.App.TradeEngine.calcOwnerPosture;
window.calcPsychTaxes = window.App.TradeEngine.calcPsychTaxes;
window.calcAcceptanceLikelihood = window.App.TradeEngine.calcAcceptanceLikelihood;
window.fairnessGrade = window.App.TradeEngine.fairnessGrade;
window.calcGrudgeTax = window.App.TradeEngine.calcGrudgeTax;
