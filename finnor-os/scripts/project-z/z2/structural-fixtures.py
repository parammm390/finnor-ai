"""Public original-model families. No producer, checker or LP imports."""
import copy
from fractions import Fraction as F
import hashlib
import itertools
import json


NAMES = [
    "early-report-late-action", "adjacent-message-chain", "hub-spoke-bypass",
    "simultaneous-reports-public-disclosure", "alternating-report-intervening-chance",
    "public-correlation-without-private-disclosure", "asymmetric-private-signals",
    "conditionally-independent-common-latent", "nested-partitions-persistent-recall",
    "linked-offpath-global-tremble", "zero-and-rare-support", "delayed-evidence-before-commitment",
    "early-commitment-local-acquisition", "mandatory-public-disclosure", "directed-private-channel",
    "two-communication-rounds", "profitable-mixture-no-profitable-pure",
    "whole-original-family-outside-grid", "triple-profitable-proper-pairs-stable",
    "overlapping-proper-and-grand-coalitions", "conserved-legal-transfer-budget",
    "transfer-constraints-distinct-outside-options", "utility-scales-weak-indifference",
    "admitted-models-different-support", "admitted-models-different-utilities",
    "opt-out-before-after-public-signal", "stable-individually-unacceptable",
    "later-chance-two-local-actions", "authorized-policy-topology",
    "complete-no-stable-candidate-family", "shared-s5-resource-constraint",
    "unresolved-s6-observation-history",
]


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def ref(name):
    return {"owner": "PUBLIC_STRUCTURAL_DEVELOPMENT", "id": name, "version": "1", "contentDigest": digest(name)}


def basis(name):
    return {"unit": name, "currency": None, "timeBasis": "three-original-dates", "owner": name,
            "rounding": "EXACT", "sourceStatus": "SUPPLIED_MODEL", "sourceRef": ref(name)}


def quantity(value, unit):
    return {"value": str(value), "basis": basis(unit)}


