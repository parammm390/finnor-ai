"""Y1 independent acceptance oracle. Written before the semantic producer.

No producer imports, database, network, dynamic code or evaluator signatures.
Exact fractions and a separate hypothesis enumerator check finite claims only.
"""
import hashlib
import heapq
import itertools
import json
import re
import resource
import sys
import time
from fractions import Fraction
from pathlib import Path

PROFILE = json.loads(Path(__file__).with_name("profile.json").read_text())
resource.setrlimit(resource.RLIMIT_AS, (PROFILE["maxCheckerMemoryBytes"],) * 2)
resource.setrlimit(resource.RLIMIT_CPU, (120, 121))
resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
DECIMAL = re.compile(r"^-?(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{0,5}[1-9])?$")
IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class Refusal(Exception):
    pass


class Exhausted(Exception):
    pass


def require(value, reason):
    if not value:
        raise Refusal(reason)


def number(value):
    require(isinstance(value, str) and DECIMAL.fullmatch(value) and value != "-0",
            "NONCANONICAL_EXACT_QUANTITY")
    return Fraction(value)


def spelling(value):
    value = Fraction(value)
    for scale in range(7):
        n = value * 10 ** scale
        if n.denominator == 1:
            sign = "-" if n < 0 else ""
            digits = str(abs(n.numerator)).rjust(scale + 1, "0")
            result = sign + (digits[:-scale] + "." + digits[-scale:] if scale else digits)
            result = result.rstrip("0").rstrip(".") if "." in result else result
            require(DECIMAL.fullmatch(result) is not None, "QUANTITY_RANGE")
            return result
    raise Refusal("NONDECIMAL_RESULT")


def dimension(value):
    return [value[k] for k in ("unit", "currency", "accountingBasis", "period")]


