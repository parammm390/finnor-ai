"""Add verified Debian TLS tools without replacing existing product/runtime bytes."""
import copy
import ctypes
import gzip
import hashlib
import io
import json
import os
import pathlib
import posixpath
import subprocess
import tarfile
from datetime import datetime, timezone

W = pathlib.Path(__file__).resolve().parents[2]
E = pathlib.Path(__file__).resolve().parent / 'evidence'
prior = W / '.r3-scratch/installed-final-owner-resolution-v19'
work = W / '.r3-scratch/installed-final-tls-v20'
supplier = E / 'openssl-supplier-02'
work.mkdir(exist_ok=False)
sha = lambda b: hashlib.sha256(b).hexdigest()
with (work / 'source-package.log').open('w') as log:
    subprocess.run(['python3', str(pathlib.Path(__file__).with_name('package-installed-source.py')),
                    'source', str(work)], check=True, stdout=log)
cut = json.loads((work / 'source-cut.json').read_text())
before = json.loads((prior / 'source-cut.json').read_text())
old = {f['path']: f for f in before['files']}
changed = [f['path'] for f in cut['files'] if old.get(f['path']) != f]
assert changed == ['finnor-os/Dockerfile.worker'], changed
acquisition = json.loads((supplier / 'acquisition.json').read_text())
assert acquisition['status'] == 'PASS' and acquisition['signedAptIndexVerified']
records = []
layer = work / 'tls-overlay.tar.gz'

def add_bytes(t, name, data, mode=0o444):
    m = tarfile.TarInfo(name)
    m.uid = m.gid = 0
    m.mode = mode
    m.size = len(data)
    t.addfile(m, io.BytesIO(data))

raw = io.BytesIO()
with tarfile.open(fileobj=raw, mode='w') as output:
    for package in acquisition['packages']:
        deb = supplier / package['file']
        assert sha(deb.read_bytes()) == package['sha256']
        data = subprocess.check_output(['ar', 'p', str(deb), 'data.tar.xz'])
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as source:
            for item in source:
                name = item.name.removeprefix('./').rstrip('/')
                if not name:
                    continue
                assert not name.startswith('/') and '..' not in pathlib.PurePosixPath(name).parts
                assert item.isfile() or item.isdir() or item.issym(), name
                item.name = name
                item.uid = item.gid = 0
                if not item.issym():
                    assert item.mode & 0o022 == 0, name
                body = source.extractfile(item).read() if item.isfile() else None
                if item.issym():
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(name), item.linkname))
                    assert not target.startswith('../'), (name, item.linkname)
                output.addfile(item, io.BytesIO(body) if body is not None else None)
                if body is not None or item.issym():
                    records.append({'path': '/' + name, 'package': package['name'],
                                    'mode': item.mode, 'sha256': sha(body) if body is not None else None,
                                    'bytes': len(body) if body is not None else None,
                                    'symlink': item.linkname if item.issym() else None})
    tls = {'schema': 'finnor.r3.disposable-tls-runtime.v1', 'packages': acquisition['packages'],
           'files': records, 'originalProductOrScientificBytesReplaced': False,
           'qualification': 'ORDINARY_DISPOSABLE_TLS_TOOLING_ONLY'}
    add_bytes(output, 'opt/finnor-disposable-tls/manifest.json', (json.dumps(tls, indent=2) + '\n').encode())
    add_bytes(output, 'app/finnor-os/Dockerfile.worker', (W / changed[0]).read_bytes())
    add_bytes(output, 'app/r3-installed-source-cut.json', (work / 'source-cut.json').read_bytes())
raw_bytes = raw.getvalue()
layer.write_bytes(gzip.compress(raw_bytes, compresslevel=3, mtime=0))
diff_id, layer_sha = sha(raw_bytes), sha(layer.read_bytes())
base = prior / 'r3-final-source-overlay.oci.tar'
with tarfile.open(base) as archive:
    index_member = archive.getmember('index.json')
    index = json.load(archive.extractfile(index_member))
    inputs = []
    for d in index['manifests']:
        m = json.load(archive.extractfile('blobs/sha256/' + d['digest'].split(':')[1]))
        c = json.load(archive.extractfile('blobs/sha256/' + m['config']['digest'].split(':')[1]))
        inputs.append((d, m, c))
lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
lib.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
lib.clonefile.restype = ctypes.c_int

def clone_prefix(path):
    assert lib.clonefile(os.fsencode(base), os.fsencode(path), 0) == 0
    with path.open('r+b') as f:
        f.truncate(index_member.offset)
        f.seek(index_member.offset)
        f.write(b'\0' * 1024)

created = datetime.now(timezone.utc).isoformat()
outputs = []
for descriptor, original_manifest, original_config in inputs:
    role = 'api' if 'r3-api:' in descriptor['annotations']['org.opencontainers.image.ref.name'] else 'worker'
    path = work / ('r3-final-' + role + '.oci.tar')
    clone_prefix(path)
    config = copy.deepcopy(original_config)
    config['created'] = created
    config['rootfs']['diff_ids'].append('sha256:' + diff_id)
    config.setdefault('history', []).append({'created': created, 'created_by': 'Verified official Debian OpenSSL/libssl3 tooling layer',
                                             'comment': 'Original product, scientific dependencies and compiled API unchanged'})
    config_bytes = json.dumps(config, sort_keys=True, separators=(',', ':')).encode()
    config_sha = sha(config_bytes)
    manifest = copy.deepcopy(original_manifest)
    manifest['config'] = {'mediaType': 'application/vnd.oci.image.config.v1+json', 'digest': 'sha256:' + config_sha, 'size': len(config_bytes)}
    manifest['layers'].append({'mediaType': 'application/vnd.oci.image.layer.v1.tar+gzip', 'digest': 'sha256:' + layer_sha, 'size': layer.stat().st_size})
    manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    digest = 'sha256:' + sha(manifest_bytes)
    next_descriptor = copy.deepcopy(descriptor)
    next_descriptor.update(digest=digest, size=len(manifest_bytes))
    with tarfile.open(path, 'a') as archive:
        add_bytes(archive, 'blobs/sha256/' + layer_sha, layer.read_bytes(), 0o644)
        add_bytes(archive, 'blobs/sha256/' + config_sha, config_bytes, 0o644)
        add_bytes(archive, 'blobs/sha256/' + digest.split(':')[1], manifest_bytes, 0o644)
        add_bytes(archive, 'index.json', json.dumps({**index, 'manifests': [next_descriptor]}).encode(), 0o644)
    with tarfile.open(path) as archive:
        assert json.load(archive.extractfile('index.json'))['manifests'] == [next_descriptor]
        for d in [manifest['config'], *manifest['layers']]:
            h = hashlib.sha256()
            with archive.extractfile('blobs/sha256/' + d['digest'].split(':')[1]) as f:
                for b in iter(lambda: f.read(1048576), b''):
                    h.update(b)
            assert 'sha256:' + h.hexdigest() == d['digest']
    outputs.append({'role': role, 'path': str(path), 'manifestDigest': digest})
previous = json.loads((E / 'repair-start/final-source-overlay-image-manifest-v19.json').read_text())
receipt = {**previous, 'createdAt': created, 'images': [{'digest': o['manifestDigest'], 'role': o['role'], 'archive': o['path']} for o in outputs],
           'archive': None, 'sourceCut': cut, 'systemTLS': tls, 'systemTLSLayerDigest': 'sha256:' + layer_sha,
           'exactChangedFilesFromV19': changed, 'predecessorProductAndScientificLayersUnchanged': True,
           'compiledBuildCustody': 'repair-start/final-v20-compiled-build-custody.json'}
(E / 'repair-start/final-source-overlay-image-manifest-v20.json').write_text(json.dumps(receipt, indent=2) + '\n')
(E / 'repair-start/reviewed-role-archives-v20.json').write_text(json.dumps({'at': created, 'outputs': outputs,
    'priorSourceVector': before['digest'], 'currentSourceVector': cut['digest'], 'exactChangedFiles': changed,
    'copyOnWrite': True, 'builtArtifactIsNotInstalledProof': True}, indent=2) + '\n')
print(json.dumps({'outputs': outputs, 'sourceVector': cut['digest'], 'sourceFiles': len(cut['files']), 'TLSFiles': len(records)}))
