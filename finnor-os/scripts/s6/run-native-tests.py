"""Retained Vitest owner-run evidence; never promotes fixtures to staging proof."""
import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import resource

workspace = pathlib.Path(__file__).resolve().parents[2]
for selector in sys.argv[2:]:
    if selector.endswith((".test.ts", ".test.tsx", ".test.mts")) and not (workspace / selector).is_file():
        raise SystemExit("Explicit test path does not exist: " + selector)
output = pathlib.Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=False)
command = ["npx", "vitest", "run", *sys.argv[2:], "--reporter=default", "--reporter=json", "--outputFile=" + str(output / "results.json")]

def snapshot():
    paths = [workspace / "package-lock.json", workspace / "vitest.config.ts", workspace / "tsconfig.json"]
    for base in ["packages", "apps", "tests"]:
        paths.extend(p for p in (workspace / base).rglob("*") if p.is_file()
                     and "node_modules" not in p.parts and ".next" not in p.parts
                     and (p.suffix in [".ts", ".tsx", ".mts", ".sql"] or p.name == "package.json"))
    return {str(p.relative_to(workspace)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(set(paths))}

manifest = {
    "schema": "finnor.s6.native-owner-run.v1", "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "command": command, "cwd": str(workspace), "node": subprocess.check_output(["node", "--version"], text=True).strip(),
    "qualification": "ACTUAL_POSTGRESQL_OWNER_BOUNDARY_WITH_REPOSITORY_FIXTURES; NOT_LIVE_PROVIDER_OR_PROTECTED_RELEASE",
    "databaseTarget": "disposable local PostgreSQL; rerun with DATABASE_URL pointing at an authorized disposable database",
    "configuration": {key: os.environ.get(key) for key in ["NODE_ENV", "CI", "FINNOR_TEST_MANAGED_EXTENSIONS", "FINNOR_STEP_LEASE_SECONDS"]},
    "sources": snapshot(),
}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2))
with (output / "runner.log").open("w") as log:
    environment = dict(os.environ, FINNOR_S6_BROWSER_EVIDENCE_DIR=str(output / "browser-readbacks"), FINNOR_S6_NATIVE_EVIDENCE_DIR=str(output / "native-readbacks"))
    usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    result = subprocess.run(command, cwd=workspace, env=environment, stdout=log, stderr=subprocess.STDOUT)
usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
manifest.update(exitCode=result.returncode, finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), sourcesUnchanged=snapshot() == manifest["sources"])
report_path = output / "results.json"
report = json.loads(report_path.read_text()) if report_path.exists() else {}
manifest["observedSelection"] = {key: report.get(key) for key in ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests"]}
manifest["noTestsExecuted"] = report.get("numPassedTests", 0) + report.get("numFailedTests", 0) == 0
manifest["resources"] = {"childCpuUserSeconds": usage_after.ru_utime - usage_before.ru_utime,
                         "childCpuSystemSeconds": usage_after.ru_stime - usage_before.ru_stime,
                         "childMaxRss": usage_after.ru_maxrss,
                         "childMaxRssUnit": "bytes" if sys.platform == "darwin" else "KiB",
                         "qualification": "WRAPPER_CHILD_RUSAGE; NOT_CGROUP_AGGREGATE_OR_PROVIDER_BILLING",
                         "providerCost": "UNMETERED_FIXTURE", "productionQuotaEnforcement": "NOT_ESTABLISHED"}
(output / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(json.dumps({"output": str(output), "exitCode": result.returncode, "sourcesUnchanged": manifest["sourcesUnchanged"]}))
sys.exit(result.returncode if manifest["sourcesUnchanged"] and not manifest["noTestsExecuted"] else 2)
