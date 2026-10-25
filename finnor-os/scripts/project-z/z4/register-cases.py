"""Pre-code public fixture registration. Independent family formulae, not a VM."""
import argparse
import hashlib
import json
from pathlib import Path
import random

FAMILIES = [
    "affine", "weighted-sum", "quadratic", "cubic", "bilinear", "minimum",
    "maximum", "absolute", "clamp", "threshold", "tiered-fee", "ratio-cross",
    "running-sum", "running-product", "running-min", "running-max",
    "rolling-two", "rolling-three", "difference", "accumulated-difference",
    "dot-product", "sum-squares", "horner", "affine-recurrence",
    "coupled-recurrence", "hysteresis", "reset-counter", "budget-decrement",
    "cash-in-out", "capped-accrual", "guarded-exchange", "ordered-affine-fold",
]
KINDS = ["positive-a", "positive-b", "wrong-result", "unsupported",
         "authority", "currentness", "budget", "interruption"]
SEED = 0x5A340126


def reg(i): return {"reg": i}
def inp(i): return {"input": i}
def num(i): return {"const": str(i)}
def op(name, dst, a, b, c=None):
    return {"op": name, "dst": dst, "a": a, "b": b, **({"c": c} if c is not None else {})}


def definition(f):
    r, x, n = reg, inp, num
    a, b = 3, 2
    definitions = {
        "affine": [op("mul", 0, x(0), n(a)), op("add", 0, r(0), n(b))],
        "weighted-sum": [op("mul", 0, x(0), n(a)), op("mul", 1, x(1), n(b)), op("add", 0, r(0), r(1))],
        "quadratic": [op("mul", 0, x(0), x(0)), op("mul", 0, r(0), n(a)), op("mul", 1, x(0), n(b)), op("add", 0, r(0), r(1)), op("add", 0, r(0), n(5))],
        "cubic": [op("mul", 1, x(0), x(0)), op("mul", 0, r(1), x(0)), op("mul", 0, r(0), n(a)), op("mul", 1, r(1), n(b)), op("add", 0, r(0), r(1)), op("add", 0, r(0), x(0))],
        "bilinear": [op("mul", 0, x(0), x(1)), op("mul", 0, r(0), n(a)), op("add", 0, r(0), x(2))],
        "minimum": [op("lt", 7, x(0), x(1)), op("select", 0, x(0), x(1), r(7))],
        "maximum": [op("lt", 7, x(0), x(1)), op("select", 0, x(1), x(0), r(7))],
        "absolute": [op("lt", 7, x(0), n(0)), op("sub", 1, n(0), x(0)), op("select", 0, r(1), x(0), r(7))],
        "clamp": [op("lt", 7, x(0), n(-3)), op("select", 0, n(-3), x(0), r(7)), op("lt", 7, n(9), r(0)), op("select", 0, n(9), r(0), r(7))],
        "threshold": [op("lt", 7, x(0), n(4)), op("mul", 0, x(0), n(a)), op("mul", 1, x(0), n(b)), op("select", 0, r(0), r(1), r(7))],
        "tiered-fee": [op("sub", 0, x(0), n(4)), op("mul", 0, r(0), n(b)), op("add", 0, r(0), n(12)), op("mul", 1, x(0), n(a)), op("lt", 7, x(0), n(4)), op("select", 0, r(1), r(0), r(7))],
        "ratio-cross": [op("mul", 0, x(0), n(b)), op("mul", 1, x(1), n(a)), op("lt", 7, r(0), r(1)), op("select", 0, n(1), n(0), r(7))],
        "running-sum": [op("add", 0, r(0), x(0))],
        "running-product": [op("mul", 0, r(0), x(0))],
        "running-min": [op("lt", 7, x(0), r(0)), op("select", 0, x(0), r(0), r(7))],
        "running-max": [op("lt", 7, r(0), x(0)), op("select", 0, x(0), r(0), r(7))],
        "rolling-two": [op("add", 2, r(0), x(0)), op("add", 0, x(0), n(0))],
        "rolling-three": [op("add", 3, r(0), r(1)), op("add", 3, r(3), x(0)), op("add", 1, r(0), n(0)), op("add", 0, x(0), n(0))],
        "difference": [op("sub", 1, x(0), r(0)), op("add", 0, x(0), n(0))],
        "accumulated-difference": [op("sub", 1, x(0), r(0)), op("add", 2, r(2), r(1)), op("add", 0, x(0), n(0))],
        "dot-product": [op("mul", 1, x(0), x(1)), op("add", 0, r(0), r(1))],
        "sum-squares": [op("mul", 1, x(0), x(0)), op("add", 0, r(0), r(1))],
        "horner": [op("mul", 0, r(0), x(0)), op("add", 0, r(0), n(a))],
        "affine-recurrence": [op("mul", 0, r(0), n(a)), op("add", 0, r(0), x(0))],
        "coupled-recurrence": [op("add", 1, r(0), n(0)), op("mul", 0, r(0), n(a)), op("add", 0, r(0), r(2)), op("add", 0, r(0), x(0)), op("add", 2, r(1), n(b))],
        "hysteresis": [op("lt", 7, n(6), x(0)), op("select", 0, n(1), r(0), r(7)), op("lt", 7, x(0), n(2)), op("select", 0, n(0), r(0), r(7))],
        "reset-counter": [op("eq", 7, x(0), n(0)), op("add", 0, r(0), n(1)), op("select", 0, n(0), r(0), r(7))],
        "budget-decrement": [op("sub", 0, r(0), x(0))],
        "cash-in-out": [op("add", 0, r(0), x(0)), op("sub", 0, r(0), x(1))],
        "capped-accrual": [op("add", 0, r(0), x(0)), op("lt", 7, n(12), r(0)), op("select", 0, n(12), r(0), r(7))],
        "guarded-exchange": [op("lt", 7, x(0), r(0)), op("sub", 1, r(0), x(0)), op("add", 2, r(3), x(0)), op("select", 0, r(1), r(0), r(7)), op("select", 3, r(2), r(3), r(7))],
        "ordered-affine-fold": [op("mul", 0, r(0), x(0)), op("add", 0, r(0), x(1))],
    }
    return {"schema": "finnor.z4.integer-program.v1", "inputCount": 3,
            "registers": [{"type": "bool" if i == 7 else "i64", "unit": "1"} for i in range(8)],
            "inputUnits": ["1"] * 3, "rounding": "EXACT_NO_CONVERSION", "instructions": definitions[f]}


