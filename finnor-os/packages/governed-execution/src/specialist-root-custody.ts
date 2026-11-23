/** Root filesystem custody only. No signer, authority or qualification is minted. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { fault } from "../../capability-evolution/src/contracts";

export async function assertSpecialistRootDirectory(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) !== directory)
    fault("SPECIALIST_ROOT_DIRECTORY_REQUIRED", 503);
  let current = directory;
  for (;;) {
    const st = await lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0
      || await realpath(current) !== current) fault("SPECIALIST_ROOT_DIRECTORY_CUSTODY", 503);
    if (current === parse(current).root) return;
    current = dirname(current);
  }
}
export async function readSpecialistRootBytes(path: string, maximum: number, secret = false) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8 * 1024 * 1024
    || !isAbsolute(path) || resolve(path) !== path) fault("SPECIALIST_ROOT_FILE_BOUND", 503);
  await assertSpecialistRootDirectory(dirname(path));
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) !== 0
      || secret && (before.mode & 0o077) !== 0 || before.size < 1 || before.size > maximum)
      fault("SPECIALIST_ROOT_FILE_CUSTODY", 503);
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await fd.read(bytes, used, bytes.length - used, null);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const after = await fd.stat();
    if (used !== before.size || after.size !== before.size || after.dev !== before.dev
      || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || after.uid !== before.uid || after.mode !== before.mode || after.nlink !== 1)
      fault("SPECIALIST_ROOT_FILE_CHANGED", 503);
    return bytes.subarray(0, used);
  } finally { await fd.close(); }
}
export async function writeSpecialistRootBytesOnce(path: string, bytes: Buffer) {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0
    || bytes.length < 1 || bytes.length > 8 * 1024 * 1024
    || !isAbsolute(path) || resolve(path) !== path) fault("SPECIALIST_ROOT_WRITER_REQUIRED", 503);
  await assertSpecialistRootDirectory(dirname(path));
  // Never unlink, truncate, rename over, repair or retry a consumed identity.
  // An incomplete write remains an explicit unknown original.
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o022) !== 0 || st.size !== 0)
      fault("SPECIALIST_ROOT_CREATED_FILE_CUSTODY", 503);
    // Root commonly uses umask 077. These are public proof records, not keys.
    // Fix only this newly/exclusively created descriptor, never an existing file.
    await fd.chmod(0o444);
    await fd.writeFile(bytes); await fd.sync();
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fd.close(); }
}
