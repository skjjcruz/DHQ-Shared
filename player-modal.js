// ══════════════════════════════════════════════════════════════════
// shared/player-modal.js — War Room Player Card
// Full-featured player modal with War Room gold/black palette,
// career stats, trade profile, position ranks, and dynasty insights.
// Requires: shared/constants.js, shared/dhq-engine.js, shared/sleeper-api.js
// ══════════════════════════════════════════════════════════════════

window.App = window.App || {};

// Seeded phrase variation (no-op fallback to first variant when AlexVoice
// isn't loaded — e.g. inside ReconAI, which doesn't ship the voice helper).
const _fwPick = (seed, arr) => (window.AlexVoice ? window.AlexVoice.pick(seed, arr) : arr[0]);

// ── Career stats cache ──────────────────────────────────────────
const _fwCareerCache = {};

// ── Position colors ────────────────────────────────────────────
const _fwPosColor = {
  QB:'rgba(96,165,250,.18)', RB:'rgba(46,204,113,.18)', WR:'rgba(212,175,55,.18)',
  TE:'rgba(251,191,36,.18)', K:'rgba(139,143,154,.12)', DL:'rgba(251,146,60,.18)',
  LB:'rgba(167,139,250,.18)', DB:'rgba(244,114,182,.18)', DEF:'rgba(248,113,113,.12)'
};
const _fwPosText = {
  QB:'#60a5fa', RB:'#2ECC71', WR:'#D4AF37', TE:'#fbbf24', K:'#a8acb8',
  DL:'#fb923c', LB:'#a78bfa', DB:'#f472b6', DEF:'#f87171'
};

// ── War Room theme colors ─────────────────────────────────────
const _wr = {
  gold: '#D4AF37', black: '#0a0a0f', charcoal: '#111318', panel: '#181b22',
  border: 'rgba(212,175,55,.2)', borderDim: 'rgba(255,255,255,.07)',
  text: '#f0f0f3', text2: '#a8acb8', text3: '#7d8291',
  green: '#2ECC71', red: '#E74C3C', amber: '#fbbf24',
  goldBg: 'rgba(212,175,55,.08)', goldBorder: 'rgba(212,175,55,.25)',
};

// ── Helper: normalize IDP positions ───────────────────────────
function _fwNormPos(p) {
  if (['DE','DT','NT','IDL','EDGE'].includes(p)) return 'DL';
  if (['CB','S','SS','FS'].includes(p)) return 'DB';
  if (['OLB','ILB','MLB'].includes(p)) return 'LB';
  return p;
}

