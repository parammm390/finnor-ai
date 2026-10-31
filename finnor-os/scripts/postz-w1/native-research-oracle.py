"""Independent original-fact/coverage oracle; never imports production code."""
import hashlib
import json
from pathlib import Path
import sys

source, destination = map(Path, sys.argv[1:])
assert not destination.exists()
data = json.loads(source.read_text())
cases = data["observations"]
expected = {
    "consentOrder": "OPEN", "coverageExclusion": "EXCLUDED", "litigation": "SETTLED",
    "wrongCommonPremise": "0.99", "independentPrimaryConcentration": "0.47",
}
assert data["originalExpected"] == expected, "The producer cannot change the original-fact oracle"
assert data["schema"] == "finnor.w1.primary-research-oracle-input.v1"
assert [(row["id"], row["status"]) for row in data["results"]] == [
    ("W003", "PASS"), ("W012", "PASS"), ("W013", "PASS")]


def result(name):
    case = cases[name]
    assert case["output"]["status"] == 200, name
    assert case["before"] == case["after"], name
    value = case["output"]["body"]
    assert value["authorityGranted"] is False
    assert value["productionActivated"] is False
    assert value["costs"]["usd"] is None
    assert value["costs"]["missingCostIsZero"] is False
    assert value["originalDeadlineAt"] == case["input"]["deadlineAt"]
    assert value["coverage"]["required"] == [item["id"] for item in case["input"]["requirements"]]
    assert [item["id"] for item in value["answers"]] == value["coverage"]["required"]
    return value


def answer(value, identity):
    return next(item for item in value["answers"] if item["id"] == identity)


small, broad = result("small"), result("broad")
assert small["allocation"]["physicalSourceReads"] == 1
assert broad["allocation"]["physicalSourceReads"] == 3
assert len({item["sourceId"] for item in broad["witnesses"]}) == 3
assert answer(small, "consentOrder")["value"] == expected["consentOrder"]
assert answer(broad, "coverageExclusion")["value"] == expected["coverageExclusion"]
assert broad["coverage"]["status"] == "COMPLETE"
withheld, restored = result("withheld"), result("restored")
assert withheld["coverage"]["status"] == "INCOMPLETE"
assert withheld["coverage"]["missing"] == [{"id": "litigation", "reason": "MISSING_EVIDENCE"}]
assert len(withheld["coverage"]["required"]) == len(restored["coverage"]["required"]) == 4
assert restored["coverage"]["status"] == "COMPLETE"
assert answer(restored, "litigation")["value"] == expected["litigation"]
assert len({item["sourceId"] for item in restored["witnesses"]}) == 4
repeated, different = result("repeated-wrong-premise"), result("different-primary-record")
assert all(row["value"] == expected["wrongCommonPremise"] for row in repeated["answers"])
assert repeated["allocation"]["physicalSourceReads"] == 1
assert repeated["allocation"]["distinctSourceVersions"] == 1
assert repeated["allocation"]["independenceProbability"] is None
assert repeated["allocation"]["duplicatePathsAreIndependentVotes"] is False
assert answer(different, "independent_concentration")["value"] == expected["independentPrimaryConcentration"]
assert repeated["witnesses"][0]["sourceId"] != different["witnesses"][0]["sourceId"]
race, fresh = result("source-currentness-race"), result("fresh-corrected-primary")
assert answer(race, "concentration")["status"] == "SOURCE_CHANGED"
assert answer(race, "concentration")["value"] is None
assert expected["wrongCommonPremise"] not in json.dumps(race)
assert answer(fresh, "concentration")["value"] == expected["independentPrimaryConcentration"]
assert answer(fresh, "concentration")["witness"]["versionId"] != repeated["witnesses"][0]["versionId"]
for case in cases.values():
    assert case["before"] == case["after"], "A negative request activated agency"
receipt = {
    "schema": "finnor.w1.primary-research-independent-oracle.v1",
    "status": "PASS_INDEPENDENT_PRIMARY_RESEARCH_ORACLE",
    "caseIds": ["W003", "W012", "W013"],
    "inputSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "oracleSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "scope": "Original typed facts, required-set completeness, distinct source witnesses, no duplicate confidence and actual source-change race",
    "economicQualification": False,
}
with destination.open("x") as output:
    output.write(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
