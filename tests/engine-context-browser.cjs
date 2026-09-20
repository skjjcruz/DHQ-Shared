'use strict';
// Actual canonical engine/providers/ledger/storage in Chrome. This fixture shell
// exercises the module contract; it is not a full public-product journey.
// NODE_PATH=<public-consumer>/node_modules node tests/engine-context-browser.cjs [artifact-dir]
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('@playwright/test'),{fixture,token}=require('./helpers/engine-fixture.cjs');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'tmp/engine-context-browser'),data=fixture();
const files=['storage.js','dhq-core.js','pick-value-model.js','dhq-providers.js','points-ledger.js','one-brain.js','dhq-engine.js'];
const includeAssessments=process.env.DHQ_TEST_ASSESSMENTS==='1';
if(includeAssessments)files.push('intelligence-context.js','team-assess.js');
const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:20px;background:#17202b;color:white}button{min-height:44px;margin:5px;padding:10px;font:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>
<h1>Engine context verification</h1><p>Controlled fixture data. No provider mutations or connected accounts.</p>
<button id="active">Load active league 111</button><button id="background">Load background league 222</button><pre id="result">Ready</pre>
<script>
window.App={};window.events=[];window.cacheReads=[];window.cacheWrites=[];
if(!localStorage.getItem('fw_session_v1'))localStorage.setItem('fw_session_v1',JSON.stringify({token:${JSON.stringify(token('fixture-A'))},user:{id:'fixture-A'}}));
window.S=${JSON.stringify(data.state)};
const ActualDate=Date;window.Date=class extends ActualDate{constructor(...args){super(...(args.length?args:['2026-09-20T00:00:00Z']));}static now(){return 1789862400000;}};
window.Sleeper={fetchSeasonStats:year=>fetch('https://api.sleeper.app/v1/stats/nfl/regular/'+year).then(r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.json();})};
window.DhqEvents={emit:(type,detail)=>events.push({type,detail})};
</script>${files.map(f=>'<script src="/'+f+'"></script>').join('')}
<script>
const get=DhqStorage.idbGet,set=DhqStorage.idbSet;
DhqStorage.idbGet=async key=>{cacheReads.push(key);return get(key);};DhqStorage.idbSet=async(key,value)=>{cacheWrites.push(key);return set(key,value);};
window.run=async background=>{document.querySelector('#result').textContent='Loading';window.lastResult=null;window.lastError=null;try{const state=JSON.parse(JSON.stringify(S));state.currentLeagueId='222';state.leagues[0].league_id='222';const result=await App.loadLeagueIntel(background?{state}:undefined);window.lastResult=result;document.querySelector('#result').textContent='Ready '+result.leagueId+' · '+Object.keys(result.data.playerScores).length+' values';}catch(e){window.lastError=e.message;document.querySelector('#result').textContent='Retry available: '+e.message;}};
document.querySelector('#active').onclick=()=>run(false);document.querySelector('#background').onclick=()=>run(true);
</script></body></html>`;
function response(url){
 if(url.hostname==='api.fantasycalc.com')return data.rows;
 const p=url.pathname;
 if(/\/stats\/nfl\/regular\//.test(p))return data.stats(Number(p.split('/').pop()));
 if(/\/projections\/nfl\/regular\//.test(p))return data.stats(2026);
 const league=p.match(/^\/v1\/league\/(111|222)$/);if(league)return{...data.league,league_id:league[1],previous_league_id:null,draft_id:'d'+league[1]};
 if(/\/drafts$/.test(p))return[{draft_id:'d1',status:'complete',settings:{rounds:4}}];
 if(/\/draft\/d1\/picks$/.test(p))return[];
 if(/\/transactions\/\d+$|\/winners_bracket$|\/losers_bracket$|\/users$/.test(p))return[];
 throw Error('Unexpected read '+url.href);
}
(async()=>{
 fs.mkdirSync(out,{recursive:true});let browser;
 const server=http.createServer((req,res)=>{const name=req.url.slice(1);if(req.method!=='GET'){res.writeHead(405);return res.end();}res.setHeader('Content-Type',(files.includes(name)?'text/javascript':'text/html')+'; charset=utf-8');res.end(files.includes(name)?fs.readFileSync(path.join(root,name)):html);});
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  console.log('Fixture listening',origin);
  browser=await chromium.launch({headless:true,timeout:15000,executablePath:process.env.PLAYWRIGHT_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});console.log('Chrome launched');
  const context=await browser.newContext({viewport:{width:390,height:844}}),requests=[],blocked=[],errors=[];let hold=false,held=[];
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(req.method()==='GET'&&url.origin===origin)return route.continue();if(req.method()!=='GET'||!['api.sleeper.app','api.fantasycalc.com'].includes(url.hostname)){blocked.push(req.method()+' '+url);return route.abort();}requests.push(url.href);try{const payload=response(url);if(hold&&url.pathname.includes('/stats/'))await new Promise(r=>held.push(r));await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)});}catch(e){if(!/Target closed|already handled|aborted/.test(e.message))errors.push(e.message);try{await route.abort();}catch{}}});
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>{errors.push(e.message);console.error('Page error',e.message);});page.on('console',m=>{if(m.type()==='warning'||m.type()==='error')console.log('Browser',m.text());});await page.goto(origin);console.log('Fixture loaded');
  const original=await page.evaluate(()=>JSON.stringify(S));await page.getByRole('button',{name:'Load background league 222'}).click();await page.getByText('Ready 222 · 8 values',{exact:true}).waitFor();
  console.log('Background completed');assert.equal(await page.evaluate(()=>JSON.stringify(S)),original);assert.equal(await page.evaluate(()=>App.LI_LOADED),false);assert.equal(await page.evaluate(()=>events.length),0);assert.equal(await page.evaluate(()=>window.DhqBrain||null),null);
  if(includeAssessments){
   const assessment=await page.evaluate(()=>{
    const league={...S.leagues[0],league_id:'222',drafts:[]},raw=localStorage.getItem('fw_session_v1');window.backgroundResult=lastResult;
    window.assessmentContext={leagueId:'222',season:'2026',playerScores:lastResult.data.playerScores,isCurrent:()=>localStorage.getItem('fw_session_v1')===raw};
    const rows=App.assessAllTeamsWithContext(S.rosters,S.players,{},league,[],[],assessmentContext);
    return{totals:rows.map(r=>r.totalDHQ),expected:S.rosters.map(r=>r.players.reduce((n,id)=>n+(lastResult.data.playerScores[id]||0),0)),globalReady:App.LI_LOADED,brain:window.DhqBrain||null};
   });assert.deepEqual(assessment.totals,assessment.expected);assert.equal(assessment.globalReady,false);assert.equal(assessment.brain,null);
  }
  await page.getByRole('button',{name:'Load active league 111'}).click();await page.getByText('Ready 111 · 8 values',{exact:true}).waitFor();const first=await page.evaluate(()=>({scores:lastResult.data.playerScores,brain:lastResult.brain,reads:cacheReads,writes:cacheWrites}));assert(first.brain);assert(first.scores['101']>0);
  // Wait on an actual IDB read, not a timing assumption, before reload.
  const key=first.writes.find(k=>k.startsWith('dhq_leagueintel')&&k.includes(':111:'));
  await page.waitForFunction(async key=>!!(await DhqStorage.idbGet(key)),key);
  requests.length=0;await page.reload();await page.getByRole('button',{name:'Load active league 111'}).click();await page.getByText('Ready 111 · 8 values',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>lastResult.data.playerScores),first.scores);assert.deepEqual(await page.evaluate(()=>lastResult.brain),first.brain);assert(!requests.some(url=>url.includes('/league/')),'reload should use matching account-owned history/value cache');
  await page.screenshot({path:path.join(out,'ready-reloaded.png')});
  // New league forces cold work; a second real tab replaces account A while
  // the actual stats request is held. No artificial storage event is emitted.
  await page.evaluate(()=>{S.currentLeagueId='222';S.leagues[0].league_id='222';S.leagues[0].scoring_settings.pass_td=6;});hold=true;await page.getByRole('button',{name:'Load active league 111'}).click();await page.getByText('Loading',{exact:true}).waitFor();while(!held.length)await new Promise(r=>setTimeout(r,20));
  const other=await context.newPage();await other.goto(origin);await other.evaluate(token=>localStorage.setItem('fw_session_v1',JSON.stringify({token,user:{id:'fixture-B'}})),token('fixture-B'));
  await page.waitForFunction(()=>!App.LI_LOADED);hold=false;held.splice(0).forEach(r=>r());await page.getByText(/Retry available:.*superseded/).waitFor();assert.equal(await page.evaluate(()=>window.DhqBrain),null);assert.equal(await page.evaluate(()=>lastResult),null);
  if(includeAssessments)assert.equal(await page.evaluate(()=>{try{App.assessAllTeamsWithContext(S.rosters,S.players,{},S.leagues[0],[],[],{leagueId:'222',season:'2026',playerScores:{100:8000},isCurrent:()=>JSON.parse(localStorage.getItem('fw_session_v1')).user.id==='fixture-A'});return false;}catch{return true;}}),true);
  await page.screenshot({path:path.join(out,'account-switch-recovery.png')});
  await page.getByRole('button',{name:'Load active league 111'}).click();await page.getByText('Ready 222 · 8 values',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>lastResult.leagueId),'222');assert.equal(await page.evaluate(()=>App.LI_LOADED),true);
  assert.deepEqual(blocked,[]);assert.deepEqual(errors,[]);
  const result={modules:files,viewport:'390x844',checks:['explicit background context preserves active bridge','foreground values and actual one-brain','actual IndexedDB reload and matching cache adoption','real cross-tab account change cancels held cold work','same-view new-account retry succeeds',...(includeAssessments?['explicit assessment uses returned league values while active LI is empty','assessment caller guard rejects replaced account']:[])],externalWrites:0,pageErrors:errors,requests:requests.length,scope:'canonical modules in fixture shell; public product caller integration remains separate'};
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
