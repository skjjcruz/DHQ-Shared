// ═══════════════════════════════════════════════════════════════
// UNIVERSAL DYNASTY PICK VALUE MODEL v9
// Three-phase continuous decay with a size-capped premium tier + final floor zone
//
// Calibrated to: KeepTradeCut (April 2026, 25M+ crowdsourced data points),
// FantasyCalc, theScore/Justin Boone dynasty trade values
//
// Key design: THREE-PHASE continuous decay, with the two steep tiers BOUNDED at a
// reference league size (REF_TEAMS=16) so the model behaves identically for
// standard leagues but does NOT crater very large leagues (e.g. 68-team), where
// the old per-pick decay bottomed out by round 2.
//   Phase 1 (premium): top REF picks — 1.01 stands out without cratering 1.02+
//   Phase 2 (moderate): next REF picks — hold reasonable value
//   Phase 3 (tail):     long lottery glide to the soft floor across the REST of
//                       the draft (spans the whole board for large leagues)
//   Floor zone:         only the final 10% of picks are exactly 50 DHQ
//   Each phase starts where the previous one ends (smooth continuous handoff)
//
// Standard leagues (teams ≤ REF_TEAMS) are byte-identical to v8's calibration.
// Works for any league size (8-68+ teams) and any draft length.
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate the industry consensus value for any dynasty draft pick.
 * Returns a value on the DHQ 0-10000 scale.
 *
 * Three-phase continuous decay. The premium/moderate tiers are anchored to
 * ABSOLUTE pick position (so a given slot's value is stable across draft lengths)
 * and capped at REF_TEAMS so large leagues taper instead of cratering. The true
 * 50-DHQ minimum is reserved for the final 10% of the draft.
 *
 * 16-team reference (unchanged from v8): 1.04≈6490, 1.08≈5350, 1.12≈4420, 1.16≈3650
 *
 * @param {number} pickNumber - Overall pick number (1-indexed)
 * @param {number} totalTeams - League size (8-68+)
 * @param {number} draftRounds - Number of draft rounds (typically 4-10)
 * @returns {number} DHQ value (50-7500)
 */
function getIndustryPickValue(pickNumber, totalTeams, draftRounds) {
  const TOP = 7500;  // Pick 1.01 value (KTC/FantasyCalc calibrated)
  const FLOOR = 50;
  const SOFT_FLOOR = 75;
  // Reference league size that bounds the steep market-rate tiers. The genuinely
  // valuable rookie tier is the top ~2 rounds of a standard draft (~32 players);
  // beyond that, picks are dart throws and should taper gently rather than keep
  // cratering. Capping the R1/R2 spans here is what stops LARGE leagues (e.g. a
  // 68-team draft, where the old per-pick decay ran for 68+ picks and bottomed out
  // by round 2) from flooring early — while leaving standard leagues (teams ≤ REF)
  // byte-identical to the calibrated model.
  const REF_TEAMS = 16;

  const teams = Math.max(1, Number(totalTeams) || 12);
  const rounds = Math.max(1, Number(draftRounds) || 7);
  const totalPicks = teams * rounds;
  const pick = Math.max(1, Math.min(Math.round(Number(pickNumber) || 1), totalPicks));
  // Only the FINAL 10% of the draft sits at the true floor, so deep picks keep a
  // differentiated, tradeable value instead of all collapsing to the minimum.
  const floorPickCount = Math.max(1, Math.round(totalPicks * 0.10));
  const floorStart = totalPicks - floorPickCount + 1;

  if (pick >= floorStart) return FLOOR;

  // Tier boundaries are capped at the reference size. For teams ≤ REF_TEAMS these
  // equal the old teams/2·teams boundaries (no behavior change); for larger leagues
  // they stay fixed so only the top tier decays at the steep market rate and the
  // rest taper over a long phase-3 tail.
  const r1End = Math.min(teams, REF_TEAMS);        // end of the premium tier
  const r2End = Math.min(teams * 2, REF_TEAMS * 2); // end of the moderate tier
  const phase3End = Math.max(r2End + 1, floorStart - 1);

  // Phase 1 (premium tier): smooth — no sharp 1.01 cliff
  const k1 = 0.048;
  // Phase 2 (moderate tier): smooth descent from the phase-1 endpoint
  const k2 = 0.035;

  // Transition values (each phase starts where the previous ends) — these depend
  // ONLY on absolute pick position, so a given slot's value is draft-length-stable.
  const t1 = TOP * Math.exp(-k1 * (r1End - 1));
  const t2 = t1 * Math.exp(-k2 * (r2End - r1End));

  function interpolateExp(start, end, step, totalSteps) {
    if (totalSteps <= 0) return end;
    const bounded = Math.max(0, Math.min(1, step / totalSteps));
    return start * Math.pow(end / start, bounded);
  }

  let value;
  if (pick <= r1End) {
    value = TOP * Math.exp(-k1 * (pick - 1));
  } else if (pick <= r2End) {
    value = t1 * Math.exp(-k2 * (pick - r1End));
  } else {
    // Long lottery tail: glide from the moderate-tier endpoint to the soft floor
    // across ALL remaining picks, so large leagues span the whole draft instead of
    // hitting the floor a round or two in.
    value = interpolateExp(t2, SOFT_FLOOR, pick - r2End, phase3End - r2End);
  }

  return Math.max(FLOOR + 1, Math.round(value));
}

/**
 * Convenience: get value using round + slot instead of pick number
 */
function getPickValueBySlot(round, posInRound, totalTeams, draftRounds) {
  const teams = Math.max(1, Number(totalTeams) || 12);
  const pickNumber = (Math.max(1, Number(round) || 1) - 1) * teams + Math.max(1, Number(posInRound) || 1);
  return getIndustryPickValue(pickNumber, teams, draftRounds || 7);
}

/**
 * Generate a complete pick value table for a league.
 * Returns an object keyed by pick number (1-indexed).
 */
function buildIndustryPickTable(totalTeams, draftRounds) {
  const table = {};
  const teams = Math.max(1, Number(totalTeams) || 12);
  const rounds = Math.max(1, Number(draftRounds) || 7);
  const totalPicks = teams * rounds;
  for (let pick = 1; pick <= totalPicks; pick++) {
    table[pick] = getIndustryPickValue(pick, teams, rounds);
  }
  // Monotonic enforcement: each pick must be worth ≤ the previous pick.
  // Guards against any discount or phase-boundary inversion.
  for (let pick = 2; pick <= totalPicks; pick++) {
    if (table[pick] > table[pick - 1]) {
      table[pick] = Math.max(50, table[pick - 1] - 1);
    }
  }
  return table;
}

// Export for use in DHQ engine and Node.js tests
if (typeof window !== 'undefined') {
  window.getIndustryPickValue = getIndustryPickValue;
  window.getPickValueBySlot = getPickValueBySlot;
  window.buildIndustryPickTable = buildIndustryPickTable;
}
if (typeof module !== 'undefined') {
  module.exports = { getIndustryPickValue, getPickValueBySlot, buildIndustryPickTable };
}
