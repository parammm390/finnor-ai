import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { fault } from './contracts';
const KeyId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const Manifest = z.object({
  schema: z.literal('finnor.p3.local-keyring.v1'), activeKeyId: KeyId,
  maxRetentionMs: z.number().int().min(1).max(90 * 86400000),
  revokedKeyIds: z.array(KeyId).max(128).default([]),
}).strict();
/** Ordinary private POSIX custody only. Not KMS, HSM, S6 or S8 authority. */
async function custodyRoot() {
  const configured = process.env.FINNOR_P3_CHECKPOINT_KEYRING;
  if (!configured || !isAbsolute(configured) || resolve(configured) !== configured) fault('CHECKPOINT_CUSTODY_REQUIRED', 503);
  for (const path of [configured, join(configured, 'keys')]) {
    const st = await lstat(path).catch(() => fault('CHECKPOINT_CUSTODY_REQUIRED', 503));
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 ||
      await realpath(path) !== path) fault('CHECKPOINT_CUSTODY_UNSAFE', 503);
  }
  return configured;
}
async function privateBytes(path: string, bound: number) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fault('CHECKPOINT_KEY_UNAVAILABLE', 503));
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || st.size > bound)
      fault('CHECKPOINT_CUSTODY_UNSAFE', 503);
    return await fd.readFile();
  } finally { await fd.close(); }
}
export async function checkpointCustody() {
  const root = await custodyRoot(), bytes = await privateBytes(join(root, 'current.json'), 16384);
  let manifest: z.infer<typeof Manifest>;
  try { manifest = Manifest.parse(JSON.parse(bytes.toString())); }
  catch { return fault('CHECKPOINT_CUSTODY_CONFIGURATION_INVALID', 503); }
  return { root, ...manifest, qualification: 'ORDINARY_LOCAL_POSIX_CUSTODY_NOT_PROTECTED_ADMISSION' as const };
}
export async function withCheckpointKey<T>(id: string | null, invoke: (bytes: Buffer, id: string) => Promise<T> | T): Promise<T> {
  const custody = await checkpointCustody(), keyId = id ?? custody.activeKeyId;
  if (!KeyId.safeParse(keyId).success) fault('CHECKPOINT_KEY_UNAVAILABLE', 503);
  if (custody.revokedKeyIds.includes(keyId)) fault('CHECKPOINT_KEY_REVOKED');
  const bytes = await privateBytes(join(custody.root, 'keys', keyId + '.key'), 32);
  try { if (bytes.length !== 32) fault('CHECKPOINT_KEY_UNAVAILABLE', 503); return await invoke(bytes, keyId); }
  finally { bytes.fill(0); }
}