def build(family, case):
    assert 1 <= family <= 32 and 0 <= case < 8
    n = 3 if family in (2, 7, 15, 19, 22, 25) else 4 if family in (3, 20) else 2
    parties = ["P"+str(i) for i in range(n)]
    title = NAMES[family-1]
    model_ref = ref(title+"-model-"+str(case))
    problem = {
        "schema": "finnor.interaction-problem.v1", "id": title+"-"+str(case), "title": title,
        "participants": [{"id": p, "principalId": "20000000-0000-4000-8000-"+str(i+1).zfill(12),
                          "outsideOption": quantity("0", p+"-utility")} for i, p in enumerate(parties)],
        "dates": ["2026-10-24T00:00:00Z", "2026-10-24T00:00:01Z", "2026-10-24T00:00:02Z"],
        "fixedOperatorRefs": [ref(title+"-fixed-lawful-operators")], "actorModelRefs": [model_ref],
        "quantityBasis": {"utilities": [basis(p+"-utility") for p in parties], "ownerValue": basis("institution-readiness")},
        "financialLimits": {
            "absolutePayments": [quantity(0, p+"-payments") for p in parties],
            "liabilities": [quantity(0, p+"-liabilities") for p in parties],
            "semantics": "SIGNED_NODE_SNAPSHOTS_NO_IMPLICIT_NETTING_OR_UTILITY_CONVERSION"
        },
        "observationRules": [], "controls": [
            {"id": "evidence-route", "kind": "COMMITMENT_TIMING", "options": ["unverified", "authorized"]}
        ], "models": [], "resourceLimits": {"capacity": quantity(1, "capacity")},
        "goal": {"minimumOwnerValue": quantity(1, "institution-readiness"), "requireNontrivial": True},
    }
    if family == 22:
        for i, p in enumerate(problem["participants"]):
            p["outsideOption"]["value"] = str(F(i+1, n+1))
    if family == 27:
        for p in problem["participants"]:
            p["outsideOption"]["value"] = "1"
    if family in (21, 22):
        cap = "1" if family == 21 else "1/2"
        for p in parties[:2]:
            problem["financialLimits"]["absolutePayments"][parties.index(p)] = quantity(cap, p+"-payments")
    rules = {}

    def observation(key, value, recipients, date, mandatory=None, classification="MODEL_RELATIVE_STATEMENT"):
        if key not in rules:
            rules[key] = {"key": key, "allowedRecipients": list(recipients), "mandatoryByDate": mandatory,
                          "classification": classification, "sourceRef": model_ref}
        else:
            assert rules[key]["allowedRecipients"] == list(recipients)
        return {"key": key, "value": str(value), "recipients": list(recipients)}

    # Public obligation families include economic and constraint variants.
    # Their labels do not by themselves establish distinct topology.
    steps = [(p, min(i, 2), ["ready", "withhold"]) for i, p in enumerate(parties)]
    if n == 2:
        steps += [("P0", 2, ["confirm", "withdraw"])]
    else:
        steps += [("P0", 2, ["confirm"])]
    if family == 4:
        steps = [("P0", 0, ["ready", "withhold"]), ("P1", 0, ["ready", "withhold"]),
                 ("P1", 1, ["acknowledge"]), ("P0", 2, ["confirm"])]
    if family in (5, 8, 28):
        steps[-1] = ("P0", 2, ["confirm"])
    if family == 16:
        steps = [("P0", 0, ["send", "silent"]), ("P1", 1, ["reply", "silent"]),
                 ("P0", 1, ["acknowledge", "silent"]), ("P1", 2, ["confirm"])]
    if family in (17, 18):
        steps = [("P0", 0, ["coordinate", "stay"]), ("P1", 1, ["join", "decline"]),
                 ("P0", 2, ["left", "right"])]
    if family == 23:
        steps[-1] = ("P0", 2, ["confirm", "equivalent-confirm"])
    if family == 26:
        steps[0] = ("P0", 0, ["enter", "opt-out"])
        steps[1] = ("P1", 1, ["join", "opt-out"])
    if family == 29:
        problem["controls"].append({"id": "communication-timing", "kind": "DISCLOSURE", "options": ["now", "later"]})
    if family == 30:
        problem["goal"]["requireNontrivial"] = False

    def model(model_id, model_number=0):
        nodes = []

        def add(kind, date, state, **fields):
            nid = model_id+"-"+str(len(nodes))
            private_state = [(state+i) % 2 for i in range(n)]
            # A support-restricted model can still have actual state transitions.
            if family == 24 and date > 0:
                private_state = [1-x for x in private_state]
            node = {"id": nid, "kind": kind, "date": date, "state": private_state, "observations": [],
                    "resources": {"capacity": "1"}, "payments": ["0"]*n, "liabilities": ["0"]*n}
            node.update(fields)
            nodes.append(node)
            return node

        def payoff(actions, authorized):
            primary = []
            for p in parties:
                own = [(k, a) for k, a in enumerate(actions) if steps[k][0] == p]
                relevant = [(k, a) for k, a in own if len(steps[k][2]) > 1 and k < n]
                primary.append(bool(relevant) and all(a == steps[k][2][0] for k, a in relevant))
            if authorized:
                values = [F(2+model_number if family == 25 else 2) if c else F(0) for c in primary]
                if family == 16:
                    values = [F(2*sum(a == steps[k][2][0] for k, a in enumerate(actions)
                                     if steps[k][0] == p and len(steps[k][2]) > 1)) for p in parties]
                if family == 23:
                    values = [10*values[0], values[1]/3]
            elif family in (17, 18):
                early, later, last = actions[:3]
                values = [F(x) for x in (
                    (4, -2) if last == "left" else (-1, 1)
                )] if early == "coordinate" and later == "join" else [
                    F(x) for x in ((-1, 0) if early == "coordinate" else (0, -1) if later == "join" else (0, 0))]
            elif family == 19:
                values = [F(2 if all(primary) else 0 if c else 1) for c in primary]
            elif family == 20:
                values = [F(2 if c and (primary[(i-1) % n] or primary[(i+1) % n])
                            else 0 if c else 1) for i, c in enumerate(primary)]
            elif family == 27:
                values = [F(0)]*n
            else:
                values = [F(1 + 2*sum(primary[j] for j in range(n) if j != i) - int(c)) for i, c in enumerate(primary)]
            if family not in (16, 17, 18, 23) and len(steps[-1][2]) > 1 and actions[-1] == "withdraw":
                values[0] -= 1
            return [str(v) for v in values]

        def terminal(state, actions, authorized):
            result = add("TERMINAL", 2, state, payoff=payoff(actions, authorized), ownerValue="2")
            if family in (21, 22) and actions[0] == steps[0][2][0]:
                transfer = F(1) if family == 21 else F(1, 2)
                result["payments"][:2] = [str(transfer), str(-transfer)]
            if family == 32:
                result["observations"].append(observation("s6-outcome-status", "UNKNOWN", ["PUBLIC"], 2,
                                                          classification="UNRESOLVED_CLAIM"))
            return result["id"]

        def play(route, state, signals, index=0, actions=(), transitioned=False, timed=False):
            authorized = route == "authorized" and family != 30
            if index == len(steps):
                if family == 18:
                    chance = add("CHANCE", 2, state, chanceRole="SIGNAL",
                                 probabilityBasis={"population": "public-development", "conditioning": "after-actions",
                                                   "identificationRef": model_ref}, edges=[])
                    for s in (0, 1):
                        target = terminal(s, actions, authorized)
                        nodes[-1]["observations"].append(observation("post-action-private", s, ["P0"], 2))
                        chance["edges"].append({"actionId": "s"+str(s), "next": target, "probability": "1/2"})
                    return chance["id"]
                return terminal(state, actions, authorized)
            party, date, alphabet = steps[index]
            if family in (5, 28) and index == 1 and not transitioned:
                chance = add("CHANCE", 1, state, chanceRole="TRANSITION",
                             probabilityBasis={"population": "public-development", "conditioning": "after-early-action",
                                               "identificationRef": model_ref}, edges=[])
                for bit in (0, 1):
                    target = play(route, bit, {**signals, "transition": bit}, index, actions, True, timed)
                    chance["edges"].append({"actionId": "transition"+str(bit), "next": target, "probability": "1/2"})
                return chance["id"]
            if family == 29 and index == 1 and not timed:
                control = add("PROTOCOL", date, state, controlId="communication-timing", edges=[])
                for option in ("now", "later"):
                    target = play(route, state, {**signals, "timing": option}, index, actions, transitioned, True)
                    control["edges"].append({"actionId": option, "next": target})
                return control["id"]
            node = add("DECISION", date, state, participant=party, edges=[])
            if index == 0 and family not in (6, 13, 16, 18):
                node["observations"].append(observation("local-state-P0", signals.get("P0", state), ["P0"], date))
            if family in (7, 8) and party != "P0" and index < n:
                node["observations"].append(observation("local-signal-"+party, signals.get(party, 0), [party], date))
            if family == 16 and party == "P1" and index == 1:
                node["observations"].append(observation("reply-private-signal", state, ["P1"], date))
            if family == 6 and index == 0:
                node["observations"].append(observation("public-correlation", state, ["PUBLIC"], date))
            if family == 13 and index == 1:
                node["observations"].append(observation("acquired-after-commitment", state, ["P1"], date))
            if family in (5, 28) and index == 1:
                recipients = ["P1"] if family == 5 else ["PUBLIC"]
                node["observations"].append(observation("later-transition", signals["transition"], recipients, date))
            if authorized and (index == (1 if family in (12, 14) else 0)):
                node["observations"].append(observation("authorized-evidence", "verified", ["PUBLIC"], date,
                                                       mandatory=1 if family == 14 else None))
            if family == 14 and "authorized-evidence" not in rules:
                observation("authorized-evidence", "verified", ["PUBLIC"], 1, mandatory=1)
            if family == 2 and 0 < index < n:
                node["observations"].append(observation("adjacent-message-"+str(index), actions[index-1], [party], date))
            if family == 3 and index in (1, 3):
                node["observations"].append(observation("hub-message-"+str(index), actions[0], [party], date))
            if family in (9, 10) and index == 1:
                node["observations"].append(observation("early-public-report", actions[0], ["PUBLIC"], date))
            if family == 9 and index == 1:
                coarse = state//2 if actions[0] == steps[0][2][0] else "withheld"
                node["observations"].append(observation("coarse-nested-signal", coarse, ["P1"], date))
            if family == 4 and index == 2:
                node["observations"].append(observation("joint-reports-disclosure", "|".join(actions), ["PUBLIC"], date))
            if family == 15 and index == 1:
                node["observations"].append(observation("directed-message", actions[0], ["P1"], date))
            if family == 16 and 0 < index < 3:
                node["observations"].append(observation("communication-round-"+str(index), actions[index-1], [party], date))
            if family == 26 and index == 1:
                node["observations"].append(observation("opt-out-public-signal", state, ["PUBLIC"], date))
            if family == 29 and index == 1:
                node["observations"].append(observation("selected-communication-time", signals["timing"], ["PUBLIC"], date))
            if family == 31 and not authorized:
                node["resources"]["capacity"] = "2"
            for action in alphabet:
                if family == 26 and action == "opt-out":
                    target = add("TERMINAL", date, state, payoff=["0"]*n, ownerValue="0")["id"]
                elif family == 13 and index == 0:
                    chance = add("CHANCE", 1, state, chanceRole="SIGNAL",
                                 probabilityBasis={"population": "public-development", "conditioning": "after-commitment",
                                                   "identificationRef": model_ref}, edges=[])
                    for bit in (0, 1):
                        target = play(route, bit, signals, index+1, actions+(action,))
                        chance["edges"].append({"actionId": "acquire"+str(bit), "next": target, "probability": "1/2"})
                    target = chance["id"]
                else:
                    target = play(route, state, signals, index+1, actions+(action,), transitioned, timed)
                node["edges"].append({"actionId": action, "next": target})
            return node["id"]

        def route(route_name):
            if family == 18:
                return play(route_name, 0, {})
            if family == 8:
                latent = add("CHANCE", 0, 0, chanceRole="PRIOR",
                             probabilityBasis={"population": "public-development", "conditioning": "ex-ante-common-latent",
                                               "identificationRef": model_ref}, edges=[])
                for state in (0, 1):
                    first = add("CHANCE", 0, state, chanceRole="SIGNAL",
                                probabilityBasis={"population": "public-development", "conditioning": "latent-state",
                                                  "identificationRef": model_ref}, edges=[])
                    latent["edges"].append({"actionId": "latent"+str(state), "next": first["id"], "probability": "1/2"})
                    for s0 in (0, 1):
                        second = add("CHANCE", 0, state, chanceRole="SIGNAL",
                                     probabilityBasis={"population": "public-development", "conditioning": "conditionally-independent-signal",
                                                       "identificationRef": model_ref}, edges=[])
                        first["edges"].append({"actionId": "signal0-"+str(s0), "next": second["id"],
                                               "probability": "2/3" if s0 == state else "1/3"})
                        for s1 in (0, 1):
                            target = play(route_name, state, {"P0": s0, "P1": s1})
                            second["edges"].append({"actionId": "signal1-"+str(s1), "next": target,
                                                    "probability": "2/3" if s1 == state else "1/3"})
                return latent["id"]
            prior = add("CHANCE", 0, 0, chanceRole="PRIOR",
                        probabilityBasis={"population": "public-development", "conditioning": "ex-ante",
                                          "identificationRef": model_ref}, edges=[])
            p0 = F(case+1, case+3)
            if family == 11:
                p0 = F(1, 2**(case+8))
            if family == 24 and model_number:
                p0 = F(1)
            if family == 9:
                remaining = add("CHANCE", 0, 0, chanceRole="PRIOR",
                                probabilityBasis={"population": "public-development", "conditioning": "remaining-nested-signal",
                                                  "identificationRef": model_ref}, edges=[])
                first = play(route_name, 0, {"P0": 0, "P1": 0})
                prior["edges"] = [{"actionId": "state0", "next": first, "probability": str(p0)},
                                  {"actionId": "remaining", "next": remaining["id"], "probability": str(1-p0)}]
                for state in (1, 2):
                    target = play(route_name, state, {"P0": state, "P1": 0})
                    remaining["edges"].append({"actionId": "state"+str(state), "next": target, "probability": "1/2"})
                return prior["id"]
            outcomes = ((0, p0), (1, 1-p0))
            for state, probability in outcomes:
                target = play(route_name, state, {"P0": state, "P1": state if family == 8 else 0})
                prior["edges"].append({"actionId": "state"+str(state), "next": target, "probability": str(probability)})
            if family == 11:
                zero = add("CHANCE", 0, 0, chanceRole="PRIOR",
                           probabilityBasis={"population": "public-development", "conditioning": "zero-support-branch",
                                             "identificationRef": model_ref}, edges=[])
                dead = add("TERMINAL", 0, 0, payoff=["-7"]*n, ownerValue="0")
                zero["edges"] = [{"actionId": "supported", "next": prior["id"], "probability": "1"},
                                 {"actionId": "zero", "next": dead["id"], "probability": "0"}]
                return zero["id"]
            return prior["id"]

        control = add("PROTOCOL", 0, 0, controlId="evidence-route", edges=[])
        for name in ("unverified", "authorized"):
            control["edges"].append({"actionId": name, "next": route(name)})
        return {"id": model_id, "qualificationRef": model_ref, "root": control["id"], "nodes": nodes}

    problem["models"] = [model("m0")]
    if family in (24, 25):
        problem["models"].append(model("m1", 1))
        problem["actorModelRefs"].append(ref(title+"-second-model-"+str(case)))
    problem["observationRules"] = list(rules.values())
    return problem


