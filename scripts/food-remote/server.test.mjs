import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFoodRemote } from './server.mjs';
import { healthModule } from '../health-agent.mjs';
const publicBase='https://mcp.example/workbench-agent',resource=publicBase+'/mcp';
const callback='https://chatgpt.com/connector/oauth/test-callback';
const verifier='A'.repeat(50),challenge=createHash('sha256').update(verifier).digest('base64url');
async function fixture(t, options = {}) {
 const dir=await mkdtemp(path.join(tmpdir(),'food-remote-'));let files=new Map(),revision=1,puts=0;
 const davFetch=async(url,init)=>{
  if(String(url).endsWith('_settings.json'))return new Response('{}');
  if(String(url).endsWith('/profile.json'))return new Response(null,{status:404});
  if(init.method==='PUT'){
   if(new Headers(init.headers).get('if-match')!==`"${revision}"`)return new Response(null,{status:412});
   files.set(String(url),JSON.parse(init.body));revision++;puts++;return new Response(null,{status:204});
  }
  return new Response(JSON.stringify(files.get(String(url))??[]),{headers:{ETag:`"${revision}"`}});
 };
 const remote=await createFoodRemote({publicBase,stateDir:dir,config:{url:'https://dav.example/wb/',username:'owner',password:'test-only'},fetchImpl:davFetch,...options});
 const http=createServer(remote.app);await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await remote.close();await rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${http.address().port}`;
 const req=(url,init={})=>new Promise((resolve,reject)=>{
  const parsed=new URL(url,publicBase);
  const request=httpRequest({hostname:'127.0.0.1',port:http.address().port,path:parsed.pathname+parsed.search,method:init.method??'GET',headers:{Host:'mcp.example',...init.headers}},response=>{
   const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(new Response([204,304].includes(response.statusCode)?null:Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));
  });request.on('error',reject);request.end(init.body?String(init.body):undefined);
 });
 async function grant(scopes='food:read food:write', redirect=callback){
  const registration=await req(publicBase+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:[redirect],token_endpoint_auth_method:'none'})});
  assert.equal(registration.status,201);const client=await registration.json();
  const query=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:redirect,code_challenge:challenge,code_challenge_method:'S256',state:'my-state',scope:scopes,resource});
  const consent=await req(publicBase+'/authorize?'+query);assert.equal(consent.status,200);
  const html=await consent.text();const ticket=/data-ticket="([\w-]+)"/.exec(html)?.[1];assert.ok(ticket);
  const confirmed=await req(publicBase+'/confirm',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://mcp.example'},body:JSON.stringify({ticket,allow:true,username:'owner',password:'test-only'})});
  assert.equal(confirmed.status,200);const target=new URL((await confirmed.json()).redirect);assert.equal(target.searchParams.get('state'),'my-state');
  const tokens=await req(publicBase+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:target.searchParams.get('code'),code_verifier:verifier,redirect_uri:redirect,resource})});
  assert.equal(tokens.status,200);return {tokens:await tokens.json(),client};
 }
 const rpc=async(token,method,params)=>{const result=await req(resource,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return {status:result.status,body:await result.json()};};
 return {req,grant,rpc,dir,puts:()=>puts};
}
test('OAuth discovery -> owner consent -> MCP add/get/update/replay uses the original store',async t=>{
 const f=await fixture(t);
 const unauth=await f.req(resource,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauth.status,401);assert.match(unauth.headers.get('www-authenticate'),/resource_metadata/);
 const metadata=await (await f.req('https://mcp.example/.well-known/oauth-authorization-server/workbench-agent')).json();assert.equal(metadata.issuer,publicBase);assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
 const {tokens}=await f.grant();const token=tokens.access_token;
 const init=await f.rpc(token,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'synthetic-dot',version:'1'}});assert.equal(init.status,200);
 const list=await f.rpc(token,'tools/list',{});assert.deepEqual(list.body.result.tools.map(t=>t.name),['food_list','food_get','food_add','food_update']);
 const item={id:'rice',date:'2026-10-30',food:'米饭',grams:200,kcal:240,protein:5,carbs:52,fat:1,note:'合成照片估算'};
 const added=await f.rpc(token,'tools/call',{name:'food_add',arguments:{mutation_id:'photo-1',items:[item]}});assert.equal(added.body.result.isError,false);
 const read=await f.rpc(token,'tools/call',{name:'food_get',arguments:{id:'rice'}});const expected=read.body.result.structuredContent.item;
 const args={name:'food_update',arguments:{mutation_id:'half-1',id:'rice',expected,patch:{grams:100}}};
 const changed=await f.rpc(token,'tools/call',args);const replay=await f.rpc(token,'tools/call',args);
 assert.equal(changed.body.result.structuredContent.item.kcal,120);assert.deepEqual(changed.body,replay.body);assert.equal(f.puts(),2);
 const disk=await readFile(path.join(f.dir,'oauth.json'),'utf8');assert.ok(!disk.includes(token)&&!disk.includes('test-only'));
});
test('read-only grants cannot discover or invoke writes; untrusted origin and Host are rejected',async t=>{
 const f=await fixture(t);const {tokens}=await f.grant('food:read');
 const tools=await f.rpc(tokens.access_token,'tools/list',{});assert.deepEqual(tools.body.result.tools.map(t=>t.name),['food_list','food_get']);
 const write=await f.rpc(tokens.access_token,'tools/call',{name:'food_add',arguments:{}});assert.ok(write.body.error||write.body.result?.isError);assert.equal(f.puts(),0);
 const host=await f.req(resource,{headers:{Host:'attacker.invalid'}});assert.equal(host.status,421);
 const origin=await f.req(publicBase+'/confirm',{method:'POST',headers:{Origin:'https://attacker.invalid','Content-Type':'application/json'},body:'{}'});assert.equal(origin.status,403);
});

test('health-only grants expose health tools without food privileges; scopes remain isolated',async t=>{
 const f=await fixture(t); const {tokens}=await f.grant('health:read');
 const tools=await f.rpc(tokens.access_token,'tools/list',{});
 assert.equal(tools.status,200);const names=tools.body.result.tools.map(t=>t.name);
 assert.ok(names.includes('health_context'));assert.ok(names.includes('workout_get'));assert.ok(!names.includes('food_list'));assert.ok(!names.includes('workout_add'));
 const denied=await f.rpc(tokens.access_token,'tools/call',{name:'workout_add',arguments:{}});assert.ok(denied.body.error||denied.body.result?.isError);
 const badDate=await f.rpc(tokens.access_token,'tools/call',{name:'health_context',arguments:{start:'2026-02-30',end:'2026-03-02'}});assert.ok(badDate.body.error||badDate.body.result?.isError);assert.equal(f.puts(),0);
});

test('health HTTP writes replay exact requests and combined context only includes food with food:read',async t=>{
 const f=await fixture(t);const {tokens}=await f.grant('health:read health:write'); const token=tokens.access_token;
 const item={id:'walk',date:'2026-10-30',title:'散步',durationMin:30,feeling:'轻松'};
 const request={name:'workout_add',arguments:{mutation_id:'walk-1',items:[item]}};
 const added=await f.rpc(token,'tools/call',request);assert.equal(added.body.result.isError,false);
 const replay=await f.rpc(token,'tools/call',request);assert.deepEqual(added.body,replay.body);assert.equal(f.puts(),1);
 const read=await f.rpc(token,'tools/call',{name:'workout_get',arguments:{id:'walk'}});assert.equal(read.body.result.structuredContent.item.feeling,'轻松');
 const context=await f.rpc(token,'tools/call',{name:'health_context',arguments:{start:'2026-10-01',end:'2026-10-30'}});assert.equal(context.body.result.isError,false);assert.equal(context.body.result.structuredContent.workouts.length,1);assert.ok(!('foods' in context.body.result.structuredContent));
 const combined=await f.grant('health:read food:read');const both=await f.rpc(combined.tokens.access_token,'tools/call',{name:'health_context',arguments:{start:'2026-10-01',end:'2026-10-30'}});assert.deepEqual(both.body.result.structuredContent.foods,[]);
 const result=both.body.result.structuredContent;const shared=await healthModule();assert.deepEqual(result.summaries.progress,shared.summarizeProgress(result.weights,null,result.asOf));assert.deepEqual(result.summaries.weekly,shared.summarizeWeek(result.foods,result.workouts,result.asOf));assert.equal(result.summaries.nutrition,null);assert.equal(result.summaries.nutritionReason,'daily-summary-requires-single-day');
});

test('workbench identity and resource metadata are profile-specific', async t => {
 const f = await fixture(t);
 const metadata = await (await f.req('https://mcp.example/.well-known/oauth-protected-resource/workbench-agent/mcp')).json();
 assert.equal(metadata.resource_name, 'Health Records');assert.equal(metadata.resource,resource);
 const {tokens}=await f.grant();
 const initialized=await f.rpc(tokens.access_token,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
 assert.equal(initialized.body.result.serverInfo.name,'health-records');
});
test('workbench accepts approved hosted and loopback clients while owner and scope checks remain', async t => {
 const f=await fixture(t);
 for(const redirect of ['http://localhost:33418/callback','https://claude.ai/api/mcp/auth_callback','https://claude.com/api/mcp/auth_callback']) {
  const {tokens}=await f.grant('food:read',redirect);
  assert.deepEqual((await f.rpc(tokens.access_token,'tools/list',{})).body.result.tools.map(t=>t.name),['food_list','food_get']);
 }
 for(const origin of ['https://chatgpt.com','https://claude.ai','https://claude.com']) {
  assert.equal((await f.req(publicBase+'/health',{headers:{Origin:origin}})).status,200);
 }
 assert.equal((await f.req(publicBase+'/health',{headers:{Origin:'https://attacker.example'}})).status,403);
 const denied=await f.req(publicBase+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:['https://attacker.example/callback'],token_endpoint_auth_method:'none'})});
 assert.equal(denied.status,400);
 const invalidScope=await f.grant('food:read');
 assert.ok((await f.rpc(invalidScope.tokens.access_token,'tools/call',{name:'worklog_list',arguments:{}})).body.result?.isError);
});


test('explicit complete health grant lists all fourteen standalone tools',async t=>{
 const f=await fixture(t);const {tokens}=await f.grant('food:read food:write health:read health:write');
 const names=(await f.rpc(tokens.access_token,'tools/list',{})).body.result.tools.map(tool=>tool.name);
 assert.equal(names.length,14);for(const name of ['food_add','workout_add','weight_add','health_goal_set','health_context'])assert.ok(names.includes(name));
});
