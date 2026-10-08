/** Verify export hashes and, when present, unchanged raw local originals. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const phase = join(root, 'scope-pm/phase-03-p3-branch-fabric');
const index = JSON.parse(await readFile(join(phase, 'redacted-evidence-index.json'), 'utf8'));
if (!index.relativeDirectory.startsWith('scope-evidence-export/') || index.relativeDirectory.split('/').includes('..')) throw Error('EXPORT_DIRECTORY_INVALID');
const directory = join(phase, index.relativeDirectory);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(join(directory, 'redaction-manifest.json')), manifest = JSON.parse(manifestBytes);
const mismatches = [], rawMissing = [], rawChanged = [];
for (const file of manifest.files) {
  if (file.path.startsWith('/') || file.path.split('/').includes('..')) throw Error('EXPORT_PATH_INVALID');
  const bytes = await readFile(join(directory, file.path));
  if (sha(bytes) !== file.exportSha256 || bytes.length !== file.exportBytes) mismatches.push(file.path);
  const wrapper = JSON.parse(bytes);
  if (wrapper.schema !== 'finnor.p3.redacted-evidence-export.v1' || wrapper.originalSha256 !== file.originalSha256 ||
    wrapper.originalRelativePath !== file.path || wrapper.qualification !== manifest.qualification) mismatches.push(file.path);
  try {
    const raw = await readFile(join(phase, 'scope-evidence', file.path));
    if (sha(raw) !== file.originalSha256 || raw.length !== file.originalBytes) rawChanged.push(file.path);
  } catch (e) { if (e.code === 'ENOENT') rawMissing.push(file.path); else throw e; }
}
const report = { schema: 'finnor.p3.redacted-export-verification.v1', observedAt: new Date().toISOString(), exportManifestSha256: sha(manifestBytes),
  files: manifest.files.length, redactions: manifest.redactions, mismatches, rawChanged, rawMissing,
  qualification: 'EXPORT_BYTE_VERIFICATION_NOT_RAW_SIGNATURE_OR_EXECUTION_ACCEPTANCE', originalP3Gate: 'UNPASSED' };
const path = join(directory, 'verification.json');
await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ path, files: report.files, mismatches: mismatches.length, rawChanged: rawChanged.length, rawMissing: rawMissing.length }));
if (mismatches.length || rawChanged.length) process.exitCode = 1;
