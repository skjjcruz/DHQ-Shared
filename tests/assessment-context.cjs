'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{execFileSync}=require('node:child_process');
const {fixture}=require('./helpers/engine-fixture.cjs'),plain=value=>JSON.parse(JSON.stringify(value));
const baseline=execFileSync('git',['show','1e7ef86:team-assess.js'],{encoding:'utf8'}),source=fs.readFileSync('team-assess.js','utf8');
function install(x,text=source){vm.runInContext(fs.readFileSync('intelligence-context.js','utf8'),x.ctx);vm.runInContext(text,x.ctx);}
const scored=x=>Object.fromEntries(Object.entries(x.stats(2026)).map(([pid,s])=>[pid,{seasonAvg:(s.pass_td*4+s.rush_td*6+s.rec_td*6+s.rec+s.idp_tkl_solo*2+s.fgm*3)/s.gp}]));
const args=(state,stats)=>[state.rosters,state.players,stats,state.leagues[0],[],state.tradedPicks];
const context=(result,extra={})=>({leagueId:result.leagueId,season:result.season,playerScores:result.data.playerScores,...extra});
const tests={
async explicitCapabilityCannotBeMistakenForOldIgnoredArgument(){const x=fixture();const result=await x.ctx.App.loadLeagueIntel();install(x);assert.throws(()=>x.ctx.App.assessAllTeamsWithContext(...args(x.state,scored(x)),context(result)),/current assessment context/);const actual=x.ctx.App.assessAllTeamsWithContext(...args(x.state,scored(x)),context(result,{isCurrent:()=>true}));assert.deepEqual(plain(actual),plain(x.ctx.App.assessAllTeams(...args(x.state,scored(x)))));},
async baselineReproducesForeignActiveValuesInExplicitAssessment(){
 const x=fixture();await x.ctx.App.loadLeagueIntel();install(x,baseline);const state=plain(x.state);state.currentLeagueId='222';state.leagues[0].league_id='222';state.leagues[0].scoring_settings.pass_td=6;const result=await x.ctx.App.loadLeagueIntel({state});const actual=x.ctx.App.assessAllTeams(...args(state,scored(x)),context(result));
 const expected=state.rosters[0].players.reduce((n,id)=>n+(result.data.playerScores[id]||0),0);assert.notEqual(actual[0].totalDHQ,expected);console.log('REPRODUCED baseline uses active111 values in explicit222 assessment');
},
async explicitAssessmentMatchesOldHealthySelectedLeagueWithoutGlobalWrites(){
 for(const mode of ['normal','superflex','custom-idp','no-season-points']){
  const old=fixture(),now=fixture(),state=plain(now.state);state.currentLeagueId='222';state.leagues[0].league_id='222';state.leagues[0].scoring_settings.pass_td=6;
  if(mode==='superflex')state.leagues[0].roster_positions.push('SUPER_FLEX');if(mode==='custom-idp')state.leagues[0].scoring_settings.idp_tkl_solo=4;
  old.ctx.S=plain(state);install(old,baseline);await old.ctx.App.loadLeagueIntel();const stats=mode==='no-season-points'?{}:scored(old);const expected=old.ctx.App.assessAllTeams(...args(old.ctx.S,stats));
  await now.ctx.App.loadLeagueIntel();install(now);const result=await now.ctx.App.loadLeagueIntel({state});const before=JSON.stringify({state:now.ctx.S,values:now.ctx.App.LI,brain:now.ctx.DhqBrain}),writes=now.writes.length;
  const actual=now.ctx.App.assessAllTeams(...args(state,stats),context(result));assert.deepEqual(plain(actual),plain(expected),mode);assert.equal(JSON.stringify({state:now.ctx.S,values:now.ctx.App.LI,brain:now.ctx.DhqBrain}),before);assert.equal(now.writes.length,writes);assert(result.data.playerScores['101']>0,'injured player value retained');
 }
},
async omittedContextRetainsExactEstablishedGenericContract(){const a=fixture(),b=fixture();await a.ctx.App.loadLeagueIntel();await b.ctx.App.loadLeagueIntel();install(a,baseline);install(b);assert.deepEqual(plain(b.ctx.App.assessAllTeams(...args(b.state,scored(b)))),plain(a.ctx.App.assessAllTeams(...args(a.state,scored(a)))));},
async invalidOrForeignContextNeverFallsBackToGlobalValues(){const x=fixture();const result=await x.ctx.App.loadLeagueIntel();install(x);for(const ctx of [context(result,{leagueId:'222'}),context(result,{season:'2025'}),context(result,{isCurrent:()=>false}),context(result,{playerScores:{}}),context(result,{playerScores:{100:NaN}}),context(result,{playerScores:[]})])assert.throws(()=>x.ctx.App.assessAllTeams(...args(x.state,scored(x)),ctx),/changed|unavailable/);},
async explicitDraftAbsenceCannotBorrowActiveSameIdBoard(){const x=fixture();const result=await x.ctx.App.loadLeagueIntel();install(x);x.state.drafts=[{draft_id:'old',league_id:'111',season:'2026',status:'complete'}];const l={...x.league,status:'pre_draft'};const actual=x.ctx.App.assessAllTeams(x.state.rosters,x.players,scored(x),l,[],[],context(result));assert.deepEqual(plain(actual[0].picksAssessment.pickYears),['2026','2027','2028']);},
async explicitInactivePolicyMatchesEngineAndInjuryDoesNotEraseValue(){const x=fixture();x.players['100'].status='Inactive';const result=await x.ctx.App.loadLeagueIntel();install(x);const a=x.ctx.App.assessAllTeams(...args(x.state,scored(x)),context(result));const expected=x.state.rosters[0].players.reduce((n,id)=>n+x.ctx.App.dynastyValue(id),0);assert.equal(a[0].totalDHQ,expected);assert(a[0].totalDHQ>=result.data.playerScores['101']);},
};
(async()=>{for(const [name,run]of Object.entries(tests)){await run();console.log('PASS',name);}console.log(Object.keys(tests).length+' explicit assessment groups passed.');})().catch(e=>{console.error(e);process.exitCode=1;});
