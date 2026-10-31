import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import { appendShortTerm, closeShortTerm, readShortTerm, writeShortTerm } from '../../packages/memory/src/short-term';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '../../..');
const redisUrl = new URL(process.env.REDIS_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(redisUrl.hostname), 'Use a disposable loopback Redis server');
assert.equal(process.env.FINNOR_TEST_REDIS_DISPOSABLE, '1', 'Explicit disposable Redis acknowledgement required');

if (process.argv.includes('--child')) {
  await readShortTerm('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000', 'connection-readiness');
  process.send?.({ ready: true });
  process.once('message', async (input: unknown) => {
    try {
      const { z } = await import('zod');
      const job = z.object({ tenant: z.string().uuid(), employee: z.string().uuid(), session: z.string(), worker: z.number().int() }).parse(input);
      for (let turn = 0; turn < 2; turn += 1) {
        await appendShortTerm(job.tenant, job.employee, job.session, { id: `${job.worker}:${turn}`, nested: { empty: [], amount: Number.MAX_SAFE_INTEGER } });
      }
      process.send?.({ done: true });
    } catch (error) {
      process.send?.({ error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    } finally {
      await closeShortTerm();
      process.disconnect();
    }
  });
} else {
  const outIndex = process.argv.indexOf('--out');
  assert(outIndex >= 0 && process.argv[outIndex + 1], '--out requires an external evidence directory');
  const output = resolve(process.argv[outIndex + 1]!);
  assert(relative(root, output).startsWith('..') || isAbsolute(relative(root, output)), 'Evidence must be outside the repository');
  await mkdir(output, { recursive: true });
  const tenant = randomUUID(), employee = randomUUID(), otherEmployee = randomUUID();
  const session = randomUUID();
  const key = (suffix = '') => `stm:${tenant}:${employee}:${session}${suffix}`;
  const redis = new Redis(redisUrl.toString(), { maxRetriesPerRequest: 1 });
  const results: { id: string; status: 'PASS' | 'FAIL'; observed: unknown }[] = [];
  const inputs = { tenant, employee, otherEmployee, session, workers: 8, turnsPerWorker: 2 };
  const sources = await Promise.all(['finnor-os/packages/memory/src/short-term.ts', 'finnor-os/scripts/audits/verify-short-term-memory.mts'].map(async path => ({ path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') })));
  const save = async () => writeFile(resolve(output, 'short-term-memory.json'), JSON.stringify({ schema: 'finnor.short-term-memory-e2e.v1', generatedAt: new Date().toISOString(), inputs, sources, results, qualification: 'Actual memory module and independent Node processes against a real disposable Redis server; no SQL history or provider effects.', rerun: 'From finnor-os: REDIS_URL=<loopback disposable URL> FINNOR_TEST_REDIS_DISPOSABLE=1 node --import=tsx scripts/audits/verify-short-term-memory.mts --out <external directory>' }, null, 2));
  const check = async (id: string, run: () => Promise<unknown>) => {
    try { results.push({ id, status: 'PASS', observed: await run() }); }
    catch (error) { results.push({ id, status: 'FAIL', observed: error instanceof Error ? error.message : String(error) }); }
    await save();
  };
  try {
    await check('concurrent-appends-on-shared-client', async () => {
      await writeShortTerm(tenant, employee, session + '-same', { turns: [] });
      await Promise.all(Array.from({ length: 16 }, (_, id) => appendShortTerm(tenant, employee, session + '-same', { id })));
      const stored = await readShortTerm(tenant, employee, session + '-same');
      assert.equal(Array.isArray(stored?.turns) && stored.turns.length, 16, JSON.stringify(stored));
      return stored;
    });
    await check('concurrent-process-appends', async () => {
      await writeShortTerm(tenant, employee, session, { turns: [], metadata: { empty: [], amount: Number.MAX_SAFE_INTEGER } });
      const children = Array.from({ length: inputs.workers }, () => fork(script, ['--child'], { execArgv: ['--import=tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
      try {
        const ready = children.map(child => new Promise<void>((accept, reject) => {
          child.once('message', message => message && typeof message === 'object' && 'ready' in message ? accept() : reject(Error('Worker did not become ready')));
          child.once('error', reject);
          child.once('exit', code => { if (code) reject(Error(`Worker exited ${code}`)); });
        }));
        const completed = children.map(child => new Promise<void>((accept, reject) => {
          child.on('message', message => {
            if (message && typeof message === 'object' && 'error' in message) reject(Error(String(message.error)));
          });
          child.once('error', reject);
          child.once('exit', code => code === 0 ? accept() : reject(Error(`Worker exited ${code}`)));
        }));
        await Promise.all(ready);
        children.forEach((child, worker) => child.send({ tenant, employee, session, worker }));
        await Promise.all(completed);
      } finally { children.forEach(child => { if (child.exitCode === null) child.kill(); }); }
      const stored = await readShortTerm(tenant, employee, session);
      assert.equal(Array.isArray(stored?.turns) && stored.turns.length, inputs.workers * inputs.turnsPerWorker, JSON.stringify(stored));
      assert.deepEqual(stored?.metadata, { empty: [], amount: Number.MAX_SAFE_INTEGER });
      const { z } = await import('zod');
      const turns = z.array(z.object({ id: z.string(), nested: z.object({ empty: z.array(z.never()), amount: z.literal(Number.MAX_SAFE_INTEGER) }) })).parse(stored?.turns);
      assert.equal(new Set(turns.map(turn => turn.id)).size, 16);
      return { retained: turns.length, distinct: new Set(turns.map(turn => turn.id)).size, metadata: stored?.metadata };
    });
    await check('principal-and-tenant-isolation', async () => {
      assert.equal(await readShortTerm(tenant, otherEmployee, session), null);
      assert.equal(await readShortTerm(randomUUID(), employee, session), null);
      assert.equal(await readShortTerm(tenant, employee, randomUUID()), null);
      assert(await readShortTerm(tenant, employee, session));
      return { employee: 'isolated', tenant: 'isolated', session: 'isolated' };
    });
    await check('cap-and-adjacent-deduplication', async () => {
      for (let n = 0; n < 24; n += 1) await appendShortTerm(tenant, employee, session + '-cap', { n });
      await appendShortTerm(tenant, employee, session + '-cap', { n: 23 });
      const stored = await readShortTerm(tenant, employee, session + '-cap');
      assert.deepEqual(stored?.turns, Array.from({ length: 20 }, (_, n) => ({ n: n + 4 })));
      return stored;
    });
    await check('duplicate-refreshes-ttl', async () => {
      await redis.expire(key('-cap'), 2);
      await appendShortTerm(tenant, employee, session + '-cap', { n: 23 });
      const ttl = await redis.ttl(key('-cap'));
      assert(ttl >= 1790 && ttl <= 1800);
      return { ttlSeconds: ttl };
    });
    await check('malformed-json-fails-without-overwrite', async () => {
      await redis.set(key('-corrupt'), '{malformed');
      await assert.rejects(appendShortTerm(tenant, employee, session + '-corrupt', { id: 'must-not-overwrite' }));
      assert.equal(await redis.get(key('-corrupt')), '{malformed');
      return { corruptValuePreserved: true };
    });
  } finally {
    await redis.del(key(), key('-same'), key('-cap'), key('-corrupt'));
    await closeShortTerm();
    await redis.quit();
    await save();
  }
  console.log(JSON.stringify({ output, results }));
  if (results.some(result => result.status !== 'PASS')) process.exitCode = 1;
}
