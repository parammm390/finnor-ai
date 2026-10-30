"""Failure-first real producer/checker process E2E, not native or protected proof.

Freeze original inputs/expected values BEFORE product edits. Never revise them
from candidate output. Reuse the unchanged original exhaustive oracle only
where its fixed monitor family is an independently complete reference.
"""
import argparse
import copy
import hashlib
import json
import os
import pathlib
import resource
import subprocess
import sys
import time

from reference import exhaustive

REPO = pathlib.Path(__file__).resolve().parents[4]
CORE = REPO / "finnor-os/packages/epistemic-runtime/src/project-z/z3-viability"
ORIGINAL_PINS = {
    CORE / "checker.py": "b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e",
    pathlib.Path(__file__).with_name("reference.py"): "fa267cb6f8d70c4f07271d7ceef68a7a68b4fad9dd792185d2bf6fd17bcbf84e",
}


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    with path.open("x") as stream:
        stream.write(value)


def arena(name, owners, targets, assumptions, goals, initial=None, unsafe=()):
    n = len(owners)
    return {
        "schema": "finnor.z3.public-arena.v1", "id": name,
        "observationMode": "PUBLIC_PERFECT_INFORMATION",
        "states": [{"id": str(v), "owner": owner, "observation": str(v),
                    "safe": v not in unsafe, "remaining": 0, "unknown": []}
                   for v, owner in enumerate(owners)],
        "edges": [{"from": str(v), "to": str(w), "action": f"edge-{i}",
                   "renewalRef": None, "settlementRef": None}
                  for v, row in enumerate(targets) for i, w in enumerate(row)],
        "initial": [str(v) for v in (range(n) if initial is None else initial)],
        "assumptions": [[str(v) for v in row] for row in assumptions],
        "goals": [[str(v) for v in row] for row in goals],
        "resources": {"capacity": 0, "maximum": 0, "obligationIds": [],
                      "renewalRefs": [], "settlementRefs": [], "unknownOccupiesCapacity": True},
    }


def binding(name):
    return {
        "tenantId": "PUBLIC_NOT_AUTH", "principalId": "PUBLIC_NOT_OWNER",
        "workId": "PUBLIC_" + name, "workInputId": "PUBLIC_INPUT", "originalParentId": "PUBLIC_PARENT",
        "sourceRevision": "source-1", "rightsRevision": "rights-1", "mandateDigest": "0" * 64,
        "observationDigest": "1" * 64, "resourceDigest": "2" * 64,
        "deadlineAt": "2030-01-01T00:00:00.000Z", "codeDigest": "3" * 64,
    }


