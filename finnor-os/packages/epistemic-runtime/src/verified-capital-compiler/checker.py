#!/usr/bin/env python3
"""Independent, bounded checker for the existing underwriting-model-ir.v1.

Specification: the preregistered R6 failure model. No producer/native compiler,
decimal.js, solver, tactics or expected answers are imported. The proof rule is
ordered deterministic term congruence, with exact Fraction interval/lattice
enclosures establishing total successful execution and universal hard checks.
Native semantic pins are explicit premises, not approved financial truth.
"""
import argparse
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from fractions import Fraction
import hashlib
import heapq
import itertools
import json
import math
import os
from pathlib import Path
import platform
import re
import resource
import sys
import time

VERSION = "r6-native-ir-congruence-v1"
MAX_BYTES = 8 * 1024 * 1024
MAX_TERMS = 250000
NATIVE_PATHS = ["finnor-os/packages/underwriting/package.json"] + [
    "finnor-os/packages/underwriting/src/" + name + ".ts"
    for name in ("canonical", "compiler", "decimal", "errors", "executor", "index",
                 "periods", "result", "snapshot", "standard-lbo", "returns", "types")
]
CHECKER_PATH = "finnor-os/packages/epistemic-runtime/src/verified-capital-compiler/checker.py"
PRODUCER_PATHS = [
    "finnor-os/packages/epistemic-runtime/src/verified-capital-compiler/" + name
    for name in ("contracts.ts", "compiler.ts", "checker.ts", "native.ts", "membership.ts", "index.ts")
] + [
    "finnor-os/packages/private-equity/src/r6/verified-capital-compiler.ts",
    "finnor-os/packages/shared-types/src/decision-proof.ts",
    "finnor-os/packages/shared-types/src/certified-state-reduction.ts",
    "finnor-os/packages/shared-types/src/evidence-execution.ts",
    "finnor-os/packages/shared-types/src/experiments.ts",
]
NUMERIC_UNITS = {"money", "rate", "multiple", "ratio", "count"}
VALUE_TYPES = {"decimal", "date", "boolean", "text"}
UNITS = NUMERIC_UNITS | {"date", "period", "boolean", "text"}
DECIMAL_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$", re.ASCII)
NODE_RE = re.compile(r"^[a-z][a-z0-9_.:-]{0,199}$", re.ASCII)
DIGEST_RE = re.compile(r"^(?:sha256:)?[a-f0-9]{64}$", re.ASCII)
TRUTH_CLASSES = {
    "OBSERVED_FACT", "CANONICAL_ASSUMPTION", "MODEL_PARAMETER", "SCENARIO_OVERRIDE",
    "DERIVED_VALUE", "EXTERNAL_CALCULATED_COMPARISON", "UNKNOWN",
}


class Refusal(Exception):
    def __init__(self, predicate, reason, disposition="REJECTED"):
        super().__init__(reason)
        self.predicate, self.reason, self.disposition = predicate, reason, disposition


def require(predicate, name, reason=None, disposition="REJECTED"):
    if not predicate:
        raise Refusal(name, reason or name, disposition)


def strict_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def utf16_key(value):
    return value.encode("utf-16-be")


def canonical(value):
    """Independent implementation of the native canonical JSON convention."""
    if value is None or isinstance(value, bool):
        return "null" if value is None else "true" if value else "false"
    if isinstance(value, str):
        require(not any(0xD800 <= ord(c) <= 0xDFFF for c in value), "UNPAIRED_UNICODE")
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if type(value) is int:
        require(abs(value) <= 9007199254740991, "UNSAFE_STRUCTURAL_INTEGER")
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        require(all(isinstance(k, str) for k in value), "OBJECT_KEY")
        return "{" + ",".join(canonical(k) + ":" + canonical(value[k])
                              for k in sorted(value, key=utf16_key)) + "}"
    raise Refusal("CANONICAL_TYPE", "Only strings, booleans, safe structural integers and bounded JSON are permitted")


def sha(bytes_value):
    return hashlib.sha256(bytes_value).hexdigest()


def h(value):
    return "sha256:" + sha(canonical(value).encode("utf-8"))


def exact_keys(obj, keys, name):
    require(isinstance(obj, dict) and set(obj) == set(keys), name)


def bounded_string(value, name, limit=256):
    require(isinstance(value, str) and 0 < len(value) <= limit, name)


def owner_ref(value):
    exact_keys(value, ("owner", "id", "version", "contentDigest"), "OWNER_REF_SCHEMA")
    for field in ("owner", "id", "version"):
        bounded_string(value[field], "OWNER_REF_" + field)
    require(isinstance(value["contentDigest"], str) and DIGEST_RE.fullmatch(value["contentDigest"]),
            "OWNER_REF_DIGEST")
    return value


def ledger_key(value):
    owner_ref(value)
    return value["owner"], value["id"], value["version"]


def power10(exponent):
    return Fraction(10 ** exponent) if exponent >= 0 else Fraction(1, 10 ** -exponent)


def floor_log10(value):
    require(value > 0, "POSITIVE_LOG_ARGUMENT")
    exponent = len(str(value.numerator)) - len(str(value.denominator))
    if value < power10(exponent):
        exponent -= 1
    while value >= power10(exponent + 1):
        exponent += 1
    return exponent


def rounded(value, places):
    """Exact nearest decimal lattice point, ties to even, including negatives."""
    scaled = abs(value) * power10(places)
    quotient, remainder = divmod(scaled.numerator, scaled.denominator)
    twice = remainder * 2
    if twice > scaled.denominator or (twice == scaled.denominator and quotient % 2):
        quotient += 1
    return (1 if value >= 0 else -1) * Fraction(quotient) / power10(places)


def significant(value):
    return rounded(value, 33 - floor_log10(abs(value))) if value else Fraction(0)


def finite_scale(value):
    denominator = value.denominator
    twos = fives = 0
    while denominator % 2 == 0:
        denominator //= 2
        twos += 1
    while denominator % 5 == 0:
        denominator //= 5
        fives += 1
    require(denominator == 1, "NON_DECIMAL_INTERNAL_VALUE")
    return max(twos, fives)


def decimal_text(value):
    if not value:
        return "0"
    scale = finite_scale(value)
    integer = abs(value.numerator) * (10 ** scale // value.denominator)
    digits = str(integer).rjust(scale + 1, "0")
    body = (digits[:-scale] + "." + digits[-scale:]).rstrip("0").rstrip(".") if scale else digits
    return ("-" if value < 0 else "") + body


def decimal_value(value):
    require(isinstance(value, str) and 0 < len(value) <= 128
            and DECIMAL_RE.fullmatch(value), "INVALID_DECIMAL")
    exponent_match = re.search(r"[eE]([+-]?\d+)$", value)
    require(exponent_match is None or abs(int(exponent_match.group(1))) <= 100, "DECIMAL_EXPONENT")
    result = Fraction(value)
    # Constructors in native decimal.js saturate outside the configured range.
    require(not result or -100 <= floor_log10(abs(result)) <= 100,
            "DECIMAL_CONSTRUCTOR_RANGE", "Constructor overflow/underflow is not proved", "INCOMPLETE")
    require(len(decimal_text(result)) <= 128, "DECIMAL_NORMALIZED_LENGTH")
    return result


def civil(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value, re.ASCII), "INVALID_DATE")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise Refusal("INVALID_DATE", str(error))
    # JavaScript Date.UTC treats 0..99 specially. Such dates do not pass native
    # parseDateOnly; years beyond 9999 are not native YYYY-MM-DD either.
    require(100 <= parsed.year <= 9999, "NATIVE_DATE_YEAR")
    return parsed


def instant(value):
    bounded_string(value, "INSTANT", 80)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise Refusal("INSTANT", str(error))
    require(parsed.tzinfo is not None, "INSTANT_TIMEZONE")
    return parsed


def month_days(year, month):
    if month == 12:
        following = date(year + 1, 1, 1)
    else:
        following = date(year, month + 1, 1)
    return (following - date(year, month, 1)).days


def months_after(original, offset):
    zero = original.year * 12 + original.month - 1 + offset
    year, month = zero // 12, zero % 12 + 1
    require(100 <= year < 9999, "CALENDAR_BOUND", "Calendar exceeds the qualified native civil range", "UNSUPPORTED")
    return date(year, month, min(original.day, month_days(year, month)))