def structural_fingerprint(problem):
    # Legacy literal-sensitive input digest, not an isomorphism invariant or
    # structural qualification. Names and exact payoff amounts are retained.
    models = []
    for model in problem["models"]:
        tree = {n["id"]: n for n in model["nodes"]}

        def walk(nid):
            n = tree[nid]
            result = {"kind": n["kind"], "date": n["date"], "participant": n.get("participant"),
                      "observations": [(o["key"], o["recipients"]) for o in n["observations"]],
                      "resources": n["resources"], "payments": n["payments"]}
            if n["kind"] == "TERMINAL":
                result["payoff"] = n["payoff"]
            result["edges"] = [(e["actionId"], walk(e["next"])) for e in n.get("edges", [])]
            return result
        models.append(walk(model["root"]))
    return digest({"parties": len(problem["participants"]), "models": models,
                   "outside": [p["outsideOption"]["value"] for p in problem["participants"]],
                   "mandatory": [(r["key"], r["mandatoryByDate"]) for r in problem["observationRules"]]})


def registration():
    families = [{"family": i, "name": name, "structuralFingerprint": structural_fingerprint(build(i, 0)),
                 "cases": [digest(build(i, case)) for case in range(8)]} for i, name in enumerate(NAMES, 1)]
    return {"schema": "finnor.project-z.z2.public-structural-registration.v1", "families": families,
            "familyCount": len(families), "freshCasesPerFamily": 8, "protectedCases": False,
            "structuralFingerprintIsQualification": False, "qualifiedStructuralFamilyCount": None,
            "structuralQualification": "REQUIRES_INDEPENDENT_LABEL_FREE_CANONICAL_AUDIT",
            "intendedPositiveCases": 31*8, "intendedImpossibleCases": 8}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--family", type=int)
    parser.add_argument("--case", type=int, default=0)
    args = parser.parse_args()
    print(canonical(build(args.family, args.case) if args.family else registration()))
