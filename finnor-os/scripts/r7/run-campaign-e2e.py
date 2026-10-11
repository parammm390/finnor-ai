"""Preregistered whole-clock R7/retained S5 campaign, including actual guard E2Es."""
import argparse
import datetime as dt
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import time

from campaign import digest, free_bytes, read, remaining, run_phase, save

REPO = pathlib.Path(__file__).resolve().parents[3]
NODE = "/Users/paramdave/.local/bin/node"
BORROW = pathlib.Path("/Users/paramdave/.codex/visualizations/2026/10/09/01a121d2-7d60-77d2-8611-b4712a5bb84f/r2-package-final")


def spec(root, name, argv, cwd, seconds, env=None, expected=None, diagnostics=None):
    value = dict(id=name, argv=[str(x) for x in argv], cwd=str(cwd), phaseSeconds=seconds,
                 environment=env or {})
    if expected:
        value["expectedResult"] = expected
    if diagnostics:
        value["diagnosticLimits"] = diagnostics
    p = root / "specs" / (name + ".json")
    save(p, value)
    return p


def owner_env(cut, evidence, cases):
    return dict(TSX_TSCONFIG_PATH=str(cut / "finnor-os/scripts/r7/tsconfig.json"),
                FINNOR_R7_SERIAL_SCHEMA=str(cut / "scope-r/r7-policy-atlas-compiler/handoff/proposals/r7-policy-atlas.sql"),
                FINNOR_R7_CASE_FILTER=",".join(cases), FINNOR_R7_EVIDENCE_DIR=str(evidence),
                FINNOR_R7_ALT_PYTHON=str(BORROW / "python/bin/python3.12"))


def diagnostic(parent, name, seconds):
    root = pathlib.Path(parent["outputRoot"]) / "diagnostics" / name
    root.mkdir(parents=True)
    reg = json.loads(json.dumps(parent))
    now = dt.datetime.now(dt.timezone.utc)
    expiry = min(now + dt.timedelta(seconds=seconds), dt.datetime.fromisoformat(parent["deadlineAt"]))
    reg.update(outputRoot=str(root), diagnosticOnly=True,
               startedAt=(expiry - dt.timedelta(seconds=3600)).isoformat(),
               deadlineAt=expiry.isoformat(),
               startedMonotonicSeconds=time.monotonic() + (expiry.timestamp() - time.time()) - 3600,
               deadlineMonotonicSeconds=min(parent["deadlineMonotonicSeconds"],
                                           time.monotonic() + (expiry.timestamp() - time.time())),
               parentRegistrationSha256=digest(json.dumps(parent, sort_keys=True).encode()),
               rule="Artificial old original3600s start / stricter resource fixture only; INCOMPLETE expected, never a reduced positive campaign")
    p = root / "registration.json"
    save(p, reg)
    return root, p


