#!/usr/bin/env node
// Thin adapter: validation and CAS writes remain in the shared health store.
import { build } from 'esbuild';
import { foodModule } from './food-agent.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
let shared;
export async function healthModule() {
  shared ??= build({ entryPoints: [fileURLToPath(new URL('../src/lib/health-service.ts', import.meta.url))], bundle: true,
    write: false, platform: 'neutral', format: 'esm', logLevel: 'silent' })
    .then(result => import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`));
  return shared;
}
function fail(message, code = 'input') { const e = new Error(message); e.code = code; throw e; }
export function dateRange(start, end) {
  for (const date of [start, end]) if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) fail('Expected valid YYYY-MM-DD dates.');
  if (start > end || (Date.parse(end)-Date.parse(start))/86400000 > 366) fail('Use an ordered date range of at most 366 days.');
  return { start, end };
}
export function boundedRows(snapshot, start, end) {
  const items = snapshot.records.filter(r => !r.deleted && (!start || r.date >= start) && (!end || r.date <= end));
  if (items.length > 1000) fail('More than 1000 records; narrow the date range.');
  return { items, total_count: items.length };
}
export async function primaryGoal(store, args) {
  if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch) || Object.hasOwn(args.patch, 'id')) fail('Goal patch must contain fields without id; the goal ID is primary.');
  if (args.expected === null) return { item: (await store.addGoals({ mutation_id: args.mutation_id, items: [{ ...args.patch, id: 'primary' }] }))[0] };
  return { item: await store.updateGoal({ mutation_id: args.mutation_id, id: 'primary', expected: args.expected, patch: args.patch }) };
}
export function parseHealthCommand(args, input = '') {
  const [kind, command, ...rest] = args;
  const valid = { health: ['context'], workout: ['list','get','add','update'], goal: ['get','set'], weight: ['list','add','update'] };
  if (!valid[kind]?.includes(command)) fail('Use health context, workout list/get/add/update, goal get/set, weight list/add/update.');
  const range = command === 'context' || command === 'list';
  if (range) { if (rest.length !== 2) fail('Provide START END explicitly.'); dateRange(...rest); }
  else if (['get','update'].includes(command) && kind !== 'goal') { if (rest.length !== 1 || !/^[\w-]{1,100}$/.test(rest[0])) fail('Expected a safe record ID.'); }
  else if (rest.length) fail('Unexpected arguments.');
  if (Buffer.byteLength(input) > 64*1024) fail('JSON input exceeds 64 KiB.');
  let body;
  if (['add','update','set'].includes(command)) {
    try { body = JSON.parse(input); } catch { fail('Expected JSON on stdin.'); }
    const fields = command === 'add' ? ['mutation_id','items'] : ['mutation_id','expected','patch'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k=>!fields.includes(k)) || fields.some(k=>body[k]===undefined)) fail('Invalid request fields.');
  } else if (input.trim()) fail('Read commands do not accept input.');
  return { kind, command, rest, body };
}
export async function runHealth(args, input = '', { env = process.env, fetchImpl = fetch } = {}) {
  const { kind, command, rest, body } = parseHealthCommand(args,input);
  const { createHealthStore } = await healthModule();
  const store = createHealthStore({ url: env.HEALTH_WEBDAV_URL, username: env.HEALTH_WEBDAV_USER, password: env.HEALTH_WEBDAV_PASSWORD },fetchImpl);
  if (kind === 'health') {
    const { createFoodStore } = await foodModule();
    const { composeHealthContext } = await healthModule();
    return composeHealthContext(store,createFoodStore({ url: env.HEALTH_WEBDAV_URL, username: env.HEALTH_WEBDAV_USER, password: env.HEALTH_WEBDAV_PASSWORD },fetchImpl),...rest);
  }
  if (kind === 'goal' && command === 'set') return primaryGoal(store,body);
  const suffix = { workout:'Workout', goal:'Goal', weight:'Weight' }[kind];
  if (command === 'add') return { items: await store['add'+suffix+'s'](body) };
  if (command === 'update') return { item: await store['update'+suffix]({...body,id:rest[0]}) };
  const snapshot = await store['read'+suffix+'s']();
  if (command === 'list') return boundedRows(snapshot,...rest);
  const item = snapshot.records.find(r=>!r.deleted && r.id===(kind==='goal'?'primary':rest[0]));
  if (!item && kind !== 'goal') fail('Record not found.','not_found');
  return { item:item ?? null };
}
export const HELP = `Health tools: health context START END; workout list START END | get ID | add | update ID; goal get | set; weight list START END | add | update ID.
Writes accept JSON stdin: add {mutation_id,items}; update/set {mutation_id,expected,patch}. goal set creates stable primary only with expected:null.
Use actual reported workouts, never training plans. Save feelings/discomfort only when reported. Ask for missing critical context. Calorie estimates require min/max and source; never invent measurements.
Use stable IDs/mutation_id and exact snapshots; after uncertainty read back and replay the original request. Inject HEALTH_WEBDAV_URL/HEALTH_WEBDAV_USER/HEALTH_WEBDAV_PASSWORD through an authorized secret provider, never arguments or files.`;
export async function main(args = process.argv.slice(2)) {
  if (args.length===1 && ['--help','-h'].includes(args[0])) { console.log(HELP);return; }
  try {
    let input='',size=0;
    if (['add','update','set'].includes(args[1])) for await (const chunk of process.stdin) { size+=Buffer.byteLength(chunk);if(size>64*1024)fail('JSON input exceeds 64 KiB.');input+=chunk; }
    console.log(JSON.stringify({ok:true,...await runHealth(args,input)}));
  } catch(e) {
    const known=['input','auth','network','http','data','conflict','version','uncertain','not_found'].includes(e.code);
    console.error(JSON.stringify({ok:false,error:{code:known?e.code:'runtime',message:known?e.message:'Health tools unavailable.',write_may_have_succeeded:e.uncertain===true}}));process.exitCode=1;
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
