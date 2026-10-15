"""Producer-side exact feasibility repair, not an independent acceptance oracle."""
from fractions import Fraction
import time


def feasible(rows, bounds, candidate):
    return all(low <= candidate[i] <= high for i, (low, high) in enumerate(bounds)) and all(
        sum((value * candidate[index] for index, value in a.items()), Fraction()) <= b for a, b, _ in rows)


def repair(rows, bounds, deadline, pivot_limit=20000):
    """Two-phase rational simplex on the FIXED allocation, bounded and disclosed.

    Dense storage is bounded by the finite input profile. Bland index tie rules
    avoid cycling. This solves feasibility only, never the mechanism MILP optimum.
    """
    lower = [b[0] for b in bounds]
    shifted = [(a, b - sum((v * lower[j] for j, v in a.items()), Fraction()), name) for a, b, name in rows]
    shifted += [({j: Fraction(1)}, high - low, "upper:%d" % j) for j, (low, high) in enumerate(bounds)]
    m, n = len(shifted), len(bounds)
    if (m + 2) * (n + 2) > 2500000:
        raise ValueError("R3_EXACT_REPAIR_MATRIX_BOUND")
    D = [[Fraction() for _ in range(n + 2)] for _ in range(m + 2)]
    basic, nonbasic = [n + i for i in range(m)], list(range(n)) + [-1]
    for i, (a, b, _) in enumerate(shifted):
        for j, v in a.items():
            D[i][j] = v
        D[i][n], D[i][n + 1] = Fraction(-1), b
    D[m + 1][n] = Fraction(1)
    pivots = 0

    def pivot(r, s):
        nonlocal pivots
        pivots += 1
        if pivots > pivot_limit or time.monotonic() >= deadline:
            raise TimeoutError("R3_EXACT_REPAIR_ORIGINAL_LIMIT")
        inverse = 1 / D[r][s]
        columns = [j for j in range(n + 2) if j != s and D[r][j]]
        for i in range(m + 2):
            if i == r or not D[i][s]:
                continue
            scale = D[i][s] * inverse
            for j in columns:
                D[i][j] -= D[r][j] * scale
                if D[i][j].numerator.bit_length() > 420 or D[i][j].denominator.bit_length() > 420:
                    raise ValueError("R3_EXACT_REPAIR_RATIONAL_GROWTH_BOUND")
            D[i][s] = -scale
        for j in range(n + 2):
            if j != s:
                D[r][j] *= inverse
        D[r][s] = inverse
        basic[r], nonbasic[s] = nonbasic[s], basic[r]

    def simplex(phase):
        objective = m + 1 if phase == 1 else m
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError("R3_EXACT_REPAIR_ORIGINAL_LIMIT")
            candidates = [j for j in range(n + 1) if not (phase == 2 and nonbasic[j] == -1) and D[objective][j] < 0]
            if not candidates:
                return True
            s = min(candidates, key=lambda j: nonbasic[j])
            eligible = [i for i in range(m) if D[i][s] > 0]
            if not eligible:
                return False
            r = min(eligible, key=lambda i: (D[i][n + 1] / D[i][s], basic[i]))
            pivot(r, s)

    r = min(range(m), key=lambda i: D[i][n + 1])
    if D[r][n + 1] < 0:
        pivot(r, n)
        if not simplex(1) or D[m + 1][n + 1] != 0:
            return None, {"basis": "FIXED_ALLOCATION_REPAIR_INFEASIBLE_NOT_ORIGINAL_MILP", "pivots": pivots}
        for i in range(m):
            if basic[i] == -1:
                columns = [j for j in range(n + 1) if D[i][j]]
                if columns:
                    pivot(i, min(columns, key=lambda j: nonbasic[j]))
    candidate = list(lower)
    for i in range(m):
        if 0 <= basic[i] < n:
            candidate[basic[i]] += D[i][n + 1]
    if not feasible(rows, bounds, candidate):
        raise ValueError("R3_EXACT_REPAIR_INTERNAL_PREDICATE")
    return candidate, {"basis": "EXACT_FIXED_ALLOCATION_FEASIBILITY_ONLY", "pivots": pivots}
