"""Original-tree certificate checker. No Z2 producer, LP or compiled-plan imports."""
import itertools
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (Q, PROFILE, PROFILE_DIGEST, rat, need, digest, canonical, load_native,
                    guard_problem, guard_candidate, check_deadline, Rejected, Incomplete,
                    Unsupported, read_request, emit)


def original_policy_family(problem):
    controls = {c["id"]: c["options"] for c in problem["controls"]}
    domain = {}
    for model in problem["models"]:
        tree = {n["id"]: n for n in model["nodes"]}

        def visit(nid, public):
            n = tree[nid]
            public = public + [{"date": n["date"], "key": o["key"], "value": o["value"], "visibility": "PUBLIC"}
                               for o in n["observations"] if "PUBLIC" in o["recipients"]]
            if n["kind"] == "PROTOCOL":
                key = "K:"+digest({"controlId": n["controlId"], "date": n["date"], "publicObservations": public})
                domain[key] = controls[n["controlId"]]
            for e in n.get("edges", []):
                if n["kind"] != "CHANCE" or rat(e["probability"]) > 0:
                    visit(e["next"], public)
        visit(model["root"], [])
    keys = sorted(domain)
    count = 1
    for k in keys:
        count *= len(domain[k])
    if count > PROFILE["maxCandidatePolicies"]:
        raise Unsupported("Z2_ORIGINAL_POLICY_BOUND")
    return [dict(zip(keys, row)) for row in itertools.product(*(domain[k] for k in keys))]


def reconstruct(problem, model, policy):
    parties = [p["id"] for p in problem["participants"]]
    original = {n["id"]: n for n in model["nodes"]}
    states, infos = {}, {}

    def visit(nid, observed, public, recalled):
        n = original[nid]
        observed = {p: list(v) for p, v in observed.items()}
        public = list(public)
        for o in n["observations"]:
            token = {"date": n["date"], "key": o["key"], "value": o["value"],
                     "visibility": "PUBLIC" if "PUBLIC" in o["recipients"] else "PRIVATE"}
            if "PUBLIC" in o["recipients"]:
                public.append(token)
            for p in parties:
                if p in o["recipients"] or "PUBLIC" in o["recipients"]:
                    observed[p].append(token)
        state = {"original": n, "children": [], "local": None}
        states[nid] = state
        if n["kind"] == "TERMINAL":
            return
        edges = n["edges"]
        if n["kind"] == "PROTOCOL":
            control = "K:"+digest({"controlId": n["controlId"], "date": n["date"], "publicObservations": public})
            need(control in policy, "Z2_ORIGINAL_POLICY_DOMAIN")
            edges = [e for e in edges if e["actionId"] == policy[control]]
            need(len(edges) == 1, "Z2_ORIGINAL_POLICY_ACTION")
        if n["kind"] == "DECISION":
            p = n["participant"]
            local = "I:"+digest({"participant": p, "date": n["date"], "observations": observed[p], "recall": recalled[p]})
            state["local"] = local
            actions = [e["actionId"] for e in edges]
            info = infos.setdefault(local, {"party": p, "actions": actions, "nodes": []})
            need(info["party"] == p and info["actions"] == actions, "Z2_ORIGINAL_LOCAL_ALPHABET")
            info["nodes"].append(nid)
        for e in edges:
            chance = rat(e["probability"]) if n["kind"] == "CHANCE" else Q(1)
            if chance == 0:
                continue
            recall = {p: list(v) for p, v in recalled.items()}
            if n["kind"] == "DECISION":
                recall[n["participant"]].append({"informationKey": state["local"], "actionId": e["actionId"]})
            state["children"].append((e["actionId"], e["next"], chance))
            visit(e["next"], observed, public, recall)
    visit(model["root"], {p: [] for p in parties}, [], {p: [] for p in parties})
    if len(infos) > PROFILE["maxInformationSets"]:
        raise Unsupported("Z2_ORIGINAL_INFORMATION_BOUND")
    return {"id": model["id"], "root": model["root"], "states": states, "infos": infos}


def complete_local_plans(game, coalition):
    domain = sorted((k, i["actions"]) for k, i in game["infos"].items() if i["party"] in coalition)
    count = 1
    for _, actions in domain:
        count *= len(actions)
    if count > PROFILE["maxPureJointPlans"]:
        raise Unsupported("Z2_ORIGINAL_JOINT_PLAN_BOUND")
    return [dict(zip((k for k, _ in domain), row)) for row in itertools.product(*(a for _, a in domain))]


