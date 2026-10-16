"""Independent R8 acceptance owner. No producer, Rosette or lowering imports.

JSON-lines transport is bounded. Every CHUNK generates its own original inputs,
enumerates all eight actions and interprets the supplied operational AST.
"""
import hashlib
import json
import resource
import sys
import time

PROFILE = "r8-three-optional-projects-integer-v1"
ORDER = ["c1", "c2", "c3", "v1", "v2", "v3"]
COUNT = 262144
SCHEMA = "finnor.r8.integer-program.v1"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def fields(value, names):
    require(type(value) is dict and set(value) == set(names), "GRAMMAR_FIELDS")


def integer(value):
    return type(value) is int


def decode(index):
    require(integer(index) and 0 <= index < COUNT, "DOMAIN_INDEX")
    remaining = index
    coordinates = [0] * 6
    for position in range(5, -1, -1):
        remaining, coordinates[position] = divmod(remaining, 8)
    encoded = 0
    for coordinate in coordinates:
        encoded = encoded * 8 + coordinate
    require(encoded == index and remaining == 0, "DOMAIN_BIJECTION")
    return coordinates


def oracle(coordinates):
    require(type(coordinates) is list and len(coordinates) == 6
            and all(integer(v) and 0 <= v <= 7 for v in coordinates), "ORIGINAL_DOMAIN")
    rows = []
    best_value = -1
    alternatives = []
    for mask in range(8):
        cost = 0
        value = 0
        for project in range(3):
            if (mask >> project) & 1:
                cost += coordinates[project]
                value += coordinates[project + 3]
        feasible = cost <= 7
        rows.append({"mask": mask, "cost": cost, "value": value, "feasible": feasible})
        if feasible and value > best_value:
            best_value = value
            alternatives = [mask]
        elif feasible and value == best_value:
            alternatives.append(mask)
    require(len(rows) == 8 and alternatives and rows[0]["feasible"], "NONEMPTY_ACTION_FAMILY")
    return {"mask": min(alternatives), "value": best_value, "optimalMasks": alternatives, "rows": rows}


