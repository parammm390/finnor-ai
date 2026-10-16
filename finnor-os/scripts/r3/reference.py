"""Independent COMPLETE small integer-grid synthesis reference.

No producer/repair/checker imports. This explicit subprofile does not prove
optimization over arbitrary bounded-rational payments or 3**81 tables.
"""
import itertools
from fractions import Fraction


def enumerate_small(p):
    parties = p["parties"]
    if len(parties) != 2 or any(len(a["types"]) != 2 for a in parties) or len(p["outcomes"]) != 2 or len(p["dates"]) != 1:
        raise ValueError("REFERENCE_REGISTERED_TWO_BY_TWO_ONLY")
    parse = lambda v: Fraction(int(v["numerator"]), int(v["denominator"]))
    grid = list(map(parse, p["referenceGrid"]))
    profiles = list(itertools.product(*(tuple(t["id"] for t in a["types"]) for a in parties)))
    choices = list(itertools.product(range(2), grid, grid))
    examined, feasible, best, best_table = 0, 0, None, None
    for table in itertools.product(choices, repeat=4):
        examined += 1
        mapping = dict(zip(profiles, table))
        accepted = True
        values = []
        for reports, row in mapping.items():
            outcome = p["outcomes"][row[0]]
            money = row[1:]
            if any(not parse(a["payments"][0]["minimum"]) <= cash <= parse(a["payments"][0]["maximum"]) for a, cash in zip(parties, money)):
                accepted = False
                break
            for i, party in enumerate(parties):
                true = next(t for t in party["types"] if t["id"] == reports[i])
                utility = parse(true["values"][outcome["id"]]) + money[i]
                outside = next(o for o in true["outsideOptions"] if o["otherReports"] == [reports[1 - i]])
                if utility < parse(outside["utility"]):
                    accepted = False
                changed = list(reports)
                changed[i] = next(t["id"] for t in party["types"] if t["id"] != reports[i])
                alternative = mapping[tuple(changed)]
                lie = parse(true["values"][p["outcomes"][alternative[0]]["id"]]) + alternative[i + 1]
                if lie > utility:
                    accepted = False
            if not parse(p["constraints"]["netTransferMinimum"]) <= sum(money) <= parse(p["constraints"]["netTransferMaximum"]):
                accepted = False
            positive = sum(max(v, 0) for v in money)
            if positive > min(parse(p["dates"][0]["grossOutflowCap"]), parse(p["dates"][0]["escrowCap"])) or positive > parse(p["constraints"]["ownerLiabilityCap"]):
                accepted = False
            for r in p["resources"]:
                for period in range(r["horizon"]["periods"] + 1):
                    demand = list(map(parse, outcome["demands"][r["resourceId"]]))
                    if r["resourceId"] == p["constraints"]["cashResourceId"]:
                        demand[0] += positive
                    baseline = list(map(parse, r["baseline"]))
                    used = sum(v + b for v, b in zip(demand[:period + 1], baseline[:period + 1]))
                    if used > parse(r["availability"][period]) - parse(r["safetyMargin"]):
                        accepted = False
            key = __import__("json").dumps(list(reports), separators=(",", ":"))
            values.append(parse(p["objective"]["valueByProfile"][key][outcome["id"]]) - sum(money))
        if accepted:
            feasible += 1
            value = min(values)
            if best is None or value > best:
                best, best_table = value, table
    return {"examined": examined, "feasible": feasible, "optimum": {"numerator": str(best.numerator), "denominator": str(best.denominator)} if best is not None else None,
            "basis": "COMPLETE_REGISTERED_4096_ALLOCATION_AND_PAYMENT_GRID_RULES", "bestTable": [[r[0], str(r[1]), str(r[2])] for r in best_table] if best_table else None}
