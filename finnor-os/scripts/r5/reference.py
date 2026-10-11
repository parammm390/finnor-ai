"""Independent original-input R5 reference. No producer/encoding imports."""
import hashlib
import itertools
import json
import re
import sys
import copy
import math
from decimal import Decimal
from canonical_allocation import canonical_constraints
from fractions import Fraction


class Refusal(Exception):
    def __init__(self, boundary, coordinate, observed, required):
        self.witness = dict(boundary=boundary, coordinate=coordinate,
                            observed=str(observed), required=str(required))
        super().__init__(boundary + ":" + coordinate)


def need(condition, boundary, coordinate, observed, required):
    if not condition:
        raise Refusal(boundary, coordinate, observed, required)


def q(value):
    need(isinstance(value, str) and
         re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:/[1-9][0-9]*|\.[0-9]+)?", value),
         "quantity", "original-rational", type(value).__name__, "exact rational string")
    return Fraction(value)


def canon(value):
    # The explicit canonical basis contains authored S4 JSON numbers. Rebuild
    # their ECMAScript spelling instead of accepting producer hash strings.
    if isinstance(value, dict) and ("canonicalAllocation" in value or
                                    value.get("schema") == "finnor.economic-mandate.v1"):
        return canonical_owner_json(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_owner_json(value):
    if isinstance(value, dict):
        keys = sorted(value, key=lambda key: key.encode("utf-16-be", errors="surrogatepass"))
        return "{" + ",".join(canonical_owner_json(key) + ":" + canonical_owner_json(value[key]) for key in keys) + "}"
    if isinstance(value, list):
        return "[" + ",".join(map(canonical_owner_json, value)) + "]"
    if isinstance(value, float):
        need(math.isfinite(value), "canonical", "finite-owner-number", value, "finite S4 number")
        if value == 0:
            return "0"
        sign, magnitude = ("-" if value < 0 else ""), abs(value)
        if 1e-6 <= magnitude < 1e21:
            text = format(Decimal(repr(magnitude)), "f")
            return sign + (text.rstrip("0").rstrip(".") if "." in text else text)
        coefficient, exponent = format(Decimal(repr(magnitude)).normalize(), "e").split("e")
        return sign + coefficient + "e" + ("+" if int(exponent) >= 0 else "") + str(int(exponent))
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canon(value).encode()).hexdigest()


def validate(p):
    need(p.get("schema") == "finnor.r5.original.v1" and
         p.get("version") == "r5-joint-coalition-rational-v1",
         "domain", "schema/version", p.get("version"), "original R5 v1")
    parties = [party["id"] for party in p["parties"]]
    worlds = [world["id"] for world in p["worlds"]]
    need(1 <= len(parties) <= 8 and len(set(parties)) == len(parties),
         "membership", "eligible-parties", parties, "1..8 unique parties")
    need(1 <= len(worlds) <= 32 and len(set(worlds)) == len(worlds),
         "worlds", "joint-index", worlds, "1..32 unique complete worlds")
    dates = p["dates"]
    need(1 <= len(dates) <= 24 and dates == sorted(set(dates)),
         "timing", "dates", dates, "ordered distinct original dates")
    need(len(p["discountFactors"]) == len(dates) and
         all(q(v) > 0 for v in p["discountFactors"]),
         "accounting", "discount", p["discountFactors"], "positive complete factors")
    need(p["model"]["noStrategicSpillover"] == "SUPPLIED_NO_CROSS_COALITION_SPILLOVER",
         "spillover", "supplied-assumption", p["model"], "explicit supplied assumption")
    need(not p["model"]["omittedMechanisms"], "spillover", "omitted-mechanisms",
         p["model"]["omittedMechanisms"], "no omitted mechanism in complete reference")
    for party in p["parties"]:
        for field in ["partyRef", "rightsRef", "outsideOptionRef", "fundingRef", "requiredConsentRef"]:
            need(bool(party[field]["contentDigest"]), "owner-binding", party["id"] + "/" + field,
                 party[field], "original immutable ref")
        need(set(party["outsideOptions"]) == set(worlds) and set(party["settledCash"]) == set(worlds),
             "worlds", party["id"], "incomplete", "outside option and cash on every original world")
        q(party["ownerObjectiveWeight"])
        for world in worlds:
            q(party["outsideOptions"][world])
            need(len(party["settledCash"][world]) == len(dates),
                 "funding", party["id"] + "/" + world, "incomplete", "all original dates")
            for value in party["settledCash"][world]:
                q(value)
    resources = {r["id"]: r for r in p["resources"]}
    need(len(resources) == len(p["resources"]), "resource", "identity", "duplicate", "unique resources")
    for resource in resources.values():
        need(set(resource["available"]) == set(worlds), "resource", resource["id"],
             "incomplete", "every joint world")
        for values in resource["available"].values():
            need(len(values) == len(dates) and all(q(v) >= 0 for v in values),
                 "resource", resource["id"], values, "complete nonnegative availability")
    ops = p["grammar"]["operators"]
    need(1 <= p["grammar"]["maxSteps"] <= 8 and 1 <= len(ops) <= 8 and
         len({op["id"] for op in ops}) == len(ops),
         "grammar", "operators", len(ops), "unique finite original grammar")
    events = {event["id"]: event for event in p["events"]}
    need(len(events) == len(p["events"]), "event", "identity", "duplicate", "unique events")
    for event in events.values():
        need(0 <= event["availableDate"] < len(dates), "event", event["id"],
             event["availableDate"], "original available date")
        for world in p["worlds"]:
            need(world["eventTokens"][event["id"]] in event["tokens"],
                 "event", event["id"] + "/" + world["id"], "unknown token", "registered token")
    for rule in p["transfers"]:
        event = events[rule["eventId"]]
        need(rule["token"] in event["tokens"] and event["availableDate"] <= rule["date"] < len(dates),
             "event", rule["eventId"], rule, "received registered event by payment date")
        need(set(rule["bounds"]) == set(parties), "division", rule["eventId"],
             "incomplete", "every party bound")
        for bounds in rule["bounds"].values():
            need(q(bounds[0]) <= q(bounds[1]), "division", "bounds", bounds, "lower <= upper")
    if p["objective"]["kind"] == "EXPECTED":
        probabilities = p["objective"]["probabilities"]
        need(bool(p["objective"]["qualifiedLawRef"]["contentDigest"]) and
             set(probabilities) == set(worlds) and sum(map(q, probabilities.values())) == 1 and
             all(q(v) >= 0 for v in probabilities.values()),
             "law", "expected-objective", probabilities, "qualified complete original joint law")
    return parties, resources, events


