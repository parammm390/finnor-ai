"""Independent original-input Fraction checker. No producer/solver imports.

Predicate: scope-r/r3-incentive-rule-synthesis/failure-model.md, revision 1.
This process establishes model-relative math, not current rights or authority.
"""
import hashlib
import itertools
import json
import math
import pathlib
import re
import resource
import sys
from fractions import Fraction

MAX_BYTES = 8 * 1024 * 1024
VERSION = "INDEPENDENT_FRACTION_V1"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def quantity(value):
    if not isinstance(value, dict) or set(value) != {"numerator", "denominator"}:
        raise ValueError("EXACT_QUANTITY_REQUIRED")
    n, d = value["numerator"], value["denominator"]
    if not isinstance(n, str) or not isinstance(d, str) or len(n) > 128 or len(d) > 128:
        raise ValueError("RATIONAL_DIGIT_BOUND")
    if not re.fullmatch(r"0|-?[1-9]\d*", n) or not re.fullmatch(r"[1-9]\d*", d):
        raise ValueError("CANONICAL_INTEGER_REQUIRED")
    q = Fraction(int(n), int(d))
    if str(q.numerator) != n or str(q.denominator) != d:
        raise ValueError("REDUCED_RATIONAL_REQUIRED")
    return q


def encoded(q):
    if len(str(q.numerator))>128 or len(str(q.denominator))>128:
        raise ValueError("EXACT_RESULT_RATIONAL_DIGIT_BOUND")
    return {"numerator": str(q.numerator), "denominator": str(q.denominator)}


def exact_ledger(q):
    encoded(q)
    return "r3q:%s/%s" % (q.numerator, q.denominator)


def use(kind, values, period):
    return sum(values[:period + 1], Fraction()) if kind in ("STOCK", "CUMULATIVE_EXPENDITURE") else values[period]


def unique(items, name):
    if len(items) != len(set(items)):
        raise ValueError("DUPLICATE_" + name)


