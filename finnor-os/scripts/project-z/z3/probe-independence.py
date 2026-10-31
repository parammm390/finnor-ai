#!/usr/bin/env python3
"""Frozen structural-independence and digest-stage forgery probes.

Closes two evidence gaps left by the main sweep (runs/02):
  1. Structural independence of the checker from the producer, bound to the
     pinned artifact digests (stdlib-only AST audit, no file/subprocess
     coupling in either direction, disjoint runtimes).
  2. Digest-stage rejection of candidate-side forgeries (claimed arena/binding
     digests flipped while content is untouched) and the deliberate semantic
     irrelevance of meter floats (metrics are stripped from the candidate
     digest; mutating only metrics must not change acceptance or the digest).
Also recomputes every retained digest in runs/02 records with this third,
independent Python implementation and requires population-wide agreement.

No DB/Auth/listener/provider is accessed. Output directory is immutable.
"""
import argparse
import ast
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
REPO = ROOT.parent
EVIDENCE = REPO / "scope-z/phase-evidence/z3"
KERNEL = ROOT / "packages/epistemic-runtime/src/project-z/z3-viability"
PRIOR = EVIDENCE / "runs/02-checker-hardening/records.ndjson"
PINNED = {"cli.mjs": "43a3d180cf01602ccacfc01147d934a5f3a5a437f5767eccb1a1ce933bdaa4d7",
          "checker.py": "b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e"}