class Oracle:
    def __init__(self, problem):
        self.p = problem
        self.steps = 0
        self.applications = 0
        self.started = time.monotonic()
        require(problem["schema"] == "finnor.economic-construction-problem.v1", "PROBLEM_SCHEMA")
        self.q = problem["quantities"]
        self.params = problem["parameters"]
        self.ops = problem["operators"]
        require(1 <= len(self.q) <= PROFILE["maxQuantities"], "QUANTITY_BOUND")
        require(len(self.params) <= PROFILE["maxParameters"], "PARAMETER_BOUND")
        require(1 <= len(self.ops) <= PROFILE["maxOperators"], "OPERATOR_BOUND")
        for group, limit in ((self.q, "maxValuesPerQuantity"), (self.params, "maxValuesPerParameter")):
            require(len({x["id"] for x in group}) == len(group), "DUPLICATE_QUANTITY")
            for item in group:
                require(IDENTIFIER.fullmatch(item["id"]) is not None, "QUANTITY_IDENTIFIER")
                values = item["values"]
                require(1 <= len(values) <= PROFILE[limit] and len(set(values)) == len(values), "VALUES_BOUND")
                require(all(number(x) >= 0 for x in values), "NEGATIVE_QUANTITY_DOMAIN")
        self.states = self.product(self.q, PROFILE["maxStateProduct"])
        self.arguments = self.product(self.params, PROFILE["maxParameterProduct"])
        self.q_by_id = {x["id"]: x for x in self.q}
        self.p_by_id = {x["id"]: x for x in self.params}
        require(len({x["id"] for x in self.ops}) == len(self.ops), "DUPLICATE_OPERATOR")
        for invariant in problem["invariants"]:
            require(invariant["terms"] and invariant["relation"] in ("EQ", "LE"), "INVARIANT_DOMAIN")
            number(invariant["constant"])
            dims = []
            for term in invariant["terms"]:
                require(term["quantityId"] in self.q_by_id and term["coefficient"] in (-1, 1), "INVARIANT_TERM")
                dims.append(dimension(self.q_by_id[term["quantityId"]]))
            require(all(x == dims[0] for x in dims), "INVARIANT_DIMENSION")
        require(any(self.safe(s) for s in self.states), "EMPTY_VALID_STATE_DOMAIN")
        for op in self.ops:
            require(IDENTIFIER.fullmatch(op["id"]) is not None, "OPERATOR_IDENTIFIER")
            require(1 <= len(op["examples"]) <= PROFILE["maxExamplesPerOperator"], "EXAMPLE_BOUND")
            require(any(e["after"] is not None for e in op["examples"]), "POSITIVE_EXAMPLE_REQUIRED")
            for e in op["examples"]:
                require(self.in_domain(e["before"], self.q) and self.safe(e["before"]), "EXAMPLE_BEFORE_DOMAIN")
                require(self.in_domain(e["parameters"], self.params), "EXAMPLE_PARAMETER_DOMAIN")
                if e["after"] is not None:
                    require(self.in_domain(e["after"], self.q) and self.safe(e["after"]), "EXAMPLE_AFTER_DOMAIN")

    def tick(self, search=False):
        if search:
            self.steps += 1
        else:
            self.applications += 1
        if self.steps > PROFILE["maxSearchSteps"] or self.applications > PROFILE["maxSemanticApplications"]:
            raise Exhausted("FROZEN_SEMANTIC_BUDGET")
        if (self.steps + self.applications) % 1024 == 0 and time.monotonic() - self.started > 118:
            raise Exhausted("FROZEN_CHECKER_DEADLINE")

    @staticmethod
    def product(items, limit):
        size = 1
        for item in items:
            size *= len(item["values"])
        require(size <= limit, "CARTESIAN_DOMAIN_BOUND")
        return [dict(zip((x["id"] for x in items), values))
                for values in itertools.product(*(x["values"] for x in items))]

    @staticmethod
    def in_domain(state, items):
        return set(state) == {x["id"] for x in items} and all(state[x["id"]] in x["values"] for x in items)

    def safe(self, state):
        if not self.in_domain(state, self.q):
            return False
        for invariant in self.p["invariants"]:
            total = sum((number(state[t["quantityId"]]) * t["coefficient"] for t in invariant["terms"]), Fraction())
            limit = number(invariant["constant"])
            if invariant["relation"] == "EQ" and total != limit or invariant["relation"] == "LE" and total > limit:
                return False
        return True

    def row_value(self, terms, state, args):
        value = Fraction()
        for t in terms:
            v = Fraction(1) if t["input"] == "ONE" else number((state if t["input"] == "STATE" else args)[t["id"]])
            value += t["coefficient"] * v
        return value

    def apply(self, body, state, args):
        self.tick()
        if not self.safe(state):
            return None
        values = {row["output"]: self.row_value(row["terms"], state, args) for row in body["rows"]}
        try:
            result = {k: spelling(v) for k, v in values.items()}
        except Refusal:
            return None
        return result if self.safe(result) else None

    def rows(self, op, target):
        inputs = [{"input": "STATE", "id": q["id"]} for q in self.q if dimension(q) == dimension(target)]
        inputs += [{"input": "PARAM", "id": p["id"]} for p in self.params if dimension(p) == dimension(target)]
        inputs += [{"input": "ONE", "id": "one"}]
        options = []
        for length in range(PROFILE["maxTermsPerRow"] + 1):
            for chosen in itertools.combinations(inputs, length):
                for signs in itertools.product((-1, 1), repeat=length):
                    self.tick(True)
                    terms = [dict(token, coefficient=sign) for token, sign in zip(chosen, signs)]
                    if all(self.row_value(terms, e["before"], e["parameters"]) == number(e["after"][target["id"]])
                           for e in op["examples"] if e["after"] is not None):
                        options.append(terms)
        options.sort(key=lambda x: (len(x), canonical(x)))
        return options

    def solve_operator(self, op):
        alternatives = [self.rows(op, q) for q in self.q]
        if any(not x for x in alternatives):
            return {"status": "INFEASIBLE", "operatorId": op["id"]}
        initial = tuple(0 for _ in self.q)
        heap = [(sum(len(x[0]) for x in alternatives), initial)]
        seen = {initial}
        best = None
        meanings = {}
        count = 0
        while heap:
            cost, indices = heapq.heappop(heap)
            if best is not None and cost > best:
                break
            count += 1
            if count > PROFILE["maxBodyCombinations"]:
                raise Exhausted("FROZEN_BODY_COMBINATION_BOUND")
            body = {"rows": [{"output": q["id"], "terms": alternatives[i][indices[i]]} for i, q in enumerate(self.q)]}
            fits = all(self.apply(body, e["before"], e["parameters"]) == e["after"] for e in op["examples"])
            if fits:
                trace = [self.apply(body, s, a) for s in self.states for a in self.arguments]
                if any(v is not None for v in trace):
                    best = cost
                    meanings.setdefault(digest(trace), body)
            for i in range(len(indices)):
                neighbor = tuple(n + (1 if i == j else 0) for j, n in enumerate(indices))
                if neighbor[i] < len(alternatives[i]) and neighbor not in seen:
                    seen.add(neighbor)
                    heapq.heappush(heap, (sum(len(alternatives[j][n]) for j, n in enumerate(neighbor)), neighbor))
        if not meanings:
            return {"status": "INFEASIBLE", "operatorId": op["id"]}
        if len(meanings) != 1:
            return {"status": "UNIDENTIFIED", "operatorId": op["id"], "alternatives": len(meanings)}
        return {"status": "CANDIDATE", "body": next(iter(meanings.values()))}

    def verify_body(self, operator):
        source = next((x for x in self.ops if x["id"] == operator["id"]), None)
        require(source is not None and len(operator["rows"]) == len(self.q), "BODY_MEMBERSHIP")
        require([r["output"] for r in operator["rows"]] == [q["id"] for q in self.q], "BODY_OUTPUT_COVERAGE")
        for row in operator["rows"]:
            require(len(row["terms"]) <= PROFILE["maxTermsPerRow"], "BODY_TERM_BOUND")
            seen = set()
            for term in row["terms"]:
                require(set(term) == {"input", "id", "coefficient"} and term["coefficient"] in (-1, 1), "BODY_TERM_SCHEMA")
                token = (term["input"], term["id"])
                require(token not in seen, "BODY_DUPLICATE_TERM")
                seen.add(token)
                if term["input"] == "ONE":
                    require(term["id"] == "one", "BODY_LITERAL")
                else:
                    table = self.q_by_id if term["input"] == "STATE" else self.p_by_id if term["input"] == "PARAM" else {}
                    require(term["id"] in table and dimension(table[term["id"]]) == dimension(self.q_by_id[row["output"]]),
                            "BODY_DIMENSION")
        require(operator["requirements"] == source["requirements"], "BODY_REQUIREMENTS")
        require(operator["guard"] == {"kind": "MAXIMAL_FINITE_SAFE_PREIMAGE",
                                     "invariantDigest": digest(self.p["invariants"])}, "BODY_GUARD")
        solution = self.solve_operator(source)
        require(solution["status"] == "CANDIDATE", "BODY_NOT_IDENTIFIED_" + solution["status"])
        expected = solution["body"]
        for state in self.states:
            for args in self.arguments:
                require(self.apply(operator, state, args) == self.apply(expected, state, args), "BODY_DENOTATION")
        reads = sorted({t["id"] for r in operator["rows"] for t in r["terms"] if t["input"] == "STATE"})
        writes = sorted(r["output"] for r in operator["rows"]
                        if r["terms"] != [{"input": "STATE", "id": r["output"], "coefficient": 1}])
        require(operator["reads"] == reads and operator["writes"] == writes, "BODY_FOOTPRINT")

    def word(self, operators, word):
        require(len(word) <= PROFILE["maxWordLength"] and all(x in operators for x in word), "LAW_WORD")
        h = hashlib.sha256()
        enabled = 0
        witness = None
        requirements = sorted({canonical(r) for x in word for r in operators[x]["requirements"]})
        for state in self.states:
            for args in self.arguments:
                current = state if self.safe(state) else None
                for identifier in word:
                    current = self.apply(operators[identifier], current, args) if current is not None else None
                result = {"state": current, "requirements": requirements} if current is not None else None
                if result is not None:
                    enabled += 1
                    witness = witness or {"before": state, "parameters": args, "after": current}
                h.update((canonical([state, args, result]) + "\n").encode())
        return h.hexdigest(), enabled, witness

    def check(self, candidate):
        require(candidate["problemDigest"] == digest(self.p) and candidate["profileDigest"] == digest(PROFILE), "CANDIDATE_INPUT")
        require(candidate["schema"] == "finnor.economic-action-theory-body.v1", "CANDIDATE_SCHEMA")
        require([x["id"] for x in candidate["operators"]] == [x["id"] for x in self.ops], "CANDIDATE_OPERATOR_COVERAGE")
        for op in candidate["operators"]:
            self.verify_body(op)
        operators = {x["id"]: x for x in candidate["operators"]}
        require(len(candidate["laws"]) <= PROFILE["maxLaws"], "LAW_BOUND")
        cache = {}
        for law in candidate["laws"]:
            require(law["left"] != law["right"], "LAW_REFLEXIVE")
            for word in (law["left"], law["right"]):
                key = tuple(word)
                if key not in cache:
                    cache[key] = self.word(operators, word)
            left, right = cache[tuple(law["left"])], cache[tuple(law["right"])]
            require(left[0] == right[0] and left[1] >= PROFILE["minimumLawEnabledWitnesses"], "LAW_FALSE_OR_VACUOUS")
            require(law["denotationDigest"] == left[0] and law["enabledWitnesses"] == left[1]
                    and law["witness"] == left[2], "LAW_CERTIFICATE")
        return {"status": "CHECKED", "operatorCount": len(operators), "lawCount": len(candidate["laws"]),
                "stateCount": len(self.states), "parameterCount": len(self.arguments),
                "traceCount": len(self.states) * len(self.arguments) * len(operators),
                "nonVacuous": True}


