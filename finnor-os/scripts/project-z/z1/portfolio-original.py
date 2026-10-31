"""Public portfolio-episode oracle, frozen before shared production.

Reads the original three-operator programmes and every opaque envelope. No
shared DAG, TypeScript capacity helper, DB, authentication or owner ports.
"""
from fractions import Fraction
import hashlib
import json
import os
import sys


def need(condition, message):
    if not condition:
        raise ValueError(message)


def text(value):
    return str(value.numerator) if value.denominator == 1 else f"{value.numerator}/{value.denominator}"


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def capacity(resource, outstanding, requested):
    used = []
    for period in range(resource["horizon"]["periods"] + 1):
        indices = [period] if resource["kind"] == "OCCUPANCY" else range(period + 1)
        total = sum((Fraction(resource["existingUse"][i]) for i in indices), Fraction())
        for commitment in outstanding:
            for envelope in commitment["envelopes"]:
                if envelope["resourceId"] == resource["resourceId"]:
                    need(envelope["horizon"] == resource["horizon"] and envelope["kind"] == resource["kind"] and
                         envelope["unit"] == resource["unit"], "ORIGINAL_RESOURCE_SEMANTICS")
                    total += sum((Fraction(envelope["quantities"][i]) for i in indices), Fraction())
        used.append(total)
    margins = [Fraction(value["amount"]) - Fraction(resource["safetyMargin"]) - total - Fraction(requested)
               for value, total in zip(resource["availability"], used)]
    return {"occupation": list(map(text, used)), "margins": list(map(text, margins)),
            "fits": all(value >= 0 for value in margins)}


raw = sys.stdin.buffer.read(134217729)
need(len(raw) <= 134217728, "ORIGINAL_INPUT_BOUND")
payload = json.loads(raw)
request = payload["request"]
sources = {source["id"]: source for source in request["sources"]}
outputs = {}
maximum_bits = 0
for work in request["works"]:
    nodes = work["programme"]["nodes"]
    need(len(nodes) == 3 and [node["op"] for node in nodes] == ["source", "project", "sum"], "ORIGINAL_THREE_NODE_MOTIF")
    source, project, aggregate = nodes
    need(project == {"id": "scale", "op": "project", "input": source["id"], "semantics": "bag",
                     "fields": {"amount": {"op": "mul", "left": {"op": "field", "name": "amount"},
                                           "right": {"op": "param", "name": "factor"}}}} and
         aggregate == {"id": "answer", "op": "sum", "input": project["id"], "keys": [],
                       "values": {"amount": {"op": "field", "name": "amount"}}, "empty": "zero"} and
         work["programme"]["output"] == "answer", "ORIGINAL_OPERATOR_MEANING")
    original = sources[source["sourceId"]]
    value = sum((Fraction(row["amount"]) * Fraction(work["parameters"]["factor"]["value"])
                 for row in original["rows"]), Fraction())
    maximum_bits = max(maximum_bits, abs(value.numerator).bit_length(), value.denominator.bit_length())
    need(maximum_bits <= 512, "ORIGINAL_512_BIT_COMPONENT_BOUND")
    outputs[work["id"]] = {"columns": {"amount": original["columns"]["amount"]},
                           "rows": [{"amount": text(value)}], "ordered": False}
original_parents = {work["resources"]["parentReservationRef"] for work in request["works"]}
need(len(original_parents) == len(request["works"]), "ONE_PARENT_PER_ORIGINAL")
counts = {}
for name in ["before", "after"]:
    rows = payload[name]
    identifiers = [row["reservationRef"]["id"] for row in rows]
    need(len(set(identifiers)) == len(identifiers), "NO_DUPLICATE_OCCUPATION")
    counts[name] = {"originals": sum(identifier in original_parents for identifier in identifiers),
                    "other": sum(identifier not in original_parents for identifier in identifiers)}
result = {"schema": "finnor.z1.public-original-portfolio-oracle.v1", "requestDigest": sha(request),
          "outputs": outputs, "digests": {key: sha(value) for key, value in outputs.items()},
          "maximumOriginalResultComponentBits": maximum_bits, "population": counts,
          "capacityBefore": {}, "capacityAfter": {}, "oneUnitShort": {}, "affinity": sorted(os.sched_getaffinity(0)),
          "python": sys.version, "databaseActions": 0}
for resource in payload["resources"]:
    key = resource["resourceId"]
    result["capacityBefore"][key] = capacity(resource, payload["before"], payload["requested"][key])
    result["capacityAfter"][key] = capacity(resource, payload["after"], "0")
    short = json.loads(json.dumps(resource))
    short["availability"][-1]["amount"] = str(int(short["availability"][-1]["amount"]) - 1)
    result["oneUnitShort"][key] = capacity(short, payload["after"], "0")
need(all(value["fits"] for value in result["capacityAfter"].values()), "ORIGINAL_PORTFOLIO_MUST_FIT")
need(all(not value["fits"] for value in result["oneUnitShort"].values()), "ORIGINAL_SHORTAGE_MUST_FAIL")
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