STDLIB_ALLOWED = {"hashlib", "json", "sys", "time"}


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def sha(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def sha_file(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def invoke(command, requests):
    result = subprocess.run(command, input="".join(canonical(r) + "\n" for r in requests),
                            text=True, capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f"child exit {result.returncode}: {result.stderr[:2000]}")
    rows = [json.loads(line) for line in result.stdout.splitlines()]
    if len(rows) != len(requests):
        raise RuntimeError("input/output denominator mismatch")
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cli", type=pathlib.Path, required=True)
    parser.add_argument("--checker", type=pathlib.Path, default=KERNEL / "checker.py")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError("Refusing to overwrite retained run")
    failures, report = [], {"schema": "finnor.z3.independence-digest-probe.v1"}

    commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"],
                            text=True, capture_output=True).stdout.strip()
    report["commit"] = commit
    report["frozenDigest"] = sha(json.loads((EVIDENCE / "frozen-public-cases-v2.json").read_text()))

    # 1. Frozen structural independence, bound to pinned artifact digests.
    artifacts = {"cli.mjs": args.cli, "checker.py": args.checker}
    digests = {name: sha_file(path) for name, path in artifacts.items()}
    report["artifacts"] = digests
    for name, digest in digests.items():
        if digest != PINNED[name]:
            failures.append([name, "PINNED_ARTIFACT_DIGEST_CHANGED", digest])

    checker_source = args.checker.read_text()
    tree = ast.parse(checker_source)
    imports = sorted({node.names[0].name.split(".")[0] for node in ast.walk(tree)
                      if isinstance(node, ast.Import)}
                     | {node.module.split(".")[0] for node in ast.walk(tree)
                        if isinstance(node, ast.ImportFrom) and node.module})
    report["checkerImports"] = imports
    if not set(imports) <= STDLIB_ALLOWED:
        failures.append(["checker.py", "NON_STDLIB_IMPORT", imports])
    coupling = {"open(": len(re.findall(r"\bopen\(", checker_source)),
                "subprocess": checker_source.count("subprocess"),
                "socket": checker_source.count("socket"),
                "eval(/exec(": len(re.findall(r"\b(eval|exec)\(", checker_source)),
                "cli.mjs": checker_source.count("cli.mjs")}
    report["checkerCouplingTokens"] = coupling
    if any(coupling.values()):
        failures.append(["checker.py", "OPERATIONAL_COUPLING_TOKEN_PRESENT", coupling])
    bundle = args.cli.read_text()
    report["producerMentionsChecker"] = bundle.count("checker")
    if bundle.count("checker"):
        failures.append(["cli.mjs", "PRODUCER_REFERENCES_CHECKER"])
    report["runtimes"] = {"producer": "node/typescript bundle", "checker": "python3 stdlib"}

    # 2. Live digest-stage forgery and metrics-irrelevance probes on F01-1.
    frozen = json.loads((EVIDENCE / "frozen-public-cases-v2.json").read_text())
    case = next(c for c in frozen["cases"] if c["id"] == "F01-1")
    request = {"arena": case["arena"], "binding": case["binding"]}
    candidate = invoke(["node", str(args.cli), "produce-batch"], [request])[0]
    if candidate.get("disposition") != "COMPLETE":
        failures.append(["F01-1", "CONTROL_CANDIDATE_NOT_COMPLETE"])
    rows = {"control": candidate}
    forged_arena = dict(candidate, arenaDigest=("0" if candidate["arenaDigest"][0] != "0" else "1")
                        + candidate["arenaDigest"][1:])
    forged_binding = dict(candidate, bindingDigest=("0" if candidate["bindingDigest"][0] != "0" else "1")
                          + candidate["bindingDigest"][1:])
    metered = dict(candidate, metrics={"wallMs": -1.5, "operations": 999999999})
    rows["forge_arena_digest"] = forged_arena
    rows["forge_binding_digest"] = forged_binding
    rows["mutate_metrics_only"] = metered
    checks = invoke([sys.executable, str(args.checker), "--batch"],
                    [{**request, "candidate": rows[key]} for key in
                     ("control", "forge_arena_digest", "forge_binding_digest", "mutate_metrics_only")])
    outcomes = dict(zip(("control", "forge_arena_digest", "forge_binding_digest",
                         "mutate_metrics_only"), checks))
    report["probes"] = {key: {"status": row["status"], "reason": row["reason"],
                              "candidateDigest": row["candidateDigest"]}
                        for key, row in outcomes.items()}
    if outcomes["control"]["status"] != "VIABLE":
        failures.append(["control", "UNMUTATED_CANDIDATE_NOT_VIABLE", outcomes["control"]["reason"]])
    for key in ("forge_arena_digest", "forge_binding_digest"):
        row = outcomes[key]
        if not (row["status"] == "REJECTED" and row["reason"] == "Z3_CHECK_ORIGINAL_OR_CURRENTNESS_BINDING"):
            failures.append([key, "FORGED_DIGEST_NOT_REJECTED_AT_DIGEST_STAGE", row["status"], row["reason"]])
    if not (outcomes["mutate_metrics_only"]["status"] == "VIABLE"
            and outcomes["mutate_metrics_only"]["candidateDigest"] == outcomes["control"]["candidateDigest"]):
        failures.append(["mutate_metrics_only", "METER_FLOATS_CHANGED_ACCEPTANCE_OR_DIGEST"])

    # 3. Population-wide digest agreement over the retained 02 evidence.
    counts = {"records": 0, "arenaDigest": 0, "bindingDigest": 0, "candidateDigest": 0}
    for line in PRIOR.read_text().splitlines():
        record = json.loads(line)
        counts["records"] += 1
        request, candidate, check = record["request"], record["candidate"], record["check"]
        if check["arenaDigest"] == sha(request["arena"]) == candidate["arenaDigest"]:
            counts["arenaDigest"] += 1
        if check["bindingDigest"] == sha(request["binding"]) == candidate["bindingDigest"]:
            counts["bindingDigest"] += 1
        if check["candidateDigest"] == sha({k: v for k, v in candidate.items() if k != "metrics"}):
            counts["candidateDigest"] += 1
    report["retainedDigestAgreement"] = counts
    if not (counts["records"] == counts["arenaDigest"] == counts["bindingDigest"]
            == counts["candidateDigest"] and counts["records"] > 0):
        failures.append(["records", "RETAINED_DIGEST_DISAGREEMENT", counts])

    report["status"] = "PASS" if not failures else "FAIL"
    report["failures"] = failures
    args.output.mkdir(parents=True)
    (args.output / "report.json").write_text(canonical(report) + "\n")
    (args.output / "probe-rows.ndjson").write_text(
        "".join(canonical({"probe": key, "candidate": rows[key], "check": outcomes[key]}) + "\n"
                for key in rows))
    print(canonical({"status": report["status"], "failures": failures,
                     "records": counts["records"], "commit": commit}))
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
