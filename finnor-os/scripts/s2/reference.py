"""Independent S2 oracle: Python Fraction forward probability propagation.

This source is authored before the S2 implementation. It imports no FINNOR code.
An ordered-path check for small cases independently challenges the forward solver.
stdin: supplied design request. stdout: exact rational expected risks/discrimination.
"""
import itertools
import json
import sys
from collections import defaultdict
from fractions import Fraction as F


def exact(x):
    return {"numerator": str(x.numerator), "denominator": str(x.denominator)}


def solve(request, candidate, ordered=False):
    prior = [F(h["prior"]) for h in request["hypotheses"]]
    losses = [[F(v) for v in row] for row in request["decisionContext"]["lossByHypothesis"]]
    law = [[F(v) for v in row] for row in candidate["likelihood"]["probabilities"]]
    h = len(prior)
    k = len(law[0])
    n = candidate["samples"]
    alpha = F(candidate["stopping"]["alpha"])
    beta = F(candidate["stopping"]["beta"])
    sequential = candidate["stopping"]["method"] == "ANYTIME_LR"
    terminal = defaultdict(lambda: [F(0) for _ in range(h)])

    def reason(counts, size):
        if h != 2:
            return "SAMPLE_LIMIT" if size == n else None
        p = [F(1), F(1)]
        for hi in range(2):
            for ki in range(k):
                p[hi] *= law[hi][ki] ** counts[ki]
        if p[0] == p[1] == 0:
            return "IMPOSSIBLE"
        if (sequential or size == n) and p[1] * alpha >= p[0] and p[1] > 0:
            return "REJECT_H0"
        if (sequential or size == n) and p[0] * beta >= p[1] and p[0] > 0:
            return "REJECT_H1"
        return "SAMPLE_LIMIT" if size == n else None

    if ordered:
        def walk(counts, size, probabilities):
            stop = reason(counts, size) if size else None
            if stop:
                key = (tuple(counts), size, stop)
                terminal[key] = [a + b for a, b in zip(terminal[key], probabilities)]
                return
            for outcome in range(k):
                next_counts = list(counts)
                next_counts[outcome] += 1
                next_p = [probabilities[hi] * law[hi][outcome] for hi in range(h)]
                if any(next_p):
                    walk(next_counts, size + 1, next_p)
        walk([0] * k, 0, [F(1)] * h)
    else:
        live = {tuple([0] * k): [F(1)] * h}
        for size in range(1, n + 1):
            next_live = defaultdict(lambda: [F(0) for _ in range(h)])
            for counts, probabilities in live.items():
                for outcome in range(k):
                    c = list(counts)
                    c[outcome] += 1
                    q = [probabilities[hi] * law[hi][outcome] for hi in range(h)]
                    if not any(q):
                        continue
                    stop = reason(c, size)
                    destination = terminal if stop else next_live
                    key = (tuple(c), size, stop) if stop else tuple(c)
                    destination[key] = [a + b for a, b in zip(destination[key], q)]
            live = next_live

    risk = F(0)
    expected_n = F(0)
    reject0, reject1, inconclusive, mass = [[F(0)] * h for _ in range(4)]
    for (counts, size, stop), probabilities in terminal.items():
        joint = [prior[hi] * probabilities[hi] for hi in range(h)]
        risk += min(sum(joint[hi] * losses[hi][a] for hi in range(h)) for a in range(len(losses[0])))
        expected_n += sum(joint) * size
        mass = [a + b for a, b in zip(mass, probabilities)]
        result = reject0 if stop == "REJECT_H0" else reject1 if stop == "REJECT_H1" else inconclusive
        for hi in range(h):
            result[hi] += probabilities[hi]
    before = min(sum(prior[hi] * losses[hi][a] for hi in range(h)) for a in range(len(losses[0])))
    assert mass == [F(1)] * h
    if h == 2:
        assert reject0[0] <= alpha
        assert reject1[1] <= beta
    encoding = []
    for (counts, size, stop), probabilities in terminal.items():
        for hi in range(h):
            path_probability = F(1)
            for ki in range(k):
                path_probability *= law[hi][ki] ** counts[ki]
            if path_probability:
                ways = probabilities[hi] / path_probability
                assert ways.denominator == 1
                encoding.append({"counts": list(counts), "sampleSize": size, "stop": stop, "sequenceMultiplicity": str(ways.numerator)})
                break
    return {"baselineRisk": exact(before), "terminalRisk": exact(risk), "riskReduction": exact(before-risk), "terminalEncoding": sorted(encoding, key=lambda r: (r["sampleSize"], r["counts"], r["stop"])),
            "expectedSamples": exact(expected_n), "massByHypothesis": [exact(p) for p in mass],
            "rejectH0ByHypothesis": [exact(p) for p in reject0], "rejectH1ByHypothesis": [exact(p) for p in reject1],
            "inconclusiveByHypothesis": [exact(p) for p in inconclusive]}


request = json.load(sys.stdin)
results = {}
for candidate in request["candidates"]:
    if candidate["likelihood"]["status"] != "SUPPLIED_CONDITIONAL":
        continue
    answer = solve(request, candidate)
    ordered_limit = 12 if candidate["stopping"]["method"] == "ANYTIME_LR" else 8
    if candidate["samples"] <= ordered_limit:
        assert answer == solve(request, candidate, ordered=True)
    results[candidate["id"]] = answer
json.dump(results, sys.stdout, sort_keys=True)
sys.stdout.write("\n")
