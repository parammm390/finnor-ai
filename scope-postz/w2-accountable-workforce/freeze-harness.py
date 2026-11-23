"""Prelaunch source/tool/policy pinset, stored outside product source.

This performs file/Git reads only, not host, build, install or browser admission.
The caller must separately freeze the emitted manifest SHA before execution.
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("w2_job", Path(__file__).with_name("run-job.py"))
job = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = job
spec.loader.exec_module(job)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--resource-policy")
    parser.add_argument("--npm-cli")
    parser.add_argument("--browser-bin")
    parser.add_argument("--browser-observer-bin")
    parser.add_argument("--browser-executable")
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute() or ".." in output.parts or output.resolve().is_relative_to(job.ROOT):
        raise ValueError("NEW_ABSOLUTE_EXTERNAL_FREEZE_MANIFEST_REQUIRED")
    sources = {}
    for name in job.HARNESS_SOURCE_PATHS:
        row = job.freeze_pin(job.ROOT / name)
        sources[name] = {key: row[key] for key in ("sha256", "bytes", "mode")}
    tools = {"node": job.freeze_pin(Path(args.node).resolve(strict=True)),
             "python": job.freeze_pin(Path(sys.executable).resolve(strict=True))}
    for name in ("git", "ps"):
        selected = shutil.which(name)
        if not selected:
            raise ValueError("ACTUAL_HOST_OBSERVER_TOOL_REQUIRED")
        tools[name] = job.freeze_pin(Path(selected).resolve(strict=True))
    for name, selected in (("npmCli", args.npm_cli), ("agentBrowser", args.browser_bin),
                           ("browserObserver", args.browser_observer_bin),
                           ("browserExecutable", args.browser_executable)):
        if selected:
            tools[name] = job.freeze_pin(Path(selected).resolve(strict=True))
    policy = job.freeze_pin(Path(args.resource_policy).resolve(strict=True)) if args.resource_policy else None
    manifest = {"schema": "finnor.w2.prelaunch-harness-freeze.v1",
                "observedAt": datetime.now(timezone.utc).isoformat(), "source": job.source_cut(),
                "sources": sources, "tools": tools, "resourcePolicy": policy,
                "qualification": "PRELAUNCH_FILE_PINS_NOT_EXECUTION_ADMISSION"}
    # Refuse a source population changing while the pinset was being made.
    for name, row in sources.items():
        current = job.freeze_pin(job.ROOT / name)
        if any(current[key] != row[key] for key in row):
            raise RuntimeError("HARNESS_SOURCE_CHANGED_DURING_FREEZE")
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(json.dumps(manifest, indent=2) + "\n")
    job.FrozenHarness(output, job.sha(output), job.ROOT, args.node, args.resource_policy)
    print(json.dumps({"status": "FROZEN", "manifest": str(output), "sha256": job.sha(output),
                      "sourceFiles": len(sources), "tools": sorted(tools), "executionAdmission": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
