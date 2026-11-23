"""Public fresh finite-model inputs; never imports the producer or its output."""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("original_models", HERE / "fixture-source.py")
original = importlib.util.module_from_spec(spec)
spec.loader.exec_module(original)

FAMILIES = [
    ("direct-accepted-stop", None, None),
    ("two-stage-complementarity", None, None),
    ("eight-stage-dependency", None, None),
    ("unequal-native-alternatives", None, None),
    ("exact-rational-ties", None, None),
    ("observation-contingent-choice", None, None),
    ("nonzero-invalid-observation", None, None),
    ("explicit-zero-support-branch", None, None),
    ("two-resource-conservation", None, None),
    ("unresolved-obligation-retention", None, None),
    ("resolved-obligation-immutability", "ALTERED_RESOLVED_OBLIGATION", "METALEVEL_ALTERED_RESOLVED_OBLIGATION"),
    ("unexecuted-prerequisite", "UNMET_DEPENDENCY", "METALEVEL_UNMET_DEPENDENCY"),
    ("unsafe-accepted-stop", "UNSAFE_ACCEPTED_STOP", "METALEVEL_UNSAFE_ACCEPTED_STOP"),
    ("unaffordable-reservation", "UNAFFORDABLE_RESERVATION", "METALEVEL_UNAFFORDABLE_RESERVATION"),
    ("successor-resource-reset", "RESOURCE_CONSERVATION", "METALEVEL_RESOURCE_CONSERVATION"),
    ("unsupported-seventeenth-computation", "UNSUPPORTED_CHOICE_BOUND", None),
]


def chain(number):
    model = original.base("eight-stage", 8)
    root = original.state("root", [], 8, 50)
    model["states"] = [root]
    model["tieOrder"] = ["stop"]
    current = root
    for depth in range(8):
        choice = "step-" + str(depth)
        history = current["history"] + [{"choiceId": choice, "observation": "OK"}]
        good = original.state("good-" + str(depth), history, 7 - depth,
                              120 + number if depth == 7 else 50, depth == 7)
        bad = original.state("bad-" + str(depth), current["history"] +
                             [{"choiceId": choice, "observation": "INVALID"}], 7 - depth, 0)
        computation = original.computation(choice, [
            original.outcome("OK", good["id"]),
            original.outcome("INVALID", bad["id"], "0", False)])
        if depth:
            computation["dependsOn"] = ["step-" + str(depth - 1)]
        current["choices"].append(computation)
        model["states"].extend([good, bad])
        model["tieOrder"].append(choice)
        current = good
    return model


def contingent(number):
    model = original.base("observation-contingent", 2)
    root = original.state("root", [], 2, 0)
    model["states"] = [root]
    model["tieOrder"] = ["stop", "probe", "left-method", "right-method"]
    probe = original.computation("probe", [])
    root["choices"].append(probe)
    for branch, probability, valid in [("LEFT", "1/2", True), ("RIGHT", "1/2", True),
                                       ("INVALID", "0", False)]:
        history = [{"choiceId": "probe", "observation": branch}]
        middle = original.state(branch, history, 1, 0)
        model["states"].append(middle)
        probe["outcomes"].append(original.outcome(branch, branch, probability, valid))
        if not valid:
            continue
        for method in ["left-method", "right-method"]:
            outcomes = []
            for observation, mass, good in [("OK", "1", True), ("INVALID", "0", False)]:
                identity = branch + "-" + method + "-" + observation
                utility = 100 + number if good and method.startswith(branch.lower()) else 0
                leaf = original.state(identity, history + [{"choiceId": method, "observation": observation}],
                                      0, utility, good)
                model["states"].append(leaf)
                outcomes.append(original.outcome(observation, identity, mass, good))
            action = original.computation(method, outcomes)
            action["dependsOn"] = ["probe"]
            middle["choices"].append(action)
    return model


