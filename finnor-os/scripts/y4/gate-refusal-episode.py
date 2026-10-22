"""Registered negative packaging at the real source/installation/evidence gate."""
import argparse
import copy
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from engineering_gates import GATE_REFUSAL_CASES


def sha(body):
    return hashlib.sha256(body).hexdigest()


def dump(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if not args.manifest.is_absolute() or args.manifest.resolve(strict=True) != args.manifest \
            or not args.evidence.is_absolute() or args.evidence.exists() \
            or args.evidence.resolve(strict=False) != args.evidence \
            or not args.evidence.is_relative_to(Path("/home/factory-user/y4-delivery")):
        raise ValueError("NEW_CONTAINED_TASK_EPISODE_REQUIRED")
    config = json.loads(args.manifest.read_bytes())
    if config["completionGate"] != "E2E_DEV_VERIFIED":
        raise ValueError("ACTUAL_COMPLETION_CONFIGURATION_REQUIRED")
    sources = {item["name"]: item["source"] for item in config["publicEvidence"]}
    if len(sources) != len(config["publicEvidence"]):
        raise ValueError("DISTINCT_ORIGINAL_PUBLIC_EVIDENCE_REQUIRED")
    raw = {name: Path(path).read_bytes() for name, path in sources.items()}
    original = {path: sha(raw[name]) for name, path in sources.items()}
    index = json.loads(raw["engineering-gates.json"])
    driver = Path(__file__).with_name("seal-handoff.py")
    results = []
    report = {"schema": "finnor.y4.gate-refusal-e2e.v1", "status": "FAIL",
              "actualSealerInvocations": True, "protectedAdmission": False,
              "driverSha256": sha(Path(__file__).read_bytes()),
              "sealerSha256": sha(driver.read_bytes()),
              "gateValidatorSha256": sha(Path(__file__).with_name("engineering_gates.py").read_bytes()),
              "sourceReviewManifestSha256": sha(Path(config["reviewManifest"]).read_bytes()), "results": results}
    args.evidence.mkdir(mode=0o700)
    try:
        for case, predicate in GATE_REFUSAL_CASES.items():
            directory = args.evidence / case
            directory.mkdir(mode=0o700)
            changed, candidate, selected = {}, copy.deepcopy(index), None

            def load(name):
                return json.loads(changed.get(name, raw[name]))

            def observation(gate_id, role):
                nonlocal selected
                selected = gate_id
                gate = next(g for g in candidate["gates"] if g["id"] == gate_id)
                proof = load(gate["publicEvidenceName"])
                name = next(i["name"] for i in proof["observations"] if i["role"] == role)
                return name, load(name)

            if case == "duplicate-gate":
                candidate["gates"][1] = copy.deepcopy(candidate["gates"][0])
            elif case == "duplicate-observation-role":
                selected = "installed-lifecycle"
                gate = next(g for g in candidate["gates"] if g["id"] == selected)
                proof = load(gate["publicEvidenceName"])
                proof["observations"].append(copy.deepcopy(proof["observations"][0]))
                changed[gate["publicEvidenceName"]] = dump(proof)
            else:
                if case in ("wrong-product-case", "stale-product-driver", "incomplete-product-stages"):
                    name, value = observation("installed-lifecycle", "product")
                    if case == "wrong-product-case":
                        value["case"] = "authority"
                    elif case == "stale-product-driver":
                        value["driverInputs"][0]["sha256"] = "0" * 64
                    else:
                        value["results"] = [r for r in value["results"] if r["id"] != "recipient-release"]
                elif case == "missing-protocol-fault":
                    name, value = observation("adverse-and-custody", "adverse")
                    value["requestedFaults"].remove("message")
                elif case in ("open-individual-review", "nonpassing-individual-review"):
                    name, value = observation("independent-review", "correctness")
                    if case == "open-individual-review":
                        value["status"] = "PASS"
                        value["findings"] = [{"id": "REGISTERED_NEGATIVE_OPEN_FINDING", "status": "OPEN"}]
                    else:
                        value["status"], value["findings"] = "FAIL", []
                else:
                    name, value = observation("offline-reconstruction", "reconstruction")
                    value["reconstructedSourceFiles"][
                        "finnor-os/packages/private-equity/src/confidential-computation/public_driver.py"] = "0" * 64
                changed[name] = dump(value)
            # Re-pin all changed observations so a semantic refusal is required.
            for gate in candidate["gates"]:
                proof_name = gate["publicEvidenceName"]
                proof = load(proof_name)
                for item in proof["observations"]:
                    item["sha256"] = sha(changed.get(item["name"], raw[item["name"]]))
                changed[proof_name] = dump(proof)
                gate["sha256"] = sha(changed[proof_name])
            # The target gate runs first, independently of later pending gates.
            if selected:
                candidate["gates"].sort(key=lambda g: g["id"] != selected)
            changed["engineering-gates.json"] = dump(candidate)
            variant = copy.deepcopy(config)
            for i, item in enumerate(variant["publicEvidence"]):
                if item["name"] in changed:
                    folder = directory / "items" / str(i)
                    folder.mkdir(mode=0o700, parents=True)
                    path = folder / "result.json"
                    path.write_bytes(changed[item["name"]])
                    item["source"] = str(path)
            manifest, output = directory / "manifest.json", directory / "refused-handoff"
            manifest.write_bytes(dump(variant))
            completed = subprocess.run([sys.executable, "-B", str(driver), "--manifest", str(manifest),
                                        "--output", str(output)], stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, timeout=120, check=False)
            (directory / "sealer.log").write_bytes(completed.stdout)
            observed = predicate if ("ValueError: " + predicate) in completed.stdout.decode().splitlines() else None
            passed = completed.returncode != 0 and observed == predicate and not output.exists()
            results.append({"id": case, "status": "PASS" if passed else "FAIL",
                            "exitCode": completed.returncode, "expectedPredicate": predicate,
                            "observedPredicate": observed, "outputCreated": output.exists()})
            if not passed:
                raise ValueError("REGISTERED_SEALER_REFUSAL_NOT_OBSERVED")
        report["originalEvidenceBytesUnchanged"] = all(sha(Path(p).read_bytes()) == h for p, h in original.items())
        if not report["originalEvidenceBytesUnchanged"]:
            raise ValueError("ORIGINAL_PUBLIC_EVIDENCE_CHANGED")
        report["status"] = "PASS"
    finally:
        (args.evidence / "gate-refusal-e2e.json").write_bytes(dump(report))
    print(json.dumps({"status": report["status"], "cases": len(results), "protectedAdmission": False}))


if __name__ == "__main__":
    main()
