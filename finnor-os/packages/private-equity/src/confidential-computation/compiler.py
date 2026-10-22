"""General P1-expression lowering. This process has no participant input API."""
from __future__ import annotations

import hashlib
import json
import re
import sys
import datetime
import uuid
from dataclasses import dataclass
from pathlib import Path

PROFILE_BYTES = Path(__file__).with_name("profile.json").read_bytes()
PROFILE = json.loads(PROFILE_BYTES)
LIMIT = int(PROFILE["maxIntegerMagnitudeExclusive"])
KEY = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}\Z")
DECIMAL = re.compile(r"[+-]?\d+(?:\.\d+)?\Z")
UNITS = {"currency", "count", "ratio", "multiple", "rate"}
DIMENSIONLESS = {"count", "ratio", "multiple", "rate"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def require(predicate, reason):
    if not predicate:
        raise ValueError(reason)


def decimal(value):
    require(isinstance(value, str) and len(value) <= 96 and DECIMAL.fullmatch(value),
            "EXACT_CANONICAL_DECIMAL_REQUIRED")
    negative = value.startswith("-")
    whole, _, fraction = value.lstrip("+-").partition(".")
    return int(whole + fraction) * (-1 if negative else 1), len(fraction)


def shape(value, fields):
    require(isinstance(value, dict) and set(value) == set(fields), "EXACT_FUNCTION_SHAPE_REQUIRED")


def ref(value):
    shape(value, ("owner", "id", "version", "contentDigest"))
    require(all(isinstance(value[k], str) and 0 < len(value[k]) <= 512
                for k in ("owner", "id", "version")), "VERSIONED_OWNER_REF_REQUIRED")
    require(re.fullmatch(r"[a-f0-9]{64}", value["contentDigest"]) is not None,
            "OWNER_REF_DIGEST_REQUIRED")


def financial_semantics(value):
    shape(value, ("entityType", "entityId", "periodStart", "periodEnd", "unit", "currencyCode",
                  "frequency", "calendar", "consolidation", "instrument", "scale", "sign"))
    require(isinstance(value["entityType"], str) and len(value["entityType"]) <= 64
            and isinstance(value["instrument"], str) and len(value["instrument"]) <= 128,
            "CANONICAL_FINANCIAL_SEMANTICS_REQUIRED")
    uuid.UUID(value["entityId"])
    start, end = [datetime.datetime.fromisoformat(value[k].replace("Z", "+00:00"))
                  for k in ("periodStart", "periodEnd")]
    require(start.tzinfo is not None and end.tzinfo is not None and start <= end,
            "CANONICAL_FINANCIAL_TIME_INTERVAL_REQUIRED")
    require(value["frequency"] in ("annual", "quarterly", "monthly", "instant", "daily", "weekly", "event")
            and value["calendar"] in ("OWNER_RECORDED", "GREGORIAN")
            and value["consolidation"] in ("OWNER_SUBJECT_ONLY", "CONSOLIDATED", "STANDALONE"),
            "CANONICAL_FINANCIAL_TIME_AND_SCOPE_REQUIRED")
    require(value["unit"] in UNITS and (value["unit"] == "currency") == (value["currencyCode"] is not None)
            and (value["currencyCode"] is None or re.fullmatch(r"[A-Z]{3}", value["currencyCode"])),
            "CANONICAL_FINANCIAL_DIMENSION_REQUIRED")
    require(value["scale"] == "1" and value["sign"] == "AS_RECORDED", "OWNER_NORMALIZED_INPUT_REQUIRED")
    return tuple(value[k] for k in ("periodStart", "periodEnd", "frequency", "calendar"))


@dataclass(frozen=True)
class Number:
    register: int
    scale: int
    low: int
    high: int
    unit: str
    currency: str | None


class Compiler:
    def __init__(self, function):
        self.function = function
        self.nodes = []
        self.used = set()
        self.steps = 0
        self.inputs = {}
        self.memo = {}

    def node(self, operation, scale, low, high, unit, currency, **body):
        require(0 <= scale <= PROFILE["maxScale"], "INTERMEDIATE_DECIMAL_SCALE_UNSUPPORTED")
        require(-LIMIT < low <= high < LIMIT, "INTERMEDIATE_INTEGER_RANGE_UNSUPPORTED")
        n = Number(len(self.nodes), scale, low, high, unit, currency)
        self.nodes.append({"op": operation, "scale": scale, "low": str(low), "high": str(high),
                           "unit": unit, "currencyCode": currency, **body})
        return n

    def align(self, a, b):
        scale = max(a.scale, b.scale)
        x, y = 10 ** (scale - a.scale), 10 ** (scale - b.scale)
        require(max(abs(a.low * x), abs(a.high * x), abs(b.low * y), abs(b.high * y)) < LIMIT,
                "ALIGNED_INTEGER_RANGE_UNSUPPORTED")
        return scale, x, y

    def same_dimension(self, a, b):
        require((a.unit, a.currency) == (b.unit, b.currency), "FINANCIAL_UNIT_CURRENCY_MISMATCH")

    def lower(self, expression, depth=1):
        self.steps += 1
        require(self.steps <= PROFILE["maxExpressionNodes"] and depth <= PROFILE["maxDepth"],
                "CANONICAL_EXPRESSION_BOUND")
        require(isinstance(expression, dict), "CANONICAL_EXPRESSION_REQUIRED")
        cache_key = canonical(expression)
        if cache_key in self.memo:
            return self.memo[cache_key]
        kind = expression.get("kind")
        if kind == "input":
            shape(expression, ("kind", "key"))
            key = expression["key"]
            require(key in self.inputs, "UNRESOLVED_PARTICIPANT_INPUT")
            self.used.add(key)
            result = self.inputs[key]
        elif kind == "literal":
            shape(expression, ("kind", "value", "unit", "currencyCode"))
            value, scale = decimal(expression["value"])
            unit, currency = expression["unit"], expression["currencyCode"]
            require(unit in UNITS and (unit == "currency") == (currency is not None),
                    "LITERAL_DIMENSION_INVALID")
            result = self.node("literal", scale, value, value, unit, currency, value=str(value))
        elif kind == "if":
            shape(expression, ("kind", "condition", "whenTrue", "whenFalse"))
            condition = expression["condition"]
            shape(condition, ("comparison", "left", "right"))
            require(condition["comparison"] in PROFILE["comparisons"], "COMPARISON_UNSUPPORTED")
            a, b = [self.lower(condition[k], depth + 1) for k in ("left", "right")]
            self.same_dimension(a, b)
            _, ax, bx = self.align(a, b)
            yes, no = [self.lower(expression[k], depth + 1) for k in ("whenTrue", "whenFalse")]
            self.same_dimension(yes, no)
            scale, yx, nx = self.align(yes, no)
            result = self.node("if", scale, min(yes.low * yx, no.low * nx),
                               max(yes.high * yx, no.high * nx), yes.unit, yes.currency,
                               left=a.register, right=b.register, leftFactor=str(ax),
                               rightFactor=str(bx), comparison=condition["comparison"],
                               whenTrue=yes.register, whenFalse=no.register,
                               trueFactor=str(yx), falseFactor=str(nx))
        else:
            require(kind in {"add", "subtract", "multiply", "ratio", "min", "max"},
                    "CANONICAL_OPERATION_UNSUPPORTED")
            shape(expression, ("kind", "left", "right"))
            a, b = [self.lower(expression[k], depth + 1) for k in ("left", "right")]
            if kind == "multiply":
                require((a.unit in DIMENSIONLESS and a.currency is None)
                        or (b.unit in DIMENSIONLESS and b.currency is None),
                        "UNDEFINED_MULTIPLICATION_UNIT")
                dimension = a if b.unit in DIMENSIONLESS and b.currency is None else b
                products = [x * y for x in (a.low, a.high) for y in (b.low, b.high)]
                result = self.node(kind, a.scale + b.scale, min(products), max(products),
                                   dimension.unit, dimension.currency, left=a.register, right=b.register)
            elif kind == "ratio":
                self.same_dimension(a, b)
                shift = b.scale + PROFILE["ratioDecimalPlaces"] - a.scale
                nf, df = 10 ** max(shift, 0), 10 ** max(-shift, 0)
                maximum = max(abs(a.low), abs(a.high)) * nf
                require(maximum < LIMIT and max(abs(b.low), abs(b.high)) * df < LIMIT,
                        "EXACT_DIVISION_RANGE_UNSUPPORTED")
                result = self.node(kind, PROFILE["ratioDecimalPlaces"], -maximum, maximum,
                                   "multiple", None, left=a.register, right=b.register,
                                   numeratorFactor=str(nf), denominatorFactor=str(df))
            else:
                self.same_dimension(a, b)
                scale, ax, bx = self.align(a, b)
                alo, ahi, blo, bhi = a.low * ax, a.high * ax, b.low * bx, b.high * bx
                bounds = {"add": (alo + blo, ahi + bhi), "subtract": (alo - bhi, ahi - blo),
                          "min": (min(alo, blo), min(ahi, bhi)), "max": (max(alo, blo), max(ahi, bhi))}
                result = self.node(kind, scale, *bounds[kind], a.unit, a.currency,
                                   left=a.register, right=b.register, leftFactor=str(ax), rightFactor=str(bx))
        self.memo[cache_key] = result
        return result

    def compile(self):
        f = self.function
        shape(f, ("schema", "functionRef", "workRevisionRef", "baselineManifestRef", "objectiveRef",
                  "mandateRef", "jointSemanticsRef", "purpose", "participants", "inputs", "outputs", "release"))
        require(f["schema"] == "finnor.confidential-function.v1", "CANONICAL_FUNCTION_VERSION_REQUIRED")
        for k in ("functionRef", "workRevisionRef", "baselineManifestRef", "objectiveRef",
                  "mandateRef", "jointSemanticsRef"):
            ref(f[k])
        require(isinstance(f["purpose"], str) and 0 < len(f["purpose"]) <= 1000, "PURPOSE_REQUIRED")
        participants = f["participants"]
        require(isinstance(participants, list) and 3 <= len(participants) <= 8, "PARTICIPANT_PROFILE_UNSUPPORTED")
        identities = []
        for p in participants:
            shape(p, ("id", "institutionId", "authorityRef"))
            require(isinstance(p["id"], str) and KEY.fullmatch(p["id"]), "PARTICIPANT_ID_REQUIRED")
            require(isinstance(p["institutionId"], str) and p["institutionId"], "INSTITUTION_ID_REQUIRED")
            ref(p["authorityRef"])
            identities.append(p["id"])
        require(len(set(identities)) == len(identities)
                and len({p["institutionId"] for p in participants}) == len(participants),
                "SEPARATELY_CONTROLLED_PARTICIPANT_DECLARATIONS_REQUIRED")
        require(1 <= len(f["inputs"]) <= 16 and 1 <= len(f["outputs"]) <= 16, "FUNCTION_PORT_BOUND")
        time_cut = None
        for index, port in enumerate(f["inputs"]):
            shape(port, ("key", "participantId", "semantics", "lower", "upper", "decimalPlaces",
                         "sourceRef", "grantRef", "validationRef", "primaryEvidenceRef", "sourceStatus",
                         "freshUntil", "rounding"))
            key = port["key"]
            require(isinstance(key, str) and KEY.fullmatch(key) and key not in self.inputs,
                    "UNIQUE_CANONICAL_INPUT_REQUIRED")
            require(port["participantId"] in identities, "PARTICIPANT_INPUT_OWNER_REQUIRED")
            for k in ("sourceRef", "grantRef", "validationRef"):
                ref(port[k])
            require(port["sourceStatus"] in ("PRIMARY_CONFIRMED", "OWNER_ASSERTED", "ESTIMATED"),
                    "INPUT_SOURCE_STATUS_REQUIRED")
            if port["primaryEvidenceRef"] is not None:
                ref(port["primaryEvidenceRef"])
            require(port["sourceStatus"] != "PRIMARY_CONFIRMED" or port["primaryEvidenceRef"] is not None,
                    "PRIMARY_CONFIRMATION_REFERENCE_REQUIRED")
            require(port["rounding"] == "EXACT_OR_REJECT", "NUMERICAL_CONTRACT_UNSUPPORTED")
            require(type(port["decimalPlaces"]) is int and 0 <= port["decimalPlaces"] <= 18,
                    "INPUT_LATTICE_SCALE_UNSUPPORTED")
            scale = port["decimalPlaces"]
            lo, ls = decimal(port["lower"])
            hi, hs = decimal(port["upper"])
            require(ls <= scale and hs <= scale, "INPUT_BOUND_NOT_ON_LATTICE")
            lo, hi = lo * 10 ** (scale - ls), hi * 10 ** (scale - hs)
            require(-(2 ** 63) < lo <= hi < 2 ** 63, "SIGNED_INPUT_RANGE_UNSUPPORTED")
            semantics = port["semantics"]
            cut = financial_semantics(semantics)
            if time_cut is not None:
                require(time_cut == cut, "JOINT_TIME_BASIS_MISMATCH")
            time_cut = cut
            self.inputs[key] = self.node("input", scale, lo, hi, semantics["unit"],
                                         semantics["currencyCode"], inputIndex=index)
        outputs = []
        for output in f["outputs"]:
            shape(output, ("key", "expression", "semantics", "recipients"))
            require(isinstance(output["key"], str) and KEY.fullmatch(output["key"]), "OUTPUT_KEY_REQUIRED")
            result = self.lower(output["expression"])
            require(financial_semantics(output["semantics"]) == time_cut, "OUTPUT_TIME_BASIS_MISMATCH")
            require((result.unit, result.currency) ==
                    (output["semantics"]["unit"], output["semantics"]["currencyCode"]), "OUTPUT_DIMENSION_MISMATCH")
            recipients = output["recipients"]
            require(isinstance(recipients, list) and recipients and len(set(recipients)) == len(recipients)
                    and set(recipients) <= set(identities), "EXPLICIT_OUTPUT_RECIPIENTS_REQUIRED")
            outputs.append({"key": output["key"], "register": result.register, "scale": result.scale,
                            "recipients": recipients})
        require(len({o["key"] for o in outputs}) == len(outputs), "UNIQUE_OUTPUT_KEYS_REQUIRED")
        require(self.used == set(self.inputs), "MATERIAL_INPUT_COVERAGE_REQUIRED")
        require({p["participantId"] for p in f["inputs"]} == set(identities),
                "ALL_PARTICIPANTS_REQUIRE_LOCAL_INPUT")
        shape(f["release"], ("familyId", "policyRef", "termsRef", "maxDistinctFunctions"))
        for k in ("policyRef", "termsRef"):
            ref(f["release"][k])
        require(isinstance(f["release"]["familyId"], str) and 0 < len(f["release"]["familyId"]) <= 200
                and f["release"]["maxDistinctFunctions"] == 1, "CUMULATIVE_RELEASE_PROFILE_REQUIRED")
        return {"schema": "finnor.y4.arithmetic-protocol.v1", "functionDigest": digest(f),
                "profileDigest": hashlib.sha256(PROFILE_BYTES).hexdigest(), "nodes": self.nodes,
                "outputs": outputs, "function": f}


def compile_function(function):
    require(len(canonical(function)) <= 262144, "FUNCTION_BYTE_BOUND")
    return Compiler(function).compile()


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(262145)
        require(len(raw) <= 262144, "FUNCTION_BYTE_BOUND")
        print(canonical({"result": "CANDIDATE", "protocol": compile_function(json.loads(raw))}))
    except (ValueError, KeyError, TypeError, RecursionError, OverflowError):
        print(canonical({"result": "UNSUPPORTED", "gap": "CANONICAL_PROFILE_OR_NUMERICAL_PREMISE_UNPASSED"}))
        sys.exit(2)