def make(family, number):
    model = original.complementarity()
    if family == "direct-accepted-stop":
        model = original.base(family, 0)
        model["states"] = [original.state("root", [], 0, 50 + number, True)]
        model["tieOrder"] = ["stop"]
    elif family == "eight-stage-dependency":
        model = chain(number)
    elif family == "unequal-native-alternatives":
        model = original.computation_boundary(2 + number % 3)
        for state in model["states"]:
            if state["id"].startswith("result-"):
                state["choices"][0]["utility"] = str(50 + number + int(state["id"].split("-")[1]))
    elif family == "exact-rational-ties":
        model = original.exact_tie()
        denominator = number + 3
        model["states"][0]["choices"][0]["utility"] = "1/" + str(denominator)
        model["states"][0]["choices"][1]["utilityCost"] = "1/" + str(denominator)
        model["states"][1]["choices"][0]["utility"] = "2/" + str(denominator)
    elif family == "observation-contingent-choice":
        model = contingent(number)
    elif family == "nonzero-invalid-observation":
        model["states"][0]["choices"][1]["outcomes"][0]["probability"] = "3/4"
        model["states"][0]["choices"][1]["outcomes"][1]["probability"] = "1/4"
    elif family == "explicit-zero-support-branch":
        extra = original.state("zero-support", [{"choiceId": "first", "observation": "UNSEEN"}], 1,
                               1000 + number)
        model["states"].append(extra)
        model["states"][0]["choices"][1]["outcomes"].append(
            original.outcome("UNSEEN", "zero-support", "0"))
    elif family == "two-resource-conservation":
        for state in model["states"]:
            state["remaining"]["timeUnits"] = str(int(state["remaining"]["computeUnits"]) * (number + 2))
            for choice in state["choices"]:
                if choice["kind"] == "COMPUTE":
                    choice["reservation"]["timeUnits"] = str(number + 2)
                    for outcome in choice["outcomes"]:
                        outcome["consumption"]["timeUnits"] = str(number + 2)
    elif family in ("unresolved-obligation-retention", "resolved-obligation-immutability"):
        for state in model["states"]:
            state["obligations"] = [{"id": "original-physical-attempt", "status":
                "UNKNOWN" if family.startswith("unresolved") else "RESOLVED",
                "resolutionRef": None if family.startswith("unresolved") else "original-provider-receipt"}]
            if family.startswith("unresolved"):
                state["acceptanceRef"] = None
                for choice in state["choices"]:
                    if choice["kind"] == "STOP":
                        choice.update(disposition="UNKNOWN", resultRef=None)
        if family.startswith("resolved"):
            model["states"][1]["obligations"][0]["resolutionRef"] = "different-provider-receipt"
    elif family == "unexecuted-prerequisite":
        model["states"][0]["choices"][1]["dependsOn"] = ["second"]
    elif family == "unsafe-accepted-stop":
        model["states"][0]["choices"][0]["disposition"] = "ACCEPTED"
    elif family == "unaffordable-reservation":
        model["states"][0]["choices"][1]["reservation"]["computeUnits"] = "3"
    elif family == "successor-resource-reset":
        model["states"][1]["remaining"]["computeUnits"] = "2"
    elif family == "unsupported-seventeenth-computation":
        model = original.computation_boundary(17)
    for state in model["states"]:
        for choice in state["choices"]:
            if choice["kind"] == "STOP" and choice["utility"] == "100":
                choice["utility"] = str(100 + number)
    return model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--seed", required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    cases = []
    for family, reference_reason, production_error in FAMILIES:
        for number in range(8):
            identity = family + "-" + str(number + 1).zfill(2)
            model = make(family, number)
            model["id"] = identity + ":" + args.seed
            for key in model["binding"]:
                if key != "deadline":
                    model["binding"][key] = str(uuid5(NAMESPACE_URL, args.seed + ":" + identity + ":" + key))
            path = args.output / (identity + ".json")
            body = (json.dumps(model, sort_keys=True, indent=2) + "\n").encode()
            with path.open("xb") as out:
                out.write(body)
            cases.append({"id": identity, "family": family, "path": path.name,
                          "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
                          "expectation": "REJECT" if reference_reason else "COMPLETE_MODEL_RELATIVE_POLICY",
                          "referenceReason": reference_reason, "productionError": production_error})
    record = {"schema": "finnor.w1.structural-inputs.v1", "seed": args.seed, "cases": cases,
              "families": len(FAMILIES), "casesPerFamily": 8, "protectedCustody": False,
              "qualification": "PUBLIC_FINITE_MODEL_MECHANISM_ONLY_NOT_EMPIRICAL_NATIVE_OR_PROTECTED"}
    (args.output / "inputs.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"families": len(FAMILIES), "cases": len(cases), "output": str(args.output)}))


if __name__ == "__main__":
    main()
