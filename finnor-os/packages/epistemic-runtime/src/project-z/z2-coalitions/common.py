"""Bounded arithmetic and process transport, not a shared game compiler."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import resource
import sys
import time
from fractions import Fraction

ROOT = Path(__file__).resolve().parent
PROFILE_BYTES = (ROOT/"profile.json").read_bytes()
PROFILE = json.loads(PROFILE_BYTES)
PROFILE_DIGEST = hashlib.sha256(PROFILE_BYTES).hexdigest()
NATIVE_ROOT = ROOT.parents[3]/"private-equity/src/interaction-synthesis"
START = time.monotonic()


class Rejected(Exception):
    pass


class Incomplete(Exception):
    pass


class Unsupported(Exception):
    pass


def need(value, reason):
    if not value:
        raise Rejected(reason)


def bounded(value):
    if value.numerator.bit_length() > 512 or value.denominator.bit_length() > 512:
        raise Incomplete("Z2_ARITHMETIC_BOUND")
    return Q(value.numerator, value.denominator)


class Q(Fraction):
    def __new__(cls, n=0, d=None):
        value = Fraction(n) if d is None else Fraction(n, d)
        if value.numerator.bit_length() > 512 or value.denominator.bit_length() > 512:
            raise Incomplete("Z2_ARITHMETIC_BOUND")
        return super().__new__(cls, value.numerator, value.denominator)

    def __add__(self, other):
        return bounded(Fraction.__add__(self, other))
    __radd__ = __add__

    def __sub__(self, other):
        return bounded(Fraction.__sub__(self, other))

    def __rsub__(self, other):
        return bounded(Fraction(other)-Fraction(self))

    def __mul__(self, other):
        return bounded(Fraction.__mul__(self, other))
    __rmul__ = __mul__

    def __truediv__(self, other):
        return bounded(Fraction.__truediv__(self, other))

    def __neg__(self):
        return Q(-self.numerator, self.denominator)


def rat(value):
    need(type(value) is str and len(value) <= 400 and re.fullmatch(r"-?(0|[1-9][0-9]*)(/[1-9][0-9]*)?", value),
         "Z2_CANONICAL_RATIONAL")
    result = Q(value)
    need(str(result) == value, "Z2_CANONICAL_RATIONAL")
    return result


def canonical(value):
    def ordered(v):
        if isinstance(v, dict):
            return {k: ordered(v[k]) for k in sorted(v, key=lambda k: k.encode("utf-16be", "surrogatepass"))}
        if isinstance(v, list):
            return [ordered(x) for x in v]
        return v
    return json.dumps(ordered(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def load_native(name="checker"):
    path = NATIVE_ROOT/(name+".py")
    spec = importlib.util.spec_from_file_location("z2_native_"+name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # The Z2 domain has the stricter arithmetic bound. Native Y3's larger
    # unmarked domain is not changed, and exhaustion never establishes absence.
    bounded_checker = module if name == "checker" else module.checker
    bounded_checker.MAX_BITS = min(bounded_checker.MAX_BITS, PROFILE["maxRationalBits"])
    return module


def guard_problem(problem, native):
    if type(problem) is not dict or type(problem.get("participants")) is not list:
        raise Unsupported("Z2_ORIGINAL_PROBLEM_REQUIRED")
    if not 2 <= len(problem["participants"]) <= 4:
        raise Unsupported("Z2_PARTICIPANT_BOUND")
    if len(problem["participants"]) > 2 and native.PROFILE["protocol_horizon_and_deviation_classes"]["parties"] != [2, 4]:
        raise Unsupported("Z2_MATCHED_NATIVE_MULTIPARTICIPANT_OWNER_PATCH_REQUIRED")
    if len(canonical(problem).encode()) > PROFILE["maxRequestBytes"]:
        raise Unsupported("Z2_REQUEST_BYTE_BOUND")
    native.schema(problem)
    quantities = [p["outsideOption"] for p in problem["participants"]]
    quantities += [problem["goal"]["minimumOwnerValue"], *problem["resourceLimits"].values()]
    quantities += problem["financialLimits"]["absolutePayments"] + problem["financialLimits"]["liabilities"]
    for v in quantities:
        rat(v["value"])
    for model in problem["models"]:
        for n in model["nodes"]:
            for v in [*n["payments"], *n["liabilities"], *n["resources"].values()]:
                rat(v)
            if n["kind"] == "CHANCE":
                for edge in n["edges"]:
                    rat(edge["probability"])
            if n["kind"] == "TERMINAL":
                for v in [*n["payoff"], n["ownerValue"]]:
                    rat(v)
    keys = native.control_keys(problem)
    count = 1
    for v in keys.values():
        count *= len(v["options"])
    if count > PROFILE["maxCandidatePolicies"]:
        raise Unsupported("Z2_ORIGINAL_POLICY_BOUND")
    return keys


def guard_candidate(candidate):
    joint_trembles = {}
    for row in candidate["strategy"].values():
        for value in row.values():
            rat(value)
    for model in candidate["models"]:
        for row in model["beliefs"].values():
            for value in row.values():
                rat(value)
        for key, row in model["trembles"].items():
            zero_rates = {}
            for action, entry in row.items():
                rat(entry["coefficient"])
                if candidate["strategy"].get(key, {}).get(action) == "0":
                    zero_rates[action] = (entry["order"], rat(entry["coefficient"]))
            need(key not in joint_trembles or joint_trembles[key] == zero_rates,
                 "Z2_GLOBAL_COMMON_TREMBLE_CONFLICT")
            joint_trembles[key] = zero_rates
    rat(candidate["objective"]); rat(candidate["upperBound"])


def check_deadline(deadline):
    if time.monotonic() >= deadline:
        raise Incomplete("Z2_REMAINING_PROCESS_DEADLINE")


def unique_object(pairs):
    result = {}
    for k, v in pairs:
        need(k not in result, "Z2_DUPLICATE_JSON_KEY")
        result[k] = v
    return result


def read_request():
    memory = PROFILE["maxProcessMemoryBytes"]
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    seconds = PROFILE["maxProcessWallMs"]//1000
    resource.setrlimit(resource.RLIMIT_CPU, (seconds, seconds))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    sys.setrecursionlimit(10000)
    maximum = PROFILE["maxRequestBytes"] + PROFILE["maxArtifactBytes"] + 65536
    raw = sys.stdin.buffer.read(maximum+1)
    need(len(raw) <= maximum, "Z2_PROCESS_INPUT_BOUND")
    return json.loads(raw, object_pairs_hook=unique_object,
                      parse_constant=lambda _: need(False, "Z2_NON_JSON_NUMBER"))


def emit(value, asset):
    usage = resource.getrusage(resource.RUSAGE_SELF)
    value["meters"] = {"wallMs": int((time.monotonic()-START)*1000),
                       "cpuMs": int((usage.ru_utime+usage.ru_stime)*1000),
                       "peakRssBytes": usage.ru_maxrss*1024,
                       "moneyUsd": None, "humanSeconds": None, "aggregatePeakMemoryBytes": None,
                       "status": "PARTIALLY_METERED"}
    value["profileDigest"] = PROFILE_DIGEST
    value["processDigest"] = hashlib.sha256((ROOT/asset).read_bytes()).hexdigest()
    value["protectedQualification"] = False
    value["executionAuthorityGranted"] = False
    data = canonical(value)
    need(len(data.encode()) <= PROFILE["maxOutputBytes"], "Z2_PROCESS_OUTPUT_BOUND")
    sys.stdout.write(data)