def expected(game, strategy, party, deviation, start=None):
    cache = {}

    def evaluate(nid):
        if nid in cache:
            return cache[nid]
        state = game["states"][nid]
        n, edges = state["original"], state["children"]
        if n["kind"] == "TERMINAL":
            result = rat(n["payoff"][int(party[1])])
        elif n["kind"] == "CHANCE":
            result = sum((chance*evaluate(child) for _, child, chance in edges), Q(0))
        elif n["kind"] == "PROTOCOL":
            result = evaluate(edges[0][1])
        elif state["local"] in deviation:
            result = evaluate(next(child for action, child, _ in edges if action == deviation[state["local"]]))
        else:
            result = sum((rat(strategy[state["local"]][action])*evaluate(child) for action, child, _ in edges), Q(0))
        cache[nid] = result
        return result
    return evaluate(start or game["root"])


def reconstructed_gains(game, strategy, coalition, deadline):
    plans = complete_local_plans(game, coalition)
    baseline = [expected(game, strategy, p, {}) for p in coalition]
    columns = []
    for plan in plans:
        check_deadline(deadline)
        columns.append([expected(game, strategy, p, plan)-base for p, base in zip(coalition, baseline)])
    return plans, columns


def dual(game, strategy, coalition, witness, deadline):
    plans, columns = reconstructed_gains(game, strategy, coalition, deadline)
    need(witness.get("kind") == "NO_PROFIT_DUAL", "Z2_DUAL_REQUIRED")
    need(witness.get("planCount") == len(plans) and witness.get("planDigest") == digest(plans)
         and witness.get("gainsDigest") == digest([[str(v) for v in row] for row in columns]), "Z2_ORIGINAL_PLAN_COVERAGE")
    need(type(witness.get("lambda")) is list and len(witness["lambda"]) == len(coalition), "Z2_DUAL_DIMENSION")
    multipliers, nu = [rat(v) for v in witness["lambda"]], rat(witness["nu"])
    need(all(v >= 0 for v in multipliers) and nu <= 0, "Z2_DUAL_SIGNS")
    for row in columns:
        need(nu >= sum(((Q(1)+lam)*gain for lam, gain in zip(multipliers, row)), Q(0)),
             "Z2_ORIGINAL_DUAL_INEQUALITY")
    return {"modelId": game["id"], "coalition": coalition, "planCount": len(plans),
            "planDigest": digest(plans), "allOriginalInequalities": True}


def primal(game, strategy, coalition, witness, deadline):
    need(witness.get("kind") == "PROFITABLE_MIXTURE", "Z2_PRIMAL_REQUIRED")
    domain = {k: i for k, i in game["infos"].items() if i["party"] in coalition}
    terms = witness.get("terms")
    need(type(terms) is list and 0 < len(terms) <= PROFILE["maxPureJointPlans"], "Z2_PRIMAL_SUPPORT")
    total, gains = Q(0), [Q(0)]*len(coalition)
    baseline = [expected(game, strategy, p, {}) for p in coalition]
    for term in terms:
        check_deadline(deadline)
        need(type(term) is dict and set(term) == {"plan", "probability"}, "Z2_PRIMAL_TERM")
        plan, weight = term["plan"], rat(term["probability"])
        need(weight > 0, "Z2_PRIMAL_PROBABILITY")
        need(type(plan) is dict and set(plan) == set(domain), "Z2_LOCAL_PLAN_DOMAIN")
        need(all(plan[k] in i["actions"] for k, i in domain.items()), "Z2_LOCAL_PLAN_ALPHABET")
        total += weight
        for i, p in enumerate(coalition):
            gains[i] += weight*(expected(game, strategy, p, plan)-baseline[i])
    need(total == 1, "Z2_PRIMAL_SIMPLEX")
    need(all(v >= 0 for v in gains) and sum(gains, Q(0)) > 0, "Z2_NO_PROFITABLE_MIXTURE")
    need(witness.get("gains") == [str(v) for v in gains], "Z2_ORIGINAL_PRIMAL_GAINS")
    return [str(v) for v in gains]


def forced_strategy(game, proof, deadline):
    need(type(proof) is dict and proof.get("modelId") == game["id"] and type(proof.get("steps")) is list,
         "Z2_DOMINANCE_MODEL")
    family = complete_local_plans(game, {i["party"] for i in game["infos"].values()})
    choices = {}
    for step in proof["steps"]:
        check_deadline(deadline)
        need(type(step) is dict and set(step) == {"informationKey", "actionId"}, "Z2_DOMINANCE_STEP")
        key, action = step["informationKey"], step["actionId"]
        need(key in game["infos"] and key not in choices, "Z2_DOMINANCE_DOMAIN")
        info = game["infos"][key]
        need(action in info["actions"], "Z2_DOMINANCE_ACTION")
        for node in info["nodes"]:
            for alternative in info["actions"]:
                if alternative == action:
                    continue
                for arbitrary in family:
                    check_deadline(deadline)
                    a = {**arbitrary, **choices, key: action}
                    b = {**arbitrary, **choices, key: alternative}
                    need(expected(game, {}, info["party"], a, node) > expected(game, {}, info["party"], b, node),
                         "Z2_NOT_POINTWISE_STRICT_DOMINANCE")
        choices[key] = action
    need(set(choices) == set(game["infos"]), "Z2_DOMINANCE_NOT_COMPLETE")
    return choices


