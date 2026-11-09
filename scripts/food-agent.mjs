#!/usr/bin/env node
// Thin Node adapter; all food validation, mutation and storage rules live in src/lib.
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

let shared;
export async function foodModule() {
  shared ??= build({ entryPoints: [fileURLToPath(new URL('../src/lib/food-store.ts', import.meta.url))], bundle: true,
    write: false, platform: 'neutral', format: 'esm', logLevel: 'silent' })
    .then(result => import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`));
  return shared;
}
function inputError(message) { const e = new Error(message); e.code = 'input'; throw e; }
export function parseFoodCommand(args, input = '') {
  if (args[0] !== 'food' || !['list', 'get', 'add', 'update'].includes(args[1])) inputError('Use food list/get/add/update.');
  const command = args[1], target = args[2];
  if (args.length > (command === 'add' ? 2 : 3)) inputError('Unexpected arguments.');
  if (command === 'list' && target && (!/^\d{4}-\d{2}-\d{2}$/.test(target) || Number.isNaN(Date.parse(target)) || new Date(target).toISOString().slice(0, 10) !== target)) inputError('Expected a valid YYYY-MM-DD.');
  if (['get', 'update'].includes(command) && (!target || !/^[\w-]{1,100}$/.test(target))) inputError('Expected a safe record ID.');
  if (Buffer.byteLength(input) > 64 * 1024) inputError('JSON input exceeds 64 KiB.');
  let body;
  if (command === 'add' || command === 'update') {
    try { body = JSON.parse(input); } catch { inputError('Expected JSON on stdin.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) inputError('Expected JSON object.');
    const fields = command === 'add' ? ['mutation_id', 'items'] : ['mutation_id', 'expected', 'patch'];
    if (Object.keys(body).some(k => !fields.includes(k)) || fields.some(k => body[k] === undefined)) inputError('Invalid request fields.');
  } else if (input.trim()) inputError('Read commands do not accept input.');
  return { command, target, body };
}
export async function runFood(args, input = '', { env = process.env, fetchImpl = fetch } = {}) {
  const { command, target, body } = parseFoodCommand(args, input);
  const config = { url: env.HEALTH_WEBDAV_URL, username: env.HEALTH_WEBDAV_USER, password: env.HEALTH_WEBDAV_PASSWORD };
  const { createFoodStore } = await foodModule();
  const store = createFoodStore(config, fetchImpl);
  if (command === 'add') return { items: await store.add(body) };
  if (command === 'update') return { item: await store.update({ ...body, id: target }) };
  const snapshot = await store.read();
  const records = snapshot.records.filter(r => !r.deleted);
  if (command === 'get') {
    const item = records.find(r => r.id === target);
    if (!item) { const e = new Error('Food record not found.'); e.code = 'not_found'; throw e; }
    return { item };
  }
  const items = records.filter(r => !target || r.date === target);
  // No silent truncation: Dot must query a date for large collections.
  if (items.length > 200) inputError('More than 200 records; query an explicit date.');
  return { items, total_count: items.length };
}
export const HELP = `Workbench food tools (Node 20+, npm ci):
  node scripts/food-agent.mjs food list [YYYY-MM-DD]
  node scripts/food-agent.mjs food get RECORD_ID
  node scripts/food-agent.mjs food add < photo.json
  node scripts/food-agent.mjs food update RECORD_ID < change.json
Add: {"mutation_id":"stable-photo-id","items":[{"id":"stable-food-id","date":"2026-10-30","meal":"午餐","food":"米饭","grams":200,"kcal":240,"note":"照片估算"}]}
Update: {"mutation_id":"stable-change-id","expected":<exact get item>,"patch":{"grams":100}}
A grams-only patch rescales known nutrients from the original grams. Use absolute grams, never retry by halving the latest record again.
Inject HEALTH_WEBDAV_URL, HEALTH_WEBDAV_USER, HEALTH_WEBDAV_PASSWORD via the already-authorized secret provider; never in arguments, files, output or chat.
On uncertainty, get the original ID and reconcile/replay the EXACT original mutation. Never change its ID or expected snapshot to force a retry.
No photo upload/recognition is performed here: Dot estimates the photo then calls add. See docs/dot-food-tools.md.
`;
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) { console.log(HELP); return; }
  try {
    let input = '', size = 0;
    if (['add', 'update'].includes(args[1])) for await (const chunk of process.stdin) {
      size += Buffer.byteLength(chunk); if (size > 64 * 1024) inputError('JSON input exceeds 64 KiB.'); input += chunk;
    }
    console.log(JSON.stringify({ ok: true, ...await runFood(args, input) }));
  } catch (e) {
    const codes = ['input', 'auth', 'network', 'http', 'data', 'conflict', 'version', 'uncertain', 'not_found'];
    const known = codes.includes(e.code);
    console.error(JSON.stringify({ ok: false, error: { code: known ? e.code : 'runtime',
      message: known ? e.message : 'Food tools unavailable.', write_may_have_succeeded: e.uncertain === true } }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
