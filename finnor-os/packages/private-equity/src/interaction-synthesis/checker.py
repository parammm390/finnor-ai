"""Exact original-bytes checker. No producer or reference imports."""
import hashlib
import json
import os
import re
import resource
import sys
import time
from fractions import Fraction

ROOT = os.path.dirname(os.path.realpath(__file__))
PROFILE_BYTES = open(os.path.join(ROOT, "profile.json"), "rb").read()
PROFILE = json.loads(PROFILE_BYTES)
PROFILE_DIGEST = hashlib.sha256(PROFILE_BYTES).hexdigest()
MAX_BITS = PROFILE["maxArithmeticBits"]
START = time.monotonic()

class Rejected(Exception):
    pass

class Gap(Exception):
    pass

def need(ok, reason):
    if not ok:
        raise Rejected(reason)

def bounded(value):
    if value.numerator.bit_length() > MAX_BITS or value.denominator.bit_length() > MAX_BITS:
        raise Gap("Y3_ARITHMETIC_BOUND")
    return Q(value.numerator, value.denominator)

class Q(Fraction):
    def __new__(cls, n=0, d=None):
        value = super().__new__(cls, n) if d is None else super().__new__(cls, n, d)
        if value.numerator.bit_length() > MAX_BITS or value.denominator.bit_length() > MAX_BITS:
            raise Gap("Y3_ARITHMETIC_BOUND")
        return value
    def __add__(self, other):
        return bounded(Fraction.__add__(self, other))
    __radd__ = __add__
    def __sub__(self, other):
        return bounded(Fraction.__sub__(self, other))
    def __mul__(self, other):
        return bounded(Fraction.__mul__(self, other))
    __rmul__ = __mul__
    def __truediv__(self, other):
        return bounded(Fraction.__truediv__(self, other))

def rat(value, unknown="Y3_UNKNOWN_QUANTITY"):
    if value is None:
        raise Gap(unknown)
    need(isinstance(value, str) and len(value) <= 2500 and re.fullmatch(r"-?(0|[1-9][0-9]*)(/[1-9][0-9]*)?", value), "Y3_NONCANONICAL_RATIONAL")
    result = Q(value)
    need(str(result) == value, "Y3_NONCANONICAL_RATIONAL")
    return result

