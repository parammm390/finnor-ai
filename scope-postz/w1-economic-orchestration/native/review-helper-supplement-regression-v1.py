"""Pre-repair isolated helper contracts; NEVER owning CONTROL/product evidence."""
import argparse
import ast
from copy import deepcopy
from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
SCOPE = ROOT / "scope-postz/w1-economic-orchestration"
NATIVE = SCOPE / "native"
STORIES = ROOT / "finnor-os/scripts/postz-w1"
HELPERS = [STORIES / "control-recovery-oracle.py", STORIES / "control-recovery-run.py",
    NATIVE / "qualify-owner-types.py", NATIVE / "register-read-custody.py",
    NATIVE / "qualify-native-current.py", NATIVE / "seal-evidence-packet.py"]


def load(path):
    spec = importlib.util.spec_from_file_location("isolated_" + path.stem.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def synthetic_control():
    original_path = SCOPE / "evidence/physical-recovery-0005-repaired/execution/observations.json"
    original = json.loads(original_path.read_bytes())
    case = next(x for x in original["cases"] if x["track"] == "A")
    selected = case["cuts"][0]
    uid, jid = case["original"]["unitId"], case["original"]["jobId"]
    for cut in case["cuts"]:
        # Keep the consumed projection; this is explicitly synthetic, not a
        # substitute observation and not an independent SQL/file-custody proof.
        cut["parent"]["proposed"] = {"bounds": cut["parent"]["proposed"]["bounds"]}
        for unit in cut["units"]:
            if unit["id"] == uid:
                unit["kind"] = "CONTROL_W1"
        for job in cut["jobs"]:
            if job["id"] == jid:
                job["idempotency_key"] = f"p2:{cut['search']['id']}:{job['payload']['generation']}:{uid}:admission:0"
        cut["events"].append({"kind": "W1_CONTROL_QUEUED",
            "body": {"unitId": uid, "continuationRef": "SYNTHETIC_HELPER_TRAIN_ONLY"}})
        if cut["label"] != "final":
            cut["programs"], cut["plans"], cut["p1Events"] = [], [], []
    workers = case["workers"]
    workers[0]["label"] = "setup-warm"
    p = selected["parent"]
    record = {"schema": "finnor.w1.control-pre-admission-recovery.v1",
        "synthetic": True, "qualification": "ISOLATED_HELPER_CONTRACT_NOT_CONTROL_E2E",
        "phase": "repaired", "status": "RECORDED_CONTROL_FALLBACK_RECOVERED",
        "sourceUnchanged": True, "productionIdentity": {}, "finalProductionIdentity": {},
        "auth": {"bypass": False, "anonymousStatus": 401, "foreignStatus": 404},
        "appIdentity": {"role": "finnor_app", "rolsuper": False, "rolbypassrls": False, "app_inherits_worker": False},
        "network": {"installed": True, "blockedExternalAttempts": 0},
        "scoredWallMs": 1000, "engineering": {"wallMs": 2000, "includesWarmAndSetup": True,
            "intervalsNonadditive": True, "billingUSD": None, "completeChildUsage": None},
        "cuts": case["cuts"], "original": case["original"], "warmEpisode": selected["episode"],
        "followUpInput": {"workId": p["work_id"], "workInputId": p["work_input_id"], "created": False, "duplicate": False},
        "trainingContinuation": [{"body": {"ref": "SYNTHETIC_HELPER_TRAIN_ONLY",
            "context": {"tenantId": p["tenant_id"], "principalId": p["principal_id"]},
            "samples": [{"split": "TRAIN", "action": "SYNTHETIC_ONLY",
                "consumption": {"attempts": 1, "steps": 1, "wallMs": 1}, "observedAt": selected["clock"]["at"]}]}}],
        "workers": workers, "node": case["node"], "kill": case["kill"],
        "victimTick": case["victimTick"], "gate": case["gate"],
        "canonicalRecoveryCount": case["canonicalRecoveryCount"], "databaseErrors": [],
        "programRead": case["programRead"], "calls": []}
    reconcile = next(x for x in case["calls"] if x["operation"] == "economic-orchestration-reconcile")
    record["calls"] = [{**reconcile, "operation": "economic-orchestration-reconcile"}]
    return record, original_path.parent / case["artifactDirectory"], sha(original_path)


class SyntheticFiles:
    def __init__(self, record, traces):
        self.cuts = {x["label"] + ".json": x for x in record["cuts"]}
        self.traces = traces

    def __truediv__(self, name):
        if name in self.cuts:
            return SimpleNamespace(read_bytes=lambda: json.dumps(self.cuts[name]).encode())
        return self.traces / name


def oracle_check(record, traces):
    return load(STORIES / "control-recovery-oracle.py").verify(record, SyntheticFiles(record, traces))


def integer_fences(record):
    for cut in record["cuts"]:
        for row in [*cut["jobs"], *cut["deliveries"]]:
            if row.get("claim_fence") is not None:
                row["claim_fence"] = int(row["claim_fence"])


def live_pids(pids):
    result = subprocess.run(["ps", "-p", ",".join(str(p) for p in pids), "-o", "pid=,stat="],
        capture_output=True, text=True, timeout=3, check=False)
    return [int(line.split()[0]) for line in result.stdout.splitlines()
        if len(line.split()) >= 2 and not line.split()[1].startswith("Z")]


def interruption(directory):
    state = directory / "owned-driver.json"
    node = directory / "node-shim"
    node.write_text("#!" + sys.executable + "\nimport json,os,signal,subprocess,sys\n"
        "from pathlib import Path\n"
        "child=subprocess.Popen([sys.executable,'-c','import signal; signal.pause()'])\n"
        "Path(os.environ['TMPDIR'],'owned-driver.json').write_text(json.dumps({'driver':os.getpid(),'descendant':child.pid}))\n"
        "signal.pause()\n")
    node.chmod(0o700)
    shim, contract = directory / "tsx-stub", directory / "contract"
    shim.write_text("fixture only"); contract.write_text("fixture only")
    wrapper = directory / "invoke-runner.py"
    wrapper.write_text("import importlib.util,sys\n"
        f"p={str(STORIES / 'control-recovery-run.py')!r}\n"
        "s=importlib.util.spec_from_file_location('runner',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n"
        "m.custody.freeze=lambda *a:{'files':{},'tools':{},'registeredContract':{}}\n"
        "sys.exit(m.main())\n")
    env = dict(os.environ, TMPDIR=str(directory))
    for role, user in [("ADMIN", "postgres"), ("APP", "finnor_app"), ("WORKER", "finnor_worker")]:
        env["FINNOR_W1_RECOVERY_C_" + role + "_URL"] = f"postgresql://{user}@127.0.0.1:1/never_connect"
    command = [sys.executable, str(wrapper), "--node", str(node), "--tsx", str(shim),
        "--python", sys.executable, "--evidence", str(directory / "runner-evidence"),
        "--contract", str(contract), "--phase", "broken", "--disposable-local-fixtures"]
    runner = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    owned = None
    try:
        end = time.monotonic() + 5
        while time.monotonic() < end and not state.exists() and runner.poll() is None:
            time.sleep(0.025)
        if not state.exists():
            raise AssertionError("ISOLATED_DRIVER_NOT_LAUNCHED: " + runner.communicate(timeout=1)[0].decode()[-2000:])
        owned = json.loads(state.read_text())
        os.kill(runner.pid, signal.SIGTERM)
        output, _ = runner.communicate(timeout=5)
        live = live_pids(owned.values())
        assert not live, "DETACHED_CONTROL_DESCENDANTS_SURVIVED_SIGTERM: " + repr(live)
        return {"ownedPids": owned, "runnerExit": runner.returncode, "survivingPids": live,
            "isolatedFixtureOutputBytes": len(output), "databaseOrNodeProductionDriverLaunched": False}
    finally:
        if owned:
            try:
                os.killpg(owned["driver"], signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.killpg(runner.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        runner.communicate(timeout=5)


def source_inventory(directory):
    for folder in ("packages", "apps", "scripts/postz-w1", "scripts/p2", "scripts/p7"):
        target = directory / "finnor-os" / folder / "fixture.mts"
        target.parent.mkdir(parents=True); target.write_text("export {};\n")
    subprocess.run(["git", "-C", str(directory), "init", "-q"], check=True, timeout=5)
    tree = ast.parse((NATIVE / "qualify-owner-types.py").read_text())
    main = next(x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name == "main")
    function = next((x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name == "source_snapshot"), None)
    if function is None:
        function = next(x for x in main.body if isinstance(x, ast.FunctionDef) and x.name == "snapshot")
    namespace = dict(root=directory, retired="absent", subprocess=subprocess, Path=Path, hashlib=hashlib)
    exec(compile(ast.Module(body=[function], type_ignores=[]), "<actual-source-snapshot>", "exec"), namespace)
    entries = namespace[function.name](directory) if function.args.args else namespace[function.name]()
    paths = {x["path"] for x in entries}
    missing = [f"finnor-os/scripts/{name}/fixture.mts" for name in ("p2", "p7")
        if f"finnor-os/scripts/{name}/fixture.mts" not in paths]
    assert not missing, "ACTUAL_COMPILER_SCRIPT_DEPENDENCIES_OMITTED: " + repr(missing)
    return {"fixtureWatchCount": len(paths), "p2AndP7Included": True}


def deadline_tail(directory, cleanup=False):
    module = load(NATIVE / "qualify-native-current.py")
    evidence = directory / "native-output"
    registration = directory / "registration.json"
    oracle = directory / "finnor-os/scripts/postz-w1/native-oracle.py"
    oracle.parent.mkdir(parents=True); oracle.write_text("synthetic oracle identity")
    record = {"command": ["SYNTHETIC_CHILD", str(evidence)], "sourceFiles": [],
        "nativeOracleSha256": sha(oracle), "environment": {"FINNOR_TEST_PYTHON": sys.executable},
        "engineeringReviewConcurrency": "ISOLATED_SYNTHETIC_CLOCK"}
    write(registration, record)
    elapsed = {"seconds": 0, "kills": 0}
    base = type(Path())

    class TimedPath(base):
        def read_bytes(self):
            data = super().read_bytes()
            if self.name == "terminal-owner-cuts.json" and not cleanup:
                elapsed["seconds"] = 331
            return data

    def popen(*args, **kwargs):
        write(evidence / "results.json", {"status": "PASS_LOCAL", "migrationCount": 235,
            "results": [{"id": "W1-native-owner-proof", "status": "PASS"}]})
        write(evidence / "w1-runner-receipt.json", {"exitCode": 0, "independentOracleStatus": "PASS"})
        write(evidence / "w1-scored-native/native-story.json", {"status": "PASS_CONTROLLED_NATIVE",
            "scoredAuth": "ACTUAL_SIGNED_BEARER_AUTH_DEV_BYPASS_0", "sourceAndAcceptanceUnchanged": True,
            "before": {"id": "synthetic"}, "after": {"id": "synthetic"}, "originalEpisode": "synthetic",
            "perProgrammeObserverSeconds": 120})
        write(evidence / "w1-scored-native/p7-currentness.json", {"status": "PASS_CONTROLLED_NATIVE"})
        for name in ("pre-run-freeze.json", "w1-scored-native/observations.json", "w1-scored-native/terminal-owner-cuts.json"):
            write(evidence / name, {})
        return SimpleNamespace(pid=99999999, wait=lambda **kw: 0)

    def recheck(command, **kwargs):
        write(Path(command[-1]), {"status": "PASS"})
        return SimpleNamespace(returncode=0)

    def killpg(*args):
        elapsed["kills"] += 1
        if cleanup and elapsed["kills"] >= 3:
            elapsed["seconds"] = 331

    module.Path, module.__file__ = TimedPath, str(directory / "scope-postz/w1-economic-orchestration/native/qualify-native-current.py")
    module.time = SimpleNamespace(monotonic=lambda: elapsed["seconds"])
    module.os = SimpleNamespace(environ={}, killpg=killpg)
    module.signal = SimpleNamespace(SIGTERM=signal.SIGTERM, SIGINT=signal.SIGINT,
        SIGKILL=signal.SIGKILL, signal=lambda *args: None)
    module.subprocess = SimpleNamespace(Popen=popen, run=recheck, STDOUT=subprocess.STDOUT,
        TimeoutExpired=subprocess.TimeoutExpired)
    old = sys.argv
    try:
        sys.argv = ["synthetic-native-parent", str(registration)]
        with redirect_stdout(io.StringIO()):
            code = module.main()
    finally:
        sys.argv = old
    result = json.loads(Path(str(evidence) + ".parent-gate.json").read_text())
    assert result.get("childExitCode") == 0 and result["wallSeconds"] >= 331, \
        "SYNTHETIC_TAIL_NOT_REACHED: " + repr(result)
    assert result.get("failure") == "COMPLETE_NATIVE_PARENT_BOUND" \
        and result.get("failureType") == "TimeoutError", \
        "RECORDED_FAILURE_MUST_IDENTIFY_THE_COMPLETE_BOUND: " + repr(
            {key: result.get(key) for key in ("status", "failure", "failureType", "cleanupFailure")})
    assert code != 0 and result["status"] != "PASS_CONTROLLED_NATIVE_CURRENT_REGISTERED_CUT", \
        "NATIVE_PARENT_PASSED_AFTER_COMPLETE_BOUND: " + repr(result.get("wallSeconds"))
    return {"clock": "SYNTHETIC", "wallSeconds": result["wallSeconds"], "status": result["status"]}


def packet_capacity(directory, overflow):
    module = load(NATIVE / "seal-evidence-packet.py")
    module.SCOPE, module.PACKETS = directory, directory / "evidence/sealed-packets"
    source = directory / "evidence/original"
    source.mkdir(parents=True); (source / "one").write_text("original bytes\n")
    module.MAX_SIDECAR = 64 if overflow else 10 * 1024**2
    old = sys.argv
    try:
        sys.argv = ["packet", "pack", "synthetic", "evidence/original"]
        rejected = None
        try:
            with redirect_stdout(io.StringIO()):
                module.main()
        except RuntimeError as error:
            rejected = str(error)
        if overflow:
            assert rejected == "PACKET_SIDECAR_CAPACITY_BOUND", "CREATOR_ACCEPTED_UNCONSUMABLE_INJECTED_SIDECAR_BOUND"
            return {"injectedBoundBytes": 64, "rejected": rejected}
        assert rejected is None, rejected
        for operation in ("verify", "extract"):
            if operation == "extract":
                (source / "one").unlink(); source.rmdir()
            sys.argv = ["packet", operation, "synthetic"]
            with redirect_stdout(io.StringIO()):
                module.main()
        assert (source / "one").read_text() == "original bytes\n"
        return {"realPackVerifyExtract": True, "productionBoundBytes": 10 * 1024**2}
    finally:
        sys.argv = old


def closure_manifests(directory):
    """Consulted-but-unlisted resolution manifests must be inside the qualified closure (H12)."""
    root = directory
    def place(relative, text):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    place("finnor-os/tsconfig.json", "{}\n")
    place("package-lock.json", "{}\n")
    place("finnor-os/package-lock.json", "{}\n")
    place("finnor-os/node_modules/typescript/bin/tsc", "// tsc\n")
    place("finnor-os/node_modules/typescript/package.json", "{}\n")
    place("finnor-os/node_modules/typescript/lib/tsc.js", "// lib\n")
    place("node_modules/@types/pg/index.d.ts", "export {};\n")
    manifest = root / "node_modules/pg/package.json"
    place("node_modules/pg/package.json", '{"name":"pg","types":"./pg.d.ts"}\n')
    place("finnor-os/packages/private-equity/src/db.ts", 'import pg from "pg";\n')
    tree = ast.parse((NATIVE / "qualify-owner-types.py").read_text())
    functions = [x for x in tree.body if isinstance(x, ast.FunctionDef)
                 and x.name in {"compiler_snapshot", "resolution_manifests"}]
    namespace = dict(Path=Path, hashlib=hashlib, CONFIGURATIONS=["finnor-os/tsconfig.json"],
                     __file__=str(NATIVE / "qualify-owner-types.py"))
    exec(compile(ast.Module(body=functions, type_ignores=[]), "<actual-compiler-snapshot>", "exec"), namespace)
    paths = [str(root / "node_modules/@types/pg/index.d.ts"),
             str(root / "finnor-os/packages/private-equity/src/db.ts")]
    before = {entry["path"]: entry for entry in namespace["compiler_snapshot"](root, paths)}
    target = str(manifest)
    assert target in before, "RESOLUTION_MANIFEST_OUTSIDE_CLOSURE: " + target
    manifest.write_text('{"name":"pg","exports":{".":"./redirected.js"}}\n')
    after = {entry["path"]: entry for entry in namespace["compiler_snapshot"](root, paths)}
    assert after[target]["sha256"] != before[target]["sha256"], "RESOLUTION_MANIFEST_EDIT_NOT_RECORDED"
    return {"recordedResolutionManifest": target, "editInvalidatesClosure": True}

def copy_race(directory):
    module = load(NATIVE / "register-read-custody.py")
    tree = ast.parse((NATIVE / "register-read-custody.py").read_text())
    main = next(x for x in tree.body if isinstance(x, ast.FunctionDef) and x.name == "main")
    begin = next(i for i,x in enumerate(main.body) if isinstance(x, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == "entries" for t in x.targets))
    end = next(i for i,x in enumerate(main.body) if isinstance(x, ast.Expr)
        and isinstance(x.value, ast.Call) and isinstance(x.value.func, ast.Attribute)
        and isinstance(x.value.func.value, ast.Name) and x.value.func.value.id == "candidate"
        and x.value.func.attr == "mkdir")
    target = "finnor-os/scripts/p2/fixture.mts"
    source = directory / target
    source.parent.mkdir(parents=True); source.write_text("digest A\n")
    scope = directory / "scope"
    (scope / "integration-proposals").mkdir(parents=True)
    proposal = scope / "proposal"; proposal.mkdir()

    def concurrent_copy(src, dst):
        src.write_text("digest B\n")
        shutil.copyfile(src, dst)

    namespace = {"root": directory, "scope": scope, "proposal": proposal, "tag": "synthetic",
        "paths": {target}, "historical": {"retainedSourceCopies": [target]}, "targets": {},
        "extra": set(), "tracked": [target], "retired_path": "absent",
        "relative_source": lambda value: value, "sha": sha, "hashlib": hashlib,
        "json": json, "Path": Path, "shutil": SimpleNamespace(copyfile=concurrent_copy, disk_usage=shutil.disk_usage)}
    failure = None
    try:
        exec(compile(ast.Module(body=main.body[begin:end], type_ignores=[]), "<actual-registration-copy-block>", "exec"), namespace)
    except RuntimeError as error:
        failure = str(error)
    assert failure and "mismatch" in failure.lower(), "COPY_AND_SECOND_LIVE_READ_ACCEPTED_UNRECORDED_DIGEST_B"
    return {"injectedRace": "A recorded, B copied", "registrationPublished": False, "failure": failure}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    assert args.output.is_absolute() and not args.output.exists()
    sources = {str(path.relative_to(ROOT)): sha(path) for path in HELPERS}
    began, results = time.monotonic(), []
    record, traces, original_sha = synthetic_control()
    normalized = deepcopy(record); integer_fences(normalized)

    def case(name, action):
        try:
            detail = action()
            results.append({"case": name, "status": "PASS", "detail": detail})
        except Exception as error:
            results.append({"case": name, "status": "FAIL", "error": str(error), "type": type(error).__name__})

    def positive():
        assert oracle_check(record, traces) == "PASS_CONTROL_PRE_ADMISSION_MINIMUM_FALLBACK"
        return {"rawPostgresBigintFences": "strings", "synthetic": True}

    def negative(mutation, expected):
        """A mutation must be rejected with exactly the predicate owning the mutated binding (H10)."""
        altered = deepcopy(normalized)
        mutation(altered, altered["cuts"][-1])
        try:
            oracle_check(altered, traces)
        except Exception as error:
            predicate = getattr(error, "predicate", None)
            assert predicate, "UNSTRUCTURED_ORACLE_CRASH: " + repr(error)
            assert predicate == expected, \
                "UNRELATED_REJECTION_PREDICATE: " + repr((predicate, expected))
            return {"rejectedPredicate": predicate, "synthetic": True}
        raise AssertionError("MUTATED_HELPER_EVIDENCE_WAS_ACCEPTED")

    def fence_mutation(kind):
        """Mutate the contended cut's claimed CONTROL job and its delivery fence pair (H9)."""
        def apply(r, _cut):
            jid = r["original"]["jobId"]
            contended = next(c for c in r["cuts"] if c["label"] == "contended")
            claimed = next(j for j in contended["jobs"] if j["id"] == jid)
            delivery = next(d for d in contended["deliveries"]
                            if d["job_id"] == jid and d["claim_token"] == claimed["claim_token"])
            if kind == "zero":
                claimed["claim_fence"] = delivery["claim_fence"] = 0
            elif kind == "mismatched":
                claimed["claim_fence"], delivery["claim_fence"] = 1, 2
            elif kind == "negative":
                claimed["claim_fence"] = delivery["claim_fence"] = -1
            else:
                claimed["claim_fence"] = "not-an-integer"
        return apply

    def baseline():
        """The unmutated normalized record underlying every negative must pass (H10)."""
        verdict = oracle_check(deepcopy(normalized), traces)
        assert verdict == "PASS_CONTROL_PRE_ADMISSION_MINIMUM_FALLBACK", \
            "BASELINE_MUST_PASS: " + repr(verdict)
        return {"integerFences": True, "synthetic": True, "predicate": verdict}

    case("H1.raw-bigint-positive", positive)
    case("H4-H5.unmutated-normalized-baseline", baseline)
    for label in ("zero", "mismatched", "negative", "malformed"):
        case("H1." + label + "-fence-rejection",
             lambda label=label: negative(fence_mutation(label), "CONTROL_CLAIM_OWNER_FENCE"))
    for label, mutation, expected in [
        ("duplicate-execute", lambda r,c: c["attempts"][1].update(unit_id=c["attempts"][0]["unit_id"]),
            "CONTROL_ONE_ATTEMPT_PER_FALLBACK_UNIT"),
        ("wrong-job", lambda r,c: next(j for j in c["jobs"] if j["id"]==c["attempts"][-1]["body"]["jobId"])["payload"].update(unitId="foreign-unit"),
            "CONTROL_PHYSICAL_ORIGINAL_JOB_PAYLOAD"),
        ("wrong-fence", lambda r,c: c["attempts"][-1]["body"].update(claimFence=999999),
            "CONTROL_PHYSICAL_DELIVERY_FENCE"),
        ("wrong-worker", lambda r,c: next(d for d in c["deliveries"] if d["id"]==c["attempts"][-1]["delivery_id"]).update(worker_id="foreign-worker"),
            "CONTROL_REPLACEMENT_PHYSICAL_COMPLETION"),
        ("extended-deadline", lambda r,c: c["attempts"][-1]["body"].update(originalDeadlineAt="2099-01-01T00:00:00Z"),
            "CONTROL_PHYSICAL_DEADLINE_EXTENDED"),
    ]:
        case("H4." + label, lambda mutation=mutation, expected=expected: negative(mutation, expected))
    for label, mutation, expected in [
        ("wrong-head", lambda r,c: c["parent"].update(head_id="missing-head"),
            "CONTROL_ACTUAL_P1_IMMUTABLE_HEAD"),
        ("wrong-value", lambda r,c: next(p["body"] for p in c["programs"] if p["id"]==c["parent"]["head_id"])["result"]["values"]["netEquity"].update(value="999"),
            "CONTROL_ORIGINAL_PUBLISHED_RESULT"),
        ("altered-acceptance", lambda r,c: next(p["body"] for p in c["programs"] if p["id"]==c["parent"]["head_id"])["acceptance"]["targets"][0].update(unit="count"),
            "CONTROL_ORIGINAL_P1_ACCEPTANCE_UNCHANGED"),
        ("failed-read", lambda r,c: r["programRead"].update(status=403),
            "CONTROL_ORIGINAL_PROGRAM_READ"),
    ]:
        case("H5." + label, lambda mutation=mutation, expected=expected: negative(mutation, expected))
    for name, action in [
        ("H2.detached-SIGTERM", interruption), ("H3.all-imported-scripts", source_inventory),
        ("H6.hash-tail", lambda p: deadline_tail(p)),
        ("H6.cleanup-tail", lambda p: deadline_tail(p, True)),
        ("H7.overflow", lambda p: packet_capacity(p, True)),
        ("H7.positive-roundtrip", lambda p: packet_capacity(p, False)),
        ("H8.inventory-copy-race", copy_race),
        ("H12.resolution-manifest-closure", closure_manifests),
    ]:
        with tempfile.TemporaryDirectory(prefix="finnor-w1-helper-contract-", dir="/tmp") as temporary:
            case(name, lambda action=action, p=Path(temporary): action(p))
    same = sources == {str(path.relative_to(ROOT)): sha(path) for path in HELPERS}
    result = {"schema": "finnor.w1.helper-isolated-regression.v1",
        "at": datetime.now(timezone.utc).isoformat(), "qualification": "ISOLATED_HELPER_CONTRACT_NOT_OWNING_E2E",
        "syntheticOracleRecordsAndClock": True, "actualDisposableInterruptionAndPacketIO": True,
        "originalRecoveryObservationsSha256": original_sha, "originalObservationsModified": False,
        "sources": sources, "sourcesUnchanged": same, "results": results,
        "total": len(results), "passed": sum(x["status"]=="PASS" for x in results),
        "failed": sum(x["status"]=="FAIL" for x in results),
        "wallSeconds": time.monotonic()-began, "billingUSD": None,
        "completeDescendantUsage": None, "CODE_COMPLETE": False, "E2E_DEV_VERIFIED": False}
    with args.output.open("x") as out:
        json.dump(result, out, indent=2); out.write("\n")
    print(json.dumps({k:result[k] for k in ("qualification","total","passed","failed","sourcesUnchanged","wallSeconds")}))
    return 0 if result["failed"] == 0 and same else 1


if __name__ == "__main__":
    raise SystemExit(main())
