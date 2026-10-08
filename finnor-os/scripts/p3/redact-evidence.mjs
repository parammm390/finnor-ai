/**
 * New, explicitly non-authoritative export. Never rewrites a retained receipt,
 * its original hash, a signature, a result status or a scientific observation.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const phase = join(root, 'scope-pm/phase-03-p3-branch-fabric');
const source = join(phase, 'scope-evidence'), output = join(phase, 'scope-evidence-export',
  'export-' + new Date().toISOString().replace(/[:.]/g, '-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sensitive = new Set(['token', 'claimtoken', 'leasetoken', 'readtoken', 'password', 'secret', 'apikey',
  'authtoken', 'accesstoken', 'refreshtoken', 'credential', 'privatekey', 'jwt', 'authorization']);
const pointer = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
const qualification = 'REDACTED_EXPORT_NOT_ORIGINAL_BYTES_NOT_AUTHORITY_OR_A_NEW_TEST';
function textRedaction(value, path, redactions) {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      () => { redactions.push({ path, kind: 'PRIVATE_KEY_TEXT' }); return 'xxxxxxxx'; })
    .replace(/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+/g,
      () => { redactions.push({ path, kind: 'JWT_TEXT' }); return 'xxxxxxxx'; })
    .replace(/((?:postgres|postgresql):\/\/)[^/@\s]+@/g,
      (_, scheme) => { redactions.push({ path, kind: 'DATABASE_USERINFO' }); return scheme + 'xxxxxxxx@'; })
    .replace(/((?:claimToken|leaseToken|access_token|refresh_token|password|token|authorization)\s*["']?\s*[:=]\s*["'])[^\s"']+(["'])/gi,
      (_, before, after) => { redactions.push({ path, kind: 'CREDENTIAL_TEXT_FIELD' }); return before + 'xxxxxxxx' + after; });
}
function redact(value, path, redactions) {
  if (Array.isArray(value)) return value.map((v, i) => redact(v, path + '/' + i, redactions));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => {
    const at = path + '/' + pointer(key);
    if (typeof v === 'string' && sensitive.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase())) {
      redactions.push({ path: at, kind: 'CREDENTIAL_FIELD' }); return [key, 'xxxxxxxx'];
    }
    return [key, redact(v, at, redactions)];
  }));
  return typeof value === 'string' ? textRedaction(value, path, redactions) : value;
}
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 });
const files = [];
async function visit(path = '') {
  for (const entry of await readdir(join(source, path), { withFileTypes: true })) {
    const item = join(path, entry.name);
    if (entry.isDirectory()) { await mkdir(join(output, item), { mode: 0o700 }); await visit(item); }
    else if (entry.isFile()) {
      const bytes = await readFile(join(source, item)), redactions = [];
      let value, encoding;
      if (entry.name.endsWith('.json')) {
        try { value = redact(JSON.parse(bytes.toString()), '', redactions); encoding = 'JSON_VALUE'; }
        catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
          // Incomplete historical captures stay incomplete. Do not publish an
          // unparseable credential-bearing fragment or invent its missing data.
          value = null; encoding = 'INVALID_OR_PARTIAL_JSON_RAW_CONTENT_WITHHELD';
          redactions.push({ path: '', kind: 'ORIGINAL_JSON_DECODE_FAILURE_CONTENT_WITHHELD' });
        }
      }
      else { value = textRedaction(bytes.toString(), '', redactions); encoding = 'UTF8_TEXT'; }
      const exported = Buffer.from(JSON.stringify({
        schema: 'finnor.p3.redacted-evidence-export.v1', qualification, originalRelativePath: item,
        originalBytes: bytes.length, originalSha256: sha(bytes), encoding, redactions,
        originalSignaturesAndContentDigestsReferToRawLocalBytesOnly: true, evidence: value,
      }, null, 2) + '\n');
      await writeFile(join(output, item), exported, { flag: 'wx', mode: 0o600 });
      if (sha(await readFile(join(source, item))) !== sha(bytes)) throw Error('RAW_EVIDENCE_CHANGED_DURING_EXPORT:' + item);
      files.push({ path: item, originalBytes: bytes.length, originalSha256: sha(bytes), exportBytes: exported.length,
        exportSha256: sha(exported), redactionCount: redactions.length });
    } else throw Error('EVIDENCE_EXPORT_LINK_OR_SPECIAL_FILE_REFUSED');
  }
}
await visit();
const manifest = { schema: 'finnor.p3.redaction-manifest.v1', observedAt: new Date().toISOString(), source, output,
  qualification, originalPreserved: true, originalReceiptsRemainLocalNotCommitted: true,
  originalSignaturesCannotBeVerifiedAgainstRedactedExport: true, redactedExportsAreNotNewExecutionEvidence: true,
  files, redactions: files.reduce((n, f) => n + f.redactionCount, 0), originalP3Gate: 'UNPASSED', externalWrites: [] };
await writeFile(join(output, 'redaction-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await writeFile(join(phase, 'redacted-evidence-index.json'), JSON.stringify({
  schema: 'finnor.p3.redacted-evidence-index.v1', relativeDirectory: output.slice(phase.length + 1),
  qualification, rawLocalDirectory: 'scope-evidence', rawOriginalsPreserved: true,
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, files: files.length, redactions: manifest.redactions, originalPreserved: true, qualification }));
