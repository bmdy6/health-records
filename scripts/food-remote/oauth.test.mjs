import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { agentRedirect, createFoodOAuth } from './oauth.mjs';
const resource='https://mcp.example/workbench-agent/mcp';
const redirect='https://chatgpt.com/connector/oauth/test-callback';
const verifier='A'.repeat(50),challenge=createHash('sha256').update(verifier).digest('base64url');
async function fixture(t) {
 const dir=await mkdtemp(path.join(tmpdir(),'food-oauth-'));let now=1000;
 const auth=await createFoodOAuth({stateDir:dir,resource,now:()=>now,verifyOwner:async body=>body.username==='owner'&&body.password==='test-only'});
 t.after(async()=>{await auth.close();await rm(dir,{recursive:true,force:true});});
 const client=await auth.provider.clientsStore.registerClient({redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
 async function code(scopes=['food:read','food:write']) {
  let ticket;
  await auth.provider.authorize(client,{redirectUri:redirect,resource:new URL(resource),codeChallenge:challenge,state:'original-state',scopes},{renderConsent:value=>{ticket=value;}});
  const url=await auth.confirm(ticket,{username:'owner',password:'test-only'},true);
  assert.equal(new URL(url).searchParams.get('state'),'original-state');
  return new URL(url).searchParams.get('code');
 }
 return {auth,client,dir,code,setNow:n=>{now=n;}};
}
test('PKCE-bound grants persist hashed tokens, scope/audience, rotation and revocation',async t=>{
 const f=await fixture(t),code=await f.code();
 const tokens=await f.auth.provider.exchangeAuthorizationCode(f.client,code,verifier,redirect,new URL(resource));
 const info=await f.auth.provider.verifyAccessToken(tokens.access_token);
 assert.deepEqual(info.scopes,['food:read','food:write']);assert.equal(String(info.resource),resource);
 const disk=await readFile(path.join(f.dir,'oauth.json'),'utf8');
 assert.ok(!disk.includes(tokens.access_token)&&!disk.includes(tokens.refresh_token)&&!disk.includes('test-only'));
 await assert.rejects(f.auth.provider.exchangeAuthorizationCode(f.client,code,verifier,redirect,new URL(resource)));
 const refreshed=await f.auth.provider.exchangeRefreshToken(f.client,tokens.refresh_token,['food:read'],new URL(resource));
 assert.deepEqual((await f.auth.provider.verifyAccessToken(refreshed.access_token)).scopes,['food:read']);
 await f.auth.provider.revokeToken(f.client,{token:refreshed.refresh_token});
 await assert.rejects(f.auth.provider.verifyAccessToken(refreshed.access_token));
});
test('rejects wrong owner, redirects, audience, verifier and scope escalation',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.auth.provider.clientsStore.registerClient({redirect_uris:['https://attacker.invalid/callback'],token_endpoint_auth_method:'none'}));
 let ticket;await f.auth.provider.authorize(f.client,{redirectUri:redirect,resource:new URL(resource),codeChallenge:challenge,scopes:['food:read']},{renderConsent:v=>{ticket=v;}});
 await assert.rejects(f.auth.confirm(ticket,{username:'owner',password:'wrong'},true));
 const code=await f.code(['food:read']);
 await assert.rejects(f.auth.provider.exchangeAuthorizationCode(f.client,code,'B'.repeat(50),redirect,new URL(resource)));
 await assert.rejects(f.auth.provider.exchangeAuthorizationCode(f.client,code,verifier,redirect,new URL('https://attacker.invalid')));
 const tokens=await f.auth.provider.exchangeAuthorizationCode(f.client,code,verifier,redirect,new URL(resource));
 await assert.rejects(f.auth.provider.exchangeRefreshToken(f.client,tokens.refresh_token,['food:read','food:write'],new URL(resource)));
 f.setNow(5000);await assert.rejects(f.auth.provider.verifyAccessToken(tokens.access_token));
});
test('refresh replay revokes the token family and a second writer cannot open the store',async t=>{
 const f=await fixture(t);await assert.rejects(createFoodOAuth({stateDir:f.dir,resource,verifyOwner:async()=>true}));
 const tokens=await f.auth.provider.exchangeAuthorizationCode(f.client,await f.code(),verifier,redirect,new URL(resource));
 const next=await f.auth.provider.exchangeRefreshToken(f.client,tokens.refresh_token,undefined,new URL(resource));
 await assert.rejects(f.auth.provider.exchangeRefreshToken(f.client,tokens.refresh_token,undefined,new URL(resource)));
 await assert.rejects(f.auth.provider.verifyAccessToken(next.access_token));
});
test('issued grants survive a process-state reopen without storing raw tokens',async t=>{
 const f=await fixture(t);const tokens=await f.auth.provider.exchangeAuthorizationCode(f.client,await f.code(),verifier,redirect,new URL(resource));
 await f.auth.close();
 const reopened=await createFoodOAuth({stateDir:f.dir,resource,now:()=>1000,verifyOwner:async()=>false});
 try {
  assert.deepEqual((await reopened.provider.verifyAccessToken(tokens.access_token)).scopes,['food:read','food:write']);
  await reopened.provider.revokeToken(f.client,{token:tokens.refresh_token});
  await assert.rejects(reopened.provider.verifyAccessToken(tokens.access_token));
 } finally {await reopened.close();}
});
test('a different owner cannot reuse existing authorization state',async t=>{
 const f=await fixture(t);await f.auth.close();
 await assert.rejects(createFoodOAuth({stateDir:f.dir,resource,ownerBinding:'another-owner',verifyOwner:async()=>true}));
 const original=await createFoodOAuth({stateDir:f.dir,resource,now:()=>1000,verifyOwner:async()=>false});await original.close();
});