def freeze(output):
    cases = []

    def add(a, expected, region, basis, limits=None):
        request = {"arena": a, "binding": binding(a["id"])}
        if limits:
            request["limits"] = limits
        cases.append({"id": a["id"], "request": request, "status": expected,
                      "nonconflictingRegion": region, "basis": basis})

    split = arena("split-justice-memory", "CCC", [[1, 2], [0], [0]], [[1]], [[2]])
    add(split, "VIABLE", [0, 1, 2], "Original alternating h,a,h,b witness. Legacy one-memory oracle is incomplete for this case.")
    add(arena("four-arm-justice", "CCCCC", [[1, 2, 3, 4], [0], [0], [0], [0]],
              [[1], [2]], [[3], [4]]), "VIABLE", list(range(5)),
        "Rotate all four original hub arms; all initial states.")
    add(arena("eight-controller-choices", "CCCCC", [[0, 0, 0, 0, 1, 2, 3, 4], [0], [0], [0], [0]],
              [[1], [2]], [[3], [4]]), "VIABLE", list(range(5)),
        "Four fair arms remain available among eight distinct original action labels.")
    add(arena("conditional-environment-wait", "CECC", [[1], [1, 2], [3], [0]],
              [[2]], [[3]]), "VIABLE", list(range(4)),
        "Every fair run visits 2 then 3. Environment can safely wait forever at 1.")
    add(arena("eight-environment-outcomes", "CECC", [[1], [1] * 7 + [2], [3], [0]],
              [[2]], [[3]]), "VIABLE", list(range(4)),
        "All eight outcomes remain present; only fairness, not prediction, implies exit.")
    add(arena("incompatible-commitments", "CCC", [[1, 2], [1], [2]], [[1]], [[2]]),
        "UNREALIZABLE", [], "No path can recur in both absorbing 1 and 2; ordinary vacuous win is not nonconflict.")
    add(arena("impossible-assumption", "E", [[0]], [[]], [[0]]),
        "UNREALIZABLE", [], "No original fair path exists.")
    add(arena("unsafe-even-if-unfair", "EE", [[0, 1], [1]], [[]], [[0]], initial=[0], unsafe=[1]),
        "UNREALIZABLE", [], "Environment can choose unsafe 1, independently of fairness.")
    add(arena("nonbottom-fair-bad-cycle", "CEE", [[1, 2], [1, 2], [2]], [], [[2]], initial=[0]),
        "VIABLE", [0, 2], "Controller must choose 2; 1 has a non-bottom fair bad SCC despite its exit to 2.")
    add(arena("all-initials-required", "CEE", [[1, 2], [1, 2], [2]], [], [[2]], initial=[0, 1]),
        "UNREALIZABLE", [0, 2], "Initial 1 cannot be discarded.")
    add(arena("unconditional-empty-justice", "E", [[0]], [], []),
        "VIABLE", [0], "Both empty justice lists mean V.")
    add(arena("fair-wait-choice", "CC", [[0, 1], [0]], [], [[1]]),
        "VIABLE", [0, 1], "Always choose 1 at 0; fair waiting at 0 is losing.")
    targets = [[] for _ in range(256)]
    targets[0] = [1, 64, 128, 192]
    ends = []
    for start, end in ((1, 63), (64, 127), (128, 191), (192, 255)):
        for v in range(start, end):
            targets[v] = [v + 1]
        targets[end] = [0]
        ends.append(end)
    add(arena("full-256-state-profile", "C" * 256, targets, [[ends[0]], [ends[1]]],
              [[ends[2]], [ends[3]]]), "VIABLE", list(range(256)),
        "Subdivision preserves four-arm recurrence; every original state is initial.")
    # Original SCC oracle, computed now, before candidate implementation/output.
    for i in range(24):
        target_rows = ([[0], [1]], [[1], [0]], [[0, 1], [0, 1]], [[0, 1], [0]])[i % 4]
        owners = ("CC", "CE", "EC", "EE")[(i // 4) % 4]
        assumptions = ([], [[0]], [[1]], [[0], [1]])[(i // 3) % 4]
        goals = ([], [[0]], [[1]], [[0], [1]])[(i // 2) % 4]
        a = arena(f"original-small-{i:02d}", owners, target_rows, assumptions, goals)
        oracle = exhaustive(a)
        if "unsupported" in oracle:
            raise RuntimeError("PRECODE_ORACLE_BOUND")
        status = "VIABLE" if oracle["nonconflictingRegion"] == [0, 1] else "UNREALIZABLE"
        add(a, status, oracle["nonconflictingRegion"], {"unchangedOriginalOracle": oracle})
    partial = copy.deepcopy(split)
    partial["id"] = "partial-observation"
    partial["states"][1]["observation"] = "0"
    add(partial, "UNSUPPORTED", None, "Unchanged original parser rejects indistinguishable private states.")
    limited = copy.deepcopy(split)
    limited["id"] = "exhausted-operations"
    add(limited, "UNKNOWN", None, "One allowed operation cannot produce complete evidence.", {"maxOperations": 1})
    limited = copy.deepcopy(split)
    limited["id"] = "exhausted-iterants"
    add(limited, "UNKNOWN", None, "One iterant cannot certify even safety convergence.", {"maxIterants": 1})
    body = {"schema": "finnor.z3.nonconflicting-precode-inputs.v1", "protected": False,
            "originalPins": {str(p.relative_to(REPO)): pin for p, pin in ORIGINAL_PINS.items()},
            "cases": cases,
            "mutations": ["nonconflict-certificate", "ordinary-certificate", "region", "memory",
                          "wait", "nonbottom", "starve-assumption", "binding", "edge", "goal"]}
    data = canonical(body) + "\n"
    write(output / "inputs.json", data)
    print(canonical({"inputs": len(cases), "sha256": sha(data.encode()), "protected": False}))


def run(args):
    output = args.output / "process-01"
    output.mkdir()
    frozen_bytes = (args.inputs or args.output / "inputs.json").read_bytes()
    frozen = json.loads(frozen_bytes)
    report = {"schema": "finnor.z3.nonconflicting-process.v1", "status": "FAIL",
              "scope": "PUBLIC_ORIGINAL_SEMANTICS_ENGINEERING_NOT_NATIVE_OR_PROTECTED",
              "inputsSha256": sha(frozen_bytes), "commands": [], "failures": [],
              "native": "NOT_RUN", "installed": "NOT_RUN", "protected": "NOT_RUN",
              "business100x": "NOT_RUN", "financial100x": "UNKNOWN",
              "nativeRemainingBudgets": "UNKNOWN_NOT_RENEWED",
              "lockedBounds": {"memories": 4, "productVertices": 1024}}
    started = time.monotonic()
    usage = resource.getrusage(resource.RUSAGE_SELF)
    environment = {"PATH": str(args.node.parent) + ":/usr/bin:/bin", "LANG": "C.UTF-8",
                   "NODE_ENV": "test", "NODE_OPTIONS": "--max-old-space-size=4096"}
    try:
        for path, expected in ORIGINAL_PINS.items():
            if sha(path.read_bytes()) != expected:
                raise RuntimeError("ORIGINAL_CHECKER_OR_ORACLE_CHANGED")
        available = os.statvfs(REPO).f_bavail * os.statvfs(REPO).f_frsize
        memory = {line.split(":")[0]: int(line.split()[1]) * 1024
                  for line in pathlib.Path("/proc/meminfo").read_text().splitlines()
                  if line.startswith("MemAvailable:")}["MemAvailable"]
        report["guards"] = {"freeDiskBytes": available, "availableMemoryBytes": memory,
                            "requiredBytes": 4294967296, "childWallCapSeconds": 120}
        if min(available, memory) < 4294967296:
            raise RuntimeError("UNCHANGED_DISK_OR_MEMORY_GUARD")
        cpus = sorted(os.sched_getaffinity(0))[:2]
        os.sched_setaffinity(0, cpus)
        report["guards"]["cpus"] = cpus

        def invoke(label, command, rows):
            before = resource.getrusage(resource.RUSAGE_CHILDREN)
            t = time.monotonic()
            child = subprocess.Popen(command, cwd=REPO, env=environment,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                stdout, stderr = child.communicate("".join(canonical(row) + "\n" for row in rows).encode(), timeout=120)
            except subprocess.TimeoutExpired:
                child.kill()
                stdout, stderr = child.communicate(timeout=5)
                write(output / (label + ".stdout.ndjson"), stdout.decode())
                write(output / (label + ".stderr.log"), stderr.decode())
                raise RuntimeError("PHYSICAL_CHILD_TIMEOUT:" + label)
            after = resource.getrusage(resource.RUSAGE_CHILDREN)
            write(output / (label + ".stdout.ndjson"), stdout.decode())
            write(output / (label + ".stderr.log"), stderr.decode())
            report["commands"].append({"label": label, "argv": command, "exit": child.returncode,
                                       "wallSeconds": time.monotonic() - t, "pid": child.pid,
                                       "userCpuSeconds": after.ru_utime - before.ru_utime,
                                       "systemCpuSeconds": after.ru_stime - before.ru_stime,
                                       "childrenMaxRssKiB": after.ru_maxrss,
                                       "stdoutSha256": sha(stdout), "stderrSha256": sha(stderr)})
            if child.returncode:
                raise RuntimeError("CHILD_EXIT:" + label)
            result = [json.loads(line) for line in stdout.splitlines()]
            if len(result) != len(rows):
                raise RuntimeError("EXACT_PROCESS_DENOMINATOR:" + label)
            return result

        cases = frozen["cases"]
        requests = [c["request"] for c in cases]
        candidates = invoke("producer", [str(args.node), str(args.cli), "produce-batch"], requests)
        checks = invoke("checker", [sys.executable, "-I", str(args.checker), "--batch"],
                        [{**r, "candidate": c} for r, c in zip(requests, candidates)])
        records = []
        for case, candidate, check in zip(cases, candidates, checks):
            if check["status"] != case["status"]:
                report["failures"].append([case["id"], "STATUS", case["status"], check])
            if case["nonconflictingRegion"] is not None:
                actual = candidate.get("nonconflicting", {}).get("region")
                if actual != case["nonconflictingRegion"] or check.get("nonconflictingComplete") is not True:
                    report["failures"].append([case["id"], "COMPLETE_NONCONFLICTING_REGION", actual])
            if candidate.get("disposition") == "COMPLETE":
                count = len(candidate["strategy"]["memories"])
                product = len(case["request"]["arena"]["states"]) * count
                if not 1 <= count <= 4 or product > 1024 or candidate["metrics"]["productVertices"] != product:
                    report["failures"].append([case["id"], "LOCKED_STRATEGY_PRODUCT_BOUND", count, product])
                if case["id"] in ("four-arm-justice", "full-256-state-profile") and count != 4:
                    report["failures"].append([case["id"], "FOUR_CHASED_GOAL_MODES", count])
            records.append({"id": case["id"], "expected": case, "candidate": candidate, "check": check})
        write(output / "records.ndjson", "".join(canonical(row) + "\n" for row in records))
        mutation_rows = []
        by_id = {case["id"]: (case["request"], candidate) for case, candidate in zip(cases, candidates)}
        for mode in frozen["mutations"]:
            name = "nonbottom-fair-bad-cycle" if mode == "nonbottom" else "fair-wait-choice" if mode == "wait" else "split-justice-memory"
            request, candidate = copy.deepcopy(by_id[name])
            if mode == "nonconflict-certificate":
                candidate["nonconflicting"]["certificate"][0] = "0"
            elif mode == "ordinary-certificate":
                candidate["certificate"]["safety"][0] = "0"
            elif mode == "region":
                candidate["nonconflicting"]["region"] = []
            elif mode == "memory":
                candidate["strategy"]["updates"][0][0] = 999
            elif mode in ("wait", "nonbottom", "starve-assumption"):
                source = request["arena"]["states"][0]["id"]
                target = "0" if mode == "wait" else "1" if mode == "nonbottom" else "2"
                edge = next(i for i, e in enumerate(request["arena"]["edges"]) if e["from"] == source and e["to"] == target)
                for row in candidate["strategy"]["actions"]:
                    row[0] = edge
            elif mode == "binding":
                request["binding"]["rightsRevision"] = "revoked"
            elif mode == "edge":
                request["arena"]["edges"][0]["to"] = "0"
            elif mode == "goal":
                request["arena"]["goals"] = [[]]
            mutation_rows.append({**request, "candidate": candidate})
        mutation_modes = list(frozen["mutations"])
        for mode in ("boolean-initial-memory", "boolean-mode-label"):
            request, candidate = copy.deepcopy(by_id["split-justice-memory"])
            if mode == "boolean-initial-memory":
                candidate["strategy"]["initial"][0] = False
            else:
                candidate["strategy"]["memories"][0]["a"] = False
            mutation_rows.append({**request, "candidate": candidate})
            mutation_modes.append(mode)
        if args.rejected_records:
            rejected = [json.loads(line) for line in args.rejected_records.read_text().splitlines()]
            for name in ("four-arm-justice", "full-256-state-profile"):
                row = next(row for row in rejected if row["id"] == name)
                if len(row["candidate"]["strategy"]["memories"]) != 8:
                    raise RuntimeError("REJECTED_EIGHT_MEMORY_PREIMAGE_MISSING")
                mutation_rows.append({**row["expected"]["request"], "candidate": row["candidate"]})
                mutation_modes.append("rejected-expanded-" + name)
        mutations = invoke("mutations", [sys.executable, "-I", str(args.checker), "--batch"], mutation_rows)
        for mode, check in zip(mutation_modes, mutations):
            if check["status"] != "REJECTED":
                report["failures"].append([mode, "FALSIFIER_NOT_REJECTED", check])
        write(output / "mutation-inputs.ndjson", "".join(canonical(row) + "\n" for row in mutation_rows))
        report["cases"] = len(cases)
        report["mutations"] = len(mutations)
        report["mutationNames"] = mutation_modes
        report["originalPinsUnchanged"] = True
        report["source"] = {str(path.relative_to(REPO)): sha(path.read_bytes())
                            for path in sorted(CORE.glob("*")) if path.is_file()}
        report["producerBundleSha256"] = sha(args.cli.read_bytes())
        report["checkerAdapterSha256"] = sha(args.checker.read_bytes())
        report["status"] = "PASS" if not report["failures"] else "FAIL"
    except Exception as error:
        report["failures"].append({"type": type(error).__name__, "message": str(error)})
    finally:
        after = resource.getrusage(resource.RUSAGE_SELF)
        report["wallSeconds"] = time.monotonic() - started
        report["parentUserCpuSeconds"] = after.ru_utime - usage.ru_utime
        report["parentSystemCpuSeconds"] = after.ru_stime - usage.ru_stime
        report["parentMaxRssKiB"] = after.ru_maxrss
        write(output / "report.json", json.dumps(report, indent=2) + "\n")
        print(canonical(report))
    if report["status"] != "PASS":
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--freeze", action="store_true")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--node", type=pathlib.Path)
    parser.add_argument("--cli", type=pathlib.Path)
    parser.add_argument("--checker", type=pathlib.Path)
    parser.add_argument("--inputs", type=pathlib.Path)
    parser.add_argument("--rejected-records", type=pathlib.Path)
    args = parser.parse_args()
    if not args.output.is_absolute():
        parser.error("Absolute --output required")
    if any(path and not path.is_absolute() for path in (args.inputs, args.rejected_records)):
        parser.error("Absolute evidence paths required")
    if args.freeze:
        freeze(args.output)
    else:
        if not all(path and path.is_absolute() for path in (args.node, args.cli, args.checker)):
            parser.error("Absolute --node, --cli and --checker required")
        run(args)


if __name__ == "__main__":
    main()
