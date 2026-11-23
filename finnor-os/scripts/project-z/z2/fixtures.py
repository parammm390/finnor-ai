"""Public process-E2E inputs, fixed before Z2 product implementation."""
import copy
import hashlib
import json


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def reference(name):
    return {"owner": "PUBLIC_DEVELOPMENT", "id": name, "version": "1", "contentDigest": digest(name)}


def basis(name):
    return {"unit": name, "currency": None, "timeBasis": "three-original-dates", "owner": name,
            "rounding": "EXACT", "sourceStatus": "SUPPLIED_MODEL", "sourceRef": reference(name)}


def quantity(value, name):
    return {"value": str(value), "basis": basis(name)}


def problem(kind="dynamic", seed=0):
    model_ref = reference("supplied-model-" + str(seed))
    result = {
        "schema": "finnor.interaction-problem.v1", "id": kind + "-" + str(seed),
        "title": "Public synthetic institutional readiness, not a business Work",
        "participants": [
            {"id": "P0", "principalId": "10000000-0000-4000-8000-000000000001", "outsideOption": quantity(-10, "P0-utility")},
            {"id": "P1", "principalId": "10000000-0000-4000-8000-000000000002", "outsideOption": quantity(-10, "P1-utility")}
        ],
        "dates": ["2026-10-24T00:00:00Z", "2026-10-24T00:00:01Z", "2026-10-24T00:00:02Z"],
        "fixedOperatorRefs": [reference("already-admitted-readiness-operators")],
        "actorModelRefs": [model_ref],
        "quantityBasis": {"utilities": [basis("P0-utility"), basis("P1-utility")], "ownerValue": basis("readiness-value")},
        "financialLimits": {
            "absolutePayments": [quantity(0, "payments-P0"), quantity(0, "payments-P1")],
            "liabilities": [quantity(0, "liability-P0"), quantity(0, "liability-P1")],
            "semantics": "SIGNED_NODE_SNAPSHOTS_NO_IMPLICIT_NETTING_OR_UTILITY_CONVERSION"
        },
        "observationRules": [
            {"key": "private-state", "allowedRecipients": ["P0"], "mandatoryByDate": None,
             "classification": "MODEL_RELATIVE_STATEMENT", "sourceRef": model_ref},
            {"key": "authorized-evidence", "allowedRecipients": ["PUBLIC"], "mandatoryByDate": None,
             "classification": "MODEL_RELATIVE_STATEMENT", "sourceRef": model_ref}
        ],
        "controls": [] if kind in ("impossible", "mixture") else [
            {"id": "evidence-commitment", "kind": "COMMITMENT_TIMING", "options": ["unverified", "authorized"]}
        ],
        "models": [], "resourceLimits": {"capacity": quantity(1, "capacity")},
        "goal": {"minimumOwnerValue": quantity(1, "readiness-value"), "requireNontrivial": kind == "dynamic"}
    }
    nodes = []

    def add(nid, date, state, kind_, **fields):
        n = {"id": nid, "date": date, "state": [state, 1-state], "kind": kind_,
             "observations": [], "resources": {"capacity": "1"}, "payments": ["0", "0"], "liabilities": ["0", "0"]}
        n.update(fields)
        nodes.append(n)
        return n

    routes = ["unverified"] if kind in ("impossible", "mixture") else ["unverified", "authorized"]
    for route in routes:
        prior_id = route + "-prior"
        add(prior_id, 0, 0, "CHANCE", chanceRole="PRIOR",
            probabilityBasis={"population": "public-synthetic", "conditioning": "ex-ante", "identificationRef": model_ref},
            edges=[{"actionId": "s0", "next": route+"-s0", "probability": "1/2"},
                   {"actionId": "s1", "next": route+"-s1", "probability": "1/2"}])
        for state in (0, 1):
            a0 = ["coordinate", "stay"] if kind == "mixture" else ["ready", "withhold"]
            a1 = ["join", "decline"] if kind == "mixture" else ["commit", "decline"]
            a2 = ["left", "right"] if kind == "mixture" else ["confirm", "withdraw"]
            nid = route + "-s" + str(state)
            root = add(nid, 0, state, "DECISION", participant="P0",
                       edges=[{"actionId": a, "next": nid+"-"+a} for a in a0])
            root["observations"] = [{"key": "private-state", "value": str(state), "recipients": ["P0"]}]
            if route == "authorized":
                root["observations"].append({"key": "authorized-evidence", "value": "verified", "recipients": ["PUBLIC"]})
            for early in a0:
                mid = nid + "-" + early
                add(mid, 1, state, "DECISION", participant="P1",
                    edges=[{"actionId": a, "next": mid+"-"+a} for a in a1])
                for later in a1:
                    final = mid+"-"+later
                    add(final, 2, state, "DECISION", participant="P0",
                        edges=[{"actionId": a, "next": final+"-"+a} for a in a2])
                    for last in a2:
                        if kind == "mixture":
                            payoff = ((4, -2) if last == "left" else (-1, 1)) if early == "coordinate" and later == "join" else (
                                (-1, 0) if early == "coordinate" else (0, -1) if later == "join" else (0, 0))
                        elif route == "authorized":
                            payoff = (2 if early == "ready" else 0, 2 if later == "commit" else 0)
                        else:
                            payoff = {("ready", "commit"): (2, 2), ("ready", "decline"): (-1, 3),
                                      ("withhold", "commit"): (3, -1), ("withhold", "decline"): (1, 1)}[(early, later)]
                        if kind != "mixture" and last == "withdraw":
                            payoff = (payoff[0]-1, payoff[1])
                        add(final+"-"+last, 2, state, "TERMINAL", payoff=[str(x) for x in payoff], ownerValue="2")
    if len(routes) == 2:
        add("root-control", 0, 0, "PROTOCOL", controlId="evidence-commitment",
            edges=[{"actionId": route, "next": route+"-prior"} for route in routes])
        root_id = "root-control"
    else:
        root_id = routes[0]+"-prior"
    result["models"] = [{"id": "m0", "qualificationRef": model_ref, "root": root_id, "nodes": nodes}]
    return result


def cases():
    result = []
    for seed in range(8):
        result.append({"id": "dynamic-"+str(seed), "problem": problem("dynamic", seed), "expected": "CHECKED_CANDIDATE"})
        result.append({"id": "impossible-"+str(seed), "problem": problem("impossible", seed), "expected": "CHECKED_INFEASIBLE"})
        result.append({"id": "mixture-"+str(seed), "problem": problem("mixture", seed), "expected": "INCOMPLETE"})
        goal = problem("dynamic", seed)
        goal["goal"]["minimumOwnerValue"]["value"] = "3"
        result.append({"id": "owner-bound-"+str(seed), "problem": goal, "expected": "CHECKED_INFEASIBLE"})
    return result
