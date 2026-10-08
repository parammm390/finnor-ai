"""Capture the interpreter behind an agent-created venv, without peer writes."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import stat

parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True)
parser.add_argument("--destination", required=True)
parser.add_argument("--venv", required=True)
args = parser.parse_args()
source, destination, venv = (Path(value).resolve() for value in (args.source, args.destination, args.venv))
repo = Path(__file__).resolve().parents[2]
for target in (destination, venv):
    target.relative_to(repo / ".runtime")
if destination.exists():
    raise RuntimeError("Existing interpreter destination refused")
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
libc.clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]


def manifest(root):
    rows = []
    for parent, dirs, files in os.walk(root):
        for name in sorted(dirs + files):
            path = Path(parent) / name
            info = path.lstat()
            row = {"path": str(path.relative_to(root)), "mode": stat.S_IMODE(info.st_mode)}
            if stat.S_ISLNK(info.st_mode):
                row["target"] = os.readlink(path)
            elif stat.S_ISREG(info.st_mode):
                h = hashlib.sha256()
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1048576), b""):
                        h.update(chunk)
                row.update(bytes=info.st_size, sha256=h.hexdigest())
            else:
                continue
            rows.append(row)
    return sorted(rows, key=lambda row: row["path"])


before = manifest(source)
for row in before:
    target = destination / row["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if "target" in row:
        link = row["target"]
        if os.path.isabs(link):
            link = str(destination / Path(link).relative_to(source))
        os.symlink(link, target)
    else:
        if libc.clonefile(os.fsencode(source / row["path"]), os.fsencode(target), 0):
            raise OSError(ctypes.get_errno(), "Independent interpreter copy failed")
        target.chmod(row["mode"])
if manifest(source) != before:
    raise RuntimeError("Moving interpreter source refused")
links = []
for path in (venv / "bin").iterdir():
    if path.is_symlink() and os.path.isabs(os.readlink(path)):
        old = path.resolve()
        try:
            relative = old.relative_to(source)
        except ValueError:
            continue
        path.unlink()
        path.symlink_to(destination / relative)
        links.append({"path": str(path), "target": str(destination / relative)})
config = venv / "pyvenv.cfg"
original = config.read_text()
config.write_text("\n".join(
    "home = " + str(destination / "bin") if line.startswith("home = ") else line
    for line in original.splitlines()) + "\n")
receipt = {
    "schema": "completion-python-base.v1", "source": str(source), "destination": str(destination),
    "sourceManifest": before, "sourceStable": True, "localManifest": manifest(destination),
    "independentInodes": True, "venvLinks": links,
    "venvOriginalConfigDigest": hashlib.sha256(original.encode()).hexdigest(),
    "venvLocalConfigDigest": hashlib.sha256(config.read_bytes()).hexdigest(),
    "systemDependencies": ["CoreFoundation", "/usr/lib/libSystem.B.dylib"],
    "qualification": "LOCAL_INTERPRETER_BYTE_CLOSURE_NOT_CLEAN_INSTALL_OR_OS_ATTESTATION",
}
(Path(__file__).parent / "evidence/python-base.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"interpreterFiles": len(before), "localInterpreter": str(destination)}))
