// ── Redraft Draft Gameplan ───────────────────────────────────────
// Derives draft round count from a league's roster structure (works even
// when no draft is scheduled on Sleeper/MFL) and builds round-by-round
// positional blueprints for several draft archetypes (Balanced, RB-Heavy,
// Hero-RB, Zero-RB/WR-Heavy, Elite-TE, QB-Early/Superflex, Late-QB), tuned
// to the league's exact roster slots + scoring (PPR / SF / TE-premium).
//
// Pure + dual-mode (browser global App.DraftGameplan + Node export).
// NOTE: warroom-local copy (loaded via a direct <script> tag) — the dev
// server regenerates warroom/reconai-shared/, so this lives under js/shared/.
// Canonical twin for Node tests: reconai/shared/draft-gameplan.js.
(function (root) {
    'use strict';
    const App = root.App = root.App || {};

    const BENCH_SLOTS = new Set(['BN', 'BE', 'BENCH', 'IR', 'TAXI', 'RES']);
    function normSlot(slot) {
        const raw = String(slot || '').trim().toUpperCase();
        if (raw === 'D/ST' || raw === 'DST') return 'DEF';
        if (raw === 'SUPERFLEX') return 'SUPER_FLEX';
        if (raw === 'WR/RB/TE' || raw === 'W/R/T') return 'FLEX';
        if (raw === 'WR/TE' || raw === 'W/T') return 'REC_FLEX';
        if (raw === 'Q/W/R/T' || raw === 'OP') return 'SUPER_FLEX';
        return raw;
    }

    function parseSlots(rosterPositions) {
        const norm = (rosterPositions || []).map(normSlot);
        const c = {};
        norm.forEach(s => { c[s] = (c[s] || 0) + 1; });
        const bench = (c.BN || 0) + (c.BE || 0) + (c.BENCH || 0);
        const starters = norm.filter(s => !BENCH_SLOTS.has(s)).length;
        const idp = (c.DL || 0) + (c.LB || 0) + (c.DB || 0) + (c.IDP_FLEX || 0);
        return {
            qb: c.QB || 0, rb: c.RB || 0, wr: c.WR || 0, te: c.TE || 0,
            flex: (c.FLEX || 0) + (c.WRTQ || 0), recFlex: c.REC_FLEX || 0, sf: c.SUPER_FLEX || 0,
            k: c.K || 0, def: c.DEF || 0, idp, bench, starters,
        };
    }

    // Draftable rounds = every startable slot + bench (IR/taxi excluded by parseSlots).
    function deriveRounds(rosterPositions) {
        const s = parseSlots(rosterPositions);
        return Math.max(1, s.starters + s.bench);
    }

    // Archetype params. rbRatio = share of the RB+WR pool that goes to RB.
    // qbFrac/teFrac = how deep (0..1) before that position becomes a priority.
    function archetypes(opts) {
        const sf = opts.superflex;
        const list = [
            { key: 'balanced', label: 'Balanced / BPA', rbWt: 1.0, wrWt: 1.0, qbFrac: 0.45, teFrac: 0.4, rbRatio: 0.5,
              blurb: 'Take the best player available, keep RB and WR even, fill QB/TE in the mid rounds.' },
            { key: 'rb_heavy', label: 'RB Heavy', rbWt: 1.45, wrWt: 0.85, qbFrac: 0.6, teFrac: 0.55, rbRatio: 0.62,
              blurb: 'Anchor early rounds with bellcow backs; chase WR value once the RB room is set.' },
            { key: 'hero_rb', label: 'Hero RB', rbWt: 0.9, wrWt: 1.2, qbFrac: 0.55, teFrac: 0.5, rbRatio: 0.4, firstPickPos: 'RB',
              blurb: 'One elite RB in Round 1, then hammer WR depth and find RB value later.' },
            { key: 'zero_rb', label: 'Zero-RB / WR Heavy', rbWt: 0.7, wrWt: 1.4, qbFrac: 0.55, teFrac: 0.42, rbRatio: 0.34,
              blurb: 'Load up on WR (and elite TE) early; attack RB upside in the middle-to-late rounds.' },
            { key: 'te_prem', label: 'Elite TE', rbWt: 1.0, wrWt: 1.0, qbFrac: 0.55, teFrac: 0.1, rbRatio: 0.48, teEarly: true,
              blurb: 'Secure a top TE early for the weekly positional edge, then run a balanced board.' },
            { key: 'qb_early', label: sf ? 'Superflex (QB Early)' : 'Early QB', rbWt: 1.0, wrWt: 1.0, qbFrac: 0.0, teFrac: 0.5, rbRatio: 0.5, qbEarly: true,
              blurb: sf ? 'In Superflex, QBs are gold — grab two starters early before the run dries up.' : 'Lock an elite QB early for a set-and-forget weekly edge.' },
            { key: 'late_qb', label: 'Late-Round QB', rbWt: 1.05, wrWt: 1.0, qbFrac: 0.82, teFrac: 0.5, rbRatio: 0.5,
              blurb: 'Pour early picks into RB/WR; stream or pair value QBs in the final rounds.' },
        ];
        // QB-Early/Late-QB are less meaningful with no real QB scarcity; keep all
        // but mark the superflex-relevant one. Late-QB is risky in superflex.
        return list;
    }

    function computeTargets(slots, rounds, arch, opts) {
        const k = slots.k, def = slots.def, idp = slots.idp;
        const sf = opts.superflex;
        let qb = sf ? (slots.qb + slots.sf + 1) : (slots.qb + 1);
        qb = Math.max(slots.qb, Math.min(qb, sf ? 4 : 2));
        let te = slots.te + 1 + (opts.tePremium ? 1 : 0);
        te = Math.max(slots.te, Math.min(te, opts.tePremium ? 3 : 2));

        let reserved = qb + te + k + def + idp;
        if (reserved > rounds) {
            let over = reserved - rounds;
            while (over > 0 && te > slots.te) { te--; over--; }
            const qbFloor = sf ? slots.qb + slots.sf : slots.qb;
            while (over > 0 && qb > qbFloor) { qb--; over--; }
            reserved = qb + te + k + def + idp;
        }
        let rbwr = Math.max(0, rounds - reserved);
        let rb = Math.round(rbwr * arch.rbRatio);
        let wr = rbwr - rb;
        // reconcile to exactly `rounds`
        let sum = qb + te + k + def + idp + rb + wr;
        let diff = rounds - sum;
        wr += diff;
        if (wr < 0) { rb += wr; wr = 0; }
        if (rb < 0) rb = 0;
        return { QB: qb, RB: rb, WR: wr, TE: te, K: k, DEF: def, IDP: idp };
    }

    function desirability(pos, frac, arch, opts) {
        if (pos === 'QB') {
            if (opts.superflex && arch.qbEarly) return 1.4;
            if (opts.superflex) return frac >= 0.12 ? 1.18 : 0.55;
            if (arch.qbEarly) return 1.25;
            return frac >= arch.qbFrac ? 1.05 : 0.15;
        }
        if (pos === 'TE') {
            if (arch.teEarly) return frac < 0.25 ? 1.3 : 0.6;
            return frac >= arch.teFrac ? 0.95 : 0.2;
        }
        if (pos === 'RB') return arch.rbWt * (1.18 - 0.4 * frac);
        if (pos === 'WR') return arch.wrWt * (1.02 - 0.08 * frac) + 0.05;
        return 0;
    }

    // Round-by-round position sequence for one archetype. K/DEF/IDP are
    // reserved for the final rounds; QB/RB/WR/TE are ordered by desirability.
    function buildSequence(targets, arch, opts) {
        const total = targets.QB + targets.RB + targets.WR + targets.TE + targets.K + targets.DEF + targets.IDP;
        const seq = new Array(total).fill(null);
        const rem = { ...targets };
        let tail = total - 1;
        for (let i = 0; i < targets.DEF; i++) { seq[tail--] = 'DEF'; rem.DEF--; }
        for (let i = 0; i < targets.K; i++) { seq[tail--] = 'K'; rem.K--; }
        for (let i = 0; i < targets.IDP; i++) { seq[tail--] = 'IDP'; rem.IDP--; }
        const head = tail; // fill 0..head
        for (let r = 0; r <= head; r++) {
            const frac = head > 0 ? r / head : 0;
            let best = null, bestScore = -Infinity;
            if (r === 0 && arch.firstPickPos && rem[arch.firstPickPos] > 0) {
                best = arch.firstPickPos;
            } else {
                for (const pos of ['QB', 'RB', 'WR', 'TE']) {
                    if (rem[pos] <= 0) continue;
                    // Balance penalty: as a position fills toward its target, its
                    // pull drops — so equal-weight positions interleave instead of
                    // one being exhausted first. Archetype tilt (weights/targets)
                    // still dominates which position gets the larger share.
                    const drafted = targets[pos] - rem[pos];
                    const balancePenalty = 0.5 * (drafted / Math.max(1, targets[pos]));
                    const sc = desirability(pos, frac, arch, opts) - balancePenalty;
                    if (sc > bestScore) { bestScore = sc; best = pos; }
                }
            }
            if (!best) best = ['RB', 'WR', 'TE', 'QB'].find(p => rem[p] > 0) || 'RB';
            seq[r] = best; rem[best]--;
        }
        return seq;
    }

    // Main entry. league: { roster_positions, scoring_settings }; opts may
    // override { rounds, superflex, tePremium }.
    function build(league, opts) {
        opts = opts || {};
        const rosterPositions = (league && league.roster_positions) || opts.rosterPositions || [];
        const scoring = (league && league.scoring_settings) || opts.scoring || {};
        const slots = parseSlots(rosterPositions);
        const rounds = Math.max(1, opts.rounds || deriveRounds(rosterPositions));
        const superflex = opts.superflex != null ? opts.superflex : (slots.sf > 0 || slots.qb >= 2);
        const ppr = Number(scoring.rec || 0);
        const tePremium = opts.tePremium != null ? opts.tePremium : !!(scoring.bonus_rec_te && scoring.bonus_rec_te > 0);
        const ctx = { superflex, tePremium, ppr };

        const plans = archetypes(ctx).map(arch => {
            const targets = computeTargets(slots, rounds, arch, ctx);
            const seq = buildSequence(targets, arch, ctx);
            const picks = seq.map((pos, i) => ({ round: i + 1, pos }));
            return { key: arch.key, label: arch.label, blurb: arch.blurb, targets, picks };
        });

        return {
            rounds, superflex, tePremium,
            ppr: ppr >= 1 ? 'PPR' : ppr > 0 ? `${ppr} PPR` : 'Standard',
            slots,
            startersLabel: rosterPositions.map(normSlot).filter(s => !BENCH_SLOTS.has(s)).join(' · '),
            archetypes: plans,
        };
    }

    const DraftGameplan = { build, deriveRounds, parseSlots, archetypes, normSlot };
    App.DraftGameplan = App.DraftGameplan || DraftGameplan;
    if (typeof module !== 'undefined' && module.exports) module.exports = DraftGameplan;
})(typeof window !== 'undefined' ? window : globalThis);
