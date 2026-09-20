'use strict';
// Actual owning issuer code, real local JWT signing, mocked database/rate-limit boundary.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {fixture,session,response,A,FW,LEGACY}=require('./session-lifecycle.cjs');
const modules=process.env.SESSION_TEST_MODULES||'/Users/jacobc/Projects/reconai-readiness-actual-proxies/node_modules';
const ts=require(path.join(modules,'typescript')),jose=require(path.join(modules,'jose'));
const owner=process.env.SESSION_ISSUER_SOURCE||'/Users/jacobc/Projects/warroom-current-native-source';
const secret='fixture-secret-used-only-in-local-runtime-regressions';
function load(relative,dependencies={}){
 const input=fs.readFileSync(path.join(owner,relative),'utf8');
 const output=ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 let handler;const exports={};const context={console,TextEncoder,URL,Request,Response,Uint8Array,crypto:require('node:crypto').webcrypto,exports,Deno:{env:{get:key=>key==='SUPABASE_URL'?'https://sxshiqyxhhifvtfqawbq.supabase.co':secret},serve:fn=>handler=fn},require:name=>{if(name==='npm:jose')return jose;if(Object.hasOwn(dependencies,name))return dependencies[name];throw new Error('Unmocked import '+name);}};
 vm.createContext(context);vm.runInContext(output,context,{filename:relative});return {exports,handler};
}
(async()=>{
 const {mintAppSessionJWT}=load('supabase/functions/_shared/entitlements.ts').exports;
 const token=await mintAppSessionJWT({userId:A,email:'fixture@example.invalid',tier:'pro',products:['war_room'],sessionVersion:7});
 const {payload}=await jose.jwtVerify(token,new TextEncoder().encode(secret));assert.equal(payload.sub,A);assert.equal(payload.app_metadata.user_id,A);assert.equal(payload.app_metadata.session_version,7);
 const f=fixture(),next={token,user:{id:A,email:'fixture@example.invalid',tier:'pro',products:['war_room']}};f.set({token});const pending=f.ctx.OD.ensureFreshAppSession();f.requests[0].resolve(response(200,next));assert.equal((await pending).user.id,A);assert.equal(f.ctx.getSessionToken(),token);console.log('PASS actual native aa13193 app JWT issuer and session_version7 repair/renewal contract');
 const db={from(table){assert.equal(table,'users');return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:{password_hash:'$2b$12$fixture-password-hash',is_gifted:true},error:null};}};}};
 const security={handleOptions:()=>null,clientIp:()=> 'fixture-ip',checkRateLimit:async()=>({allowed:true}),clearRateLimit:async()=>{},auditEvent:async()=>{},json:(_req,body,status=200)=>Response.json(body,{status})};
 const {handler}=load('supabase/functions/get-session-token/index.ts',{'npm:bcryptjs':{compare:async()=>true},'npm:@supabase/supabase-js@2':{createClient:()=>db},'../_shared/security.ts':security});
 const result=await handler(new Request('https://fixture.invalid/get-session-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'fixture-user',password:'fixture-password'})}));assert.equal(result.status,200);const issued=await result.json();const legacyClaims=await jose.jwtVerify(issued.token,new TextEncoder().encode(secret));assert.equal(legacyClaims.payload.sub,'fixture-user');assert.equal(legacyClaims.payload.app_metadata.sleeper_username,'fixture-user');
 const l=fixture();l.map.set(LEGACY,JSON.stringify(issued));l.map.set('dynastyhq_username','fixture-user');assert.equal(l.ctx.getSessionToken(),issued.token);assert.equal(l.ctx.getOwnerIdentity().username,'fixture-user');l.map.set(FW,'malformed');assert.equal(l.ctx.getSessionToken(),null);console.log('PASS actual native aa13193 legacy handler signed username/expiry contract and authoritative modern boundary');
})().catch(error=>{console.error(error);process.exitCode=1;});