def validate_original(p):
    if p.get("schema") != "finnor.r3.problem.v1" or not 1 <= len(p["parties"]) <= 4 or not 1 <= len(p["outcomes"]) <= 3:
        raise ValueError("UNSUPPORTED_FINITE_DOMAIN")
    if p["model"] != {"utility": "SUPPLIED_QUASILINEAR", "participation": "EX_POST_ALL_OTHER_REPORTS",
                       "events": "UNCONDITIONAL_DUE_TIME", "guarantee": "INDIVIDUAL_WEAK_DSIC"}:
        raise ValueError("UNSUPPORTED_PREFERENCE_EVENT_OR_STRATEGIC_CLAIM")
    if p["constraints"]["incomingPromisesMayFund"] is not False:
        raise ValueError("PROMISED_INCOMING_FUNDING_UNSUPPORTED")
    if quantity(p["constraints"]["netTransferMinimum"])>quantity(p["constraints"]["netTransferMaximum"]) or quantity(p["constraints"]["ownerLiabilityCap"])<0:
        raise ValueError("OWNER_NET_TRANSFER_OR_LIABILITY_BOUNDS_REQUIRED")
    money = p["money"]
    if money["currency"] != money["unit"] or money["ownerId"] != p["binding"]["principalId"]:
        raise ValueError("EXPLICIT_OWNER_CURRENCY_UNIT_REQUIRED")
    if not money["timeConvention"] or not money["discountConvention"] or not p["assumptions"]:
        raise ValueError("DECLARED_TIME_DISCOUNT_ASSUMPTIONS_REQUIRED")
    dates, parties, outcomes = p["dates"], p["parties"], p["outcomes"]
    if not 1 <= len(dates) <= 8 or not 1 <= len(p["resources"]) <= 16:
        raise ValueError("DATE_RESOURCE_BOUND")
    unique([d["id"] for d in dates], "DATE")
    unique([a["id"] for a in parties], "PARTY")
    unique([o["id"] for o in outcomes], "OUTCOME")
    unique([r["resourceId"] for r in p["resources"]], "RESOURCE")
    for d in dates:
        if d["trigger"] != "DUE_TIME" or d["observableBy"] != "OWNER_CLOCK" or d["defaultCondition"] != "RETAIN_OUTSTANDING_LIABILITY":
            raise ValueError("UNOBSERVABLE_OR_EVENT_DEPENDENT_PAYMENT")
        if d["contractRef"] != p["binding"]["paymentContractRef"]:
            raise ValueError("PAYMENT_CONTRACT_REVISION_MISMATCH")
        if quantity(d["grossOutflowCap"]) < 0 or quantity(d["escrowCap"]) < 0:
            raise ValueError("NEGATIVE_FUNDING")
    for a in parties:
        if not a["sourceRef"] or not a["rightsRef"] or not a["assumptionRef"] or not a["reportingPrincipalId"]:
            raise ValueError("PREFERENCE_RIGHTS_REPORTER_PROVENANCE_REQUIRED")
        if not 1 <= len(a["types"]) <= 3:
            raise ValueError("TYPE_DOMAIN_BOUND")
        unique([t["id"] for t in a["types"]], "TYPE")
        if len(a["payments"]) != len(dates) or {b["dateId"] for b in a["payments"]} != {d["id"] for d in dates}:
            raise ValueError("COMPLETE_PAYMENT_BOUNDS_REQUIRED")
        for b in a["payments"]:
            if quantity(b["minimum"]) > quantity(b["maximum"]):
                raise ValueError("PAYMENT_BOUNDS_REVERSED")
        if quantity(a["liabilityCap"]) < 0:
            raise ValueError("NEGATIVE_PARTY_LIABILITY_CAP")
    reports = list(itertools.product(*[[t["id"] for t in a["types"]] for a in parties]))
    for i, a in enumerate(parties):
        other = {tuple(r[:i] + r[i + 1:]) for r in reports}
        for t in a["types"]:
            if set(t["values"]) != {o["id"] for o in outcomes} or set(t["dateMultipliers"]) != {d["id"] for d in dates}:
                raise ValueError("COMPLETE_VALUATION_DATE_MODEL_REQUIRED")
            for q in list(t["values"].values()) + list(t["dateMultipliers"].values()):
                quantity(q)
            keys = [tuple(o["otherReports"]) for o in t["outsideOptions"]]
            if len(keys) != len(other) or set(keys) != other:
                raise ValueError("COMPLETE_ORIGINAL_OUTSIDE_OPTIONS_REQUIRED")
            for o in t["outsideOptions"]:
                quantity(o["utility"])
    periods = p["resources"][0]["horizon"]["periods"]
    if not 1 <= periods <= 24:
        raise ValueError("HORIZON_BOUND")
    for r in p["resources"]:
        if r["horizon"] != p["resources"][0]["horizon"] or any(len(r[k]) != periods + 1 for k in ("availability", "baseline", "minimumBaseline")):
            raise ValueError("COMPLETE_RESOURCE_HORIZON_REQUIRED")
        for q in r["availability"] + r["baseline"] + r["minimumBaseline"] + [r["safetyMargin"]]:
            if quantity(q) < 0:
                raise ValueError("NEGATIVE_OR_UNKNOWN_RESOURCE")
        if any(quantity(a) > quantity(b) for a, b in zip(r["minimumBaseline"], r["baseline"])):
            # Raw increments of a prefix envelope may be negative; original
            # baselines here are cumulative-independent conservative schedules.
            if r["kind"] not in ("STOCK", "CUMULATIVE_EXPENDITURE"):
                raise ValueError("LOWER_BASELINE_EXCEEDS_UPPER")
    if p["constraints"]["cashResourceId"] not in {r["resourceId"] for r in p["resources"]}:
        raise ValueError("OWNER_CASH_RESOURCE_REQUIRED")
    cash = next(r for r in p["resources"] if r["resourceId"] == p["constraints"]["cashResourceId"])
    if cash["unit"] != money["currency"] or cash["kind"] not in ("STOCK", "FLOW", "CUMULATIVE_EXPENDITURE"):
        raise ValueError("CASH_RESOURCE_SEMANTICS_MISMATCH")
    for d in dates:
        if not 0 <= d["period"] <= periods:
            raise ValueError("PAYMENT_PERIOD_OUTSIDE_HORIZON")
        from datetime import datetime, timezone, timedelta
        start = datetime.fromisoformat(cash["horizon"]["startAt"].replace("Z", "+00:00"))
        at = datetime.fromisoformat(d["at"].replace("Z", "+00:00"))
        if at != start + timedelta(milliseconds=cash["horizon"]["periodMs"] * d["period"]):
            raise ValueError("EXACT_DATED_PAYMENT_GRID_REQUIRED")
    if len(money["ownerPeriodMultipliers"])!=periods+1 or any(quantity(v)<0 for v in money["ownerPeriodMultipliers"]):
        raise ValueError("COMPLETE_OWNER_COST_LIABILITY_TIME_MULTIPLIERS_REQUIRED")
    if any(quantity(money["ownerDateMultipliers"][d["id"]])!=quantity(money["ownerPeriodMultipliers"][d["period"]]) for d in dates):
        raise ValueError("OWNER_PAYMENT_COST_LIABILITY_DISCOUNT_MEANING_MISMATCH")
    for o in outcomes:
        if set(o["demands"]) != {r["resourceId"] for r in p["resources"]}:
            raise ValueError("COMPLETE_OUTCOME_RESOURCE_DEMAND_REQUIRED")
        for schedule in list(o["demands"].values()) + [o["costs"], o["liabilities"]]:
            if len(schedule) != periods + 1 or any(quantity(q) < 0 for q in schedule):
                raise ValueError("COMPLETE_NONNEGATIVE_OUTCOME_SCHEDULE_REQUIRED")
        if o["eligibility"] != "ALL_REPORTS":
            if not isinstance(o["eligibility"], list) or any(tuple(r) not in reports for r in o["eligibility"]):
                raise ValueError("OUTCOME_ELIGIBILITY_OUTSIDE_REPORT_DOMAIN")
    for c in p["covenants"]:
        if not c["terms"] or any(t["resourceId"] not in {r["resourceId"] for r in p["resources"]} for t in c["terms"]):
            raise ValueError("COVENANT_RESOURCE_IDENTITY_REQUIRED")
        for q in [c["maximum"], c["safetyMargin"]] + [t["coefficient"] for t in c["terms"]]:
            quantity(q)
        if any(not 0 <= t <= periods for t in c["periods"]):
            raise ValueError("COVENANT_PERIOD_OUTSIDE_HORIZON")
    for d in p["mandateLimits"]["dimensions"]:
        if d["resourceId"] not in {r["resourceId"] for r in p["resources"]} or d["unit"] != next(r["unit"] for r in p["resources"] if r["resourceId"] == d["resourceId"]):
            raise ValueError("ORIGINAL_MANDATE_RESOURCE_IDENTITY_REQUIRED")
        if quantity(d["totalLimit"]) < 0 or quantity(d["capacity"]) < 0:
            raise ValueError("NEGATIVE_MANDATE_RESOURCE_BOUND")
    for c in p["mandateLimits"]["couplings"]:
        if not c["weights"] or any(k not in {r["resourceId"] for r in p["resources"]} for k in c["weights"]):
            raise ValueError("MANDATE_COUPLING_IDENTITY_REQUIRED")
        for value in c["weights"].values():
            quantity(value)
        quantity(c["maximum"])
    objective = p["objective"]
    keys = {json.dumps(list(r), separators=(",", ":"), ensure_ascii=False) for r in reports}
    if set(objective["valueByProfile"]) != keys:
        raise ValueError("COMPLETE_ORIGINAL_OBJECTIVE_REQUIRED")
    for row in objective["valueByProfile"].values():
        if set(row) != {o["id"] for o in outcomes}:
            raise ValueError("COMPLETE_OWNER_OUTCOME_VALUE_REQUIRED")
        for q in row.values():
            quantity(q)
    if objective["kind"] == "MAXIMIN":
        if objective["weights"] is not None or objective["distributionRef"] is not None:
            raise ValueError("MAXIMIN_HAS_NO_TYPE_DISTRIBUTION")
    elif objective["kind"] == "EXPECTED_QUALIFIED_JOINT":
        weights = objective["weights"]
        if not objective["distributionRef"] or not isinstance(weights, list) or len(weights) != len(reports) or any(quantity(w) < 0 for w in weights) or sum(map(quantity, weights)) != 1:
            raise ValueError("QUALIFIED_EXACT_JOINT_DISTRIBUTION_REQUIRED")
    else:
        raise ValueError("UNSUPPORTED_OWNER_OBJECTIVE")
    if set(money["ownerDateMultipliers"]) != {d["id"] for d in dates}:
        raise ValueError("OWNER_DISCOUNT_DATE_COVERAGE_REQUIRED")
    for q in money["ownerDateMultipliers"].values():
        if quantity(q) < 0:
            raise ValueError("NEGATIVE_OWNER_DATE_MULTIPLIER")
    if quantity(objective["normalization"]) <= 0 or quantity(objective["range"][0]) >= quantity(objective["range"][1]):
        raise ValueError("FIXED_OBJECTIVE_RANGE_REQUIRED")
    quantity(objective["minimumValue"])
    return reports


