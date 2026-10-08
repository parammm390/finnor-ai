#!/usr/bin/env python3
"""Lossless retention of explicitly stopped, generated P7 test clusters."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tarfile

root = Path(__file__).resolve().parent.parent / "phase-09-p7-live-recompilation" / "evidence"
for raw in sys.argv[1:]:
    case = Path(raw).resolve()
    if case.parent != root or not case.name.startswith("native-"):
        raise SystemExit("Only explicit owned native evidence directories are accepted")
    state = json.loads((case / "cleanup.json").read_text())
    database = Path(state["ownedDatabaseDirectory"])
    archive, receipt = case / "db.tar.gz", case / "database-archive.json"
    if not database.exists():
        if not archive.is_file() or not receipt.is_file():
            raise SystemExit("Source missing without a verified archive")
        print(case.name, "already archived")
        continue
    if not state["databaseStopped"] or not database.name.startswith("completion-c-p7-") or (database / "postmaster.pid").exists():
        raise SystemExit("Unexpected or live cluster, preserved")
    if database.is_symlink() or any(p.is_symlink() for p in database.rglob("*")):
        raise SystemExit("Unexpected symlink, preserved")
    inventory = {str(p.relative_to(database)): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in database.rglob("*") if p.is_file()}
    with tarfile.open(archive, "x:gz") as target:
        target.add(database, arcname="db")
    with tarfile.open(archive, "r:gz") as target:
        recovered = {str(Path(member.name).relative_to("db")): hashlib.sha256(target.extractfile(member).read()).hexdigest()
                     for member in target.getmembers() if member.isfile()}
    if inventory != recovered:
        raise SystemExit("Byte verification failed, original cluster preserved")
    with receipt.open("x") as target:
        json.dump({"source": str(database), "archive": str(archive),
                   "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                   "files": inventory, "verifiedAllBytes": True,
                   "restore": "tar -xzf db.tar.gz"}, target, indent=2)
    shutil.rmtree(database)  # All generated file bytes are now verified and recoverable.
    print(case.name, "verified", len(inventory), "files;", archive.stat().st_size, "compressed bytes")
