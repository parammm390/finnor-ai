/** Private fixture/evidence custody only. No runtime/admission/key bootstrap. */
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { z } from "zod";
import { byteDigest } from "../../packages/capability-evolution/src/contracts";

export function refuseQualifiedFixture(code: string): never {
  throw Object.assign(Error(code), { code });
}
export function qualifiedFixtureFailureCode(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown } | null;
  for (const code of [value?.code, value?.message])
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{4,159}$/.test(code)) return code;
  return "W2_QUALIFIED_OWNING_CALLER_FAILED";
}
async function ancestors(path: string, includeLeaf: boolean) {
  if (!isAbsolute(path) || path !== normalize(path) || path.includes("\0"))
    refuseQualifiedFixture("W2_QUALIFIED_CANONICAL_ABSOLUTE_PATH_REQUIRED");
  const root = parse(path).root;
  let at = root;
  const components = relative(root, includeLeaf ? path : dirname(path)).split(sep).filter(Boolean);
  for (const component of components) {
    at = join(at, component);
    const found = await lstat(at);
    const rootSticky = found.uid === 0 && !!(found.mode & 0o1000);
    if (!found.isDirectory() || found.isSymbolicLink() || ![0, process.getuid?.()].includes(found.uid)
      || (found.mode & 0o022) && !rootSticky)
      refuseQualifiedFixture("W2_QUALIFIED_PRIVATE_OR_ROOT_CUSTODIED_ANCESTORS_REQUIRED");
  }
}
export async function readPrivateQualifiedFixture<T extends z.ZodTypeAny>(path: string, schema: T) {
  await ancestors(path, false);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let firstFailure: { error: unknown } | undefined;
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1
      || before.mode & 0o077 || before.size <= 0 || before.size > 8 * 1024 * 1024)
      refuseQualifiedFixture("W2_QUALIFIED_PRIVATE_FIXTURE_REQUIRED");
    const bytes = await fd.readFile(), after = await fd.stat(), named = await lstat(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.uid !== before.uid || after.mode !== before.mode || after.nlink !== 1
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes.length !== before.size
      || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino)
      refuseQualifiedFixture("W2_QUALIFIED_FIXTURE_CHANGED");
    return { fixture: schema.parse(JSON.parse(bytes.toString("utf8"))) as z.infer<T>,
      fixtureSha256: byteDigest(bytes) };
  } catch (error) { firstFailure = { error }; throw error; }
  finally { try { await fd.close(); } catch (closeError) { if (!firstFailure) throw closeError; } }
}
export interface QualifiedFixtureArtifacts {
  readonly directory: string;
  write(name: string, value: unknown): Promise<Readonly<{ path: string; sha256: string }>>;
}
export async function reserveQualifiedFixtureArtifacts(directory: string): Promise<QualifiedFixtureArtifacts> {
  await ancestors(directory, false);
  const parent = await lstat(dirname(directory));
  if (parent.uid !== process.getuid?.() || parent.mode & 0o077)
    refuseQualifiedFixture("W2_QUALIFIED_PRIVATE_ARTIFACT_PARENT_REQUIRED");
  // Exclusive reservation, never reuse a failed run's directory or remove it.
  await mkdir(directory, { mode: 0o700 });
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.()
    || before.mode & 0o077) refuseQualifiedFixture("W2_QUALIFIED_PRIVATE_ARTIFACT_DIRECTORY_REQUIRED");
  return Object.freeze({
    directory,
    async write(name: string, value: unknown) {
      if (!/^[a-z0-9-]+\.json$/.test(name)) refuseQualifiedFixture("W2_QUALIFIED_FIXED_ARTIFACT_NAME_REQUIRED");
      await ancestors(directory, true);
      const current = await lstat(directory);
      if (current.dev !== before.dev || current.ino !== before.ino || current.uid !== before.uid
        || current.mode !== before.mode) refuseQualifiedFixture("W2_QUALIFIED_ARTIFACT_DIRECTORY_CHANGED");
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
      if (bytes.length > 8 * 1024 * 1024) refuseQualifiedFixture("W2_QUALIFIED_ARTIFACT_BOUND");
      const path = join(directory, name);
      const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let firstFailure: { error: unknown } | undefined;
      try {
        await fd.writeFile(bytes); await fd.sync();
        const file = await fd.stat(), named = await lstat(path), after = await lstat(directory);
        if (!file.isFile() || file.uid !== before.uid || file.nlink !== 1 || file.mode & 0o077
          || file.size !== bytes.length || named.isSymbolicLink() || named.dev !== file.dev || named.ino !== file.ino
          || after.dev !== before.dev || after.ino !== before.ino)
          refuseQualifiedFixture("W2_QUALIFIED_ARTIFACT_CUSTODY_CHANGED");
      } catch (error) { firstFailure = { error }; throw error; }
      finally { try { await fd.close(); } catch (closeError) { if (!firstFailure) throw closeError; } }
      return Object.freeze({ path, sha256: byteDigest(bytes) });
    },
  });
}