def periods(definition):
    require(isinstance(definition, dict)
            and set(definition) <= {"frequency", "forecastStart", "count", "fiscalYearStartMonth"}
            and {"frequency", "forecastStart", "count"} <= set(definition), "PERIOD_DEFINITION")
    frequency, count = definition["frequency"], definition["count"]
    require(frequency in {"annual", "quarterly", "monthly"}, "FREQUENCY")
    require(type(count) is int and 1 <= count <= 12, "HORIZON")
    fiscal = definition.get("fiscalYearStartMonth", 1)
    require(type(fiscal) is int and 1 <= fiscal <= 12, "FISCAL_MONTH")
    first = civil(definition["forecastStart"])
    months = {"annual": 12, "quarterly": 3, "monthly": 1}[frequency]
    result = []
    for ordinal in range(count):
        start = months_after(first, ordinal * months)
        end = months_after(first, (ordinal + 1) * months) - timedelta(days=1)
        fiscal_year = end.year + (1 if fiscal != 1 and end.month >= fiscal else 0)
        fiscal_month = (end.month - fiscal + 12) % 12 + 1
        label = "FY" + str(fiscal_year)
        if frequency == "monthly":
            label += "-M" + str(fiscal_month).zfill(2)
        elif frequency == "quarterly":
            label += "-Q" + str((fiscal_month + 2) // 3)
        result.append({
            "id": "P" + str(ordinal + 1).zfill(3) + ":" + start.isoformat() + ":" + end.isoformat(),
            "ordinal": ordinal, "startDate": start.isoformat(), "endDate": end.isoformat(),
            "fiscalLabel": label,
        })
    return result


def metadata(node, shape=None):
    return node["valueType"], node["unit"], node.get("currency"), shape or node["shape"]


def same_type(left, right):
    require(left[0] == right[0] and left[3] == right[3], "TYPE_MISMATCH")
    require(left[1] == right[1], "UNIT_MISMATCH")
    require(left[2] == right[2], "CURRENCY_MISMATCH")


def numeric_type(value):
    require(value[0] == "decimal" and value[1] in NUMERIC_UNITS, "NUMERIC_TYPE")


def multiplication_type(left, right):
    numeric_type(left)
    numeric_type(right)
    require(not (left[1] == right[1] == "money"), "UNIT_MISMATCH")
    require(not (left[2] and right[2]), "CURRENCY_MISMATCH")
    shape = "series" if "series" in (left[3], right[3]) else "scalar"
    money = left if left[1] == "money" else right if right[1] == "money" else None
    if money:
        factor = right if money is left else left
        require(factor[1] in {"rate", "multiple", "ratio", "count"}, "UNIT_MISMATCH")
        return "decimal", "money", money[2], shape
    unit = right[1] if left[1] == "count" else left[1] if right[1] == "count" else left[1] if left[1] == right[1] else "ratio"
    return "decimal", unit, None, shape


def division_type(left, right):
    numeric_type(left)
    numeric_type(right)
    shape = "series" if "series" in (left[3], right[3]) else "scalar"
    if right[1] == "money":
        require(left[1] == "money" and left[2] == right[2], "UNIT_MISMATCH")
        return "decimal", "ratio", None, shape
    if left[1] == "money":
        require(right[1] in {"rate", "multiple", "ratio", "count"}, "UNIT_MISMATCH")
        return "decimal", "money", left[2], shape
    require(not left[2] and not right[2], "CURRENCY_MISMATCH")
    return "decimal", "ratio" if left[1] == right[1] else left[1], None, shape


def expression_type(expression, nodes, series, depth=0):
    require(isinstance(expression, dict) and depth <= 64, "EXPRESSION_DEPTH")
    op = expression.get("op")
    if op == "literal":
        require(set(expression) <= {"op", "value", "valueType", "unit", "currency"}
                and {"op", "value", "valueType", "unit"} <= set(expression), "LITERAL_SCHEMA")
        value_type, unit = expression["valueType"], expression["unit"]
        require(value_type in VALUE_TYPES and unit in UNITS, "LITERAL_TYPE")
        if value_type == "decimal":
            decimal_value(expression["value"])
        elif value_type == "boolean":
            require(type(expression["value"]) is bool, "LITERAL_BOOLEAN")
        else:
            require(isinstance(expression["value"], str), "LITERAL_STRING")
        currency = expression.get("currency")
        require("currency" not in expression or (
            isinstance(currency, str) and unit == "money" and re.fullmatch(r"[A-Z]{3}", currency)),
            "CURRENCY_MISMATCH")
        return (value_type, unit, currency, "scalar"), set()
    if op in {"ref", "lag"}:
        exact_keys(expression, ("op", "nodeId", "periods") if op == "lag" else ("op", "nodeId"), "REFERENCE_SCHEMA")
        identity = expression["nodeId"]
        require(identity in nodes, "MISSING_DEPENDENCY")
        node = nodes[identity]
        if op == "lag":
            require(series and node["shape"] == "series" and type(expression["periods"]) is int
                    and expression["periods"] >= 1, "LAG_CONTEXT")
        shape = "scalar" if series and node["shape"] == "series" else node["shape"]
        return metadata(node, shape), {identity}
    recur = lambda child: expression_type(child, nodes, series, depth + 1)
    if op == "negate":
        exact_keys(expression, ("op", "arg"), "NEGATE_SCHEMA")
        value_type, refs = recur(expression["arg"])
        numeric_type(value_type)
        return value_type, refs
    if op == "compare":
        exact_keys(expression, ("op", "comparison", "left", "right"), "COMPARE_SCHEMA")
        require(expression["comparison"] in {"eq", "ne", "lt", "lte", "gt", "gte"}, "COMPARISON")
        left, lrefs = recur(expression["left"])
        right, rrefs = recur(expression["right"])
        same_type(left, right)
        return ("boolean", "boolean", None, left[3]), lrefs | rrefs
    if op == "if":
        exact_keys(expression, ("op", "condition", "then", "else"), "IF_SCHEMA")
        condition, crefs = recur(expression["condition"])
        yes, yrefs = recur(expression["then"])
        no, nrefs = recur(expression["else"])
        require(condition[0] == "boolean", "BOOLEAN_PREDICATE")
        same_type(yes, no)
        shape = "series" if "series" in (condition[3], yes[3], no[3]) else "scalar"
        return (yes[0], yes[1], yes[2], shape), crefs | yrefs | nrefs
    require(op in {"add", "subtract", "multiply", "divide", "min", "max", "sum"}, "UNSUPPORTED_EXPRESSION")
    exact_keys(expression, ("op", "args"), "ARITHMETIC_SCHEMA")
    args = expression["args"]
    require(isinstance(args, list) and len(args) >= 1
            and (op not in {"subtract", "multiply", "divide"} or len(args) == 2), "ARITY")
    inferred = [recur(arg) for arg in args]
    refs = set().union(*(item[1] for item in inferred))
    types = [item[0] for item in inferred]
    if op == "multiply":
        return multiplication_type(types[0], types[1]), refs
    if op == "divide":
        return division_type(types[0], types[1]), refs
    for item in types:
        numeric_type(item)
        same_type(types[0], item)
    return types[0], refs


def compile_independently(model):
    require(isinstance(model, dict), "MODEL_SCHEMA")
    require(set(model) <= {"schemaVersion", "modelKey", "modelVersion", "financialConventionVersion",
                           "minimumEngineVersion", "periodDefinition", "nodes", "circularBlocks", "runtime", "metadata"}
            and {"schemaVersion", "modelKey", "modelVersion", "financialConventionVersion",
                 "minimumEngineVersion", "periodDefinition", "nodes", "circularBlocks"} <= set(model), "MODEL_SCHEMA")
    require(model["schemaVersion"] == "underwriting-model-ir.v1", "IR_SCHEMA")
    require(isinstance(model["modelKey"], str) and re.fullmatch(r"[a-z][a-z0-9_.:-]{0,99}", model["modelKey"], re.ASCII), "MODEL_KEY")
    bounded_string(model["modelVersion"], "MODEL_VERSION")
    bounded_string(model["financialConventionVersion"], "FINANCIAL_CONVENTION")
    require(isinstance(model["minimumEngineVersion"], str)
            and model["minimumEngineVersion"].startswith("finnor-underwriting-engine/1."), "ENGINE_VERSION")
    require("runtime" not in model, "SPECIALIZED_RUNTIME",
            "standard_lbo_v1 needs an independently accepted exact schedule/fixed-point/return specification", "UNSUPPORTED")
    require(model["circularBlocks"] == [], "GENERIC_CIRCULAR_BLOCK",
            "Native generic execution does not execute fixed-point blocks", "UNSUPPORTED")
    require(len(canonical(model).encode("utf-8")) <= 5 * 1024 * 1024, "MODEL_BYTES")
    raw_nodes = model["nodes"]
    require(isinstance(raw_nodes, list) and 1 <= len(raw_nodes) <= 10000, "NODE_COUNT")
    nodes = {}
    common_keys = {"id", "label", "kind", "valueType", "unit", "currency", "shape", "dependencies", "rounding"}
    extra_keys = {
        "input": {"required", "evidenceSemantics", "source", "allowStale", "allowedTruthClasses", "minimum", "maximum"},
        "constant": {"value", "truthClass"}, "expression": {"expression"}, "series": {"expression"},
        "aggregate": {"aggregation", "sourceNodeId"}, "check": {"assertion", "failureCode", "severity"},
        "output": {"sourceNodeId"},
    }
    for node in raw_nodes:
        require(isinstance(node, dict) and node.get("kind") in extra_keys, "NODE_KIND")
        require(set(node) <= common_keys | extra_keys[node["kind"]], "UNMODELED_NODE_FIELD",
                "An undeclared native field requires semantic qualification", "UNSUPPORTED")
        require({"id", "kind", "valueType", "unit", "shape", "dependencies"} <= set(node), "NODE_SCHEMA")
        require(isinstance(node["id"], str) and NODE_RE.fullmatch(node["id"]), "NODE_ID")
        require(node["id"] not in nodes, "DUPLICATE_NODE")
        require(node["valueType"] in VALUE_TYPES and node["unit"] in UNITS and node["shape"] in {"scalar", "series"}, "NODE_TYPE")
        currency = node.get("currency")
        require("currency" not in node or (
            isinstance(currency, str) and node["unit"] == "money" and re.fullmatch(r"[A-Z]{3}", currency)),
            "CURRENCY_MISMATCH")
        require(node["unit"] != "money" or currency is not None, "MONEY_CURRENCY")
        if node["valueType"] == "decimal":
            require(node["unit"] in NUMERIC_UNITS, "TYPE_MISMATCH")
        elif node["valueType"] == "date":
            require(node["unit"] == "date", "TYPE_MISMATCH")
        elif node["valueType"] == "boolean":
            require(node["unit"] == "boolean", "TYPE_MISMATCH")
        else:
            require(node["unit"] in {"text", "period"}, "TYPE_MISMATCH")
        deps = node["dependencies"]
        require(isinstance(deps, list) and all(isinstance(v, str) for v in deps)
                and len(deps) == len(set(deps)), "DEPENDENCIES")
        if "rounding" in node:
            exact_keys(node["rounding"], ("decimalPlaces",), "ROUNDING_SCHEMA")
            places = node["rounding"]["decimalPlaces"]
            require(node["valueType"] == "decimal" and type(places) is int and 0 <= places <= 34, "ROUNDING_POLICY")
        if node["kind"] == "input":
            require(type(node.get("required")) is bool and not deps, "INPUT_POLICY")
            require("allowStale" not in node or type(node["allowStale"]) is bool, "INPUT_POLICY")
            if "allowedTruthClasses" in node:
                classes = node["allowedTruthClasses"]
                require(isinstance(classes, list) and classes and len(classes) == len(set(classes))
                        and set(classes) <= TRUTH_CLASSES, "INPUT_TRUTH_POLICY")
            for field in ("minimum", "maximum"):
                if field in node:
                    decimal_value(node[field])
            require("minimum" not in node or "maximum" not in node
                    or decimal_value(node["minimum"]) <= decimal_value(node["maximum"]), "INPUT_RANGE")
        elif node["kind"] == "constant":
            require(not deps and node.get("truthClass") == "MODEL_PARAMETER", "CONSTANT_POLICY")
        elif node["kind"] == "expression":
            require(node["shape"] == "scalar", "EXPRESSION_SHAPE")
        elif node["kind"] == "series":
            require(node["shape"] == "series", "SERIES_SHAPE")
        elif node["kind"] == "aggregate":
            require(node["shape"] == "scalar" and node.get("aggregation") in {"sum", "min", "max", "first", "last"}, "AGGREGATION")
        elif node["kind"] == "check":
            require(metadata(node) == ("boolean", "boolean", None, "scalar")
                    and node.get("severity") in {"error", "warning"}
                    and isinstance(node.get("failureCode"), str), "CHECK_SCHEMA")
        nodes[node["id"]] = node
    for node in nodes.values():
        require(all(dep in nodes for dep in node["dependencies"]), "MISSING_DEPENDENCY")
        kind = node["kind"]
        if kind in {"expression", "series", "check"}:
            expr = node["assertion"] if kind == "check" else node["expression"]
            inferred, refs = expression_type(expr, nodes, kind == "series")
            # The native compiler overrides inferred shape at this boundary.
            # Actual scalar/series execution totality is checked separately.
            same_type(metadata(node), (inferred[0], inferred[1], inferred[2], node["shape"]))
            require(set(node["dependencies"]) == refs, "EXACT_EXPRESSION_DEPENDENCIES")
        elif kind in {"aggregate", "output"}:
            source_id = node.get("sourceNodeId")
            require(source_id in nodes and node["dependencies"] == [source_id], "SOURCE_DEPENDENCY")
            source = nodes[source_id]
            if kind == "aggregate":
                require(source["shape"] == "series", "AGGREGATE_SERIES")
                same_type(metadata(node), metadata(source, "scalar"))
            else:
                same_type(metadata(node), metadata(source))
    incoming = {identity: set(node["dependencies"]) for identity, node in nodes.items()}
    outgoing = {identity: [] for identity in nodes}
    for identity, node in nodes.items():
        for dependency in node["dependencies"]:
            outgoing[dependency].append(identity)
    ready = [identity for identity, deps in incoming.items() if not deps]
    heapq.heapify(ready)
    order = []
    while ready:
        identity = heapq.heappop(ready)
        order.append(identity)
        for following in sorted(outgoing[identity]):
            incoming[following].remove(identity)
            if not incoming[following]:
                heapq.heappush(ready, following)
    require(len(order) == len(nodes), "UNDECLARED_CYCLE")
    semantic = {key: model[key] for key in (
        "schemaVersion", "financialConventionVersion", "minimumEngineVersion",
        "periodDefinition", "nodes", "circularBlocks",
    )}
    return {
        "model": model, "periods": periods(model["periodDefinition"]), "semanticHash": h(semantic),
        "executionOrder": order, "nodeById": nodes,
        "dependencyGraph": {identity: node["dependencies"] for identity, node in nodes.items()},
        "dependentsGraph": {identity: sorted(values) for identity, values in outgoing.items()},
    }


@dataclass(frozen=True)
class Interval:
    low: Fraction
    high: Fraction
    scale: int


def minimum_nonzero(interval):
    if interval.low > 0:
        return interval.low
    if interval.high < 0:
        return -interval.high
    return power10(-interval.scale)


def range_safe(interval):
    require(interval.low <= interval.high and 0 <= interval.scale <= 100, "DECIMAL_TOTALITY",
            "Whole-domain normalized-length/underflow safety is not established", "INCOMPLETE")
    maximum = max(abs(interval.low), abs(interval.high))
    require(not maximum or floor_log10(maximum) <= 100, "DECIMAL_OVERFLOW",
            "A whole-domain native operation may overflow", "INCOMPLETE")
    if interval.low == interval.high:
        length = len(decimal_text(interval.low))
    else:
        digits = max(1, floor_log10(maximum) + 1) if maximum else 1
        length = (1 if interval.low < 0 else 0) + digits + (1 + interval.scale if interval.scale else 0)
    require(length <= 128, "DECIMAL_TOTALITY",
            "A whole-domain native operation may exceed the normalized decimal character bound", "INCOMPLETE")
    return interval


def exact_interval(value):
    return range_safe(Interval(value, value, finite_scale(value)))


def sig_interval(interval):
    maximum = max(abs(interval.low), abs(interval.high))
    if not maximum:
        return exact_interval(Fraction(0))
    lower = minimum_nonzero(interval)
    require(floor_log10(lower) >= -100 and floor_log10(maximum) <= 100, "DECIMAL_TOTALITY",
            "Native significant rounding could saturate outside the admitted decimal exponent range", "INCOMPLETE")
    scale = min(interval.scale, max(0, 33 - floor_log10(lower)))
    return range_safe(Interval(significant(interval.low), significant(interval.high), scale))


def union_bounds(left, right):
    if isinstance(left, Interval) and isinstance(right, Interval):
        return range_safe(Interval(min(left.low, right.low), max(left.high, right.high), max(left.scale, right.scale)))
    require(isinstance(left, frozenset) and isinstance(right, frozenset), "BOUND_TYPE")
    return left | right


def compare_interval(operator, left, right, identical=False):
    require(isinstance(left, Interval) and isinstance(right, Interval), "NATIVE_STRING_COMPARISON",
            "Native text/date/boolean locale comparison is not qualified by this numeric checker", "UNSUPPORTED")
    if identical:
        return frozenset({operator in {"eq", "lte", "gte"}})
    if operator in {"gt", "gte"}:
        return compare_interval("lt" if operator == "gt" else "lte", right, left)
    if operator in {"eq", "ne"}:
        if left.low == left.high == right.low == right.high:
            values = {True}
        elif left.high < right.low or right.high < left.low:
            values = {False}
        else:
            values = {False, True}
        return frozenset(not v for v in values) if operator == "ne" else frozenset(values)
    if operator == "lt":
        return frozenset({True}) if left.high < right.low else frozenset({False}) if left.low >= right.high else frozenset({False, True})
    return frozenset({True}) if left.high <= right.low else frozenset({False}) if left.low > right.high else frozenset({False, True})


class Arena:
    """Hash-consed proof DAG. Terms are evidence, never an executable finance IR.
    Evaluation is iterative to cover native 10,000-node chains without relying
    on Python recursion limits. Lazy branches are requested only when applicable.
    """
    def __init__(self):
        self.terms, self.by_term = [], {}
        self.domain_bounds, self.witness = {}, {}
        self.abstract_cache, self.concrete_cache = {}, {}

    def intern(self, term):
        if term in self.by_term:
            return self.by_term[term]
        require(len(self.terms) < MAX_TERMS, "PROOF_TERMS", "Complete proof exceeds its explicit term bound", "INCOMPLETE")
        identity = len(self.terms)
        self.terms.append(term)
        self.by_term[term] = identity
        return identity

    def literal(self, node, value):
        value_type, unit, currency, _ = metadata(node)
        if value_type == "decimal":
            value = decimal_text(decimal_value(value))
        elif value_type == "boolean":
            require(type(value) is bool, "BOOLEAN_CONSTANT")
        else:
            require(isinstance(value, str), "STRING_CONSTANT")
            if value_type == "date":
                civil(value)
        return self.intern(("literal", value_type, unit, currency, value))

    def children(self, term):
        op = term[0]
        if op in {"input", "literal", "failure"}:
            return []
        if op in {"add", "mul", "min", "max"}:
            return list(term[1])
        if op in {"sub", "div"}:
            return [term[1], term[2]]
        if op == "neg":
            return [term[1]]
        if op == "round":
            return [term[2]]
        if op == "cmp":
            return [term[2], term[3]]
        if op == "if":
            return [term[1]]
        raise Refusal("TERM_RULE", str(op))

    def expression(self, expr, compiled, values, index=None):
        op = expr["op"]
        if op == "literal":
            return self.literal({"valueType": expr["valueType"], "unit": expr["unit"],
                                 "currency": expr.get("currency"), "shape": "scalar"}, expr["value"])
        if op in {"ref", "lag"}:
            identity = expr["nodeId"]
            node = compiled["nodeById"][identity]
            if node["shape"] == "scalar":
                return values[identity]["$scalar"]
            if index is None:
                return self.intern(("failure", "PERIOD_MISMATCH"))
            offset = expr["periods"] if op == "lag" else 0
            position = index - offset
            if position < 0:
                return self.intern(("failure", "MISSING_REQUIRED_INPUT"))
            return values[identity][compiled["periods"][position]["id"]]
        recur = lambda arg: self.expression(arg, compiled, values, index)
        if op == "if":
            condition, yes, no = recur(expr["condition"]), recur(expr["then"]), recur(expr["else"])
            cond_term = self.terms[condition]
            if cond_term[0] == "literal" and cond_term[1] == "boolean":
                return yes if cond_term[4] else no
            return self.intern(("if", condition, yes, no))
        if op == "compare":
            return self.intern(("cmp", expr["comparison"], recur(expr["left"]), recur(expr["right"])))
        if op == "negate":
            return self.intern(("neg", recur(expr["arg"])))
        args = tuple(recur(arg) for arg in expr["args"])
        if op in {"add", "sum", "multiply", "min", "max"}:
            return self.intern(({"sum": "add", "multiply": "mul"}.get(op, op), args))
        return self.intern(("sub" if op == "subtract" else "div", args[0], args[1]))

    def build(self, compiled, input_terms):
        values, checks = {}, {}
        for identity in compiled["executionOrder"]:
            node = compiled["nodeById"][identity]
            kind = node["kind"]
            if kind == "input":
                value = input_terms[identity].copy()
            elif kind == "constant":
                if node["shape"] == "scalar":
                    value = {"$scalar": self.literal(node, node["value"])}
                else:
                    expected = {p["id"] for p in compiled["periods"]}
                    require(isinstance(node["value"], dict) and set(node["value"]) == expected,
                            "CONSTANT_SERIES_COVERAGE")
                    value = {p["id"]: self.literal(node, node["value"][p["id"]]) for p in compiled["periods"]}
            elif kind in {"expression", "check"}:
                expr = node["assertion"] if kind == "check" else node["expression"]
                value = {"$scalar": self.expression(expr, compiled, values)}
            elif kind == "series":
                value = {p["id"]: self.expression(node["expression"], compiled, values, p["ordinal"])
                         for p in compiled["periods"]}
            elif kind == "aggregate":
                source = values[node["sourceNodeId"]]
                args = tuple(source[p["id"]] for p in compiled["periods"])
                method = node["aggregation"]
                if method in {"first", "last"}:
                    value = {"$scalar": args[0] if method == "first" else args[-1]}
                else:
                    require(node["valueType"] == "decimal", "AGGREGATE_TYPE")
                    value = {"$scalar": self.intern(("add" if method == "sum" else method, args))}
            elif kind == "output":
                value = values[node["sourceNodeId"]].copy()
            else:
                raise Refusal("UNSUPPORTED_NODE", kind, "UNSUPPORTED")
            if "rounding" in node:
                value = {component: self.intern(("round", node["rounding"]["decimalPlaces"], term))
                         for component, term in value.items()}
            values[identity] = value
            if kind == "check":
                checks[identity] = value["$scalar"]
        return values, checks

    def evaluate(self, root, abstract):
        cache = self.abstract_cache if abstract else self.concrete_cache
        stack = [(root, 0)]
        while stack:
            identity, phase = stack.pop()
            if identity in cache:
                continue
            term = self.terms[identity]
            if phase == 0:
                stack.append((identity, 1))
                for child in reversed(self.children(term)):
                    if child not in cache:
                        stack.append((child, 0))
                continue
            if term[0] == "if" and phase == 1:
                condition = cache[term[1]]
                possible = condition if abstract else frozenset({condition})
                require(isinstance(possible, frozenset) and set(possible) <= {False, True}
                        and all(type(v) is bool for v in possible), "BOOLEAN_PREDICATE")
                branches = ([term[2]] if True in possible else []) + ([term[3]] if False in possible else [])
                stack.append((identity, 2))
                for child in reversed(branches):
                    if child not in cache:
                        stack.append((child, 0))
                continue
            cache[identity] = self.compute(identity, cache, abstract)
        return cache[root]

    def compute(self, identity, cache, abstract):
        term = self.terms[identity]
        op = term[0]
        if op == "input":
            return self.domain_bounds[identity] if abstract else self.witness[identity]
        if op == "literal":
            if term[1] == "decimal":
                value = decimal_value(term[4])
                return exact_interval(value) if abstract else value
            return frozenset({term[4]}) if abstract else term[4]
        if op == "failure":
            raise Refusal("EXECUTION_TOTALITY", "Applicable native execution fails: " + term[1], "INCOMPLETE")
        if op == "if":
            condition = cache[term[1]]
            if not abstract:
                return cache[term[2] if condition else term[3]]
            if condition == frozenset({True}):
                return cache[term[2]]
            if condition == frozenset({False}):
                return cache[term[3]]
            return union_bounds(cache[term[2]], cache[term[3]])
        if op == "cmp":
            left, right = cache[term[2]], cache[term[3]]
            if abstract:
                return compare_interval(term[1], left, right, term[2] == term[3])
            require(isinstance(left, Fraction) and isinstance(right, Fraction), "NATIVE_STRING_COMPARISON",
                    "Non-numeric native locale comparisons are not qualified", "UNSUPPORTED")
            return {"eq": left == right, "ne": left != right, "lt": left < right,
                    "lte": left <= right, "gt": left > right, "gte": left >= right}[term[1]]
        children = [cache[child] for child in self.children(term)]
        if not abstract:
            require(all(isinstance(v, Fraction) for v in children), "NUMERIC_TERM")
            if op == "neg":
                return -children[0]
            if op == "round":
                return rounded(children[0], term[1])
            if op == "min":
                return min(children)
            if op == "max":
                return max(children)
            if op == "sub":
                return significant(children[0] - children[1])
            if op == "div":
                require(children[1] != 0, "DIVIDE_BY_ZERO")
                return significant(children[0] / children[1])
            total = Fraction(0 if op == "add" else 1)
            for child in children:
                total = significant(total + child if op == "add" else total * child)
            return total
        require(all(isinstance(v, Interval) for v in children), "NUMERIC_BOUND")
        if op == "neg":
            item = children[0]
            return range_safe(Interval(-item.high, -item.low, item.scale))
        if op == "round":
            item = children[0]
            return range_safe(Interval(rounded(item.low, term[1]), rounded(item.high, term[1]),
                                       min(item.scale, term[1])))
        if op in {"min", "max"}:
            fn = min if op == "min" else max
            return range_safe(Interval(fn(v.low for v in children), fn(v.high for v in children),
                                       max(v.scale for v in children)))
        if op == "sub":
            left, right = children
            return sig_interval(Interval(left.low - right.high, left.high - right.low, max(left.scale, right.scale)))
        if op == "div":
            left, right = children
            require(right.high < 0 or right.low > 0, "DIVISOR_TOTALITY",
                    "Whole-domain denominator can be zero; no successful all-input execution proof", "INCOMPLETE")
            if left.low == left.high == 0:
                return exact_interval(Fraction(0))
            endpoints = [a / b for a in (left.low, left.high) for b in (right.low, right.high)]
            smallest = minimum_nonzero(left) / max(abs(right.low), abs(right.high))
            require(floor_log10(smallest) >= -100, "DECIMAL_TOTALITY",
                    "Division may underflow below the qualified native range", "INCOMPLETE")
            scale = max(0, 33 - floor_log10(significant(smallest)))
            return range_safe(Interval(significant(min(endpoints)), significant(max(endpoints)), scale))
        total = exact_interval(Fraction(0 if op == "add" else 1))
        for child in children:
            if op == "add":
                exact = Interval(total.low + child.low, total.high + child.high, max(total.scale, child.scale))
            else:
                products = [a * b for a in (total.low, total.high) for b in (child.low, child.high)]
                exact = Interval(min(products), max(products), total.scale + child.scale)
            total = sig_interval(exact)
        return total


def scalar_domain(raw, value_type):
    require(isinstance(raw, dict), "INPUT_DOMAIN_COMPONENT")
    if value_type == "decimal":
        exact_keys(raw, ("kind", "minimum", "maximum", "decimalPlaces"), "DECIMAL_DOMAIN_SCHEMA")
        require(raw["kind"] == "DECIMAL_LATTICE", "DECIMAL_DOMAIN_KIND")
        scale = raw["decimalPlaces"]
        require(type(scale) is int and 0 <= scale <= 34, "DECIMAL_DOMAIN_SCALE")
        low, high = decimal_value(raw["minimum"]), decimal_value(raw["maximum"])
        require(low <= high, "EMPTY_DOMAIN")
        left, right = low * power10(scale), high * power10(scale)
        require(left.denominator == right.denominator == 1, "DOMAIN_LATTICE_ENDPOINT")
        return range_safe(Interval(low, high, scale)), int(right - left) + 1
    exact_keys(raw, ("kind", "values"), "ENUMERATION_SCHEMA")
    values = raw["values"]
    require(raw["kind"] == "ENUMERATION" and isinstance(values, list) and 1 <= len(values) <= 256, "EMPTY_DOMAIN")
    require(len({canonical(v) for v in values}) == len(values), "DUPLICATE_DOMAIN_VALUE")
    if value_type == "boolean":
        require(all(type(v) is bool for v in values), "BOOLEAN_DOMAIN")
    else:
        require(all(isinstance(v, str) and len(v) <= 128 for v in values), "STRING_DOMAIN")
        if value_type == "date":
            for value in values:
                civil(value)
    return frozenset(values), len(values)


def scalar_member(raw, value_type, value):
    if value_type == "decimal":
        parsed = decimal_value(value)
        require(decimal_text(parsed) == value, "NONCANONICAL_WITNESS_DECIMAL")
        require(decimal_value(raw["minimum"]) <= parsed <= decimal_value(raw["maximum"])
                and (parsed * power10(raw["decimalPlaces"])).denominator == 1, "WITNESS_DOMAIN")
        return parsed
    require(any(type(v) is type(value) and v == value for v in raw["values"]), "WITNESS_DOMAIN")
    return value


def snapshot_valid(snapshot, compiled):
    require(isinstance(snapshot, dict) and snapshot.get("schemaVersion") == "underwriting-input-snapshot.v1",
            "WITNESS_SNAPSHOT")
    instant(snapshot["worldAt"])
    bounded_string(snapshot["investmentCaseId"], "INVESTMENT_CASE")
    require(snapshot.get("semanticHash") == h({k: v for k, v in snapshot.items() if k != "semanticHash"}),
            "WITNESS_SNAPSHOT_HASH")
    inputs = {identity: node for identity, node in compiled["nodeById"].items() if node["kind"] == "input"}
    require(isinstance(snapshot["values"], dict) and set(snapshot["values"]) == set(inputs), "WITNESS_INPUT_COVERAGE")
    for identity, node in inputs.items():
        value = snapshot["values"][identity]
        require(value.get("nodeId") == identity and metadata(value) == metadata(node)
                and ("currency" in value) == ("currency" in node), "WITNESS_INPUT_METADATA",
                "Native strict currency policy distinguishes an absent field from JSON null")
        require(value.get("truthClass") in TRUTH_CLASSES, "WITNESS_TRUTH_CLASS")
        require(value.get("status") == "KNOWN" or (value.get("status") == "STALE" and node.get("allowStale") is True),
                "WITNESS_TRUTH_POLICY", "UNKNOWN/CONFLICTING/UNSUPPORTED or forbidden STALE witness", "INCOMPLETE")
        require("allowedTruthClasses" not in node or value["truthClass"] in node["allowedTruthClasses"],
                "WITNESS_TRUTH_POLICY")
        require(value.get("value") is not None, "WITNESS_MISSING_INPUT", "No nonempty valid input witness", "INCOMPLETE")
        require(isinstance(value.get("provenance"), list) and len(value["provenance"]) <= 32, "WITNESS_PROVENANCE")


def validate_domain(packet, programme, reference, arena):
    domain = packet["domain"]
    exact_keys(domain, ("schema", "ref", "fixedInputMetadataDigest", "inputs"), "DOMAIN_SCHEMA")
    require(domain["schema"] == "finnor.r6.input-domain.v1", "DOMAIN_VERSION")
    owner_ref(domain["ref"])
    snapshot_valid(packet["witness"], programme)
    snapshot_valid(packet["nativeWitness"]["referenceSnapshot"], reference)
    fixed_metadata = {
        "schemaVersion": packet["witness"]["schemaVersion"],
        "investmentCaseId": packet["witness"]["investmentCaseId"],
        "worldAt": packet["witness"]["worldAt"],
        "values": {identity: {k: v for k, v in raw.items() if k != "value"}
                   for identity, raw in packet["witness"]["values"].items()},
    }
    require(domain["fixedInputMetadataDigest"] == h(fixed_metadata), "DOMAIN_FIXED_INPUT_METADATA",
            "D fixes actual native input status/class/provenance/as-of metadata; changed or unknown owner metadata is not silently assumed")
    p_inputs = {i: n for i, n in programme["nodeById"].items() if n["kind"] == "input"}
    r_inputs = {i: n for i, n in reference["nodeById"].items() if n["kind"] == "input"}
    require(isinstance(domain["inputs"], list) and len(domain["inputs"]) == len(p_inputs) == len(r_inputs),
            "DOMAIN_INPUT_COVERAGE")
    require(len({v["programmeNodeId"] for v in domain["inputs"]}) == len(p_inputs)
            and len({v["referenceNodeId"] for v in domain["inputs"]}) == len(r_inputs), "INPUT_BIJECTION")
    p_terms, r_terms, owners = {}, {}, set()
    cardinality = 1
    for binding in domain["inputs"]:
        exact_keys(binding, ("ownerRef", "programmeNodeId", "referenceNodeId", "valueType",
                             "unit", "currency", "shape", "components"), "INPUT_BINDING_SCHEMA")
        owner_ref(binding["ownerRef"])
        owner = ledger_key(binding["ownerRef"])
        require(owner not in owners, "DUPLICATE_INPUT_OWNER",
                "Two independent domain variables cannot be silently equated by an owner alias")
        owners.add(owner)
        pid, rid = binding["programmeNodeId"], binding["referenceNodeId"]
        require(pid in p_inputs and rid in r_inputs, "INPUT_BINDING")
        pnode, rnode = p_inputs[pid], r_inputs[rid]
        declared = (binding["valueType"], binding["unit"], binding["currency"], binding["shape"])
        same_type(declared, metadata(pnode))
        same_type(declared, metadata(rnode))
        expected = {"$scalar"} if binding["shape"] == "scalar" else {p["id"] for p in programme["periods"]}
        require(isinstance(binding["components"], dict) and set(binding["components"]) == expected,
                "DOMAIN_COMPONENT_COVERAGE")
        p_raw, r_raw = packet["witness"]["values"][pid]["value"], packet["nativeWitness"]["referenceSnapshot"]["values"][rid]["value"]
        p_terms[pid], r_terms[rid] = {}, {}
        for component, component_domain in binding["components"].items():
            bounds, count = scalar_domain(component_domain, binding["valueType"])
            if binding["valueType"] == "decimal":
                for node in (pnode, rnode):
                    require("minimum" not in node or bounds.low >= decimal_value(node["minimum"]), "DOMAIN_NATIVE_MINIMUM")
                    require("maximum" not in node or bounds.high <= decimal_value(node["maximum"]), "DOMAIN_NATIVE_MAXIMUM")
            pv, rv = (p_raw, r_raw) if component == "$scalar" else (p_raw[component], r_raw[component])
            require(type(pv) is type(rv) and pv == rv, "WITNESS_INPUT_CORRESPONDENCE")
            witness = scalar_member(component_domain, binding["valueType"], pv)
            term = arena.intern(("input", canonical(binding["ownerRef"]), component,
                                 binding["valueType"], binding["unit"], binding["currency"]))
            arena.domain_bounds[term], arena.witness[term] = bounds, witness
            p_terms[pid][component] = r_terms[rid][component] = term
            cardinality *= count
    return p_terms, r_terms, cardinality


def validate_money(specification, programme, reference):
    conventions = specification["moneyConventions"]
    require(isinstance(conventions, list), "MONEY_CONVENTIONS")
    currencies = {n["currency"] for c in (programme, reference) for n in c["nodeById"].values() if n["unit"] == "money"}
    require(len(conventions) == len(currencies) and {c.get("currency") for c in conventions} == currencies,
            "COMPLETE_MONEY_CONVENTIONS")
    for convention in conventions:
        exact_keys(convention, ("currency", "semantics", "valuationDate", "ownerShare",
                                "discountConventionRef", "timeBasis"), "MONEY_CONVENTION_SCHEMA")
        semantics = convention["semantics"]
        exact_keys(semantics, ("entityType", "entityId", "periodStart", "periodEnd", "unit", "currencyCode",
                               "frequency", "calendar", "consolidation", "instrument", "scale", "sign"),
                   "CANONICAL_FINANCIAL_SEMANTICS")
        require(semantics["unit"] == "currency" and semantics["currencyCode"] == convention["currency"]
                and semantics["scale"] == "1" and semantics["sign"] == "AS_RECORDED", "MONEY_UNITS",
                "A scaling/sign/FX transformation requires its own exact proof", "UNSUPPORTED")
        require(semantics["calendar"] == "GREGORIAN" and semantics["frequency"] == programme["model"]["periodDefinition"]["frequency"],
                "MONEY_CALENDAR")
        require(semantics["consolidation"] in {"OWNER_SUBJECT_ONLY", "CONSOLIDATED", "STANDALONE"}, "CONSOLIDATION")
        bounded_string(semantics["entityType"], "ENTITY_TYPE", 64)
        bounded_string(semantics["entityId"], "ENTITY_ID", 64)
        bounded_string(semantics["instrument"], "INSTRUMENT", 128)
        require(instant(semantics["periodStart"]).date().isoformat() == programme["periods"][0]["startDate"]
                and instant(semantics["periodEnd"]).date().isoformat() == programme["periods"][-1]["endDate"], "MONEY_TIME_BASIS")
        civil(convention["valuationDate"])
        require(convention["timeBasis"] == "EXACT_NATIVE_FINANCIAL_PERIODS", "MONEY_TIME_BASIS")
        owner_ref(convention["discountConventionRef"])
        share = convention["ownerShare"]
        exact_keys(share, ("numerator", "denominator"), "OWNER_SHARE")
        require(isinstance(share["numerator"], str) and isinstance(share["denominator"], str)
                and re.fullmatch(r"0|[1-9][0-9]*", share["numerator"])
                and re.fullmatch(r"[1-9][0-9]*", share["denominator"])
                and len(share["numerator"]) <= 128 and len(share["denominator"]) <= 128, "OWNER_SHARE")
        numerator, denominator = int(share["numerator"]), int(share["denominator"])
        require(0 <= numerator <= denominator and math.gcd(numerator, denominator) == 1, "NORMALIZED_OWNER_SHARE")


def timing_terms(timing, compiled, values):
    require(isinstance(timing, dict), "TIMING")
    kind = timing.get("kind")
    if kind == "AS_OF":
        exact_keys(timing, ("kind", "date"), "TIMING")
        civil(timing["date"])
        return "AS_OF", timing["date"]
    if kind == "PERIOD_END":
        exact_keys(timing, ("kind",), "TIMING")
        return "PERIOD_END", tuple((p["id"], p["endDate"]) for p in compiled["periods"])
    exact_keys(timing, ("kind", "nodeId"), "TIMING")
    require(kind == "NODE" and timing["nodeId"] in values
            and compiled["nodeById"][timing["nodeId"]]["valueType"] == "date", "PAYMENT_DATE_NODE")
    return "NODE", tuple(sorted(values[timing["nodeId"]].items()))


def validate_states(packet, programme, reference, p_values, r_values):
    spec, bindings = packet["reference"], packet["programmeBindings"]
    exact_keys(spec, ("schema", "ref", "model", "stateInventory", "inventoryBasis", "moneyConventions",
                      "assumptions", "approval"), "REFERENCE_SPECIFICATION")
    require(spec["schema"] == "finnor.r6.reference-specification.v1" and spec["approval"] is None,
            "REFERENCE_AUTHORITY", "Ordinary reference data cannot manufacture approval")
    owner_ref(spec["ref"])
    require(spec["inventoryBasis"] == "ALL_DECLARED_REFERENCE_ITEMS_NOT_ALL_REAL_WORLD_OBLIGATIONS", "INVENTORY_BASIS")
    require(isinstance(spec["assumptions"], list) and spec["assumptions"], "ASSUMPTION_INVENTORY")
    for assumption in spec["assumptions"]:
        exact_keys(assumption, ("ref", "statement", "qualification"), "ASSUMPTION_SCHEMA")
        owner_ref(assumption["ref"])
        bounded_string(assumption["statement"], "ASSUMPTION_STATEMENT", 4000)
        require(assumption["qualification"] == "SUPPLIED_MODEL_RELATIVE", "ASSUMPTION_QUALIFICATION")
    inventory = spec["stateInventory"]
    require(isinstance(inventory, list) and 1 <= len(inventory) <= 10000 and isinstance(bindings, list)
            and len(bindings) == len(inventory), "COMPLETE_STATE_INVENTORY")
    by_ledger = {}
    for binding in bindings:
        exact_keys(binding, ("ledgerRef", "nodeId", "timing"), "PROGRAMME_STATE_SCHEMA")
        key = ledger_key(binding["ledgerRef"])
        require(key not in by_ledger, "DUPLICATE_PROGRAMME_LEDGER_ITEM")
        by_ledger[key] = binding
    seen, p_covered, r_covered, cash_terms = set(), set(), set(), set()
    statements = packet["proof"]["statements"]
    require(isinstance(statements, list) and len(statements) == len(inventory), "PROOF_STATEMENT_COVERAGE")
    for index, state in enumerate(inventory):
        exact_keys(state, ("ledgerRef", "role", "nodeId", "timing", "obligationRef",
                          "obligationStatus", "sourceClauseRefs"), "REFERENCE_STATE_SCHEMA")
        key = ledger_key(state["ledgerRef"])
        require(key not in seen and key in by_ledger, "REFERENCE_LEDGER_COVERAGE")
        seen.add(key)
        binding = by_ledger[key]
        require(binding["ledgerRef"] == state["ledgerRef"], "LEDGER_CONTENT_DIGEST")
        pid, rid = binding["nodeId"], state["nodeId"]
        require(pid in p_values and rid in r_values, "STATE_NODE")
        pnode, rnode = programme["nodeById"][pid], reference["nodeById"][rid]
        same_type(metadata(pnode), metadata(rnode))
        role = state["role"]
        require(role in {"CASH", "LIABILITY", "CONSTRAINT", "OBJECTIVE", "TIMING"}, "STATE_ROLE")
        if role in {"CASH", "LIABILITY"}:
            require(pnode["valueType"] == "decimal" and pnode["unit"] == "money", "FINANCIAL_STATE_TYPE")
        elif role == "CONSTRAINT":
            require(pnode["valueType"] == "boolean", "CONSTRAINT_STATE_TYPE")
        elif role == "TIMING":
            require(pnode["valueType"] in {"date", "text"}, "TIMING_STATE_TYPE")
        else:
            require(pnode["valueType"] == "decimal", "OBJECTIVE_STATE_TYPE")
        require(isinstance(state["sourceClauseRefs"], list) and state["sourceClauseRefs"], "SOURCE_CLAUSE_INTERPRETATIONS")
        for clause in state["sourceClauseRefs"]:
            owner_ref(clause)
        if role == "LIABILITY":
            require(state["obligationStatus"] != "UNKNOWN", "UNKNOWN_LIABILITY",
                    "Unknown owner liability remains outstanding; no mechanically complete claim", "INCOMPLETE")
            require(state["obligationStatus"] == "REPRESENTED" and state["obligationRef"] is not None,
                    "LIABILITY_OWNER_BINDING")
            owner_ref(state["obligationRef"])
        else:
            require(state["obligationStatus"] == "NOT_APPLICABLE" and state["obligationRef"] is None, "OBLIGATION_STATUS")
        expected_statement = {
            "ledgerRef": state["ledgerRef"], "programmeNodeId": pid,
            "referenceNodeId": rid, "rule": "CONGRUENCE",
        }
        require(statements[index] == expected_statement, "PROOF_STATEMENT")
        require(p_values[pid] == r_values[rid], "ORDERED_TERM_CONGRUENCE",
                "An amount/guard/rounding/series translation has no permitted all-input congruence proof")
        ptime, rtime = timing_terms(binding["timing"], programme, p_values), timing_terms(state["timing"], reference, r_values)
        require(ptime == rtime, "SETTLEMENT_TIMING")
        if role == "CASH":
            cash_key = pid, ptime
            require(cash_key not in cash_terms, "DUPLICATED_CASH_PROJECTION")
            cash_terms.add(cash_key)
        p_covered.add(pid)
        r_covered.add(rid)
    for compiled, covered in ((programme, p_covered), (reference, r_covered)):
        mandatory = {identity for identity, node in compiled["nodeById"].items() if node["kind"] in {"output", "check"}}
        require(mandatory <= covered, "OUTPUT_CHECK_STATE_COVERAGE",
                "Every actual native output and CheckNode must remain in the declared state projection")
    require(seen == set(by_ledger), "EXTRA_PROGRAMME_LEDGER_ITEM")


def validate_identity(packet, args):
    identity = packet["nativeIdentity"]
    exact_keys(identity, ("schema", "engineVersion", "irSchema", "decimalPolicy", "sourcePins",
                          "dependencyLockDigest", "decimalModuleDigest", "decimalPackageVersion",
                          "checkerDigest", "producerDigest"), "NATIVE_IDENTITY")
    require(identity["schema"] == "finnor.r6.native-semantics.v1"
            and identity["engineVersion"] == "finnor-underwriting-engine/1.0.0"
            and identity["irSchema"] == "underwriting-model-ir.v1", "NATIVE_VERSION")
    require(identity["decimalPolicy"] == {"precision": 34, "rounding": "ROUND_HALF_EVEN",
                                         "maxInputCharacters": 128, "maxAbsoluteExponent": 100}, "NATIVE_DECIMAL_POLICY")
    root = args.repo.resolve()
    pins = identity["sourcePins"]
    require(isinstance(pins, list) and len(pins) == len(NATIVE_PATHS)
            and {p["path"] for p in pins} == set(NATIVE_PATHS), "NATIVE_SOURCE_COVERAGE")
    for pin in pins:
        exact_keys(pin, ("path", "sha256"), "SOURCE_PIN")
        require(pin["sha256"] == sha((root / pin["path"]).read_bytes()), "NATIVE_SOURCE_PIN", pin["path"])
    lock_bytes = (root / "finnor-os/package-lock.json").read_bytes()
    require(identity["dependencyLockDigest"] == "sha256:" + sha(lock_bytes), "DEPENDENCY_LOCK_PIN")
    lock = json.loads(lock_bytes)
    decimal_module = args.decimal_module.resolve()
    require(decimal_module.name == "decimal.mjs", "DECIMAL_MODULE_PATH")
    package = json.loads((decimal_module.parent / "package.json").read_text())
    require(package["name"] == "decimal.js"
            and package["version"] == identity["decimalPackageVersion"] == lock["packages"]["node_modules/decimal.js"]["version"],
            "DECIMAL_VERSION_PIN")
    require(identity["decimalModuleDigest"] == "sha256:" + sha(decimal_module.read_bytes()), "DECIMAL_MODULE_PIN")
    require(identity["checkerDigest"] == "sha256:" + sha(Path(__file__).resolve().read_bytes()), "CHECKER_PIN")
    producer_pins = [{"path": path, "sha256": sha((root / path).read_bytes())} for path in PRODUCER_PATHS]
    require(identity["producerDigest"] == h(producer_pins), "PRODUCER_PIN")


def validate_proof(packet):
    proof = packet["proof"]
    exact_keys(proof, ("schema", "rule", "programmeDigest", "referenceDigest", "domainDigest", "bindingsDigest",
                       "compiledProgrammeDigest", "compiledReferenceDigest", "nativeIdentityDigest",
                       "witnessDigest", "statements", "axioms", "unresolvedGoals", "coverage"), "PROOF_SCHEMA")
    require(proof["schema"] == "finnor.r6.translation-proof.v1"
            and proof["rule"] == "ORDERED_NATIVE_TERM_CONGRUENCE_WITH_UNIVERSAL_VALIDITY", "PROOF_RULE")
    require(proof["axioms"] == [], "UNAPPROVED_AXIOMS")
    require(proof["unresolvedGoals"] == [], "UNRESOLVED_GOALS")
    require(proof["coverage"] == "EVERY_DECLARED_INPUT_EVERY_APPLICABLE_BRANCH", "PROOF_COVERAGE")
    fields = {
        "programmeDigest": "programme", "referenceDigest": "reference", "domainDigest": "domain",
        "bindingsDigest": "programmeBindings", "compiledProgrammeDigest": "compiledProgramme",
        "compiledReferenceDigest": "compiledReference", "nativeIdentityDigest": "nativeIdentity",
        "witnessDigest": "witness",
    }
    for name, source in fields.items():
        require(proof[name] == h(packet[source]), "PROOF_BINDING_" + name)


def concretely_valued(arena, values):
    result = {}
    for node, components in values.items():
        computed = {}
        for key, term in components.items():
            value = arena.evaluate(term, False)
            computed[key] = decimal_text(value) if isinstance(value, Fraction) else value
        result[node] = computed["$scalar"] if set(computed) == {"$scalar"} else computed
    return result


def native_witness_conformance(raw_result, snapshot, compiled, values, checks, arena):
    require(raw_result.get("status") == "SUCCEEDED" and raw_result.get("validity") == "VALID",
            "NATIVE_WITNESS_VALIDITY", "Actual native witness did not execute successfully and validly", "INCOMPLETE")
    require(raw_result.get("engineVersion") == "finnor-underwriting-engine/1.0.0"
            and raw_result.get("modelSemanticHash") == compiled["semanticHash"]
            and raw_result.get("inputSemanticHash") == snapshot["semanticHash"], "NATIVE_WITNESS_IDENTITY")
    require(raw_result.get("resultSemanticHash") == h({k: v for k, v in raw_result.items() if k != "resultSemanticHash"}),
            "NATIVE_WITNESS_RESULT_HASH")
    expected = concretely_valued(arena, values)
    require(set(raw_result["values"]) == set(expected), "NATIVE_WITNESS_NODE_COVERAGE")
    for identity, value in expected.items():
        observed = raw_result["values"][identity]
        node = compiled["nodeById"][identity]
        require(observed["nodeId"] == identity and metadata(observed) == metadata(node)
                and observed["value"] == value and observed["directDependencies"] == node["dependencies"],
                "NATIVE_WITNESS_CONFORMANCE", identity)
    expected_outputs = {i for i, n in compiled["nodeById"].items() if n["kind"] == "output"}
    require(set(raw_result["outputs"]) == expected_outputs
            and all(raw_result["outputs"][i] == raw_result["values"][i] for i in expected_outputs),
            "NATIVE_WITNESS_OUTPUTS")
    observed_checks = raw_result["checks"]
    require(len(observed_checks) == len(checks) and {c["nodeId"] for c in observed_checks} == set(checks),
            "NATIVE_WITNESS_CHECKS")
    for check in observed_checks:
        node = compiled["nodeById"][check["nodeId"]]
        require(check["passed"] is arena.evaluate(checks[node["id"]], False)
                and check["severity"] == node["severity"] and check["code"] == node["failureCode"], "NATIVE_WITNESS_CHECK")
    require(raw_result.get("solverDiagnostics") == [] and "failure" not in raw_result, "NATIVE_WITNESS_FAILURE")
    return expected


def full_conformance(request, packet, programme, p_values, p_checks, arena, cardinality):
    """Additional E2E evidence only: complete enumeration of a frozen SMALL D."""
    exact_keys(request, ("schema", "packetDigest", "trials"), "CONFORMANCE_SCHEMA")
    require(request["schema"] == "finnor.r6.complete-finite-conformance.v1"
            and request["packetDigest"] == h(packet), "CONFORMANCE_BINDING")
    require(cardinality <= 4096, "CONFORMANCE_LIMIT", "Finite comparison is bounded; large-domain proof is congruence, not sampling", "UNSUPPORTED")
    trials = request["trials"]
    require(isinstance(trials, list) and len(trials) == cardinality, "COMPLETE_CONFORMANCE_COVERAGE")
    components = [(binding, component, raw) for binding in packet["domain"]["inputs"]
                  for component, raw in binding["components"].items()]
    seen = set()
    for trial in trials:
        exact_keys(trial, ("snapshot", "nativeResult"), "CONFORMANCE_TRIAL")
        snapshot_valid(trial["snapshot"], programme)
        vector = []
        arena.concrete_cache.clear()
        for binding, component, raw in components:
            node = binding["programmeNodeId"]
            value = trial["snapshot"]["values"][node]["value"]
            value = value if component == "$scalar" else value[component]
            member = scalar_member(raw, binding["valueType"], value)
            term = arena.by_term[("input", canonical(binding["ownerRef"]), component,
                                 binding["valueType"], binding["unit"], binding["currency"])]
            arena.witness[term] = member
            vector.append(value)
        key = canonical(vector)
        require(key not in seen, "CONFORMANCE_DUPLICATE_INPUT")
        seen.add(key)
        native_witness_conformance(trial["nativeResult"], trial["snapshot"], programme, p_values, p_checks, arena)
    return {
        "schema": "finnor.r6.complete-finite-conformance-receipt.v1",
        "packetDigest": h(packet), "checkedInputs": str(len(seen)), "domainCardinality": str(cardinality),
        "coverage": "EVERY_INPUT_OF_THIS_DECLARED_SMALL_DOMAIN",
        "notSubstituteForLargeDomainProof": True,
    }


def check(packet, args, receipt):
    exact_keys(packet, ("schema", "programme", "reference", "domain", "programmeBindings", "witness",
                        "nativeIdentity", "compiledProgramme", "compiledReference", "nativeWitness", "proof"), "PACKET_SCHEMA")
    require(packet["schema"] == "finnor.r6.proof-packet.v1", "PACKET_VERSION")
    validate_identity(packet, args)
    validate_proof(packet)
    programme = compile_independently(packet["programme"])
    reference = compile_independently(packet["reference"]["model"])
    receipt["coverage"]["nativeNodes"] = len(programme["nodeById"]) + len(reference["nodeById"])
    receipt["coverage"]["periods"] = len(programme["periods"])
    require(programme == packet["compiledProgramme"], "NATIVE_COMPILED_PROGRAMME",
            "Actual compiled programme differs from independent native compiler reconstruction")
    require(reference == packet["compiledReference"], "NATIVE_COMPILED_REFERENCE")
    require(programme["periods"] == reference["periods"]
            and programme["model"]["periodDefinition"]["frequency"] == reference["model"]["periodDefinition"]["frequency"],
            "NATIVE_CALENDAR_CORRESPONDENCE")
    require(programme["model"]["financialConventionVersion"] == reference["model"]["financialConventionVersion"]
            and programme["model"]["minimumEngineVersion"] == reference["model"]["minimumEngineVersion"], "FINANCIAL_SEMANTIC_REVISION")
    arena = Arena()
    p_inputs, r_inputs, cardinality = validate_domain(packet, programme, reference, arena)
    receipt["nonemptyDomain"] = True
    receipt["domainCardinality"] = str(cardinality)
    p_values, p_checks = arena.build(programme, p_inputs)
    r_values, r_checks = arena.build(reference, r_inputs)
    receipt["coverage"]["terms"] = len(arena.terms)
    validate_money(packet["reference"], programme, reference)
    validate_states(packet, programme, reference, p_values, r_values)
    receipt["coverage"]["financialStates"] = len(packet["reference"]["stateInventory"])
    receipt["allInputEquivalence"] = True
    # Native execution evaluates EVERY declared node, not only observed outputs.
    # A dangling failing node cannot hide behind an equivalent cash projection.
    for compiled, values, checks in ((programme, p_values, p_checks), (reference, r_values, r_checks)):
        for components in values.values():
            for term in components.values():
                arena.evaluate(term, True)
        for identity, term in checks.items():
            possible = arena.evaluate(term, True)
            require(isinstance(possible, frozenset) and all(type(v) is bool for v in possible), "CHECK_BOOLEAN")
            if compiled["nodeById"][identity]["severity"] == "error":
                require(possible == frozenset({True}), "UNIVERSAL_HARD_CONSTRAINT",
                        identity + ": hard financial check is not true for every declared input", "INCOMPLETE")
    witness_values = native_witness_conformance(
        packet["nativeWitness"]["programme"], packet["witness"], programme, p_values, p_checks, arena)
    native_witness_conformance(
        packet["nativeWitness"]["reference"], packet["nativeWitness"]["referenceSnapshot"],
        reference, r_values, r_checks, arena)
    receipt["witnessValues"] = witness_values
    receipt["witnessChecks"] = [{"nodeId": identity, "passed": arena.evaluate(term, False)} for identity, term in p_checks.items()]
    receipt["universallyValid"] = True
    receipt["checkedInvariants"] = [
        "NONEMPTY_EXACT_INPUT_DOMAIN",
        "ALL_INPUT_ORDERED_NATIVE_CASH_LIABILITY_CONSTRAINT_EQUIVALENCE",
        "NO_OMITTED_DECLARED_REFERENCE_LIABILITY",
        "NO_DUPLICATED_DECLARED_CASH_ITEM",
        "EXACT_DECLARED_SETTLEMENT_TIMING",
        "NATIVE_UNITS_CURRENCY_CALENDAR_AND_ROUNDING_PRESERVED",
        "SUCCESSFUL_NATIVE_EXECUTION_EVERY_APPLICABLE_BRANCH",
        "ALL_SPECIFIED_NATIVE_HARD_FINANCIAL_CHECKS_TRUE_ON_DOMAIN",
        "NO_UNAPPROVED_AXIOMS_OR_UNRESOLVED_GOALS",
    ]
    if args.conformance is not None:
        raw = args.conformance.read_bytes()
        require(len(raw) <= MAX_BYTES, "CONFORMANCE_BYTES")
        request = json.loads(raw, object_pairs_hook=strict_pairs)
        receipt["finiteConformance"] = full_conformance(request, packet, programme, p_values, p_checks, arena, cardinality)
    receipt["disposition"], receipt["predicate"] = "ACCEPTED", "ALL_INPUT_TRANSLATION_AND_VALIDITY"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--packet", required=True)
    parser.add_argument("--decimal-module", required=True, type=Path)
    parser.add_argument("--conformance", type=Path)
    args = parser.parse_args()
    started, cpu = time.monotonic(), resource.getrusage(resource.RUSAGE_SELF)
    receipt = {
        "schema": "finnor.r6.independent-check.v1", "disposition": "UNKNOWN",
        "predicate": "NOT_CHECKED", "reason": None, "packetDigest": "", "proofDigest": "",
        "checkerDigest": "sha256:" + sha(Path(__file__).resolve().read_bytes()),
        "nativeIdentityDigest": "", "allInputEquivalence": False, "universallyValid": False,
        "nonemptyDomain": False, "domainCardinality": None, "checkedInvariants": [],
        "coverage": {"nativeNodes": 0, "financialStates": 0, "periods": 0, "terms": 0},
        "witnessValues": None, "witnessChecks": [],
        "basis": "INDEPENDENT_ORDERED_TERM_CONGRUENCE_EXACT_FRACTION_ENCLOSURES",
        "qualification": "ORDINARY_DEVELOPMENT_EVIDENCE_NOT_ADMITTED", "physical": None,
    }
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1) if args.packet == "-" else Path(args.packet).read_bytes()
        require(len(raw) <= MAX_BYTES, "PACKET_BYTES")
        packet = json.loads(raw, object_pairs_hook=strict_pairs)
        receipt["packetDigest"] = h(packet)
        receipt["proofDigest"] = h(packet.get("proof"))
        receipt["nativeIdentityDigest"] = h(packet.get("nativeIdentity"))
        check(packet, args, receipt)
    except Refusal as error:
        receipt["disposition"], receipt["predicate"], receipt["reason"] = error.disposition, error.predicate, error.reason
    except Exception as error:
        receipt["disposition"], receipt["predicate"], receipt["reason"] = "UNKNOWN", "CHECKER_FAILURE", type(error).__name__ + ": " + str(error)
    usage = resource.getrusage(resource.RUSAGE_SELF)
    receipt["physical"] = {
        "pid": os.getpid(), "parentPid": os.getppid(), "pythonVersion": platform.python_version(),
        "executable": sys.executable, "executableDigest": "sha256:" + sha(Path(sys.executable).resolve().read_bytes()),
        "platform": platform.platform(), "elapsedMs": round((time.monotonic() - started) * 1000),
        "cpuUserMicros": round((usage.ru_utime - cpu.ru_utime) * 1000000),
        "cpuSystemMicros": round((usage.ru_stime - cpu.ru_stime) * 1000000),
        "maxRssNative": usage.ru_maxrss, "maxRssUnit": "PLATFORM_NATIVE",
        "aggregateSimultaneousPeakKnown": False, "usd": None,
    }
    print(json.dumps(receipt, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