def feature(f, members, step):
    kind = f["kind"]
    if kind == "PRODUCT":
        need(f["left"]["kind"] != "PRODUCT" and f["right"]["kind"] != "PRODUCT",
             "model", "product-degree", f, "two original atomic features")
        return feature(f["left"], members, step) * feature(f["right"], members, step)
    if kind == "CONSTANT":
        return Fraction(1)
    if kind == "MEMBER":
        return Fraction(f["partyId"] in members)
    if kind == "MEMBER_PAIR":
        need(len(set(f["parties"])) == 2, "model", "member-pair", f["parties"], "distinct pair")
        return Fraction(all(p in members for p in f["parties"]))
    if kind == "TERM":
        return q(step["terms"][f["id"]])
    if kind == "GRANT":
        return q(step["grants"][f["resourceId"]][f["date"]])
    raise Refusal("model", "feature", kind, "registered supported feature")


def programme(p, members, steps):
    """Reconstruct original equations, cash timing, demand and canonical items."""
    ids = [party["id"] for party in p["parties"]]
    n = len(p["dates"])
    operators = {op["id"]: op for op in p["grammar"]["operators"]}
    need(1 <= len(steps) <= p["grammar"]["maxSteps"], "grammar", "programme-length",
         len(steps), p["grammar"]["maxSteps"])
    need(len(set(members)) == len(members) and set(members) <= set(ids),
         "membership", "programme-members", members, "distinct eligible parties")
    gross = {w["id"]: {i: Fraction(0) for i in ids} for w in p["worlds"]}
    cash = {w["id"]: {i: [Fraction(0)] * n for i in ids} for w in p["worlds"]}
    outgoing = {w["id"]: {i: [Fraction(0)] * n for i in ids} for w in p["worlds"]}
    use = {r["id"]: [Fraction(0)] * n for r in p["resources"]}
    used, items, exclusive, consents = [], set(), set(), set()
    for number, step in enumerate(steps):
        op = operators[step["operatorId"]]
        need(set(members) <= set(op["eligibleParties"]) and
             set(op["requiredParties"]) <= set(members) and
             op["minMembers"] <= len(members) <= op["maxMembers"],
             "eligibility", op["id"], members, "original permitted membership")
        need(set(op["requiresAfter"]) <= set(used) and
             (not used or operators[used[-1]]["kind"] != "STOP"),
             "programme", op["id"], used, "original executable operator order")
        need(step["terms"] in op["termChoices"] and step["grants"] in op["grantChoices"],
             "grammar", op["id"], step, "original full term/grant choice")
        need(set(step["grants"]) == set(use), "resource", op["id"],
             list(step["grants"]), "complete resource vector")
        for resource, values in step["grants"].items():
            need(len(values) == n and all(q(v) >= 0 for v in values),
                 "resource", resource, values, "complete nonnegative original grant")
            use[resource] = [a + q(b) for a, b in zip(use[resource], values)]
        for cost, equations in [(False, op["equations"]), (True, op["costs"])]:
            for eq in equations:
                owner = eq["ownerPartyId"]
                need(eq["kind"] in {"CASH", "RESIDUAL_ASSET", "LIABILITY"} and
                     owner in ids and eq["unit"] == p["unit"] and
                     eq["currency"] == p["currency"] and 0 <= eq["date"] < n,
                     "accounting", eq["itemId"], eq, "original owner/unit/currency/date")
                active = False
                for world in p["worlds"]:
                    value = sum((q(world["coefficients"][term["coefficientId"]]) *
                                 feature(term["feature"], members, step) for term in eq["terms"]), Fraction(0))
                    need(owner in members or value == 0, "spillover", eq["itemId"],
                         value, "no nonmember payoff mechanism")
                    if cost:
                        need(value >= 0, "cost", eq["itemId"], value, "nonnegative original cost")
                    sign = -1 if cost or eq["kind"] == "LIABILITY" else 1
                    gross[world["id"]][owner] += sign * value * q(p["discountFactors"][eq["date"]])
                    if eq["kind"] == "CASH":
                        cash[world["id"]][owner][eq["date"]] += sign * value
                        outgoing[world["id"]][owner][eq["date"]] += max(Fraction(0), -sign * value)
                    active |= value != 0
                if active:
                    need(eq["itemId"] not in items, "ownership", eq["itemId"],
                         "counted twice", "one canonical economic item")
                    items.add(eq["itemId"])
        exclusive.update(op["exclusiveItems"])
        consents.update(op["consentRequired"])
        used.append(op["id"])
    return dict(members=list(members), steps=steps, itemIds=sorted(items),
                exclusiveItems=sorted(exclusive), requiredConsents=sorted(consents),
                grossPayoffs=gross, cashFlows=cash, cashOutflows=outgoing, resourceUse=use)


