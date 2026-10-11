"""Checker-owned S4/S5 reconstruction. No producer or owner helper imports."""
import copy
import math
from datetime import datetime, timezone
from fractions import Fraction


def canonical_constraints(p, supplied_options, columns, payments, world_ids, q, need, digest):
    c = p.get("canonicalAllocation")
    if c is None:
        return [], []
    m, resources, outstanding = c["mandate"], c["resources"], c["outstanding"]
    control, periods = p.get("controlDemand"), len(p["dates"]) - 1
    need(control is not None and c["schema"] == "finnor.r5.canonical-allocation-basis.v1",
         "canonical", "original-control-meaning", control, "explicit original owner basis")
    need(c["snapshotDigest"] == digest(dict(resources=resources, outstanding=outstanding)) and
         m["ref"] == p["objective"]["mandateRef"] and m["horizon"]["periods"] == periods and
         {r["resourceId"] for r in resources} == {r["id"] for r in p["resources"]},
         "canonical", "owner-preimages", c["snapshotDigest"], "complete original owner basis")
    need(all(next(r for r in p["resources"] if r["id"] == resource["resourceId"])["sourceRef"] == resource["ref"]
             for resource in resources), "canonical", "resource-preimages", resources, "original source refs")
    need(m["utility"]["tail"]["terminalLiability"] == 0 and not any(
        item["kind"] == "LIABILITY" for op in p["grammar"]["operators"] for item in op["equations"] + op["costs"]),
         "canonical", "terminal-liability-unbound", m["utility"]["tail"], "original settlement/funding meaning")

    def number(value):
        need(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value),
             "canonical", "authored-owner-number", value, "finite S4 decimal")
        return Fraction(str(value))

    def instant(value):
        delta = datetime.fromisoformat(value.replace("Z", "+00:00")) - datetime(1970, 1, 1, tzinfo=timezone.utc)
        return delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000

    def usage(resource, values, date):
        return sum(values[:date+1], Fraction(0)) if resource["kind"] in {"STOCK", "CUMULATIVE_EXPENDITURE"} else values[date]

    baseline = {r["resourceId"]: list(map(q, r["existingUse"])) for r in resources}
    lower = copy.deepcopy(baseline)
    for resource in resources:
        need(not resource["revoked"] and instant(resource["knowledgeAt"]) <= instant(c["knowledgeAt"]) < instant(resource["validUntil"]) and
             len(resource["availability"]) == len(resource["existingUse"]) == periods + 1 and
             all(a["amount"] is not None and a["basis"] == "REPORTED_AVAILABLE" for a in resource["availability"]),
             "canonical", "resource-basis/" + resource["resourceId"], resource, "known current complete availability")
    for commitment in outstanding:
        need(commitment["status"] != "RESERVED" or not commitment["effectRefs"],
             "canonical", "retained-stage", commitment["status"], "no effect in untouched reservation")
        for envelope in commitment["envelopes"]:
            resource = next((r for r in resources if r["resourceId"] == envelope["resourceId"]), None)
            need(resource and resource["unit"] == envelope["unit"] and resource["kind"] == envelope["kind"] and
                 resource["horizon"] == envelope["horizon"] and
                 len(envelope["quantities"]) == len(envelope["minimumQuantities"]) == periods + 1,
                 "canonical", "retained-envelope", envelope, "complete original semantics")
            maximum, minimum = list(map(q, envelope["quantities"])), list(map(q, envelope["minimumQuantities"]))
            for date in range(periods + 1):
                need(usage(resource, minimum, date) <= usage(resource, maximum, date),
                     "canonical", "retained-lower-envelope", envelope, "lower <= upper")
                baseline[resource["resourceId"]][date] += maximum[date]
                lower[resource["resourceId"]][date] += minimum[date]
    funding = {}
    for party in p["parties"]:
        resource = next((r for r in resources if r["ref"] == party["fundingRef"]), None)
        need(resource and resource["resourceClass"] == "CASH" and resource["unit"] == p["unit"] and
             resource["currency"] == p["currency"], "canonical", "party-cash/" + party["id"],
             party["fundingRef"], "named compatible cash")
        funding[party["id"]] = resource["resourceId"]
    covenants = dict((covenant["id"], covenant) for resource in resources for covenant in resource["covenants"])
    exact = {term["resourceId"] for covenant in covenants.values() for term in covenant["terms"] if q(term["coefficient"]) < 0}
    variables, rows, outgoing = [], [], {}

    def row(sense, rhs, terms):
        sums = {}
        for name, value in terms:
            sums[name] = sums.get(name, Fraction(0)) + (value if isinstance(value, Fraction) else q(value))
        rows.append((sense, rhs if isinstance(rhs, Fraction) else q(rhs), {name: value for name, value in sums.items() if value}))

    def options(coefficient):
        return [(col["variableId"], coefficient(option)) for col, option in zip(columns, supplied_options)]

    for payment in payments:
        lo, hi = map(q, p["transfers"][payment["rule"]]["bounds"][payment["partyId"]])
        name, transfer = "out_" + payment["variableId"], payment["variableId"]
        outgoing[transfer] = name
        variables.append(dict(id=name, kind="CONTINUOUS", lower="0", upper=str(-min(lo, Fraction(0)))))
        if lo >= 0:
            continue
        if hi <= 0:
            row("E", "0", [(name, "1"), (transfer, "1")])
            continue
        row("G", "0", [(name, "1"), (transfer, "1")])
        if funding[payment["partyId"]] not in exact:
            continue
        sign = "sign_" + transfer
        variables.append(dict(id=sign, kind="BINARY", lower="0", upper="1"))
        row("G", "0", [(transfer, "1"), (sign, -lo)])
        row("L", hi, [(transfer, "1"), (sign, hi)])
        row("L", "0", [(name, "1"), (sign, lo)])
        row("L", hi, [(name, "1"), (transfer, "1"), (sign, hi)])

    def used(world, resource, date):
        dates = list(range(date+1)) if resource["kind"] in {"STOCK", "CUMULATIVE_EXPENDITURE"} else [date]
        def quantity(option):
            result = sum((q(option["resourceUse"][resource["resourceId"]][t]) for t in dates), Fraction(0))
            for party in p["parties"]:
                if funding[party["id"]] == resource["resourceId"]:
                    result += sum((q(option["cashOutflows"][world["id"]][party["id"]][t]) for t in dates), Fraction(0))
            return result
        terms = options(quantity)
        for payment in payments:
            rule = p["transfers"][payment["rule"]]
            if funding[payment["partyId"]] == resource["resourceId"] and rule["date"] in dates and world["eventTokens"][rule["eventId"]] == rule["token"]:
                terms.append((outgoing[payment["variableId"]], "1"))
        return terms

    need(len(control["dimensions"]) == len(m["resources"]["dimensions"]), "canonical", "complete-dimensions",
         control["dimensions"], "every authorized dimension")
    for wid in world_ids:
        world = next(world for world in p["worlds"] if world["id"] == wid)
        for resource in resources:
            for date in range(periods + 1):
                free = q(resource["availability"][date]["amount"]) - q(resource["safetyMargin"]) - usage(resource, baseline[resource["resourceId"]], date)
                row("L", free, used(world, resource, date))
        for covenant in covenants.values():
            for date in covenant["periods"]:
                need(date <= periods, "canonical", "covenant-date", date, periods)
                limit, terms = q(covenant["maximum"]) - q(covenant["safetyMargin"]), []
                for term in covenant["terms"]:
                    resource = next(r for r in resources if r["resourceId"] == term["resourceId"])
                    coefficient = q(term["coefficient"])
                    fixed = lower if coefficient < 0 else baseline
                    limit -= coefficient * usage(resource, fixed[resource["resourceId"]], date)
                    terms += [(name, coefficient * (value if isinstance(value, Fraction) else q(value))) for name, value in used(world, resource, date)]
                row("L", limit, terms)
        occupied = {}
        for dimension in m["resources"]["dimensions"]:
            binding = next(b for b in control["dimensions"] if b["dimensionId"] == dimension["id"])
            need(binding["totalResourceId"] is not None and
                 next(r for r in resources if r["resourceId"] == binding["totalResourceId"])["unit"] == dimension["unit"] and
                 (binding["occupancyResourceId"] is None or
                  next(r for r in resources if r["resourceId"] == binding["occupancyResourceId"])["unit"] == dimension["unit"]),
                 "canonical", "dimension-units", binding, "original compatible units")
            row("L", number(dimension["totalLimit"]), options(lambda option: sum(map(q, option["resourceUse"][binding["totalResourceId"]]), Fraction(0))))
            occupied[dimension["id"]] = [options(lambda option, t=date: "0" if binding["occupancyResourceId"] is None else option["resourceUse"][binding["occupancyResourceId"]][t]) for date in range(periods+1)]
            for date in range(periods + 1):
                row("L", number(dimension["capacity"]), occupied[dimension["id"]][date])
        for coupling in m["resources"]["couplings"]:
            for date in range(periods + 1):
                row("L", number(coupling["maxPerPeriod"]), [(name, number(weight) * q(value)) for dimension, weight in coupling["weights"].items() for name, value in occupied[dimension][date]])
        row("L", number(m["search"]["maxHumanSeconds"]), options(lambda option: sum((q(control["humanSecondsByOperator"][step["operatorId"]]) for step in option["steps"]), Fraction(0))))
        utility = options(lambda option: sum((q(party["ownerObjectiveWeight"]) * q(option["grossPayoffs"][wid][party["id"]]) for party in p["parties"]), Fraction(0)))
        for payment in payments:
            rule = p["transfers"][payment["rule"]]
            if world["eventTokens"][rule["eventId"]] == rule["token"]:
                party = next(party for party in p["parties"] if party["id"] == payment["partyId"])
                utility.append((payment["variableId"], q(party["ownerObjectiveWeight"]) * q(p["discountFactors"][rule["date"]])))
        row("G", number(m["risk"]["minimumUtility"]), utility)
    return variables, rows
