"""Independent original-programme expectations before any shared production.

Uses the public direct Python/Fraction interpreter, never produce(), shared keys,
cached intermediates or a producer-selected certificate. This is not protected
custody and does not assert source truth or native admission.
"""
import importlib.util
import copy
import functools
import json
import pathlib
import sys
from graphlib import TopologicalSorter


def main():
    base = pathlib.Path(__file__).resolve().parents[3]
    path = base / "packages/epistemic-runtime/src/project-z/z1-shared-work/original_checker.py"
    spec = importlib.util.spec_from_file_location("z1_public_original_interpreter", path)
    original = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(original)
    raw = sys.stdin.buffer.read(134217729)
    original.need(len(raw) <= 134217728, "ORIGINAL_INPUT_BYTE_BOUND")
    payload = json.loads(raw, parse_float=lambda _: (_ for _ in ()).throw(ValueError("FLOAT_UNSUPPORTED")))
    request = copy.deepcopy(payload.get("request", payload))
    changes = payload.get("changes", {})
    for change in changes.get("sourceChanges", []):
        source = next(source for source in request["sources"] if source["id"] == change["sourceId"])
        original.need(source["revision"] == change["fromRevision"] != change["toRevision"], "SOURCE_REVISION_FENCED")
        # Independently maintain the original bag, including zero-count slots.
        bag = {}
        for row in source["rows"]:
            row = original.normalize(row, source["columns"])
            key = original.stable(row)
            bag.setdefault(key, [row, 0])[1] += 1
        for row in change["retract"]:
            key = original.stable(original.normalize(row, source["columns"]))
            original.need(key in bag and bag[key][1] > 0, "NEGATIVE_ORIGINAL_BAG_MULTIPLICITY")
            bag[key][1] -= 1
        for row in change["insert"]:
            row = original.normalize(row, source["columns"])
            bag.setdefault(original.stable(row), [row, 0])[1] += 1
        source["rows"] = [row for row, count in bag.values() for _ in range(count)]
        source["revision"] = change["toRevision"]
        if "revoked" in change:
            source["revoked"] = change["revoked"]
    for change in changes.get("workEdits", []):
        index = next(i for i, work in enumerate(request["works"]) if work["id"] == change["workId"])
        old, replacement = request["works"][index], change["replacement"]
        original.need(old["programmeRevision"] == change["expectedProgrammeRevision"] and
                      replacement["id"] == old["id"] and replacement["programmeRevision"] != old["programmeRevision"],
                      "ORIGINAL_PROGRAMME_REVISION_FENCED")
        original.need(old["resources"] == replacement["resources"] and
                      old["partition"] == replacement["partition"] and
                      set(old["unresolvedObligationRefs"]) <= set(replacement["unresolvedObligationRefs"]),
                      "ORIGINAL_PARENT_SCOPE_AND_RESPONSIBILITY_RETAINED")
        request["works"][index] = copy.deepcopy(replacement)
    for work_id in changes.get("withdrawWorkIds", []):
        next(work for work in request["works"] if work["id"] == work_id)["withdrawn"] = True
    sources = {source["id"]: source for source in request["sources"]}
    expected = {}
    for work in request["works"]:
        nodes = {node["id"]: node for node in work["programme"]["nodes"]}
        original.need(len(nodes) == len(work["programme"]["nodes"]), "DUPLICATE_ORIGINAL_NODE")
        if work["withdrawn"] or any(sources[node["sourceId"]]["revoked"] for node in nodes.values() if node["op"] == "source"):
            expected[work["id"]] = None
            continue
        values = {}
        for node_id in TopologicalSorter({key: original.inputs(node) for key, node in nodes.items()}).static_order():
            values[node_id] = original.original_operator(nodes[node_id], values, sources, work["parameters"])
        expected[work["id"]] = values[work["programme"]["output"]]
    owner_uses = {}
    for work in request["works"]:
        relation, consumer = expected[work["id"]], payload.get("consumers", {}).get(work["id"])
        if relation is None or consumer is None:
            owner_uses[work["id"]] = None
        elif consumer["owner"] == "S3":
            field = consumer["measureField"]
            original.need(original.number_type(relation["columns"][field]), "EXACT_ORIGINAL_MODEL_MEASURE_REQUIRED")
            total = sum((original.quantity(row[field]) for row in relation["rows"]), original.quantity("0"))
            owner_uses[work["id"]] = {"owner": "S3", "value": original.qtext(total), "type": relation["columns"][field]}
        else:
            field, action = consumer["valueField"], consumer["actionField"]
            def compare(left, right):
                order = original.compare(left[field], right[field], relation["columns"][field])
                if order:
                    return -order if consumer["direction"] == "MAXIMIZE" else order
                left_key, right_key = original.lexical(original.stable(left)), original.lexical(original.stable(right))
                return (left_key > right_key) - (left_key < right_key)
            rows = sorted(relation["rows"], key=functools.cmp_to_key(compare))
            selected = None if work["unresolvedObligationRefs"] else next(iter(rows), None)
            choice = selected[action] if selected is not None else (
                "WAIT_ORIGINAL_S6_RECONCILIATION" if work["unresolvedObligationRefs"] else "WAIT_NO_ELIGIBLE_ORIGINAL_RESULT")
            owner_uses[work["id"]] = {"owner": "S4", "choice": choice, "selected": selected}
    print(json.dumps({"schema": "finnor.z1.original-expectations.v1", "request": request, "requestDigest": original.sha(request),
                      "outputs": expected, "digests": {key: original.sha(value) for key, value in expected.items()},
                      "ownerUses": owner_uses,
                      "scope": "PUBLIC_ORIGINAL_INTERPRETATION_BEFORE_SHARED_OUTPUT_NOT_PROTECTED_CUSTODY"},
                     separators=(",", ":"), ensure_ascii=True))


if __name__ == "__main__":
    main()