def check(p, rule):
    result = {"schema": "finnor.r3.check.v1", "accepted": False, "inputDigest": digest(p),
              "ruleDigest": digest(rule) if rule is not None else None,
              "checker": {"sourceDigest": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
                          "pythonVersion": sys.version.split()[0], "implementation": VERSION},
              "basis": "UNKNOWN", "counts": {"profiles": 0, "deviations": 0, "participation": 0},
              "failures": [], "objective": None, "upper": None, "optimizationGap": None,
              "optimum": "UNKNOWN", "minimumIncentiveMargin": None, "minimumParticipationMargin": None,
              "maximumDeviationGain": None, "envelopes": [], "assumptions": p.get("assumptions", []),
              "consentEstablished": False, "executionAuthorityGranted": False, "behavioralTruthEstablished": False}
    def fail(code, **witness):
        # Bound retained witnesses, not enumerated checks. Counts and total
        # failure count disclose the distinction, never truncate the domain.
        result["failureCount"] = result.get("failureCount", 0) + 1
        if len(result["failures"]) < 1024:
            result["failures"].append({"constraint": code, **witness})
    try:
        profiles = validate_original(p)
        parties, dates = p["parties"], p["dates"]
        if not isinstance(rule, dict) or set(rule) != {"schema", "inputDigest", "binding", "table", "search"}:
            raise ValueError("RULE_SCHEMA_OR_HIDDEN_PREDICATE")
        if rule["schema"] != "finnor.r3.rule.v1" or rule["inputDigest"] != digest(p) or rule["binding"] != p["binding"]:
            raise ValueError("ORIGINAL_INPUT_OWNER_METHOD_BINDING_MISMATCH")
        if p["binding"]["checkerDigest"] != result["checker"]["sourceDigest"]:
            raise ValueError("CHECKER_VERSION_CUSTODY_MISMATCH")
        if len(rule["table"]) != len(profiles):
            raise ValueError("PROFILE_COUNT_MISMATCH")
        rows = {}
        for row in rule["table"]:
            if set(row) != {"reports", "outcomeId", "schedule"}:
                raise ValueError("DETERMINISTIC_RULE_ONLY_NO_HIDDEN_PREDICATES")
            key = tuple(row["reports"])
            if key not in profiles or key in rows:
                raise ValueError("DUPLICATE_OR_FOREIGN_PROFILE")
            if row["outcomeId"] not in {o["id"] for o in p["outcomes"]}:
                raise ValueError("ONE_PERMITTED_DETERMINISTIC_OUTCOME_REQUIRED")
            expected = {(a["id"], d["id"]) for a in parties for d in dates}
            actual = [(s["partyId"], s["dateId"]) for s in row["schedule"]]
            if len(actual) != len(expected) or set(actual) != expected:
                raise ValueError("COMPLETE_PARTY_DATE_SCHEDULE_REQUIRED")
            for s in row["schedule"]:
                if set(s) != {"partyId", "dateId", "amount", "eventId", "currency", "unit", "dueAt"}:
                    raise ValueError("PAYMENT_SCHEMA_OR_HIDDEN_EVENT")
                d = next(d for d in dates if d["id"] == s["dateId"])
                if s["eventId"] != "due:" + d["id"] or s["dueAt"] != d["at"] or s["currency"] != p["money"]["currency"] or s["unit"] != p["money"]["unit"]:
                    raise ValueError("PAYMENT_EVENT_UNIT_CURRENCY_TIME_MISMATCH")
                amount = quantity(s["amount"])
                if p.get("referenceGrid") is not None and amount not in list(map(quantity, p["referenceGrid"])):
                    raise ValueError("REGISTERED_REFERENCE_GRID_VIOLATION")
            rows[key] = row
        if set(rows) != set(profiles):
            raise ValueError("COMPLETE_CARTESIAN_REPORT_DOMAIN_REQUIRED")
        def cash(row, party, date):
            return quantity(next(s["amount"] for s in row["schedule"] if s["partyId"] == party and s["dateId"] == date))
        def utility(row, party, true_type):
            return quantity(true_type["values"][row["outcomeId"]]) + sum(
                (cash(row, party["id"], d["id"]) * quantity(true_type["dateMultipliers"][d["id"]]) for d in dates), Fraction())
        incentive_margins, participation_margins, gains, values, demand_paths = [], [], [], [], []
        resources = {r["resourceId"]: r for r in p["resources"]}
        h = next(iter(resources.values()))["horizon"]["periods"]
        for report in profiles:
            row = rows[report]
            result["counts"]["profiles"] += 1
            outcome = next(o for o in p["outcomes"] if o["id"] == row["outcomeId"])
            if outcome["eligibility"] != "ALL_REPORTS" and list(report) not in outcome["eligibility"]:
                fail("OUTCOME_ELIGIBILITY", reports=list(report), outcomeId=outcome["id"])
            raw = {k: list(map(quantity, outcome["demands"][k])) for k in resources}
            costs, liabilities = list(map(quantity, outcome["costs"])), list(map(quantity, outcome["liabilities"]))
            cash_id = p["constraints"]["cashResourceId"]
            for t in range(h + 1):
                raw[cash_id][t] += costs[t] + liabilities[t]
            owner_liability = sum(liabilities)
            net = Fraction()
            for a in parties:
                positive = Fraction()
                for d in dates:
                    amount = cash(row, a["id"], d["id"])
                    bounds = next(b for b in a["payments"] if b["dateId"] == d["id"])
                    if not quantity(bounds["minimum"]) <= amount <= quantity(bounds["maximum"]):
                        fail("PARTY_PAYMENT_BOUND", reports=list(report), partyId=a["id"], dateId=d["id"], amount=encoded(amount))
                    positive += max(amount, 0)
                    raw[cash_id][d["period"]] += max(amount, 0)
                    net += amount
                owner_liability += positive
                if positive > quantity(a["liabilityCap"]):
                    fail("PARTY_LIABILITY_CAP", reports=list(report), partyId=a["id"], liability=encoded(positive))
            if owner_liability > quantity(p["constraints"]["ownerLiabilityCap"]):
                fail("OWNER_OUTSTANDING_LIABILITY_CAP", reports=list(report), liability=encoded(owner_liability))
            if not quantity(p["constraints"]["netTransferMinimum"]) <= net <= quantity(p["constraints"]["netTransferMaximum"]):
                fail("NET_TRANSFER_SUBSIDY_OR_BALANCE", reports=list(report), netTransfer=encoded(net))
            for d in dates:
                gross = sum(max(cash(row, a["id"], d["id"]), 0) for a in parties) + costs[d["period"]] + liabilities[d["period"]]
                if gross > quantity(d["grossOutflowCap"]) or gross > quantity(d["escrowCap"]):
                    fail("DATED_GROSS_FUNDING_ESCROW", reports=list(report), dateId=d["id"], grossOutflow=encoded(gross),
                         incomingPromisesCounted=False, eventRef=d["contractRef"])
            for r in resources.values():
                for t in range(h + 1):
                    used = use(r["kind"], [quantity(v) + q for v, q in zip(r["baseline"], raw[r["resourceId"]])], t)
                    maximum = quantity(r["availability"][t]) - quantity(r["safetyMargin"])
                    if used > maximum:
                        fail("HARD_RESOURCE", reports=list(report), resourceId=r["resourceId"], period=t,
                             used=encoded(used), maximum=encoded(maximum), margin=encoded(maximum - used), sourceRef=r["ref"])
            for c in p["covenants"]:
                for t in c["periods"]:
                    used = Fraction()
                    for term in c["terms"]:
                        r = resources[term["resourceId"]]
                        coefficient = quantity(term["coefficient"])
                        baseline = r["minimumBaseline"] if coefficient < 0 else r["baseline"]
                        used += coefficient * use(r["kind"], [quantity(v) + q for v, q in zip(baseline, raw[r["resourceId"]])], t)
                    maximum = quantity(c["maximum"]) - quantity(c["safetyMargin"])
                    if used > maximum:
                        fail("HARD_COVENANT", reports=list(report), covenantId=c["id"], period=t,
                             used=encoded(used), maximum=encoded(maximum), sourceRef=c["sourceRef"])
            for d in p["mandateLimits"]["dimensions"]:
                values_raw = raw[d["resourceId"]]
                if sum(values_raw) > quantity(d["totalLimit"]) or any(v > quantity(d["capacity"]) for v in values_raw):
                    fail("ORIGINAL_S4_MANDATE_ENVELOPE", reports=list(report), resourceId=d["resourceId"])
            for c in p["mandateLimits"]["couplings"]:
                for t in range(h + 1):
                    if sum(quantity(weight) * raw[k][t] for k, weight in c["weights"].items()) > quantity(c["maximum"]):
                        fail("ORIGINAL_S4_MANDATE_COUPLING", reports=list(report), couplingId=c["id"], period=t)
            demand_paths.append(raw)
            value_key = json.dumps(list(report), separators=(",", ":"), ensure_ascii=False)
            value = quantity(p["objective"]["valueByProfile"][value_key][outcome["id"]])
            value -= sum((costs[t]+liabilities[t])*quantity(p["money"]["ownerPeriodMultipliers"][t]) for t in range(h+1))
            value -= sum(cash(row, a["id"], d["id"]) * quantity(p["money"]["ownerDateMultipliers"][d["id"]]) for a in parties for d in dates)
            values.append(value)
            if value < quantity(p["objective"]["minimumValue"]):
                fail("ORIGINAL_OWNER_VALUE_FLOOR", reports=list(report), value=encoded(value), floor=p["objective"]["minimumValue"])
            for i, a in enumerate(parties):
                true_type = next(t for t in a["types"] if t["id"] == report[i])
                others = report[:i] + report[i + 1:]
                truthful = utility(row, a, true_type)
                outside = quantity(next(o["utility"] for o in true_type["outsideOptions"] if tuple(o["otherReports"]) == others))
                margin = truthful - outside
                participation_margins.append(margin)
                result["counts"]["participation"] += 1
                if margin < 0:
                    fail("EX_POST_PARTICIPATION", partyId=a["id"], trueType=true_type["id"], otherReports=list(others),
                         truthfulUtility=encoded(truthful), outsideOption=encoded(outside), margin=encoded(margin), inputRef=a["sourceRef"])
                for alternative in a["types"]:
                    if alternative["id"] == true_type["id"]:
                        continue
                    changed = list(report)
                    changed[i] = alternative["id"]
                    deviating = utility(rows[tuple(changed)], a, true_type)
                    margin, gain = truthful - deviating, deviating - truthful
                    incentive_margins.append(margin)
                    gains.append(gain)
                    result["counts"]["deviations"] += 1
                    if margin < 0:
                        fail("UNILATERAL_DEVIATION", partyId=a["id"], trueType=true_type["id"], alternativeReport=alternative["id"],
                             otherReports=list(others), truthfulUtility=encoded(truthful), deviatingUtility=encoded(deviating),
                             gain=encoded(gain), margin=encoded(margin), inputRef=a["sourceRef"])
        objective = min(values) if p["objective"]["kind"] == "MAXIMIN" else sum(v * quantity(w) for v, w in zip(values, p["objective"]["weights"]))
        # Independent original-model box bound, explicitly ignoring DSIC/resources.
        # It is not the floating solver's reported dual bound.
        per_report_upper = []
        for report in profiles:
            key = json.dumps(list(report), separators=(",", ":"), ensure_ascii=False)
            bound = max(quantity(p["objective"]["valueByProfile"][key][o["id"]]) -
                        sum((quantity(cost)+quantity(liability))*quantity(p["money"]["ownerPeriodMultipliers"][t])
                            for t,(cost,liability) in enumerate(zip(o["costs"],o["liabilities"]))) for o in p["outcomes"])
            bound -= sum(quantity(next(b for b in a["payments"] if b["dateId"] == d["id"])["minimum"]) *
                         quantity(p["money"]["ownerDateMultipliers"][d["id"]]) for a in parties for d in dates)
            per_report_upper.append(bound)
        upper = min(per_report_upper) if p["objective"]["kind"] == "MAXIMIN" else sum(v * quantity(w) for v, w in zip(per_report_upper, p["objective"]["weights"]))
        search = rule["search"]
        if set(search) != {"status", "numericalSemantics", "optimum", "claimedObjective", "claimedUpper", "proof", "trace"} or search["numericalSemantics"] != "SCIP_FLOAT64_PROPOSAL" or search["proof"] is not None:
            fail("UNADMITTED_BACKEND_PROOF_OR_SEARCH_BASIS")
        if quantity(search["claimedObjective"]) != objective:
            fail("OBJECTIVE_RECONSTRUCTION", calculated=encoded(objective), claimed=search["claimedObjective"])
        if search["claimedUpper"] is not None and quantity(search["claimedUpper"]) != upper:
            fail("ORIGINAL_BOUND_RECONSTRUCTION", calculated=encoded(upper), claimed=search["claimedUpper"])
        if search["optimum"] not in ("UNKNOWN", "ORIGINAL_ANALYTIC_BOUND_ATTAINED") or search["optimum"] == "ORIGINAL_ANALYTIC_BOUND_ATTAINED" and (search["claimedUpper"] is None or objective != upper):
            fail("UNPROVED_OPTIMUM")
        for r in resources.values():
            maxima, minima = [], []
            for t in range(h + 1):
                amounts = [use(r["kind"], raw[r["resourceId"]], t) for raw in demand_paths]
                maxima.append(max(amounts))
                minima.append(min(amounts))
            if r["kind"] in ("STOCK", "CUMULATIVE_EXPENDITURE"):
                maxima = [maxima[0]] + [b - a for a, b in zip(maxima, maxima[1:])]
                minima = [minima[0]] + [b - a for a, b in zip(minima, minima[1:])]
            result["envelopes"].append({"resourceId": r["resourceId"], "unit": r["unit"], "kind": r["kind"],
                                       "horizon": r["horizon"], "quantities": list(map(exact_ledger, maxima)),
                                       "minimumQuantities": list(map(exact_ledger, minima))})
        result.update(objective=encoded(objective), upper=encoded(upper), optimizationGap=encoded(upper - objective),
                      optimum="CHECKED_ANALYTIC" if search["optimum"] == "ORIGINAL_ANALYTIC_BOUND_ATTAINED" and objective == upper else "UNKNOWN",
                      minimumIncentiveMargin=encoded(min(incentive_margins)) if incentive_margins else encoded(Fraction()),
                      minimumParticipationMargin=encoded(min(participation_margins)), maximumDeviationGain=encoded(max([Fraction()] + gains)),
                      basis="MODEL_RELATIVE_EXACT")
        result["accepted"] = not result["failures"]
    except (KeyError, TypeError, ValueError, StopIteration, IndexError, OverflowError) as error:
        result["basis"] = "UNSUPPORTED" if str(error).startswith("UNSUPPORTED") else "UNKNOWN"
        fail(str(error) if isinstance(error, ValueError) else "MALFORMED_ORIGINAL_INPUT_OR_RULE", errorType=type(error).__name__)
    return result