test('health scopes require new explicit consent and food defaults never expand',async t=>{
 const f=await fixture(t);
 const old=await f.auth.provider.exchangeAuthorizationCode(f.client,await f.code(),verifier,redirect,new URL(resource));
 await assert.rejects(f.auth.provider.exchangeRefreshToken(f.client,old.refresh_token,['food:read','health:read'],new URL(resource)));
 const defaults=await f.auth.provider.exchangeAuthorizationCode(f.client,await f.code([]),verifier,redirect,new URL(resource));assert.equal(defaults.scope,'food:read food:write');
 await assert.rejects(f.code(['health:write']));await assert.rejects(f.code(['health:read','health:read']));await assert.rejects(f.code(['health:read','unknown']));
 const fresh=await f.auth.provider.exchangeAuthorizationCode(f.client,await f.code(['health:read','health:write']),verifier,redirect,new URL(resource));assert.equal(fresh.scope,'health:read health:write');
});

test('existing ChatGPT grants and refresh remain valid after widening allowed clients', async t => {
 const f=await fixture(t);
 const tokens=await f.auth.provider.exchangeAuthorizationCode(f.client,await f.code(),verifier,redirect,new URL(resource));
 await f.auth.close();
 const reopened=await createFoodOAuth({stateDir:f.dir,resource,now:()=>1000,verifyOwner:async()=>false,validRedirect:agentRedirect,clientName:'AI client'});
 try {
  assert.deepEqual((await reopened.provider.verifyAccessToken(tokens.access_token)).scopes,['food:read','food:write']);
  const client=await reopened.provider.clientsStore.getClient(f.client.client_id);
  assert.deepEqual(client.redirect_uris,[redirect]);
  const refreshed=await reopened.provider.exchangeRefreshToken(client,tokens.refresh_token,undefined,new URL(resource));
  assert.equal(refreshed.scope,'food:read food:write');
  await assert.rejects(reopened.provider.exchangeRefreshToken(client,refreshed.refresh_token,['food:read','health:read'],new URL(resource)));
 } finally {await reopened.close();}
});