def conformance(registration, cut):
    parent = read(registration)
    out = pathlib.Path(parent["outputRoot"])
    results = []

    def assert_guard(root, registration_path, specification, expected):
        receipt = run_phase(registration_path, specification)
        assert receipt["status"] == "INCOMPLETE" and receipt["guardPredicate"] == expected, receipt
        assert not receipt["residualProcesses"], receipt
        results.append(dict(id=read(specification)["id"], expected=expected,
                            observed=receipt["guardPredicate"], status="PASS",
                            supervision=str(root / "phases" / read(specification)["id"] / "supervision.json")))
        # Phase tmp holds only regenerable databases/HOME; prune after the receipt
        # is sealed so serial phases cannot exhaust the shared disk reserve.
        shutil.rmtree(root / "phases" / read(specification)["id"] / "tmp", ignore_errors=True)
        return receipt

    # Actual original owners, exact native child, real SQL UNKNOWN responsibility.
    root, registration_path = diagnostic(parent, "actual-global-stop", 45)
    evidence, ready = root / "evidence", root / "boundary-ready.json"
    env = owner_env(cut, evidence, ["campaign-boundary-reconcile"])
    env["FINNOR_R7_BOUNDARY_READY"] = str(ready)
    p = spec(root, "actual-global-stop", [NODE, "--import=tsx", "scripts/r7/run-owner.mts"],
             cut / "finnor-os", 180, env)
    receipt = assert_guard(root, registration_path, p, "GLOBAL_DEADLINE")
    assert ready.is_file(), "Global diagnostic expired before the registered actual physical boundary"
    original = read(ready)
    reconciliation = read(evidence / "campaign-reconciliation.json")
    actual = read(evidence / "results.json")["cases"]
    assert len(actual) == 1 and actual[0]["id"] == "campaign-boundary-reconcile" and actual[0]["status"] == "PASS", actual
    assert reconciliation["before"]["episodes"] == reconciliation["after"]["episodes"]
    assert reconciliation["before"]["reservations"] == reconciliation["after"]["reservations"]
    assert reconciliation["before"]["consumptions"] == reconciliation["after"]["consumptions"]
    assert original["unknown"]["reservation"]["status"] == "UNKNOWN_OUTCOME"
    assert not reconciliation["livePhysical"] and not reconciliation["workerPids"]
    assert any(v["owner_id"] == "r7:" + original["start"]["invocationId"] and v["released_at"]
               for v in reconciliation["after"]["leases"])
    assert receipt["pid"] and len(receipt["ownedProcesses"]) >= 3

    root, registration_path = diagnostic(parent, "expired-restart", -1)
    marker = root / "marker"
    p = spec(root, "expired-first", [sys.executable, REPO / "finnor-os/scripts/r7/campaign-fixture.py",
                                   "launch-marker", marker], REPO, 180)
    receipt = assert_guard(root, registration_path, p, "GLOBAL_DEADLINE")
    assert receipt["pid"] is None and not marker.exists()
    again = spec(root, "expired-restart", read(p)["argv"], REPO, 180)
    refusal = subprocess.run([sys.executable, str(REPO / "finnor-os/scripts/r7/campaign.py"),
                              "--registration", str(registration_path), "--phase", str(again)],
                             text=True, capture_output=True, timeout=5,
                             env={"PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"})
    save(root / "restart-refusal.json", {"exitCode": refusal.returncode, "stdout": refusal.stdout,
                                       "stderr": refusal.stderr, "markerExists": marker.exists()})
    assert refusal.returncode != 0 and not marker.exists()

    for name, mode, cap, predicate in [
        ("evidence-quota", "write", {"maxGeneratedEvidenceBytes": 65536}, "EVIDENCE_QUOTA"),
        ("rss-quota", "memory", {"aggregateRssGuardBytes": 33554432}, "AGGREGATE_RSS_QUOTA"),
    ]:
        root, registration_path = diagnostic(parent, name, 20)
        p = spec(root, name, [sys.executable, REPO / "finnor-os/scripts/r7/campaign-fixture.py", mode, root / "actual"],
                 REPO, 180, diagnostics=cap)
        receipt = assert_guard(root, registration_path, p, predicate)
        child = read(root / "actual/actual-child.json")
        assert child["childPid"] in [v["pid"] for v in receipt["ownedProcesses"]]
        assert len(receipt["ownedProcesses"]) >= 2

    root, registration_path = diagnostic(parent, "disk-reserve", 20)
    marker = root / "marker"
    p = spec(root, "disk-reserve", [sys.executable, REPO / "finnor-os/scripts/r7/campaign-fixture.py",
                                  "launch-marker", marker], REPO, 180,
             diagnostics={"minimumFreeBytes": free_bytes(root) + 64 * 1024 * 1024})
    receipt = assert_guard(root, registration_path, p, "DISK_RESERVE")
    assert receipt["pid"] is None and not marker.exists()
    save(out / "conformance-results.json", dict(schema="finnor.r7.global-guard-e2e.v1",
                                               results=results, passed=len(results),
                                               negativeReceiptsRemainIncomplete=True,
                                               noFinancialSettlementOrFreshGrant=True))