def main():
    started = time.monotonic()
    raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    require(len(raw) <= 8 * 1024 * 1024, "CHECKER_INPUT_BOUND")
    request = json.loads(raw)
    require(request["profile"] == PROFILE, "FROZEN_PROFILE_SUBSTITUTION")
    problem = request["problem"]
    oracle = Oracle(problem)
    if request["operation"] == "CHECK":
        result = oracle.check(request["candidate"])
        result["candidateDigest"] = digest(request["candidate"])
    elif request["operation"] == "INFEASIBLE":
        solutions = [oracle.solve_operator(op) for op in oracle.ops]
        require(any(s["status"] == "INFEASIBLE" for s in solutions), "INFEASIBILITY_NOT_EXHAUSTIVELY_ESTABLISHED")
        result = {"status": "INFEASIBLE", "exhaustiveWithinFrozenHypothesis": True, "operators": solutions}
    else:
        raise Refusal("CHECKER_OPERATION")
    return dict(result, schema="finnor.economic-theory-check.v1", problemDigest=digest(problem),
                profileDigest=digest(PROFILE), checkerDigest=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                searchSteps=oracle.steps, semanticApplications=oracle.applications,
                wallMs=(time.monotonic() - started) * 1000,
                cpuMs=time.process_time() * 1000, peakRssBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
                protectionDomain="DISPOSABLE_LOCAL_DEVELOPMENT", protectedQualification=False,
                executionAuthorityGranted=False)


try:
    answer = main()
except Exhausted as error:
    answer = {"status": "INCOMPLETE", "reason": str(error), "executionAuthorityGranted": False}
except (Refusal, KeyError, TypeError, ValueError, ZeroDivisionError) as error:
    answer = {"status": "REJECTED", "reason": str(error)[:256], "executionAuthorityGranted": False}
answer["interpreterVersion"] = sys.version.split()[0]
answer["interpreterExecutableDigest"] = hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest()
encoded = canonical(answer)
if len(encoded.encode()) > PROFILE["maxCheckerOutputBytes"]:
    encoded = canonical({"status": "UNKNOWN", "reason": "CHECKER_OUTPUT_BOUND", "executionAuthorityGranted": False})
print(encoded)
