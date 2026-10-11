"""Finite native producer -> separate checker E2E, with retained repeatable bytes."""
import argparse
from copy import deepcopy
from fractions import Fraction
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time

from corpus import scenarios, MUTATIONS, evaluate_ast, probability, base, bundle

parser = argparse.ArgumentParser()
parser.add_argument("--python", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--comparison-only", action="store_true")
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[3]
native = root / "finnor-os/packages/epistemic-runtime/src/identification-plan"
output = pathlib.Path(args.output)
output.mkdir(parents=True, exist_ok=False)
started = time.monotonic()
cases, candidates = [], {}


def stable(x):
    return json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha(x):
    return hashlib.sha256(stable(x).encode()).hexdigest()


def invoke(kind, request, folder):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "input.json").write_text(stable(request) + "\n")
    begin = time.monotonic()
    p = subprocess.run([args.python, "-I", str(native / (kind + ".py"))], input=stable(request),
                       text=True, capture_output=True, timeout=20,
                       env={k:v for k,v in os.environ.items() if k in {"HOME","PATH","TMPDIR"}})
    (folder / "stderr.txt").write_text(p.stderr)
    (folder / "output.json").write_text(p.stdout)
    assert p.returncode == 0, f"{kind} exit={p.returncode}: {p.stderr}"
    result = json.loads(p.stdout)
    return result, time.monotonic() - begin


def save():
    manifest = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in [native / "producer.py", native / "checker.py", pathlib.Path(__file__),
                          pathlib.Path(__file__).with_name("corpus.py"),
                          pathlib.Path(__file__).with_name("requirements.lock"),
                          root / "scope-r/r4-identification-plan-compiler/verification-plan.json"]}
    result = {"schema":"finnor.r4.scientific-e2e.v1", "status":"FAIL" if any(c["status"]=="FAIL" for c in cases) else "PASS",
              "elapsedSeconds":time.monotonic()-started, "sourceDigests":manifest, "cases":cases,
              "trust":"Separate stdlib derivation/data/menu checker; positive synthetic owner premises, not graph truth or admission",
              "costs":{"moneyUSD":None,"humanSeconds":None,"qualification":"MATERIAL_METERS_INCOMPLETE"},
              "rerun":f"python3 {pathlib.Path(__file__)} --python {args.python} --output <new-private-directory>"}
    (output / "results.json").write_text(json.dumps(result,indent=2)+"\n")


def challenge(id, expected, fn):
    begin = time.monotonic()
    try:
        observed = fn()
        cases.append({"id":id,"status":"PASS","expected":expected,"observed":observed,"seconds":time.monotonic()-begin})
    except Exception as e:
        cases.append({"id":id,"status":"FAIL","expected":expected,"observed":repr(e),"seconds":time.monotonic()-begin})
    save()


