/** Adverse installed-entry E2Es, specified in the pre-code installation oracle.
 * Mutations are temporary, owned byte/link changes; no SQL or service authority. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, readlinkSync, unlinkSync, symlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../../../', import.meta.url)), args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--installation' || args[2] !== '--evidence'
    || !args[1].startsWith('/') || !args[3].startsWith('/')) throw Error('X1_EXACT_INSTALLED_CONTRACT_ARGUMENTS_REQUIRED');
const installation = resolve(args[1]), evidence = resolve(args[3]);
const plan = JSON.parse(readFileSync(join(repo, 'scope-frontier5/x1-institutional-programme-compiler/verification-plan.json')));
if (dirname(evidence) !== plan.privateEvidenceRoot) throw Error('X1_FRESH_REGISTERED_PRIVATE_EVIDENCE_REQUIRED');
mkdirSync(evidence, { mode: 0o700 });
const manifestPath = join(installation, 'finnor-os/x1-development-installation.json'), bytes = readFileSync(manifestPath);
const manifest = JSON.parse(bytes), sha = value => createHash('sha256').update(value).digest('hex');
const results = [], started = Date.now();
function run(id, entry, predicate, environment = {}, cwd = join(installation, 'finnor-os')) {
  const began = Date.now(), argv = ['--max-old-space-size=512', join(installation, manifest.entrypoints[entry])];
  const child = spawnSync(process.execPath, argv, { cwd, input: '', encoding: 'utf8', timeout: 30_000,
    maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, NODE_ENV: 'test', NODE_OPTIONS: '',
      AUTH_DEV_BYPASS: '0', FINNOR_P4_PROFILE: 'ordinary_disposable', ...environment } });
  const output = (child.stdout ?? '') + (child.stderr ?? '');
  writeFileSync(join(evidence, id + '.log'), output, { flag: 'wx', mode: 0o600 });
  const row = { id, entry, argv: [process.execPath, ...argv], cwd, predicate,
    exitCode: child.status, signal: child.signal, elapsedMs: Date.now() - began,
    outputSha256: sha(output), status: !child.error && child.status !== 0 && output.includes(predicate) ? 'PASS' : 'FAIL' };
  results.push(row); assert.equal(row.status, 'PASS', id + ' must reach its intended refusal');
}
function tamper(id, path) {
  const pin = manifest.files.find(p => p.path === path); assert.ok(pin, 'independently selected declared pin');
  const full = join(installation, path), original = readFileSync(full);
  try { chmodSync(full, 0o644); writeFileSync(full, Buffer.concat([original, Buffer.from('\n ')])); chmodSync(full, pin.mode);
    run(id, 'api', 'X1_INSTALLATION_BYTE_PIN_MISMATCH:' + path);
  } finally { chmodSync(full, 0o644); writeFileSync(full, original); chmodSync(full, pin.mode); }
}
try {
  run('intact-pins-reach-missing-database', 'api', 'Invalid URL');
  for (const entry of ['api', 'worker', 'checker']) {
    run('production-refused-' + entry, entry, 'X1_COMPILED_DEVELOPMENT_PROFILE_REQUIRED', { NODE_ENV: 'production' });
    run('non-disposable-refused-' + entry, entry, 'X1_COMPILED_DEVELOPMENT_PROFILE_REQUIRED', { FINNOR_P4_PROFILE: 'staging' });
  }
  tamper('compiled-checker-byte-refusal', manifest.entrypoints.checker);
  tamper('original-source-byte-refusal', 'finnor-os/packages/private-equity/src/institution-program/source-decoder.ts');
  tamper('dependency-byte-refusal', 'finnor-os/node_modules/zod/package.json');
  const modePin=manifest.files.find(p=>p.path==='finnor-os/node_modules/zod/package.json');
  try{chmodSync(join(installation,modePin.path),modePin.mode|0o4000);
    run('special-file-mode-refusal','api','X1_INSTALLATION_FILE_MODE_MISMATCH:'+modePin.path);
  }finally{chmodSync(join(installation,modePin.path),modePin.mode);}
  try{renameSync(manifestPath,manifestPath+'.held');
    run('compiled-checker-missing-manifest-refusal','checker','X1_COMPILED_INSTALLATION_MANIFEST_REQUIRED');
  }finally{renameSync(manifestPath+'.held',manifestPath);}
  try{chmodSync(manifestPath,0o444|0o4000);
    run('manifest-special-mode-refusal','api','X1_INSTALLATION_MANIFEST_PATH_OR_MODE_REFUSED');
  }finally{chmodSync(manifestPath,0o444);}
  const outsideManifest=join(evidence,'external-same-byte-manifest.json');
  writeFileSync(outsideManifest,bytes,{flag:'wx',mode:0o444});
  try{renameSync(manifestPath,manifestPath+'.held');symlinkSync(outsideManifest,manifestPath);
    run('manifest-external-same-byte-link-refusal','api','X1_INSTALLATION_MANIFEST_PATH_OR_MODE_REFUSED');
  }finally{unlinkSync(manifestPath);renameSync(manifestPath+'.held',manifestPath);}
  const link = manifest.links.find(p => p.path === 'finnor-os/node_modules/@finnor/db'); assert.ok(link);
  const full = join(installation, link.path), target = readlinkSync(full);
  try { unlinkSync(full); symlinkSync('../../packages/tools', full);
    run('dependency-link-refusal', 'api', 'X1_INSTALLATION_LINK_PIN_MISMATCH:' + link.path);
  } finally { unlinkSync(full); symlinkSync(target, full); }
  const sentinel = join(installation, 'finnor-os/packages/private-equity/src/decision-slice/contracts.ts');
  try { renameSync(sentinel, sentinel + '.held');
    run('missing-custody-no-builder-cwd-rescue', 'api', 'CANONICAL_RUNTIME_SOURCE_TREE_UNAVAILABLE', {}, repo);
  } finally { renameSync(sentinel + '.held', sentinel); }
  run('restored-pins-reach-missing-database', 'api', 'Invalid URL');
} catch (error) { results.push({ id: 'installed-contract-driver', status: 'FAIL', predicate: error.message }); }
assert.equal(sha(readFileSync(manifestPath)), sha(bytes), 'manifest never rewritten to accept a mutation');
const record = { schema: 'finnor.x1.installed-contract-evidence.v1', source: manifest.source,
  installation, manifestDigest: sha(bytes), results, durationMs: Date.now() - started,
  status: results.every(r => r.status === 'PASS') ? 'PASS_INSTALLED_REFUSALS_ONLY' : 'FAIL',
  positiveAuthenticatedOwners: 'SEPARATE_INSTALLED_DELIVERY_REQUIRED', protectedQualification: false,
  rerun: 'node finnor-os/scripts/frontier5/x1/installed-contract-cases.mjs --installation <same-installation> --evidence <fresh-registered-private-directory>' };
writeFileSync(join(evidence, 'run.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: record.status, evidence, cases: results.length, elapsedMs: record.durationMs }));
process.exitCode = record.status === 'PASS_INSTALLED_REFUSALS_ONLY' ? 0 : 1;
