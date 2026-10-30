"""Independent expected values for the public dynamic Z2 fixture.

Reads one InteractionProblem on stdin. It enumerates every disclosure policy with the installed original oracle's own
game reader, never the producer or checker, then fixes one hand-chosen pure profile (hold on market 0, disclose on market 1,
P0 engages, P1 accepts), proves with the oracle that no coalition profits, and prints the information-key to action table
and the oracle utilities that must be frozen before any native construction runs.
"""
import importlib.util
import itertools
import json
import sys

pack = sys.argv[1]
spec = importlib.util.spec_from_file_location("original_oracle", pack + "/finnor-os/scripts/project-z/z2/original-oracle.py")
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
problem = json.load(sys.stdin)
assert [m["id"] for m in problem["models"]] == ["supplied"]
model = problem["models"][0]
control = problem["controls"][0]
assert control["options"] == ["hold", "disclose"]


class Recording(dict):
    def __init__(self, choose):
        super().__init__()
        self.choose, self.seen = choose, []

    def __getitem__(self, key):
        self.seen.append(key)
        return self.choose(key)


recording = Recording(lambda key: "hold")
oracle.local_game(problem, model, recording)
keys = sorted(set(recording.seen))
assert len(keys) == 2, keys
actions = {}
for assignment in itertools.product(["hold", "disclose"], repeat=len(keys)):
    policy = dict(zip(keys, assignment))
    game = oracle.local_game(problem, model, policy)
    for key, info in game["infos"].items():
        want = "engage" if info["party"] == "P0" else "accept"
        assert want in info["actions"], (info, want)
        actions[key] = want


def market_key(bit):
    return "K:" + oracle.digest({"controlId": control["id"], "date": 0, "publicObservations": [
        {"date": 0, "key": "market", "value": str(bit), "visibility": "PUBLIC"}]})


policy = {market_key(0): "hold", market_key(1): "disclose"}
assert sorted(policy) == keys, (sorted(policy), keys)
game = oracle.local_game(problem, model, policy)
strategy = {key: {a: ("1" if a == actions[key] else "0") for a in info["actions"]} for key, info in game["infos"].items()}
candidate = {"policy": policy, "strategy": strategy}
reports = oracle.inspect(problem, candidate)
assert not any(r["profitable"] for r in reports), "HAND_PROFILE_IS_NOT_COALITION_PROOF"
utilities = {model["id"]: [str(v) for v in oracle.value(game, strategy, {})]}
print(json.dumps({"actionByInformationKey": actions, "utilities": utilities, "oracleReportCount": len(reports),
                  "handCandidateDigest": oracle.digest(candidate), "problemDigest": oracle.digest(problem)}, sort_keys=True))
