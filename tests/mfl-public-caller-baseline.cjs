'use strict';
// Reproduction only: actual public callbacks, synthetic storage/providers.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.env.MFL_PUBLIC_SOURCE||'/Users/jacobc/Projects/warroom-readiness-public-auth/js/app.js','utf8');
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve};};
function context(){const map=new Map([['fw_session_v1','account-a']]);const events=[];const store={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};const x={localStorage:store,sessionStorage:store,window:null,console,Promise,setTimeout,clearTimeout,platformAccessAllowed:()=>true,sleeperUsername:'',OWNER_MFL_TEAM:'Fixture',setMflFranchises:v=>events.push(['franchises',v]),setMflPendingResult:v=>events.push(['pending',v]),setMflLeagues:fn=>events.push(['leagues',fn([])]),handleSelectLeague:v=>events.push(['selected',v]),buildMflLeagueObj:(result,id,franchiseId)=>({id:'mfl_'+id+'_2025',name:result.league.name,franchiseId}),OD:{saveMflConnection:c=>events.push(['cloud-save',c])},MFL:{}};x.window=x;vm.createContext(x);return{x,map,events};}
(async()=>{
 const a=context(),held=deferred();a.x.OD.loadMflConnection=()=>held.promise;
 const start=source.indexOf('            let alive = true;',source.indexOf('// ── MFL rehydration'));
 const end=source.indexOf('            return () => { alive = false; };',start);
 assert(start>0&&end>start);
 vm.runInContext(source.slice(start,end).replace('(async () => {','window.pending = (async () => {'),a.x);
 a.map.set('fw_session_v1','account-b');held.resolve({leagueId:'12345',year:'2025',franchiseId:'0001'});await a.x.pending;
 assert.equal(a.map.get('mfl_league_id'),'12345');
 console.log('REPRODUCED: A cloud connection installs league/year/franchise keys after B signs in, before provider entry.');
 const b=context();b.map.set('mfl_league_id','99999');b.map.set('mfl_year','2026');b.x.mflPendingResult={league:{league_id:'mfl_12345_2025',name:'A selected league'}};
 const fstart=source.indexOf('        function finalizeMFLConnect('),fend=source.indexOf('\n        // ── The connect',fstart);
 vm.runInContext(source.slice(fstart,fend)+';finalizeMFLConnect("0001");',b.x);
 assert.equal(b.events.find(e=>e[0]==='selected')[1].id,'mfl_99999_2025');
 assert.equal(b.events.find(e=>e[0]==='cloud-save')[1].year,'2026');
 console.log('REPRODUCED: delayed franchise selection combines pending 12345/2025 data with current 99999/2026 connection.');
})().catch(e=>{console.error(e);process.exitCode=1;});