def expected(f, initial, rows):
    s = list(initial)
    for u, v, w in rows:
        old = s[:]
        if f == "affine": s[0] = 3*u+2
        elif f == "weighted-sum": s[0], s[1] = 3*u+2*v, 2*v
        elif f == "quadratic": s[0], s[1] = 3*u*u+2*u+5, 2*u
        elif f == "cubic": s[0], s[1] = 3*u**3+2*u*u+u, 2*u*u
        elif f == "bilinear": s[0] = 3*u*v+w
        elif f == "minimum": s[0], s[7] = min(u, v), int(u < v)
        elif f == "maximum": s[0], s[7] = max(u, v), int(u < v)
        elif f == "absolute": s[0], s[1], s[7] = abs(u), -u, int(u < 0)
        elif f == "clamp": s[0], s[7] = max(-3, min(9, u)), int(u > 9)
        elif f == "threshold": s[0], s[1], s[7] = (3*u if u < 4 else 2*u), 2*u, int(u < 4)
        elif f == "tiered-fee": s[0], s[1], s[7] = (3*u if u < 4 else 12+2*(u-4)), 3*u, int(u < 4)
        elif f == "ratio-cross": s[0], s[1], s[7] = int(2*u < 3*v), 3*v, int(2*u < 3*v)
        elif f == "running-sum": s[0] += u
        elif f == "running-product": s[0] *= u
        elif f == "running-min": s[0], s[7] = min(old[0], u), int(u < old[0])
        elif f == "running-max": s[0], s[7] = max(old[0], u), int(old[0] < u)
        elif f == "rolling-two": s[2], s[0] = old[0]+u, u
        elif f == "rolling-three": s[3], s[1], s[0] = old[0]+old[1]+u, old[0], u
        elif f == "difference": s[1], s[0] = u-old[0], u
        elif f == "accumulated-difference": s[1], s[2], s[0] = u-old[0], old[2]+u-old[0], u
        elif f == "dot-product": s[1], s[0] = u*v, old[0]+u*v
        elif f == "sum-squares": s[1], s[0] = u*u, old[0]+u*u
        elif f == "horner": s[0] = old[0]*u+3
        elif f == "affine-recurrence": s[0] = 3*old[0]+u
        elif f == "coupled-recurrence": s[1], s[0], s[2] = old[0], 3*old[0]+old[2]+u, old[0]+2
        elif f == "hysteresis": s[0], s[7] = (0 if u < 2 else 1 if u > 6 else old[0]), int(u < 2)
        elif f == "reset-counter": s[0], s[7] = (0 if u == 0 else old[0]+1), int(u == 0)
        elif f == "budget-decrement": s[0] -= u
        elif f == "cash-in-out": s[0] += u-v
        elif f == "capped-accrual": s[0], s[7] = min(12, old[0]+u), int(12 < old[0]+u)
        elif f == "guarded-exchange":
            s[1], s[2], s[7] = old[0]-u, old[3]+u, int(u < old[0])
            s[0], s[3] = (old[0]-u, old[3]+u) if u < old[0] else (old[0], old[3])
        elif f == "ordered-affine-fold": s[0] = old[0]*u+v
        else: raise AssertionError(f)
    return list(map(str, s))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--output", required=True, type=Path)
    a = p.parse_args()
    rng = random.Random(SEED)
    cases = []
    for family in FAMILIES:
        for kind in KINDS:
            initial = [rng.randint(-3, 5) for _ in range(7)] + [0]
            if family == "hysteresis": initial[0] = 0
            rows = [[rng.randint(-4, 9), rng.randint(-4, 6), rng.randint(-3, 3)] for _ in range(2)]
            cases.append({"id": family+":"+kind, "family": family, "kind": kind,
                          "request": {"program": definition(family), "initial": list(map(str, initial)),
                                      "inputs": [[str(x) for x in row] for row in rows]},
                          "expectedFinal": expected(family, initial, rows)})
    body = {"schema": "finnor.z4.public-fixture-registration.v1", "seed": SEED,
            "executionAuthorityGranted": False, "protectedAdmission": False,
            "nativeWork": False, "eligibleReuseN": 0, "denominator": 256,
            "families": FAMILIES, "kinds": KINDS, "cases": cases,
            "stoppingRule": "one full sweep; preserve failures; bounded affected reruns only"}
    raw = (json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode()
    with a.output.open("xb") as f: f.write(raw)
    print(json.dumps({"cases": len(cases), "sha256": hashlib.sha256(raw).hexdigest(), "output": str(a.output)}))


if __name__ == "__main__": main()