def choices(p, members):
    """Independent direct grammar expansion, not the producer's option pool."""
    def visit(steps):
        if steps:
            try:
                yield programme(p, members, steps)
            except Refusal as error:
                if error.witness["boundary"] not in {"eligibility", "programme", "ownership"}:
                    raise
        if len(steps) == p["grammar"]["maxSteps"]:
            return
        for op in p["grammar"]["operators"]:
            if steps and next(o for o in p["grammar"]["operators"] if o["id"] == steps[-1]["operatorId"])["kind"] == "STOP":
                continue
            for terms in op["termChoices"]:
                for grants in op["grantChoices"]:
                    yield from visit(steps + [dict(operatorId=op["id"], terms=terms, grants=grants)])
    return list(visit([]))


def partitions(ids):
    """Restricted-growth construction independent of exact-cover encoding."""
    blocks = []
    def visit(index):
        if index == len(ids):
            yield tuple(tuple(block) for block in blocks)
            return
        for block in blocks:
            block.append(ids[index])
            yield from visit(index + 1)
            block.pop()
        blocks.append([ids[index]])
        yield from visit(index + 1)
        blocks.pop()
    yield from visit(0)


def arrangement(p, selected, division):
    ids = [party["id"] for party in p["parties"]]
    members = [i for option in selected for i in option["members"]]
    need(sorted(members) == sorted(ids), "membership", "exact-cover", members, ids)
    exclusive = [i for option in selected for i in option["exclusiveItems"]]
    items = [i for option in selected for i in option["itemIds"]]
    need(len(set(exclusive)) == len(exclusive) and len(set(items)) == len(items),
         "ownership", "joint-items", "duplicate", "one joint use of each canonical item")
    need(len(division) == len(p["transfers"]), "division", "schedule", len(division), len(p["transfers"]))
    values = {}
    for world in p["worlds"]:
        wid = world["id"]
        net = {i: sum((o["grossPayoffs"][wid][i] for o in selected), Fraction(0)) for i in ids}
        cash = {party["id"]: list(map(q, party["settledCash"][wid])) for party in p["parties"]}
        for party in ids:
            running = Fraction(0)
            for date in range(len(p["dates"])):
                running += sum((o["cashFlows"][wid][party][date] for o in selected), Fraction(0))
                cash[party][date] += running
        for rule, payment in zip(p["transfers"], division):
            need(all(payment[k] == rule[k] for k in ["eventId", "token", "date", "operationRef"]),
                 "event", "contract-binding", payment, rule)
            amounts = payment["amounts"]
            need(set(amounts) == set(ids) and sum(map(q, amounts.values())) == 0,
                 "conservation", rule["eventId"], amounts, "all parties; exact zero sum")
            for party, amount in amounts.items():
                need(q(rule["bounds"][party][0]) <= q(amount) <= q(rule["bounds"][party][1]),
                     "division", party, amount, rule["bounds"][party])
            if world["eventTokens"][rule["eventId"]] == rule["token"]:
                for party in ids:
                    amount = q(amounts[party])
                    net[party] += amount * q(p["discountFactors"][rule["date"]])
                    for date in range(rule["date"], len(p["dates"])):
                        cash[party][date] += amount
        for party in p["parties"]:
            i = party["id"]
            need(net[i] >= q(party["outsideOptions"][wid]), "participation",
                 i + "/" + wid, net[i], party["outsideOptions"][wid])
            for date, amount in enumerate(cash[i]):
                need(amount >= 0, "prefix-funding", i + "/" + wid + "/" + p["dates"][date],
                     amount, "nonnegative cash without earlier promised receipts")
        for resource in p["resources"]:
            total = [sum((o["resourceUse"][resource["id"]][d] for o in selected), Fraction(0))
                     for d in range(len(p["dates"]))]
            if resource["kind"] == "CUMULATIVE_EXPENDITURE":
                total = list(itertools.accumulate(total))
            for date, amount in enumerate(total):
                need(amount <= q(resource["available"][wid][date]), "resource",
                     resource["id"] + "/" + wid + "/" + p["dates"][date],
                     amount, resource["available"][wid][date])
        values[wid] = sum((q(party["ownerObjectiveWeight"]) * net[party["id"]]
                           for party in p["parties"]), Fraction(0))
    if p.get("canonicalAllocation"):
        columns = [dict(optionId="selected-" + str(i), variableId="c" + str(i)) for i in range(len(selected))]
        payments = [dict(rule=rule, partyId=party, variableId="t" + str(rule) + "_" + str(i))
                    for rule in range(len(p["transfers"])) for i, party in enumerate(ids)]
        variables, rows = canonical_constraints(p, serial(selected), columns, payments,
                                                [w["id"] for w in p["worlds"]], q, need, digest)
        primal = {col["variableId"]: Fraction(1) for col in columns}
        for payment in payments:
            amount = q(division[payment["rule"]]["amounts"][payment["partyId"]])
            primal[payment["variableId"]] = amount
            primal["out_" + payment["variableId"]] = max(-amount, Fraction(0))
            primal["sign_" + payment["variableId"]] = Fraction(1 if amount < 0 else 0)
        for variable in variables:
            value = primal[variable["id"]]
            need(q(variable["lower"]) <= value <= q(variable["upper"]), "resource",
                 "canonical-outgoing-bound/" + variable["id"], value, variable)
        for index, (sense, rhs, terms) in enumerate(rows):
            value = sum((coefficient * primal[name] for name, coefficient in terms.items()), Fraction(0))
            need(value == rhs if sense == "E" else value <= rhs if sense == "L" else value >= rhs,
                 "resource", "canonical-row/" + str(index), value, (sense, rhs))
    if p["objective"]["kind"] == "ROBUST":
        return min(values.values()), values
    return sum((q(p["objective"]["probabilities"][wid]) * value
                for wid, value in values.items()), Fraction(0)), values


