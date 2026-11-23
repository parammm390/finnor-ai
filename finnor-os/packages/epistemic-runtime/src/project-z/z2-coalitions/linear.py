"""Exact two-phase simplex with Bland pivots. Certificates are checked elsewhere."""
from common import Q, PROFILE, Incomplete, need, check_deadline


def solve(gains, deadline):
    n, members = len(gains), len(gains[0])
    # -Gp <= 0 with nonnegative slacks; sum(p)=1 has one artificial basis.
    rows = [[-gains[j][i] for j in range(n)] +
            [Q(int(i == k)) for k in range(members)] + [Q(0), Q(0)]
            for i in range(members)]
    rows.append([Q(1)]*n + [Q(0)]*members + [Q(1), Q(1)])
    artificial = n+members
    basis = list(range(n, n+members)) + [artificial]
    pivots = 0

    def reduced(cost):
        return [cost[j]-sum((cost[b]*row[j] for b, row in zip(basis, rows)), Q(0))
                for j in range(len(cost))]

    def pivot(i, j):
        nonlocal pivots
        pivots += 1
        if pivots > PROFILE["maxPivots"]:
            raise Incomplete("Z2_EXACT_LP_PIVOT_BOUND")
        row = [x/rows[i][j] for x in rows[i]]
        rows[i] = row
        for k in range(len(rows)):
            if k != i and rows[k][j] != 0:
                factor = rows[k][j]
                rows[k] = [x-factor*y for x, y in zip(rows[k], row)]
        basis[i] = j

    def optimize(cost, allow_artificial):
        while True:
            check_deadline(deadline)
            reduced_cost = reduced(cost)
            entering = next((j for j, v in enumerate(reduced_cost)
                             if v > 0 and j not in basis and (allow_artificial or j != artificial)), None)
            if entering is None:
                return sum((cost[b]*row[-1] for b, row in zip(basis, rows)), Q(0))
            possible = [i for i, row in enumerate(rows) if row[entering] > 0]
            need(possible, "Z2_LP_UNBOUNDED_INVARIANT")
            leaving = min(possible, key=lambda i: (rows[i][-1]/rows[i][entering], basis[i]))
            pivot(leaving, entering)

    phase_one = [Q(0)]*artificial + [Q(-1)]
    optimum = optimize(phase_one, True)
    need(optimum == 0, "Z2_BASELINE_MIXTURE_FEASIBILITY")
    if artificial in basis:
        i = basis.index(artificial)
        entering = next((j for j in range(artificial) if j not in basis and rows[i][j] != 0), None)
        if entering is None:
            need(rows[i][-1] == 0, "Z2_LP_ARTIFICIAL_RESIDUAL")
            rows.pop(i); basis.pop(i)
        else:
            pivot(i, entering)
    cost = [sum(v, Q(0)) for v in gains] + [Q(0)]*(members+1)
    optimum = optimize(cost, False)
    if optimum > 0:
        p = [Q(0)]*n
        for b, row in zip(basis, rows):
            if b < n:
                p[b] = row[-1]
        return {"kind": "PROFITABLE_MIXTURE", "weights": p, "objective": optimum, "pivots": pivots}
    # Slack columns recover nonnegative lambda; artificial column recovers free nu.
    dual = [sum((cost[b]*row[j] for b, row in zip(basis, rows)), Q(0))
            for j in range(n, artificial+1)]
    need(all(v >= 0 for v in dual[:-1]) and dual[-1] <= 0, "Z2_LP_DUAL_SIGN_INVARIANT")
    return {"kind": "NO_PROFIT_DUAL", "lambda": dual[:-1], "nu": dual[-1], "pivots": pivots}
