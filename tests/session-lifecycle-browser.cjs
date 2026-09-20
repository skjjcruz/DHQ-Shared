'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'@playwright/test');
const {session,profile,A,B,FW,PROVIDER}=require('./session-lifecycle.cjs');
const source=fs.readFileSync(path.resolve(__dirname,'../supabase-client.js'),'utf8');
const sdk=fs.readFileSync(process.env.SUPABASE_SDK_FIXTURE||'/tmp/readiness-supabase-2.101.1.js','utf8');
assert.equal(require('node:crypto').createHash('sha256').update(sdk).digest('hex'),'7d4690230324f312db08a0bb7e0d31e04c2ab8d46306c08eb3dabf6aefaeeacd','SDK fixture must be the owning page pinned 2.101.1 artifact');
const app='https://fixture.invalid/index.html',origin='https://sxshiqyxhhifvtfqawbq.supabase.co';
const jwt=(id)=>'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({sub:id,role:'authenticated',aud:'authenticated',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.c2lnbmF0dXJl';
const provider=(id)=>({access_token:jwt(id),refresh_token:'fixture-refresh-'+id,token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id,aud:'authenticated',role:'authenticated',email:'fixture@example.invalid',app_metadata:{provider:'email'},user_metadata:{}}});
(async()=>{let browser;try{
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:320,height:700}});const page=await context.newPage();const unexpected=[],pageErrors=[],databaseHeaders=[];page.on('pageerror',error=>pageErrors.push(error.message));let held=null,holdPath=null;
 const waitHeld=async()=>{const deadline=Date.now()+5000;while(!held&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.ok(held,'expected fixture request arrived');};
 await context.route('**/*',async route=>{const url=route.request().url();
  if(url===app)return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:18px system-ui;margin:16px}button{min-height:48px;font:inherit}p{overflow-wrap:anywhere}</style><button id="refresh">Refresh account</button><button id="profile">Load profile</button><p id="status">Fixture account</p><script src="/sdk.js"></script><script src="/supabase-client.js"></script><script>document.querySelector("#refresh").onclick=()=>{window.pending=OD.ensureFreshAppSession().then(value=>{document.querySelector("#status").textContent=value?value.user.id:"Account changed";return value})};document.querySelector("#profile").onclick=()=>{window.pending=OD.loadProfile().then(value=>{document.querySelector("#status").textContent=value?value.tier:"Account changed";return value})}</script>'});
  if(url==='https://fixture.invalid/sdk.js')return route.fulfill({contentType:'application/javascript',body:sdk});
  if(url==='https://fixture.invalid/supabase-client.js')return route.fulfill({contentType:'application/javascript',body:source});
  if(holdPath && url.startsWith(origin+holdPath)){held=route;return;}
  if(url.startsWith(origin+'/rest/v1/')){databaseHeaders.push(route.request().headers().authorization);return route.fulfill({contentType:'application/json',body:'[]'});}
  if(url===origin+'/auth/v1/user')return route.fulfill({contentType:'application/json',body:JSON.stringify(provider(A).user)});
  if(url===origin+'/functions/v1/fw-profile')return route.fulfill({contentType:'application/json',body:JSON.stringify(profile())});
  unexpected.push(url);return route.abort();
 });
 for(const status of [401,200]){
  await page.goto(app);await page.evaluate(({value,FW})=>{localStorage.clear();localStorage.setItem(FW,JSON.stringify(value));},{value:session(A,{old:true}),FW});
  holdPath='/functions/v1/fw-refresh-session';held=null;await page.locator('#refresh').click();await page.waitForFunction(()=>window.pending instanceof Promise);await waitHeld();
  await page.evaluate(({value,FW})=>localStorage.setItem(FW,JSON.stringify(value)),{value:session(B),FW});await held.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?session(A):{error:'fixture revoked'})});
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='Account changed');assert.equal(await page.evaluate(FW=>JSON.parse(localStorage.getItem(FW)).user.id,FW),B);console.log('PASS Chrome320 late app refresh '+status+' preserves B');
 }
 holdPath='/functions/v1/fw-profile';held=null;await page.evaluate(({value,FW})=>localStorage.setItem(FW,JSON.stringify(value)),{value:session(A),FW});await page.locator('#profile').click();await waitHeld();
 await page.evaluate(({value,FW})=>localStorage.setItem(FW,JSON.stringify(value)),{value:session(B),FW});await held.fulfill({status:401,contentType:'application/json',body:'{}'});assert.equal(await page.evaluate(()=>window.pending),null);assert.equal(await page.evaluate(FW=>JSON.parse(localStorage.getItem(FW)).user.id,FW),B);console.log('PASS Chrome320 late app profile rejection preserves B');
 holdPath=null;await page.goto(app);await page.evaluate(({value,FW})=>{localStorage.clear();localStorage.setItem(FW,JSON.stringify(value));},{value:session(A),FW});
 const setup=await page.evaluate(async value=>{window.oldSDK=OD.supabase;const out=await oldSDK.auth.setSession({access_token:value.access_token,refresh_token:value.refresh_token});return {error:out.error?.message,id:out.data.user?.id};},provider(A));assert.equal(setup.error,undefined);assert.equal(setup.id,A);
 assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).user.id,PROVIDER),A);console.log('PASS actual Supabase 2.101.1 SDK persists normal provider session with guarded adapter');
 holdPath='/auth/v1/token?grant_type=refresh_token';held=null;await page.evaluate(()=>{window.sdkPending=oldSDK.auth.refreshSession().then(value=>({error:value.error?.message,id:value.data.user?.id})).catch(error=>({error:error.message}));});await waitHeld();
 await page.evaluate(({value,provider,FW,PROVIDER})=>{localStorage.setItem(FW,JSON.stringify(value));localStorage.setItem(PROVIDER,JSON.stringify(provider));},{value:session(B),provider:provider(B),FW,PROVIDER});
 await held.fulfill({contentType:'application/json',body:JSON.stringify(provider(A))});const stale=await page.evaluate(()=>window.sdkPending);assert.ok(stale.id===A||stale.error,'retired SDK request settles without persisting its result');assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).user.id,PROVIDER),B);console.log('PASS actual SDK delayed A refresh cannot overwrite B provider session');
 holdPath='/auth/v1/logout?scope=global';held=null;await page.evaluate(()=>{window.logoutPending=OD.signOut();});await waitHeld();
 // This logout captures B; a newly signed-in A must survive its late response.
 await page.evaluate(({value,provider,FW,PROVIDER})=>{localStorage.setItem(FW,JSON.stringify(value));localStorage.setItem(PROVIDER,JSON.stringify(provider));},{value:session(A),provider:provider(A),FW,PROVIDER});
 await held.fulfill({status:204,body:''});const signedOut=await page.evaluate(()=>window.logoutPending);assert.equal(signedOut.superseded,true);assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).user.id,PROVIDER),A);assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).user.id,FW),A);console.log('PASS Chrome late captured-provider logout preserves later explicit sign-in');
 holdPath=null;
 for(const bad of ['',JSON.stringify(session(A,{expired:true})),JSON.stringify({...session(A),user:{id:B}}),JSON.stringify({token:'malformed',user:{id:A}})]) {
  await page.evaluate(async ({raw,provider,FW,PROVIDER})=>{localStorage.setItem(FW,raw);localStorage.setItem(PROVIDER,JSON.stringify(provider));const client=OD.getClient();const result=await client.from('users').select('id');if(result.error)throw result.error;},{raw:bad,provider:provider(B),FW,PROVIDER});
  assert.equal(databaseHeaders.at(-1),'Bearer '+await page.evaluate(()=>OD.SUPABASE_ANON));
 }
 console.log('PASS actual SDK sends anonymous authorization for invalid modern storage despite valid provider B');
 assert.deepEqual(unexpected,[]);assert.deepEqual(pageErrors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 fs.mkdirSync(path.resolve(__dirname,'../output/playwright'),{recursive:true});await page.screenshot({path:path.resolve(__dirname,'../output/playwright/session-lifecycle-320.png')});
}finally{await browser?.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
