"""Materialize an owned, hashed Mac development runtime; never copy credentials.

The source manifest preserves the canonical workspace. Third-party npm bytes
are materialized from the verified lock-matched install and all external links
are rewritten into this package or rejected. Host OS/Seatbelt remains explicit.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument('--output', required=True)
p.add_argument('--native', required=True)
p.add_argument('--python-root', required=True)
p.add_argument('--node', required=True)
p.add_argument('--node-license', required=True)
a = p.parse_args()
root = Path(__file__).resolve().parents[3]
out = Path(a.output).resolve()
if out.exists(): raise SystemExit('Package destination must be new')
out.mkdir(mode=0o700, parents=True)
started = datetime.now(timezone.utc).isoformat()
def sha(path):
 h = hashlib.sha256()
 with path.open('rb') as stream:
  for b in iter(lambda: stream.read(1048576), b''): h.update(b)
 return h.hexdigest()
def clone_tree(origin, target, patterns=()):
 target.parent.mkdir(parents=True, exist_ok=True)
 subprocess.run(['/bin/cp', '-cRp', str(origin), str(target)], check=True)
 for pattern in patterns:
  for path in list(target.rglob(pattern)):
   if not path.exists() and not path.is_symlink(): continue
   if path.is_symlink() or path.is_file(): path.unlink()
   elif path.is_dir(): shutil.rmtree(path)
def copy(source, target):
 target.parent.mkdir(parents=True, exist_ok=True)
 subprocess.run(['/bin/cp', '-cp', str(source), str(target)], check=True)
source = out/'source'
names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root).decode().split('\0')
for name in sorted(set(names)):
 if not name or name.startswith('scope-r/r2-robust-programme-search/evidence/'): continue
 path = root/name
 if path.is_file(): copy(path, source/name)
backend = source/'finnor-os'
mods = root/'finnor-os/node_modules'
mappings = []
workspaces = {}
for base in ('apps', 'packages'):
 for manifest in (root/'finnor-os'/base).rglob('package.json'):
  if 'node_modules' in manifest.parts: continue
  try:
   package_name = json.loads(manifest.read_text()).get('name', '')
   if package_name.startswith('@finnor/'): workspaces[package_name] = manifest.parent
  except (ValueError, UnicodeError): pass
# Preserve local workspace identity and separately materialize foreign packages.
for scope in sorted(mods.iterdir()):
 if scope.name in ('.bin', '.cache'): continue
 packages = sorted(scope.iterdir()) if scope.name.startswith('@') else [scope]
 for package in packages:
  relative = package.relative_to(mods)
  destination = backend/'node_modules'/relative
  origin = package.resolve()
  if relative.parts[0] == '@finnor':
   own = workspaces.get(str(relative))
   if own is None: raise ValueError('Unknown workspace '+str(relative))
   destination.parent.mkdir(parents=True, exist_ok=True)
   destination.symlink_to(os.path.relpath(source/own.relative_to(root), destination.parent), target_is_directory=True)
   mappings.append((origin, source/own.relative_to(root)))
  else:
   destination.parent.mkdir(parents=True, exist_ok=True)
   if origin.is_dir(): clone_tree(origin, destination)
   else: copy(origin, destination)
   mappings.append((origin, destination))
# The built frontend uses Next 16/React 19 while the API uses Next 15/React 18.
# Materialize distinct root dependencies, deduplicating only identical bytes.
def tree_identity(path):
 if path.is_file(): return sha(path)
 h = hashlib.sha256()
 for f in sorted(path.rglob('*')):
  if f.is_symlink(): h.update((str(f.relative_to(path))+':link:'+os.readlink(f)).encode())
  elif f.is_file(): h.update((str(f.relative_to(path))+':'+sha(f)).encode())
 return h.hexdigest()
backend_by_name = {str(destination.relative_to(backend/'node_modules')): (origin, destination) for origin, destination in mappings if destination.is_relative_to(backend/'node_modules')}
for scope in sorted((root/'node_modules').iterdir()):
 if scope.name in ('.bin', '.cache'): continue
 packages = sorted(scope.iterdir()) if scope.name.startswith('@') else [scope]
 for package in packages:
  relative = package.relative_to(root/'node_modules')
  origin = package.resolve(); destination = source/'node_modules'/relative
  candidate = backend_by_name.get(str(relative))
  if candidate and (candidate[0] == origin or tree_identity(candidate[0]) == tree_identity(origin)):
   destination.parent.mkdir(parents=True, exist_ok=True)
   destination.symlink_to(os.path.relpath(candidate[1], destination.parent), target_is_directory=candidate[1].is_dir())
  else:
   destination.parent.mkdir(parents=True, exist_ok=True)
   if origin.is_dir(): clone_tree(origin, destination)
   else: copy(origin, destination)
   mappings.append((origin, destination))
# Nested aliases and binary links must resolve within the materialized package.
mappings.sort(key=lambda pair: len(str(pair[0])), reverse=True)
links = []
for path in list((backend/'node_modules').rglob('*'))+list((source/'node_modules').rglob('*')):
 if not path.is_symlink(): continue
 raw = os.readlink(path)
 if not raw.startswith('/') and path.resolve().is_relative_to(out):
  links.append({'path': str(path.relative_to(out)), 'target': raw}); continue
 original = path.resolve()
 mapped = next((destination/original.relative_to(origin) for origin, destination in mappings if original.is_relative_to(origin)), None)
 if mapped is None: raise ValueError('Uncontained dependency alias '+str(path)+' -> '+str(original))
 path.unlink(); path.symlink_to(os.path.relpath(mapped, path.parent), target_is_directory=mapped.is_dir())
 links.append({'path': str(path.relative_to(out)), 'target': os.readlink(path)})
python_root = Path(a.python_root).resolve()
python = out/'python'
copy((python_root/'bin/python3').resolve(), python/'bin/python3.12')
(python/'bin/python3').symlink_to('python3.12')
clone_tree(python_root/'lib/python3.12', python/'lib/python3.12', ('site-packages', '__pycache__', 'test', 'tests', 'idlelib', 'turtledemo'))
copy(Path(a.node).resolve(), out/'node/bin/node')
copy(Path(a.node_license), out/'node/LICENSE')
native = Path(a.native).resolve()
clone_tree(native, out/'scientific', ('include', '*.a', '*.la', 'cmake', 'pkgconfig'))
for path in (out/'scientific').rglob('*'):
 if path.is_symlink() and not path.resolve().is_relative_to(out): raise ValueError('Uncontained native alias '+str(path))
for name in ('gmp.tar.xz', 'mpfr.tar.xz'):
 copy(native.parent/name, out/'sources'/name)
# The final built API and root artifacts are included without reusable dev/cache.
for origin, target in ((root/'finnor-os/apps/api/.next', backend/'apps/api/.next'), (root/'.next', source/'.next')):
 if origin.exists(): clone_tree(origin, target, ('cache', 'dev'))
files = [{'path': str(f.relative_to(out)), 'sha256': sha(f), 'bytes': f.stat().st_size} for f in sorted(out.rglob('*')) if f.is_file() and not f.is_symlink()]
licenses = []
for f in list((backend/'node_modules').rglob('package.json'))+list((source/'node_modules').rglob('package.json')):
 if f.is_file():
  try:
   j = json.loads(f.read_text())
   if j.get('name') and j.get('version'): licenses.append({'path': str(f.relative_to(out)), 'name': j['name'], 'version': j['version'], 'licenseDeclaration': j.get('license'), 'manifestSha256': sha(f)})
  except (ValueError, UnicodeError): pass
manifest = {'schema': 'finnor.r2.materialized-runtime.v1', 'startedAt': started, 'finishedAt': datetime.now(timezone.utc).isoformat(),
 'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(),
 'sourceTree': subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=root).decode().strip(),
 'sourceStatus': subprocess.check_output(['git', 'status', '--porcelain'], cwd=root).decode(),
 'files': files, 'symlinks': links, 'npmInventory': licenses,
 'host': {'platform': platform.platform(), 'architecture': platform.machine(), 'os': subprocess.check_output(['sw_vers'], text=True) if platform.system() == 'Darwin' else platform.platform()},
 'copyBasis': 'APFS clonefile via cp -c; independent owned regular files, copy-on-write byte custody, no dependency on peer symlinks',
 'trustBasis': 'Materialized locked npm/source/native/Python stdlib/Node bytes on this host; macOS system libraries and Seatbelt are named host TCB. No Linux/OCI qualification inferred.',
 'money': None, 'qualification': 'MATERIALIZED_AWAITING_PACKAGED_EXECUTION'}
(out/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps({'package': str(out), 'manifestSha256': sha(out/'manifest.json'), 'files': len(files), 'bytes': sum(f['bytes'] for f in files)}))
