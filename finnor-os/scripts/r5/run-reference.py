"""Finite independent original-input campaign registered before producer code."""
import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import time

from corpus import cases, joint

ROOT = pathlib.Path(__file__).resolve().parents[3]
CHECKER = pathlib.Path(__file__).with_name("reference.py")
started = time.monotonic()
output = pathlib.Path(sys.argv[1])
if not output.is_absolute():
    raise SystemExit("Fresh absolute private output required")
output.mkdir(mode=0o700, parents=True, exist_ok=False)
results = []


def call(name, request, expected_exit=0):
    directory = output / name
    directory.mkdir(mode=0o700)
    data = json.dumps(request, sort_keys=True).encode()
    (directory / "input.json").write_bytes(data)
    remaining = 900 - (time.monotonic() - started)
    if remaining <= 0:
        raise RuntimeError("Original reference campaign deadline exhausted")
    run = subprocess.run([sys.executable, str(CHECKER)], input=data,
                         capture_output=True, timeout=remaining)
    (directory / "stdout.json").write_bytes(run.stdout)
    (directory / "stderr.txt").write_bytes(run.stderr)
    if run.returncode != expected_exit:
        raise RuntimeError("Independent checker exit " + str(run.returncode) + " at " + name)
    return json.loads(run.stdout)


def story(name, expected, run):
    began = time.monotonic()
    try:
        observed = run()
        results.append(dict(id=name, status="PASS", expected=expected, observed=observed,
                            elapsedSeconds=time.monotonic() - began))
    except Exception as error:
        results.append(dict(id=name, status="FAIL", expected=expected, message=str(error),
                            elapsedSeconds=time.monotonic() - began))
    record = dict(schema="finnor.r5.independent-reference-campaign.v1", results=results,
                  elapsedSeconds=time.monotonic() - started,
                  evidenceClass="DETERMINISTICALLY_VERIFIED_REGISTERED_REFERENCE_SUBPROFILE",
                  owners="NOT_RUN", nativeR2="NOT_RUN", mounted="NOT_RUN",
                  installed="NOT_RUN", protectedGain="NOT_RUN", money=None)
    (output / "results.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(dict(id=name, status=results[-1]["status"])), flush=True)


def reference_case(name, p, expected):
    result = call(name, dict(operation="reference", original=p))
    assert result["complete"] and result["partitions"] == expected["partitions"]
    assert result["programmeCombinations"] >= result["partitions"]
    if expected.get("infeasible"):
        assert result["best"] is None
    else:
        assert result["best"]["value"] == expected["optimum"]
    return dict(partitions=result["partitions"],
                programmeCombinations=result["programmeCombinations"],
                rejectedCombinations=result["rejectedCombinations"],
                optimum=result["best"]["value"] if result["best"] else None,
                divisionProfile=result["divisionProfile"])


for name, p, expected in cases():
    story(name, expected, lambda name=name, p=p, expected=expected: reference_case(name, p, expected))

p = joint(2)
positive = call("mutation-basis", dict(operation="reference", original=p))
candidate = dict(selected=positive["best"]["selected"],
                 division=positive["best"]["division"], objective=positive["best"]["value"])


def mutation(name, original, changed, boundary):
    result = call(name, dict(operation="candidate", original=original, candidate=changed), 1)
    assert result["disposition"] == "REJECTED"
    assert result["witnesses"][0]["boundary"] == boundary, result
    return result


missing = copy.deepcopy(candidate)
missing["selected"][0]["members"].pop()
story("missing-member", "membership witness", lambda: mutation("missing-member", p, missing, "membership"))
duplicate = copy.deepcopy(candidate)
duplicate["selected"][0]["members"].append(duplicate["selected"][0]["members"][0])
story("duplicate-member", "membership witness", lambda: mutation("duplicate-member", p, duplicate, "membership"))
steps = copy.deepcopy(candidate)
steps["selected"][0]["steps"] *= 2
story("unadmitted-programme", "original grammar length witness",
      lambda: mutation("unadmitted-programme", p, steps, "grammar"))
money = copy.deepcopy(candidate)
money["division"][0]["amounts"]["party-0"] = "50"
story("money-creation", "conservation witness", lambda: mutation("money-creation", p, money, "conservation"))
unit = copy.deepcopy(p)
unit["grammar"]["operators"][1]["costs"][0]["currency"] = "EUR"
story("original-cost-currency", "accounting witness",
      lambda: mutation("original-cost-currency", unit, candidate, "accounting"))
funding = copy.deepcopy(p)
funding["parties"][0]["settledCash"] = {"downside": ["0", "100"], "upside": ["0", "100"]}
story("late-funds-cannot-pay-early-cost", "prefix-funding witness",
      lambda: mutation("late-funds-cannot-pay-early-cost", funding, candidate, "prefix-funding"))
objective = copy.deepcopy(candidate)
objective["objective"] = "100"
story("false-objective", "full original world objective witness",
      lambda: mutation("false-objective", p, objective, "objective"))
hidden = copy.deepcopy(p)
hidden["transfers"][0]["date"] = 0
story("event-not-yet-available", "event boundary witness",
      lambda: mutation("event-not-yet-available", hidden, candidate, "event"))
spill = copy.deepcopy(p)
spill["model"]["noStrategicSpillover"] = "STRATEGIC_CROSS_COALITION_REACTION"
story("unsupported-spillover", "supplied unsupported mechanism",
      lambda: mutation("unsupported-spillover", spill, candidate, "spillover"))

correlated = joint(2)
for eq in correlated["grammar"]["operators"][1]["equations"]:
    party = eq["ownerPartyId"]
    eq["terms"][0]["coefficientId"] = "return-" + party
for index, world in enumerate(correlated["worlds"]):
    world["coefficients"].update({"return-party-0": ["1", "9"][index],
                                  "return-party-1": ["9", "1"][index]})
story("joint-correlated-worlds", "joint optimum 9, not local-worst sum 1",
      lambda: reference_case("joint-correlated-worlds", correlated, {"partitions": 2, "optimum": "9"}))

freeze = dict(sourceDigests={str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                            for path in [CHECKER, pathlib.Path(__file__), CHECKER.with_name("corpus.py")]},
              python=sys.version, originalCampaignWallSeconds=900,
              reproduce="python3 finnor-os/scripts/r5/run-reference.py <fresh-absolute-private-output>",
              qualification="Independent complete reference and candidate mutations; not producer/native/owner completion")
(output / "freeze.json").write_text(json.dumps(freeze, indent=2) + "\n")
raise SystemExit(1 if any(r["status"] != "PASS" for r in results) else 0)
