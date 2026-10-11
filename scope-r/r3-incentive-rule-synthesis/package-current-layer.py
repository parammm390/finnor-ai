"""Package current sources and an optional verified Linux build over frozen roles."""
import argparse
import copy
import ctypes
import gzip
import hashlib
import io
import json
import os
import pathlib
import subprocess
import tarfile
from datetime import datetime, timezone

W = pathlib.Path(__file__).resolve().parents[2]
E = pathlib.Path(__file__).resolve().parent / 'evidence'
parser = argparse.ArgumentParser()
parser.add_argument('directory')
parser.add_argument('generation')
parser.add_argument('--compiled-next')
args = parser.parse_args()
work = pathlib.Path(args.directory).resolve()
work.mkdir(exist_ok=False)
prior = W / '.r3-scratch/installed-final-tls-v20'
with (work / 'source-package.log').open('w') as log:
    subprocess.run(['python3', str(pathlib.Path(__file__).with_name('package-installed-source.py')),
                    'source', str(work)], check=True, stdout=log)
cut = json.loads((work / 'source-cut.json').read_text())
previous = json.loads((E / 'repair-start/final-source-overlay-image-manifest-v20.json').read_text())
old = {f['path']: f for f in previous['sourceCut']['files']}
changed = [f['path'] for f in cut['files'] if old.get(f['path']) != f]
assert changed == ['finnor-os/apps/api/app/api/allocations/[operation]/route.ts',
                   'finnor-os/apps/api/app/api/obligations/[operation]/route.ts',
                   'finnor-os/apps/api/next.config.mjs',
                   'finnor-os/packages/private-equity/src/index.ts'], changed
sha = lambda b: hashlib.sha256(b).hexdigest()

def add(t, name, data, mode=0o444):
    m = tarfile.TarInfo(name)
    m.uid = m.gid = 0
    m.mode = mode
    m.size = len(data)
    t.addfile(m, io.BytesIO(data))

raw = io.BytesIO()
compiled_files = []
with tarfile.open(fileobj=raw, mode='w') as output:
    with tarfile.open(work / 'current-source.tar') as source:
        for item in source:
            output.addfile(item, source.extractfile(item) if item.isfile() else None)
    add(output, 'app/r3-installed-source-cut.json', (work / 'source-cut.json').read_bytes())
    if args.compiled_next:
        compiled = pathlib.Path(args.compiled_next).resolve()
        build = json.loads((E / 'repair-start/native-error-linux-build-command.json').read_text())
        assert build['exitCode'] == 0 and build['sourceVector'] == cut['digest'] and build['typecheckingDisabled'] is False
        assert (compiled / 'BUILD_ID').is_file()
        add(output, 'app/finnor-os/apps/api/.next/.wh..wh..opq', b'', 0o000)
        for p in sorted(compiled.rglob('*')):
            if p.is_file():
                data = p.read_bytes()
                name = 'app/finnor-os/apps/api/.next/' + str(p.relative_to(compiled))
                add(output, name, data, p.stat().st_mode & 0o777)
                compiled_files.append({'path': name, 'sha256': sha(data), 'bytes': len(data)})
layer = work / 'current-overlay.tar.gz'
raw_bytes = raw.getvalue()
layer.write_bytes(gzip.compress(raw_bytes, compresslevel=3, mtime=0))
diff_id, layer_sha = sha(raw_bytes), sha(layer.read_bytes())
lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
lib.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
lib.clonefile.restype = ctypes.c_int
created = datetime.now(timezone.utc).isoformat()
outputs = []
for role in ['api', 'worker']:
    base = prior / ('r3-final-' + role + '.oci.tar')
    with tarfile.open(base) as archive:
        member = archive.getmember('index.json')
        index = json.load(archive.extractfile(member))
        descriptor = index['manifests'][0]
        original = json.load(archive.extractfile('blobs/sha256/' + descriptor['digest'].split(':')[1]))
        config = json.load(archive.extractfile('blobs/sha256/' + original['config']['digest'].split(':')[1]))
    target = work / ('r3-final-' + role + '.oci.tar')
    assert lib.clonefile(os.fsencode(base), os.fsencode(target), 0) == 0
    with target.open('r+b') as f:
        f.truncate(member.offset)
        f.seek(member.offset)
        f.write(b'\0' * 1024)
    config['created'] = created
    config['rootfs']['diff_ids'].append('sha256:' + diff_id)
    config.setdefault('history', []).append({'created': created, 'created_by': 'Exact current source and verified compiled API' if args.compiled_next else 'Current source for compiler only; stale compiled output is not functional proof'})
    c = json.dumps(config, sort_keys=True, separators=(',', ':')).encode()
    manifest = copy.deepcopy(original)
    manifest['config'] = {'mediaType': 'application/vnd.oci.image.config.v1+json', 'digest': 'sha256:' + sha(c), 'size': len(c)}
    manifest['layers'].append({'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip', 'digest': 'sha256:' + layer_sha, 'size': layer.stat().st_size})
    m = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    d = {**descriptor, 'digest': 'sha256:' + sha(m), 'size': len(m)}
    with tarfile.open(target, 'a') as archive:
        for name, data in [('blobs/sha256/' + layer_sha, layer.read_bytes()),
                           ('blobs/sha256/' + sha(c), c), ('blobs/sha256/' + sha(m), m),
                           ('index.json', json.dumps({**index, 'manifests': [d]}).encode())]:
            add(archive, name, data, 0o644)
    with tarfile.open(target) as archive:
        assert json.load(archive.extractfile('index.json'))['manifests'] == [d]
        for blob in [manifest['config'], *manifest['layers']]:
            h = hashlib.sha256()
            with archive.extractfile('blobs/sha256/' + blob['digest'].split(':')[1]) as f:
                for b in iter(lambda: f.read(1048576), b''):
                    h.update(b)
            assert 'sha256:' + h.hexdigest() == blob['digest']
    outputs.append({'role': role, 'path': str(target), 'manifestDigest': d['digest']})
receipt = {**previous, 'createdAt': created, 'images': [{'digest': o['manifestDigest'], 'role': o['role'], 'archive': o['path']} for o in outputs],
           'sourceCut': cut, 'actualLinuxBuildExit': 0 if args.compiled_next else None,
           'builderOnly': not bool(args.compiled_next), 'exactChangedFilesFromV20': changed,
           'compiledFiles': compiled_files, 'compiledOutputSourceVector': cut['digest'] if args.compiled_next else None}
(E / ('repair-start/final-source-overlay-image-manifest-' + args.generation + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'outputs': outputs, 'sourceVector': cut['digest'], 'compiledFiles': len(compiled_files), 'builderOnly': receipt['builderOnly']}))