def reference(id, problem, expected):
    produced, elapsed = invoke("producer", {"problem":problem}, output / id / "producer")
    if expected.get("invalid"):
        assert produced.get("status") == "INVALID_INPUT", produced
        return {"rejection":produced,"producerSeconds":elapsed}
    assert produced.get("plan"), produced
    checked, checking = invoke("checker", {"problem":problem, "candidate":produced}, output / id / "checker")
    assert checked["status"] == "ACCEPTED", checked
    plan = produced["plan"]
    selected = None if plan["selected"] is None else plan["selected"]["mask"]
    assert selected == expected.get("selected"), (selected, expected, plan)
    if expected.get("functional"):
        expression = produced["proofs"][0]["expression"]
        # Positive joint diagnostic exercises all variable bindings independently.
        names = tuple(problem["graphs"][0]["nodes"])
        import itertools
        weights = {bits:Fraction(1 + sum((i+1)*b for i,b in enumerate(bits)),1) for bits in itertools.product([0,1],repeat=len(names))}
        total = sum(weights.values())
        joint = {bits:w/total for bits,w in weights.items()}
        for x in [0,1]:
            assignment = {n:1 for n in names}; assignment["X"] = x
            assert evaluate_ast(expression,joint,assignment,names) == evaluate_ast(expected["functional"],joint,assignment,names), expression
    if expected.get("rule"):
        def rules(n): return [n["rule"]] + [r for c in n["children"] for r in rules(c)]
        assert expected["rule"] in rules(produced["proofs"][0]["trace"])
    if expected.get("structural"):
        assert any(p["structural"]==expected["structural"] for p in plan["pairs"])
    if expected.get("data"):
        assert any(pair["data"] == expected["data"] for pair in plan["pairs"]), plan["pairs"]
    if expected.get("equivalence"):
        assert plan["commonFunctional"]["status"] == expected["equivalence"]
    if expected.get("identification"):
        assert plan["identification"] == expected["identification"]
    if expected.get("minimality"):
        assert plan["minimality"]["status"] == expected["minimality"]
    if expected.get("rejectedMask") is not None:
        assert plan["masks"][expected["rejectedMask"]]["status"]=="REJECTED"
    if expected.get("unionMask") is not None:
        assert plan["masks"][expected["unionMask"]]["totalCost"]==expected["unionCost"]
    if expected.get("future"):
        assert any(c["prospective"] for p in plan["pairs"] if p["sufficient"] for c in p["conditions"])
    if expected.get("masks"):
        assert len(plan["masks"])==expected["masks"] and len(plan["pairs"])==expected["pairs"]
        assert checked["checks"]["masks"]==expected["masks"] and checked["checks"]["pairs"]==expected["pairs"]
    if id == "opposed-graphs":
        joint = {(0,0):Fraction(3,8),(0,1):Fraction(1,8),(1,0):Fraction(1,8),(1,1):Fraction(3,8)}
        values = [evaluate_ast(p["expression"],joint,{"X":1,"Y":1}) for p in produced["proofs"]]
        assert values == [Fraction(3,4),Fraction(1,2)], values
    candidates[id] = (problem,produced)
    return {"selectedMask":selected,"identification":plan["identification"],"minimality":plan["minimality"],
            "check":checked,"producerSeconds":elapsed,"checkerSeconds":checking}


