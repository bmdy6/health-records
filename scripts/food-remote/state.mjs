// Single-process durable OAuth receipts. No bearer tokens or Workbench credentials on disk.
import { mkdir, lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function openOAuthState(directory) {
  if (!path.isAbsolute(directory)) throw new Error('OAuth state directory must be absolute.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('OAuth state directory must be private (0700).');
  const lockPath = path.join(directory, 'writer.lock'), filename = path.join(directory, 'oauth.json');
  const identity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await readFile(lockPath, 'utf8'); const parsed = JSON.parse(prior);
    let alive = true;
    try { process.kill(parsed.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive || prior !== await readFile(lockPath, 'utf8')) throw new Error('OAuth state already has a writer.');
    await unlink(lockPath); lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(identity); await lock.close();
  let data = { schema: 1, clients: {}, grants: [] }, tail = Promise.resolve(), closed = false;
  try {
    const fileInfo = await lstat(filename);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || (fileInfo.mode & 0o077) || fileInfo.size > 4 * 1024 * 1024) throw new Error('Invalid OAuth state file.');
    data = JSON.parse(await readFile(filename, 'utf8'));
    if (data.schema !== 1 || !data.clients || typeof data.clients !== 'object' || Array.isArray(data.clients) || !Array.isArray(data.grants)) throw new Error('Invalid OAuth state.');
  } catch (error) { if (error.code !== 'ENOENT') { await unlink(lockPath); throw error; } }
  async function mutate(change) {
    if (closed) throw new Error('OAuth state is closed.');
    const task = tail.then(async () => {
      const next = structuredClone(data); const result = change(next);
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error('OAuth state limit exceeded.');
      const temporary = path.join(directory, `.oauth-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
        await rename(temporary, filename);
        const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
        data = next; return result;
      } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    });
    tail = task.catch(() => {}); return task;
  }
  return {
    mutate,
    async read() { await tail; if (closed) throw new Error('OAuth state is closed.'); return structuredClone(data); },
    async close() { if (closed) return; closed = true; await tail; if (await readFile(lockPath, 'utf8') === identity) await unlink(lockPath); },
  };
}
