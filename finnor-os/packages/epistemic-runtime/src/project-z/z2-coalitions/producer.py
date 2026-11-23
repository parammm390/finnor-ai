"""Untrusted native policy/profile search, guided by exact coalition counterstrategies."""
import itertools
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (PROFILE, PROFILE_DIGEST, need, digest, load_native, guard_problem,
                    guard_candidate, Incomplete, Unsupported, Rejected, check_deadline, read_request, emit)
from plans import certificate, coalitions, force_strategy, plans


def construct(problem, budget_ms):
    deadline = time.monotonic()+budget_ms/1000
    search = {"steps": 0, "policies": 0, "profiles": 0, "coalitionChecks": 0, "pivots": 0,
              "complete": False, "uncovered": ["NON_GRID_BEHAVIOR", "NONUNIT_TREMBLES", "ALGEBRAIC_ASSESSMENTS"]}
    rejected = []

    def result(status, reason, **extra):
        return {"schema": "finnor.project-z.z2.construction.v1", "status": status, "reason": reason,
                "problemDigest": digest(problem), "profileDigest": PROFILE_DIGEST, "candidate": None,
                "certificates": [], "search": search, "counterstrategies": rejected, **extra}

    try:
        check_deadline(deadline)
        native, proposer = load_native(), load_native("producer")
        keys = guard_problem(problem, native)
        bound = native.objective_bound(problem)
        if bound < native.known_quantity(problem["goal"]["minimumOwnerValue"]):
            return result("CHECKED_INFEASIBLE", "Z2_WHOLE_ORIGINAL_OWNER_BOUND",
                          infeasibility={"kind": "WHOLE_ORIGINAL_OWNER_BOUND", "upperBound": str(bound)})
        ordered = sorted(keys)
        policies = [dict(zip(ordered, row)) for row in itertools.product(*(keys[k]["options"] for k in ordered))]
        exclusions = []
        parties = [p["id"] for p in problem["participants"]]
        def fair_profiles():
            pending = []
            for policy in policies:
                check_deadline(deadline)
                search["policies"] += 1
                try:
                    games = [native.compile_original(problem, model, policy) for model in problem["models"]]
                except native.Rejected:
                    # No whole-family exclusion is inferred for an ineligible policy.
                    continue
                union = {}
                for game in games:
                    for key, info in game["infos"].items():
                        if key in union and set(union[key]["actionIds"]) != set(info["actionIds"]):
                            raise Unsupported("Z2_CROSS_MODEL_ORIGINAL_LOCAL_ALPHABET")
                        union[key] = info
                    plans(game, parties)
                if len(union) > PROFILE["maxInformationSets"]:
                    raise Unsupported("Z2_ORIGINAL_INFORMATION_BOUND")
                info_keys = sorted(union)
                choices, proofs = {}, []
                for game in games:
                    forced = force_strategy(game, parties, deadline)
                    if forced is None or any(k in choices and choices[k] != a for k, a in forced["choices"].items()):
                        proofs = []
                        break
                    choices.update(forced["choices"])
                    proofs.append({"modelId": game["modelId"], "steps": forced["steps"]})
                distributions = [
                    [{a: str(int(choices[k] == a)) for a in union[k]["actionIds"]}]
                    if proofs else proposer.distribution_rows(union[k]["actionIds"])
                    for k in info_keys
                ]
                rows = iter(itertools.product(*distributions))
                # Visit every original policy before exhausting one policy's
                # incomplete behavior grid. Complete forced exclusions remain exact.
                yield policy, games, proofs, dict(zip(info_keys, next(rows)))
                pending.append((policy, games, proofs, info_keys, rows))
            while pending:
                remaining = []
                for policy, games, proofs, info_keys, rows in pending:
                    check_deadline(deadline)
                    row = next(rows, None)
                    if row is not None:
                        yield policy, games, proofs, dict(zip(info_keys, row))
                        remaining.append((policy, games, proofs, info_keys, rows))
                pending = remaining

        for policy, games, proofs, strategy in fair_profiles():
            check_deadline(deadline)
            search["steps"] += 1; search["profiles"] += 1
            if search["steps"] > PROFILE["maxSearchSteps"]:
                raise Incomplete("Z2_ORIGINAL_SEARCH_BOUND")
            candidate = proposer.propose(problem, games, policy, strategy, bound)
            guard_candidate(candidate)
            check = native.inspect(problem, candidate)
            if check["status"] != "CHECKED":
                if proofs and check["status"] == "REJECTED" and check.get("reason") in (
                        "Y3_OUTSIDE_OPTION_NOT_MET", "Y3_OWNER_GOAL_NOT_MET", "Y3_NONTRIVIAL_REQUIRED"):
                    exclusions.append({"policy": policy, "candidate": candidate, "dominance": proofs,
                                       "nativeReason": check["reason"]})
                continue
            certificates, profitable = [], None
            for game in games:
                for coalition in coalitions(parties):
                    cert = certificate(game, candidate["strategy"], coalition, deadline)
                    search["coalitionChecks"] += 1; search["pivots"] += cert["pivots"]
                    if cert["kind"] == "PROFITABLE_MIXTURE":
                        profitable = cert
                        break
                    certificates.append(cert)
                if profitable:
                    break
            if profitable:
                if len(rejected) < 32:
                    rejected.append({"candidateDigest": digest(candidate), "candidate": candidate,
                                     "policy": policy, "counterstrategy": profitable})
                if proofs:
                    exclusions.append({"policy": policy, "candidate": candidate, "dominance": proofs,
                                       "counterstrategy": profitable})
                continue
            return result("CANDIDATE", "Z2_FRESH_INDEPENDENT_CHECK_REQUIRED", candidate=candidate, certificates=certificates)

        # Only complete strict-dominance exclusions cover non-grid behavior.
        if len(exclusions) == len(policies):
            search.update(complete=True, uncovered=[])
            return result("CHECKED_INFEASIBLE", "Z2_COMPLETE_STRICT_DOMINANCE_EXCLUSION",
                          infeasibility={"kind": "STRICT_DOMINANCE_EXHAUSTION", "policies": exclusions})
        return result("INCOMPLETE", "Z2_EXHAUSTED_GRID_NOT_ORIGINAL_FAMILY")
    except Unsupported as error:
        return result("UNSUPPORTED", str(error))
    except (Incomplete, MemoryError, RecursionError) as error:
        return result("INCOMPLETE", str(error) or "Z2_PROCESS_RESOURCE_BOUND")
    except Rejected as error:
        return result("UNSUPPORTED", str(error))


def main():
    request = read_request()
    need(type(request) is dict and set(request) == {"problem", "budgetMs"}, "Z2_REQUEST_SHAPE")
    need(type(request["budgetMs"]) is int and 0 <= request["budgetMs"] <= PROFILE["maxProcessWallMs"], "Z2_PROCESS_BUDGET")
    emit(construct(request["problem"], request["budgetMs"]), "producer.py")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"schema": "finnor.project-z.z2.construction.v1", "status": "INCOMPLETE", "candidate": None,
              "certificates": [], "reason": str(error)[:160] if str(error).startswith(("Z2_", "Y3_")) else "Z2_PRODUCER_FAILURE",
              "search": {"complete": False}}, "producer.py")
