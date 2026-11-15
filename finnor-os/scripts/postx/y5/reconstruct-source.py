"""Reconstruct safe committed source objects, then stop before snapshot commit."""
import argparse, hashlib, json, os, pathlib, re, shutil, subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
assert pathlib.Path(args.source).is_absolute() and pathlib.Path(args.output).is_absolute()
source, output = pathlib.Path(args.source).resolve(), pathlib.Path(args.output).resolve()
assert source != output and source not in output.parents and output not in source.parents
assert not output.exists(), 'Y5_RECONSTRUCTION_REQUIRES_NEW_OUTPUT'

def git(directory, *arguments, data=None):
    result = subprocess.run(['git', '-C', str(directory), *arguments], input=data,
                            capture_output=True, timeout=60)
    assert result.returncode == 0, result.stderr.decode(errors='replace')
    return result.stdout

assert pathlib.Path(git(source, 'rev-parse', '--show-toplevel').decode().strip()).resolve() == source
assert git(source, 'rev-parse', '--show-object-format').strip() == b'sha1'
git(source, 'diff', '--exit-code', 'HEAD', '--')
head = git(source, 'rev-parse', 'HEAD^{commit}').decode().strip()
tree = git(source, 'rev-parse', 'HEAD^{tree}').decode().strip()
entries, excluded, total = [], [], 0

def omit(name):
    parts = pathlib.PurePosixPath(name).parts
    return name == 'JARVIS-CREDENTIALS-LEDGER.md' or any(
        part in ('.git', '.next', '.vercel', '.cache', '.vite', 'evidence', 'node_modules')
        or part == '.env' or part.startswith('.env.') for part in parts)

for entry in git(source, 'ls-tree', '-r', '-l', '-z', '--full-tree', head).split(b'\0'):
    if not entry:
        continue
    metadata, raw_name = entry.split(b'\t', 1)
    mode, kind, oid, size = metadata.split()
    name = raw_name.decode('utf-8')
    path = pathlib.PurePosixPath(name)
    assert not path.is_absolute() and '..' not in path.parts and '.' not in path.parts
    if omit(name):
        excluded.append(name)
        continue
    assert kind == b'blob' and mode in (b'100644', b'100755', b'120000')
    size = int(size)
    assert size <= 256 * 1024 * 1024, 'Y5_RECONSTRUCTION_BLOB_BOUND'
    total += size
    assert total <= 512 * 1024 * 1024, 'Y5_RECONSTRUCTION_TOTAL_BOUND'
    entries.append({'path': name, 'mode': mode.decode(), 'gitBlob': oid.decode(), 'bytes': size})

assert entries and shutil.disk_usage(source).free >= total * 2 + 128 * 1024 * 1024
output.mkdir(mode=0o700)
target = output / 'source'
target.mkdir(mode=0o700)
git(target, 'init', '--initial-branch=y5-reconstructed-source')
batch = subprocess.Popen(['git', '-C', str(source), 'cat-file', '--batch'],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE)
index, files = [], []
try:
    for entry in entries:
        oid = entry['gitBlob'].encode()
        batch.stdin.write(oid + b'\n')
        batch.stdin.flush()
        actual_oid, kind, size = batch.stdout.readline().split()
        assert actual_oid == oid and kind == b'blob' and int(size) == entry['bytes']
        body = batch.stdout.read(entry['bytes'])
        assert len(body) == entry['bytes'] and batch.stdout.read(1) == b'\n'
        assert hashlib.sha1(b'blob ' + str(len(body)).encode() + b'\0' + body).hexdigest() == entry['gitBlob']
        destination = target / entry['path']
        destination.parent.mkdir(parents=True, exist_ok=True)
        if entry['mode'] == '120000':
            link = body.decode('utf-8')
            assert not pathlib.Path(link).is_absolute()
            resolved = (destination.parent / link).resolve()
            assert resolved == target or target in resolved.parents, 'Y5_RECONSTRUCTION_LINK_ESCAPE'
            os.symlink(link, destination)
        else:
            with destination.open('xb') as handle:
                handle.write(body)
            destination.chmod(0o755 if entry['mode'] == '100755' else 0o644)
        assert git(target, 'hash-object', '-w', '--stdin', data=body).strip() == oid
        index.append(entry['mode'].encode() + b' ' + oid + b'\t' + entry['path'].encode() + b'\0')
        files.append({**entry, 'sha256': hashlib.sha256(body).hexdigest()})
finally:
    batch.stdin.close()
    assert batch.wait(timeout=30) == 0

for entry in entries:
    if entry['mode'] == '120000':
        resolved = (target / entry['path']).resolve()
        assert resolved == target or target in resolved.parents, 'Y5_RECONSTRUCTION_FINAL_LINK_ESCAPE'

git(target, 'update-index', '-z', '--index-info', data=b''.join(index))
actual_index = []
for entry in git(target, 'ls-files', '-s', '-z').split(b'\0'):
    if entry:
        metadata, name = entry.split(b'\t', 1)
        mode, oid, stage = metadata.split()
        assert stage == b'0'
        actual_index.append((name.decode(), mode.decode(), oid.decode()))
assert sorted(actual_index) == sorted((f['path'], f['mode'], f['gitBlob']) for f in files)

