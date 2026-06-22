// ══════════════════════════════════════════════════════════════════
// shared/constants.js — Dynasty HQ shared constants
// ══════════════════════════════════════════════════════════════════

window.App = window.App || {};

// Version for cache invalidation — bump on deploy
window.App.VERSION = '2026.04.02';

// Tier thresholds (healthScore-based)
window.App.TIER_THRESHOLDS = { ELITE: 90, CONTENDER: 80, CROSSROADS: 70 };

// Position colors (used across both apps)
window.App.POS_COLORS = {QB:'#E74C3C',RB:'#2ECC71',WR:'#3498DB',TE:'#F0A500',K:'#9B59B6',DEF:'#85929E',DL:'#E67E22',LB:'#1ABC9C',DB:'#E91E63'};

window.App.posMap={QB:'QB',RB:'RB',WR:'WR',TE:'TE',FLEX:'FLEX',SUPER_FLEX:'SF',K:'K',DEF:'DEF',DST:'DEF','D/ST':'DEF',BN:'BN',IDP_FLEX:'IDP',DL:'DL',LB:'LB',DB:'DB',REC_FLEX:'FLEX',WR_RB_FLEX:'FLEX',WR_TE:'FLEX'};

window.App.posClass=s=>{const p=window.App.posMap[s]||s||'FLEX';return{QB:'pQB',RB:'pRB',WR:'pWR',TE:'pTE',K:'pK',DEF:'pDEF',FLEX:'pFLEX',SF:'pSF',BN:'pBN',DL:'pDL',LB:'pLB',DB:'pDB',IDP:'pIDP'}[p]||'pFLEX'};

// Expose as bare globals for modules that reference them without namespace
window.posMap = window.App.posMap;
window.posClass = window.App.posClass;

window.App.NFL_TEAMS={
  ARI:'Arizona Cardinals',ATL:'Atlanta Falcons',BAL:'Baltimore Ravens',BUF:'Buffalo Bills',
  CAR:'Carolina Panthers',CHI:'Chicago Bears',CIN:'Cincinnati Bengals',CLE:'Cleveland Browns',
  DAL:'Dallas Cowboys',DEN:'Denver Broncos',DET:'Detroit Lions',GB:'Green Bay Packers',
  HOU:'Houston Texans',IND:'Indianapolis Colts',JAX:'Jacksonville Jaguars',KC:'Kansas City Chiefs',
  LAC:'Los Angeles Chargers',LAR:'Los Angeles Rams',LV:'Las Vegas Raiders',MIA:'Miami Dolphins',
  MIN:'Minnesota Vikings',NE:'New England Patriots',NO:'New Orleans Saints',NYG:'New York Giants',
  NYJ:'New York Jets',PHI:'Philadelphia Eagles',PIT:'Pittsburgh Steelers',SEA:'Seattle Seahawks',
  SF:'San Francisco 49ers',TB:'Tampa Bay Buccaneers',TEN:'Tennessee Titans',WAS:'Washington Commanders',
  FA:'Free Agent'
};

window.App.fullTeam=abbr=>window.App.NFL_TEAMS[abbr]||abbr||'FA';
window.NFL_TEAMS = window.App.NFL_TEAMS;
window.fullTeam = window.App.fullTeam;

// AI-sourced peak age curves - loaded async, with research-backed defaults
window.App.PEAK_CURVES={
  QB:{lo:28,hi:34,src:'default'},RB:{lo:23,hi:25,src:'default'},
  WR:{lo:25,hi:28,src:'default'},TE:{lo:26,hi:29,src:'default'},
  EDGE:{lo:25,hi:29,src:'default'},DT:{lo:25,hi:29,src:'default'},
  LB:{lo:24,hi:28,src:'default'},CB:{lo:24,hi:27,src:'default'},
  S:{lo:24,hi:27,src:'default'},K:{lo:28,hi:35,src:'default'},
};

// Age curves: build-up, elite peak, and still-valuable decline bands.
window.App.ageCurveWindows={
  QB:{build:[23,27],peak:[28,34],decline:[35,38]},
  RB:{build:[21,22],peak:[23,25],decline:[26,28]},
  WR:{build:[22,24],peak:[25,28],decline:[29,31]},
  TE:{build:[23,25],peak:[26,29],decline:[30,32]},
  DL:{build:[22,24],peak:[25,29],decline:[30,32]},
  EDGE:{build:[22,24],peak:[25,29],decline:[30,32]},
  LB:{build:[22,23],peak:[24,28],decline:[29,31]},
  DB:{build:[21,23],peak:[24,27],decline:[28,30]},
  K:{build:[23,27],peak:[28,35],decline:[36,40]},
};

// Peak windows are the elite portion of the curve. Use ageCurveWindows when
// the consumer needs build-up or decline-band context.
window.App.peakWindows=Object.fromEntries(
  Object.entries(window.App.ageCurveWindows).map(([pos,curve])=>[pos,curve.peak])
);

// Position-specific decay rates after the valuable decline band.
window.App.decayRates={QB:0.12,RB:0.22,WR:0.18,TE:0.16,K:0.08,DL:0.15,EDGE:0.15,LB:0.16,DB:0.18};

// ── Draft pick values ──────────────────────────────────────────
// Standard dynasty pick values (approximate DLF/KTC scale)
window.App.BASE_PICK_VALUES={
  '1.01':10050,'1.02':9150,'1.03':8350,'1.04':7600,'1.05':6900,
  '1.06':6250,'1.07':5700,'1.08':5250,'1.09':4800,'1.10':4450,
  '1.11':4150,'1.12':3800,
  '2.01':4650,'2.02':4350,'2.03':4050,'2.04':3750,'2.05':3450,
  '2.06':3150,'2.07':2950,'2.08':2700,'2.09':2500,'2.10':2250,
  '2.11':2100,'2.12':1950,
  '3.01':2650,'3.02':2400,'3.03':2200,'3.04':2000,'3.05':1800,
  '3.06':1650,'3.07':1500,'3.08':1350,'3.09':1250,'3.10':1100,
  '3.11':1000,'3.12':925,
  '4.01':1300,'4.02':1200,'4.03':1100,'4.04':1000,'4.05':925,
  '4.06':850,'4.07':775,'4.08':725,'4.09':675,'4.10':600,
  '4.11':550,'4.12':500,
  '5.01':700,'5.02':650,'5.03':600,'5.04':550,'5.05':500,
  '5.06':450,'5.07':400,'5.08':350,'5.09':325,'5.10':300,
  '5.11':275,'5.12':250,
};

// ── Player Value — DHQ Primary ───────────────────────────────
window.App.tradeValueTier=function(val){
  if(val>=7000)return{tier:'Elite',col:'var(--green)'};
  if(val>=4000)return{tier:'Starter',col:'var(--accent)'};
  if(val>=2000)return{tier:'Depth',col:'var(--text2)'};
  if(val>0)return{tier:'Stash',col:'var(--text3)'};
  return{tier:'—',col:'var(--text3)'};
};
window.tradeValueTier = window.App.tradeValueTier;