if not args.comparison_only:
    for id,p,e in scenarios():
        challenge(id,e,lambda id=id,p=p,e=e: reference(id,p,e))

    def mutate(name):
        chosen = "backdoor" if name in {"ancestor","decomposition","district"} else "idc-exchange" if name in {"conditioning","idc-mutilation","separation"} else "idc-normalization" if name=="denominator" else "necessary-affordable"
        p,c = candidates[chosen]
        original, candidate = deepcopy(p), deepcopy(c)
        boundary = None
        def nodes(n):
            yield n
            for child in n["children"]: yield from nodes(child)
        trace_nodes = [n for proof in candidate["proofs"] for n in nodes(proof["trace"])]
        proof_changed = False
        if name == "graph":
            candidate["proofs"][0]["trace"]["graph"]["directed"]=[]
            proof_changed=True; boundary="trace"
        elif name in {"query","conditioning"}:
            candidate["proofs"][0]["trace"]["query"]["z" if name=="conditioning" else "y"]=[]
            proof_changed=True; boundary="trace"
        elif name == "intervention":
            candidate["plan"]["targetQuery"]["scope"]["intervention"]="changed-v2"; boundary="query"
        elif name in {"district","decomposition","ancestor"}:
            rule = "ID6" if name=="district" else "ID4" if name=="decomposition" else "ID3"
            found = next((n for n in trace_nodes if n["rule"]==rule),None)
            if not found:
                # An ID2 reference deliberately retains an irrelevant observed W.
                original,candidate=deepcopy(candidates["recursive-kernel"][0]),deepcopy(candidates["recursive-kernel"][1])
                trace_nodes=[n for proof in candidate["proofs"] for n in nodes(proof["trace"])]
                found=next(n for n in trace_nodes if n["rule"]=="ID2")
            key="district" if name=="district" else "districts" if name=="decomposition" else "ancestors" if found["rule"]=="ID2" else "addedActions"
            found["witness"][key]=[]; proof_changed=True; boundary="district" if name=="district" else "decomposition" if name=="decomposition" else "ancestor"
        elif name in {"idc-mutilation","separation"}:
            test=candidate["proofs"][0]["trace"]["witness"]["tests"][0]
            if name=="idc-mutilation": test["graph"]["directed"]=[]
            else:test["separated"]=not test["separated"]
            proof_changed=True; boundary="separation"
        elif name == "kernel":
            next(n for n in trace_nodes if n["rule"]=="ID6")["witness"]["factors"]=probability(["X"])
            proof_changed=True; boundary="kernel"
        elif name == "source":
            candidate["plan"]["pairs"][-1]["expression"]["law"]="different-law"; boundary="data-support"
        elif name in {"bound-variable","marginalization"}:
            original,candidate=deepcopy(candidates["backdoor"][0]),deepcopy(candidates["backdoor"][1])
            target=candidate["proofs"][0]["trace"]
            if name=="bound-variable":
                target["expression"]={"op":"sum","variables":["X"],"expression":target["expression"]}; boundary="expression"
            else:
                target["witness"]["marginalized"]=["X"]; boundary="decomposition"
            proof_changed=True
        elif name == "denominator":
            candidate["proofs"][0]["trace"]["expression"]["denominator"]=probability(["X"])
            proof_changed=True; boundary="expression"
        elif name == "support":
            candidate["plan"]["pairs"][-1]["conditions"][0]["status"]="UNKNOWN"; boundary="data-support"
        elif name in {"cost","tie"}:
            candidate["plan"]["masks"][2]["totalCost" if name=="cost" else "completion"]={"numerator":"0","denominator":"1"}; boundary="minimality"
        elif name == "mask":
            candidate["plan"]["masks"].pop(); boundary="minimality"
        elif name == "omitted-cheaper":
            candidate["plan"]["pairs"]=candidate["plan"]["pairs"][1:]; boundary="minimality"
        elif name == "backend":
            candidate["method"]["y0"]="0.2.10"; boundary="identity"
        elif name in {"checker","domain"}:
            candidate["identities"][name]="changed"; boundary="identity"
        elif name in {"unsupported-as-missing", "unresolved-as-proved"}:
            original, candidate = deepcopy(candidates["unsupported-cheaper"][0]), deepcopy(candidates["unsupported-cheaper"][1])
            if name == "unsupported-as-missing":
                next(pair for pair in candidate["plan"]["pairs"] if pair["mask"] == 1)["data"] = "MISSING_DATA"
                boundary = "data-support"
            else:
                candidate["plan"]["minimality"]["status"] = "PROVED"
                candidate["plan"]["minimality"]["unresolvedMasks"] = []
                boundary = "minimality"
        if proof_changed:
            mapping={}
            for proof in candidate["proofs"]:
                old=proof["id"]
                proof["id"]=sha({k:v for k,v in proof.items() if k!="id"})
                mapping[old]=proof["id"]
            for pair in candidate["plan"]["pairs"]:
                pair["proofId"]=mapping.get(pair["proofId"],pair["proofId"])
        checked,elapsed=invoke("checker",{"problem":original,"candidate":candidate},output / ("mutation-"+name))
        assert checked["status"]=="REJECTED" and checked["boundary"]==boundary, (name,boundary,checked)
        return {"reachedBoundary":boundary,"check":checked,"seconds":elapsed}
    for name in MUTATIONS:
        challenge("mutation-"+name, "Intended independent boundary rejects mutation, not an earlier unrelated refusal",
                  lambda name=name: mutate(name))

def comparison():
    p=base()
    bundle(p,"a-marginal",["X"],cost=1)
    bundle(p,"b-joint",cost=3,delay=3)
    bundle(p,"c-expensive-joint",cost=9,delay=5)
    p["baseline"]=[]
    candidate,elapsed=invoke("producer",{"problem":p},output/"comparison"/"on")
    checked,checking=invoke("checker",{"problem":p,"candidate":candidate},output/"comparison"/"check")
    assert checked["status"]=="ACCEPTED"
    on=candidate["plan"]["selected"]
    off=candidate["plan"]["masks"][4]
    assert on["mask"]==2
    result={"sameOriginalInputDigest":sha(p),"r4OffEquippedBackendPlan":off,"r4On":on,
            "plannedCostDeltaUSD":str(Fraction(9)-Fraction(3)),
            "compilerSeconds":elapsed,"checkerSeconds":checking,
            "actualAcquisitionCost":None,"decisionShortfall":None,"protectedGain":"NOT_RUN",
            "economicCreditGranted":False,"basis":"SYNTHETIC_PLANNED_MENU_SEARCH_DIAGNOSTIC_ONLY"}
    (output/"comparison.json").write_text(json.dumps(result,indent=2)+"\n")
    return result
challenge("matched-diagnostic","Same input and equipped backend; planned saving only, no protected gain",comparison)
save()
print(json.dumps({"output":str(output),"passed":sum(c["status"]=="PASS" for c in cases),"failed":sum(c["status"]=="FAIL" for c in cases)}))
sys.exit(1 if any(c["status"]=="FAIL" for c in cases) else 0)
