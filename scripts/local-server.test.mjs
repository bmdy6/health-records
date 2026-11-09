import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalServer } from './local-server.mjs';
const credentials = 'Basic ' + Buffer.from('demo:demo-only').toString('base64');
async function fixture(t, options={}) {
  const dir = await mkdtemp(join(tmpdir(),'health-local-test-'));
  const app = await createLocalServer({ dataDir: dir, ...options });
  await new Promise(r=>app.listen(0,'127.0.0.1',r));
  t.after(async()=>{ await new Promise(r=>app.close(r)); await rm(dir,{recursive:true,force:true}); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, init={})=>fetch(base+path,{...init,headers:{Authorization:credentials,...init.headers}});
  return {app,dir,base,request};
}
test('DAV persists bytes and enforces atomic create / stale / concurrent versions', async t=>{
 const {request,dir}=await fixture(t); const path='/dav/personal/demo/body/food.json';
 assert.equal((await request(path)).status,404);
 const first=await request(path,{method:'PUT',headers:{'If-None-Match':'*'},body:'[]'});assert.equal(first.status,201);
 const initial=await request(path);const etag=initial.headers.get('etag');assert.match(etag,/^"[a-f0-9]{64}"$/);
 assert.equal((await request(path,{method:'PUT',headers:{'If-None-Match':'*'},body:'[1]'})).status,412);
 assert.equal((await request(path,{method:'PUT',body:'[1]'})).status,428);
 const raced=await Promise.all(['[1]','[2]'].map(body=>request(path,{method:'PUT',headers:{'If-Match':etag},body})));
 assert.deepEqual(raced.map(r=>r.status).sort(),[204,412]);
 const stored=await (await request(path)).text();assert.ok(['[1]','[2]'].includes(stored));
 assert.equal(await readFile(join(dir,'personal/demo/body/food.json'),'utf8'),stored);
 assert.equal((await request(path,{method:'PUT',headers:{'If-Match':etag},body:'[3]'})).status,412);
});
test('rejects unauthenticated DAV, foreign Origin/Host and non-health paths',async t=>{
 const {base,request}=await fixture(t);
 assert.equal((await fetch(base+'/dav/personal/demo/body/food.json')).status,401);
 assert.equal((await request('/dav/personal/demo/body/food.json',{headers:{Origin:'https://attacker.invalid'}})).status,403);
 assert.equal(await new Promise(resolve=>{const req=httpRequest(base+'/dav/personal/demo/body/food.json',{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.end();}),421);
 assert.equal((await request('/dav/personal/other/body/food.json')).status,404);
 assert.equal((await request('/dav/personal/demo/body/%2e%2e%2fsecrets.json')).status,404);
 assert.equal((await request('/api/ai/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,503);
});
test('AI uses runtime key/model and never returns upstream errors or follows redirects',async t=>{
 let called;
 const {request}=await fixture(t,{ai:{baseUrl:'https://provider.example/v1',key:'synthetic-provider-key',textModel:'text-model',visionModel:'vision-model'},fetchImpl:async(url,init)=>{called={url,init};return new Response(JSON.stringify({choices:[{message:{content:'[]'}}]}),{headers:{'Content-Type':'application/json'}});}});
 const response=await request('/api/ai/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'vision',messages:[{role:'user',content:'test'}],stream:false})});
 assert.equal(response.status,200);assert.equal(called.url,'https://provider.example/v1/chat/completions');assert.equal(called.init.redirect,'error');
 assert.equal(called.init.headers.Authorization,'Bearer synthetic-provider-key');assert.equal(JSON.parse(called.init.body).model,'vision-model');assert.ok(!(await response.text()).includes('synthetic-provider-key'));
});

test('CLI releases its new data lock when the listen port is already occupied',async t=>{
 const occupied=await fixture(t);const dir=await mkdtemp(join(tmpdir(),'health-listen-error-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const child=spawn(process.execPath,['scripts/local-server.mjs'],{cwd:new URL('..',import.meta.url),env:{HEALTH_LOCAL_DATA_DIR:dir,HEALTH_LOCAL_PORT:String(occupied.app.address().port)},stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',c=>stderr+=c);
 const exit=await new Promise(resolve=>child.once('exit',resolve));assert.equal(exit,1);
 await assert.rejects(readFile(join(dir,'.writer.lock')),e=>e.code==='ENOENT');
 assert.match(stderr,/port|listen/i);
});