def infeasible(problem, proof, native, deadline):
    need(type(proof) is dict, "Z2_ORIGINAL_INFEASIBILITY_PROOF_REQUIRED")
    if proof.get("kind") == "WHOLE_ORIGINAL_OWNER_BOUND":
        floor = native.inspect(problem, None)
        need(floor["status"] == "INFEASIBLE" and proof.get("upperBound") == floor["upperBound"],
             "Z2_ORIGINAL_OWNER_BOUND_NOT_CHECKED")
        return {"basis": "WHOLE_ORIGINAL_OWNER_BOUND", "policyCoverage": "ALL_ORIGINAL"}
    need(proof.get("kind") == "STRICT_DOMINANCE_EXHAUSTION" and type(proof.get("policies")) is list,
         "Z2_ORIGINAL_INFEASIBILITY_PROOF_REQUIRED")
    family = original_policy_family(problem)
    exclusions = proof["policies"]
    actual = [canonical(e.get("policy")) for e in exclusions]
    need(len(actual) == len(set(actual)) == len(family) and set(actual) == {canonical(p) for p in family},
         "Z2_ORIGINAL_CANDIDATE_FAMILY_COVERAGE")
    for exclusion in exclusions:
        check_deadline(deadline)
        candidate = exclusion.get("candidate")
        need(type(candidate) is dict and candidate.get("policy") == exclusion["policy"], "Z2_EXCLUSION_CANDIDATE")
        guard_candidate(candidate)
        games = [reconstruct(problem, m, exclusion["policy"]) for m in problem["models"]]
        proofs = exclusion.get("dominance")
        need(type(proofs) is list and len(proofs) == len(games) and
             {p.get("modelId") for p in proofs} == {g["id"] for g in games}, "Z2_DOMINANCE_MODELS")
        choices = {}
        for game in games:
            local = forced_strategy(game, next(p for p in proofs if p["modelId"] == game["id"]), deadline)
            need(all(k not in choices or choices[k] == a for k, a in local.items()), "Z2_DOMINANCE_MODEL_CONFLICT")
            choices.update(local)
        need(set(candidate["strategy"]) == set(choices), "Z2_FORCED_STRATEGY_DOMAIN")
        for key, action in choices.items():
            row = candidate["strategy"][key]
            need(all(rat(v) == int(a == action) for a, v in row.items()) and action in row,
                 "Z2_FORCED_STRATEGY_MISMATCH")
        floor = native.inspect(problem, candidate)
        if floor["status"] == "REJECTED" and floor.get("reason") in (
                "Y3_OUTSIDE_OPTION_NOT_MET", "Y3_OWNER_GOAL_NOT_MET", "Y3_NONTRIVIAL_REQUIRED"):
            need(exclusion.get("nativeReason") == floor["reason"], "Z2_ORIGINAL_NATIVE_EXCLUSION_REASON")
            continue
        need(floor["status"] == "CHECKED", "Z2_EXCLUSION_NATIVE_FLOOR")
        witness = exclusion.get("counterstrategy")
        need(type(witness) is dict, "Z2_EXCLUSION_COUNTERSTRATEGY")
        model = next((g for g in games if g["id"] == witness.get("modelId")), None)
        coalition = witness.get("coalition")
        parties = [p["id"] for p in problem["participants"]]
        need(model is not None and type(coalition) is list and coalition and
             len(set(coalition)) == len(coalition) and set(coalition).issubset(parties), "Z2_EXCLUSION_COALITION")
        primal(model, candidate["strategy"], coalition, witness, deadline)
    return {"basis": "POINTWISE_STRICT_DOMINANCE_AND_EXACT_EXCLUSIONS", "policyCoverage": len(family)}