manifest_path = target / 'finnor-os/packages/private-equity/src/uniform-algorithms/source-manifest.generated.ts'
emitted = json.loads(manifest_path.read_text().split('export default ', 1)[1].rsplit(' as const;', 1)[0])
by_path = {entry['path']: entry for entry in files}
for pin in emitted['files']:
    assert pin['path'] in by_path and by_path[pin['path']]['sha256'] == pin['sha256']
    assert pin['path'].isascii() and pin['sha256'].isascii()
canonical = json.dumps(emitted['files'], sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
assert hashlib.sha256(canonical).hexdigest() == emitted['sourceDigest']

model_base = 'finnor-os/packages/epistemic-runtime/src/uniform-algorithms/total/'
model_pin_path = model_base + 'model-pin.generated.ts'
model_source_path = model_base + 'Total.lean'
assert all(path in by_path for path in (model_pin_path, model_source_path)), 'Y5_RECONSTRUCTION_TOTAL_SOURCE_MISSING'
pin_match = re.search(r'export const TOTAL_MODEL_PIN\s*=\s*(\{[\s\S]*\})\s*as const;\s*$',
                      (target / model_pin_path).read_text())
assert pin_match, 'Y5_RECONSTRUCTION_TOTAL_PIN_FORMAT'
model_pin = json.loads(pin_match.group(1))
assert set(model_pin) == {'schema', 'sourceDigest', 'objectDigest', 'version',
                         'archiveDigest', 'inventoryDigest', 'identityDigest'}
assert model_pin['schema'] == 'finnor.y5.total-model-pin.v2' and model_pin['version'] == '4.34.1'
assert all(isinstance(model_pin[key], str) and re.fullmatch('[a-f0-9]{64}', model_pin[key])
           for key in ('sourceDigest', 'objectDigest', 'archiveDigest', 'inventoryDigest', 'identityDigest'))
assert by_path[model_source_path]['sha256'] == model_pin['sourceDigest'], 'Y5_RECONSTRUCTION_TOTAL_SOURCE_PIN'
source_pin_paths = {pin['path'] for pin in emitted['files']}
assert {model_pin_path, model_source_path} <= source_pin_paths, 'Y5_RECONSTRUCTION_TOTAL_SOURCE_CLOSURE'
required_runtime_sources = {
    'finnor-os/packages/private-equity/src/allocation-experience.ts',
    'finnor-os/packages/private-equity/src/allocation-total-task.ts',
    'finnor-os/packages/shared-types/src/total-algorithm-theory.ts',
    *('finnor-os/packages/epistemic-runtime/src/uniform-algorithms/' + name
      for name in ('native.ts', 'native-supervisor.mjs', 'native-sandbox.sb'))}
assert required_runtime_sources <= set(by_path), 'Y5_RECONSTRUCTION_RUNTIME_ASSET_MISSING'
assert required_runtime_sources <= source_pin_paths, 'Y5_RECONSTRUCTION_RUNTIME_ASSET_CLOSURE'
model_assets = {
    'schema': 'finnor.y5.reconstructed-total-model-prerequisite.v2',
    'pin': model_pin,
    'runtimeRoot': '.y5-tools/total-core',
    'requiredFiles': [model_pin['sourceDigest'] + '/Total.olean',
                      model_pin['sourceDigest'] + '/setup.json'],
    'sourceReconstructed': True, 'binaryOrSetupCopied': False,
    'setupDigest': None,
    'setupPolicy': 'EXPLICIT_PREPARED_SHARED_RECEIPT_REQUIRED_NOT_FREE_OR_INDEPENDENTLY_QUALIFIED',
    'missingAssetPolicy': 'REFUSE_NO_IMPLICIT_COMPILE',
    'runtimeKernelReplay': 'REQUIRED_PER_CHECK',
    'completeMoney': None, 'completeHumanSeconds': None, 'aggregatePeakBytes': None}

result = {'schema': 'finnor.y5.git-object-reconstruction.v1',
          'status': 'VERIFIED_STAGED_REVIEW_REQUIRED_NOT_YET_COMMITTED_OR_BUILT',
          'sourceCommit': head, 'sourceTree': tree, 'source': str(source),
          'reconstructedSource': str(target),
          'sanitizedSnapshotTree': git(target, 'write-tree').decode().strip(),
          'files': files, 'excludedPaths': excluded, 'totalBytes': total,
          'sourceDigest': emitted['sourceDigest'], 'sourcePinsVerified': len(emitted['files']),
          'totalModelAssets': model_assets,
          'workingTreeCopied': False, 'gitStoreCopied': False, 'hostDependenciesCopied': False,
          'configuredIdentityOverride': False, 'protectedAdmission': False,
          'completeMoney': None, 'completeHumanSeconds': None, 'aggregatePeakBytes': None}
receipt = output / 'source-object-reconstruction.json'
with receipt.open('x') as handle:
    json.dump(result, handle, indent=2)
    handle.write('\n')
receipt.chmod(0o444)
print(json.dumps({key: result[key] for key in (
    'status', 'sourceCommit', 'sourceTree', 'sanitizedSnapshotTree', 'reconstructedSource',
    'totalBytes', 'sourceDigest', 'sourcePinsVerified')}))
