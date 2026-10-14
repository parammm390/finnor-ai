import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Development custody and finite evidence integrity, not a business-truth oracle.
export function auditScrutinyEvidence({ repo, controlRoot, source, ledgerPath }) {
  repo = realpathSync(repo);
  const checked = [], compatibility = [], root = realpathSync(controlRoot);
  const refuse = (code, detail) => { const error = new Error(`${code}: ${detail}`); error.code = code; throw error; };
  const incomplete = stages => {
    const missingStages = [...new Set(stages)].sort();
    const error = new Error(`Missing development evidence: ${missingStages.join(', ')}`);
    error.code = 'INCOMPLETE_NOT_RUN'; error.missingStages = missingStages; throw error;
  };
  const requireThat = (condition, code, detail) => { if (!condition) refuse(code, detail); };
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    requireThat(result.status === 0, 'SOURCE', 'Git read failed'); return result.stdout;
  };
  const pathWithin = (base, name) => {
    requireThat(typeof name === 'string' && name.length < 4096 && !name.includes('\\')
      && !name.split('/').includes('..'), 'PATH', 'Invalid evidence path');
    const path = resolve(base, name);
    requireThat(path.startsWith(base + sep) && realpathSync(path) === path, 'PATH', 'Evidence outside real custody root');
    return path;
  };
  const absentPath = name => {
    requireThat(typeof name === 'string' && !name.includes('\\') && !name.split('/').includes('..'), 'PATH', 'Invalid absent-evidence path');
    const path = resolve(root, name);
    requireThat(path.startsWith(root + sep), 'PATH', 'Absent-evidence reference outside root');
    let existing = path;
    while (!existsSync(existing)) {
      try { lstatSync(existing); refuse('PATH', 'Dangling evidence alias'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      existing = dirname(existing);
    }
    requireThat(realpathSync(existing) === existing, 'PATH', 'Evidence alias in absent namespace');
    return existing !== path;
  };
  const metadata = s => [s.dev, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs].join(':');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const hashFile = (path, maxBytes = 1536 * 1024 * 1024) => {
    const before = lstatSync(path, { bigint: true });
    requireThat(before.isFile() && before.size <= BigInt(maxBytes), 'FILE', 'Regular bounded file required');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      requireThat(metadata(fstatSync(fd, { bigint: true })) === metadata(before), 'FILE', 'File changed while opening');
      const hash = createHash('sha256'); let count, bytes = 0;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, count)); bytes += count; }
      requireThat(BigInt(bytes) === before.size && metadata(fstatSync(fd, { bigint: true })) === metadata(before), 'FILE', 'File changed while reading');
      return hash.digest('hex');
    } finally { closeSync(fd); }
  };
  const jsonFile = path => {
    const size = lstatSync(path).size;
    requireThat(size <= 32 * 1024 * 1024 && lstatSync(path).isFile(), 'FILE', 'Bounded regular JSON required');
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const pinned = ref => {
    requireThat(ref && /^[0-9a-f]{64}$/.test(ref.sha256), 'REQUIRED_ROLE', 'Missing evidence role or SHA256');
    const path = pathWithin(root, ref.path);
    requireThat(hashFile(path, 32 * 1024 * 1024) === ref.sha256, 'PIN', relative(root, path));
    const bytes = readFileSync(path);
    requireThat(sha(bytes) === ref.sha256, 'PIN', 'Evidence changed during JSON read');
    const value = JSON.parse(bytes); checked.push({ path: relative(root, path), sha256: ref.sha256 }); return value;
  };
  const contractPath = join(repo, 'finnor-os/scripts/frontier5/x1/reference/scrutiny-evidence-contract.json');
  const contract = jsonFile(contractPath);
  requireThat(contract.schema === 'finnor.x1.scrutiny-evidence-contract.v1', 'CONTRACT', 'Wrong contract schema');
  const requestedLedger = resolve(ledgerPath ?? join(root, 'delivery/scrutiny-ledger.json'));
  requireThat(requestedLedger.startsWith(root + sep), 'PATH', 'Ledger outside evidence root');
  if (absentPath(requestedLedger)) incomplete(['evidence-ledger']);
  const ledgerFile = pathWithin(root, requestedLedger);
  const ledgerDigest = hashFile(ledgerFile, 32 * 1024 * 1024), ledger = jsonFile(ledgerFile);
  requireThat(ledger.schema === 'finnor.x1.scrutiny-ledger.v1', 'CONTRACT', 'Wrong ledger schema');
  requireThat(ledger.protectedQualification === false && ledger.productionActive === false
    && ledger.executionAuthorityGranted === false, 'AUTHORITY', 'Development audit cannot issue authority');
  const missing = [];
  const absent = ref => {
    if (!ref || typeof ref.path !== 'string') return true;
    return absentPath(ref.path);
  };
  for (const role of Object.keys(contract.ownerPredicates)) {
    const binding = ledger.owners?.[role];
    if (!binding || ['run', 'results', 'worker'].some(name => absent(binding[name]))) missing.push(`owners.${role}`);
  }
  for (const role of ['backend', 'frontend', 'wire', 'guard', 'reconstruction', 'sourcePackage',
    'rawVerdicts', 'releaseGates', 'diagnostic', 'wholeTypes'])
    if (absent(ledger.pins?.[role])) missing.push(`pins.${role}`);
  if (missing.length) incomplete(missing);
  requireThat(ledger.source?.commit === source.commit && ledger.source?.tree === source.tree
    && git('rev-parse', 'HEAD').toString().trim() === source.commit
    && git('rev-parse', 'HEAD^{tree}').toString().trim() === source.tree
    && git('status', '--porcelain=v1', '-uall').length === 0, 'SOURCE', 'Clean exact verifier cut required');
  const currentChanges = git('diff', '--name-only', contract.runtimeAnchor, source.commit).toString().trim().split('\n').filter(Boolean);
  requireThat(currentChanges.every(path => contract.verificationOnlyPaths.includes(path)), 'SOURCE', 'Unlisted runtime-producing source drift');
  const acceptedCuts = new Set([contract.runtimeAnchor]);
  for (const transition of contract.historicalTransitions) {
    const paths = git('diff', '--name-only', transition.from, transition.to).toString().trim().split('\n').filter(Boolean);
    requireThat(transition.to === contract.runtimeAnchor
      && JSON.stringify(paths) === JSON.stringify(transition.changes.map(c => c.path)), 'SOURCE', 'Historical transition differs');
    for (const pin of transition.changes) requireThat(sha(git('show', `${transition.from}:${pin.path}`)) === pin.before
      && sha(git('show', `${transition.to}:${pin.path}`)) === pin.after, 'SOURCE', 'Historical transition preimage differs');
    acceptedCuts.add(transition.from); compatibility.push({ from: transition.from, to: transition.to, exactChangedPaths: paths });
  }
  const backend = pinned(ledger.pins?.backend), frontend = pinned(ledger.pins?.frontend);
  requireThat(backend.source?.commit === contract.runtimeAnchor && backend.source.dirty === ''
    && backend.mode === 'DEVELOPMENT_ONLY' && backend.protectedQualification === false
    && backend.productionActive === false && backend.executionAuthorityGranted === false, 'RUNTIME', 'Wrong backend source or authority');
  requireThat(frontend.mode === 'DEVELOPMENT_ONLY' && frontend.productionActive === false
    && frontend.protectedQualification === false && frontend.executionAuthorityGranted === false, 'RUNTIME', 'Wrong frontend authority');
  for (const [role, ids] of Object.entries(contract.ownerPredicates)) {
    const binding = ledger.owners?.[role];
    requireThat(binding?.run && binding?.results && binding?.worker, 'REQUIRED_ROLE', role);
    const result = pinned(binding.results), run = pinned(binding.run), worker = pinned(binding.worker);
    const observer = contract.historicalObserverDirty;
    const observedDirty = role === observer.role && result.source?.commit === observer.sourceCommit
      && result.source.dirty === observer.dirty && result.source.dirtyDiffDigest === observer.dirtyDiffDigest
      && sha(git('diff', '--binary', observer.sourceCommit, observer.committedObserverCut).toString().trim()) === observer.dirtyDiffDigest
      && result.source.pins?.some(pin => pin.path === observer.path && pin.sha256 === observer.sha256)
      && sha(git('show', `${observer.committedObserverCut}:${observer.path}`)) === observer.sha256;
    requireThat(result.status === 'PASS_LOCAL_OWNER_SLICE' && result.sourceUnchanged === true
      && (result.source?.dirty === '' || observedDirty) && acceptedCuts.has(result.source.commit)
      && run.source?.commit === result.source.commit && run.ownerResult?.sha256 === binding.results.sha256
      && run.status === 'DEVELOPMENT_NAMED_OWNER_CASE_PASS'
      && run.commands?.length > 0 && run.commands.every(c => c.exitCode === 0 && !c.signal), 'OWNER', `${role}: raw owner run failed or substituted`);
    const rows = new Map(result.results?.map(row => [row.id, row]));
    requireThat(rows.size === result.results?.length && result.results.every(row => row.status === 'PASS')
      && ids.every(id => rows.get(id)?.status === 'PASS'), 'OWNER', `${role}: missing/failed predicate`);
    for (const pin of result.source.pins ?? []) requireThat(hashFile(pathWithin(repo, pin.path)) === pin.sha256,
      'SOURCE', `${role}: original measured input changed`);
    requireThat(Array.isArray(worker.environmentNames)
      && !worker.environmentNames.some(name => name.startsWith('FINNOR_S8_')), 'OWNER', `${role}: historical S8 compatibility cannot be assumed`);
    if (role === 'installed') {
      const domain = rows.get('A-full-declared-source-and-owner-domain').observed;
      const ops = rows.get('A-all-ordinary-operations').observed;
      requireThat(domain.sourceClasses === 10 && domain.sourceInstances === 15 && domain.mappingCount === 26 && domain.canonicalKinds === 14
        && ops.nativeEffects === 3 && ops.obligationDenominator === 3 && ops.nativeCompletionSelectors === 3
        && JSON.stringify([...ops.operationClasses].sort()) === JSON.stringify(['create_deal_request', 'open_workstream', 'record_finding']), 'OWNER', 'Declared A domain differs');
      const fields = rows.get('A-eight-class-original-corpus')?.observed?.fullFieldStructure;
      requireThat(fields?.program === 14 && fields.envelope === 34, 'OWNER', 'Incomplete logical output/envelope');
      const restart = rows.get('G-compiled-installed-api-worker-checker-and-restart').observed;
      requireThat(restart.manifestDigest === ledger.pins.backend.sha256 && restart.previousWorkerPid !== restart.currentWorkerPid
        && restart.apiRestart.previousPid !== restart.apiRestart.currentPid && restart.originalReservationPreserved === true,
      'OWNER', 'Installed restart/current source proof absent');
    }
    if (role === 'upgrade') {
      const observed = rows.get('G-existing-schema-upgrade-and-jobs').observed;
      requireThat(observed.oldHead === '0171_runtime_database_role_isolation.sql' && observed.applied?.length === 18
        && observed.applied.at(-1) === '0190_x1_final_compiler_head_fence.sql'
        && observed.secondPassApplied === 0 && observed.oldRowsAndBytesPreserved === true
        && observed.newJobs.some(job => job.type === 'run_x1_institution_compiler_v1' && job.status === 'completed')
        && observed.newJobs.some(job => job.type === 'run_workflow_step_v2' && job.status === 'completed'), 'OWNER', 'Upgrade/old data/mixed jobs missing');
    }
  }
  const wire = pinned(ledger.pins.wire), finish = wire.wire?.find(row => row.event === 'X1_ACTUAL_HTTP_RESPONSE_FINISH');
  requireThat(wire.entered?.actualHandlerCompleted === true && wire.entered.capturedArtifact === true
    && wire.entered.capturedProgramme === true && wire.entered.status === 200
    && wire.released?.afterActualBrowserDenial === true && wire.released.requestId === wire.entered.requestId
    && finish?.responseStatus === 200 && finish.responseDigest === wire.entered.responseDigest
    && Date.parse(finish.at) >= Date.parse(wire.released.at) && finish.responseBytes > 0
    && wire.clientRenderingProof?.status === 'PASS'
    && ['principal-denial-clears-entire-workspace', 'late-response-no-private-resurrection', 'Retry-retains-suspended-principal-denial']
      .every(id => wire.clientRenderingProof.checks.some(c => c.id === id && c.status === 'PASS')), 'WIRE', 'Physical finish and client clearing required together');
  const guard = pinned(ledger.pins.guard);
  requireThat(guard.status === 'PASS_DETERMINISTIC_COMPILED_POLICY_GUARD_ONLY' && guard.source?.commit === contract.runtimeAnchor
    && guard.installationManifestSha256 === ledger.pins.backend.sha256 && guard.exitCode === 0
    && guard.keysPoliciesGrantsSignersOrServiceCreated === false && guard.authenticatedLifecycleAdmissionClaimed === false,
  'OWNER', 'Current compiled S8 guard absent or misrepresented');
  const reconstruction = pinned(ledger.pins.reconstruction), sourcePackage = pinned(ledger.pins.sourcePackage);
  requireThat(reconstruction.status === 'PASS' && reconstruction.source?.commit === source.commit && reconstruction.source.tree === source.tree
    && reconstruction.sourcePackageManifestSha256 === ledger.pins.sourcePackage.sha256
    && sourcePackage.source?.commit === source.commit && sourcePackage.source.tree === source.tree
    && reconstruction.builderObjectDatabaseUsed === false && reconstruction.runtimeDependenciesCopied === false
    && reconstruction.steps?.every(step => step.exitCode === 0) && reconstruction.checkedTrackedFiles === sourcePackage.trackedFiles.length,
  'RECONSTRUCTION', 'Exact standalone source reconstruction missing');
  for (const archive of sourcePackage.archives) requireThat(hashFile(pathWithin(root, join('delivery', archive.path))) === archive.sha256,
    'PIN', 'Source archive bytes differ');
  const raw = pinned(ledger.pins.rawVerdicts), gates = pinned(ledger.pins.releaseGates), diagnostic = pinned(ledger.pins.diagnostic);
  const wholeTypes = pinned(ledger.pins.wholeTypes);
  requireThat(wholeTypes.status === 'DIAGNOSIS_COMPLETE_NOT_A_BLANKET_TYPECHECK_PASS' && wholeTypes.results?.length === 2
    && wholeTypes.results.every(result => result.status === 'FAIL' && result.exitCode === -6), 'FAILURE_RETENTION', 'Original full-type boundary was hidden');
  requireThat(raw.entries?.some(entry => entry.status?.startsWith('FAIL')), 'FAILURE_RETENTION', 'Original failures absent');
  requireThat(ledger.retainedFailures?.length >= 4, 'FAILURE_RETENTION', 'Native/static/mounted/scanner failures missing');
  for (const ref of ledger.retainedFailures) {
    const failure = pinned(ref);
    requireThat(typeof failure.status === 'string' && (failure.status.includes('FAIL') || failure.status === 'INCOMPLETE_NOT_RUN'), 'FAILURE_RETENTION', 'Failure relabeled');
  }
  requireThat(gates.noProducerIssuedGlobalPass === true && contract.externalGates.every(id => typeof gates.separateGates?.[id] === 'string'
    && !/^(PASS|DOMAIN_QUALIFIED|PRODUCTION_ACTIVE|DETERMINISTICALLY_VERIFIED|EMPIRICALLY_VERIFIED)$/.test(gates.separateGates[id])),
  'AUTHORITY', 'External gate missing or self-qualified');
  const h = diagnostic.results?.find(row => row.id === 'H-matched-equipped-native-original-inputs')?.observed;
  requireThat(h?.onAccepted === 3 && h.offAccepted === 0 && ledger.diagnosticDisposition === 'PARTIAL_NO_RATIO', 'DIAGNOSTIC', 'Historical partial diagnostic misrepresented');
  const installationFiles = [];
  for (const [ref, installed] of [[ledger.pins.backend, backend], [ledger.pins.frontend, frontend]]) {
    const manifestPath = pathWithin(root, ref.path);
    const installedRoot = installed === backend ? dirname(dirname(manifestPath)) : dirname(manifestPath);
    requireThat(installed.runtime.node === process.version && installed.runtime.platform === process.platform
      && (installed.runtime.architecture ?? installed.runtime.arch) === process.arch
      && installed.runtime.nodeBinarySha256 === hashFile(realpathSync(process.execPath)), 'RUNTIME', 'Actual Node runtime differs');
    const paths = new Set(); let bytes = 0;
    requireThat(Array.isArray(installed.files) && installed.files.length > 0 && installed.files.length <= 50000, 'RUNTIME', 'Invalid installed population');
    for (const pin of installed.files) {
      requireThat(!isAbsolute(pin.path) && !paths.has(pin.path), 'RUNTIME', 'Duplicate/absolute runtime path'); paths.add(pin.path);
      const path = pathWithin(installedRoot, pin.path), stat = lstatSync(path);
      requireThat(stat.isFile() && (stat.mode & 0o7777) === pin.mode && stat.size === pin.bytes
        && hashFile(path) === pin.sha256, 'RUNTIME', 'Installed mode/bytes differ'); bytes += stat.size;
      requireThat(bytes <= 1536 * 1024 * 1024, 'RUNTIME', 'Installed byte ceiling exceeded');
    }
    for (const pin of installed.links) {
      requireThat(!isAbsolute(pin.path) && !pin.path.split('/').includes('..'), 'PATH', 'Invalid runtime link path');
      const path = resolve(installedRoot, pin.path);
      requireThat(path.startsWith(installedRoot + sep) && lstatSync(path).isSymbolicLink()
        && readlinkSync(path) === pin.target && realpathSync(path).startsWith(installedRoot + sep), 'RUNTIME', 'Runtime link escaped/substituted');
    }
    for (const pin of installed.sourcePreimages) {
      const actual = hashFile(pathWithin(repo, pin.path));
      if (actual !== (pin.generatedSha256 ?? pin.sha256)) requireThat(installed === backend
        && contract.verificationOnlyPaths.includes(pin.path) && sha(git('show', `${contract.runtimeAnchor}:${pin.path}`)) === pin.sha256,
      'SOURCE', 'Installed source preimage differs');
    }
    installationFiles.push({ source: installed.source, files: paths.size, bytes, links: installed.links.length, sourcePreimages: installed.sourcePreimages.length });
  }
  requireThat(hashFile(ledgerFile, 32 * 1024 * 1024) === ledgerDigest && git('status', '--porcelain=v1', '-uall').length === 0,
    'SOURCE', 'Ledger/source changed during audit');
  return { status: 'PASS_DEVELOPMENT_EVIDENCE_INTEGRITY_ONLY', source, runtimeSource: backend.source,
    ledgerSha256: ledgerDigest, contractSha256: hashFile(contractPath), checked, compatibility, verificationOnlyChangedPaths: currentChanges,
    installationFiles, protectedQualification: false, productionActive: false, executionAuthorityGranted: false,
    limitations: ['Native independent feature review/user testing remains separate.', 'Historical receipts keep original cuts; exact compatibility is limited to the declared transitions.',
      'Protected population/S8/S6 authority/100x/H2 remain unestablished.', 'Historical H is PARTIAL: on3/off0, no gain ratio.',
      'Original FAILs and whole-backend OOM remain failures; full-backend types, monetary/human/aggregate memory qualification are not established.'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error('No arbitrary evidence/configuration arguments accepted');
    const repo = fileURLToPath(new URL('../../../../', import.meta.url));
    const plan = JSON.parse(readFileSync(join(repo, 'scope-frontier5/x1-institutional-programme-compiler/verification-plan.json'), 'utf8'));
    const git = expression => {
      const child = spawnSync('git', ['-C', repo, 'rev-parse', expression], { encoding: 'utf8', timeout: 5000 });
      if (child.status !== 0) throw Error('Cannot resolve verifier cut'); return child.stdout.trim();
    };
    process.stdout.write(JSON.stringify(auditScrutinyEvidence({ repo, controlRoot: dirname(plan.privateEvidenceRoot),
      source: { commit: git('HEAD'), tree: git('HEAD^{tree}') } })) + '\n');
  } catch (error) {
    const incomplete = error.code === 'INCOMPLETE_NOT_RUN';
    process.stdout.write(JSON.stringify({ status: incomplete ? 'INCOMPLETE_NOT_RUN' : 'FAIL',
      code: error.code ?? 'EVIDENCE_ERROR', reason: error.message,
      ...(incomplete ? { missingStages: error.missingStages } : {}) }) + '\n');
    process.exitCode = incomplete ? 2 : 1;
  }
}