def validate(program):
    fields(program, ["schema", "profile", "inputOrder", "semantics", "body", "output", "bounds"])
    require(program["schema"] == SCHEMA and program["profile"] == PROFILE
            and program["inputOrder"] == ORDER and program["semantics"] == "EXACT_INTEGER", "ORIGINAL_PROFILE")
    fields(program["bounds"], ["steps", "integerAbs"])
    require(program["bounds"] == {"steps": 1024, "integerAbs": 63}, "DECLARED_BOUNDS")
    require(len(canonical(program).encode()) <= 16384, "GRAMMAR_BYTES")
    nodes = [0]
    loops = [0]
    counting = [True]
    names = set()

    def count(depth):
        if counting[0]:
            nodes[0] += 1
        require(nodes[0] <= 512 and depth <= 24, "GRAMMAR_NODES_DEPTH")

    def name(value):
        require(type(value) is str and value.isascii() and 1 <= len(value) <= 32
                and value[0].isalpha() and all(v.isalnum() or v == "_" for v in value), "LOCAL_NAME")
        names.add(value)
        require(len(names) <= 32, "LOCAL_COUNT")

    def expression(expr, environment, depth):
        count(depth)
        require(type(expr) is dict and type(expr.get("op")) is str, "EXPRESSION")
        op = expr["op"]
        if op == "int":
            fields(expr, ["op", "value"])
            require(integer(expr["value"]) and -21 <= expr["value"] <= 21, "INTEGER_LITERAL")
            return "int", expr["value"], expr["value"]
        if op == "bool":
            fields(expr, ["op", "value"])
            require(type(expr["value"]) is bool, "BOOLEAN_LITERAL")
            return "bool", 0, 1
        if op == "input":
            fields(expr, ["op", "index"])
            require(integer(expr["index"]) and 0 <= expr["index"] < 6, "INPUT_REFERENCE")
            return "int", 0, 7
        if op == "local":
            fields(expr, ["op", "name"])
            name(expr["name"])
            require(expr["name"] in environment, "UNINITIALIZED_LOCAL")
            return environment[expr["name"]]
        if op == "member":
            fields(expr, ["op", "mask", "project"])
            bound = expression(expr["mask"], environment, depth + 1)
            require(bound[0] == "int" and 0 <= bound[1] <= bound[2] <= 7
                    and integer(expr["project"]) and 0 <= expr["project"] < 3, "MEMBERSHIP")
            return "bool", 0, 1
        if op == "not":
            fields(expr, ["op", "value"])
            require(expression(expr["value"], environment, depth + 1)[0] == "bool", "BOOLEAN_TYPE")
            return "bool", 0, 1
        if op == "if":
            fields(expr, ["op", "condition", "then", "else"])
            require(expression(expr["condition"], environment, depth + 1)[0] == "bool", "BOOLEAN_TYPE")
            yes = expression(expr["then"], environment, depth + 1)
            no = expression(expr["else"], environment, depth + 1)
            require(yes[0] == no[0], "BRANCH_TYPE")
            return yes[0], min(yes[1], no[1]), max(yes[2], no[2])
        require(op in ("add", "sub", "mul", "lt", "lte", "eq", "gte", "gt", "and", "or"), "FORBIDDEN_OPERATION")
        fields(expr, ["op", "left", "right"])
        left = expression(expr["left"], environment, depth + 1)
        right = expression(expr["right"], environment, depth + 1)
        if op in ("and", "or"):
            require(left[0] == right[0] == "bool", "BOOLEAN_TYPE")
            return "bool", 0, 1
        require(left[0] == right[0] == "int", "INTEGER_TYPE")
        if op in ("lt", "lte", "eq", "gte", "gt"):
            return "bool", 0, 1
        if op == "add":
            low, high = left[1] + right[1], left[2] + right[2]
        elif op == "sub":
            low, high = left[1] - right[2], left[2] - right[1]
        else:
            products = [a * b for a in left[1:] for b in right[1:]]
            low, high = min(products), max(products)
        require(-63 <= low <= high <= 63, "INTEGER_GROWTH")
        return "int", low, high

    def statements(items, environment, depth):
        require(type(items) is list and len(items) <= 32, "STATEMENT_LIST")
        environment = dict(environment)
        for statement in items:
            count(depth)
            require(type(statement) is dict, "STATEMENT")
            op = statement.get("op")
            if op == "set":
                fields(statement, ["op", "name", "value"])
                name(statement["name"])
                bound = expression(statement["value"], environment, depth + 1)
                if statement["name"] in environment:
                    require(environment[statement["name"]][0] == bound[0], "ASSIGNMENT_TYPE")
                environment[statement["name"]] = bound
            elif op == "if":
                fields(statement, ["op", "condition", "then", "else"])
                require(expression(statement["condition"], environment, depth + 1)[0] == "bool", "BOOLEAN_TYPE")
                yes = statements(statement["then"], environment, depth + 1)
                no = statements(statement["else"], environment, depth + 1)
                for key in yes.keys() & no.keys():
                    require(yes[key][0] == no[key][0], "BRANCH_TYPE")
                    environment[key] = (yes[key][0], min(yes[key][1], no[key][1]), max(yes[key][2], no[key][2]))
            elif op == "for":
                fields(statement, ["op", "name", "from", "to", "step", "body"])
                loops[0] += 1
                require(loops[0] <= 1, "LOOP_COUNT")
                name(statement["name"])
                start, end, step = statement["from"], statement["to"], statement["step"]
                require(all(integer(v) and -21 <= v <= 21 for v in (start, end, step)) and step in (-1, 1), "LOOP_UPDATE")
                values = list(range(start, end, step))
                require(1 <= len(values) <= 7 and all(0 <= v <= 7 for v in values), "LOOP_ITERATIONS")
                original_counting = counting[0]
                for iteration, value in enumerate(values):
                    counting[0] = original_counting and iteration == 0
                    environment[statement["name"]] = ("int", value, value)
                    environment = statements(statement["body"], environment, depth + 1)
                counting[0] = original_counting
            else:
                raise ValueError("FORBIDDEN_STATEMENT")
        return environment

    environment = statements(program["body"], {}, 0)
    require(program["output"] in environment and environment[program["output"]][0] == "int", "OUTPUT_TYPE")
    return {"nodes": nodes[0], "loops": loops[0], "integerAbs": 63, "steps": 1024}


