import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFood, parseFoodCommand } from './food-agent.mjs';
const env = { HEALTH_WEBDAV_URL: 'https://dav.example/wb/', HEALTH_WEBDAV_USER: 'owner', HEALTH_WEBDAV_PASSWORD: 'private-test' };
const item = { id: 'rice-1', date: '2026-10-30', food: '米饭', grams: 200, kcal: 240 };
function fixture() {
  let records = [], rev = 1, puts = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('_settings.json')) return new Response('{"body":"private"}');
    if (init.method === 'PUT') {
      if (new Headers(init.headers).get('if-match') !== `"${rev}"`) return new Response('', { status: 412 });
      records = JSON.parse(init.body); rev++; puts++; return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(records), { headers: { ETag: `"${rev}"` } });
  };
  return { fetchImpl, puts: () => puts };
}
test('CLI structured photo add -> get -> half portion -> replay -> list', async () => {
  const f = fixture(), options = { env, fetchImpl: f.fetchImpl };
  const request = JSON.stringify({ mutation_id: 'photo-1', items: [item] });
  const added = await runFood(['food', 'add'], request, options);
  const read = await runFood(['food', 'get', 'rice-1'], '', options);
  assert.deepEqual(added.items[0], read.item);
  const patch = JSON.stringify({ mutation_id: 'half-1', expected: read.item, patch: { grams: 100 } });
  const changed = await runFood(['food', 'update', 'rice-1'], patch, options);
  assert.equal(changed.item.kcal, 120);
  assert.deepEqual(await runFood(['food', 'update', 'rice-1'], patch, options), changed);
  assert.equal((await runFood(['food', 'list', '2026-10-30'], '', options)).items.length, 1);
  assert.equal(f.puts(), 2);
});
test('input errors, incomplete credentials and arbitrary commands never invoke network', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw new Error('secret password'); };
  for (const args of [['food', 'delete', 'x'], ['food', 'list', '../../x'], ['food', 'get', '../x'], ['food', 'add', 'extra']]) {
    assert.throws(() => parseFoodCommand(args, ''));
  }
  await assert.rejects(runFood(['food', 'list'], '', { env: {}, fetchImpl }));
  await assert.rejects(runFood(['food', 'add'], '{"bad":true}', { env, fetchImpl }));
  assert.equal(calls, 0);
});
test('upstream errors do not leak secrets or automatically replay writes', async () => {
  const fetchImpl = async () => { throw new Error('private-test https://secret.invalid'); };
  await assert.rejects(runFood(['food', 'list'], '', { env, fetchImpl }), e => !/private-test|secret.invalid/.test(e.message));
});
