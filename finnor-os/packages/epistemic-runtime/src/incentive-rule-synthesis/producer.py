"""Complete finite MILP proposer. Acceptance is a separate checker.py process."""
from fractions import Fraction
import hashlib
import itertools
import json
import pathlib
import resource
import sys
import time
from repair import feasible, repair


def rational(value):
    return Fraction(int(value["numerator"]), int(value["denominator"]))


def number(q):
    return {"numerator": str(q.numerator), "denominator": str(q.denominator)}


def digest(v):
    return hashlib.sha256(json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def encoding(p, allocation=None, transfer_signs=None):
    parties, outcomes, dates = p["parties"], p["outcomes"], p["dates"]
    profiles = list(itertools.product(*(tuple(t["id"] for t in a["types"]) for a in parties)))
    index = {r: i for i, r in enumerate(profiles)}
    rows, bounds, names, kinds = [], [], [], []
    def variable(name, lower, upper, kind="C"):
        j = len(bounds)
        bounds.append((lower, upper))
        names.append(name)
        kinds.append(kind)
        return j
    def add(a, b, name):
        rows.append(({j: v for j, v in a.items() if v}, b, name))
    def le(a, b, name):
        add(a, b, name)
    def eq(a, b, name):
        add(a, b, name + ":upper")
        add({j: -v for j, v in a.items()}, -b, name + ":lower")
    def expression(terms):
        result = {}
        for j, v in terms:
            result[j] = result.get(j, Fraction()) + v
        return result
    x, transfers, gross, signs = {}, {}, {}, {}
    for r in range(len(profiles)):
        if allocation is None:
            for o, outcome in enumerate(outcomes):
                eligible = outcome["eligibility"] == "ALL_REPORTS" or list(profiles[r]) in outcome["eligibility"]
                x[r, o] = variable("x:%d:%d" % (r, o), Fraction(), Fraction(int(eligible)), "B")
            eq({x[r, o]: Fraction(1) for o in range(len(outcomes))}, Fraction(1), "deterministic:%d" % r)
        for i, party in enumerate(parties):
            for d, date in enumerate(dates):
                b = next(b for b in party["payments"] if b["dateId"] == date["id"])
                low, high = rational(b["minimum"]), rational(b["maximum"])
                transfers[r, i, d] = variable("cash:%d:%d:%d" % (r, i, d), low, high)
                gross[r, i, d] = variable("gross:%d:%d:%d" % (r, i, d), Fraction(), max(Fraction(), high))
                le({transfers[r, i, d]: Fraction(1), gross[r, i, d]: Fraction(-1)}, Fraction(), "positive-cash:%d:%d:%d" % (r, i, d))
                cash, positive = transfers[r, i, d], gross[r, i, d]
                if low >= 0:
                    eq({positive: Fraction(1), cash: Fraction(-1)}, Fraction(), "gross-exact-positive:%d:%d:%d" % (r, i, d))
                elif high <= 0:
                    bounds[positive] = (Fraction(), Fraction())
                elif transfer_signs is not None:
                    if transfer_signs[r, i, d]:
                        bounds[cash] = (Fraction(), high)
                        eq({positive: Fraction(1), cash: Fraction(-1)}, Fraction(), "gross-fixed-positive:%d:%d:%d" % (r, i, d))
                    else:
                        bounds[cash], bounds[positive] = (low, Fraction()), (Fraction(), Fraction())
                else:
                    sign = variable("transfer-sign:%d:%d:%d" % (r, i, d), Fraction(), Fraction(1), "B")
                    signs[r, i, d] = sign
                    le({cash: Fraction(1), sign: -high}, Fraction(), "cash-sign-upper:%d:%d:%d" % (r, i, d))
                    le({cash: Fraction(-1), sign: -low}, -low, "cash-sign-lower:%d:%d:%d" % (r, i, d))
                    le({positive: Fraction(1), sign: -high}, Fraction(), "gross-sign-upper:%d:%d:%d" % (r, i, d))
                    le({positive: Fraction(1), cash: Fraction(-1), sign: -low}, -low, "gross-sign-exact:%d:%d:%d" % (r, i, d))
    def outcome_expression(r, values):
        return ({x[r, o]: v for o, v in enumerate(values)}, Fraction()) if allocation is None else ({}, values[allocation[r]])
    def add_combined(a, b, expression_value):
        terms, constant = expression_value
        return expression(list(a.items()) + list(terms.items())), b - constant
    counts = {"profiles": len(profiles), "outcomeBinaries": len(x), "scalarTransfers": len(transfers),
              "datedCashVariables": len(transfers), "grossOutflowAuxiliaries": len(gross), "transferSignBinaries":len(signs), "deviations": 0, "participation": 0}
    for r, report in enumerate(profiles):
        for i, party in enumerate(parties):
            t = next(t for t in party["types"] if t["id"] == report[i])
            rates = [rational(t["dateMultipliers"][d["id"]]) for d in dates]
            others = report[:i] + report[i + 1:]
            outside = rational(next(o["utility"] for o in t["outsideOptions"] if tuple(o["otherReports"]) == others))
            # -v(truth) - tau(truth) <= -outside
            a = {transfers[r, i, d]: -rate for d, rate in enumerate(rates)}
            terms, constant = outcome_expression(r, [-rational(t["values"][o["id"]]) for o in outcomes])
            a = expression(list(a.items()) + list(terms.items()))
            le(a, -outside - constant, "ir:%d:%d" % (r, i))
            counts["participation"] += 1
            for alternative in party["types"]:
                if alternative["id"] == t["id"]:
                    continue
                changed = list(report)
                changed[i] = alternative["id"]
                alt = index[tuple(changed)]
                terms = [(transfers[alt, i, d], rate) for d, rate in enumerate(rates)]
                terms += [(transfers[r, i, d], -rate) for d, rate in enumerate(rates)]
                truth_a, truth_c = outcome_expression(r, [-rational(t["values"][o["id"]]) for o in outcomes])
                alt_a, alt_c = outcome_expression(alt, [rational(t["values"][o["id"]]) for o in outcomes])
                le(expression(terms + list(truth_a.items()) + list(alt_a.items())), -truth_c - alt_c, "dsic:%d:%d:%d" % (r, i, alt))
                counts["deviations"] += 1
        net = {transfers[r, i, d]: Fraction(1) for i in range(len(parties)) for d in range(len(dates))}
        le(net, rational(p["constraints"]["netTransferMaximum"]), "net-max:%d" % r)
        le({j: -v for j, v in net.items()}, -rational(p["constraints"]["netTransferMinimum"]), "net-min:%d" % r)
        for i, party in enumerate(parties):
            le({gross[r, i, d]: Fraction(1) for d in range(len(dates))}, rational(party["liabilityCap"]), "party-liability:%d:%d" % (r, i))
        a = {gross[r, i, d]: Fraction(1) for i in range(len(parties)) for d in range(len(dates))}
        a, b = add_combined(a, rational(p["constraints"]["ownerLiabilityCap"]), outcome_expression(r, [sum(map(rational, o["liabilities"])) for o in outcomes]))
        le(a, b, "owner-liability:%d" % r)
        for d, date in enumerate(dates):
            period = date["period"]
            a = {gross[r, i, d]: Fraction(1) for i in range(len(parties))}
            fixed = outcome_expression(r, [rational(o["costs"][period]) + rational(o["liabilities"][period]) for o in outcomes])
            a, b = add_combined(a, min(rational(date["grossOutflowCap"]), rational(date["escrowCap"])), fixed)
            le(a, b, "dated-funding:%d:%d" % (r, d))
        def demand(resource_id, period):
            resource = next(q for q in p["resources"] if q["resourceId"] == resource_id)
            slots = range(period + 1) if resource["kind"] in ("STOCK", "CUMULATIVE_EXPENDITURE") else [period]
            values = [sum((rational(o["demands"][resource_id][s]) for s in slots), Fraction()) for o in outcomes]
            if resource_id == p["constraints"]["cashResourceId"]:
                values = [v + sum((rational(o["costs"][s]) + rational(o["liabilities"][s]) for s in slots), Fraction()) for v, o in zip(values, outcomes)]
            a, constant = outcome_expression(r, values)
            if resource_id == p["constraints"]["cashResourceId"]:
                a = expression(list(a.items()) + [(gross[r, i, d], Fraction(1)) for i in range(len(parties)) for d, date in enumerate(dates) if date["period"] in slots])
            return a, constant, resource, slots
        def raw_demand(resource_id, slots):
            values = [sum((rational(o["demands"][resource_id][s]) for s in slots), Fraction()) for o in outcomes]
            if resource_id == p["constraints"]["cashResourceId"]:
                values = [v + sum((rational(o["costs"][s]) + rational(o["liabilities"][s]) for s in slots), Fraction()) for v, o in zip(values, outcomes)]
            a, constant = outcome_expression(r, values)
            if resource_id == p["constraints"]["cashResourceId"]:
                a = expression(list(a.items()) + [(gross[r, i, d], Fraction(1)) for i in range(len(parties)) for d, date in enumerate(dates) if date["period"] in slots])
            return a, constant
        horizon = p["resources"][0]["horizon"]["periods"]
        for dimension in p["mandateLimits"]["dimensions"]:
            a, constant = raw_demand(dimension["resourceId"], range(horizon + 1))
            le(a, rational(dimension["totalLimit"]) - constant, "mandate-total:%d:%s" % (r, dimension["resourceId"]))
            for period in range(horizon + 1):
                a, constant = raw_demand(dimension["resourceId"], [period])
                le(a, rational(dimension["capacity"]) - constant, "mandate-capacity:%d:%s:%d" % (r, dimension["resourceId"], period))
        for coupling in p["mandateLimits"]["couplings"]:
            for period in range(horizon + 1):
                a, fixed = {}, Fraction()
                for key, weight in coupling["weights"].items():
                    coefficients, constant = raw_demand(key, [period])
                    coefficient = rational(weight)
                    a = expression(list(a.items()) + [(j, v * coefficient) for j, v in coefficients.items()])
                    fixed += constant * coefficient
                le(a, rational(coupling["maximum"]) - fixed, "mandate-coupling:%d:%s:%d" % (r, coupling["id"], period))
        for resource_value in p["resources"]:
            for period in range(resource_value["horizon"]["periods"] + 1):
                a, fixed, resource_value, slots = demand(resource_value["resourceId"], period)
                maximum = rational(resource_value["availability"][period]) - rational(resource_value["safetyMargin"])
                baseline = sum((rational(resource_value["baseline"][s]) for s in slots), Fraction())
                le(a, maximum - baseline - fixed, "resource:%d:%s:%d" % (r, resource_value["resourceId"], period))
        for covenant in p["covenants"]:
            for period in covenant["periods"]:
                a, fixed = {}, Fraction()
                for term in covenant["terms"]:
                    coefficient = rational(term["coefficient"])
                    demand_a, demand_fixed, resource_value, slots = demand(term["resourceId"], period)
                    a = expression(list(a.items()) + [(j, v * coefficient) for j, v in demand_a.items()])
                    base = resource_value["minimumBaseline"] if coefficient < 0 else resource_value["baseline"]
                    fixed += coefficient * (demand_fixed + sum((rational(base[s]) for s in slots), Fraction()))
                le(a, rational(covenant["maximum"]) - rational(covenant["safetyMargin"]) - fixed, "covenant:%d:%s:%d" % (r, covenant["id"], period))
    objective_rows = []
    for r, report in enumerate(profiles):
        key = json.dumps(list(report), separators=(",", ":"), ensure_ascii=False)
        values = [rational(p["objective"]["valueByProfile"][key][o["id"]]) -
                  sum((rational(cost)+rational(liability))*rational(p["money"]["ownerPeriodMultipliers"][t])
                      for t,(cost,liability) in enumerate(zip(o["costs"],o["liabilities"]))) for o in outcomes]
        a, constant = outcome_expression(r, values)
        a = expression(list(a.items()) + [(transfers[r, i, d], -rational(p["money"]["ownerDateMultipliers"][date["id"]])) for i in range(len(parties)) for d, date in enumerate(dates)])
        objective_rows.append((a, constant))
        le({j: -v for j, v in a.items()}, constant - rational(p["objective"]["minimumValue"]), "owner-risk-floor:%d" % r)
    return {"rows": rows, "bounds": bounds, "names": names, "kinds": kinds, "profiles": profiles,
            "x": x, "transfers": transfers, "gross": gross, "signs":signs, "objectiveRows": objective_rows, "counts": counts}


def synthesize(p, seconds):
    import pyscipopt
    import numpy
    started, deadline = time.monotonic(), time.monotonic() + min(24, seconds)
    e = encoding(p)
    if len(e["bounds"]) > 2500 or len(e["rows"]) > 30000:
        raise ValueError("R3_COMPLETE_ENCODING_SIZE_BOUND")
    m = pyscipopt.Model("R3_complete_original_mechanism")
    m.hideOutput()
    settings = {"limits/time": max(0.001, deadline - time.monotonic() - 2),
                "limits/memory": 768.0, "limits/nodes": 100000,
                "parallel/maxnthreads": 1, "randomization/randomseedshift": 0,
                "randomization/permutationseed": 0}
    for name, value in settings.items():
        m.setParam(name, value)
    variables = [m.addVar(name=name, vtype=kind, lb=float(low), ub=float(high)) for name, kind, (low, high) in zip(e["names"], e["kinds"], e["bounds"])]
    for a, b, name in e["rows"]:
        m.addCons(pyscipopt.quicksum(float(v) * variables[j] for j, v in a.items()) <= float(b), name=name)
    if p.get("referenceGrid") is not None:
        grid = list(map(rational, p["referenceGrid"]))
        for key, j in e["transfers"].items():
            grid_vars = [m.addVar(name="grid:%d:%d" % (j, k), vtype="B") for k in range(len(grid))]
            m.addCons(pyscipopt.quicksum(grid_vars) == 1)
            m.addCons(variables[j] == pyscipopt.quicksum(float(q) * v for q, v in zip(grid, grid_vars)))
        e["counts"]["referenceGridBinaries"] = len(e["transfers"]) * len(grid)
    if p["objective"]["kind"] == "MAXIMIN":
        box_lowers,box_uppers=[],[]
        for a,constant in e["objectiveRows"]:
            box_lowers.append(constant+sum(v*(e["bounds"][j][0] if v>=0 else e["bounds"][j][1]) for j,v in a.items()))
            box_uppers.append(constant+sum(v*(e["bounds"][j][1] if v>=0 else e["bounds"][j][0]) for j,v in a.items()))
        z = m.addVar("worst_owner_value", lb=float(min(box_lowers)), ub=float(min(box_uppers)))
        for a, constant in e["objectiveRows"]:
            m.addCons(z <= pyscipopt.quicksum(float(v) * variables[j] for j, v in a.items()) + float(constant))
        m.setObjective(z, "maximize")
    else:
        m.setObjective(pyscipopt.quicksum(float(rational(w)) * (pyscipopt.quicksum(float(v) * variables[j] for j, v in a.items()) + float(constant)) for (a, constant), w in zip(e["objectiveRows"], p["objective"]["weights"])), "maximize")
    m.optimize()
    status = str(m.getStatus())
    trace = {"backend": "SCIP", "scipVersion": "%s.%s.%s" % (m.getMajorVersion(), m.getMinorVersion(), m.getTechVersion()),
             "pyscipoptVersion": pyscipopt.__version__, "numpyVersion": numpy.__version__, "settings": settings,
             "numericalSemantics": "FLOAT64", "exactModeAvailable": "exact/enable" in m.getParams(),
             "exactModeEnabled": False, "proofLogging": "NOT_ADOPTED", "encodingDigest": digest({"rows": [[{str(j): number(v) for j, v in a.items()}, number(b), name] for a, b, name in e["rows"]], "bounds": [[number(a), number(b)] for a, b in e["bounds"]]}),
             "counts": e["counts"], "constraintRows": len(e["rows"]), "solverStatus": status,
             "solverDualBoundEstimate": m.getDualbound() if abs(m.getDualbound()) < 1e20 else None,
             "solverEstimateQualification": "NUMERICAL_HINT_NOT_ACCEPTED_PROOF",
             "tieConvention": "FIXED_INPUT_DOMAIN_ORDER_SEED0_FLOAT_BACKEND_NOT_CANONICAL_REPLAY",
             "originalModelOptimum": "UNKNOWN", "originalModelInfeasibility": "UNKNOWN"}
    if m.getNSols() == 0:
        return {"status": "UNKNOWN", "rule": None, "trace": trace}
    solution = m.getBestSol()
    allocation = [max(range(len(p["outcomes"])), key=lambda o: m.getSolVal(solution, variables[e["x"][r, o]])) for r in range(len(e["profiles"]))]
    transfer_signs = {key:m.getSolVal(solution,variables[j]) >= 0.5 for key,j in e["signs"].items()}
    fixed = encoding(p, allocation, transfer_signs)
    cash_proposal = {key: Fraction(m.getSolVal(solution, variables[j])).limit_denominator(1000000) for key, j in e["transfers"].items()}
    proposal = [Fraction() for _ in fixed["bounds"]]
    for key, j in fixed["transfers"].items():
        proposal[j] = cash_proposal[key]
    for key, j in fixed["gross"].items():
        proposal[j] = max(cash_proposal[key], 0)
    if feasible(fixed["rows"], fixed["bounds"], proposal):
        exact = proposal
        trace["repair"] = {"basis": "RATIONAL_RECONSTRUCTION_ALL_FIXED_ALLOCATION_ROWS_EXACT", "pivots": 0}
    else:
        exact, trace["repair"] = repair(fixed["rows"], fixed["bounds"], deadline)
        if exact is None:
            return {"status": "UNKNOWN", "rule": None, "trace": trace}
        trace["repair"]["transferSignBasis"]="PROPOSED_SIGNS_FIXED_ONLY_CANDIDATE_FEASIBILITY_NOT_COMPLETE_TRANSFER_SEARCH"
    table, owner_values = [], []
    for r, report in enumerate(fixed["profiles"]):
        schedule = [{"partyId": party["id"], "dateId": date["id"], "amount": number(exact[fixed["transfers"][r, i, d]]),
                     "eventId": "due:" + date["id"], "currency": p["money"]["currency"], "unit": p["money"]["unit"], "dueAt": date["at"]}
                    for i, party in enumerate(p["parties"]) for d, date in enumerate(p["dates"])]
        table.append({"reports": list(report), "outcomeId": p["outcomes"][allocation[r]]["id"], "schedule": schedule})
        a, constant = fixed["objectiveRows"][r]
        owner_values.append(constant + sum((v * exact[j] for j, v in a.items()), Fraction()))
    objective = min(owner_values) if p["objective"]["kind"] == "MAXIMIN" else sum(v * rational(w) for v, w in zip(owner_values, p["objective"]["weights"]))
    rule = {"schema": "finnor.r3.rule.v1", "inputDigest": digest(p), "binding": p["binding"], "table": table,
            "search": {"status": status, "numericalSemantics": "SCIP_FLOAT64_PROPOSAL", "optimum": "UNKNOWN",
                       "claimedObjective": number(objective), "claimedUpper": None, "proof": None, "trace": trace}}
    trace["elapsedMs"] = (time.monotonic() - started) * 1000
    return {"status": "INCOMPLETE", "rule": rule, "trace": trace,
            "qualification": "PROVISIONAL_UNTIL_SEPARATE_ORIGINAL_INPUT_CHECK_NO_OPTIMUM_PROOF"}


if __name__ == "__main__":
    resource.setrlimit(resource.RLIMIT_CPU, (25, 26))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024,) * 2)
    raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise SystemExit("R3_PRODUCER_INPUT_BYTE_BOUND")
    request = json.loads(raw)
    try:
        answer = synthesize(request["problem"], request["seconds"])
    except (TimeoutError, ValueError) as error:
        answer = {"status": "UNKNOWN", "rule": None, "failure": str(error)}
    answer["usage"] = {"cpuUserSeconds": resource.getrusage(resource.RUSAGE_SELF).ru_utime,
                       "cpuSystemSeconds": resource.getrusage(resource.RUSAGE_SELF).ru_stime,
                       "maxRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024),
                       "money": None, "moneyBasis": "UNMETERED"}
    output = json.dumps(answer, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    if len(output.encode()) > 8 * 1024 * 1024:
        raise SystemExit("R3_PRODUCER_OUTPUT_BYTE_BOUND")
    print(output)
