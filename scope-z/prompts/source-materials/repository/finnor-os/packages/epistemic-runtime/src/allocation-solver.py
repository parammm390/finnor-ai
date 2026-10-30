"""Replaceable, bounded numerical MILP producer; owns no allocation semantics.

Original canonical exact checking and all reservation/authority decisions remain
outside this numerical adapter. Failure model is preregistered under scope-5.
"""
import json, math, re, resource, sys, time, warnings
from fractions import Fraction

START = time.monotonic()
MAX_BYTES = 8 * 1024 * 1024
DECIMAL = re.compile(r"^-?(?:0|[1-9]\d*)(?:\.\d{1,48})?$")
RATIONAL = re.compile(r"^-?(?:0|[1-9]\d*)/[1-9]\d*$")
EXACT_RATIONAL_V2 = False

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result

def exact(value):
    if EXACT_RATIONAL_V2 and isinstance(value, str) and RATIONAL.fullmatch(value):
        numerator, denominator = value.split("/")
        if len(numerator) > 512 or len(denominator) > 512:
            raise ValueError("RATIONAL_INTEGER_GROWTH_BOUND")
        result = Fraction(int(numerator), int(denominator))
    elif not isinstance(value, str) or len(value) > 96 or not DECIMAL.fullmatch(value):
        raise ValueError("NONCANONICAL_FINITE_DECIMAL")
    else:
        result = Fraction(value)
    if abs(result) > 10 ** 24:
        raise ValueError("NUMERICAL_MAGNITUDE_DOMAIN")
    return result

def finite(value):
    return float(value) if value is not None and math.isfinite(float(value)) else None

