#!/usr/bin/env python3
"""Build a review candidate. No keys, signatures, deployment or admission issued."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, datetime

repo = pathlib.Path(__file__).resolve().parents[1]
workspace = repo / 'finnor-os'
out = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repo / 'scope-6/release-candidate'
inventory = repo / 'scope-6/completion-inventory.md'
frozen = 'c45c2e5915fad5c8d0e8af2cfe9e1be76b866ef7b50ccbd830a6130a18305373'
def sha(p):
    digest = hashlib.sha256()
    with open(p, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()
if sha(inventory) != frozen:
    raise SystemExit('Frozen inventory changed; release candidate refused')
out.mkdir(parents=True, exist_ok=True)
ring0 = ['ledger.ts', 'ledger-server.mts', 'protocol.ts', 'request-verifier.ts',
         'adapter-contract.ts', 'dispatch-broker.ts', 'broker-io.ts']
authority = ['enterprise-obligations.ts', 'enterprise-allocation.ts',
             'enterprise-control.ts', 'enterprise-beliefs.ts',
             'allocation-store.ts', 'obligation-contracts.ts']
paths = [workspace / 'packages/governed-execution/src' / name for name in ring0]
ordinary = [workspace / 'packages/private-equity/src' / name for name in authority]
ordinary += [workspace / 'apps/api/app/api/obligations/[operation]/route.ts',
             workspace / 'packages/orchestration/src/request-compiler.ts',
             workspace / 'packages/orchestration/src/compiler.ts']
before = {str(p.relative_to(repo)): sha(p) for p in paths + ordinary}
install = out / 'install/finnor-os'
for source in paths + ordinary:
    destination = install / source.relative_to(workspace)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.chmod(0o644)
    shutil.copyfile(source, destination)
    destination.chmod(0o444)
node = shutil.which('node')
if not node:
    raise SystemExit('Existing Node runtime required')
runtime = json.loads(subprocess.check_output([node, '-e',
    "console.log(JSON.stringify({node:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch,execPath:process.execPath,uid:process.getuid?.(),gid:process.getgid?.()}))"], cwd=workspace, text=True))
runtime['binarySha256'] = sha(pathlib.Path(runtime['execPath']).resolve())
compiler = workspace / 'node_modules/typescript/bin/tsc'
command = [node, str(compiler), '--module', 'ESNext', '--moduleResolution', 'Bundler',
           '--target', 'ES2022', '--types', 'node', '--skipLibCheck', '--strict',
           '--rootDir', str(workspace / 'packages/governed-execution/src'),
           '--outDir', str(install / 'packages/governed-execution/src'), *map(str, paths)]
with (out / 'compile.log').open('w') as log:
    compiled = subprocess.run(command, cwd=workspace, stdout=log, stderr=subprocess.STDOUT)
if compiled.returncode:
    raise SystemExit('Protected runtime compilation failed; preserve compile.log')
for dependency in ['fs-ext']:
    source = workspace / 'node_modules' / dependency
    destination = install / 'node_modules' / dependency
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination, symlinks=False,
                    ignore=shutil.ignore_patterns('node_modules', '.git', 'test', 'tests'))
(install / 'package.json').write_text(json.dumps({'private': True, 'type': 'module',
    'description': 'Unsigned S6 review candidate; standalone compiled Ring-0 only'}, indent=2) + '\n')
after = {str(p.relative_to(repo)): sha(p) for p in paths + ordinary}
if before != after:
    raise SystemExit('Sources changed during build; candidate refused')
files = [{'path': str(p.relative_to(out)), 'sha256': sha(p), 'bytes': p.stat().st_size}
         for p in sorted(install.rglob('*')) if p.is_file()]
package_versions = {name: json.loads((workspace / 'node_modules' / name / 'package.json').read_text())['version']
                    for name in ['typescript', 'tsx', 'fs-ext', 'nan']}
mechanisms = [
 ('identity/authority verification', ['ledger.ts', 'dispatch-broker.ts', 'request-verifier.ts'], ['S6-03', 'S6-12']),
 ('tenant/isolation enforcement', ['ledger.ts', 'dispatch-broker.ts', 'adapter-contract.ts'], ['S6-04', 'S6-05', 'S6-13']),
 ('bounded IR/proof verification', ['protocol.ts', 'request-verifier.ts'], ['S6-02']),
 ('credential/capability brokerage', ['dispatch-broker.ts', 'broker-io.ts'], ['S6-04', 'S6-05']),
 ('consequential-egress enforcement', ['dispatch-broker.ts', 'broker-io.ts', 'adapter-contract.ts'], ['S6-05']),
 ('ledger authorization/integrity/references/order/receipts', ['ledger.ts', 'protocol.ts'], ['S6-11R', 'S6-14', 'S6-15', 'S6-16', 'S6-17', 'S6-18']),
 ('promotion/signature enforcement', ['ledger.ts', 'request-verifier.ts', 'dispatch-broker.ts'], ['S6-20', 'X1', 'X2']),
 ('evaluator-secret protection', ['ledger.ts', 'ledger-server.mts'], ['S6-19', 'S6-20', 'X1', 'X2']),
]
manifest = {
 'schema': 'finnor.s6.release-review-candidate.v1',
 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
 'frozenInventorySha256': frozen, 'status': 'UNSIGNED_NOT_DEPLOYED_NOT_ADMITTED',
 'sourceDigests': before, 'sourceSnapshotUnchanged': True, 'runtime': runtime,
 'dependencies': package_versions, 'packageLockSha256': sha(workspace / 'package-lock.json'),
 'compile': {'command': command, 'exitCode': compiled.returncode,
             'compilerSha256': sha(compiler), 'compilerOutsideProtectedRuntime': True},
 'files': files,
 'mechanisms': [{'name': name, 'sources': sources, 'inventoryItems': items}
                for name, sources, items in mechanisms],
 'outsideProtectedSemanticAuthority': ['business planners', 'effect producer/compiler',
    'causal/economic models', 'resource selection', 'ordinary database/storage engines',
    'learning', 'projections/queries', 'browser/Office/generated-code executors'],
 'admittedMethod': 'CONDITIONAL_JSON_RECORD_V1',
 'productionAdmission': {'established': False, 'externalDependencies': ['X1', 'X2', 'X3', 'X4']},
 'privateKeysOrCredentialsIncluded': False,
 'policyAndKeyBindings': {'installedPolicy': None, 'ledgerPublicKey': None,
    'humanReviewerPublicKey': None, 'independentS8PublicKey': None,
    'businessOwnerPublicKey': None, 'nativeOwnerPublicKey': None,
    'providerAccountOrCredential': None, 'witnessBinding': None, 'evaluatorAccess': None},
 'qualification': 'Actual compiled source/native package candidate. Null production bindings are external evidence not supplied, never invented.',
 'rerun': 'python3 scope-6/prepare-release.py',
}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'output': str(out), 'compiled': True, 'sourceSnapshotUnchanged': True,
                  'files': len(files), 'productionAdmitted': False}))
