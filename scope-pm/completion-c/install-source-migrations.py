#!/usr/bin/env python3
"""Materialize exact original SQL bytes under the declared forward registry."""
import hashlib
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
plan = json.loads((HERE / "migration-plan.json").read_text())
rows = []
for entry in plan["forward"]:
    original = "finnor-os/packages/db/migrations/" + entry["original"]
    blob = subprocess.run(["git", "-C", str(ROOT), "show",
                           plan["source"] + ":" + original],
                          check=True, capture_output=True).stdout
    target = ROOT / "finnor-os/packages/db/migrations" / entry["release"]
    if target.exists():
        raise RuntimeError("Never overwrite a migration: " + str(target))
    with target.open("xb") as stream:
        stream.write(blob)
    rows.append({**entry, "sha256": hashlib.sha256(blob).hexdigest(),
                 "transformation": "REGISTRY_FILENAME_ONLY_SQL_BYTES_EXACT"})
with (HERE / "evidence/integration/source-migrations.json").open("x") as stream:
    stream.write(json.dumps(rows, indent=2) + "\n")
