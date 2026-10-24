"""Public independent original-Work interpreter. Never executes the shared DAG.

No protected custody, source truth, native admission or effect authority is
claimed. Stdlib Fraction supplies arithmetic independently of the TS producer.
"""
import copy
import functools
import hashlib
import json
import re
import resource
import sys
from fractions import Fraction
from graphlib import TopologicalSorter

resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (12, 12))


class Rejected(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Rejected(code)


def stable(value):
    if isinstance(value, dict):
        return "{" + ",".join(stable(key) + ":" + stable(value[key]) for key in sorted(value, key=lexical)) + "}"
    if isinstance(value, list):
        return "[" + ",".join(stable(item) for item in value) + "]"
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha(value):
    return hashlib.sha256(stable(value).encode("utf-8")).hexdigest()


def lexical(value):
    return value.encode("utf-16-be", errors="surrogatepass")


def quantity(value):
    need(isinstance(value, str) and len(value) <= 312 and
         re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:/[1-9][0-9]*)?", value), "EXACT_RATIONAL_TEXT_REQUIRED")
    value = Fraction(value)
    need(abs(value.numerator).bit_length() <= 512 and value.denominator.bit_length() <= 512, "RATIONAL_COMPONENT_BOUND")
    return value


def qtext(value):
    value = Fraction(value)
    need(abs(value.numerator).bit_length() <= 512 and value.denominator.bit_length() <= 512, "RATIONAL_COMPONENT_BOUND")
    return str(value.numerator) if value.denominator == 1 else str(value.numerator) + "/" + str(value.denominator)


def number_type(t):
    return t["kind"] in ("integer", "rational")


def scalar(value, t):
    if number_type(t):
        n = quantity(value)
        need(t["kind"] != "integer" or n.denominator == 1, "INTEGER_TYPE_MISMATCH")
        need((t["unit"] == "money") == (t["currency"] is not None), "CURRENCY_UNIT_MISMATCH")
        return qtext(n)
    need(type(value) is (str if t["kind"] == "text" else bool), "SCALAR_TYPE_MISMATCH")
    return value


def normalize(row, columns):
    need(set(row) == set(columns), "EXACT_ROW_SCHEMA_REQUIRED")
    return {k: scalar(row[k], t) for k, t in columns.items()}


def expression_type(e, columns, parameters):
    op = e["op"]
    if op == "field":
        return columns[e["name"]]
    if op in ("literal", "param"):
        value = e if op == "literal" else parameters[e["name"]]
        scalar(value["value"], value["type"])
        return value["type"]
    if op == "round":
        t = expression_type(e["value"], columns, parameters)
        need(number_type(t), "ROUND_NUMERIC_REQUIRED")
        return dict(t, kind="rational")
    lt, rt = expression_type(e["left"], columns, parameters), expression_type(e["right"], columns, parameters)
    need(number_type(lt) and number_type(rt), "NUMERIC_EXPRESSION_REQUIRED")
    kind = "integer" if op != "div" and lt["kind"] == rt["kind"] == "integer" else "rational"
    same_unit = lt["unit"] == rt["unit"] and lt["currency"] == rt["currency"]
    dimensionless = lambda t: t["unit"] == "1" and t["currency"] is None
    if op in ("add", "sub"):
        need(same_unit, "ARITHMETIC_UNIT_MISMATCH")
        return dict(lt, kind=kind)
    if op == "mul":
        need(dimensionless(lt) or dimensionless(rt), "UNDECLARED_PRODUCT_UNIT")
        return dict(rt if dimensionless(lt) else lt, kind=kind)
    need(op == "div" and (dimensionless(rt) or same_unit), "DIVISION_TYPE_INVALID")
    return dict(lt, kind=kind) if dimensionless(rt) else {"kind": kind, "unit": "1", "currency": None}


def predicate_types(p, columns, parameters):
    if p["op"] in ("and", "or"):
        for item in p["args"]:
            predicate_types(item, columns, parameters)
    elif p["op"] == "not":
        predicate_types(p["arg"], columns, parameters)
    else:
        a, b = expression_type(p["left"], columns, parameters), expression_type(p["right"], columns, parameters)
        need(a == b, "COMPARISON_TYPE_UNIT_MISMATCH")
        need(a["kind"] != "boolean" or p["op"] in ("eq", "ne"), "BOOLEAN_ORDER_UNSUPPORTED")


def expr(e, row, columns, parameters):
    op = e["op"]
    if op == "field":
        return columns[e["name"]], row[e["name"]]
    if op in ("literal", "param"):
        item = e if op == "literal" else parameters[e["name"]]
        return item["type"], scalar(item["value"], item["type"])
    if op == "round":
        t, v = expr(e["value"], row, columns, parameters)
        need(number_type(t), "ROUND_NUMERIC_REQUIRED")
        x = quantity(v) * 10 ** e["places"]
        if e["mode"] == "FLOOR":
            y = x.numerator // x.denominator
        elif e["mode"] == "CEILING":
            y = -((-x.numerator) // x.denominator)
        elif e["mode"] == "TRUNCATE":
            y = int(x)
        else:
            need(e["mode"] in ("HALF_EVEN", "HALF_AWAY"), "ROUND_MODE_UNSUPPORTED")
            sign = -1 if x < 0 else 1
            base, remainder = divmod(abs(x.numerator), x.denominator)
            twice = remainder * 2
            y = sign * (base + (1 if twice > x.denominator or
                               twice == x.denominator and (e["mode"] == "HALF_AWAY" or base % 2) else 0))
        return dict(t, kind="rational"), qtext(Fraction(y, 10 ** e["places"]))
    lt, lv = expr(e["left"], row, columns, parameters)
    rt, rv = expr(e["right"], row, columns, parameters)
    need(number_type(lt) and number_type(rt), "NUMERIC_EXPRESSION_REQUIRED")
    a, b = quantity(lv), quantity(rv)
    kind = "integer" if op != "div" and lt["kind"] == rt["kind"] == "integer" else "rational"
    same_unit = lt["unit"] == rt["unit"] and lt["currency"] == rt["currency"]
    dimensionless = lambda t: t["unit"] == "1" and t["currency"] is None
    if op in ("add", "sub"):
        need(same_unit, "ARITHMETIC_UNIT_MISMATCH")
        return dict(lt, kind=kind), qtext(a + b if op == "add" else a - b)
    if op == "mul":
        need(dimensionless(lt) or dimensionless(rt), "UNDECLARED_PRODUCT_UNIT")
        return dict(rt if dimensionless(lt) else lt, kind=kind), qtext(a * b)
    need(op == "div" and b != 0 and (dimensionless(rt) or same_unit), "DIVISION_SEMANTICS_INVALID")
    result_type = dict(lt, kind=kind) if dimensionless(rt) else {"kind": kind, "unit": "1", "currency": None}
    return result_type, qtext(a / b)


def compare(a, b, t):
    if number_type(t):
        a, b = quantity(a), quantity(b)
    elif t["kind"] == "text":
        a, b = lexical(a), lexical(b)
    return (a > b) - (a < b)


def predicate(p, row, columns, parameters):
    op = p["op"]
    if op in ("and", "or"):
        values = (predicate(x, row, columns, parameters) for x in p["args"])
        return all(values) if op == "and" else any(values)
    if op == "not":
        return not predicate(p["arg"], row, columns, parameters)
    lt, lv = expr(p["left"], row, columns, parameters)
    rt, rv = expr(p["right"], row, columns, parameters)
    need(lt == rt, "COMPARISON_TYPE_UNIT_MISMATCH")
    need(lt["kind"] != "boolean" or op in ("eq", "ne"), "BOOLEAN_ORDER_UNSUPPORTED")
    c = compare(lv, rv, lt)
    return {"eq": c == 0, "ne": c != 0, "lt": c < 0, "le": c <= 0, "gt": c > 0, "ge": c >= 0}[op]


def canonical(columns, rows, ordered=False, as_set=False):
    if as_set:
        rows = list({stable(row): row for row in rows}.values())
        ordered = False
    if not ordered:
        rows.sort(key=lambda r: lexical(stable(r)))
    return {"columns": columns, "rows": rows, "ordered": ordered}


def inputs(n):
    if n["op"] == "source":
        return []
    if n["op"] == "union":
        return n["inputs"]
    if n["op"] == "join":
        return [n["left"], n["right"]]
    return [n["input"]]


def original_operator(n, values, sources, parameters):
    op = n["op"]
    if op == "source":
        s = sources[n["sourceId"]]
        return canonical(s["columns"], [normalize(r, s["columns"]) for r in s["rows"]])
    children = [values[x] for x in inputs(n)]
    first = children[0]
    columns, rows, ordered = first["columns"], first["rows"], first["ordered"]
    if op == "filter":
        predicate_types(n["predicate"], columns, parameters)
        return canonical(columns, [r for r in rows if predicate(n["predicate"], r, columns, parameters)], ordered)
    if op == "project":
        types = {k: expression_type(e, columns, parameters) for k, e in n["fields"].items()}
        out = [{k: expr(e, row, columns, parameters)[1] for k, e in n["fields"].items()} for row in rows]
        return canonical(types, out, ordered, n["semantics"] == "set")
    if op == "union":
        need(all(v["columns"] == columns for v in children), "UNION_SCHEMA_UNIT_MISMATCH")
        return canonical(columns, [r for v in children for r in v["rows"]], as_set=n["semantics"] == "set")
    if op == "join":
        right = children[1]
        for key in n["on"]:
            need(columns[key["left"]] == right["columns"][key["right"]], "JOIN_TYPE_UNIT_MISMATCH")
        out_columns = dict(columns)
        for key, t in right["columns"].items():
            need(n["rightPrefix"] + key not in out_columns, "JOIN_ALIAS_COLLISION")
            out_columns[n["rightPrefix"] + key] = t
        index = {}
        for r in right["rows"]:
            key = tuple(r[k["right"]] for k in n["on"])
            index.setdefault(key, []).append(r)
        out = []
        for row in rows:
            for r in index.get(tuple(row[k["left"]] for k in n["on"]), []):
                out.append(dict(row, **{n["rightPrefix"] + k: v for k, v in r.items()}))
                need(len(out) <= 1000000, "DERIVED_ROW_BOUND")
        return canonical(out_columns, out)
    if op == "sum":
        types = {k: columns[k] for k in n["keys"]}
        for key, e in n["values"].items():
            need(key not in types, "GROUP_ALIAS_COLLISION")
            types[key] = expression_type(e, columns, parameters)
            need(number_type(types[key]), "GROUP_NUMERIC_REQUIRED")
        groups = {}
        if not n["keys"]:
            groups[()] = ({}, {k: Fraction(0) for k in n["values"]})
        for row in rows:
            key = tuple(row[k] for k in n["keys"])
            group = groups.setdefault(key, ({k: row[k] for k in n["keys"]}, {k: Fraction(0) for k in n["values"]}))
            for k, e in n["values"].items():
                group[1][k] += quantity(expr(e, row, columns, parameters)[1])
                qtext(group[1][k])
        return canonical(types, [dict(keys, **{k: qtext(v) for k, v in totals.items()}) for keys, totals in groups.values()])
    need(op == "select" and n["ties"] == "CANONICAL_ROW", "ORIGINAL_OPERATOR_UNSUPPORTED")
    for order in n["order"]:
        need(order["field"] in columns, "SELECTION_FIELD_UNAVAILABLE")

    def order(a, b):
        for item in n["order"]:
            c = compare(a[item["field"]], b[item["field"]], columns[item["field"]])
            if c:
                return c if item["direction"] == "asc" else -c
        return (lexical(stable(a)) > lexical(stable(b))) - (lexical(stable(a)) < lexical(stable(b)))

    return canonical(columns, sorted(rows, key=functools.cmp_to_key(order))[:n["limit"]], True)


def check(request, candidate):
    need(request["schema"] == "finnor.z1.request.v1" and 2 <= len(request["works"]) <= 1000 and
         sum(len(w["programme"]["nodes"]) for w in request["works"]) <= 4096 and
         sum(len(s["rows"]) for s in request["sources"]) <= 100000, "ORIGINAL_PROFILE_BOUND")
    need(candidate["schema"] == "finnor.z1.shared-work-program.v1", "ARTIFACT_SCHEMA")
    need(candidate["requestDigest"] == sha(request), "ORIGINAL_REQUEST_BINDING")
    need(candidate["executionAuthorityGranted"] is False and candidate["protectedAdmission"] is False, "PRODUCER_SELF_ADMISSION")
    unsigned = copy.deepcopy(candidate)
    unsigned["envelope"]["immutableArtifactDigest"] = ""
    need(candidate["envelope"]["immutableArtifactDigest"] == sha(unsigned), "ARTIFACT_CONTENT_DIGEST")
    need(candidate["envelope"]["productLockDigest"] == request["identity"]["productLockDigest"], "PRODUCT_LOCK")
    need(candidate["envelope"]["checkerIdentityAndResultReferences"]["resultReference"] is None, "FORGED_CHECKER_RECEIPT")
    need(not candidate["rules"]["rewrites"], "UNREGISTERED_REWRITE")
    sources = {s["id"]: s for s in request["sources"]}
    works = {w["id"]: w for w in request["works"]}
    need(len(sources) == len(request["sources"]) and len(works) == len(request["works"]), "ORIGINAL_IDENTITY_COVERAGE")
    first_partition = request["works"][0]["partition"]
    need(all(w["partition"]["tenantId"] == first_partition["tenantId"] and
             w["partition"]["principalId"] == first_partition["principalId"] for w in works.values()),
         "BATCH_AUTHENTICATED_PRINCIPAL_BOUNDARY")
    need(all(s["partition"]["tenantId"] == first_partition["tenantId"] and
             s["partition"]["principalId"] == first_partition["principalId"] for s in sources.values()),
         "BATCH_RAW_SOURCE_PRINCIPAL_BOUNDARY")
    projections = {p["workId"]: p for p in candidate["workProjections"]}
    need(len(projections) == len(candidate["workProjections"]) and set(projections) == set(works), "ORIGINAL_WORK_COVERAGE")
    need(candidate["envelope"]["Work"] == list(works), "ENVELOPE_ORIGINAL_WORK_COVERAGE")
    shared_nodes = {n["key"]: n for n in candidate["sharedDag"]}
    need(len(shared_nodes) == len(candidate["sharedDag"]), "DUPLICATE_SHARED_NODE")
    expected, graph_users, discovery_required, execution_floor = {}, {}, {}, {}
    for work_id, w in works.items():
        p = projections[work_id]
        original_nodes = {n["id"]: n for n in w["programme"]["nodes"]}
        need(len(original_nodes) == len(w["programme"]["nodes"]), "DUPLICATE_ORIGINAL_NODE")
        live, pending = set(), [w["programme"]["output"]]
        while pending:
            node_id = pending.pop()
            if node_id not in live:
                live.add(node_id)
                pending.extend(inputs(original_nodes[node_id]))
        need(live == set(original_nodes), "UNCOVERED_ORIGINAL_NODE")
        used_sources = sorted(set(n["sourceId"] for n in original_nodes.values() if n["op"] == "source"))
        binding = {"original": w, "build": request["identity"], "sources": [
            {"id": i, "revision": sources[i]["revision"], "digest": sha(sources[i]), "partition": sources[i]["partition"],
             "revoked": sources[i]["revoked"], "evidenceClass": sources[i]["evidenceClass"]} for i in used_sources]}
        need(p["binding"] == binding and p["bindingDigest"] == sha(binding), "ORIGINAL_CURRENTNESS_BINDING")
        need(p["unresolvedObligationRefs"] == w["unresolvedObligationRefs"], "ORIGINAL_S6_EXPOSURE")
        for i in used_sources:
            a, b = dict(sources[i]["partition"]), dict(w["partition"])
            ac, bc = a.pop("classification"), b.pop("classification")
            need(a == b and (ac == "PUBLIC" or ac == bc), "UNAUTHORIZED_ORIGINAL_SOURCE")
        revoked = any(sources[i]["revoked"] for i in used_sources)
        discovery_required[work_id] = 0 if w["withdrawn"] or revoked else len(original_nodes)
        if w["withdrawn"] or revoked:
            need(p["result"] is None and p["outputKey"] is None and not p["originalNodeKeys"], "WITHDRAWN_OR_REVOKED_OUTPUT")
            need(p["lifecycle"] == ("WITHDRAWN" if w["withdrawn"] else "ACTIVE"), "WITHDRAWAL_LIFECYCLE")
            if revoked:
                need(p["disposition"] == "REVOKED", "REVOKED_DISPOSITION")
            expected[work_id] = None
            continue
        values, keys = {}, {}
        need(p["lifecycle"] == "ACTIVE" and p["disposition"] == "UNKNOWN", "UNCHECKED_CANDIDATE_DISPOSITION")
        for node_id in TopologicalSorter({n["id"]: inputs(n) for n in original_nodes.values()}).static_order():
            n = original_nodes[node_id]
            values[node_id] = original_operator(n, values, sources, w["parameters"])
            need(0 < len(values[node_id]["columns"]) <= 128, "ORIGINAL_RELATION_COLUMN_BOUND")
            operator = {k: v for k, v in n.items() if k not in ("id", "input", "inputs", "left", "right")}
            child_keys = [keys[i] for i in inputs(n)]
            payload = {"partition": w["partition"], "build": request["identity"]["producerBuildIdentity"],
                       "parameters": w["parameters"], "operator": operator, "inputs": child_keys,
                       "source": sha(sources[n["sourceId"]]) if n["op"] == "source" else None, "mode": None}
            possible = [sha(payload), sha(dict(payload, mode=work_id))]
            key = p["originalNodeKeys"][node_id]
            need(key in possible, "SHARED_ORIGINAL_REFINEMENT_KEY")
            keys[node_id] = key
            shared = shared_nodes[key]
            need(shared["operator"] == operator and shared["inputs"] == child_keys and
                 shared["outputSchema"] == values[node_id]["columns"], "SHARED_ORIGINAL_OPERATOR_COVERAGE")
            graph_users.setdefault(key, set()).add(work_id)
            child_rows = [len(values[i]["rows"]) for i in inputs(n)]
            if n["op"] == "source":
                floor = len(sources[n["sourceId"]]["rows"])
            elif n["op"] == "join":
                floor = sum(child_rows) + len(values[node_id]["rows"])
            elif n["op"] == "union":
                floor = sum(child_rows)
            elif n["op"] == "sum":
                floor = child_rows[0] * (1 + len(n["values"]))
            else:
                floor = child_rows[0]
            execution_floor[key] = floor
        need(set(p["originalNodeKeys"]) == set(original_nodes), "ORIGINAL_NODE_COVERAGE")
        need(p["outputKey"] == keys[w["programme"]["output"]], "ORIGINAL_OUTPUT_PROJECTION")
        expected[work_id] = values[w["programme"]["output"]]
        need(p["result"] == expected[work_id], "ORIGINAL_SEMANTICS_COUNTEREXAMPLE")
    need(set(graph_users) == set(shared_nodes), "EXTRA_OR_MISSING_SHARED_OPERATOR")
    for key, users in graph_users.items():
        need(shared_nodes[key]["workIds"] == sorted(users, key=lexical), "LAWFUL_SHARED_CONSUMER_COVERAGE")
    costs = candidate["costs"]
    meter_gaps = [
        "TICKS_ARE_DETERMINISTIC_OPERATION_ACCOUNTING_NOT_CPU_OR_USD",
        "INPUT_VALIDATION_HASHING_STORAGE_IO_CHECKER_AND_FAILED_PROCESS_PHYSICAL_COSTS_REQUIRE_NATIVE_METERS",
        "NO_MODEL_PROVIDER_HUMAN_CAPITAL_OR_EFFECT_COST_MEASUREMENT",
    ]
    need(costs["usd"] is None and costs["gaps"] == meter_gaps, "UNMETERED_PHYSICAL_COST_NOT_ZERO")
    totals = {i: Fraction(0) for i in works}
    discovery = {i: Fraction(0) for i in works}
    storage = {key: Fraction(0) for key in graph_users}
    execution = {key: Fraction(0) for key in graph_users}
    for charge in costs["charges"]:
        allocation = charge["allocations"]
        n = quantity(charge["ticks"])
        need(n >= 0 and n == sum((quantity(x) for x in allocation.values()), Fraction(0)), "CHARGE_CONSERVATION")
        need(all(i in works and quantity(x) >= 0 for i, x in allocation.items()), "UNATTRIBUTABLE_CHARGE")
        if charge["phase"] == "DISCOVERY":
            need(charge["nodeKey"] is None and len(allocation) == 1, "DISCOVERY_CHARGE_COVERAGE")
            for i, value in allocation.items():
                discovery[i] += quantity(value)
        else:
            need(charge["phase"] in ("EXECUTION", "STORAGE") and
                 set(allocation) == graph_users[charge["nodeKey"]], "SHARED_CHARGE_PARENT_COVERAGE")
            (storage if charge["phase"] == "STORAGE" else execution)[charge["nodeKey"]] += n
        need(all(quantity(x) == n / len(allocation) for x in allocation.values()), "DETERMINISTIC_COST_ALLOCATION")
        for i, value in allocation.items():
            totals[i] += quantity(value)
    need(set(costs["byWork"]) == set(works) and all(quantity(costs["byWork"][i]) == q for i, q in totals.items()), "PER_WORK_COST_TOTAL")
    need(sum(totals.values(), Fraction(0)) == quantity(costs["totalTicks"]), "TOTAL_SHARED_COST")
    need(discovery == discovery_required and all(n == 1 for n in storage.values()), "COMPLETE_DISCOVERY_AND_STORAGE_CHARGES")
    if not candidate["history"]:
        need(all(execution[key] >= floor for key, floor in execution_floor.items()), "INITIAL_EXECUTION_CHARGE_FLOOR")
    for i, w in works.items():
        accounting = projections[i]["accounting"]
        cumulative = quantity(accounting["cumulativeTicks"])
        need(quantity(accounting["chargedTicks"]) == totals[i] and cumulative >= totals[i], "CUMULATIVE_PARENT_COST")
        need(quantity(accounting["remainingTicks"]) == quantity(w["resources"]["remainingTicks"]) - cumulative >= 0, "REMAINING_PARENT_BUDGET")
    need(type(candidate["version"]) is int and candidate["version"] == len(candidate["history"]) + 1, "CHECKPOINT_HISTORY_COVERAGE")
    identity, principal = request["identity"], request["works"][0]["partition"]
    obligations = sorted({ref for w in works.values() for ref in w["unresolvedObligationRefs"]}, key=lexical)
    expected_envelope = {
        "schemaVersion": "finnor.project-z.artifact-envelope.v1", "phase": "Z1", "principalOutputType": "SharedWorkProgram",
        "immutableArtifactDigest": "", "productLockDigest": identity["productLockDigest"],
        "sourceCommit": identity["sourceCommit"], "sourceTree": identity["sourceTree"],
        "producerBuildIdentity": identity["producerBuildIdentity"],
        "originalTenant": principal["tenantId"], "principal": principal["principalId"], "Work": list(works),
        "mandate": [w["resources"]["mandateRef"] for w in works.values()],
        "assignment": [w["resources"]["assignmentRef"] for w in works.values()],
        "parentReservation": [w["resources"]["parentReservationRef"] for w in works.values()],
        "originalDeadline": [w["resources"]["originalDeadline"] for w in works.values()],
        "remainingBudgetReference": [w["resources"]["remainingBudgetRef"] for w in works.values()],
        "unresolvedObligationReferences": obligations,
        "inputSemanticsAndRevisionReferences": [w["inputRef"] for w in works.values()],
        "rightsAndPermittedUseFingerprint": [sha(w["partition"]) for w in works.values()],
        "supportedDomain": "EXACT_FINITE_TYPED_PURE_RELATIONAL_DAGS_V1",
        "unsupportedConditions": ["FLOATS", "EFFECTS", "RECURSION", "UNDECLARED_UNIT_ALGEBRA", "OUT_OF_PROFILE_OR_EXHAUSTED_RESOURCES"],
        "claimAndEvidenceClasses": sorted({"deterministic"} | {s["evidenceClass"] for s in sources.values()}, key=lexical),
        "checkerIdentityAndResultReferences": {"identity": identity["checkerIdentity"], "resultReference": None},
        "currentnessDependencies": [projections[i]["bindingDigest"] for i in works],
        "securityAndConfidentialityProfile": "PRIVATE_AUTHENTICATED_PRINCIPAL; EXACT_LAWFUL_PARTITIONS; NOT_EFFECT_AUTHORITY",
        "ownerConsumerContractVersion": identity["ownerConsumerContractVersion"],
        "costAndResourceReceiptReferences": [sha(costs)],
        "gaps": ["INDEPENDENT_CHECK_REQUIRED", "NATIVE_OWNER_ADMISSION_AND_USE_REQUIRED"] + meter_gaps,
        "reconstructionReference": identity["reconstructionReference"],
    }
    need(unsigned["envelope"] == expected_envelope, "COMPLETE_ORIGINAL_ENVELOPE_BINDING")
    return {"disposition": "CHECKED_CANDIDATE", "checker": "z1-original-fraction-v1",
            "requestDigest": sha(request), "candidateDigest": candidate["envelope"]["immutableArtifactDigest"],
            "originalWorksChecked": len(works), "originalNodesChecked": sum(len(w["programme"]["nodes"]) for w in works.values()),
            "originalResultDigests": {i: sha(r) for i, r in expected.items()}, "expectedOutputs": expected,
            "scope": "PUBLIC_ORIGINAL_EXACT_SEMANTICS_NOT_SOURCE_TRUTH_OR_NATIVE_ADMISSION"}


def main():
    try:
        raw = sys.stdin.buffer.read(134217729)
        need(len(raw) <= 134217728, "CHECKER_INPUT_BYTE_BOUND")
        data = json.loads(raw, parse_float=lambda _: (_ for _ in ()).throw(Rejected("FLOAT_UNSUPPORTED")),
                          parse_constant=lambda _: (_ for _ in ()).throw(Rejected("NON_JSON_CONSTANT_UNSUPPORTED")))
        report = check(data["request"], data["candidate"])
    except MemoryError:
        report = {"disposition": "INCOMPLETE", "reason": "CHECKER_MEMORY_BOUND"}
    except (Rejected, KeyError, ValueError, TypeError, ZeroDivisionError, RecursionError, UnicodeError) as error:
        report = {"disposition": "COUNTEREXAMPLE", "reason": str(error) if isinstance(error, Rejected) else "ORIGINAL_SEMANTICS_OR_CERTIFICATE_INVALID"}
    print(json.dumps(report, separators=(",", ":"), ensure_ascii=True))


if __name__ == "__main__":
    main()
