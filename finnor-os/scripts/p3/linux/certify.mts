/** Executable failure-first Linux observers. No provisioning, fallback or self-admission. */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash, bytesHash, type InputArtifact } from '../../../packages/private-equity/src/branch-fabric/contracts';
import { baselineState } from '../../../packages/private-equity/src/branch-fabric/fixture';
import { programmeRef } from '../../../packages/private-equity/src/branch-fabric/registry';
import { checkCandidate } from '../../../packages/private-equity/src/branch-fabric/checker';
import { runLinuxCell, runLinuxFixtureProbe, runLinuxProbe, verifiedLinuxProfile, LinuxCellFailure,
  checkpointRunsc, restoreRunsc, ociSpec, type LinuxProfile } from '../../../packages/private-equity/src/branch-fabric/linux';
const exec = promisify(execFile), root = resolve(import.meta.dirname, '../../../..');
const output = join(root, 'scope-pm/phase-03-p3-branch-fabric/scope-evidence', 'linux-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true, mode: 0o700 });
process.env.FINNOR_P3_LINUX_CERTIFIER = '1';
process.env.NODE_ENV = 'test';
const save = async (name: string, body: unknown) => writeFile(join(output, name), JSON.stringify(body, null, 2) + '\n');
const cases: any[] = [], trips: any[] = [], began = performance.now(), before = process.resourceUsage();
let server: ReturnType<typeof createServer> | undefined;
const sources: Array<{ path: string; sha256: string }> = [];
for (const path of ['finnor-os/packages/private-equity/src/branch-fabric/linux.ts', 'finnor-os/scripts/p3/linux/README.md',
  ...['build.mjs', 'profile.mts', 'certify.mts', 'probe.mjs', 'checkpoint.mjs', 'checkpoint-observer.mjs'].map(n => 'finnor-os/scripts/p3/linux/' + n)]) {
  sources.push({ path, sha256: bytesHash(await readFile(join(root, path))) });
}
await save('pre-run.json', { at: new Date().toISOString(), sources, profilePresent: Boolean(process.env.FINNOR_P3_LINUX_PROFILE),
  platform: process.platform, node: process.version, architecturalCeilingsUnchanged: true, protectedEligible: false });
const challenge = async (id: string, input: unknown, expected: string, fn: () => Promise<unknown>) => {
  const start = performance.now(), record: any = { id, input, expected };
  try { record.observed = await fn(); record.status = 'PASS_LOCAL_LINUX'; }
  catch (e) { record.status = 'FAIL'; record.observed = e instanceof LinuxCellFailure ? { message: e.message, receipt: e.receipt } : { message: e instanceof Error ? e.message : String(e) }; }
  record.elapsedMs = performance.now() - start; cases.push(record); await save(id + '.json', record);
};
function syntheticInput(kind: InputArtifact['kind'], payload: Record<string, any>, programme: InputArtifact['programme'], source: InputArtifact['source']): InputArtifact {
  return { schema: 'finnor.branch-input.v1', tenantId: randomUUID(), principalId: randomUUID(), root: { entityType: 'external_organization', entityId: randomUUID() },
    kind, profile: 'LINUX_GVISOR_DEVELOPMENT', programme, payload, source, ownerBindings: { qualification: 'PUBLIC_CERTIFICATION_INPUT_NOT_ENTERPRISE_OWNER_ADMISSION' },
    basis: { workId: randomUUID(), inputRevision: randomUUID(), inputDigest: hash(payload), dependencyDigest: hash(source), rightsRevision: 1, validAt: '2026-01-01T00:00:00.000Z', knowledgeAt: new Date().toISOString() },
    qualification: 'PUBLIC_CERTIFICATION_INPUT_NOT_AUTHENTIC_WORK_API_OR_FINANCIAL_GRANT' };
}
async function rawCheckpoint(p: LinuxProfile) {
  const bundle = await mkdtemp(join(p.workRoot, 'checkpoint-')), runtimeRoot = join(bundle, 'runsc'), image = join(bundle, 'snapshot');
  await mkdir(runtimeRoot, { mode: 0o700 });
  const initialId = 'p3-' + randomUUID(), restoredId = 'p3-' + randomUUID(), group = join(p.cgroupRoot, initialId);
  await mkdir(group); await writeFile(join(group, 'memory.max'), String(512 * 1024 * 1024)); await writeFile(join(group, 'memory.swap.max'), '0');
  await writeFile(join(group, 'pids.max'), '32'); await writeFile(join(group, 'cpu.max'), '100000 100000');
  const spec = ociSpec(p, group); spec.process.args[1] = '/app/checkpoint.mjs';
  await writeFile(join(bundle, 'config.json'), JSON.stringify(spec));
  const flags = [`--root=${runtimeRoot}`, '--network=none', '--platform=systrap', '--file-access=exclusive'];
  const env = { PATH: '/usr/bin:/bin' }, child = spawn(p.runtimePath, [...flags, 'run', '--bundle=' + bundle, initialId], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout!.on('data', b => { stdout += b; if (stdout.length > 65536) child.kill('SIGKILL'); });
  child.stderr!.on('data', b => { stderr += b; if (stderr.length > 65536) child.kill('SIGKILL'); });
  const observe = async (id: string) => {
    const r = await exec(p.runtimePath, [...flags, 'exec', '--user=65534:65534', id, '/bin/node', '/app/checkpoint-observer.mjs'], { env, timeout: 3000, maxBuffer: 65536 });
    return JSON.parse(r.stdout);
  };
  let cleanup: any = null, observed: any;
  try {
    const deadline = Date.now() + 10000;
    while (!stdout.includes('"QUIESCENT"')) { assert(child.exitCode === null && child.signalCode === null, stderr); assert(Date.now() < deadline, 'QUIESCENT_DEADLINE'); await new Promise(ok => setTimeout(ok, 25)); }
    const before = await observe(initialId), diskDigest = hash(before.state);
    const checkpoint = await checkpointRunsc(p, runtimeRoot, initialId, image, { manifestDigest: diskDigest, quiesced: true });
    await exec(p.runtimePath, [...flags, 'delete', '--force', initialId], { env, timeout: 3000 });
    spec.process.env.push('FINNOR_P3_RESTORE_ID=' + restoredId);
    await writeFile(join(bundle, 'config.json'), JSON.stringify(spec));
    await assert.rejects(restoreRunsc(p, runtimeRoot, restoredId, image, { ...checkpoint, kernelRelease: 'incompatible' }, diskDigest));
    await restoreRunsc(p, runtimeRoot, restoredId, image, checkpoint, diskDigest);
    let after: any;
    for (let i = 0; i < 100; i++) { after = await observe(restoredId); if (after.restored) break; await new Promise(ok => setTimeout(ok, 25)); }
    assert.deepEqual(after.state, before.state); assert.notEqual(after.identity.identity, before.identity.identity);
    assert.equal(after.identity.container, restoredId); assert.equal(after.restored.identityReplaced, true);
    const file = checkpoint.imageManifest[0]!; const filePath = join(image, file.path), bytes = await readFile(filePath);
    const changed = Buffer.from(bytes); changed[0] = (changed[0] ?? 0) ^ 1; await writeFile(filePath, changed);
    await assert.rejects(restoreRunsc(p, runtimeRoot, 'p3-' + randomUUID(), image, checkpoint, diskDigest));
    observed = { before, after, checkpoint, initialId, restoredId, stdout, stderr, rawTmpfsAndMemoryRestore: true, securityIdentityReplaced: true };
  } finally {
    for (const id of [initialId, restoredId]) await exec(p.runtimePath, [...flags, 'delete', '--force', id], { env, timeout: 3000 }).catch(() => undefined);
    await writeFile(join(group, 'cgroup.kill'), '1').catch(() => undefined);
    const procs = await readFile(join(group, 'cgroup.procs'), 'utf8').catch(() => 'UNKNOWN');
    cleanup = { procs, observedStopped: procs.trim() === '', cpu: await readFile(join(group, 'cpu.stat'), 'utf8').catch(() => null),
      memoryPeak: await readFile(join(group, 'memory.peak'), 'utf8').catch(() => null) };
    await save('checkpoint-cleanup.json', cleanup);
    if (cleanup.observedStopped) { await rm(bundle, { recursive: true, force: true }); await rmdir(group).catch(() => undefined); }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  assert(cleanup.observedStopped); return { ...observed, cleanup };
}
try {
  if (process.platform !== 'linux') cases.push({ id: 'LINUX_ISOLATION', status: 'BLOCKED_EXTERNAL_UNPASSED', observed: 'DARWIN_NO_AUTHORIZED_LINUX_RUNNER', countedAsPass: false });
  else {
    const profile = await verifiedLinuxProfile(); await save('profile.json', profile);
    server = createServer((req, res) => {
      trips.push({ at: new Date().toISOString(), path: req.url, method: req.method });
      if (req.url?.startsWith('/redirect')) { res.writeHead(302, { location: '/lender/redirect' }); } else res.writeHead(200);
      res.end('{"observed":true}');
    });
    await new Promise<void>(ok => server!.listen(0, '127.0.0.1', ok)); const address = server.address(); assert(address && typeof address !== 'string');
    const port = address.port, tag = 'p3-' + randomUUID(), hostSentinel = join(profile.workRoot, 'sentinel-' + randomUUID());
    await writeFile(hostSentinel, randomUUID(), { mode: 0o600, flag: 'wx' });
    for (const stage of ['autosave', 'background', 'navigate', 'submit']) await fetch(`http://127.0.0.1:${port}/lender/${stage}?positiveControl=1`, { method: stage === 'background' || stage === 'navigate' ? 'GET' : 'POST' });
    assert.equal(trips.length, 4); await save('tripwire-positive.json', trips);
    const baseTrips = trips.length, signal = new AbortController().signal;
    const publicPayload = JSON.parse(await readFile(join(root, 'finnor-os/packages/private-equity/src/branch-fabric/fixtures/allocation.json'), 'utf8'));
    publicPayload.parameters = { equity: 95, leverageTenths: 35, reserve: 0 };
    const pure = syntheticInput('pure', publicPayload, await programmeRef('public-allocation'), { kind: 'public_fixture', fixture: 'allocation-abc-v1', parameters: publicPayload.parameters });
    await challenge('pure-native', pure, 'Exact34 with outside-cell independent check and observed cgroup teardown', async () => {
      const r = await runLinuxCell(pure, signal), check = checkCandidate(pure, r.value, hash(pure));
      assert(check.passed); assert(r.receipt.observedStopped); return { ...r, check };
    });
    await challenge('three-private-financing', { baseline: baselineState(), tag, port }, 'Independent private databases/identities and zero live tripwire effects at every stage', async () => {
      const observations = [];
      for (let i = 0; i < 3; i++) {
        const steps = [{ operation: 'autosave' as const, target: 'C_01' as const, feeCents: 2000 + i, effectId: randomUUID() },
          { operation: 'navigate' as const, target: 'C_01' as const, effectId: randomUUID() }, { operation: 'submit' as const, target: 'C_01' as const, effectId: randomUUID() }];
        const input = syntheticInput('application_fixture', { state: baselineState(), steps }, await programmeRef('financing'), { kind: 'financing_fixture', steps });
        const r = await runLinuxFixtureProbe(input, signal, port), check = checkCandidate(input, r.value, hash(input));
        assert(check.passed); assert(r.receipt.observedStopped); assert.equal(trips.length, baseTrips);
        observations.push({ input, ...r, check });
      }
      assert.equal(new Set(observations.map(r => r.value.result.identity)).size, 3);
      assert.equal(baselineState().rows[0]!.feeCents, 20000); return { observations, trips: trips.slice(baseTrips) };
    });
    for (const probe of ['egress', 'host', 'storage', 'inodes', 'output', 'memory', 'descendants', 'wall']) {
      const input = { probe, tag, tripwirePort: port, hostSentinel };
      await challenge('probe-' + probe, input, 'Denied/terminated, metered, no host effects and complete observed teardown', async () => {
        try {
          const r = await runLinuxProbe(input, signal);
          assert(['egress', 'host', 'storage', 'inodes'].includes(probe)); assert(r.value.results.length);
          assert(r.value.results.every((v: any) => v.denied)); assert(r.receipt.observedStopped);
          assert.equal(trips.length, baseTrips); return r;
        } catch (e) {
          if (!(e instanceof LinuxCellFailure) || !['output', 'memory', 'descendants', 'wall'].includes(probe)) throw e;
          assert(e.receipt.observedStopped && e.receipt.elapsedMs < 40000);
          assert.notEqual(e.receipt.sampledTreePeakRssBytes, null); assert.notEqual(e.receipt.sampledTreeCpuMs, null);
          assert.equal(trips.length, baseTrips); return { failure: e.message, receipt: e.receipt, expectedTermination: true };
        }
      });
    }
    await challenge('raw-checkpoint-fresh-restore', { profileDigest: hash(profile) }, 'Quiescent tmpfs/process state, new container and identity, mutation/compatibility refusals', () => rawCheckpoint(profile));
    await save('tripwire-after.json', { all: trips, unexpectedGuestEffects: trips.slice(baseTrips), sentinelDigest: bytesHash(await readFile(hostSentinel)) });
  }
} catch (e) { cases.push({ id: 'LINUX_SETUP', status: 'FAIL', observed: e instanceof Error ? e.message : String(e) }); }
finally {
  if (server) await new Promise<void>(ok => server!.close(() => ok()));
  const after = process.resourceUsage();
  await save('results.json', { schema: 'finnor.p3.linux-certification.v1', cases, sources, elapsedMs: performance.now() - began,
    parentUsageBefore: before, parentUsageAfter: after, moneyUSD: null, reconciliation: 'UNRECONCILED',
    isolatedAcceptedDenominator: cases.every(c => c.status === 'PASS_LOCAL_LINUX') ? 'DEVELOPMENT_MECHANICAL_DOMAIN_ONLY' : 0,
    protectedEligible: false, originalP3Comparative: 'UNPASSED', rerun: 'node --import=tsx scripts/p3/linux/certify.mts' });
  for (const source of sources) assert.equal(bytesHash(await readFile(join(root, source.path))), source.sha256);
  const files = [];
  for (const name of (await readdir(output)).sort()) { const bytes = await readFile(join(output, name)); files.push({ path: name, bytes: bytes.length, sha256: bytesHash(bytes) }); }
  await save('evidence-manifest.json', { schema: 'finnor.p3.evidence-manifest.v1', files });
  console.log(JSON.stringify({ output, cases: cases.map(c => ({ id: c.id, status: c.status })), protectedEligible: false }));
  process.exitCode = cases.every(c => c.status === 'PASS_LOCAL_LINUX') ? 0 : 1;
}
