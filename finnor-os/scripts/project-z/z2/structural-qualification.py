"""Fresh registered original-input mode of structural-replay.py, no native services."""
import copy
from fractions import Fraction as F
import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import time


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    with path.open("x") as file:
        json.dump(value, file, sort_keys=True, indent=2)
        file.write("\n")


def child_limits():
    resource.setrlimit(resource.RLIMIT_AS, (512*1024**2, 512*1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    resource.setrlimit(resource.RLIMIT_FSIZE, (8*1024**2, 8*1024**2))


def recalculate_beliefs(audit, problem, candidate):
    """Independent original-tree leading monomials, not native assessment code."""
    for model in problem["models"]:
        game = audit.original_game(problem, model, candidate["policy"])
        cert = next(c for c in candidate["models"] if c["modelId"] == model["id"])
        leading = {game["root"]: (0, F(1))}
        for nid, state in game["states"].items():
            order, coefficient = leading[nid]
            for action, child, chance in state["edges"]:
                degree, weight = order, coefficient*chance
                if state["local"]:
                    p = F(candidate["strategy"][state["local"]][action])
                    if p:
                        weight *= p
                    else:
                        rate = cert["trembles"][state["local"]][action]
                        degree += rate["order"]
                        weight *= F(rate["coefficient"])
                leading[child] = (degree, weight)
        for key, info in game["infos"].items():
            degree = min(leading[n][0] for n in info["nodes"])
            mass = sum((leading[n][1] for n in info["nodes"] if leading[n][0] == degree), F(0))
            cert["beliefs"][key] = {n: str(leading[n][1]/mass if leading[n][0] == degree else F(0))
                                    for n in info["nodes"]}


def run(args):
    repo, out = Path(args.repo).resolve(), Path(args.evidence_dir).resolve()
    registration_path = args.qualification_registration.resolve()
    frozen = registration_path.parent
    registration = json.loads(registration_path.read_text())
    assert registration["status"] == "FROZEN" and registration["familyCount"] == 32
    assert registration["casesPerFamily"] == 8 and len(registration["cases"]) == 256
    assert args.reference_root and args.critical_expectations
    expected_critical = json.loads(args.critical_expectations.read_text())
    for name, expected in registration["equipment"].items():
        assert sha(repo/name) == expected, ("FROZEN_ORACLE_DRIFT", name)
    out.mkdir(parents=True, exist_ok=False)
    write(out/"registration.json", registration)
    write(out/"critical-expectations.json", expected_critical)
    scripts = repo/"finnor-os/scripts/project-z/z2"
    engine_rel = Path("finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions")
    native_rel = Path("finnor-os/packages/private-equity/src/interaction-synthesis")
    source = out/"source"
    pins = {}
    for root, rel, names in [
        (repo, engine_rel, ["common.py", "checker.py", "producer.py", "linear.py", "plans.py", "profile.json"]),
        (args.reference_root.resolve(), native_rel, ["checker.py", "producer.py", "reference.py", "profile.json"])
    ]:
        for name in names:
            src, target = root/rel/name, source/rel/name
            assert src.is_file() and not src.is_symlink()
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as file:
                file.write(src.read_bytes())
            target.chmod(0o444)
            pins[str(rel/name)] = {"sha256": sha(target), "origin": str(src)}
    source_pins = {str(p.relative_to(repo)): sha(p) for p in scripts.iterdir()
                   if p.is_file() and p.suffix in (".py", ".json", ".mjs", ".ts")}
    write(out/"source-manifest.json", pins)
    engine, native = source/engine_rel, source/native_rel
    oracle = load("z2_frozen_independent_oracle", scripts/"original-oracle.py")
    audit = load("z2_frozen_independent_audit", scripts/"structural-audit.py")
    equipment = load("z2_untrusted_adverse_equipment", native/"producer.py")
    rows, negatives, steps = [], [], []
    started = time.monotonic()

    def process(target, label, path, request):
        directory = target/label
        directory.mkdir()
        write(directory/"input.json", request)
        command = ["/usr/bin/python3", "-I", "-B", str(path)]
        begin = time.monotonic()
        before = resource.getrusage(resource.RUSAGE_CHILDREN)
        exit_code, signal = None, None
        try:
            child = subprocess.run(command, input=json.dumps(request), capture_output=True, text=True,
                                   timeout=min(120, args.budget_ms/1000+10),
                                   env={"NODE_ENV": "test", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
                                   preexec_fn=child_limits)
            stdout, stderr, exit_code = child.stdout, child.stderr, child.returncode
        except subprocess.TimeoutExpired as error:
            stdout = error.stdout.decode() if isinstance(error.stdout, bytes) else error.stdout or ""
            stderr = error.stderr.decode() if isinstance(error.stderr, bytes) else error.stderr or ""
            signal = "TIMEOUT"
        (directory/"stdout.json").write_text(stdout)
        (directory/"stderr.log").write_text(stderr)
        try:
            value = json.loads(stdout)
        except ValueError:
            value = {"status": "HARNESS_FAILURE", "reason": "PROCESS_OUTPUT_NOT_JSON"}
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        steps.append({"id": str(directory.relative_to(out)), "command": command, "exitCode": exit_code,
                      "signal": signal, "wallMs": round(1000*(time.monotonic()-begin)),
                      "cpuMs": round(1000*(after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime)),
                      "status": value.get("status"), "reason": value.get("reason")})
        return value, exit_code

    def critical(target, label, request, native_check=False):
        value, code = process(target, label, (native if native_check else engine)/"checker.py", request)
        expected = expected_critical[label]
        passed = code == 0 and [value.get("status"), value.get("reason")] == expected
        negatives.append({"id": str((target/label).relative_to(out)), "passed": passed,
                          "expected": expected, "actual": [value.get("status"), value.get("reason")],
                          "exitCode": code})
        assert passed, ("CRITICAL_DISPOSITION", label)

    def adverse(problem):
        keys = equipment.checker.control_keys(problem)
        policy = {k: "unverified" if "unverified" in spec["options"] else spec["options"][0]
                  for k, spec in keys.items()}
        games = [equipment.checker.compile_original(problem, m, policy) for m in problem["models"]]
        strategy = {}
        for game in games:
            for key, info in game["infos"].items():
                preferred = next((a for a in ("withhold", "stay", "decline", "confirm", "left")
                                  if a in info["actionIds"]), info["actionIds"][0])
                strategy[key] = {a: str(int(a == preferred)) for a in info["actionIds"]}
        return equipment.propose(problem, games, policy, strategy, equipment.checker.objective_bound(problem))

    families = args.family or list(range(1, 33))
    for frozen_row in registration["cases"]:
        family, case = frozen_row["family"], frozen_row["case"]
        if family not in families or case >= args.cases:
            continue
        assert shutil.disk_usage(out).free >= 4*1024**3, "DISK_GUARD_REFUSAL"
        for field in ("problem", "expectation"):
            path = frozen/frozen_row[field]
            assert not path.is_symlink() and sha(path) == frozen_row[field+"Sha256"]
        problem = json.loads((frozen/frozen_row["problem"]).read_text())
        expected = json.loads((frozen/frozen_row["expectation"]).read_text())
        target = out/(str(family).zfill(2)+"-"+str(case))
        target.mkdir()
        write(target/"frozen-expectation.json", expected)
        row = {"family": family, "case": case, "expected": expected["expected"], "passed": False,
               "problemSha256": frozen_row["problemSha256"]}
        construction, pc = process(target, "construct", engine/"producer.py",
                                   {"problem": problem, "budgetMs": args.budget_ms})
        checked, cc = process(target, "check", engine/"checker.py", {"problem": problem, "construction": construction})
        row.update(actual=checked.get("status"), reason=checked.get("reason"), producerExit=pc, checkerExit=cc)
        try:
            assert pc == cc == 0 and checked.get("status") == expected["expected"], "REGISTERED_DISPOSITION"
            if family == 30:
                proof = construction["infeasibility"]
                assert proof["kind"] == expected["infeasibilityKind"]
                assert checked["coverage"]["policyCoverage"] == expected["completePolicyCount"] == 2
                actual_policies = {audit.digest(p["policy"]) for p in proof["policies"]}
                assert actual_policies == {audit.digest(p["policy"]) for p in expected["originalPolicies"]}
                for i, exclusion in enumerate(proof["policies"]):
                    candidate = exclusion["candidate"]
                    for model in problem["models"]:
                        game = audit.original_game(problem, model, candidate["policy"])
                        for key, info in game["infos"].items():
                            forced = "withhold" if "withhold" in info["actions"] else "confirm"
                            assert candidate["strategy"][key] == {a: str(int(a == forced)) for a in info["actions"]}
                    independent = oracle.inspect(problem, candidate)
                    assert any(r["profitable"] for r in independent if len(r["coalition"]) == 2)
                    write(target/("independent-impossibility-"+str(i)+".json"), independent)
                row["completeIndependentInfeasibility"] = True
            else:
                candidate = construction["candidate"]
                original_policy = next(p for p in expected["originalPolicies"] if p["policy"] == candidate["policy"])
                assert not any(m["violations"] for m in original_policy["models"])
                assert expected["allowedUnverified"] or "authorized" in candidate["policy"].values()
                independent, ic = process(target, "independent-original-oracle", scripts/"original-oracle.py",
                                          {"problem": problem, "candidate": candidate})
                continuation, rc = process(target, "independent-continuation-reference", native/"reference.py",
                                           {"problem": problem, "candidate": candidate})
                floor, fc = process(target, "original-y3-floor", native/"checker.py",
                                    {"problem": problem, "candidate": candidate})
                assert ic == rc == fc == 0
                assert floor.get("status") == "CHECKED" and floor.get("globalBeliefConsistency") is True
                assert all(m["maxRegret"] == "0" for m in continuation["models"])
                assert len(independent["reports"]) == len(problem["models"])*(2**len(problem["participants"])-1)
                for model in original_policy["models"]:
                    assert independent["utilities"][model["id"]] == model["upperUtilities"], "FROZEN_ORIGINAL_UPPER"
                    for count in model["planCounts"]:
                        report = next(r for r in independent["reports"] if
                                      r["modelId"] == model["id"] and r["coalition"] == count["coalition"])
                        certificate = next(r for r in construction["certificates"] if
                                           r["modelId"] == model["id"] and r["coalition"] == count["coalition"])
                        assert report["planCount"] == count["count"] == certificate["planCount"]
                        assert not report["profitable"] and report["columnsDigest"] == certificate["gainsDigest"]
                row["frozenOriginalUtilitiesAttained"] = True
                if case == 0:
                    request = {"problem": copy.deepcopy(problem), "construction": copy.deepcopy(construction)}
                    request["construction"]["certificates"].pop()
                    critical(target, "omitted-grand-coalition", request)
                    request = {"problem": copy.deepcopy(problem), "construction": copy.deepcopy(construction)}
                    request["problem"]["fixedOperatorRefs"][0]["version"] = "2"
                    critical(target, "original-operator-revision", request)
                    request = {"problem": copy.deepcopy(problem), "construction": copy.deepcopy(construction)}
                    request["problem"]["models"][0]["nodes"][0]["resources"]["capacity"] = "2"
                    changed = oracle.digest(request["problem"])
                    request["construction"]["problemDigest"] = changed
                    request["construction"]["candidate"]["problemDigest"] = changed
                    critical(target, "all-history-resource-bound", request)
                if family in (17, 18):
                    bad = adverse(problem)
                    game = oracle.local_game(problem, problem["models"][0], bad["policy"])
                    columns = oracle.columns(game, bad["strategy"], ["P0", "P1"])
                    first = next(p for p, g in columns if g == (F(4), F(-2)))
                    second = next(p for p, g in columns if g == (F(-1), F(1)))
                    witness = {"modelId": problem["models"][0]["id"], "coalition": ["P0", "P1"],
                               "kind": "PROFITABLE_MIXTURE", "gains": ["1/4", "1/4"],
                               "terms": [{"plan": first, "probability": "1/4"}, {"plan": second, "probability": "3/4"}]}
                    raw = {"status": "CANDIDATE", "problemDigest": oracle.digest(problem),
                           "profileDigest": sha(engine/"profile.json"), "candidate": bad,
                           "certificates": [], "counterstrategy": witness}
                    critical(target, "original-quarter-mixture", {"problem": problem, "construction": raw})
                    forged = copy.deepcopy(raw)
                    forged["counterstrategy"]["terms"][0]["plan"]["I:pooled-other-private-state"] = "ready"
                    critical(target, "pooled-private-state", {"problem": problem, "construction": forged})
                    if family == 18:
                        write(target/"whole-original-outside-grid.json", oracle.outside_grid_report(problem, bad))
                if family in (19, 20) and case == 0:
                    reports = oracle.inspect(problem, adverse(problem))
                    profitable = [r["coalition"] for r in reports if r["profitable"]]
                    if family == 19:
                        assert all(len(c) == 3 for c in profitable) and profitable
                    else:
                        proper = [set(c) for c in profitable if 1 < len(c) < 4]
                        assert any(a != b and a & b for a in proper for b in proper)
                        assert any(len(c) == 4 for c in profitable)
                    write(target/"original-overlapping-coalitions.json", reports)
                if family == 27 and case == 0:
                    critical(target, "individually-unacceptable-native",
                             {"problem": problem, "candidate": adverse(problem)}, native_check=True)
                if family in (24, 25):
                    common = copy.deepcopy(construction)
                    keys = sorted(common["candidate"]["strategy"])
                    for cert in common["candidate"]["models"]:
                        for key, rates in cert["trembles"].items():
                            for action, rate in rates.items():
                                if common["candidate"]["strategy"][key][action] == "0":
                                    rate.update(order=1+keys.index(key)%2, coefficient=str(2+keys.index(key)%3))
                    recalculate_beliefs(audit, problem, common["candidate"])
                    critical(target, "shared-nonunit-native",
                             {"problem": problem, "candidate": common["candidate"]}, native_check=True)
                    critical(target, "shared-nonunit-z2", {"problem": problem, "construction": common})
                    certs = common["candidate"]["models"]
                    shared = set(certs[0]["trembles"]) & set(certs[1]["trembles"])
                    key, action = next((k, a) for k in sorted(shared)
                                       for a, p in common["candidate"]["strategy"][k].items() if p == "0")
                    for field in ("coefficient", "order"):
                        conflict = copy.deepcopy(common)
                        rate = conflict["candidate"]["models"][0]["trembles"][key][action]
                        rate[field] = str(F(rate[field])+1) if field == "coefficient" else rate[field]+1
                        recalculate_beliefs(audit, problem, conflict["candidate"])
                        critical(target, "conflicting-"+field+"-native",
                                 {"problem": problem, "candidate": conflict["candidate"]}, native_check=True)
                        critical(target, "conflicting-"+field+"-z2", {"problem": problem, "construction": conflict})
                    unrelated = copy.deepcopy(common)
                    beliefs = unrelated["candidate"]["models"][0]["beliefs"]
                    belief = next(v for v in beliefs.values() if len(v) > 1)
                    selected = next(n for n, p in belief.items() if p != "1")
                    belief.update({n: str(int(n == selected)) for n in belief})
                    critical(target, "unrelated-belief-native",
                             {"problem": problem, "candidate": unrelated["candidate"]}, native_check=True)
                    critical(target, "unrelated-belief-z2", {"problem": problem, "construction": unrelated})
            row["passed"] = True
        except (AssertionError, KeyError, StopIteration, ValueError) as error:
            row.update(oracleFailure=type(error).__name__, oracleDetail=str(error)[:300])
        rows.append(row)
        (out/"progress.json").write_text(json.dumps({"cases": rows, "negatives": negatives}, indent=2)+"\n")
    unchanged = all(sha(repo/name) == value for name, value in source_pins.items())
    unchanged &= all(sha(source/name) == row["sha256"] for name, row in pins.items())
    failed = sum(not r["passed"] for r in rows)
    complete = len(rows) == 256 and {r["family"] for r in rows} == set(range(1, 33))
    critical_failed = any(not n["passed"] for n in negatives) or (complete and len(negatives) != 254)
    qualified = complete and not failed and not critical_failed and bool(unchanged)
    positives = [r for r in rows if r["family"] != 30]
    report = {"schema": "finnor.project-z.z2.fresh-structural-process-replay.v1", "cases": rows,
              "steps": steps, "negatives": negatives, "passed": len(rows)-failed, "failed": failed,
              "criticalNegativeFailures": sum(not n["passed"] for n in negatives),
              "usefulSupportedPositiveCount": len(positives),
              "usefulSupportedPositivePassed": sum(r["passed"] for r in positives),
              "frozenRegistrationSha256": sha(registration_path),
              "criticalExpectationsSha256": sha(args.critical_expectations),
              "structuralFamiliesQualified": 32 if qualified else None,
              "sourceUnchanged": bool(unchanged), "sourceHashes": source_pins,
              "sourceEquipmentDigest": audit.digest(pins), "wallMs": round(1000*(time.monotonic()-started)),
              "childCpuMs": sum(s["cpuMs"] for s in steps),
              "maxRecordedChildRssBytes": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss*1024,
              "moneyUsd": None, "humanSeconds": None, "aggregatePeakMemoryBytes": None,
              "qualification": "PUBLIC_SOURCE_STRUCTURAL_ONLY", "nativeOwner": "NOT_RUN",
              "protectedAdmission": False, "business100x": "NOT_ESTABLISHED", "wholePhaseAccepted": False}
    write(out/"report.json", report)
    write(out/"sha256.json", {str(p.relative_to(out)): sha(p) for p in sorted(out.rglob("*")) if p.is_file()})
    print(json.dumps({k: report[k] for k in ("passed", "failed", "criticalNegativeFailures",
                                          "structuralFamiliesQualified", "sourceUnchanged", "wallMs")}))
    return int(bool(failed or critical_failed or not unchanged))