def one_settlement_division(p, selected):
    """Exact continuous analytical subprofile; never a general LP claim."""
    ids = [party["id"] for party in p["parties"]]
    division = []
    for world in p["worlds"]:
        matching = [r for r in p["transfers"] if world["eventTokens"][r["eventId"]] == r["token"]]
        need(len(matching) == 1, "reference-profile", world["id"], len(matching),
             "one received settlement rule per world; otherwise use exact LP proof")
    for rule in p["transfers"]:
        relevant = [w for w in p["worlds"] if w["eventTokens"][rule["eventId"]] == rule["token"]]
        need(relevant, "reference-profile", rule["eventId"], "unreachable", "registered reachable event")
        lower, upper = {}, {}
        for party in p["parties"]:
            i = party["id"]
            lo, hi = map(q, rule["bounds"][i])
            for world in relevant:
                wid = world["id"]
                gross = sum((o["grossPayoffs"][wid][i] for o in selected), Fraction(0))
                lo = max(lo, (q(party["outsideOptions"][wid]) - gross) /
                         q(p["discountFactors"][rule["date"]]))
                running = Fraction(0)
                for date in range(len(p["dates"])):
                    running += sum((o["cashFlows"][wid][i][date] for o in selected), Fraction(0))
                    cash = q(party["settledCash"][wid][date]) + running
                    if date < rule["date"]:
                        need(cash >= 0, "prefix-funding", i + "/" + wid + "/" + str(date), cash, "nonnegative")
                    else:
                        lo = max(lo, -cash)
            need(lo <= hi, "participation", i, lo, hi)
            lower[i], upper[i] = lo, hi
        need(sum(lower.values()) <= 0 <= sum(upper.values()),
             "division", "continuous-conservation", [sum(lower.values()), sum(upper.values())], "interval covers zero")
        amounts = dict(lower)
        remaining = -sum(amounts.values())
        ranked = sorted(range(len(ids)), key=lambda j: (q(p["parties"][j]["ownerObjectiveWeight"]), j), reverse=True)
        for index in ranked:
            i = ids[index]
            addition = min(remaining, upper[i] - amounts[i])
            amounts[i] += addition
            remaining -= addition
        need(remaining == 0, "division", "continuous-allocation", remaining, "zero")
        division.append({**rule, "amounts": {i: str(amounts[i]) for i in ids}})
    return division


def reference(p):
    ids, _, _ = validate(p)
    options, covered, evaluated, rejected = {}, 0, 0, 0
    best = None
    for partition in partitions(ids):
        covered += 1
        for block in partition:
            if block not in options:
                options[block] = choices(p, block)
        for selected in itertools.product(*(options[block] for block in partition)):
            evaluated += 1
            try:
                division = one_settlement_division(p, selected)
                value, worlds = arrangement(p, selected, division)
            except Refusal as error:
                if error.witness["boundary"] == "reference-profile":
                    raise
                rejected += 1
                continue
            tie = canon([dict(members=o["members"], steps=o["steps"]) for o in selected])
            if best is None or value > best["value"] or value == best["value"] and tie < best["tie"]:
                best = dict(value=value, tie=tie, partition=partition,
                            selected=selected, division=division, worldValues=worlds)
    return dict(schema="finnor.r5.independent-reference.v1",
                originalDigest=digest(p), partitions=covered,
                programmeCombinations=evaluated, rejectedCombinations=rejected,
                divisionProfile="EXACT_CONTINUOUS_ONE_OBSERVABLE_SETTLEMENT",
                best=best, complete=True)


