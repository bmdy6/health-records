import { it, expect } from 'vitest';
import { createHealthStore } from './health-store';
it('adds and replays a validated workout via conditional creation', async () => {
    let saved: string | undefined;
    let writes = 0;
    const fetcher: typeof fetch = async (url, init) => {
        if (String(url).includes('_settings'))
            return new Response('{"body":"private"}');
        if (init?.method === 'PUT') {
            expect(new Headers(init.headers).get('If-None-Match')).toBe('*');
            saved = String(init.body);
            writes++;
            return new Response(null, { status: 204 });
        }
        return saved ? new Response(saved, { headers: { etag: '"1"' } }) : new Response(null, { status: 404 });
    };
    const store = createHealthStore({ url: 'https://dav.example/', username: 'owner', password: 'test' }, fetcher, () => Date.parse('2026-10-30T04:00:00Z'));
    const req = { mutation_id: 'a', items: [{ id: 'a', date: '2026-10-30', title: '走路', durationMin: 30 }] };
    expect(await store.addWorkouts(req)).toEqual(await store.addWorkouts(req));
    expect(writes).toBe(1);
    await expect(store.addWorkouts({ ...req, items: [{ ...req.items[0], durationMin: -1 }] })).rejects.toThrow();
});
function fixture(initial: unknown = []) {
    let rows = initial, rev = 1, puts = 0, tag = 'strong', fault = '', settings = 0;
    const fetcher: typeof fetch = async (url, init) => {
        if (String(url).includes('_settings')) {
            settings++;
            return new Response(JSON.stringify({ body: fault === 'path' && settings > 1 ? 'shared' : 'private' }));
        }
        if (fault === 'broken')
            return new Response('broken');
        if (fault === 'read')
            return new Response(null, { status: 503 });
        if (init?.method === 'PUT') {
            if (new Headers(init.headers).get('If-Match') !== `"${rev}"`)
                return new Response(null, { status: 412 });
            rows = JSON.parse(String(init.body));
            rev++;
            puts++;
            if (fault === 'lost')
                throw Error('network');
            return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify(rows), { headers: tag === 'strong' ? { etag: `"${rev}"` } : tag === 'weak' ? { etag: 'W/"1"' } : {} });
    };
    return { store: createHealthStore({ url: 'https://dav.example/', username: 'owner', password: 'test' }, fetcher, () => Date.parse('2026-10-30T04:00:00Z')), puts: () => puts, rows: () => rows, fail: (s: string) => { fault = s; }, tag: (s: string) => { tag = s; }, external: (r: unknown) => { rows = r; rev++; } };
}
const draft = { id: 'w', date: '2026-10-30', title: '力量', exercises: [{ name: '深蹲', sets: 3, reps: 8, weightKg: 20 }], feeling: '轻松', discomfort: '无', calories: { min: 100, max: 150, source: '手表估算' } };
it('retains detailed workout fields and guards stale expected records', async () => { const f = fixture(); const [record] = await f.store.addWorkouts({ mutation_id: 'm', items: [draft] }); expect(record).toMatchObject(draft); f.external([{ ...record, title: '手机改动' }]); await expect(f.store.updateWorkout({ mutation_id: 'u', id: record.id, expected: record, patch: { title: '覆盖' } })).rejects.toMatchObject({ code: 'conflict' }); expect(f.puts()).toBe(1); });
it('replays updates once and rejects altered replay payload', async () => { const f = fixture(); const [record] = await f.store.addWorkouts({ mutation_id: 'm', items: [draft] }); const req = { mutation_id: 'u', id: record.id, expected: record, patch: { durationMin: 45 } }; const result = await f.store.updateWorkout(req); expect(await f.store.updateWorkout(req)).toEqual(result); await expect(f.store.updateWorkout({ ...req, patch: { durationMin: 50 } })).rejects.toThrow(); expect(f.puts()).toBe(2); });
it.each(['weak', 'none'])('refuses writes without a strong ETag (%s)', async (tag) => { const f = fixture(); f.tag(tag); await expect(f.store.addWorkouts({ mutation_id: 'm', items: [draft] })).rejects.toMatchObject({ code: 'version' }); expect(f.puts()).toBe(0); });
it.each(['broken', 'read', 'path'])('does not write on failed read or changed path (%s)', async (fault) => { const f = fixture(); f.fail(fault); await expect(f.store.addWorkouts({ mutation_id: 'm', items: [draft] })).rejects.toThrow(); expect(f.puts()).toBe(0); });
it('lost PUT receipt is uncertain and exact replay reconciles it', async () => { const f = fixture(); const req = { mutation_id: 'm', items: [draft] }; f.fail('lost'); await expect(f.store.addWorkouts(req)).rejects.toMatchObject({ uncertain: true }); f.fail(''); expect(await f.store.addWorkouts(req)).toHaveLength(1); expect(f.puts()).toBe(1); });
it('rejects impossible dates, unknown fields, invalid exercise/calorie ranges', async () => {
    for (const item of [{ ...draft, date: '2026-02-30' }, { ...draft, wat: 1 }, { ...draft, exercises: [{ name: 'x', sets: 1.2 }] }, { ...draft, calories: { min: 200, max: 100, source: '估算' } }, { ...draft, intensity: 'extreme' }]) {
        const f = fixture();
        await expect(f.store.addWorkouts({ mutation_id: 'm', items: [item as typeof draft] })).rejects.toThrow();
        expect(f.puts()).toBe(0);
    }
});
it('supports goal and legacy weight records with safe CAS', async () => { const legacy = { id: 'old', date: '2026-10-29', kg: 75, createdAt: 1, updatedAt: 1, deleted: false }; const f = fixture([legacy]); expect((await f.store.readWeights()).records).toEqual([legacy]); const changed = await f.store.updateWeight({ mutation_id: 'u', id: 'old', expected: legacy, patch: { kg: 74 } }); expect(changed.kg).toBe(74); const g = fixture(); const [goal] = await g.store.addGoals({ mutation_id: 'g', items: [{ id: 'primary', date: '2026-10-30', startKg: 75, targetKg: 70 }] }); expect(await g.store.updateGoal({ mutation_id: 'g2', id: 'primary', expected: goal, patch: { carbsG: 200 } })).toMatchObject({ carbsG: 200 }); });
it('strict profile and bounded context fail rather than report empty success', async () => { const f = fixture({}); await expect(f.store.readProfile()).rejects.toMatchObject({ code: 'data' }); await expect(f.store.healthContext('2020-01-01', '2026-10-30')).rejects.toThrow(); await expect(f.store.healthContext('2026-10-31', '2026-10-30')).rejects.toThrow(); });
it('rejects malformed stored records, duplicate identities and forged metadata', async () => { const row = { ...draft, createdAt: 1, updatedAt: 1, deleted: false }; for (const records of [[row, row], [{ ...row, deleted: 'false' }], [{ ...row, updatedAt: 0 }], [{ ...row, agentMutation: { id: 'm', fingerprint: 'bad' } }], [{ ...row, unexpected: true }]]) {
    const f = fixture(records);
    await expect(f.store.readWorkouts()).rejects.toMatchObject({ code: 'data' });
    expect(f.puts()).toBe(0);
} });
it('does not accept coerced enum and profile values', async () => { const f = fixture(); await expect(f.store.addWorkouts({ mutation_id: 'm', items: [{ ...draft, intensity: ['light'] } as never] })).rejects.toThrow(); const p = fixture({ heightCm: 175, weightKg: 75, age: 30, sex: 'male', activity: '1.2', updatedAt: 1 }); await expect(p.store.readProfile()).rejects.toMatchObject({ code: 'data' }); });
it('only HTTP404 represents absence and returns explicit coverage', async () => { const fetcher: typeof fetch = async (url) => String(url).includes('_settings') ? new Response('{"body":"private"}') : new Response(null, { status: 404 }); const store = createHealthStore({ url: 'https://dav.example/', username: 'owner', password: 'test' }, fetcher); expect(await store.readProfile()).toBeNull(); expect(await store.healthContext('2026-10-01', '2026-10-30')).toMatchObject({ workouts: [], goals: [], weights: [], profile: null, coverage: { workouts: false, goals: false, weights: false, profile: false } }); });
it('stores goals only in the Issue727 health-goals.json path', async () => { const paths: string[] = []; const fetcher: typeof fetch = async (url) => { paths.push(String(url)); return String(url).includes('_settings') ? new Response('{"body":"private"}') : new Response(null, { status: 404 }); }; const store = createHealthStore({ url: 'https://dav.example/', username: 'owner', password: 'test' }, fetcher); expect((await store.readGoals()).path).toBe('personal/owner/body/health-goals.json'); expect(paths.some(p => p.endsWith('/health-goals.json'))).toBe(true); expect(paths.some(p => p.endsWith('/body/goals.json'))).toBe(false); });
it('rejects future actual workouts and weights before any request in Shanghai date',async()=>{const calls:string[]=[];const fetcher:typeof fetch=async(url)=>{calls.push(String(url));throw Error('must not request');};const store=createHealthStore({url:'https://dav.example/',username:'owner',password:'test'},fetcher,()=>Date.parse('2026-10-30T15:59:59Z'));const workout={id:'w',date:'2026-10-31',title:'未来训练'};const weight={id:'k',date:'2026-10-31',kg:75};await expect(store.addWorkouts({mutation_id:'wa',items:[workout]})).rejects.toMatchObject({code:'input'});await expect(store.addWeights({mutation_id:'ka',items:[weight]})).rejects.toMatchObject({code:'input'});await expect(store.updateWorkout({mutation_id:'wu',id:'w',expected:{...workout,date:'2026-10-30',createdAt:1,updatedAt:1,deleted:false},patch:{date:'2026-10-31'}})).rejects.toMatchObject({code:'input'});await expect(store.updateWeight({mutation_id:'ku',id:'k',expected:{...weight,date:'2026-10-30',createdAt:1,updatedAt:1,deleted:false},patch:{date:'2026-10-31'}})).rejects.toMatchObject({code:'input'});expect(calls).toEqual([]);});
it('uses Shanghai midnight rather than UTC date for actual records',async()=>{const requests:string[]=[];const fetcher:typeof fetch=async(url)=>{requests.push(String(url));throw Error('read reached');};const store=createHealthStore({url:'https://dav.example/',username:'owner',password:'test'},fetcher,()=>Date.parse('2026-10-30T16:00:00Z'));await expect(store.addWorkouts({mutation_id:'w',items:[{id:'w',date:'2026-10-31',title:'刚练完'}]})).rejects.toMatchObject({code:'network'});await expect(store.addWeights({mutation_id:'k',items:[{id:'k',date:'2026-10-30',kg:75}]})).rejects.toMatchObject({code:'network'});expect(requests).toHaveLength(2);});
it('allows future goal starts while historical completed records remain writable',async()=>{const f=fixture();expect(await f.store.addGoals({mutation_id:'future-goal',items:[{id:'primary',date:'2027-01-01',startKg:75,targetKg:70}]})).toHaveLength(1);const h=fixture();expect(await h.store.addWorkouts({mutation_id:'historical',items:[{id:'past',date:'2026-10-29',title:'昨天散步'}]})).toHaveLength(1);const w=fixture();expect(await w.store.addWeights({mutation_id:'historical-weight',items:[{id:'past',date:'2026-10-29',kg:75}]})).toHaveLength(1);});