// ── Helper: FantasyPros URL ────────────────────────────────────
function _fwFPUrl(name) {
  if (!name) return '#';
  return 'https://www.fantasypros.com/nfl/players/' +
    name.toLowerCase().replace(/[.']/g,'').replace(/[^a-z0-9]+/g,'-').replace(/-+$/,'') + '.php';
}

// ── Helper: age curve years ───────────────────────────────────
const _fwAgeCurves = window.App?.ageCurveWindows || {
  QB:{build:[23,27],peak:[28,34],decline:[35,38]},
  RB:{build:[21,22],peak:[23,25],decline:[26,28]},
  WR:{build:[22,24],peak:[25,28],decline:[29,31]},
  TE:{build:[23,25],peak:[26,29],decline:[30,32]},
  DL:{build:[22,24],peak:[25,29],decline:[30,32]},
  LB:{build:[22,23],peak:[24,28],decline:[29,31]},
  DB:{build:[21,23],peak:[24,27],decline:[28,30]},
  K:{build:[23,27],peak:[28,35],decline:[36,40]},
};
function _fwPeakYears(pos, age) {
  const curve = _fwAgeCurves[pos] || {build:[22,24],peak:[24,29],decline:[30,32]};
  const [lo,hi] = curve.peak;
  const declineHi = curve.decline[1];
  if (!age) return {label:'\u2014',desc:'',lo,hi,declineHi};
  if (age < curve.build[0]) return {label:'Seedling',desc:(lo-age)+'yr to peak',lo,hi,declineHi};
  if (age < lo) return {label:'Rising',desc:(lo-age)+'yr to peak',lo,hi,declineHi};
  if (age <= hi) return {label:'Peak',desc:Math.max(0,hi-age)<=0?'final yr':'~'+(hi-age)+'yr left',lo,hi,declineHi};
  if (age <= declineHi) return {label:'Veteran',desc:Math.max(0,declineHi-age)<=0?'final value yr':'~'+(declineHi-age)+' value yr left',lo,hi,declineHi};
  return {label:'Declining',desc:(age-hi)+'yr past peak',lo,hi,declineHi};
}

// ── Helper: compute fantasy points from raw stats ─────────────
function _fwCalcPts(raw, sc) {
  if (!raw) return 0;
  if (typeof calcRawPts === 'function') return calcRawPts(raw, sc);
  if (typeof calcFantasyPts === 'function') return calcFantasyPts(raw, sc);
  if (window.App?.Sleeper?.calcFantasyPts) return window.App.Sleeper.calcFantasyPts(raw, sc);
  return 0;
}

// ── Inject modal DOM ──────────────────────────────────────────
function _ensureModalDOM() {
  if (document.getElementById('fw-player-modal')) return;
  const div = document.createElement('div');
  div.innerHTML = `
  <div id="fw-player-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);z-index:10000;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto">
    <div style="background:linear-gradient(135deg,${_wr.charcoal} 0%,${_wr.panel} 100%);border:2px solid ${_wr.gold};border-radius:16px;width:100%;max-width:640px;margin:auto;position:relative;box-shadow:0 16px 64px rgba(0,0,0,.7),0 0 0 1px rgba(212,175,55,.1);animation:fwModalIn .25s ease">
      <style>
        @keyframes fwModalIn{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
        #fw-player-modal *{box-sizing:border-box}
        .fwpm-stat-box{padding:10px 6px;text-align:center;border-right:1px solid ${_wr.borderDim}}
        .fwpm-stat-box:last-child{border-right:none}
        .fwpm-stat-val{font-size:16px;font-weight:800;letter-spacing:-.03em;line-height:1;font-family:'JetBrains Mono',monospace}
        .fwpm-stat-lbl{font-size:13px;color:${_wr.text2};text-transform:uppercase;letter-spacing:.06em;margin-top:5px;font-weight:600}
        .fwpm-section{margin-bottom:14px}
        .fwpm-section-title{font-family:'DM Sans',sans-serif;font-size:13px;font-weight:700;color:${_wr.text2};text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
        .fwpm-card-box{background:${_wr.panel};border:1px solid ${_wr.border};border-radius:10px;padding:12px}
        .fwpm-btn{font-size:13px;padding:7px 16px;background:${_wr.panel};border:1px solid ${_wr.border};border-radius:8px;color:${_wr.text2};text-decoration:none;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:.04em;transition:all .15s;display:inline-block}
        .fwpm-btn:hover{background:${_wr.goldBg};color:${_wr.gold};border-color:${_wr.gold}}
        .fwpm-btn-gold{background:${_wr.gold};color:${_wr.black};border-color:${_wr.gold}}
        .fwpm-btn-gold:hover{background:#c9a42e}
        .fwpm-career-row{display:grid;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04);gap:3px;font-size:13px}
        .fwpm-career-row:last-child{border-bottom:none}
        .fwpm-career-hdr{font-size:13px;font-weight:700;color:${_wr.text3};text-transform:uppercase}
      </style>
      <!-- Drag handle for swipe-to-dismiss -->
      <div id="fwpm-handle" style="display:flex;justify-content:center;padding:10px 0 2px;cursor:grab">
        <div style="width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,.15)"></div>
      </div>
      <!-- Banner -->
      <div id="fwpm-banner" style="border-radius:14px 14px 0 0;padding:20px 22px;position:relative;overflow:hidden;background:linear-gradient(135deg,${_wr.panel} 0%,rgba(212,175,55,.04) 100%)">
        <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 20% 50%,rgba(212,175,55,.06),transparent 60%);pointer-events:none"></div>
        <button onclick="closeFWPlayerModal()" style="position:absolute;top:12px;right:12px;background:rgba(0,0,0,.5);border:1px solid ${_wr.border};color:${_wr.text2};cursor:pointer;font-size:18px;line-height:1;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;z-index:1;font-weight:400">&times;</button>
        <div style="display:flex;gap:16px;align-items:flex-start">
          <div style="position:relative;flex-shrink:0">
            <img id="fwpm-photo" src="" style="width:90px;height:90px;border-radius:12px;object-fit:cover;object-position:top;border:2px solid ${_wr.border}" onerror="this.style.display='none';document.getElementById('fwpm-initials').style.display='flex'"/>
            <div id="fwpm-initials" style="display:none;width:90px;height:90px;border-radius:12px;background:${_wr.panel};align-items:center;justify-content:center;font-size:26px;font-weight:700;color:${_wr.text3};border:2px solid ${_wr.border}"></div>
            <div id="fwpm-pos" style="position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);font-size:13px;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap"></div>
          </div>
          <div style="flex:1;min-width:0;padding-top:2px">
            <div id="fwpm-name" style="font-family:'DM Sans',sans-serif;font-size:22px;font-weight:800;letter-spacing:-.01em;color:${_wr.text};line-height:1.1;margin-bottom:4px"></div>
            <!-- Insight blurb -->
            <div id="fwpm-insight" style="margin-bottom:6px"></div>
            <div id="fwpm-bio" style="font-size:13px;color:${_wr.text2};margin-bottom:6px"></div>
            <div id="fwpm-tags" style="display:flex;gap:6px;flex-wrap:wrap"></div>
          </div>
        </div>
      </div>
      <!-- Stats bar -->
      <div id="fwpm-stats" style="display:grid;grid-template-columns:repeat(5,1fr);border-bottom:1px solid ${_wr.borderDim}"></div>
      <!-- Body -->
      <div style="padding:16px 20px">
        <!-- Age curve -->
        <div class="fwpm-section">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div class="fwpm-section-title" style="margin-bottom:0">Age Curve</div>
            <div id="fwpm-peak-tag" style="font-size:13px;color:${_wr.text2}"></div>
          </div>
          <div id="fwpm-curve" style="display:flex;height:22px;border-radius:5px;overflow:hidden;gap:1px"></div>
          <div id="fwpm-curve-lbl" style="display:flex;justify-content:space-between;font-size:13px;color:${_wr.text3};margin-top:3px"></div>
        </div>
        <!-- Value + Trade Profile -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
          <div class="fwpm-card-box">
            <div style="font-size:13px;color:${_wr.text3};text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Dynasty Trade Value</div>
            <div id="fwpm-val" style="font-size:24px;font-weight:800;letter-spacing:-.02em;color:${_wr.gold};font-family:'JetBrains Mono',monospace"></div>
            <div id="fwpm-tier" style="font-size:13px;color:${_wr.text2};margin-top:2px"></div>
          </div>
          <div id="fwpm-right" class="fwpm-card-box"></div>
        </div>
        <!-- Career Stats -->
        <div class="fwpm-section">
          <div class="fwpm-section-title" id="fwpm-stats-title">Career Stats</div>
          <div id="fwpm-career" style="background:${_wr.panel};border:1px solid ${_wr.border};border-radius:8px;padding:10px 12px;overflow-x:auto"></div>
        </div>
        <!-- Actions -->
        <div id="fwpm-actions" style="display:flex;gap:8px;flex-wrap:wrap"></div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(div.firstElementChild);
  document.getElementById('fw-player-modal').addEventListener('click', e => {
    if (e.target.id === 'fw-player-modal') closeFWPlayerModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeFWPlayerModal();
  });

  // Swipe-to-dismiss on drag handle
  const fwModal = document.getElementById('fw-player-modal');
  const fwSheet = fwModal?.firstElementChild;
  const fwHandle = document.getElementById('fwpm-handle');
  if (fwSheet && fwHandle) {
    let startY = 0, dragging = false;
    fwHandle.addEventListener('touchstart', e => { startY = e.touches[0].clientY; dragging = true; fwSheet.style.transition = 'none'; }, { passive: true });
    fwSheet.addEventListener('touchmove', e => {
      if (!dragging) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 0) { fwSheet.style.transform = `translateY(${dy}px)`; fwSheet.style.opacity = Math.max(0.4, 1 - dy / 400); }
    }, { passive: true });
    fwSheet.addEventListener('touchend', e => {
      if (!dragging) return;
      dragging = false;
      const dy = e.changedTouches[0].clientY - startY;
      fwSheet.style.transition = 'transform .2s ease, opacity .2s ease';
      if (dy > 100) { fwSheet.style.transform = 'translateY(100%)'; fwSheet.style.opacity = '0'; setTimeout(() => { closeFWPlayerModal(); fwSheet.style.transform = ''; fwSheet.style.opacity = ''; }, 200); }
      else { fwSheet.style.transform = ''; fwSheet.style.opacity = ''; }
    });
  }
}

// ── Fetch career stats from Sleeper ────────────────────────────
async function _fwFetchCareerStats(pid, currentYear, yrsExp) {
  if (_fwCareerCache[pid]) return _fwCareerCache[pid];
  const maxYears = Math.min(yrsExp + 1, 8); // up to 8 years back
  const startYear = Math.max(currentYear - maxYears + 1, 2018); // Sleeper data starts ~2018
  const years = [];
  for (let y = currentYear; y >= startYear; y--) years.push(y);

  const results = {};
  const SLEEPER_BASE = 'https://api.sleeper.app/v1';

  // Pull each season's full stats map from the shared IndexedDB-backed cache so
  // we reuse the blobs loadLeagueIntel/loadRosterStats already fetched instead of
  // re-downloading multi-MB-per-year just to read one player. (Previously this
  // wrote sessionStorage 'fw_stats_{yr}' with a {data,ts} shape that collided
  // with fetchSeasonStats' bare-JSON write under the same key.) Falls back to a
  // raw fetch if the shared API isn't loaded.
  await Promise.all(years.map(async yr => {
    let allStats;
    try {
      allStats = window.Sleeper?.fetchSeasonStats
        ? await window.Sleeper.fetchSeasonStats(yr)
        : await fetch(`${SLEEPER_BASE}/stats/nfl/regular/${yr}`).then(r => r.ok ? r.json() : null);
    } catch(e) {}
    if (allStats && allStats[pid]) {
      results[yr] = allStats[pid];
    }
  }));

  _fwCareerCache[pid] = results;
  return results;
}

// ── Build career stats table ──────────────────────────────────
function _fwBuildCareerTable(pid, careerData, pos, sc, playerObj) {
  const isIDP = ['DL','LB','DB'].includes(pos);
  const isQB = pos === 'QB';
  const isRB = pos === 'RB';
  const isK = pos === 'K';

  // Per-season TEAM column was removed — Sleeper career payload doesn't include
  // team-by-year, so it was always displaying the player's CURRENT team for
  // every row (misleading, e.g., Kenneth Walker showing Chiefs for every year).
  // PPG (fpts / gp) is computed per row + totals row in parseRow.
  let cols = [];
  if (isQB) cols = [{k:'gp',l:'GP'},{k:'ppg',l:'PPG'},{k:'pass_cmp',l:'CMP'},{k:'pass_att',l:'ATT'},{k:'pass_yd',l:'YDS'},{k:'pass_td',l:'TD'},{k:'pass_int',l:'INT'},{k:'rush_yd',l:'RUSH'},{k:'fpts',l:'FPTS'}];
  else if (isRB) cols = [{k:'gp',l:'GP'},{k:'ppg',l:'PPG'},{k:'rush_att',l:'ATT'},{k:'rush_yd',l:'YDS'},{k:'rush_td',l:'TD'},{k:'rec',l:'REC'},{k:'rec_yd',l:'REC YD'},{k:'rec_tgt',l:'TGT'},{k:'fpts',l:'FPTS'}];
  else if (['WR','TE'].includes(pos)) cols = [{k:'gp',l:'GP'},{k:'ppg',l:'PPG'},{k:'rec_tgt',l:'TGT'},{k:'rec',l:'REC'},{k:'rec_yd',l:'YDS'},{k:'rec_td',l:'TD'},{k:'rush_yd',l:'RUSH'},{k:'fpts',l:'FPTS'}];
  else if (isK) cols = [{k:'gp',l:'GP'},{k:'ppg',l:'PPG'},{k:'fgm',l:'FGM'},{k:'fga',l:'FGA'},{k:'fgm_50p',l:'50+'},{k:'xpm',l:'XPM'},{k:'xpa',l:'XPA'},{k:'fpts',l:'FPTS'}];
  else if (isIDP) cols = [{k:'gp',l:'GP'},{k:'ppg',l:'PPG'},{k:'idp_tkl',l:'TKL'},{k:'idp_sack',l:'SACK'},{k:'idp_int',l:'INT'},{k:'idp_pass_def',l:'PD'},{k:'idp_qb_hit',l:'QBH'},{k:'idp_ff',l:'FF'},{k:'fpts',l:'FPTS'}];
  else cols = [{k:'gp',l:'GP'},{k:'ppg',l:'PPG'},{k:'fpts',l:'FPTS'}];

  const gridCols = `38px ${cols.map(() => '1fr').join(' ')}`;

  const years = Object.keys(careerData).sort((a,b) => b-a);
  if (!years.length) return `<div style="color:${_wr.text3};font-size:13px;padding:4px 0">No career stats available.</div>`;

  const parseRow = (raw, yr) => {
    if (!raw) return null;
    const g = (...keys) => { for (const k of keys) { if (raw[k] != null && raw[k] !== 0) return raw[k]; } return 0; };
    const gp = g('gp','games_played') || 0;
    if (gp === 0 && !g('pass_yd') && !g('rush_yd') && !g('rec_yd') && !g('idp_tkl_solo')) return null;
    const fpts = _fwCalcPts(raw, sc);
    const ppg = gp > 0 ? +(fpts / gp).toFixed(1) : 0;
    return {
      yr, gp, fpts: +fpts.toFixed(1), ppg,
      pass_cmp: g('pass_cmp'), pass_att: g('pass_att'), pass_yd: g('pass_yd'), pass_td: g('pass_td'), pass_int: g('pass_int'),
      rush_att: g('rush_att'), rush_yd: g('rush_yd'), rush_td: g('rush_td'),
      rec: g('rec'), rec_yd: g('rec_yd'), rec_td: g('rec_td'), rec_tgt: g('rec_tgt','targets','tgt'),
      idp_tkl: g('idp_tkl_solo','tkl_solo') + g('idp_tkl_ast','tkl_ast'),
      idp_sack: g('idp_sack','sack'), idp_int: g('idp_int','def_int','int'),
      idp_pass_def: g('idp_pass_def','def_pass_def','pass_defended'),
      idp_qb_hit: g('idp_qb_hit','qb_hit'), idp_ff: g('idp_ff','ff','fumble_forced'),
      fgm: g('fgm','fg_made'), fga: g('fga','fg_att'), fgm_50p: g('fgm_50p','fgm_50_plus','fg_made_50_plus'),
      xpm: g('xpm','xp_made'), xpa: g('xpa','xp_att'),
      // Extra efficiency metrics
      _raw: raw,
    };
  };

  const rows = years.map(yr => parseRow(careerData[yr], yr)).filter(Boolean);
  if (!rows.length) return `<div style="color:${_wr.text3};font-size:13px;padding:4px 0">No career stats available.</div>`;

  const fmt = (v, k) => {
    if (v == null || (v === 0 && k !== 'pass_int')) return `<span style="color:${_wr.text3}">\u2014</span>`;
    if (k === 'fpts') return `<span style="color:${_wr.gold};font-weight:700">${v}</span>`;
    if (k === 'ppg') {
      // Color PPG by tier: elite >= 18, solid >= 12, low otherwise
      const col = v >= 18 ? _wr.green : v >= 12 ? _wr.gold : _wr.text2;
      return `<span style="color:${col};font-weight:600">${v.toFixed(1)}</span>`;
    }
    if (['pass_yd','rush_yd','rec_yd'].includes(k)) return `<strong>${Math.round(v).toLocaleString()}</strong>`;
    if (['idp_sack','idp_int','idp_ff','idp_qb_hit'].includes(k) && v >= 5) return `<span style="color:${_wr.green};font-weight:600">${Number.isInteger(v)?v:v.toFixed(1)}</span>`;
    if (k === 'idp_tkl' && v >= 80) return `<span style="color:${_wr.green};font-weight:600">${Math.round(v)}</span>`;
    return Number.isInteger(v) ? v : v.toFixed(1);
  };

  // Career totals row
  let totalsRow = '';
  if (rows.length >= 2) {
    const totals = { yr: 'TOT', gp: 0, fpts: 0, ppg: 0 };
    cols.forEach(c => { if (!['gp','fpts','ppg'].includes(c.k)) totals[c.k] = 0; });
    rows.forEach(r => {
      totals.gp += r.gp || 0;
      totals.fpts += r.fpts || 0;
      cols.forEach(c => { if (!['gp','fpts','ppg'].includes(c.k)) totals[c.k] = (totals[c.k]||0) + (r[c.k]||0); });
    });
    totals.fpts = +totals.fpts.toFixed(1);
    totals.ppg = totals.gp > 0 ? +(totals.fpts / totals.gp).toFixed(1) : 0;
    totalsRow = `
      <div class="fwpm-career-row" style="grid-template-columns:${gridCols};border-top:2px solid ${_wr.border};padding-top:6px;font-weight:700">
        <div style="font-size:13px;font-weight:800;color:${_wr.gold}">TOT</div>
        ${cols.map(c => `<div style="text-align:right;color:${_wr.text}">${fmt(totals[c.k], c.k)}</div>`).join('')}
      </div>`;
  }

  return `
    <div class="fwpm-career-row" style="grid-template-columns:${gridCols};padding-bottom:5px;border-bottom:2px solid ${_wr.border};margin-bottom:2px">
      <div class="fwpm-career-hdr">YR</div>
      ${cols.map(c => `<div class="fwpm-career-hdr" style="text-align:right">${c.l}</div>`).join('')}
    </div>
    ${rows.map(r => `
      <div class="fwpm-career-row" style="grid-template-columns:${gridCols}">
        <div style="font-weight:700;color:${_wr.text3}">${r.yr}</div>
        ${cols.map(c => `<div style="font-weight:600;text-align:right;color:${_wr.text}">${fmt(r[c.k], c.k)}</div>`).join('')}
      </div>`).join('')}
    ${totalsRow}`;
}

// ── Main: open player modal ────────────────────────────────────
function openFWPlayerModal(playerIdOrObj, playersData, statsData, scoringSettings) {
  _ensureModalDOM();

  // Resolve player data
  let pid, p, stats;
  if (typeof playerIdOrObj === 'object') {
    p = playerIdOrObj;
    pid = p.player_id || p.id || '';
    stats = statsData?.[pid] || {};
  } else {
    pid = String(playerIdOrObj);
    const players = (window.S && window.S.players) || playersData || {};
    p = players[pid];
    if (!p) { console.warn('[FW] Player not found:', pid); return; }
    stats = (window.S && window.S.playerStats?.[pid]) || statsData?.[pid] || {};
  }

  const pos = _fwNormPos(p.position || '');
  const age = p.age || 0;
  const name = p.full_name || ((p.first_name||'') + ' ' + (p.last_name||'')).trim() || pid;
  const team = p.team || 'FA';
  window._fwModalOpenPid = pid; // guards the async Dynasty Read swap against stale writes
  const exp = p.years_exp ?? 0;
  const pk = _fwPeakYears(pos, age);
  const isIDP = ['DL','LB','DB'].includes(pos);

  const LI = window.App.LI || {};
  const LI_LOADED = window.App.LI_LOADED || false;

  // DHQ value
  const val = (typeof dynastyValue === 'function') ? dynastyValue(pid) : (LI.playerScores?.[pid] || 0);
  const _isElite = typeof window.App?.isElitePlayer === 'function' ? window.App.isElitePlayer(pid) : val >= 7000;
  const tier = _isElite ? 'Elite' : val >= 4000 ? 'Starter' : val >= 2000 ? 'Depth' : val > 0 ? 'Stash' : '\u2014';
  const tierCol = _isElite ? _wr.green : val >= 4000 ? _wr.gold : val >= 2000 ? _wr.text2 : _wr.text3;

  // Position rank from DHQ engine
  const fcRankData = (typeof getPlayerRank === 'function') ? getPlayerRank(pid) : null;

  // Meta from DHQ
  const meta = LI.playerMeta?.[pid];
  const trend = meta?.trend || 0;
  const peakYrsLeft = meta?.peakYrsLeft || 0;

  // Scoring settings
  const sc = scoringSettings ||
    (window.S && window.S.leagues?.find(l => l.league_id === (window.S?.currentLeagueId))?.scoring_settings) || {};

  // Raw stats
  const rawStats = stats.prevRawStats || stats.curRawStats || stats;
  const gamesPlayed = stats.gp || rawStats?.gp || 0;
  let ppg = stats.prevAvg || stats.seasonAvg || 0;
  let total = stats.prevTotal || stats.seasonTotal || 0;
  if (!ppg && gamesPlayed > 0) {
    const pts = _fwCalcPts(rawStats, sc);
    if (pts) { total = Math.round(pts * 10) / 10; ppg = +(pts / gamesPlayed).toFixed(1); }
  }

  // ── Helper: safe DOM set ──
  const _fwSet=(id,prop,val)=>{const el=document.getElementById(id);if(el){if(prop==='textContent')el.textContent=val;else if(prop==='innerHTML')el.innerHTML=val;else el.style[prop]=val;}return el;};

  // ── Photo ──
  const photo = document.getElementById('fwpm-photo');
  if(photo){photo.src=`https://sleepercdn.com/content/nfl/players/${pid}.jpg`;photo.style.display='';}
  const initials = document.getElementById('fwpm-initials');
  if(initials){initials.textContent=((p.first_name||'?')[0]+(p.last_name||'?')[0]).toUpperCase();initials.style.display='none';}

  // ── Position badge ──
  const posBadge = document.getElementById('fwpm-pos');
  if(posBadge){posBadge.textContent=window.App?.posLabel?.(pos)||(pos==='DEF'?'D/ST':pos);posBadge.style.background=_fwPosColor[pos]||'rgba(212,175,55,.15)';posBadge.style.color=_fwPosText[pos]||_wr.gold;}

  // ── Name ──
  _fwSet('fwpm-name','textContent',name);

  // Scout Pro gate — fail-open (missing tier.js = Pro). Free browses raw
  // identity/value/stats; the dynasty-insight read and the Buy/Sell trade
  // verdict are Pro, mirroring reconai's app-local modal (player-modal.js).
  const _pmPro = typeof window.isScoutPro !== 'function' || window.isScoutPro();

  // ── Insight blurb ──
  const insightEl = document.getElementById('fwpm-insight');
  if (meta && _pmPro) {
    const yrsPast = Math.max(0, age - pk.hi);
    const yrsExp = exp;
    let blurb = '', blurbCol = _wr.amber;
    const _sd = 'pm:' + (pid || name) + ':' + pos;

    if (meta.source === 'FC_ROOKIE') {
      blurb = _fwPick(_sd, [
        `Incoming rookie with ${peakYrsLeft||'?'} peak years ahead. Value's off DHQ dynasty consensus for now.`,
        `Rookie \u2014 ${peakYrsLeft||'?'} peak years of runway, and the value's anchored to DHQ consensus until he plays.`,
      ]);
      blurbCol = _wr.green;
    } else if (meta.statusReason) {
      const roleNote = meta.roleLabel ? ` ${meta.roleLabel}.` : '';
      blurb = _fwPick(_sd, [
        `${meta.statusReason}.${roleNote} DHQ's holding the profile down until the NFL role changes.`,
        `${meta.statusReason}.${roleNote} The value won't move until his role does.`,
      ]);
      blurbCol = meta.statusCode === 'active' ? _wr.amber : _wr.red;
    } else if (meta.roleLabel && meta.roleMult < 0.9) {
      blurb = _fwPick(_sd, [
        `${meta.roleLabel} on the depth chart \u2014 DHQ's discounting him until the playing time firms up.`,
        `${meta.roleLabel} right now, so the value's docked until he earns more snaps.`,
      ]);
      blurbCol = _wr.amber;
    } else if (meta.opportunityLabel && meta.opportunityMult < 1) {
      blurb = _fwPick(_sd, [
        `${meta.opportunityLabel}. That's a softer opportunity discount, not a hard ceiling.`,
        `${meta.opportunityLabel} \u2014 DHQ trims for it, but it's not capping his upside.`,
      ]);
      blurbCol = _wr.amber;
	    } else if (meta.sitMult <= 0.35 && (!team || team === 'FA')) {
	      blurb = _fwPick(_sd, [
	        `Nobody in the league rosters him and he's got no NFL team. ${yrsPast>=2?'Probably done.':'Needs a landing spot first.'}`,
	        `No league roster, no NFL team. ${yrsPast>=2?'Looks retired or out of the league.':'He needs somewhere to land.'}`,
	      ]);
	      blurbCol = _wr.red;
	    } else if (age <= pk.declineHi && yrsPast > 0) {
	      blurb = _fwPick(_sd, [
	        `A touch past elite ${pos} peak, but still in the valuable veteran band. ${pk.desc}.`,
	        `Just past his ${pos} prime, though he's hanging in the useful veteran range. ${pk.desc}.`,
	      ]);
	      blurbCol = _wr.amber;
	    } else if (yrsPast >= 5) {
      const extra = gamesPlayed <= 12 && gamesPlayed > 0 ? ` Only ${gamesPlayed} games last year.` : '';
      const trendNote = trend <= -15 ? ` Production down ${Math.abs(trend)}%.` : '';
      const vet = yrsExp>8?yrsExp+'-year vet, ':'';
      blurb = _fwPick(_sd, [
        `${vet}${yrsPast} years past ${pos} prime at ${age}. On borrowed time \u2014 sell if anyone's buying.${extra}${trendNote}`,
        `${vet}${yrsPast} years past peak at ${age}. I'd be shopping him while there's still a market.${extra}${trendNote}`,
      ]);
      blurbCol = _wr.red;
    } else if (yrsPast >= 2) {
      const trendNote = trend <= -20 ? ` PPG dropped ${Math.abs(trend)}% last season.` : trend >= 15 ? ` Still trending up ${trend}% \u2014 defying age.` : '';
      const gpNote = gamesPlayed <= 12 && gamesPlayed > 0 ? ` Durability concern \u2014 only ${gamesPlayed} games.` : '';
      const proven = meta.starterSeasons>=4?'Proven producer, but ':'';
      blurb = _fwPick(_sd, [
        `${yrsPast} years past ${pos} peak at ${age}. ${proven}the dynasty value's sliding.${trendNote}${gpNote}`,
        `At ${age}, he's ${yrsPast} years past ${pos} peak \u2014 ${proven}value's on the way down.${trendNote}${gpNote}`,
      ]);
      blurbCol = _wr.red;
    } else if (yrsPast === 1) {
      const trendNote = trend <= -20 ? ` PPG fell ${Math.abs(trend)}% \u2014 the slide may be starting.` : trend >= 15 ? ` Still improving (+${trend}%) \u2014 could have more in the tank.` : ' Worth watching closely this year.';
      blurb = _fwPick(_sd, [
        `Just stepped out of his ${pos} peak window at ${age}.${trendNote}`,
        `One year removed from ${pos} peak at ${age}.${trendNote}`,
      ]);
      blurbCol = _wr.amber;
    } else if (age <= pk.lo && peakYrsLeft >= 5) {
      const prodNote = meta.starterSeasons >= 2 ? ` Already a ${meta.starterSeasons}-year starter at just ${age} \u2014 that's rare.` : meta.starterSeasons === 1 ? ' Flashed starter production in year one.' : ' Still developing.';
      const trendNote = trend >= 20 ? ` PPG up ${trend}% \u2014 breakout trajectory.` : '';
      blurb = _fwPick(_sd, [
        `${peakYrsLeft} peak years ahead at ${age}.${prodNote}${trendNote} Stock's rising.`,
        `Loads of runway \u2014 ${peakYrsLeft} peak years left at ${age}.${prodNote}${trendNote} This is the arrow-up profile.`,
      ]);
      blurbCol = _wr.green;
    } else if (peakYrsLeft >= 3) {
      const eliteNote = meta.sitMult >= 1.30 && age <= 25 ? ' Elite young producer \u2014 exactly what dynasty is about.' : '';
      const trendNote = trend >= 20 ? ` PPG up ${trend}% year-over-year.` : '';
      const proven = meta.starterSeasons>=3?meta.starterSeasons+'-year proven starter. ':'';
      blurb = _fwPick(_sd, [
        `Right in his prime with ${peakYrsLeft} peak years left. ${proven}${eliteNote}${trendNote}`,
        `Squarely in the window \u2014 ${peakYrsLeft} peak years to go. ${proven}${eliteNote}${trendNote}`,
      ]);
      blurbCol = _wr.green;
    } else if (peakYrsLeft >= 1) {
      const trendNote = trend <= -20 ? ` Production declining (${trend}%).` : '';
      const stillReliable = meta.starterSeasons>=3?' but still a reliable starter':'';
      blurb = _fwPick(_sd, [
        `${peakYrsLeft} peak year${peakYrsLeft>1?'s':''} left at ${age}. Window's closing${stillReliable}.${trendNote}`,
        `Getting late \u2014 ${peakYrsLeft} peak year${peakYrsLeft>1?'s':''} left at ${age}${stillReliable}.${trendNote}`,
      ]);
      blurbCol = _wr.amber;
    } else {
      blurb = _fwPick(_sd, [
        `Right at the edge of ${pos} peak at ${age}. Value tops out now \u2014 it only goes down from here.`,
        `He's at the ${pos} peak cliff at ${age}. This is about as high as the value gets.`,
      ]);
      blurbCol = _wr.amber;
    }

    if (gamesPlayed <= 8 && gamesPlayed > 0 && !blurb.includes('games')) blurb += ` Only ${gamesPlayed} games last season.`;

    if (blurb && insightEl) {
      const bg = blurbCol === _wr.red ? 'rgba(231,76,60,.08)' : blurbCol === _wr.green ? 'rgba(46,204,113,.08)' : 'rgba(212,175,55,.08)';
      insightEl.innerHTML = `<div style="font-size:13px;color:${blurbCol};line-height:1.45;padding:6px 10px;background:${bg};border-radius:6px;border-left:3px solid ${blurbCol}">${blurb}</div>`;
      // Dynasty Read AI upgrade (paid tier): swap the template for a live,
      // web-search news synthesis when available (shared weekly cache → usually an
      // instant hit). fetchDynastyRead returns '' when not entitled/unavailable, so
      // the template stands. Guarded so a slow response can't overwrite a different
      // (or closed) player's modal.
      if (typeof window.fetchDynastyRead === 'function') {
        const _readPid = pid;
        const _readCtx = {
          pid, name, team, pos, age: age || null,
          season: (window.S && window.S.nflState && window.S.nflState.season) || '',
          week: (window.S && window.S.nflState && (window.S.nflState.display_week || window.S.nflState.week)) || 0,
        };
        window.fetchDynastyRead(_readCtx, { fallback: '' }).then(function (txt) {
          if (!txt || window._fwModalOpenPid !== _readPid) return;
          const el = document.getElementById('fwpm-insight');
          if (!el || !el.isConnected) return;
          const esc = String(txt).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          el.innerHTML = `<div style="font-size:13px;color:${blurbCol};line-height:1.45;padding:6px 10px;background:${bg};border-radius:6px;border-left:3px solid ${blurbCol}">${esc}</div>`;
        });
      }
    } else if(insightEl) insightEl.innerHTML = '';
  } else if(insightEl) insightEl.innerHTML = '';

  // ── Bio ──
  const teamFull = (typeof fullTeam === 'function') ? fullTeam(team) : team;
  _fwSet('fwpm-bio','innerHTML',`${pos} \u00B7 ${teamFull} \u00B7 Age ${age || '?'} \u00B7 ${exp}yr exp${p.college ? ' \u00B7 '+p.college : ''}`);

  // ── Tags ──
  const tags = [];
  if (p.injury_status) tags.push(`<span style="background:rgba(231,76,60,.1);color:${_wr.red};font-size:13px;font-weight:700;padding:2px 8px;border-radius:20px">${p.injury_status}</span>`);
  if (fcRankData && fcRankData.pos) tags.push(`<span style="background:rgba(212,175,55,.1);color:${_wr.gold};font-size:13px;font-weight:700;padding:2px 8px;border-radius:20px">#${fcRankData.pos} ${pos}</span>`);
  // League position rank
  const S = window.App.S || window.S || {};
  if (S.rosters) {
    const myRoster = S.rosters?.find(r => r.owner_id === S.myUserId || (r.co_owners||[]).includes(S.myUserId));
    const posRank = _fwLeaguePosRank(pid, pos, S);
    const allRostered = [];
    if (posRank) {
      S.rosters.forEach(r => (r.players || []).forEach(p => { const m = window.App?.LI?.playerMeta?.[p]; if (m?.pos === pos && (window.App?.LI?.playerScores?.[p]||0) > 0) allRostered.push(p); }));
      tags.push(`<span style="background:rgba(46,204,113,.1);color:${_wr.green};font-size:13px;font-weight:700;padding:2px 8px;border-radius:20px" title="${posRank} of ${allRostered.length} rostered ${pos}s in league">${pos}${posRank}</span>`);
    }
  }
  if (p.height || p.weight) {
    const ht = p.height ? Math.floor(p.height/12)+"'"+(p.height%12)+'"' : '';
    const wt = p.weight ? p.weight+'lbs' : '';
    tags.push(`<span style="background:rgba(255,255,255,.04);color:${_wr.text3};font-size:13px;padding:2px 8px;border-radius:20px">${[ht,wt].filter(Boolean).join(' \u00B7 ')}</span>`);
  }
  _fwSet('fwpm-tags','innerHTML',tags.join(''));

  // ── Stats bar ──
  const curYear = parseInt(S.season) || new Date().getFullYear();
  const prevYr = String(curYear - 1).slice(2);
  const trendLabel = trend > 100 ? 'Rising' : trend < -100 ? 'Falling' : 'Stable';
  const trendCol = trend > 100 ? _wr.green : trend < -100 ? _wr.red : _wr.text3;

  let statBoxes;
  if (isIDP && rawStats) {
    const idpPts = _fwCalcPts(rawStats, sc);
    const gp = rawStats.gp || 17;
    const idpPPG = +(idpPts / Math.max(1, gp)).toFixed(1);
    const tkl = Math.round((rawStats.idp_tkl_solo||0) + (rawStats.idp_tkl_ast||0));
    const sacks = +(rawStats.idp_sack||0).toFixed(1);
    const ints = rawStats.idp_int || 0;
    const pds = rawStats.idp_pass_def || 0;
    statBoxes = [
      {val: val > 0 ? val.toLocaleString() : '\u2014', lbl: 'DHQ Value', col: tierCol},
      {val: fcRankData ? '#'+fcRankData.pos : '\u2014', lbl: 'Pos Rank', col: _wr.gold},
      {val: idpPPG || '\u2014', lbl: 'IDP PPG', col: idpPPG >= 6 ? _wr.green : idpPPG >= 3 ? _wr.text : _wr.text3},
      {val: tkl || '\u2014', lbl: 'Tackles', col: tkl >= 80 ? _wr.green : tkl >= 40 ? _wr.text : _wr.text3},
      {val: pos === 'DB' ? (ints+'/'+pds) : String(sacks), lbl: pos === 'DB' ? 'INT/PD' : 'Sacks', col: _wr.text},
    ];
  } else {
    statBoxes = [
      {val: val > 0 ? val.toLocaleString() : '\u2014', lbl: 'DHQ Value', col: tierCol},
      {val: fcRankData ? '#'+fcRankData.pos : '\u2014', lbl: 'Pos Rank', col: _wr.gold},
      {val: ppg ? ppg.toFixed(1) : '\u2014', lbl: `'${prevYr} PPG`, col: ppg > 15 ? _wr.green : ppg > 8 ? _wr.text : _wr.text3},
      {val: total ? Math.round(total) : '\u2014', lbl: `'${prevYr} Total`, col: _wr.text2},
      {val: trendLabel, lbl: '30d Trend', col: trendCol},
    ];
  }

  _fwSet('fwpm-stats','innerHTML',statBoxes.map(s =>
    `<div class="fwpm-stat-box">
      <div class="fwpm-stat-val" style="color:${s.col}">${s.val}</div>
      <div class="fwpm-stat-lbl">${s.lbl}</div>
    </div>`
  ).join(''));

  // ── Age curve ──
  const ages = Array.from({length: 17}, (_, i) => i + 20);
  _fwSet('fwpm-curve','innerHTML',ages.map(a => {
    const col = a < pk.lo-3 ? 'rgba(96,165,250,.3)' : a < pk.lo ? 'rgba(46,204,113,.45)' :
      (a >= pk.lo && a <= pk.hi) ? 'rgba(46,204,113,.75)' : a <= pk.hi+2 ? 'rgba(212,175,55,.45)' : 'rgba(231,76,60,.35)';
    return `<div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;cursor:default;background:${col};opacity:${a===age?1:0.55};outline:${a===age?'2px solid '+_wr.gold:'none'};outline-offset:-1px;color:${a===age?_wr.text:'transparent'}">${a===age?age:''}</div>`;
  }).join(''));
  _fwSet('fwpm-peak-tag','textContent',`Currently age ${age || '?'} \u00B7 ${pk.label} \u00B7 ${pk.desc}`);
  _fwSet('fwpm-curve-lbl','innerHTML',`<span>20</span><span>Peak ${pk.lo}\u2013${pk.hi}</span><span>36</span>`);

  // ── Trade value ──
  _fwSet('fwpm-val','textContent',val > 0 ? val.toLocaleString() : LI_LOADED ? '\u2014' : 'Loading...');
  _fwSet('fwpm-tier','innerHTML',val > 0
    ? `<span style="color:${tierCol}">${tier}</span>${fcRankData ? ' \u00B7 Overall #'+fcRankData.overall : ''}`
    : LI_LOADED ? `<span style="color:${_wr.text3}">No DHQ data</span>` : `<span style="color:${_wr.text3}">DHQ loading...</span>`);

  // ── Right panel: Trade Profile for ALL positions (unified layout) ──
  const rightPanel = document.getElementById('fwpm-right');
  if (rightPanel) {
    const tpTrend = trend >= 15 ? '+'+trend+'%' : trend <= -15 ? trend+'%' : 'Stable';
    const tpTrendCol = trend >= 15 ? _wr.green : trend <= -15 ? _wr.red : _wr.text3;
    const tpTitle = `<div style="font-size:13px;color:${_wr.text3};text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Trade Profile${isIDP ? ' <span style="font-size:13px;color:'+_wr.gold+';background:rgba(212,175,55,.1);padding:1px 5px;border-radius:4px;font-weight:700;vertical-align:middle;margin-left:4px">IDP</span>' : ''}</div>`;
    const tpRawLine = `<div style="font-size:13px;color:${_wr.text2};margin-top:4px;line-height:1.4">
        <span style="color:${tpTrendCol}">${tpTrend}</span> \u00B7 ${peakYrsLeft > 0 ? peakYrsLeft+' peak yr'+(peakYrsLeft>1?'s':'')+' left' : pk.desc || 'Past value window'}
      </div>`;

    if (_pmPro) {
      const pa = (typeof getPlayerAction === 'function') ? getPlayerAction(pid) : { label: 'Hold', col: _wr.gold, reason: '' };
      const recCol = pa.col || _wr.gold;
      rightPanel.innerHTML = `
      ${tpTitle}
      <div style="font-size:22px;font-weight:800;color:${recCol};font-family:'JetBrains Mono',monospace;letter-spacing:.02em">${pa.label}</div>
      ${tpRawLine}
      <div style="font-size:13px;color:${_wr.text3};margin-top:4px">${pa.reason}</div>`;
    } else {
      // Free: raw trend + age-window facts only \u2014 the Buy/Sell call is Pro.
      rightPanel.innerHTML = `
      ${tpTitle}
      ${tpRawLine}
      <div style="font-size:13px;color:${_wr.text3};margin-top:6px">\uD83D\uDD12 Buy/Sell verdict \u00B7 <span style="color:${_wr.gold};font-weight:700">Pro</span></div>`;
    }
  }

  // ── Career stats ──
  const careerEl = document.getElementById('fwpm-career');
  const titleEl = document.getElementById('fwpm-stats-title');

  // Show current-year stats immediately if available, then fetch career
  if (careerEl) {
    if (rawStats && Object.keys(rawStats).length > 1) {
      const quickData = {};
      quickData[curYear] = rawStats;
      if (stats.prevRawStats) quickData[curYear - 1] = stats.prevRawStats;
      if(titleEl)titleEl.textContent = 'Career Stats';
      careerEl.innerHTML = _fwBuildCareerTable(pid, quickData, pos, sc, p);
    } else {
      careerEl.innerHTML = `<div style="color:${_wr.text3};font-size:13px;padding:4px 0">Loading career stats...</div>`;
    }
  }

  // Fetch full career in background
  _fwFetchCareerStats(pid, curYear, exp).then(careerData => {
    if (Object.keys(careerData).length && careerEl) {
      const yrs = Object.keys(careerData).sort();
      if(titleEl)titleEl.textContent = yrs.length > 1
        ? `Career Stats \u00B7 '${String(yrs[0]).slice(-2)}\u2013'${String(yrs[yrs.length-1]).slice(-2)}`
        : `'${String(yrs[0]).slice(-2)} Season Stats`;
      careerEl.innerHTML = _fwBuildCareerTable(pid, careerData, pos, sc, p);
    }
  }).catch(() => {});

  // ── Actions ──
  const actionsEl = document.getElementById('fwpm-actions');
  if(actionsEl)actionsEl.innerHTML = `
    <a href="${_fwFPUrl(name)}" target="_blank" class="fwpm-btn">FantasyPros</a>
    <a href="https://sleeper.com/players/nfl/${pid}" target="_blank" class="fwpm-btn">Sleeper</a>`;

  // ── Show ──
  const modal = document.getElementById('fw-player-modal');
  if(modal)modal.style.display = 'flex';
}

// ── Helper: league position rank ────────────────────────────────
function _fwLeaguePosRank(pid, pos, S) {
  if (!S.rosters || !window.App.LI?.playerScores) return null;
  const scores = window.App.LI.playerScores;
  const meta = window.App.LI.playerMeta || {};
  const allRostered = [];
  S.rosters.forEach(r => (r.players || []).forEach(p => {
    if (meta[p]?.pos === pos && scores[p] > 0) allRostered.push({ pid: p, val: scores[p] });
  }));
  allRostered.sort((a, b) => b.val - a.val);
  const idx = allRostered.findIndex(x => x.pid === String(pid));
  return idx >= 0 ? idx + 1 : null;
}

// ── Close ──────────────────────────────────────────────────────
function closeFWPlayerModal() {
  const el = document.getElementById('fw-player-modal');
  if (el) el.style.display = 'none';
}

// ── Expose globally ────────────────────────────────────────────
window.openFWPlayerModal = openFWPlayerModal;
window.closeFWPlayerModal = closeFWPlayerModal;
window.fwFetchCareerStats = _fwFetchCareerStats;
window.fwBuildCareerTable = _fwBuildCareerTable;
window.fwCalcPts = _fwCalcPts;
window.App.openFWPlayerModal = openFWPlayerModal;
window.App.closeFWPlayerModal = closeFWPlayerModal;
window.App.fwFetchCareerStats = _fwFetchCareerStats;
window.App.fwBuildCareerTable = _fwBuildCareerTable;
window.App.fwCalcPts = _fwCalcPts;
