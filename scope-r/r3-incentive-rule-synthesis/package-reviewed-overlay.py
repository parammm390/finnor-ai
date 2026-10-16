"""Package reviewed changes and independently indexed API/worker OCI roles."""
import argparse
import ctypes
import io
import json
import os
import pathlib
import subprocess
import tarfile
from datetime import datetime, timezone

repo = pathlib.Path(__file__).resolve().parents[2]
scope = pathlib.Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('generation')
parser.add_argument('directory')
parser.add_argument('--compared-with', required=True)
parser.add_argument('--expected-changed', nargs='*', default=[])
parser.add_argument('--compiled-next')
parser.add_argument('--upstream-bytecode')
args = parser.parse_args()
work = pathlib.Path(args.directory).resolve()
prior = pathlib.Path(args.compared_with).resolve()
work.mkdir(exist_ok=False)
if args.upstream_bytecode:
    os.link(pathlib.Path(args.upstream_bytecode).resolve(), work / 'upstream-bytecode.tar.gz')
for name in ['native-callee-graft.tar.gz', 'native-callee-manifest.json']:
    os.link(prior / name, work / name)
compiled = pathlib.Path(args.compiled_next).resolve() if args.compiled_next else repo / '.r3-scratch/installed-supplier-reuse/final-next'
assert (compiled / 'BUILD_ID').is_file()
(work / 'final-next').symlink_to(compiled, target_is_directory=True)
subprocess.run(['python3', str(scope / 'package-installed-source.py'), 'source', str(work)], check=True)
before = json.loads((prior / 'source-cut.json').read_text())
cut = json.loads((work / 'source-cut.json').read_text())
previous = {f['path']: f['sha256'] for f in before['files']}
changed = [f['path'] for f in cut['files'] if previous.get(f['path']) != f['sha256']]
assert changed == sorted(args.expected_changed), changed
with (work / 'packaging.log').open('w') as log:
    subprocess.run(['python3', str(scope / 'package-source-overlay.py'), '--work-dir', str(work)], check=True, stdout=log)
manifest = json.loads((work / 'final-image-manifest.json').read_text())
manifest['sourceCut'] = cut
evidence = scope / 'evidence/repair-start'
(evidence / f'final-source-overlay-image-manifest-{args.generation}.json').write_text(json.dumps(manifest, indent=2) + '\n')
lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
lib.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
lib.clonefile.restype = ctypes.c_int
full = work / 'r3-final-source-overlay.oci.tar'
with tarfile.open(full) as archive:
    entry = archive.getmember('index.json')
    index = json.load(archive.extractfile(entry))
roles = []
for descriptor in index['manifests']:
    role = 'api' if 'r3-api:' in descriptor['annotations']['org.opencontainers.image.ref.name'] else 'worker'
    path = work / f'r3-final-{role}.oci.tar'
    assert lib.clonefile(os.fsencode(full), os.fsencode(path), 0) == 0
    with path.open('r+b') as f:
        f.truncate(entry.offset)
        f.seek(entry.offset)
        f.write(b'\0' * 1024)
    with tarfile.open(path, 'a') as archive:
        data = json.dumps({'schemaVersion': 2, 'mediaType': index['mediaType'], 'manifests': [descriptor]}).encode()
        item = tarfile.TarInfo('index.json')
        item.size = len(data)
        item.mode = 0o644
        archive.addfile(item, io.BytesIO(data))
    with tarfile.open(path) as archive:
        assert json.load(archive.extractfile('index.json'))['manifests'] == [descriptor]
    roles.append({'role': role, 'path': str(path), 'manifestDigest': descriptor['digest']})
receipt = {'at': datetime.now(timezone.utc).isoformat(), 'outputs': roles, 'copyOnWrite': True,
    'priorSourceVector': before['digest'], 'currentSourceVector': cut['digest'], 'exactChangedFiles': changed,
    'compiledBuildReused': not bool(args.compiled_next), 'compiledNext': str(compiled),
    'builtArtifactIsNotInstalledProof': True}
(evidence / f'reviewed-role-archives-{args.generation}.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