def inspect(problem, construction):
    result = {"schema": "finnor.project-z.z2.check.v1", "status": "INCOMPLETE",
              "problemDigest": digest(problem), "constructionDigest": digest(construction)}
    deadline = time.monotonic()+PROFILE["maxProcessWallMs"]/1000
    try:
        native = load_native()
        guard_problem(problem, native)
        if len(canonical(construction).encode()) > PROFILE["maxArtifactBytes"]:
            raise Unsupported("Z2_ARTIFACT_BYTE_BOUND")
        need(type(construction) is dict and construction.get("problemDigest") == digest(problem)
             and construction.get("profileDigest") == PROFILE_DIGEST, "Z2_CONSTRUCTION_BINDING")
        if construction.get("status") == "CHECKED_INFEASIBLE":
            coverage = infeasible(problem, construction.get("infeasibility"), native, deadline)
            result.update(status="CHECKED_INFEASIBLE", reason="Z2_ORIGINAL_FAMILY_INFEASIBILITY_CHECKED", coverage=coverage)
            return result
        if construction.get("status") != "CANDIDATE":
            result["reason"] = "Z2_NO_CHECKED_CANDIDATE"
            return result
        candidate = construction.get("candidate")
        need(type(candidate) is dict, "Z2_CANDIDATE_REQUIRED")
        guard_candidate(candidate)
        floor = native.inspect(problem, candidate)
        result["nativeY3"] = floor
        need(floor["status"] == "CHECKED", "Z2_NATIVE_FULL_Y3_FLOOR")
        parties = [p["id"] for p in problem["participants"]]
        games = [reconstruct(problem, m, candidate["policy"]) for m in problem["models"]]
        if len(set().union(*(set(g["infos"]) for g in games))) > PROFILE["maxInformationSets"]:
            raise Unsupported("Z2_ORIGINAL_INFORMATION_BOUND")
        for game in games:
            complete_local_plans(game, parties)
        witness = construction.get("counterstrategy")
        if witness is not None:
            need(type(witness) is dict, "Z2_COUNTERSTRATEGY_REQUIRED")
            game = next((g for g in games if g["id"] == witness.get("modelId")), None)
            coalition = witness.get("coalition")
            need(game is not None and type(coalition) is list and coalition and
                 all(type(p) is str for p in coalition) and len(set(coalition)) == len(coalition)
                 and set(coalition).issubset(parties), "Z2_COUNTERSTRATEGY_COALITION")
            gains = primal(game, candidate["strategy"], coalition, witness, deadline)
            result.update(status="COUNTEREXAMPLE", reason="Z2_CHECKED_PROFITABLE_CORRELATED_MIXTURE",
                          candidateDigest=digest(candidate), counterstrategy={
                              "modelId": game["id"], "coalition": coalition, "terms": witness["terms"], "gains": gains,
                              "independentlyVerifiedOriginalLocalPlans": True, "incentiveConcept": PROFILE["concept"]})
            return result
        coalition_family = [list(c) for size in range(1, len(parties)+1) for c in itertools.combinations(parties, size)]
        expected_pairs = {(g["id"], tuple(c)) for g in games for c in coalition_family}
        witnesses = construction.get("certificates")
        need(type(witnesses) is list and all(type(w) is dict for w in witnesses), "Z2_CERTIFICATE_COVERAGE")
        pairs = [(w.get("modelId"), tuple(w.get("coalition", []))) for w in witnesses]
        need(len(pairs) == len(set(pairs)) == len(expected_pairs) and set(pairs) == expected_pairs, "Z2_CERTIFICATE_COVERAGE")
        reports = []
        for game in games:
            for coalition in coalition_family:
                witness = next(w for w in witnesses if w["modelId"] == game["id"] and w["coalition"] == coalition)
                reports.append(dual(game, candidate["strategy"], coalition, witness, deadline))
        result.update(status="CHECKED_CANDIDATE", reason="Z2_EXACT_ALL_ORIGINAL_CORRELATED_COALITIONS",
                      candidateDigest=digest(candidate), coverage=reports, allModels=True, allNonemptyCoalitions=True,
                      incentiveConcept=PROFILE["concept"], nativeFullSequentialAndCommonTremble=True)
    except Rejected as error:
        result.update(status="COUNTEREXAMPLE", reason=str(error))
    except Unsupported as error:
        result.update(status="UNSUPPORTED", reason=str(error))
    except (Incomplete, MemoryError, RecursionError) as error:
        result.update(status="INCOMPLETE", reason=str(error) or "Z2_PROCESS_RESOURCE_BOUND")
    return result


def main():
    request = read_request()
    need(type(request) is dict and set(request) == {"problem", "construction"}, "Z2_CHECK_REQUEST_SHAPE")
    emit(inspect(request["problem"], request["construction"]), "checker.py")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"schema": "finnor.project-z.z2.check.v1", "status": "INCOMPLETE",
              "reason": str(error)[:160] if str(error).startswith(("Z2_", "Y3_")) else "Z2_CHECKER_FAILURE"}, "checker.py")