def canonical(value):
    def ordered(v):
        if isinstance(v, dict):
            return {k: ordered(v[k]) for k in sorted(v, key=lambda k: k.encode("utf-16be", "surrogatepass"))}
        if isinstance(v, list):
            return [ordered(x) for x in v]
        return v
    return json.dumps(ordered(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)

def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()

def obj(value, required, optional=()):
    need(type(value) is dict and set(required).issubset(value) and set(value).issubset(set(required) | set(optional)), "Y3_OBJECT_SHAPE")

def text(value, maximum=256):
    need(type(value) is str and 0 < len(value) <= maximum, "Y3_TEXT_SHAPE")

def identifier(value):
    need(type(value) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", value) and value not in ("__proto__", "constructor", "prototype"), "Y3_IDENTIFIER")

def unique(values, reason):
    need(len(set(values)) == len(values), reason)

def reference(value):
    obj(value, ("owner", "id", "version", "contentDigest"))
    text(value["owner"]); text(value["id"], 1024); text(value["version"])
    need(type(value["contentDigest"]) is str and re.fullmatch("[a-f0-9]{64}", value["contentDigest"]), "Y3_REFERENCE_DIGEST")

def basis(value):
    obj(value, ("unit", "currency", "timeBasis", "owner", "rounding", "sourceStatus", "sourceRef"))
    for k in ("unit", "timeBasis", "owner"):
        text(value[k])
    need(value["currency"] is None or type(value["currency"]) is str and re.fullmatch("[A-Z]{3}", value["currency"]), "Y3_CURRENCY")
    need(value["rounding"] == "EXACT" and value["sourceStatus"] in ("SUPPLIED_MODEL", "CANONICAL_OBSERVATION", "UNKNOWN"), "Y3_QUANTITY_BASIS")
    reference(value["sourceRef"])

def quantity(value):
    obj(value, ("value", "basis"), ("unknownReason",))
    basis(value["basis"])
    if value["value"] is None:
        text(value.get("unknownReason"))
    else:
        rat(value["value"])
    if "unknownReason" in value:
        text(value["unknownReason"])

def known_quantity(value):
    quantity(value)
    if value["basis"]["sourceStatus"] == "UNKNOWN":
        raise Gap("Y3_UNKNOWN_BASIS")
    return rat(value["value"])

def schema(problem):
    obj(problem, ("schema", "id", "title", "participants", "dates", "fixedOperatorRefs", "actorModelRefs", "quantityBasis", "financialLimits", "observationRules", "controls", "models", "resourceLimits", "goal"))
    need(problem["schema"] == "finnor.interaction-problem.v1", "Y3_SCHEMA")
    identifier(problem["id"]); text(problem["title"])
    need(type(problem["participants"]) is list and len(problem["participants"]) == 2, "Y3_PARTIES")
    for i, participant in enumerate(problem["participants"]):
        obj(participant, ("id", "principalId", "outsideOption"))
        need(participant["id"] == "P" + str(i), "Y3_PARTY_ID")
        need(type(participant["principalId"]) is str and re.fullmatch(r"[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", participant["principalId"]), "Y3_PRINCIPAL_ID")
        quantity(participant["outsideOption"])
    unique([p["principalId"] for p in problem["participants"]], "Y3_DISTINCT_PRINCIPALS_REQUIRED")
    need(type(problem["dates"]) is list and len(problem["dates"]) == 3, "Y3_DATES")
    import datetime
    instants = []
    for instant in problem["dates"]:
        need(type(instant) is str and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)", instant), "Y3_DATE")
        try:
            instants.append(datetime.datetime.fromisoformat(instant.replace("Z", "+00:00")))
        except ValueError:
            raise Rejected("Y3_DATE")
    need(instants[0] < instants[1] < instants[2], "Y3_ORDERED_DATES_REQUIRED")
    for key in ("fixedOperatorRefs", "actorModelRefs"):
        need(type(problem[key]) is list and 1 <= len(problem[key]) <= 64, "Y3_REFERENCE_COUNT")
        for r in problem[key]:
            reference(r)
    obj(problem["quantityBasis"], ("utilities", "ownerValue"))
    need(type(problem["quantityBasis"]["utilities"]) is list and len(problem["quantityBasis"]["utilities"]) == 2, "Y3_UTILITY_BASES")
    for b in problem["quantityBasis"]["utilities"] + [problem["quantityBasis"]["ownerValue"]]:
        basis(b)
        if b["sourceStatus"] == "UNKNOWN":
            raise Gap("Y3_UNKNOWN_BASIS")
    limits = problem["financialLimits"]
    obj(limits, ("absolutePayments", "liabilities", "semantics"))
    need(limits["semantics"] == "SIGNED_NODE_SNAPSHOTS_NO_IMPLICIT_NETTING_OR_UTILITY_CONVERSION", "Y3_FINANCIAL_SEMANTICS")
    for field in ("absolutePayments", "liabilities"):
        need(type(limits[field]) is list and len(limits[field]) == 2, "Y3_FINANCIAL_LIMIT_PAIR")
        for value in limits[field]:
            need(known_quantity(value) >= 0, "Y3_NEGATIVE_FINANCIAL_LIMIT")
    for i, p in enumerate(problem["participants"]):
        need(p["outsideOption"]["basis"] == problem["quantityBasis"]["utilities"][i], "Y3_OUTSIDE_OPTION_BASIS")
        known_quantity(p["outsideOption"])
    obj(problem["goal"], ("minimumOwnerValue", "requireNontrivial"))
    need(type(problem["goal"]["requireNontrivial"]) is bool, "Y3_GOAL_SHAPE")
    need(problem["goal"]["minimumOwnerValue"]["basis"] == problem["quantityBasis"]["ownerValue"], "Y3_GOAL_BASIS")
    known_quantity(problem["goal"]["minimumOwnerValue"])
    need(type(problem["resourceLimits"]) is dict and len(problem["resourceLimits"]) <= 128, "Y3_RESOURCE_LIMITS")
    for key, value in problem["resourceLimits"].items():
        identifier(key)
        need(known_quantity(value) >= 0, "Y3_NEGATIVE_RESOURCE_LIMIT")
    need(type(problem["observationRules"]) is list and len(problem["observationRules"]) <= 64, "Y3_OBSERVATION_RULES")
    for rule in problem["observationRules"]:
        obj(rule, ("key", "allowedRecipients", "mandatoryByDate", "classification", "sourceRef"))
        identifier(rule["key"])
        need(type(rule["allowedRecipients"]) is list and 1 <= len(rule["allowedRecipients"]) <= 3 and all(r in ("P0", "P1", "PUBLIC") for r in rule["allowedRecipients"]), "Y3_RECIPIENTS")
        unique(rule["allowedRecipients"], "Y3_DUPLICATE_RECIPIENT")
        need(rule["mandatoryByDate"] is None or type(rule["mandatoryByDate"]) is int and rule["mandatoryByDate"] in (0, 1, 2), "Y3_MANDATORY_DATE")
        need(rule["classification"] in ("SOURCED_FACT", "AUTHENTICATED_ASSERTION", "MODEL_RELATIVE_STATEMENT", "UNRESOLVED_CLAIM"), "Y3_CLAIM_CLASS")
        reference(rule["sourceRef"])
    unique([r["key"] for r in problem["observationRules"]], "Y3_DUPLICATE_OBSERVATION_RULE")
    need(type(problem["controls"]) is list and len(problem["controls"]) <= PROFILE["maxProtocolControls"], "Y3_CONTROL_BOUND")
    for c in problem["controls"]:
        obj(c, ("id", "kind", "options")); identifier(c["id"])
        need(c["kind"] in ("DISCLOSURE", "COMMUNICATION", "COMMITMENT_TIMING"), "Y3_CONTROL_KIND")
        need(type(c["options"]) is list and 1 <= len(c["options"]) <= PROFILE["maxProtocolOptions"], "Y3_OPTION_BOUND")
        for a in c["options"]:
            identifier(a)
        unique(c["options"], "Y3_DUPLICATE_ACTION")
    unique([c["id"] for c in problem["controls"]], "Y3_DUPLICATE_CONTROL")
    need(type(problem["models"]) is list and 1 <= len(problem["models"]) <= PROFILE["maxModels"], "Y3_MODEL_BOUND")
    rules = {r["key"]: r for r in problem["observationRules"]}
    controls = {c["id"]: c for c in problem["controls"]}
    for model in problem["models"]:
        obj(model, ("id", "qualificationRef", "root", "nodes"))
        identifier(model["id"]); identifier(model["root"]); reference(model["qualificationRef"])
        need(type(model["nodes"]) is list and 1 <= len(model["nodes"]) <= PROFILE["maxNodesPerModel"], "Y3_NODE_BOUND")
        for n in model["nodes"]:
            common = ("id", "date", "state", "observations", "resources", "payments", "liabilities", "kind")
            extra = {"CHANCE": ("chanceRole", "probabilityBasis", "edges"), "DECISION": ("participant", "edges"), "PROTOCOL": ("controlId", "edges"), "TERMINAL": ("payoff", "ownerValue")}
            need(type(n) is dict and n.get("kind") in extra, "Y3_NODE_KIND")
            obj(n, common + extra[n["kind"]], ("informationSet",) if n["kind"] == "DECISION" else ())
            identifier(n["id"])
            need(type(n["date"]) is int and n["date"] in (0, 1, 2), "Y3_NODE_DATE")
            need(type(n["state"]) is list and len(n["state"]) == 2 and all(type(x) is int and x in (0, 1) for x in n["state"]), "Y3_PRIVATE_STATE")
            need(type(n["observations"]) is list and len(n["observations"]) <= PROFILE["maxObservationsPerNode"], "Y3_OBSERVATION_BOUND")
            for o in n["observations"]:
                obj(o, ("key", "value", "recipients")); identifier(o["key"])
                need(type(o["value"]) is str and len(o["value"]) <= 4096, "Y3_OBSERVATION_VALUE")
                need(o["key"] in rules, "Y3_UNDECLARED_OBSERVATION")
                need(type(o["recipients"]) is list and 1 <= len(o["recipients"]) <= 3, "Y3_RECIPIENTS")
                unique(o["recipients"], "Y3_DUPLICATE_RECIPIENT")
                need(all(r in rules[o["key"]]["allowedRecipients"] for r in o["recipients"]), "Y3_UNLAWFUL_RECIPIENT")
            need(type(n["resources"]) is dict and len(n["resources"]) <= 128, "Y3_RESOURCE_BOUND")
            for k, v in n["resources"].items():
                identifier(k); rat(v)
            for field in ("payments", "liabilities"):
                need(type(n[field]) is list and len(n[field]) == 2, "Y3_QUANTITY_PAIR")
                for v in n[field]:
                    rat(v)
            if n["kind"] == "TERMINAL":
                need(type(n["payoff"]) is list and len(n["payoff"]) == 2, "Y3_PAYOFF_PAIR")
                for v in n["payoff"] + [n["ownerValue"]]:
                    if v is not None:
                        rat(v)
                continue
            if n["kind"] == "DECISION":
                need(n["participant"] in ("P0", "P1"), "Y3_PARTY_ID")
                if "informationSet" in n:
                    identifier(n["informationSet"])
            if n["kind"] == "PROTOCOL":
                need(n["controlId"] in controls, "Y3_UNDECLARED_CONTROL")
            need(type(n["edges"]) is list and 1 <= len(n["edges"]) <= PROFILE["maxActions"], "Y3_ACTION_BOUND")
            for e in n["edges"]:
                obj(e, ("actionId", "next", "probability") if n["kind"] == "CHANCE" else ("actionId", "next"))
                identifier(e["actionId"]); identifier(e["next"])
            unique([e["actionId"] for e in n["edges"]], "Y3_DUPLICATE_ACTION")
            if n["kind"] == "CHANCE":
                need(n["chanceRole"] in ("PRIOR", "TRANSITION", "SIGNAL"), "Y3_CHANCE_ROLE")
                obj(n["probabilityBasis"], ("population", "conditioning", "identificationRef"))
                text(n["probabilityBasis"]["population"]); text(n["probabilityBasis"]["conditioning"])
                reference(n["probabilityBasis"]["identificationRef"])
                ps = [rat(e["probability"], "Y3_UNIDENTIFIED_CHANCE") for e in n["edges"]]
                need(all(p >= 0 for p in ps) and sum(ps, Q(0)) == 1, "Y3_INVALID_CHANCE_LAW")
            if n["kind"] == "PROTOCOL":
                need(set(controls[n["controlId"]]["options"]) == {e["actionId"] for e in n["edges"]}, "Y3_PROTOCOL_ALPHABET_CHANGED")
        unique([n["id"] for n in model["nodes"]], "Y3_DUPLICATE_NODE")
        nodes = {n["id"]: n for n in model["nodes"]}
        visited = set()
        def tree(nid, date):
            need(nid in nodes, "Y3_MISSING_NODE")
            need(nid not in visited, "Y3_NOT_A_FINITE_TREE")
            visited.add(nid)
            n = nodes[nid]
            need(n["date"] >= date, "Y3_TIME_REVERSAL")
            for e in n.get("edges", []):
                tree(e["next"], n["date"])
        tree(model["root"], 0)
        need(len(visited) == len(nodes), "Y3_DISCONNECTED_TREE")
    unique([m["id"] for m in problem["models"]], "Y3_DUPLICATE_MODEL")

def control_keys(problem):
    keys = {}
    controls = {c["id"]: c for c in problem["controls"]}
    for model in problem["models"]:
        nodes = {n["id"]: n for n in model["nodes"]}
        def visit(nid, public):
            n = nodes[nid]
            pub = public + [{"date": n["date"], "key": o["key"], "value": o["value"], "visibility": "PUBLIC"} for o in n["observations"] if "PUBLIC" in o["recipients"]]
            if n["kind"] == "PROTOCOL":
                key = "K:" + digest({"controlId": n["controlId"], "date": n["date"], "publicObservations": pub})
                keys[key] = {"key": key, "controlId": n["controlId"], "date": n["date"], "publicObservations": pub, "options": controls[n["controlId"]]["options"]}
            for e in n.get("edges", []):
                if n["kind"] != "CHANCE" or rat(e["probability"]) > 0:
                    visit(e["next"], pub)
        visit(model["root"], [])
    return keys

def compile_original(problem, model, policy):
    original = {n["id"]: n for n in model["nodes"]}
    nodes, infos, sequence, used = {}, {}, [], set()
    a_to_l, l_to_a = {}, {}
    def mandatory(delivered, date):
        for rule in problem["observationRules"]:
            if rule["mandatoryByDate"] is not None and rule["mandatoryByDate"] <= date:
                have = delivered.get(rule["key"], set())
                need(all(r in have or r != "PUBLIC" and "PUBLIC" in have for r in rule["allowedRecipients"]), "Y3_MANDATORY_DISCLOSURE_MISSING")
    def visit(nid, obs, public, recall, delivered, chance, depth):
        n = original[nid]
        obs, public = [list(x) for x in obs], list(public)
        sent = {k: set(v) for k, v in delivered.items()}
        for o in n["observations"]:
            token = {"date": n["date"], "key": o["key"], "value": o["value"], "visibility": "PUBLIC" if "PUBLIC" in o["recipients"] else "PRIVATE"}
            if "PUBLIC" in o["recipients"]:
                public.append(token)
            for i in (0, 1):
                if "P" + str(i) in o["recipients"] or "PUBLIC" in o["recipients"]:
                    obs[i].append(token)
            sent.setdefault(o["key"], set()).update(o["recipients"])
        for resource_name, value in n["resources"].items():
            need(resource_name in problem["resourceLimits"], "Y3_UNDECLARED_RESOURCE")
            need(0 <= rat(value) <= known_quantity(problem["resourceLimits"][resource_name]), "Y3_ALL_HISTORY_RESOURCE_LIMIT")
        need(all(rat(v) >= 0 for v in n["liabilities"]), "Y3_NEGATIVE_LIABILITY")
        for i in (0, 1):
            need(abs(rat(n["payments"][i])) <= known_quantity(problem["financialLimits"]["absolutePayments"][i])
                 and rat(n["liabilities"][i]) <= known_quantity(problem["financialLimits"]["liabilities"][i]),
                 "Y3_ALL_HISTORY_FINANCIAL_LIMIT")
        s = {"original": n, "informationKey": None, "controlKey": None, "edges": [], "depth": depth, "chanceReach": chance}
        nodes[nid] = s
        sequence.append(nid)
        if n["kind"] == "TERMINAL":
            mandatory(sent, 2)
            for v in n["payoff"] + [n["ownerValue"]]:
                rat(v, "Y3_UNKNOWN_PAYOFF")
            return
        edges = n["edges"]
        if n["kind"] == "PROTOCOL":
            key = "K:" + digest({"controlId": n["controlId"], "date": n["date"], "publicObservations": public})
            s["controlKey"] = key; used.add(key)
            need(key in policy, "Y3_MISSING_POLICY")
            edges = [e for e in edges if e["actionId"] == policy[key]]
            need(len(edges) == 1, "Y3_INVALID_POLICY")
        if n["kind"] == "DECISION":
            i = int(n["participant"][1])
            key = "I:" + digest({"participant": n["participant"], "date": n["date"], "observations": obs[i], "recall": recall[i]})
            s["informationKey"] = key
            info = infos.setdefault(key, {"id": key, "participant": n["participant"], "date": n["date"], "recall": recall[i], "nodeIds": [], "actionIds": [e["actionId"] for e in edges]})
            need(set(info["actionIds"]) == {e["actionId"] for e in edges}, "Y3_INFORMATION_ACTION_ALPHABET")
            need(info["recall"] == recall[i], "Y3_PERFECT_RECALL")
            need(key not in [r["informationKey"] for r in recall[i]], "Y3_ABSENT_MINDEDNESS")
            info["nodeIds"].append(nid)
            asserted = n["participant"] + ":" + n.get("informationSet", key)
            need(asserted not in a_to_l or a_to_l[asserted] == key, "Y3_ASSERTED_PARTITION_NOT_LAWFUL")
            need(key not in l_to_a or l_to_a[key] == asserted, "Y3_ASSERTED_PARTITION_NOT_LAWFUL")
            a_to_l[asserted] = key; l_to_a[key] = asserted
        for e in edges:
            p = rat(e["probability"]) if n["kind"] == "CHANCE" else Q(1)
            if p == 0:
                continue
            if original[e["next"]]["date"] > n["date"]:
                mandatory(sent, original[e["next"]]["date"] - 1)
            next_recall = [list(x) for x in recall]
            if n["kind"] == "DECISION":
                next_recall[i].append({"informationKey": key, "actionId": e["actionId"]})
            s["edges"].append((e["actionId"], e["next"], p))
            visit(e["next"], obs, public, next_recall, sent, chance * p, depth + 1)
    visit(model["root"], [[], []], [], [[], []], {}, Q(1), 0)
    for participant in ("P0", "P1"):
        if sum(i["participant"] == participant for i in infos.values()) > PROFILE["protocol_horizon_and_deviation_classes"]["maxInformationSetsPerParty"]:
            raise Gap("Y3_INFORMATION_SET_BOUND")
    return {"modelId": model["id"], "root": model["root"], "nodes": nodes, "infos": infos, "sequence": sequence, "used": used}

def assessment(game, strategy, certificate):
    infos, nodes = game["infos"], game["nodes"]
    obj(certificate, ("modelId", "beliefs", "trembles"))
    need(type(certificate["beliefs"]) is dict and set(certificate["beliefs"]) == set(infos), "Y3_BELIEF_DOMAIN")
    need(type(certificate["trembles"]) is dict and set(certificate["trembles"]) == set(infos), "Y3_JOINT_TREMBLE_DOMAIN")
    rates, max_sum = {}, Q(0)
    for key, info in infos.items():
        row = certificate["trembles"][key]
        need(type(row) is dict and set(row) == set(info["actionIds"]), "Y3_TREMBLE_ACTION_DOMAIN")
        total = Q(0)
        rates[key] = {}
        for a, entry in row.items():
            obj(entry, ("order", "coefficient"))
            need(type(entry["order"]) is int and 1 <= entry["order"] <= 9007199254740991, "Y3_TREMBLE_ORDER")
            coefficient = rat(entry["coefficient"])
            need(coefficient > 0, "Y3_TREMBLE_COEFFICIENT")
            rates[key][a] = (entry["order"], coefficient)
            if rat(strategy[key][a]) == 0:
                total += coefficient
        max_sum = max(max_sum, total)
    delta = Q(1) / (Q(2) * (Q(1) + max_sum))
    leading = {game["root"]: (0, Q(1))}
    for nid in game["sequence"]:
        s = nodes[nid]
        order, coefficient = leading[nid]
        for a, child, chance in s["edges"]:
            k, c = order, coefficient * chance
            if s["informationKey"] is not None:
                b = rat(strategy[s["informationKey"]][a])
                if b == 0:
                    extra, multiplier = rates[s["informationKey"]][a]
                    k += extra; c *= multiplier
                else:
                    c *= b
            leading[child] = (k, c)
    beliefs = {}
    for key, info in infos.items():
        row = certificate["beliefs"][key]
        need(type(row) is dict and set(row) == set(info["nodeIds"]), "Y3_BELIEF_NODE_DOMAIN")
        minimum = min(leading[n][0] for n in info["nodeIds"])
        denominator = sum((leading[n][1] for n in info["nodeIds"] if leading[n][0] == minimum), Q(0))
        beliefs[key] = {n: leading[n][1] / denominator if leading[n][0] == minimum else Q(0) for n in info["nodeIds"]}
        for n in info["nodeIds"]:
            need(rat(row[n]) == beliefs[key][n], "Y3_GLOBAL_BELIEF_LIMIT")
    return beliefs, {"delta": str(delta), "sequence": "t_n=delta/(n+1)", "jointInformationSets": len(infos), "exactLeadingOrderLimit": True}

def evaluator(game, strategy, participant, choices=None):
    cache = {}
    def value(nid):
        if nid in cache:
            return cache[nid]
        s = game["nodes"][nid]; n = s["original"]
        if n["kind"] == "TERMINAL":
            result = rat(n["ownerValue"] if participant == "OWNER" else n["payoff"][int(participant[1])])
        elif n["kind"] == "CHANCE":
            result = sum((p * value(child) for _, child, p in s["edges"]), Q(0))
        elif n["kind"] == "PROTOCOL":
            result = value(s["edges"][0][1])
        elif choices is not None and n["participant"] == participant:
            key = s["informationKey"]
            need(key in choices, "Y3_CONTINUATION_ORDER_PREMISE")
            result = value(next(child for a, child, _ in s["edges"] if a == choices[key]))
        else:
            result = sum((rat(strategy[s["informationKey"]][a]) * value(child) for a, child, _ in s["edges"]), Q(0))
        cache[nid] = result
        return result
    return value

def best_continuation(game, strategy, start, beliefs):
    info = game["infos"][start]; participant = info["participant"]
    weights = {nid: Q(0) for nid in game["sequence"]}
    for nid, probability in beliefs.items():
        weights[nid] += probability
    for nid in game["sequence"]:
        weight = weights[nid]
        s = game["nodes"][nid]; n = s["original"]
        for a, child, p in s["edges"]:
            factor = p
            if n["kind"] == "DECISION" and n["participant"] != participant:
                factor *= rat(strategy[s["informationKey"]][a])
            weights[child] += weight * factor
    choices = {}
    optimized = evaluator(game, strategy, participant, choices)
    own_infos = sorted((v for v in game["infos"].values() if v["participant"] == participant), key=lambda i: len(i["recall"]), reverse=True)
    for future in own_infos:
        scores = {}
        for a in future["actionIds"]:
            scores[a] = sum((weights[nid] * optimized(next(child for action, child, _ in game["nodes"][nid]["edges"] if action == a)) for nid in future["nodeIds"]), Q(0))
        choices[future["id"]] = max(future["actionIds"], key=lambda a: scores[a])
    best = sum((mu * optimized(nid) for nid, mu in beliefs.items()), Q(0))
    prescribed_value = evaluator(game, strategy, participant)
    prescribed = sum((mu * prescribed_value(nid) for nid, mu in beliefs.items()), Q(0))
    witness = {k: a for k, a in choices.items() if any(weights[n] > 0 for n in game["infos"][k]["nodeIds"])}
    return {"informationKey": start, "participant": participant, "prescribed": str(prescribed), "best": str(best), "gain": str(best - prescribed), "plan": witness}

def nontrivial(problem, games):
    def interface(model, nid):
        n = index[model["id"]][nid]
        result = [n["kind"], n["date"], n["observations"], n.get("participant"), n.get("controlId")]
        result.append([[e["actionId"], interface(model, e["next"])] for e in n.get("edges", [])])
        return result
    index = {m["id"]: {n["id"]: n for n in m["nodes"]} for m in problem["models"]}
    for model, game in zip(problem["models"], games):
        active = [s["original"] for s in game["nodes"].values()]
        dates = {n["date"] for n in active if n["kind"] == "DECISION"}
        states = {tuple(n["state"]) for n in active}
        material = False
        for n in active:
            if n["kind"] == "PROTOCOL":
                alternatives = [canonical(interface(model, e["next"])) for e in n["edges"]]
                material |= len(set(alternatives)) > 1
        if len(dates) < 2 or len(states) < 2 or not material:
            return False
    return bool(games)

def objective_bound(problem):
    values = [rat(n["ownerValue"], "Y3_UNKNOWN_GOAL_BOUND") for m in problem["models"] for n in m["nodes"] if n["kind"] == "TERMINAL"]
    return max(values)

def inspect(problem, candidate):
    out = {"schema": "finnor.interaction-check.v1", "status": "UNKNOWN", "problemDigest": digest(problem), "profileDigest": PROFILE_DIGEST, "protectedQualification": False, "executionAuthorityGranted": False}
    if candidate is not None:
        out["candidateDigest"] = digest(candidate)
    try:
        schema(problem)
        bound = objective_bound(problem)
        if candidate is None:
            if bound < known_quantity(problem["goal"]["minimumOwnerValue"]):
                out.update(status="INFEASIBLE", reason="Y3_WHOLE_FAMILY_TERMINAL_OWNER_BOUND", upperBound=str(bound))
            else:
                out["reason"] = "Y3_NO_CANDIDATE_NO_ELIMINATION_PROOF"
            return out
        need(type(candidate) is dict, "Y3_CANDIDATE_SHAPE")
        for field in ("schema", "problemDigest", "profileDigest", "policy", "strategy", "models", "objective", "upperBound", "nontrivial"):
            need(field in candidate, "Y3_CANDIDATE_SHAPE")
        need(candidate["schema"] == "finnor.interaction-candidate.v1", "Y3_CANDIDATE_SCHEMA")
        need(candidate["problemDigest"] == out["problemDigest"] and candidate["profileDigest"] == PROFILE_DIGEST, "Y3_CERTIFICATE_BINDING")
        keys = control_keys(problem)
        need(type(candidate["policy"]) is dict and set(candidate["policy"]) == set(keys), "Y3_LAWFUL_POLICY_DOMAIN")
        for k, spec in keys.items():
            need(candidate["policy"][k] in spec["options"], "Y3_POLICY_ALPHABET")
        games = [compile_original(problem, m, candidate["policy"]) for m in problem["models"]]
        out.update(informationValid=True, resourcesValid=True)
        union = {}
        for game in games:
            for k, info in game["infos"].items():
                need(k not in union or set(union[k]["actionIds"]) == set(info["actionIds"]), "Y3_CROSS_MODEL_INFORMATION_ALPHABET")
                union[k] = info
        strategy = candidate["strategy"]
        need(type(strategy) is dict and set(strategy) == set(union), "Y3_STRATEGY_DOMAIN")
        for k, info in union.items():
            need(type(strategy[k]) is dict and set(strategy[k]) == set(info["actionIds"]), "Y3_STRATEGY_ACTION_DOMAIN")
            values = [rat(v) for v in strategy[k].values()]
            need(all(v >= 0 for v in values) and sum(values, Q(0)) == 1, "Y3_STRATEGY_SIMPLEX")
        need(type(candidate["models"]) is list and len(candidate["models"]) == len(games), "Y3_ASSESSMENT_MODELS")
        certs = {c["modelId"]: c for c in candidate["models"]}
        need(len(certs) == len(games) and set(certs) == {m["id"] for m in problem["models"]}, "Y3_ASSESSMENT_MODELS")
        model_reports, all_cases, objectives = [], [], []
        for game in games:
            try:
                beliefs, limit = assessment(game, strategy, certs[game["modelId"]])
            except Rejected:
                out["globalBeliefConsistency"] = False
                raise
            cases = [best_continuation(game, strategy, k, beliefs[k]) for k in game["infos"]]
            values = {p: evaluator(game, strategy, p)(game["root"]) for p in ("P0", "P1", "OWNER")}
            objectives.append(values["OWNER"]); all_cases += cases
            model_reports.append({"modelId": game["modelId"], "limit": limit, "continuations": cases, "expectedUtilities": [str(values["P0"]), str(values["P1"])], "ownerValue": str(values["OWNER"])})
        out.update(models=model_reports, globalBeliefConsistency=True, fullDeviationCoverage=True)
        maximum = max((rat(c["gain"]) for c in all_cases), default=Q(0))
        out["maxRegret"] = str(maximum)
        if maximum > 0:
            out["counterstrategy"] = max(all_cases, key=lambda c: rat(c["gain"]))
            raise Rejected("Y3_PROFITABLE_FULL_CONTINUATION")
        out["participationValid"] = all(rat(report["expectedUtilities"][i]) >= known_quantity(problem["participants"][i]["outsideOption"]) for report in model_reports for i in (0, 1))
        need(out["participationValid"], "Y3_OUTSIDE_OPTION_NOT_MET")
        actual_nontrivial = nontrivial(problem, games)
        out["nontrivial"] = actual_nontrivial
        need(type(candidate["nontrivial"]) is bool and candidate["nontrivial"] == actual_nontrivial, "Y3_NONTRIVIAL_CLAIM")
        need(not problem["goal"]["requireNontrivial"] or actual_nontrivial, "Y3_NONTRIVIAL_REQUIRED")
        objective = min(objectives)
        need(rat(candidate["objective"]) == objective and rat(candidate["upperBound"]) == bound, "Y3_OBJECTIVE_CERTIFICATE")
        need(objective >= known_quantity(problem["goal"]["minimumOwnerValue"]), "Y3_OWNER_GOAL_NOT_MET")
        out.update(status="CHECKED", reason="Y3_EXACT_SEQUENTIAL_ASSESSMENT", objective=str(objective), upperBound=str(bound))
    except Rejected as error:
        out.update(status="REJECTED", reason=str(error))
    except (Gap, MemoryError, RecursionError) as error:
        out.update(status="UNKNOWN", reason=str(error) or "Y3_PROCESS_RESOURCE_BOUND")
    return out

def reject_constants(value):
    raise ValueError("Y3_NON_JSON_NUMBER")

def unique_object(pairs):
    result = {}
    for k, v in pairs:
        if k in result:
            raise ValueError("Y3_DUPLICATE_JSON_KEY")
        result[k] = v
    return result

def configure_limits():
    memory = PROFILE["maxProcessMemoryBytes"]
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    cpu = max(1, (PROFILE["maxProcessWallMs"] + 999) // 1000)
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    resource.setrlimit(resource.RLIMIT_FSIZE, (PROFILE["maxProcessOutputBytes"], PROFILE["maxProcessOutputBytes"]))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    sys.setrecursionlimit(10000)

def main():
    configure_limits()
    maximum = PROFILE["maxRequestBytes"] + PROFILE["maxArtifactBytes"] + 65536
    raw = sys.stdin.buffer.read(maximum + 1)
    need(len(raw) <= maximum, "Y3_PROCESS_INPUT_BOUND")
    request = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constants)
    obj(request, ("problem", "candidate"))
    out = inspect(request["problem"], request["candidate"])
    usage = resource.getrusage(resource.RUSAGE_SELF)
    out.update(wallMs=int((time.monotonic() - START) * 1000), cpuMs=int((usage.ru_utime + usage.ru_stime) * 1000), peakRssBytes=usage.ru_maxrss * 1024, checkerDigest=hashlib.sha256(open(__file__, "rb").read()).hexdigest())
    result = canonical(out).encode()
    need(len(result) <= PROFILE["maxProcessOutputBytes"], "Y3_PROCESS_OUTPUT_BOUND")
    sys.stdout.buffer.write(result)

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stdout.write(canonical({"schema": "finnor.interaction-check.v1", "status": "UNKNOWN", "reason": str(error)[:256] or "Y3_PROCESS_FAILURE", "protectedQualification": False, "executionAuthorityGranted": False}))
