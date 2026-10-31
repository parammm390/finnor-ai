"""Independent original-row/counter comparison, no production selector imports."""
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import sys

source, output = map(Path, sys.argv[1:])
record = json.loads(source.read_text())
result = {"schema": "finnor.w1.native-on-off-oracle.v1", "status": "FAIL",
          "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
          "empiricalGainQualified": False, "economicGainQualified": False}
try:
    assert record["schema"] == "finnor.w1.actual-native-on-off.v1"
    assert [arm["arm"] for arm in record["arms"]] == ["OFF", "ON"]
    values = {key: Fraction(value) for key, value in record["originalValues"].items()}
    equity, leverage = values["EV"] - values["debt"] - values["liability"], values["debt"] / values["EBITDA"]
    assert equity == 43 and leverage == Fraction(7, 2)
    summary = []
    for arm in record["arms"]:
        original, before, after = [arm[key] for key in ("originalEpisode", "before", "after")]
        for key in ("id", "deadline_at", "max_attempts", "max_steps", "max_candidates", "max_depth"):
            assert original[key] == before[key] == after[key], (arm["arm"], key)
        assert original["attempts_used"] < before["attempts_used"] < after["attempts_used"] <= after["max_attempts"]
        assert after["steps_used"] <= after["max_steps"] and after["candidates_used"] <= after["max_candidates"]
        assert arm["program"]["status"] == "TESTED"
        observed = arm["program"]["program"]["result"]["values"]
        assert Fraction(observed["netEquity"]["value"]) == equity
        assert Fraction(observed["leverage"]["value"]) == leverage
        attempts, units = arm["attempts"], arm["units"]
        assert len({attempt["id"] for attempt in attempts}) == len(attempts)
        physical = [attempt for attempt in attempts if next(unit for unit in units if unit["id"] == attempt["unit_id"])["kind"] not in ("CONTROL_W1", "CONTROL_M2")]
        controllers = [attempt for attempt in attempts if attempt not in physical]
        # CONTROL_W1 is real charged cognition, not free orchestration.
        assert len(attempts) == after["attempts_used"] - original["attempts_used"]
        assert sum(Fraction(str(row["spent"])) for row in arm["grant"]) == len(attempts)
        assert all(attempt["status"] == "COMPLETED" for attempt in attempts)
        assert len(physical) > 0
        checks = [unit for unit in units if unit["kind"] == "VERIFY_P1" and unit["status"] == "COMPLETED"]
        assert checks
        assert all(unit["result"]["checks"] and all(check["status"] == "PASS" for check in unit["result"]["checks"]) for unit in checks)
        applied = [event for event in arm["events"] if event["kind"] == "W1_NEXT_COMPUTATION_APPLIED"]
        if arm["enabled"]:
            assert arm["capsules"] and applied and controllers
            native_oracle = json.loads((source.parent / "ON/independent-oracle.json").read_text())
            assert native_oracle["status"] == "PASS"
        else:
            assert not arm["capsules"] and not applied and not controllers
        assert arm["billingUSD"] is None
        assert arm["auth"] == "ACTUAL_SIGNED_BEARER_AUTH_DEV_BYPASS_0"
        summary.append({"arm": arm["arm"], "accepted": True, "physicalAttemptsIncludingWarmup": len(physical),
                        "controllerAttemptsIncludingWarmup": len(controllers),
                        "totalChargedAttemptsIncludingWarmup": len(attempts), "capsules": len(arm["capsules"]),
                        "actualW1Dispatches": len(applied), "parentAttemptsUsed": after["attempts_used"],
                        "elapsedIncludingSetupWarmupAndCheckingMs": arm["elapsedIncludingSetupWarmupAndCheckingMs"],
                        "billingUSD": None})
    off, on = record["arms"]
    for key in ("sources", "acceptance", "limits", "instruction"):
        left, right = json.loads(json.dumps(off["originalRequest"][key])), json.loads(json.dumps(on["originalRequest"][key]))
        if key == "sources":
            for collection in (left, right):
                for item in collection:
                    item["source"]["subject"] = "<fresh-arm-subject>"
        assert left == right, ("MATCHED_ORIGINAL_CONTRACT", key)
    assert off["originalGrant"]["owner"] == on["originalGrant"]["owner"] == "S5"
    result.update(status="PASS", originalEquity=str(equity), originalLeverage=str(leverage),
                  summary=summary, conclusion="ACTUAL_W1_MECHANISM_DIFFERENCE_ONLY_NO_QUALIFIED_GAIN",
                  limitations=record["limitations"])
except Exception as error:
    result.update(failure=str(error), failureType=type(error).__name__)
with output.open("x") as out:
    out.write(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
raise SystemExit(0 if result["status"] == "PASS" else 1)
