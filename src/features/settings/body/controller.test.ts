import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { WebDavConfig } from '../../../lib/webdav';
import type { BodyProfile } from '../../../types';
const sample: BodyProfile = { heightCm:175,weightKg:70,age:28,sex:'male',activity:1.375,updatedAt:1 };
const env=vi.hoisted(()=>({
 config:{url:'https://fixture-a.invalid/',username:'fixture-a',password:'test-only'} as WebDavConfig|null,revision:0,
 reads:[] as string[],writes:[] as {user:string;profile:BodyProfile}[],
 get:vi.fn<(path:string)=>Promise<string>>(),put:vi.fn<()=>Promise<void>>(),
}));
vi.mock('../../../lib/webdav',()=>({
 getConfig:()=>env.config,getConfigRevision:()=>env.revision,
 createDavClient:(cfg:WebDavConfig)=>({
  getFileContents:async(path:string)=>{env.reads.push(path);return env.get(path);},
  putFileContents:async(_path:string,data:string)=>{env.writes.push({user:cfg.username,profile:JSON.parse(data)});await env.put();},
 }),
}));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function make(config:WebDavConfig|null=env.config){return (await import('./controller')).createBodySettingsController(config);}
beforeEach(()=>{
 vi.resetModules();env.config={url:'https://fixture-a.invalid/',username:'fixture-a',password:'test-only'};env.revision=0;env.reads=[];env.writes=[];
 env.get.mockReset().mockImplementation(async path=>JSON.stringify(path.endsWith('_settings.json')?{body:'private'}:sample));
 env.put.mockReset().mockResolvedValue(undefined);
});
afterEach(()=>vi.useRealTimers());
describe('body settings lifecycle',()=>{
 it('loads the original form and confirmed profile',async()=>{
  const c=await make();await c.start();expect(c.getSnapshot()).toMatchObject({phase:'ready',form:{h:'175',w:'70',age:'28',sex:'male',activity:1.375,goalMode:'maintain',kcalOverride:'',proteinOverride:''},profile:sample});c.dispose();
 });
 it('uses editable defaults only when a profile is missing',async()=>{
  env.get.mockImplementation(async path=>{if(path.endsWith('profile.json'))throw Object.assign(new Error('missing'),{status:404});return '{}';});
  const c=await make();await c.start();expect(c.getSnapshot()).toMatchObject({phase:'ready',profile:null,form:{h:'175',w:'70'}});expect(await c.save()).toBe(true);c.dispose();
 });
 it('blocks saving after load failure and recovers with explicit reload',async()=>{
  env.get.mockImplementation(async path=>{if(path.endsWith('profile.json'))throw new Error('network');return '{}';});
  const c=await make();await c.start();expect(c.getSnapshot().phase).toBe('error');expect(await c.save()).toBe(false);expect(env.writes).toEqual([]);
  env.get.mockResolvedValue(JSON.stringify(sample));await c.reload();expect(c.getSnapshot().phase).toBe('ready');c.dispose();
 });
 it('rejects invalid required values and overrides without a write',async()=>{
  const c=await make();await c.start();
  for(const [key,value] of [['h',''],['h','0'],['h','NaN'],['age','28.5'],['kcalOverride','0'],['proteinOverride','-1']] as const){
   c.updateField('h','175');c.updateField('age','28');c.updateField('kcalOverride','');c.updateField('proteinOverride','');c.updateField(key,value);expect(await c.save()).toBe(false);
  }
  expect(env.writes).toEqual([]);c.dispose();
 });
 it('confirms daily needs only after successful save',async()=>{
  const wait=deferred<void>();env.put.mockReturnValueOnce(wait.promise);const c=await make();await c.start();c.updateField('w','75');c.updateField('kcalOverride','1800');
  const saving=c.save();await vi.waitFor(()=>expect(env.writes).toHaveLength(1));expect(c.getSnapshot()).toMatchObject({phase:'saving',profile:{weightKg:70}});
  wait.resolve();expect(await saving).toBe(true);expect(c.getSnapshot()).toMatchObject({phase:'ready',profile:{weightKg:75,kcalOverride:1800},message:'已保存，每日目标已更新'});c.dispose();
 });
 it('deduplicates a second save while a PUT is pending',async()=>{
  const wait=deferred<void>();env.put.mockReturnValueOnce(wait.promise);const c=await make();await c.start();const first=c.save();expect(await c.save()).toBe(false);wait.resolve();await first;expect(env.writes).toHaveLength(1);c.dispose();
 });
 it('retains the draft and previous confirmed profile on a failed save',async()=>{
  env.put.mockRejectedValueOnce(new Error('503'));const c=await make();await c.start();c.updateField('w','76');expect(await c.save()).toBe(false);
  expect(c.getSnapshot()).toMatchObject({phase:'ready',form:{w:'76'},profile:{weightKg:70},message:'保存失败，请重试'});
  expect(await c.save()).toBe(true);expect(c.getSnapshot().profile?.weightKg).toBe(76);c.dispose();
 });
 it('ignores a late read after dispose',async()=>{
  const wait=deferred<string>();env.get.mockReturnValueOnce(wait.promise);const c=await make();const listener=vi.fn();c.subscribe(listener);const loading=c.start();c.dispose();listener.mockClear();wait.resolve('{}');await loading;
  expect(env.reads).toHaveLength(1);expect(listener).not.toHaveBeenCalled();expect(await c.save()).toBe(false);
 });
 it('ignores the previous binding response and cannot subsequently save it',async()=>{
  const wait=deferred<string>();env.get.mockReturnValueOnce(wait.promise);const c=await make();const loading=c.start();env.config={url:'https://fixture-b.invalid/',username:'fixture-b',password:'test-only'};env.revision++;wait.resolve('{}');await loading;
  expect(c.getSnapshot().profile).toBeNull();expect(await c.save()).toBe(false);expect(env.writes).toEqual([]);c.dispose();
 });
 it('invalidates clear and rebind to the same credentials',async()=>{
  const c=await make();await c.start();env.revision+=2;expect(await c.save()).toBe(false);expect(env.writes).toEqual([]);c.dispose();
 });
 it('finishes an issued PUT at the old binding without publishing success',async()=>{
  const wait=deferred<void>();env.put.mockReturnValueOnce(wait.promise);const c=await make();await c.start();c.updateField('w','77');const saving=c.save();await vi.waitFor(()=>expect(env.writes).toHaveLength(1));env.config={url:'https://fixture-b.invalid/',username:'fixture-b',password:'test-only'};env.revision++;wait.resolve();expect(await saving).toBe(false);
  expect(env.writes[0].user).toBe('fixture-a');expect(c.getSnapshot().profile?.weightKg).toBe(70);expect(c.getSnapshot().message).not.toContain('已保存');c.dispose();
 });
 it('rereads shared routing after identical credentials are rebound',async()=>{
  const old=await make();await old.start();old.dispose();env.revision+=2;env.reads=[];
  env.get.mockImplementation(async path=>JSON.stringify(path.endsWith('_settings.json')?{body:'shared'}:sample));
  const current=await make();await current.start();expect(env.reads).toContain('bills/_settings.json');expect(env.reads).toContain('bills/body/profile.json');await current.save();expect(env.writes[0].user).toBe('fixture-a');current.dispose();
 });
 it.each(['false','0','""','[]','null'])('blocks a malformed persisted profile %s',async json=>{
  env.get.mockImplementation(async path=>path.endsWith('profile.json')?json:'{}');const c=await make();await c.start();expect(c.getSnapshot().phase).toBe('error');expect(await c.save()).toBe(false);expect(env.writes).toEqual([]);c.dispose();
 });
 it('clears the success timer on dispose',async()=>{
  vi.useFakeTimers();const c=await make();await c.start();await c.save();expect(vi.getTimerCount()).toBe(1);c.dispose();expect(vi.getTimerCount()).toBe(0);
 });
 it.each([null,{url:'https://fixture.invalid/',username:'shared-viewer',password:'test-only'}])('never reads or saves for unauthorized binding %s',async cfg=>{
  env.config=cfg;const c=await make(cfg);await c.start();expect(await c.save()).toBe(false);expect(env.reads).toEqual([]);expect(env.writes).toEqual([]);c.dispose();
 });
});
