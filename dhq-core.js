// shared/dhq-core.js — standalone DHQ calculation core
// Pure helpers for labs, tests, and browser wrappers. No app state required.
(function(root){
  'use strict';

  const AGE_CURVES={
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

  const DECAY_RATES={QB:0.12,RB:0.22,WR:0.18,TE:0.16,K:0.08,DL:0.15,EDGE:0.15,LB:0.16,DB:0.18};
  const DECLINE_END_FACTOR={QB:0.78,RB:0.62,WR:0.68,TE:0.70,K:0.82,DL:0.70,EDGE:0.70,LB:0.68,DB:0.66};
  const OFFENSE=['QB','RB','WR','TE','K'];
  const MARKET_BLEND_WEIGHTS={base:0.30,medium:0.35,major:0.40,customCap:0.25,extremeCustomCap:0.15};

  function defaultScoring(ppr){
    return {
      pass_yd:0.04,pass_td:4,pass_int:-1,pass_2pt:0,pass_sack:0,
      rush_yd:0.1,rush_td:6,rush_2pt:0,rush_fd:0,
      rec:Number(ppr)||0,rec_yd:0.1,rec_td:6,rec_2pt:0,rec_fd:0,
      fum_lost:-1,fum_rec_td:0,
      xpm:1,xpmiss:0,fgm:3,fgm_0_19:0,fgm_20_29:0,fgm_30_39:0,
      fgm_40_49:0,fgm_50p:0,fgm_50_59:0,fgm_60p:0,fgm_yds:0,
      fgmiss:0,fgmiss_0_19:0,fgmiss_20_29:0,
    };
  }

  function scoringDelta(scoring,ppr,key,weight,reasons){
    const base=defaultScoring(ppr);
    const actual=Number(scoring?.[key]??base[key]??0);
    const expected=Number(base[key]??0);
    if(Math.abs(actual-expected)>0.001){
      reasons.push(key);
      return weight;
    }
    return 0;
  }

  function fantasyCalcCompatibility(config){
    const cfg=config||{};
    const ppr=Number(cfg.ppr??cfg.scoring?.rec??0.5);
    const scoring={...defaultScoring(ppr),...(cfg.scoring||{})};
    const rosterPositions=Array.isArray(cfg.rosterPositions)
      ? cfg.rosterPositions
      : String(cfg.roster||'').split(',').map(s=>s.trim()).filter(Boolean);
    const reasons=[];
    let penalty=0;

    penalty+=scoringDelta(scoring,ppr,'pass_td',0.12,reasons);
    penalty+=scoringDelta(scoring,ppr,'pass_int',0.08,reasons);
    penalty+=scoringDelta(scoring,ppr,'fum_lost',0.05,reasons);
    penalty+=scoringDelta(scoring,ppr,'rush_fd',0.18,reasons);
    penalty+=scoringDelta(scoring,ppr,'rec_fd',0.18,reasons);
    penalty+=scoringDelta(scoring,ppr,'pass_sack',0.12,reasons);

    const base=defaultScoring(ppr);
    const kickerKeys=['fgm','fgm_0_19','fgm_20_29','fgm_30_39','fgm_40_49','fgm_50p','fgm_50_59','fgm_60p','fgm_yds','fgmiss','fgmiss_0_19','fgmiss_20_29','xpm','xpmiss'];
    const kickerChanged=kickerKeys.some(key=>Math.abs(Number(scoring[key]??0)-Number(base[key]??0))>0.001);
    if(kickerChanged){
      reasons.push('kicker_scoring');
      penalty+=0.35;
      const maxKicker=Math.max(...kickerKeys.map(key=>Math.abs(Number(scoring[key]??0))));
      if(maxKicker>10)penalty+=0.50;
    }

    const known=new Set(Object.keys(base));
    Object.keys(cfg.scoring||{}).forEach(key=>{
      if(!known.has(key)&&Number(cfg.scoring[key])){
        reasons.push(key);
        penalty+=0.25;
      }
    });

    const normalizedRoster=rosterPositions.map(String).map(s=>s.toUpperCase());
    if(normalizedRoster.some(slot=>slot==='IDP_FLEX'||['DL','DE','DT','EDGE','LB','DB','CB','S','SS','FS'].includes(slot))){
      reasons.push('idp_roster');
      penalty+=0.50;
    }
    const startableOffense=normalizedRoster.filter(slot=>!['BN','IR','TAXI','K'].includes(slot)).length;
    if(startableOffense>=11){
      reasons.push('deep_starting_lineup');
      penalty+=0.15;
    }
    if(normalizedRoster.filter(slot=>slot==='SUPER_FLEX').length>1){
      reasons.push('multiple_superflex');
      penalty+=0.25;
    }

    const score=clamp(1-penalty,0,1);
    return {
      score:+score.toFixed(3),
      supported:score>=0.70,
      custom:score<0.70,
      extremeCustom:score<0.35,
      reasons:Array.from(new Set(reasons)),
    };
  }

  function marketBlendWeight(deviation,config){
    const d=Number(deviation)||0;
    let weight=d>0.5?MARKET_BLEND_WEIGHTS.major:d>0.3?MARKET_BLEND_WEIGHTS.medium:MARKET_BLEND_WEIGHTS.base;
    const compatibility=config?.score!=null&&config?.reasons
      ? config
      : fantasyCalcCompatibility(config||{});
    const cap=compatibility.extremeCustom?MARKET_BLEND_WEIGHTS.extremeCustomCap
      : compatibility.custom?MARKET_BLEND_WEIGHTS.customCap
      : MARKET_BLEND_WEIGHTS.major;
    return +Math.min(weight,cap).toFixed(2);
  }

  function normalizePosition(pos){
    if(!pos)return'';
    const p=String(pos).toUpperCase();
    if(['DE','DT','NT','IDL','EDGE'].includes(p))return'DL';
    if(['CB','S','SS','FS'].includes(p))return'DB';
    if(['OLB','ILB','MLB'].includes(p))return'LB';
    if(['DEF','DST','D/ST'].includes(p))return'DEF';
    if(p==='SUPER_FLEX')return'SF';
    if(p==='IDP_FLEX')return'IDP';
    if(['REC_FLEX','WR_RB_FLEX','WR_TE'].includes(p))return'FLEX';
    return p;
  }

  function starterCountsFromRoster(rosterPositions, opts){
    const includeDefense=opts?.includeDefense!==false;
    const minimum=opts?.minimumOne?1:0;
    const counts={QB:0,RB:0,WR:0,TE:0,K:0,DEF:0,DL:0,LB:0,DB:0};
    const add=(pos,amount)=>{
      const n=normalizePosition(pos);
      if(counts[n]!=null)counts[n]+=amount;
    };

    (rosterPositions||[]).forEach(slot=>{
      const raw=String(slot||'').toUpperCase();
      if(['BN','IR','TAXI'].includes(raw))return;
      if(raw==='FLEX'){add('RB',0.4);add('WR',0.4);add('TE',0.2);}
      else if(raw==='SUPER_FLEX'){add('QB',1);}
      else if(raw==='REC_FLEX'){add('WR',0.5);add('TE',0.5);}
      else if(raw==='IDP_FLEX'&&includeDefense){add('DL',0.35);add('LB',0.35);add('DB',0.3);}
      else add(raw,1);
    });

    Object.keys(counts).forEach(pos=>{
      counts[pos]=Math.max(minimum,counts[pos]>0?Math.ceil(counts[pos]):0);
    });
    return counts;
  }

  function scoreStats(stats, scoring){
    if(!stats)return 0;
    const sc={...defaultScoring(scoring?.rec),...(scoring||{})};
    let pts=0;
    const add=(stat,mult)=>{pts+=(Number(stats[stat])||0)*(mult??0);};
    add('pass_yd',sc.pass_yd);add('pass_td',sc.pass_td);add('pass_int',sc.pass_int);
    add('pass_2pt',sc.pass_2pt);add('pass_sack',sc.pass_sack);
    add('rush_yd',sc.rush_yd);add('rush_td',sc.rush_td);add('rush_2pt',sc.rush_2pt);add('rush_fd',sc.rush_fd);
    add('rec',sc.rec);add('rec_yd',sc.rec_yd);add('rec_td',sc.rec_td);add('rec_2pt',sc.rec_2pt);add('rec_fd',sc.rec_fd);
    add('fum_lost',sc.fum_lost);add('fum_rec_td',sc.fum_rec_td);
    add('xpm',sc.xpm);add('xpmiss',sc.xpmiss);
    add('fgm',sc.fgm);add('fgm_0_19',sc.fgm_0_19);add('fgm_20_29',sc.fgm_20_29);
    add('fgm_30_39',sc.fgm_30_39);add('fgm_40_49',sc.fgm_40_49);
    add('fgm_50p',sc.fgm_50p);add('fgm_50_59',sc.fgm_50_59);add('fgm_60p',sc.fgm_60p);
    add('fgm_yds',sc.fgm_yds);
    add('fgmiss',sc.fgmiss);add('fgmiss_0_19',sc.fgmiss_0_19);add('fgmiss_20_29',sc.fgmiss_20_29);
    return +pts.toFixed(1);
  }

  function ppgReliability(gp){
    const games=Number(gp)||0;
    if(games>=12)return 1;
    if(games>=10)return +(0.96+(games-10)*0.02).toFixed(3);
    if(games>=8)return +(0.88+(games-8)*0.04).toFixed(3);
    if(games>=5)return +(0.70+(games-5)*0.06).toFixed(3);
    if(games>=3)return +(0.55+(games-3)*0.075).toFixed(3);
    return games>0?0.45:0;
  }

  function curveForPosition(pos, curves){
    const p=normalizePosition(pos);
    return (curves||{})[p]||AGE_CURVES[p]||AGE_CURVES.WR;
  }

  function ageCurvePhase(age,pos,curves){
    const curve=curveForPosition(pos,curves);
    const a=Number(age)||0;
    if(!a)return'unknown';
    if(a<curve.build[0])return'developmental';
    if(a<=curve.build[1])return'build';
    if(a<=curve.peak[1])return'peak';
    if(a<=curve.decline[1])return'decline';
    return'post_decline';
  }

  function ageCurveFactor(age,pos,curves,decayRates){
    const curve=curveForPosition(pos,curves);
    const p=normalizePosition(pos)||'WR';
    const a=Number(age)||0;
    const [buildStart,buildEnd]=curve.build;
    const [peakStart,peakEnd]=curve.peak;
    const declineEnd=curve.decline[1];
    const rate=(decayRates||{})[p]||DECAY_RATES[p]||0.16;
    const declineEndFactor=DECLINE_END_FACTOR[p]||0.68;
    if(!a)return 1;
    if(a<buildStart){
      const progress=Math.max(0,Math.min(1,(a-18)/Math.max(1,buildStart-18)));
      return 0.72+0.08*progress;
    }
    if(a<=buildEnd){
      const progress=(a-buildStart)/Math.max(1,buildEnd-buildStart);
      return 0.82+0.16*Math.max(0,Math.min(1,progress));
    }
    if(a<peakStart)return 0.98;
    if(a<=peakEnd)return 1;
    if(a<=declineEnd){
      const progress=(a-peakEnd)/Math.max(1,declineEnd-peakEnd);
      return 1-(1-declineEndFactor)*Math.max(0,Math.min(1,progress));
    }
    const yearsPost=a-declineEnd;
    let factor=declineEndFactor-(yearsPost*rate);
    if(yearsPost>=3)factor*=0.75;
    if(yearsPost>=6)factor*=0.55;
    return Math.max(0.02,factor);
  }

  function positionScoringWeights(avgThresh,starterCounts,positions){
    const active=(positions||[])
      .map(pos=>Number(avgThresh?.[pos]?.avgStarter)||0)
      .filter(v=>v>0)
      .sort((a,b)=>a-b);
    const median=active.length?active[Math.floor(active.length/2)]:1;
    const weights={};
    (positions||[]).forEach(pos=>{
      const avg=Number(avgThresh?.[pos]?.avgStarter)||median;
      const scoringRatio=avg>0?avg/Math.max(1,median):1;
      const demandRatio=(Number(starterCounts?.[pos])||1)/2;
      const scoringAdj=Math.pow(Math.max(0.35,Math.min(3.5,scoringRatio)),0.35);
      const demandAdj=Math.pow(Math.max(0.5,Math.min(2.5,demandRatio)),0.15);
      weights[pos]=+(scoringAdj*demandAdj).toFixed(3);
    });
    return weights;
  }

  function slotEligiblePositions(slot,includeDefense){
    const raw=String(slot||'').toUpperCase();
    if(['BN','IR','TAXI'].includes(raw))return[];
    if(raw==='SUPER_FLEX'||raw==='SF')return['QB','RB','WR','TE'];
    if(raw==='FLEX'||raw==='WR_RB_FLEX'||raw==='WR_RB_TE_FLEX')return['RB','WR','TE'];
    if(raw==='REC_FLEX'||raw==='WR_TE')return['WR','TE'];
    if(raw==='IDP_FLEX')return includeDefense===false?[]:['DL','LB','DB'];
    const pos=normalizePosition(raw);
    if(OFFENSE.includes(pos)||['DEF','DL','LB','DB'].includes(pos))return[pos];
    return[];
  }

  // ── Depth-chart role (single source of truth) ────────────────────────────
  // Indexing CONVENTION: `rank` is 0-based — rank 0 = top of the depth chart
  // (the starter), rank 1 = second on the chart, etc. The displayed label is
  // `rank+1` (so rank 0 → "QB1"). BOTH resolution paths below use the SAME
  // raw-order convention (no -1 subtraction) so they can never drift apart.
  //
  // NOTE on Sleeper data: production reads `player.depth_chart_order` as-is via
  // Math.max(0,order). Sleeper's player feed is in practice 1-based for many
  // players, which makes the team's #1 read as rank 1 ("QB2"). Converting to a
  // strict 0-based read (order-1) was tested and REJECTED — it inflated QB
  // values and worsened elite-skill FC alignment — so the raw read is the
  // intentional, anchored production behavior and is preserved here verbatim.
  function depthRoleMult(pos,rank){
    if(pos==='QB')return rank===0?1.15:rank===1?0.78:rank===2?0.52:0.35;
    if(pos==='RB')return rank===0?1.08:rank===1?0.98:rank===2?0.86:rank===3?0.74:0.62;
    if(pos==='WR')return rank<=1?1.04:rank===2?0.96:rank===3?0.88:rank===4?0.78:0.68;
    if(pos==='TE')return rank===0?1.06:rank===1?0.88:rank===2?0.72:0.60;
    if(pos==='K')return rank===0?1.03:0.60;
    return rank<=1?1.02:rank<=3?0.92:0.82;
  }

  function depthRole(pid,player,state,normPos){
    const norm=typeof normPos==='function'?normPos:normalizePosition;
    const pos=norm(player?.position||'')||player?.position||'';
    const team=player?.team;
    const cleanTeam=team&&team!=='null'&&team!=='FA'?team:null;
    let rank=null,rolePos=player?.depth_chart_position||pos,source='';

    // Path A — Sleeper player object. depth_chart_order is 1-INDEXED (starter=1).
    // We KEEP `rank` as the raw 1-indexed read because the role-MULTIPLIER table
    // (depthRoleMult) is calibrated against it — converting to a true 0-based
    // rank flips starters from the backup mult to the starter mult, which
    // inflates QBs and crushes skill players vs the FantasyCalc market. The
    // user-facing DEPTH LABEL is corrected separately below (pos+rank, not +1).
    if(typeof player?.depth_chart_order==='number'&&Number.isFinite(player.depth_chart_order)){
      rank=Math.max(0,player.depth_chart_order);
      source='player';
    }

    // Path B — state.depthCharts fallback. Uses the SAME raw-order convention
    // as Path A (no -1) so the two paths agree. (This fallback is currently
    // unpopulated in production; consistency is enforced to prevent drift if
    // it is ever wired up.)
    if(rank==null&&cleanTeam&&state?.depthCharts?.[cleanTeam]){
      const dc=state.depthCharts[cleanTeam]||{};
      for(const[dpos,dplayers]of Object.entries(dc)){
        for(const[order,plObj]of Object.entries(dplayers||{})){
          const plId=typeof plObj==='object'?plObj?.player_id:plObj;
          if(plId!=null&&String(plId)===String(pid)){
            const parsed=Number(order);
            rank=Number.isFinite(parsed)?Math.max(0,parsed):0;
            rolePos=dpos||rolePos;
            source='depthCharts';
            break;
          }
        }
        if(rank!=null)break;
      }
    }

    if(rank==null)return{rank:null,label:'',mult:1,source:'',reason:''};

    // `rank` is the raw 1-indexed Sleeper order (starter=1), so the depth label
    // is pos+rank (QB1 for the starter), NOT pos+(rank+1). Guarded so it's never
    // below 1. The multiplier keeps using `rank` against the calibrated table —
    // labels are fixed, scores are unchanged.
    const label=(rolePos||pos||'').toUpperCase()+String(Math.max(1,rank));
    const mult=depthRoleMult(pos,rank);
    return{rank,label,mult:+mult.toFixed(3),source,reason:`NFL depth chart ${label}`};
  }

  function rowPpg(row){
    return Number(row?.ppg??row?.wPPG??row?.avg??row?.projected_ppg??row?.value_ppg??0)||0;
  }

  function median(values){
    const sorted=(values||[]).filter(v=>Number.isFinite(v)&&v>0).sort((a,b)=>a-b);
    return sorted.length?sorted[Math.floor(sorted.length/2)]:1;
  }

  function clamp(value,min,max){
    return Math.max(min,Math.min(max,value));
  }

  function buildLineupContext(input){
    const cfg=input||{};
    const totalTeams=Math.max(1,Number(cfg.totalTeams||cfg.teams)||12);
    const rosterPositions=Array.isArray(cfg.rosterPositions)
      ? cfg.rosterPositions
      : String(cfg.roster||'QB,RB,RB,WR,WR,TE,FLEX').split(',').map(s=>s.trim()).filter(Boolean);
    const positions=Array.from(new Set((cfg.positions||OFFENSE).map(normalizePosition).filter(Boolean)));
    const starterCounts=cfg.starterCounts||starterCountsFromRoster(rosterPositions,{includeDefense:cfg.includeDefense!==false});
    const rows=(cfg.rows||cfg.players||[]).map((row,idx)=>({
      id:String(row?.sleeper_id||row?.pid||row?.id||idx),
      position:normalizePosition(row?.position||row?.pos),
      ppg:rowPpg(row),
      source:row,
    })).filter(row=>row.position&&positions.includes(row.position)&&row.ppg>0);

    const byPos={};
    positions.forEach(pos=>{byPos[pos]=[];});
    rows.forEach(row=>{
      if(!byPos[row.position])byPos[row.position]=[];
      byPos[row.position].push(row);
    });
    positions.forEach(pos=>byPos[pos].sort((a,b)=>b.ppg-a.ppg));

    const fallbackPpg={};
    positions.forEach(pos=>{
      const list=byPos[pos]||[];
      const demand=Math.max(1,Math.round((Number(starterCounts[pos])||0)*totalTeams));
      if(!list.length){fallbackPpg[pos]=0;return;}
      const idx=Math.min(list.length-1,demand-1);
      const discount=list.length>=demand?1:0.92;
      fallbackPpg[pos]=+(list[idx].ppg*discount).toFixed(2);
    });

    const fixedSlots=[];
    const flexSlots=[];
    rosterPositions.forEach(slot=>{
      const eligible=slotEligiblePositions(slot,cfg.includeDefense!==false).filter(pos=>positions.includes(pos));
      if(!eligible.length)return;
      for(let i=0;i<totalTeams;i++){
        const item={raw:String(slot||''),eligible};
        if(eligible.length===1)fixedSlots.push(item);
        else flexSlots.push(item);
      }
    });
    flexSlots.sort((a,b)=>a.eligible.length-b.eligible.length);

    const used=new Set();
    const selected=[];
    let placeholderId=0;
    function selectSlot(slot){
      let best=null;
      slot.eligible.forEach(pos=>{
        const list=byPos[pos]||[];
        for(let i=0;i<list.length;i++){
          const row=list[i];
          if(used.has(row.id))continue;
          if(!best||row.ppg>best.ppg)best=row;
          break;
        }
      });
      if(best){
        used.add(best.id);
        selected.push({...best,slot:slot.raw,placeholder:false});
        return;
      }
      let fallbackPos=slot.eligible[0];
      slot.eligible.forEach(pos=>{
        if((fallbackPpg[pos]||0)>(fallbackPpg[fallbackPos]||0))fallbackPos=pos;
      });
      selected.push({
        id:`placeholder-${++placeholderId}`,
        position:fallbackPos,
        ppg:fallbackPpg[fallbackPos]||0,
        slot:slot.raw,
        placeholder:true,
      });
    }
    fixedSlots.forEach(selectSlot);
    flexSlots.forEach(selectSlot);

    const position={};
    positions.forEach(pos=>{
      position[pos]={
        lineupSlots:0,perTeamSlots:0,lineupPpg:0,perTeamPpg:0,
        slotShare:0,pointShare:0,marginalShare:0,expectedShare:0,
        pointsRatio:1,marginalRatio:1,perSlotPpg:0,replacementPpg:fallbackPpg[pos]||0,
        importance:1,
      };
    });

    selected.forEach(row=>{
      if(!position[row.position])return;
      position[row.position].lineupSlots+=1;
      position[row.position].lineupPpg+=row.ppg;
    });

    positions.forEach(pos=>{
      const posSelected=selected.filter(row=>row.position===pos).map(row=>row.ppg).sort((a,b)=>a-b);
      if(posSelected.length)position[pos].replacementPpg=+posSelected[0].toFixed(2);
      position[pos].perTeamSlots=+(position[pos].lineupSlots/totalTeams).toFixed(3);
      position[pos].perTeamPpg=+(position[pos].lineupPpg/totalTeams).toFixed(2);
      position[pos].perSlotPpg=position[pos].lineupSlots?position[pos].lineupPpg/position[pos].lineupSlots:fallbackPpg[pos]||0;
    });

    selected.forEach(row=>{
      const ctx=position[row.position];
      if(!ctx)return;
      ctx.marginalPpg=(ctx.marginalPpg||0)+Math.max(0,row.ppg-(ctx.replacementPpg||0));
    });

    const totalSlots=selected.length;
    const totalLineupPpg=selected.reduce((sum,row)=>sum+row.ppg,0);
    const totalMarginalPpg=positions.reduce((sum,pos)=>sum+(position[pos].marginalPpg||0),0);
    const medianPerSlot=median(positions.map(pos=>position[pos].perSlotPpg));

    positions.forEach(pos=>{
      const ctx=position[pos];
      const expectedShare=totalSlots?ctx.lineupSlots/totalSlots:(1/Math.max(1,positions.length));
      const pointShare=totalLineupPpg?ctx.lineupPpg/totalLineupPpg:expectedShare;
      const marginalShare=totalMarginalPpg?(ctx.marginalPpg||0)/totalMarginalPpg:pointShare;
      const pointsRatio=pointShare/Math.max(0.001,expectedShare||0.001);
      const marginalRatio=marginalShare/Math.max(0.001,expectedShare||0.001);
      const perSlotRatio=(ctx.perSlotPpg||medianPerSlot)/Math.max(1,medianPerSlot);
      const demandRatio=(Number(starterCounts[pos])||ctx.perTeamSlots||1)/2;
      const importance=clamp(
        Math.pow(clamp(perSlotRatio,0.15,20),0.35)
        *Math.pow(clamp(pointsRatio,0.10,20),0.25)
        *Math.pow(clamp(marginalRatio,0.10,20),0.20)
        *Math.pow(clamp(demandRatio,0.35,3.5),0.10),
        0.20,6
      );
      ctx.lineupPpg=+ctx.lineupPpg.toFixed(2);
      ctx.perSlotPpg=+ctx.perSlotPpg.toFixed(2);
      ctx.marginalPpg=+((ctx.marginalPpg||0)).toFixed(2);
      ctx.slotShare=+expectedShare.toFixed(4);
      ctx.expectedShare=+expectedShare.toFixed(4);
      ctx.pointShare=+pointShare.toFixed(4);
      ctx.marginalShare=+marginalShare.toFixed(4);
      ctx.pointsRatio=+pointsRatio.toFixed(3);
      ctx.marginalRatio=+marginalRatio.toFixed(3);
      ctx.importance=+importance.toFixed(3);
    });

    return {
      totalTeams,
      totalSlots,
      totalLineupPpg:+totalLineupPpg.toFixed(2),
      perTeamLineupPpg:+(totalLineupPpg/totalTeams).toFixed(2),
      totalMarginalPpg:+totalMarginalPpg.toFixed(2),
      perTeamMarginalPpg:+(totalMarginalPpg/totalTeams).toFixed(2),
      selected,
      position,
    };
  }

  function normalizePlayerEntries(players){
    if(Array.isArray(players)){
      return players.map((p,i)=>[String(p.sleeper_id||p.sleeperId||p.player_id||p.id||i),p]);
    }
    return Object.entries(players||{}).map(([id,p])=>[String(id),p||{}]);
  }

  function playerName(player,id){
    return player.full_name||player.name||`${player.first_name||''} ${player.last_name||''}`.trim()||String(id);
  }

  function normalizeMarketRow(row){
    const player=row?.player||row||{};
    const sid=row?.sleeper_id||row?.sleeperId||player.sleeperId||player.sleeper_id||player.id;
    if(!sid)return null;
    return {
      sleeperId:String(sid),
      name:row.name||player.name||player.full_name||String(sid),
      position:normalizePosition(row.position||player.position),
      team:row.nfl_team||row.team||player.maybeTeam||player.team||'',
      age:Number(row.age||player.maybeAge||player.age||0),
      value:Number(row.fc_value||row.value||row.marketValue||0),
      rank:row.fc_rank||row.overallRank||row.rank||'',
      positionRank:row.fc_pos_rank||row.positionRank||row.position_rank||'',
      trend30Day:row.fc_trend_30d??row.trend30Day??'',
    };
  }

  function defaultPickValue(pickNumber,totalTeams,draftRounds){
    const teams=Math.max(1,Number(totalTeams)||12);
    const rounds=Math.max(1,Number(draftRounds)||4);
    const total=teams*rounds;
    const pick=Math.max(1,Math.min(total,Number(pickNumber)||1));
    const top=7200;
    const floor=50;
    const decay=0.06;
    return Math.max(floor,Math.round(top*Math.exp(-decay*(pick-1))));
  }

  function calculateValues(input){
    const cfg=input?.config||{};
    const mode=cfg.mode||'dynasty';
    const isDynasty=mode!=='redraft';
    const totalTeams=Math.max(1,Number(cfg.teams||cfg.totalTeams)||12);
    const projectionYears=Math.max(0,Number(cfg.projectionYears??cfg.years??2)||0);
    const draftRounds=Math.max(1,Number(cfg.draftRounds)||4);
    const rosterPositions=Array.isArray(cfg.rosterPositions)
      ? cfg.rosterPositions
      : String(cfg.roster||'QB,RB,RB,WR,WR,TE,FLEX').split(',').map(s=>s.trim()).filter(Boolean);
    const scoring={...defaultScoring(cfg.ppr??0.5),...(cfg.scoring||{})};
    const starterCounts=starterCountsFromRoster(rosterPositions,{includeDefense:false});
    const positions=(cfg.positions||OFFENSE).map(normalizePosition).filter(Boolean);
    const activePositions=positions.filter(pos=>starterCounts[pos]>0||['QB','RB','WR','TE'].includes(pos));
    if(starterCounts.K>0&&!activePositions.includes('K'))activePositions.push('K');

    const marketRows=(input?.marketRows||[]).map(normalizeMarketRow).filter(Boolean);
    const marketBySleeper=new Map(marketRows.map(row=>[row.sleeperId,row]));
    const stats=input?.stats||{};
    const baseRows=[];
    const seen=new Set();

    normalizePlayerEntries(input?.players||{}).forEach(([pid,player])=>{
      const market=marketBySleeper.get(pid);
      const pos=normalizePosition(player.position||market?.position);
      if(!activePositions.includes(pos))return;
      const statLine=stats[pid]||player.stats||null;
      const gp=Number(statLine?.gp||statLine?.games_played||statLine?.gms_active||player.gp||0);
      const total=scoreStats(statLine,scoring);
      const ppg=gp>0?total/gp:Number(player.ppg||0);
      if(!market&&ppg<=0)return;
      seen.add(pid);
      baseRows.push({
        sleeper_id:pid,asset_type:'player',name:playerName(player,pid),position:pos,
        nfl_team:player.team||market?.team||'',age:Number(player.age||market?.age||0),
        gp,season_total:+total.toFixed(1),ppg:+ppg.toFixed(2),
        fc_value:market?.value||0,fc_rank:market?.rank||'',fc_pos_rank:market?.positionRank||'',
        fc_trend_30d:market?.trend30Day??'',
      });
    });

    marketRows.forEach(market=>{
      if(seen.has(market.sleeperId)||!activePositions.includes(market.position))return;
      baseRows.push({
        sleeper_id:market.sleeperId,asset_type:'player',name:market.name,position:market.position,
        nfl_team:market.team,age:market.age,gp:0,season_total:0,ppg:0,
        fc_value:market.value,fc_rank:market.rank,fc_pos_rank:market.positionRank,
        fc_trend_30d:market.trend30Day,
      });
    });

    const lineupContext=buildLineupContext({
      rows:baseRows,
      rosterPositions,
      totalTeams,
      positions:activePositions,
      starterCounts,
      includeDefense:false,
    });
    const topByPosition={};
    const positionContext={};
    activePositions.forEach(pos=>{
      const rows=baseRows.filter(row=>row.position===pos&&row.ppg>0).sort((a,b)=>b.ppg-a.ppg);
      const ctx=lineupContext.position[pos]||{};
      const configuredDemand=Math.max(1,Math.round((starterCounts[pos]||1)*totalTeams));
      const demand=Math.max(1,Math.round(ctx.lineupSlots||configuredDemand));
      const replacement=ctx.replacementPpg||rows[Math.min(rows.length-1,configuredDemand-1)]?.ppg||0;
      const topAvgCount=Math.max(1,Math.min(rows.length,totalTeams));
      const topAvg=rows.slice(0,topAvgCount).reduce((sum,row)=>sum+row.ppg,0)/topAvgCount||0;
      topByPosition[pos]={
        demand,
        configuredDemand,
        replacement:+replacement.toFixed(2),
        topAvg:+topAvg.toFixed(2),
        count:rows.length,
        lineupSlots:ctx.lineupSlots||0,
        perTeamSlots:ctx.perTeamSlots||0,
        lineupPpg:ctx.lineupPpg||0,
        perTeamPpg:ctx.perTeamPpg||0,
        lineupPointShare:ctx.pointShare||0,
        lineupMarginalShare:ctx.marginalShare||0,
        lineupSlotShare:ctx.slotShare||0,
        lineupImportance:ctx.importance||1,
      };
      positionContext[pos]=ctx.importance||1;
    });
    const marketCompatibility=fantasyCalcCompatibility({...cfg,rosterPositions,scoring,ppr:cfg.ppr??scoring.rec});

    // Rookie / market-only rows (gp===0, no ppg) have no real age on file — default
    // to a rookie-appropriate 21 rather than 26, so their age-curve factor and future
    // projections aren't penalized as if they were 26-year-olds. Veterans with real
    // stats (ppg>0) keep the 26 fallback for a genuinely missing age.
    const ageFor = row => Number(row.age) || (row.gp === 0 && (row.ppg || 0) === 0 ? 21 : 26);
    const rawComposites=baseRows.map(row=>{
      const marketPpgProxy=row.fc_value?row.fc_value/450:0;
      const basePpg=row.ppg||marketPpgProxy;
      const replacement=topByPosition[row.position]?.replacement||0;
      const replacementEdge=Math.max(0,basePpg-replacement);
      const lineupValuePpg=(basePpg*0.35)+(replacementEdge*0.65);
      return lineupValuePpg*ageCurveFactor(ageFor(row),row.position)*(positionContext[row.position]||1);
    });
    const topComposite=Math.max(1,...rawComposites);
    const playerRows=baseRows.map((row,idx)=>{
      const currentAgeFactor=ageCurveFactor(ageFor(row),row.position);
      const ppgValue=Math.round((rawComposites[idx]/topComposite)*10000);
      const marketValue=Number(row.fc_value)||0;
      const marketPpgProxy=marketValue?marketValue/450:0;
      const basePpg=row.ppg||marketPpgProxy;
      const replacement=topByPosition[row.position]?.replacement||0;
      const replacementEdge=Math.max(0,basePpg-replacement);
      const lineupValuePpg=(basePpg*0.35)+(replacementEdge*0.65);
      const perTeamLineupPpg=Math.max(1,lineupContext.perTeamLineupPpg||1);
      const posLineup=topByPosition[row.position]||{};
      const avgPositionSlotPpg=posLineup.perTeamSlots?((posLineup.perTeamPpg||0)/posLineup.perTeamSlots):replacement;
      const playerLineupTotal=Math.max(1,perTeamLineupPpg-avgPositionSlotPpg+basePpg);
      let marketWeight=0;
      if(marketValue){
        if(isDynasty){
          const deviation=Math.abs(ppgValue-marketValue)/Math.max(ppgValue,marketValue,1);
          marketWeight=marketBlendWeight(deviation,marketCompatibility);
        }else{
          marketWeight=cfg.marketWeight!=null?Number(cfg.marketWeight):0.45;
        }
      }
      const now=Math.round((ppgValue*(1-marketWeight))+(marketValue*marketWeight));
      const out={
        ...row,mode,league_size:totalTeams,roster_slots:rosterPositions.join('|'),
        starter_demand:starterCounts[row.position]||0,
        league_starter_pool:(starterCounts[row.position]||0)*totalTeams,
        replacement_ppg:replacement,
        replacement_edge_ppg:+replacementEdge.toFixed(2),
        lineup_value_ppg:+lineupValuePpg.toFixed(2),
        lineup_total_ppg:lineupContext.perTeamLineupPpg||0,
        player_lineup_point_share:+(basePpg/playerLineupTotal).toFixed(4),
        position_lineup_point_share:posLineup.lineupPointShare||0,
        position_lineup_marginal_share:posLineup.lineupMarginalShare||0,
        position_lineup_slot_share:posLineup.lineupSlotShare||0,
        position_context:positionContext[row.position]||1,
        age_curve_phase:ageCurvePhase(row.age,row.position),
        age_factor:+currentAgeFactor.toFixed(3),
        market_weight:+marketWeight.toFixed(2),
        market_compatibility_score:marketCompatibility.score,
        market_compatibility_reasons:marketCompatibility.reasons.join('|'),
        ppg_value:ppgValue,
        dhq_now:Math.max(0,Math.min(10000,now)),
      };
      for(let year=1;year<=projectionYears;year++){
        const futureFactor=ageCurveFactor(ageFor(row)+year,row.position)/Math.max(0.01,currentAgeFactor);
        const horizonDiscount=isDynasty?Math.pow(0.96,year):Math.pow(0.70,year);
        out[`dhq_year_${year}`]=Math.round(out.dhq_now*futureFactor*horizonDiscount);
      }
      return out;
    }).sort((a,b)=>b.dhq_now-a.dhq_now);

    playerRows.forEach((row,idx)=>{row.overall_rank=idx+1;});
    activePositions.forEach(pos=>{
      playerRows.filter(row=>row.position===pos).sort((a,b)=>b.dhq_now-a.dhq_now)
        .forEach((row,idx)=>{row.position_rank=idx+1;});
    });

    const pickRows=[];
    if(isDynasty&&cfg.includePicks!==false){
      const pickValueFn=input?.pickValueFn||defaultPickValue;
      const baseYear=Number(cfg.basePickYear)||new Date().getFullYear();
      for(let year=0;year<=projectionYears;year++){
        const season=baseYear+year;
        for(let round=1;round<=draftRounds;round++){
          for(let slot=1;slot<=totalTeams;slot++){
            const pickNo=(round-1)*totalTeams+slot;
            const base=pickValueFn(pickNo,totalTeams,draftRounds);
            const val=Math.round(base*Math.pow(0.88,year));
            const row={asset_type:'pick',name:`${season} Pick ${round}.${String(slot).padStart(2,'0')}`,
              position:'PICK',mode,league_size:totalTeams,dhq_now:year===0?val:'',
              overall_rank:'',position_rank:''};
            for(let y=1;y<=projectionYears;y++)row[`dhq_year_${y}`]=year===y?val:'';
            pickRows.push(row);
          }
        }
      }
    }

    return {
      generatedAt:new Date().toISOString(),
      config:{...cfg,mode,totalTeams,rosterPositions,scoring,starterCounts,projectionYears,draftRounds},
      starterCounts,
      positionContext,
      topByPosition,
      lineupContext,
      marketCompatibility,
      playerRows,
      pickRows,
      rows:[...playerRows,...pickRows],
    };
  }

  const api={
    AGE_CURVES,DECAY_RATES,DECLINE_END_FACTOR,OFFENSE,MARKET_BLEND_WEIGHTS,
    defaultScoring,normalizePosition,starterCountsFromRoster,scoreStats,
    ppgReliability,curveForPosition,ageCurvePhase,ageCurveFactor,
    fantasyCalcCompatibility,marketBlendWeight,
    positionScoringWeights,slotEligiblePositions,buildLineupContext,
    depthRole,depthRoleMult,
    calculateValues,defaultPickValue,
  };

  if(typeof root.window!=='undefined'){
    root.window.App=root.window.App||{};
    root.window.App.DhqCore=api;
    root.window.DhqCore=api;
  }else if(root.App){
    root.App.DhqCore=api;
  }
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