def row_numbers(row, n, integrality):
    if set(row) != {"id", "coefficients", "lower", "upper"} or not isinstance(row["id"], str):
        raise ValueError("ROW_SCHEMA")
    coefficients = row["coefficients"]
    if not isinstance(coefficients, dict) or len(coefficients) > n:
        raise ValueError("ROW_COEFFICIENT_LIMIT")
    qs = {}
    for key, value in coefficients.items():
        if not key.isdigit() or str(int(key)) != key or not 0 <= int(key) < n:
            raise ValueError("UNKNOWN_COLUMN")
        q = exact(value)
        if q:
            qs[int(key)] = q
    bounds = [None if row[k] is None else exact(row[k]) for k in ("lower", "upper")]
    # Scale exact terminating decimal rows into primitive integers where their
    # integer range remains representable. Otherwise refuse meaningful tiny
    # coefficients rather than allow HiGHS to discard them silently.
    denom = 1
    for q in qs.values():
        denom = math.lcm(denom, q.denominator)
    integers = [q.numerator * (denom // q.denominator) for q in qs.values()]
    common = 0
    for i in integers:
        common = math.gcd(common, abs(i))
    scale = Fraction(denom, common or 1)
    scaled = bool(integers) and max(abs(q * scale) for q in qs.values()) <= 10 ** 12
    if scaled:
        qs = {i: q * scale for i, q in qs.items()}
        bounds = [None if q is None else q * scale for q in bounds]
        # Every integral-column LHS is an exact integer. Taking ceil/floor of
        # its exact bounds preserves the feasible integer set, including a
        # cash margin many orders below the solver's float tolerance.
        if all(integrality[i] == 1 for i in qs):
            bounds = [None if bounds[0] is None else Fraction(math.ceil(bounds[0])),
                      None if bounds[1] is None else Fraction(math.floor(bounds[1]))]
    numeric = {i: float(q) for i, q in qs.items()}
    if any(not math.isfinite(v) or abs(v) <= 1e-9 or abs(v) > 1e12 for v in numeric.values()):
        raise ValueError("UNSAFE_COEFFICIENT_SCALING")
    lower = -math.inf if bounds[0] is None else float(bounds[0])
    upper = math.inf if bounds[1] is None else float(bounds[1])
    if bounds[0] is not None and Fraction(lower) < bounds[0]:
        lower = math.nextafter(lower, math.inf)
    if bounds[1] is not None and Fraction(upper) > bounds[1]:
        upper = math.nextafter(upper, -math.inf)
    if lower > upper or any(abs(q) > 10 ** 15 for q in bounds if q is not None):
        raise ValueError("UNSAFE_ROW_BOUNDS")
    return numeric, lower, upper

result = {"schema": "finnor.s5.milp-result.v1", "status": "NUMERICAL_FAILURE", "vector": None,
          "minObjective": None, "minDualBound": None, "mipGap": None, "nodeCount": None,
          "termination": "NOT_INVOKED", "dualProposal": None, "backend": {"pythonVersion": sys.version.split()[0], "scipyVersion": None, "numpyVersion": None, "highsVersion": None},
          "usage": {}, "warnings": []}
try:
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("INPUT_BYTE_LIMIT")
    p = json.loads(data, object_pairs_hook=unique_object, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("NONFINITE_JSON")))
    base_keys = {"schema", "c", "integrality", "lowerBounds", "upperBounds", "rows", "budget"}
    EXACT_RATIONAL_V2 = p.get("schema") == "finnor.s5.milp.rational.v2" and p.get("quantityEncoding") == "DECIMAL_OR_RATIONAL_V2"
    if not ((set(p) == base_keys and p.get("schema") == "finnor.s5.milp.v1") or (EXACT_RATIONAL_V2 and set(p) == base_keys | {"quantityEncoding"})):
        raise ValueError("INPUT_SCHEMA")
    n = len(p["c"])
    if not 1 <= n <= 1024 or any(len(p[k]) != n for k in ("integrality", "lowerBounds", "upperBounds")) or not isinstance(p["rows"], list) or len(p["rows"]) > 30000:
        raise ValueError("STRUCTURAL_LIMIT")
    if any(type(v) is not int or v not in (0, 1) for v in p["integrality"]):
        raise ValueError("INTEGRALITY_SCHEMA")
    if len(set(row["id"] for row in p["rows"])) != len(p["rows"]):
        raise ValueError("DUPLICATE_CONSTRAINT")
    budget = p["budget"]
    if set(budget) != {"deadlineMs", "nodeLimit"} or type(budget["deadlineMs"]) is not int or not 1 <= budget["deadlineMs"] <= 30000 or type(budget["nodeLimit"]) is not int or not 1 <= budget["nodeLimit"] <= 50000:
        raise ValueError("BUDGET_SCHEMA")
    import numpy as np
    import scipy
    from scipy.optimize import milp, linprog, Bounds, LinearConstraint
    from scipy.sparse import csc_array
    from scipy.optimize._highspy._core import HIGHS_VERSION_MAJOR, HIGHS_VERSION_MINOR, HIGHS_VERSION_PATCH
    result["backend"].update(scipyVersion=scipy.__version__, numpyVersion=np.__version__, highsVersion=f"{HIGHS_VERSION_MAJOR}.{HIGHS_VERSION_MINOR}.{HIGHS_VERSION_PATCH}")
    if scipy.__version__ != "1.16.2" or np.__version__ != "2.3.3" or result["backend"]["highsVersion"] != "1.8.0" or not sys.version.startswith("3.12."):
        raise ValueError("PINNED_BACKEND_VERSION_CHANGED")
    c = np.array([float(exact(v)) for v in p["c"]], dtype=float)
    if any(v != 0 and abs(v) < 1e-9 for v in c):
        raise ValueError("UNSAFE_OBJECTIVE_SCALE")
    lb = np.array([-math.inf if v is None else float(exact(v)) for v in p["lowerBounds"]])
    ub = np.array([math.inf if v is None else float(exact(v)) for v in p["upperBounds"]])
    if np.any(lb > ub):
        raise ValueError("VARIABLE_BOUNDS_INCONSISTENT")
    ri, ci, values, lowers, uppers = [], [], [], [], []
    for i, row in enumerate(p["rows"]):
        coefficients, lower, upper = row_numbers(row, n, p['integrality'])
        for j, v in coefficients.items():
            ri.append(i); ci.append(j); values.append(v)
        lowers.append(lower); uppers.append(upper)
        if len(values) > 1000000:
            raise ValueError("NONZERO_LIMIT")
    remaining = budget["deadlineMs"] / 1000 - (time.monotonic() - START)
    if remaining <= 0:
        result.update(status="SEARCH_EXHAUSTED", termination="ADAPTER_STARTUP_EXHAUSTED_DEADLINE")
    else:
        A = csc_array((np.array(values), (np.array(ri, dtype=np.int32), np.array(ci, dtype=np.int32))), shape=(len(p["rows"]), n))
        with warnings.catch_warnings(record=True) as observed:
            solved = milp(c, integrality=np.array(p["integrality"]), bounds=Bounds(lb, ub), constraints=LinearConstraint(A, np.array(lowers), np.array(uppers)),
                          options={"disp": False, "presolve": True, "mip_rel_gap": 0.0, "time_limit": remaining, "node_limit": budget["nodeLimit"]})
        result["warnings"] = [str(w.message)[:512] for w in observed[:8]]
        vector = solved.x.tolist() if solved.x is not None and np.all(np.isfinite(solved.x)) else None
        result.update(status={0: "OPTIMAL_NUMERICAL", 1: "FEASIBLE_NUMERICAL" if vector is not None else "SEARCH_EXHAUSTED", 2: "INFEASIBLE_NUMERICAL", 3: "UNBOUNDED_NUMERICAL"}.get(solved.status, "NUMERICAL_FAILURE"),
                      vector=vector, minObjective=finite(solved.fun), minDualBound=finite(getattr(solved, "mip_dual_bound", None)), mipGap=finite(getattr(solved, "mip_gap", None)),
                      nodeCount=getattr(solved, "mip_node_count", None), termination=str(solved.message)[:1024])
        # Original continuous rows, not integer-tightened rows. Marginals are
        # untrusted decimal proposals; the canonical checker absorbs residuals.
        lp_remaining=min(1.0,budget["deadlineMs"]/1000-(time.monotonic()-START))
        if lp_remaining>0.02 and vector is not None:
            try:
                lr,lc,lv,limits,identities=[],[],[],[],[]
                for row in p["rows"]:
                    for side,sign in (("upper",1),("lower",-1)):
                        if row[side] is None: continue
                        i=len(limits);limits.append(sign*float(exact(row[side])));identities.append((row["id"],side))
                        for key,q in row["coefficients"].items():
                            if exact(q):lr.append(i);lc.append(int(key));lv.append(sign*float(exact(q)))
                LA=csc_array((np.array(lv),(np.array(lr,dtype=np.int32),np.array(lc,dtype=np.int32))),shape=(len(limits),n))
                lp=linprog(c,A_ub=LA,b_ub=np.array(limits),bounds=[(None if not math.isfinite(l) else l,None if not math.isfinite(u) else u) for l,u in zip(lb,ub)],method="highs",options={"time_limit":lp_remaining})
                if lp.status==0:
                    ms=[]
                    for (key,side),v in zip(identities,lp.ineqlin.marginals):
                        value=-float(v)
                        if not math.isfinite(value) or not 0<value<=1e12:
                            continue
                        formatted=format(value,".18f").rstrip("0").rstrip(".")
                        if formatted and formatted!="0":
                            ms.append({"rowId":key,"side":side,"value":formatted})
                    result["dualProposal"]={"schema":"finnor.s5.dual-proposal.v1","multipliers":ms}
                    result["usage"]["lpNumericalUpperEstimate"]=-float(lp.fun)
            except Exception as error:
                result["warnings"].append("LP_PROPOSAL_UNAVAILABLE:"+str(error)[:256])

except Exception as error:
    result.update(status="NUMERICAL_FAILURE", termination=f"{type(error).__name__}:{str(error)[:1024]}")
finally:
    usage = resource.getrusage(resource.RUSAGE_SELF)
    result["usage"].update({"elapsedMs": (time.monotonic() - START) * 1000, "cpuSeconds": usage.ru_utime + usage.ru_stime,
                       "maxRssBytes": usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024,
                       "memoryScope": "CHILD_PROCESS_SELF_HIGH_WATER_NOT_CONTAINER_PEAK", "pricing": "UNMETERED"})
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))
