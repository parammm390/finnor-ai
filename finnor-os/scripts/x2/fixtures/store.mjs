import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, lstat, unlink, rmdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const JOURNAL_LIMIT = 32 * 1024 * 1024;
export const hash = value => createHash('sha256').update(
  typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)
).digest('hex');
export const id = prefix => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('--')) out._.push(argv[index]);
    else {
      const key = argv[index].slice(2);
      if (Object.hasOwn(out, key)) throw new Error(`Duplicate option: ${key}`);
      out[key] = argv[index + 1] && !argv[index + 1].startsWith('--')
        ? argv[++index] : true;
    }
  }
  return out;
}

export async function requirePrivateDir(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw new Error('An absolute --private-dir is required');
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
    throw new Error('Custody directory must be owned by this UID and mode 0700');
  }
}

export async function privateJson(path, value, exclusive = false) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600, flag: exclusive ? 'wx' : 'w',
  });
}

export async function readJournal(directory, allowEmpty = false) {
  const path = join(directory, 'provider', 'journal.ndjson');
  let bytes;
  try {
    const info = await stat(path);
    if (info.size > JOURNAL_LIMIT) throw new Error('STORE_CAPACITY_EXCEEDED');
    bytes = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && allowEmpty) return { rows: [], state: null, digest: null };
    throw error;
  }
  if (!bytes.endsWith('\n')) throw new Error('STORE_INCOMPLETE_TAIL');
  const rows = [];
  let previousHash = null;
  for (const line of bytes.slice(0, -1).split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('STORE_INVALID_JSON'); }
    const { digest, ...core } = row;
    if (core.sequence !== rows.length + 1 || core.previousHash !== previousHash ||
        digest !== hash(core) || !Array.isArray(core.events) ||
        core.state?.schema !== 'X2.PORTAL.PRIVATE_STATE.v1') {
      throw new Error('STORE_HASH_CHAIN_INVALID');
    }
    rows.push(row);
    previousHash = digest;
  }
  if (!rows.length) throw new Error('STORE_EMPTY');
  return { rows, state: rows.at(-1).state, digest: previousHash };
}

async function lock(directory) {
  const path = join(directory, 'provider', 'writer.lock');
  const started = performance.now();
  while (true) {
    try { await mkdir(path, { mode: 0o700 }); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (performance.now() - started >= 5000) throw new Error('STORE_LOCK_TIMEOUT');
      await sleep(15);
    }
  }
  // A death between mkdir and metadata leaves an unowned lock, deliberately fail-closed.
  await privateJson(join(path, 'owner.json'), { pid: process.pid, nonce: randomUUID(), at: now() }, true);
  return async () => {
    await unlink(join(path, 'owner.json'));
    await rmdir(path);
  };
}

async function append(directory, current, state, events) {
  const core = {
    sequence: current.rows.length + 1,
    previousHash: current.digest,
    at: now(),
    events,
    state,
  };
  const line = `${JSON.stringify({ ...core, digest: hash(core) })}\n`;
  const path = join(directory, 'provider', 'journal.ndjson');
  const existing = current.rows.length ? (await stat(path)).size : 0;
  if (existing + Buffer.byteLength(line) > JOURNAL_LIMIT) throw new Error('STORE_CAPACITY_EXCEEDED');
  const file = await open(path, current.rows.length ? 'a' : 'wx', 0o600);
  try {
    await file.writeFile(line);
    await file.sync();
  } finally { await file.close(); }
}

export async function initializeJournal(directory, state) {
  const release = await lock(directory);
  try {
    const current = await readJournal(directory, true);
    if (current.state) throw new Error('Already initialized');
    await append(directory, current, state, [{ type: 'fixture.initialized', at: now() }]);
  } finally { await release(); }
}

export async function transaction(directory, execute) {
  await requirePrivateDir(directory);
  const release = await lock(directory);
  try {
    const current = await readJournal(directory);
    const state = structuredClone(current.state);
    const events = [];
    const result = await execute(state, events, current);
    if (events.length) await append(directory, current, state, events);
    return result;
  } finally { await release(); }
}

export async function snapshot(directory) {
  return transaction(directory, (state, _events, current) => ({
    state, digest: current.digest, sequence: current.rows.length,
  }));
}

export async function recoverLock(directory, writersStopped) {
  await requirePrivateDir(directory);
  if (writersStopped !== true) throw new Error('Require --writers-stopped after stopping all writers');
  const path = join(directory, 'provider', 'writer.lock');
  const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid lock owner');
  try {
    process.kill(owner.pid, 0);
    throw new Error('Lock owner is still alive; PID reuse also requires independent inspection');
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await unlink(join(path, 'owner.json'));
  await rmdir(path);
}
