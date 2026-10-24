"""Independent ordered-term/interval checker, with no producer imports."""
import hashlib
import json
import re
import sys
from fractions import Fraction
from pathlib import Path

P_BYTES = Path(__file__).with_name("profile.json").read_bytes()
P = json.loads(P_BYTES)
MAXIMUM = 2 ** 80


def demand(condition):
    if not condition:
        raise ValueError("CORRESPONDENCE_PREMISE_FAILED")


def stable(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha(value):
    return hashlib.sha256(stable(value).encode()).hexdigest()


def integer(value):
    demand(isinstance(value, str) and re.fullmatch(r"-?(?:0|[1-9]\d*)", value) is not None
           and len(value) < 100)
    return int(value)


def number(value):
    demand(isinstance(value, str) and len(value) <= 96
           and re.fullmatch(r"[+-]?\d+(?:\.\d+)?", value) is not None)
    return Fraction(value)


def check(function, protocol):
    demand(protocol["schema"] == "finnor.y4.arithmetic-protocol.v1"
           and protocol["functionDigest"] == sha(function)
           and protocol["profileDigest"] == hashlib.sha256(P_BYTES).hexdigest()
           and protocol["function"] == function)
    inputs = function["inputs"]
    demand(3 <= len(function["participants"]) <= 8 and 1 <= len(inputs) <= 16)
    ports = {p["key"]: p for p in inputs}
    demand(len(ports) == len(inputs))
    original_count = 0

    def original(e, depth=1):
        nonlocal original_count
        original_count += 1
        demand(depth <= 12 and original_count <= 256)
        op = e["kind"]
        if op == "input":
            demand(set(e) == {"kind", "key"} and e["key"] in ports)
            return ("input", e["key"])
        if op == "literal":
            demand(set(e) == {"kind", "value", "unit", "currencyCode"})
            v = number(e["value"])
            return ("literal", v, e["unit"], e["currencyCode"])
        if op == "if":
            demand(set(e) == {"kind", "condition", "whenTrue", "whenFalse"})
            c = e["condition"]
            demand(c["comparison"] in {"lt", "lte", "eq", "gte", "gt"}
                   and set(c) == {"comparison", "left", "right"})
            return ("if", c["comparison"], original(c["left"], depth + 1),
                    original(c["right"], depth + 1), original(e["whenTrue"], depth + 1),
                    original(e["whenFalse"], depth + 1))
        demand(op in {"add", "subtract", "multiply", "ratio", "min", "max"}
               and set(e) == {"kind", "left", "right"})
        return (op, original(e["left"], depth + 1), original(e["right"], depth + 1))

    originals = {o["key"]: original(o["expression"]) for o in function["outputs"]}
    demand(len(originals) == len(function["outputs"]))
    terms, ranges, dimensions, scales = [], [], [], []
    used_inputs = set()
    nodes = protocol["nodes"]
    demand(isinstance(nodes, list) and len(nodes) <= 1024)
    for i, n in enumerate(nodes):
        op, s = n["op"], n["scale"]
        demand(type(s) is int and 0 <= s <= 36)
        scale = 10 ** s
        dim = n["unit"], n["currencyCode"]
        demand(dim[0] in {"currency", "count", "ratio", "multiple", "rate"}
               and (dim[0] == "currency") == (dim[1] is not None))
        common = {"op", "scale", "low", "high", "unit", "currencyCode"}
        if op == "input":
            demand(set(n) == common | {"inputIndex"} and type(n["inputIndex"]) is int
                   and 0 <= n["inputIndex"] < len(inputs))
            p = inputs[n["inputIndex"]]
            demand(n["inputIndex"] not in used_inputs and p["decimalPlaces"] == s)
            used_inputs.add(n["inputIndex"])
            term = ("input", p["key"])
            lo, hi = number(p["lower"]), number(p["upper"])
            demand((lo * scale).denominator == 1 and (hi * scale).denominator == 1
                   and -(2 ** 63) < lo * scale <= hi * scale < 2 ** 63)
            demand(dim == (p["semantics"]["unit"], p["semantics"]["currencyCode"]))
        elif op == "literal":
            demand(set(n) == common | {"value"})
            lo = hi = Fraction(integer(n["value"]), scale)
            term = ("literal", lo, *dim)
        else:
            a, b = n["left"], n["right"]
            demand(type(a) is int and type(b) is int and 0 <= a < i and 0 <= b < i)
            al, ah = ranges[a]
            bl, bh = ranges[b]
            ad, bd = dimensions[a], dimensions[b]
            if op in {"add", "subtract", "min", "max", "if"}:
                af, bf = integer(n["leftFactor"]), integer(n["rightFactor"])
                demand(af > 0 and bf > 0 and af * scales[a] == bf * scales[b])
                demand(max(abs(al * scales[a] * af), abs(ah * scales[a] * af),
                           abs(bl * scales[b] * bf), abs(bh * scales[b] * bf)) < MAXIMUM)
                demand(ad == bd)
            if op == "if":
                demand(set(n) == common | {"left", "right", "leftFactor", "rightFactor",
                       "comparison", "whenTrue", "whenFalse", "trueFactor", "falseFactor"})
                y, z = n["whenTrue"], n["whenFalse"]
                demand(type(y) is int and type(z) is int and 0 <= y < i and 0 <= z < i)
                demand(dimensions[y] == dimensions[z] == dim)
                demand(integer(n["trueFactor"]) * scales[y] == scale
                       and integer(n["falseFactor"]) * scales[z] == scale)
                demand(n["comparison"] in {"lt", "lte", "eq", "gte", "gt"})
                lo, hi = min(ranges[y][0], ranges[z][0]), max(ranges[y][1], ranges[z][1])
                term = ("if", n["comparison"], terms[a], terms[b], terms[y], terms[z])
            elif op == "multiply":
                demand(set(n) == common | {"left", "right"})
                demand(scales[a] * scales[b] == scale)
                dimensionless = lambda d: d[0] in {"count", "rate", "ratio", "multiple"} and d[1] is None
                demand(dimensionless(ad) or dimensionless(bd))
                demand(dim == (ad if dimensionless(bd) else bd))
                extrema = [x * y for x in (al, ah) for y in (bl, bh)]
                lo, hi = min(extrema), max(extrema)
                term = (op, terms[a], terms[b])
            elif op == "ratio":
                demand(set(n) == common | {"left", "right", "numeratorFactor", "denominatorFactor"})
                nf, df = integer(n["numeratorFactor"]), integer(n["denominatorFactor"])
                demand(nf > 0 and df > 0 and s == 18 and ad == bd and dim == ("multiple", None))
                demand(Fraction(nf, df * scale) == Fraction(scales[b], scales[a]))
                demand(max(abs(al * scales[a] * nf), abs(ah * scales[a] * nf),
                           abs(bl * scales[b] * df), abs(bh * scales[b] * df)) < MAXIMUM)
                # Nonzero denominator's integer encoding has magnitude at least 1.
                maximum = max(abs(al), abs(ah)) * scales[b]
                lo, hi = -maximum, maximum
                term = (op, terms[a], terms[b])
            else:
                demand(op in {"add", "subtract", "min", "max"}
                       and set(n) == common | {"left", "right", "leftFactor", "rightFactor"})
                demand(integer(n["leftFactor"]) * scales[a] == scale
                       and integer(n["rightFactor"]) * scales[b] == scale and dim == ad)
                if op == "add":
                    lo, hi = al + bl, ah + bh
                elif op == "subtract":
                    lo, hi = al - bh, ah - bl
                elif op == "min":
                    lo, hi = min(al, bl), min(ah, bh)
                else:
                    lo, hi = max(al, bl), max(ah, bh)
                term = (op, terms[a], terms[b])
        claimed_lo, claimed_hi = integer(n["low"]), integer(n["high"])
        demand(-MAXIMUM < claimed_lo <= lo * scale <= hi * scale <= claimed_hi < MAXIMUM)
        terms.append(term)
        ranges.append((Fraction(claimed_lo, scale), Fraction(claimed_hi, scale)))
        dimensions.append(dim)
        scales.append(scale)
    demand(used_inputs == set(range(len(inputs))))
    reachable = set()

    def visit(index):
        if index in reachable:
            return
        demand(type(index) is int and 0 <= index < len(nodes))
        reachable.add(index)
        for k in ("left", "right", "whenTrue", "whenFalse"):
            if k in nodes[index]:
                visit(nodes[index][k])

    output_keys = set()
    for o in protocol["outputs"]:
        demand(set(o) == {"key", "register", "scale", "recipients"} and o["key"] not in output_keys)
        output_keys.add(o["key"])
        declaration = next(p for p in function["outputs"] if p["key"] == o["key"])
        index = o["register"]
        visit(index)
        demand(terms[index] == originals[o["key"]] and 10 ** o["scale"] == scales[index]
               and declaration["recipients"] == o["recipients"])
        demand(dimensions[index] == (declaration["semantics"]["unit"], declaration["semantics"]["currencyCode"]))
    demand(output_keys == set(originals) and reachable == set(range(len(nodes))))
    return {"schema": "finnor.y4.correspondence-receipt.v1", "status": "CHECKED",
            "functionDigest": sha(function), "protocolDigest": sha(protocol),
            "profileDigest": hashlib.sha256(P_BYTES).hexdigest(),
            "checkerDigest": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "basis": "ORDERED_TERM_CONGRUENCE_AND_ALL_DOMAIN_INTEGER_ENCLOSURES",
            "checkedNodes": len(nodes), "checkedOutputs": len(output_keys),
            "backendTranslationTheorem": False, "protectedAdmission": False}


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(1048577)
        demand(len(raw) <= 1048576)
        request = json.loads(raw)
        print(stable(check(request["function"], request["protocol"])))
    except (ValueError, KeyError, TypeError, StopIteration, IndexError, RecursionError, OverflowError):
        print('{"status":"REJECTED","predicate":"INDEPENDENT_CORRESPONDENCE_UNPASSED"}')
        sys.exit(2)