def serial(value):
    if isinstance(value, Fraction):
        return str(value)
    if isinstance(value, dict):
        return {k: serial(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serial(v) for v in value]
    return value


def verify_encoding(p, family, encoding):
    """Original-input reconstruction, with no producer or encoding imports."""
    ids, resources, _ = validate(p)
    need(family["complete"] and not family["unresolved"], "coverage", "programme-family",
         family, "complete original grammar, not a generated shortlist")
    expected_options = {}
    for size in range(1, len(ids) + 1):
        for members in itertools.combinations(ids, size):
            for option in choices(p, members):
                option_id = "option:" + digest(dict(members=list(members), steps=option["steps"]))
                expected_options[option_id] = dict(id=option_id, **serial(option))
    supplied_options = family["options"]
    need(len({o["id"] for o in supplied_options}) == len(supplied_options) and
         {o["id"] for o in supplied_options} == set(expected_options),
         "coverage", "complete-original-programmes", len(supplied_options), len(expected_options))
    for option in supplied_options:
        need(option == expected_options[option["id"]], "model", option["id"],
             option, expected_options[option["id"]])
    counts = {}
    for option in expected_options.values():
        key = tuple(option["members"])
        counts[key] = counts.get(key, 0) + 1
    expected_partitions = []
    for blocks in partitions(ids):
        combinations = 1
        for block in blocks:
            combinations *= counts.get(block, 0)
        original_blocks = [list(block) for block in blocks]
        expected_partitions.append(dict(id="partition:" + digest(original_blocks), blocks=original_blocks,
                                        programmeCombinations=str(combinations),
                                        disposition="COMPLETE_JOINT_ENCODING" if combinations else "NO_ADMITTED_LOCAL_PROGRAMME"))
    need(family["partitions"] == expected_partitions, "coverage", "original-partition-dispositions",
         len(family["partitions"]), len(expected_partitions))
    need(encoding["schema"] == "finnor.r5.milp.v1" and
         encoding["originalDigest"] == digest(p) and
         encoding["grammarDigest"] == digest(p["grammar"]) and
         encoding["worldDigest"] == digest(p["worlds"]),
         "encoding", "original-preimages", encoding["schema"], "exact original bound digests")
    columns = [dict(optionId=o["id"], variableId="c" + str(i))
               for i, o in enumerate(supplied_options)]
    payments = [dict(rule=rule, partyId=party, variableId="t" + str(rule) + "_" + str(i))
                for rule in range(len(p["transfers"])) for i, party in enumerate(ids)]
    need(encoding["optionColumns"] == columns and encoding["transferColumns"] == payments,
         "encoding", "column-bijections", "changed", "all original programme and continuous division columns")
    variables = [dict(id="z", kind="CONTINUOUS", lower=None, upper=None)]
    variables += [dict(id=c["variableId"], kind="BINARY", lower="0", upper="1") for c in columns]
    variables += [dict(id=c["variableId"], kind="CONTINUOUS",
                       lower=p["transfers"][c["rule"]]["bounds"][c["partyId"]][0],
                       upper=p["transfers"][c["rule"]]["bounds"][c["partyId"]][1]) for c in payments]
    canonical_variables, canonical_rows = canonical_constraints(p, supplied_options, columns, payments,
                                                               encoding["restrictedWorlds"], q, need, digest)
    variables += canonical_variables
    need(encoding["variables"] == variables, "encoding", "original-variable-bounds",
         encoding["variables"], variables)
    worlds = encoding["restrictedWorlds"]
    need(worlds and len(set(worlds)) == len(worlds) and set(worlds) <= {w["id"] for w in p["worlds"]},
         "worlds", "restricted-master", worlds, "distinct original joint worlds")
    need(encoding["coverage"] == dict(fullProgrammeFamily=True,
         completeWorldIndex=[w["id"] for w in p["worlds"]], allEligibleParties=ids),
         "coverage", "original-family-index", encoding["coverage"], "complete original indices")
    expected_rows = []

    def options(values):
        return [(c["variableId"], values(o)) for c, o in zip(columns, supplied_options)]

    def row(sense, rhs, terms):
        values = {}
        for name, value in terms:
            values[name] = values.get(name, Fraction(0)) + (value if isinstance(value, Fraction) else q(value))
        expected_rows.append((sense, q(rhs), {name: value for name, value in values.items() if value}))

    def net(world, party):
        return options(lambda o: o["grossPayoffs"][world["id"]][party]) + [
            (c["variableId"], p["discountFactors"][p["transfers"][c["rule"]]["date"]])
            for c in payments if c["partyId"] == party and
            world["eventTokens"][p["transfers"][c["rule"]]["eventId"]] == p["transfers"][c["rule"]]["token"]]

    for party in ids:
        row("E", "1", options(lambda o: "1" if party in o["members"] else "0"))
    for category in ["itemIds", "exclusiveItems"]:
        item_ids = dict.fromkeys(item for option in supplied_options for item in option[category])
        for item in item_ids:
            row("L", "1", options(lambda o: "1" if item in o[category] else "0"))
    for rule in range(len(p["transfers"])):
        row("E", "0", [(c["variableId"], "1") for c in payments if c["rule"] == rule])
    for wid in worlds:
        world = next(w for w in p["worlds"] if w["id"] == wid)
        for party in p["parties"]:
            pid = party["id"]
            row("G", party["outsideOptions"][wid], net(world, pid))
            for date in range(len(p["dates"])):
                terms = options(lambda o: sum(map(q, o["cashFlows"][wid][pid][:date+1]), Fraction(0)))
                terms += [(c["variableId"], "1") for c in payments if c["partyId"] == pid and
                          p["transfers"][c["rule"]]["date"] <= date and
                          world["eventTokens"][p["transfers"][c["rule"]]["eventId"]] == p["transfers"][c["rule"]]["token"]]
                row("G", str(-q(party["settledCash"][wid][date])), terms)
        for resource in p["resources"]:
            for date in range(len(p["dates"])):
                def used(option):
                    values = option["resourceUse"][resource["id"]]
                    return sum(map(q, values[:date+1]), Fraction(0)) if resource["kind"] == "CUMULATIVE_EXPENDITURE" else values[date]
                row("L", resource["available"][wid][date], options(used))
        if p["objective"]["kind"] == "ROBUST":
            terms = [("z", "1")]
            for party in p["parties"]:
                terms += [(name, -q(value)*q(party["ownerObjectiveWeight"])) for name, value in net(world, party["id"])]
            row("L", "0", terms)
    if p["objective"]["kind"] == "EXPECTED":
        terms = [("z", "1")]
        for world in p["worlds"]:
            for party in p["parties"]:
                terms += [(name, -q(value)*q(party["ownerObjectiveWeight"])*q(p["objective"]["probabilities"][world["id"]]))
                          for name, value in net(world, party["id"])]
        row("E", "0", terms)
    supplied_rows = encoding["rows"]
    expected_rows += canonical_rows
    need(len(supplied_rows) == len(expected_rows), "encoding", "original-row-count", len(supplied_rows), len(expected_rows))
    for index, (actual, (sense, rhs, terms)) in enumerate(zip(supplied_rows, expected_rows)):
        need(actual["id"] == "r" + str(index) and actual["sense"] == sense and q(actual["rhs"]) == rhs and
             len({name for name, _ in actual["terms"]}) == len(actual["terms"]) and
             dict((name, q(value)) for name, value in actual["terms"]) == terms,
             "encoding", "original-row/" + str(index), actual, dict(sense=sense, rhs=str(rhs)))
    need(encoding["objective"] == dict(sense="min", terms=[["z", "-1"]]),
         "encoding", "objective-sense", encoding["objective"], "minimize negative original value")
    return dict(disposition="ACCEPTED", claims=["ORIGINAL_FULL_PROGRAMME_ENCODING"],
                originalDigest=digest(p), encodingDigest=digest(encoding),
                programmeOptions=len(supplied_options), transferVariables=len(payments),
                partitions=len(expected_partitions))


def verify_proof(request):
    import importlib.util
    import pathlib
    import stat
    p, encoding = request["original"], request["encoding"]
    result = verify_encoding(p, request["family"], encoding)
    path = pathlib.Path(request["proofPath"])
    need(path.is_absolute() and path.resolve().parent == pathlib.Path.cwd().resolve() and
         stat.S_ISREG(path.lstat().st_mode) and not path.is_symlink() and
         path.stat().st_size <= p["limits"]["native"]["maxProofBytes"],
         "proof", "owned-regular-file", str(path), "same private working directory and original byte grant")
    source = pathlib.Path(__file__).resolve().parents[2] / "packages/epistemic-runtime/python/r2_check.py"
    spec = importlib.util.spec_from_file_location("r5_r2_independent_binding", source)
    binding = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(binding)
    try:
        bound = binding.bind_proof(encoding, str(path))
    except ValueError as error:
        raise Refusal("proof", "original-model-correspondence", str(error), "all original variables/rows/bounds")
    return result | dict(minimizationLower=bound["bound"], infeasibleProof=bound["infeasible"],
                         claims=result["claims"] + ["ORIGINAL_VIPR_MODEL_CORRESPONDENCE"],
                         upper=None if bound["infeasible"] else str(-q(bound["bound"])))


def verify_tie(request):
    """Reconstruct every lexicographic face and native bound independently."""
    import importlib.util
    import pathlib
    import stat
    p, family, base = request["original"], request["family"], request["base"]
    verify_encoding(p, family, base)
    ids = [party["id"] for party in p["parties"]]
    need(base["restrictedWorlds"] == [w["id"] for w in p["worlds"]],
         "tie", "full-world-index", base["restrictedWorlds"], "all original worlds")
    primary = request["primaryValue"]
    source = pathlib.Path(__file__).resolve().parents[2] / "packages/epistemic-runtime/python/r2_check.py"
    spec = importlib.util.spec_from_file_location("r5_tie_independent_binding", source)
    binding = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(binding)
    options = {o["id"]: o for o in family["options"]}

    def terms(criterion):
        if criterion["kind"] == "TRANSFER":
            col = next(c for c in base["transferColumns"] if c["rule"] == criterion["rule"] and
                       c["partyId"] == criterion["partyId"])
            return [[col["variableId"], "-1"]]
        ranks = sorted({canon(o["steps"]) for o in family["options"] if
                        o["members"] == criterion.get("members")})
        result = []
        for col in base["optionColumns"]:
            option = options[col["optionId"]]
            if criterion["kind"] == "MEMBERSHIP" and criterion["anchor"] in option["members"]:
                mask = sum(2 ** (len(ids)-index-1) for index, pid in enumerate(ids) if pid in option["members"])
                result.append([col["variableId"], str(mask)])
            elif criterion["kind"] == "PROGRAMME" and option["members"] == criterion["members"]:
                rank = ranks.index(canon(option["steps"]))
                if rank:
                    result.append([col["variableId"], str(-rank)])
        return result

    fixes, assigned, position = [], set(), 0
    stages = request["stages"]
    need(len(stages) <= 2*len(ids)+len(p["transfers"])*len(ids),
         "tie", "stage-count", len(stages), "complete bounded original coordinate sequence")

    def accept(criterion):
        nonlocal position
        need(position < len(stages), "tie", "missing-coordinate", position, criterion)
        stage = stages[position]
        expected = copy.deepcopy(base)
        expected.update(primaryValue=primary, tieCriterion=criterion, tieFixes=copy.deepcopy(fixes))
        expected["variables"] = [dict(id="z", kind="CONTINUOUS", lower=None, upper=None)] + [
            dict(v, id="economic", lower=primary, upper=primary) if v["id"] == "z" else v
            for v in expected["variables"]]
        for row in expected["rows"]:
            row["terms"] = [["economic" if key == "z" else key, value] for key, value in row["terms"]]
        for fix in fixes:
            expected["rows"].append(dict(id="r"+str(len(expected["rows"])), sense="E",
                                         rhs=fix["value"], terms=terms(fix["criterion"])))
        expected["rows"].append(dict(id="r"+str(len(expected["rows"])), sense="L", rhs="0",
                                     terms=[["z", "1"]]+[[key, str(-q(value))] for key, value in terms(criterion)]))
        need(stage["encoding"] == expected, "tie", "original-coordinate-encoding/"+str(position),
             digest(stage["encoding"]), digest(expected))
        path = pathlib.Path(stage["proofPath"])
        need(path.is_absolute() and path.resolve().parent == pathlib.Path.cwd().resolve() and
             stat.S_ISREG(path.lstat().st_mode) and not path.is_symlink() and
             path.stat().st_size <= p["limits"]["native"]["maxProofBytes"],
             "proof", "tie-owned-regular-file", str(path), "original private directory/byte grant")
        try:
            bound = binding.bind_proof(expected, str(path))
        except ValueError as error:
            raise Refusal("proof", "tie-original-model", str(error), "all original rows/bounds/variables")
        solution = stage["solution"]
        values = {v["id"]: q(solution.get(v["id"], "0")) for v in expected["variables"]}
        for variable in expected["variables"]:
            value = values[variable["id"]]
            need((variable["kind"] != "BINARY" or value in (0, 1)) and
                 (variable["lower"] is None or value >= q(variable["lower"])) and
                 (variable["upper"] is None or value <= q(variable["upper"])),
                 "tie", "primal-bound/"+variable["id"], value, variable)
        for row in expected["rows"]:
            lhs = sum((q(coefficient)*values[key] for key, coefficient in row["terms"]), Fraction(0))
            rhs = q(row["rhs"])
            need(lhs == rhs if row["sense"] == "E" else lhs <= rhs if row["sense"] == "L" else lhs >= rhs,
                 "tie", "primal-row/"+row["id"], lhs, rhs)
        objective = sum((q(coefficient)*values[key] for key, coefficient in terms(criterion)), Fraction(0))
        need(not bound["infeasible"] and objective == values["z"] == q(stage["value"]) == -q(bound["bound"]),
             "tie", "exact-coordinate-gap/"+str(position), [objective, values["z"], stage["value"], bound],
             "feasible coordinate equals original native proof bound")
        fixes.append(dict(criterion=criterion, value=str(objective)))
        position += 1
        return objective

    for pid in ids:
        if pid in assigned:
            continue
        mask = accept(dict(kind="MEMBERSHIP", anchor=pid))
        need(mask.denominator == 1 and 0 < mask < 2**len(ids), "tie", "membership-mask", mask, "original bit mask")
        members = [party for index, party in enumerate(ids) if int(mask) & (1 << (len(ids)-index-1))]
        need(pid in members and not assigned.intersection(members), "tie", "partition", members, "distinct original coalition")
        accept(dict(kind="PROGRAMME", members=members))
        assigned.update(members)
    for rule in range(len(p["transfers"])):
        for pid in ids:
            accept(dict(kind="TRANSFER", rule=rule, partyId=pid))
    need(position == len(stages), "tie", "extra-coordinate", len(stages), position)
    final = stages[-1]["solution"]
    selected = [options[c["optionId"]] for c in base["optionColumns"] if q(final.get(c["variableId"], "0")) == 1]
    candidate = request["candidate"]
    need(candidate["selected"] == selected and q(candidate["objective"]) == q(primary),
         "tie", "final-programme-primal", candidate["selected"], selected)
    for rule, payment in enumerate(candidate["division"]):
        for col in [c for c in base["transferColumns"] if c["rule"] == rule]:
            need(q(payment["amounts"][col["partyId"]]) == q(final.get(col["variableId"], "0")),
                 "tie", "final-transfer-primal", payment, col)
    checked = separate_candidate(p, candidate)
    need(checked["feasible"] and checked["lower"] == q(primary),
         "tie", "full-world-primary-face", checked, primary)
    return checked | dict(tieQualified=True, tieStages=len(stages),
                          claims=["ORIGINAL_FULL_WORLD_FEASIBILITY", "EXACT_FROZEN_TIE_ON_SUPPLIED_PRIMARY_FACE"])


def separate_candidate(p, candidate):
    validate(p)
    reconstructed = [programme(p, o["members"], o["steps"]) for o in candidate["selected"]]
    values, violations = {}, []
    for world in p["worlds"]:
        try:
            _, current = arrangement(p | {"worlds": [world]}, reconstructed, candidate["division"])
            values.update(current)
        except Refusal as error:
            if error.witness["boundary"] not in {"participation", "prefix-funding", "resource"}:
                raise
            violations.append(dict(worldId=world["id"], witness=error.witness))
    lower = None
    if not violations:
        lower = min(values.values()) if p["objective"]["kind"] == "ROBUST" else sum(
            (q(p["objective"]["probabilities"][wid])*value for wid, value in values.items()), Fraction(0))
    return dict(disposition="ACCEPTED", feasible=not violations, lower=lower, upper=None,
                worldValues=[dict(worldId=wid, value=value) for wid, value in values.items()],
                violations=violations, originalDigest=digest(p), candidateDigest=digest(candidate),
                claims=["ORIGINAL_FULL_WORLD_FEASIBILITY"] if not violations else ["ORIGINAL_WORLD_VIOLATION"])


def verify_candidate(p, candidate):
    validate(p)
    if candidate.get("schema") == "finnor.r5.candidate.v1":
        need(candidate["originalDigest"] == digest(p), "owner-binding", "candidate-original",
             candidate["originalDigest"], digest(p))
        supplied = candidate["programmeOptions"]
        pool = {}
        for option in supplied:
            original = programme(p, option["members"], option["steps"])
            option_id = "option:" + digest(dict(members=option["members"], steps=option["steps"]))
            need(option["id"] == option_id and option == dict(id=option_id, **serial(original)),
                 "programme", "candidate-pool-preimage", option["id"], option_id)
            need(option_id not in pool, "programme", "duplicate-pool-option", option_id, "distinct option")
            pool[option_id] = original
        selected = candidate["selectedOptionIds"]
        need(len(set(selected)) == len(selected) and set(selected) <= set(pool),
             "membership", "selected-original-programmes", selected, "distinct original option handles")
        need(candidate["family"]["generatedOptions"] == len(supplied),
             "coverage", "declared-pool-count", candidate["family"]["generatedOptions"], len(supplied))
        reconstructed = [pool[key] for key in selected]
    else:
        reconstructed = [programme(p, o["members"], o["steps"]) for o in candidate["selected"]]
    value, worlds = arrangement(p, reconstructed, candidate["division"])
    need(value == q(candidate["objective"]), "objective", "original-world-value", candidate["objective"], value)
    return dict(disposition="ACCEPTED", feasible=True, lower=value, upper=None,
                worldValues=worlds, claims=["ORIGINAL_FULL_WORLD_FEASIBILITY"],
                originalDigest=digest(p), candidateDigest=digest(candidate))


def verify_owner_programme(request):
    p, candidate = request["original"], request["candidate"]
    checked = verify_candidate(p, candidate)
    selection = request["selectionRef"]
    need(selection["owner"] == "S4" and selection["version"] == p["version"],
         "owner-binding", "selected-programme-s4", selection, "original S4 owner/version")
    pool = {option["id"]: option for option in candidate["programmeOptions"]}
    expected = dict(schema="finnor.p1.coalition-owner-programme.v1",
                    originalDigest=digest(p), candidateDigest=digest(candidate), selectionRef=selection,
                    programmes=[pool[key] for key in candidate["selectedOptionIds"]], division=candidate["division"],
                    stages=["READ_S4_SELECTION", "RESERVE_SINGLE_S5", "INTEND_SINGLE_S5_CONSUMPTION",
                            "PROPOSE_S6_SCHEDULE", "STOP_UNADMITTED_EFFECT"],
                    quantityEncoding="ORIGINAL_CANONICAL_RATIONAL_STRINGS",
                    qualification="ORDINARY_SELECTED_OWNER_PLANNING_NOT_BUSINESS_EXECUTION",
                    executionAuthorityGranted=False)
    need(request["module"] == expected, "programme", "selected-original-owner-handoff",
         digest(request["module"]), digest(expected))
    return checked | dict(programmeDigest=digest(expected), programmeQualified=True,
                          claims=checked["claims"] + ["EXACT_SELECTED_OWNER_HANDOFF_PREIMAGE"])


if __name__ == "__main__":
    request = json.load(sys.stdin)
    try:
        operation = request["operation"]
        if operation == "reference":
            result = reference(request["original"])
        elif operation == "validate":
            validate(request["original"])
            result = dict(disposition="ACCEPTED", originalDigest=digest(request["original"]))
        elif operation == "encoding":
            result = verify_encoding(request["original"], request["family"], request["encoding"])
        elif operation == "proof":
            result = verify_proof(request)
        elif operation == "tie":
            result = verify_tie(request)
        elif operation == "separate":
            result = separate_candidate(request["original"], request["candidate"])
        elif operation == "candidate":
            result = verify_candidate(request["original"], request["candidate"])
        elif operation == "programme":
            result = verify_owner_programme(request)
        else:
            raise Refusal("operation", "independent-check", operation, "registered operation")
        print(json.dumps(serial(result), sort_keys=True))
    except Refusal as error:
        print(json.dumps(dict(disposition="REJECTED", feasible=False, lower=None,
                              upper=None, reason=str(error), witnesses=[error.witness]), sort_keys=True))
        sys.exit(1)