def contradiction(p):
    """Narrow complete original-problem witness: IR impossible even at box upper."""
    validate_original(p)
    checker={"sourceDigest":hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),"implementation":VERSION}
    if p["binding"]["checkerDigest"]!=checker["sourceDigest"]:
        raise ValueError("CHECKER_VERSION_CUSTODY_MISMATCH")
    for i, a in enumerate(p["parties"]):
        for t in a["types"]:
            maximum = max(map(quantity, t["values"].values())) + sum(
                max(quantity(b["minimum"]) * quantity(t["dateMultipliers"][b["dateId"]]),
                    quantity(b["maximum"]) * quantity(t["dateMultipliers"][b["dateId"]])) for b in a["payments"])
            for o in t["outsideOptions"]:
                if quantity(o["utility"]) > maximum:
                    return {"status": "INFEASIBLE", "basis": "ORIGINAL_IR_BOX_CONTRADICTION", "inputDigest": digest(p), "checker":checker,
                            "partyId": a["id"], "trueType": t["id"], "otherReports": o["otherReports"],
                            "maximumUtility": encoded(maximum), "outsideOption": o["utility"],
                            "margin": encoded(maximum - quantity(o["utility"]))}
    return {"status": "UNKNOWN", "basis": "NO_ACCEPTED_ORIGINAL_INFEASIBILITY_PROOF", "inputDigest": digest(p), "checker":checker}


if __name__ == "__main__":
    resource.setrlimit(resource.RLIMIT_CPU, (25, 26))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024,) * 2)
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise SystemExit("R3_CHECK_INPUT_BYTE_BOUND")
    request = json.loads(raw)
    answer = contradiction(request["problem"]) if request.get("operation") == "contradiction" else check(request["problem"], request["rule"])
    answer["usage"] = {"cpuUserSeconds": resource.getrusage(resource.RUSAGE_SELF).ru_utime,
                       "cpuSystemSeconds": resource.getrusage(resource.RUSAGE_SELF).ru_stime,
                       "maxRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024),
                       "money": None, "moneyBasis": "UNMETERED"}
    output = json.dumps(answer, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    if len(output.encode()) > MAX_BYTES:
        raise SystemExit("R3_CHECK_OUTPUT_BYTE_BOUND")
    print(output)
