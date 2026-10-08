import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fault, hash, bytesHash, type InputArtifact } from './contracts';
const warm = new Map<string, { directory: string; identity: string; body: any; preparedAt: number; assigned: number }>();
const owned = new Map<string, { identity: string; createdAt: number }>();
const retentionMs = 5 * 60 * 1000;
/** Public manifest cache only. No private state/process/session is prewarmed. */
export async function cleanNativePreparation(input: InputArtifact, mode: string) {
  const publicBody = { schema: 'finnor.p3.clean-public-cell.v1', programme: input.programme, runtime: { node: process.version, binarySha256: bytesHash(await readFile(process.execPath)), platform: process.platform, architecture: process.arch }, privateStateIncluded: false, assignedIdentityIncluded: false };
  const key = hash(publicBody), began = performance.now();
  const retired = [];
  for (const [directory, cell] of owned) if (Date.now() - cell.createdAt > retentionMs) {
    try {
      await rm(directory, { recursive: true, force: true }); owned.delete(directory);
      for (const [cacheKey, candidate] of warm) if (candidate.directory === directory) warm.delete(cacheKey);
      retired.push({ preparationId: cell.identity, retainedMs: Date.now() - cell.createdAt, cleanup: 'REMOVED_OWNED_EPHEMERAL_PUBLIC_MANIFEST' });
    } catch { retired.push({ preparationId: cell.identity, cleanup: 'CLEANUP_REQUIRED', retainedMs: Date.now() - cell.createdAt }); }
  }
  let cell = mode === 'CLEAN_WARM_IMAGE' ? warm.get(key) : undefined;
  let reused = false;
  if (cell) {
    await verifyCleanCell(cell.directory, cell.body);
    reused = true;
  } else {
    const directory = await mkdtemp(join(tmpdir(), 'p3-public-clean-'));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(publicBody), { mode: 0o400, flag: 'wx' });
    cell = { directory, identity: randomUUID(), body: publicBody, preparedAt: Date.now(), assigned: 0 };
    owned.set(directory, { identity: cell.identity, createdAt: cell.preparedAt });
    await verifyCleanCell(directory, publicBody);
    if (mode === 'CLEAN_WARM_IMAGE') {
      if (warm.size >= 8) fault('PUBLIC_WARM_POOL_CAPACITY_UNAVAILABLE', 429);
      warm.set(key, cell);
    }
  }
  cell.assigned++;
  return { schema: 'finnor.p3.preparation-receipt.v1', preparationId: cell.identity, preparationDigest: key, mode, reused, assignment: cell.assigned, warmIdleMs: Date.now() - cell.preparedAt, elapsedMs: performance.now() - began, directory: cell.directory, publicManifest: publicBody, cleanBeforeAssignment: true, retired, retentionMs, publicBytes: Buffer.byteLength(JSON.stringify(publicBody)), qualification: 'PUBLIC_MODULE_MANIFEST_CACHE_NOT_PROCESS_IMAGE_OR_COW_SPEEDUP', moneyUSD: null };
}
export async function releaseNativePreparation(receipt: { preparationId: string; directory: string; mode: string }) {
  const cell = owned.get(receipt.directory);
  if (!cell || cell.identity !== receipt.preparationId) return { preparationId: receipt.preparationId, cleanup: 'OWNERSHIP_UNCONFIRMED_RETAINED', retainedMs: null };
  if (receipt.mode === 'CLEAN_WARM_IMAGE') return { preparationId: cell.identity, cleanup: 'PUBLIC_MANIFEST_RETAINED_BOUNDED_TTL', retainedMs: Date.now() - cell.createdAt, retentionMs };
  try { await rm(receipt.directory, { recursive: true, force: true }); owned.delete(receipt.directory); return { preparationId: cell.identity, cleanup: 'REMOVED_OWNED_EPHEMERAL_PUBLIC_MANIFEST', retainedMs: Date.now() - cell.createdAt }; }
  catch { return { preparationId: cell.identity, cleanup: 'CLEANUP_REQUIRED', retainedMs: Date.now() - cell.createdAt }; }
}
export async function verifyCleanCell(directory: string, expected: unknown) {
  const st = await lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || (await readdir(directory)).sort().join() !== 'manifest.json') fault('DIRTY_WARM_CELL_QUARANTINED');
  const manifest = join(directory, 'manifest.json'), s = await lstat(manifest);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 8192 || hash(JSON.parse(await readFile(manifest, 'utf8'))) !== hash(expected)) fault('CLEAN_IMAGE_IDENTITY_CHANGED');
}
/** Trusted controller shutdown only; these roots contain public manifests, no cells. */
export async function disposeNativePreparations() {
  const began = performance.now(), cells = [];
  for (const [directory, cell] of owned) {
    const cached = [...warm.values()].find(c => c.directory === directory);
    const publicBytes = cached ? Buffer.byteLength(JSON.stringify(cached.body)) : null;
    const retainedMs = Date.now() - cell.createdAt;
    try {
      await rm(directory, { recursive: true, force: true });
      owned.delete(directory);
      for (const [key, candidate] of warm) if (candidate.directory === directory) warm.delete(key);
      cells.push({ preparationId: cell.identity, assignments: cached?.assigned ?? null, publicBytes, retainedMs,
        byteMilliseconds: publicBytes === null ? null : publicBytes * retainedMs, cleanup: 'REMOVED_OWNED_EPHEMERAL_PUBLIC_MANIFEST' });
    } catch { cells.push({ preparationId: cell.identity, publicBytes, retainedMs, cleanup: 'CLEANUP_REQUIRED' }); }
  }
  return { elapsedMs: performance.now() - began, cells };
}