def main(registration):
    reg = read(registration)
    root = pathlib.Path(reg["outputRoot"])
    # Source reconstruction is not generated evidence; keep it beside the
    # evidence root exactly like the predecessor's separately scoped cuts.
    cut = root.with_name(root.name + "-serial-cut")
    phases = []
    started = time.monotonic()
    summary = dict(schema="finnor.r7.successor-campaign-results.v1", status="INCOMPLETE",
                   registrationSha256=digest(pathlib.Path(registration).read_bytes()),
                   predecessorOverrun=reg["originalRedReceipt"], globalCapSeconds=3600,
                   startedAt=reg["startedAt"], deadlineAt=reg["deadlineAt"],
                   phases=phases, reusedMath=reg["reusedMathematics"],
                   fullFunctionalGate="PARTIAL_MAIN_SERIAL_NATIVE_INSTALLED_AND_PROTECTED_GATES_REMAIN",
                   money=None, humanSeconds=None, protectedAggregateMemoryQualification=False)

    def phase(name, argv, cwd, seconds, env=None, expected=None):
        assert remaining(reg) > 0, "Original successor deadline exhausted before next phase"
        p = spec(root, name, argv, cwd, seconds, env, expected)
        receipt = run_phase(registration, p)
        phases.append(dict(id=name, status=receipt["status"], guardPredicate=receipt["guardPredicate"],
                           wallSeconds=receipt["phaseWallSeconds"],
                           supervision=str(root / "phases" / name / "supervision.json")))
        save(root / "campaign-summary.json", summary)
        if receipt["status"] != "PASS":
            raise RuntimeError(name + ":" + str(receipt["guardPredicate"]))
        shutil.rmtree(root / "phases" / name / "tmp", ignore_errors=True)
        return receipt

    try:
        for v in reg["reusedMathematics"]["inputs"]:
            assert digest((REPO / v["path"]).read_bytes()) == v["sha256"], "Changed mathematical source cannot reuse old receipt"
        for v in reg["reusedMathematics"]["receipts"]:
            assert digest(pathlib.Path(v["path"]).read_bytes()) == v["sha256"]
        python = reg["scientificBinding"]["python"]
        probe = ("import sys,json,hashlib,pathlib,numpy,scipy;"
                 "from scipy.optimize import milp,Bounds;"
                 "r=milp(c=[-1.0],integrality=[1],bounds=Bounds([0.0],[1.0]));"
                 "assert r.success and r.x[0]==1.0;"
                 "print(json.dumps({'python':sys.executable,'version':sys.version,"
                 "'binarySha256':hashlib.sha256(pathlib.Path(sys.executable).read_bytes()).hexdigest(),"
                 "'numpy':numpy.__version__,'numpyPath':numpy.__file__,"
                 "'scipy':scipy.__version__,'scipyPath':scipy.__file__,"
                 "'actualMilpStatus':int(r.status),'actualMilpValue':float(r.fun),"
                 "'runtimeCopiedOrInstalled':False}))")
        phase("scientific-runtime-preflight", [python, "-c", probe], REPO, 30)
        probe_value = json.loads((root / "phases/scientific-runtime-preflight/runner.log").read_text())
        save(root / "scientific-runtime.json", probe_value)
        phase("private-overlay-preparation",
              [NODE, REPO / "finnor-os/scripts/r7/serial-projection.mjs", cut,
               BORROW / "source/finnor-os/node_modules", BORROW / "source/node_modules"],
              REPO / "finnor-os", 120)
        phase("wrapper-conformance", [sys.executable, __file__, "--registration", registration,
                                      "--conformance-only", "--cut", cut], REPO, 180)
        phase("owned-typecheck", [NODE, BORROW / "source/finnor-os/node_modules/typescript/bin/tsc",
                                  "-p", "scripts/r7/tsconfig.json", "--noEmit"],
              cut / "finnor-os", 600)
        evidence = root / "owners"
        phase("owner-full23", [NODE, "--import=tsx", "scripts/r7/run-owner.mts"], cut / "finnor-os", 1200,
              owner_env(cut, evidence, reg["requiredOwnerCases"]),
              {"path": str(evidence / "results.json"), "caseIds": reg["requiredOwnerCases"]})
        evidence = root / "retained-s5"
        env = dict(NODE_ENV="test", CI="1", LOG_LEVEL="silent", AUTH_DEV_BYPASS="1",
                   RATE_LIMIT_PER_MINUTE="100000", FINNOR_TEST_MANAGED_EXTENSIONS="omit",
                   FINNOR_S5_EVIDENCE_DIR=str(evidence), FINNOR_S4_POLICY_STORE=str(evidence / "ordinary-policies"),
                   FINNOR_S3_MODEL_STORE=str(evidence / "ordinary-models"),
                   FINNOR_S3_PYTHON=python, FINNOR_S5_PYTHON=python)
        phase("retained-s5-full14", [NODE, "--import=tsx", "scripts/s5/run-s5-e2e.mts"],
              cut / "finnor-os", 1200, env,
              {"path": str(evidence / "results.json"), "caseIds": reg["requiredRetainedS5Cases"]})
        assert remaining(reg) > 0
        summary["status"] = "PASS_OPERATIONAL_GLOBAL_CAMPAIGN_ONLY"
        summary["originalOwnerCases"] = len(reg["requiredOwnerCases"])
        summary["originalRetainedS5Cases"] = len(reg["requiredRetainedS5Cases"])
    except BaseException as error:
        summary["failedPredicate"] = type(error).__name__ + ": " + str(error)
    finally:
        summary["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        summary["campaignElapsedSeconds"] = time.monotonic() - reg["startedMonotonicSeconds"]
        summary["actualOrchestratorWallSeconds"] = time.monotonic() - started
        summary["remainingSeconds"] = remaining(reg)
        summary["measuredPhaseBottleneck"] = max(phases, key=lambda x: x["wallSeconds"]) if phases else None
        save(root / "campaign-summary.json", summary)
    print(json.dumps(summary, indent=2))
    return 0 if summary["status"].startswith("PASS") else 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--registration", required=True)
    parser.add_argument("--conformance-only", action="store_true")
    parser.add_argument("--cut")
    args = parser.parse_args()
    if args.conformance_only:
        conformance(args.registration, pathlib.Path(args.cut))
    else:
        sys.exit(main(args.registration))
