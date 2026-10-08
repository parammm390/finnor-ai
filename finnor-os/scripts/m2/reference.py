"""Independent exact finite accepted-output chain oracle; no production imports.

Enumerates every subset of the bounded available frontier. Dependencies must be
fulfilled, correlated representations can fulfill a goal only once, completed
work is sunk, and unknown forward cost/duration prevents a numeric net bound.
Inputs and output are retained by the owning-boundary E2E driver.
"""
import itertools
import json
import sys
from decimal import Decimal


def reference(data):
    units = data["units"]
    assert len(units) <= 8
    ids = {u["id"] for u in units}
    assert len(ids) == len(units)
    assert all(set(u["prerequisites"]) <= ids for u in units)
    completed = {u["id"] for u in units if u["status"] == "COMPLETED"}
    eligible = [u for u in units if u["status"] in ("PENDING", "QUEUED", "RUNNING")]
    chains = []
    for count in range(len(eligible) + 1):
        for subset in itertools.combinations(eligible, count):
            selected = {u["id"] for u in subset}
            if any(not set(u["prerequisites"]) <= selected | completed for u in subset):
                continue
            if count > data["remainingAttempts"]:
                continue
            gain = Decimal(0) if data["incumbentQualified"] else (
                Decimal(str(data["lossGap"])) if any(u["kind"] == "VERIFY_P1" for u in subset) else Decimal(0))
            def depth(unit, seen=()):
                assert unit["id"] not in seen
                dependencies = [v for v in subset if v["id"] in unit["prerequisites"]]
                return 1 + max((depth(v, seen + (unit["id"],)) for v in dependencies), default=0)
            control_calls = max((depth(u) for u in subset), default=0)
            cost = None if any(u["cost"] is None for u in subset) else sum((Decimal(str(u["cost"])) for u in subset), Decimal(0)) + control_calls * Decimal(str(data.get("controllerCallCost", 0)))
            duration = None if any(u["durationMs"] is None for u in subset) else sum((Decimal(str(u["durationMs"])) for u in subset), Decimal(0))
            if duration is not None and duration > Decimal(str(data["remainingMs"])):
                continue
            delay = None if duration is None or data["delayPerMs"] is None else duration * Decimal(str(data["delayPerMs"]))
            net = None if cost is None or delay is None else gain - cost - delay
            chains.append({"ids": sorted(selected), "conditionalGain": str(gain), "cost": None if cost is None else str(cost), "delay": None if delay is None else str(delay), "net": None if net is None else str(net)})
    known = [c for c in chains if c["net"] is not None]
    best = max((Decimal(c["net"]) for c in known), default=Decimal(0))
    return {"schema": "finnor.m2.independent-finite-reference.v1", "chains": chains, "bestNet": str(best), "optimizers": [c["ids"] for c in known if Decimal(c["net"]) == best], "unknownChains": sum(c["net"] is None for c in chains), "scope": "SUPPLIED_FINITE_CONDITIONAL_ACCEPTED_OUTPUT_MODEL_NOT_FIELD_PROBABILITY"}


if __name__ == "__main__":
    print(json.dumps(reference(json.load(sys.stdin))))