def interpret(program, coordinates):
    environment = {}
    used = 0
    largest = 0

    def tick():
        nonlocal used
        used += 1
        require(used <= 1024, "FUEL_EXHAUSTED")

    def expression(expr):
        nonlocal largest
        tick()
        op = expr["op"]
        if op in ("int", "bool"):
            result = expr["value"]
        elif op == "input":
            result = coordinates[expr["index"]]
        elif op == "local":
            result = environment[expr["name"]]
        elif op == "member":
            result = bool((expression(expr["mask"]) >> expr["project"]) & 1)
        elif op == "if":
            result = expression(expr["then"] if expression(expr["condition"]) else expr["else"])
        elif op == "not":
            result = not expression(expr["value"])
        elif op == "and":
            result = expression(expr["left"]) and expression(expr["right"])
        elif op == "or":
            result = expression(expr["left"]) or expression(expr["right"])
        else:
            left, right = expression(expr["left"]), expression(expr["right"])
            if op == "add":
                result = left + right
            elif op == "sub":
                result = left - right
            elif op == "mul":
                result = left * right
            elif op == "lt":
                result = left < right
            elif op == "lte":
                result = left <= right
            elif op == "eq":
                result = left == right
            elif op == "gte":
                result = left >= right
            elif op == "gt":
                result = left > right
            else:
                raise ValueError("FORBIDDEN_OPERATION")
        if integer(result):
            largest = max(largest, abs(result))
            require(abs(result) <= 63, "INTEGER_GROWTH")
        return result

    def statements(items):
        for statement in items:
            tick()
            if statement["op"] == "set":
                environment[statement["name"]] = expression(statement["value"])
            elif statement["op"] == "if":
                statements(statement["then"] if expression(statement["condition"]) else statement["else"])
            else:
                for value in range(statement["from"], statement["to"], statement["step"]):
                    tick()
                    environment[statement["name"]] = value
                    statements(statement["body"])
    statements(program["body"])
    output = environment[program["output"]]
    require(integer(output), "OUTPUT_INTEGER")
    return output, used, largest


def inspect(program, coordinates, emitted=None):
    reference = oracle(coordinates)
    output, steps, largest = interpret(program, coordinates)
    legal = integer(output) and 0 <= output <= 7
    selected = reference["rows"][output] if legal else None
    failures = []
    if not legal:
        failures.append("ILLEGAL_OUTPUT")
    elif not selected["feasible"]:
        failures.append("INFEASIBLE_OUTPUT")
    else:
        if selected["value"] != reference["value"]:
            failures.append("UTILITY_GAP")
        if output != reference["mask"]:
            failures.append("TIE_OR_OPTIMUM")
    if emitted is not None and emitted != output:
        failures.append("EMITTED_INTERPRETER_DISAGREEMENT")
    return {"input": coordinates, "output": output, "reference": reference, "failures": failures,
            "gap": reference["value"] - selected["value"] if selected and selected["feasible"] else None,
            "steps": steps, "maximumIntegerAbs": largest, "emitted": emitted}


def operation(request):
    fields(request, ["operation", "program", "input"])
    program = request["program"]
    structural = validate(program)
    if request["operation"] == "VALIDATE":
        return {"structural": structural, "programDigest": digest(program)}
    if request["operation"] == "WITNESS":
        fields(request["input"], ["coordinates", "emitted"])
        return inspect(program, request["input"]["coordinates"], request["input"]["emitted"])
    require(request["operation"] == "CHUNK", "CHECKER_OPERATION")
    fields(request["input"], ["start", "count"])
    start, count = request["input"]["start"], request["input"]["count"]
    require(integer(start) and integer(count) and 0 <= start < COUNT
            and 1 <= count <= 4096 and start + count <= COUNT, "COVERAGE_CHUNK")
    inputs, expected, interpreted, optimal_sets = [], [], [], []
    total_steps, largest = 0, 0
    input_hash = hashlib.sha256()
    for index in range(start, start + count):
        coordinates = decode(index)
        witness = inspect(program, coordinates)
        if witness["failures"]:
            return {"status": "FAIL", "index": index, "witness": witness, "checked": index - start + 1}
        inputs.append(coordinates)
        expected.append(witness["reference"]["mask"])
        interpreted.append(witness["output"])
        optimal_sets.append(sum(1 << m for m in witness["reference"]["optimalMasks"]))
        total_steps += witness["steps"]
        largest = max(largest, witness["maximumIntegerAbs"])
        input_hash.update((canonical([index, coordinates]) + "\n").encode())
    return {"status": "PASS", "start": start, "count": count, "pairs": count * 8,
            "inputs": inputs, "expected": expected, "interpreted": interpreted, "optimalSets": optimal_sets,
            "inputDigest": input_hash.hexdigest(), "outputDigest": digest(expected),
            "steps": total_steps, "maximumIntegerAbs": largest, "structural": structural}


if __name__ == "__main__":
    for line in sys.stdin:
        began = time.monotonic()
        try:
            require(len(line.encode()) <= 262144, "CHECKER_TRANSPORT_BOUND")
            result = operation(json.loads(line))
            result["checker"] = {"identity": hashlib.sha256(open(__file__, "rb").read()).hexdigest(),
                                 "python": sys.version, "cpuSeconds": time.process_time(),
                                 "maximumRss": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                                 "elapsedMs": (time.monotonic() - began) * 1000}
            print(canonical({"ok": True, "result": result}), flush=True)
        except Exception as error:
            print(canonical({"ok": False, "reason": str(error)}), flush=True)
