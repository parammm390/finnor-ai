"""Finite native E2E corpus. Retains inputs/commands/raw failures and reruns."""
import argparse
import copy
import datetime
import hashlib
import json
from fractions import Fraction
import pathlib
import platform
import resource
import subprocess
import sys
import time
from fixtures import fixture, posted_rule, q, NATIVE, ROOT
from reference import enumerate_small

parser = argparse.ArgumentParser()
parser.add_argument("--python", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
out = pathlib.Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=False)
results, invocations = [], []
started = time.monotonic()


def save(name, value):
    (out / (name + ".json")).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def child(name, script, request):
    save(name + "-input", request)
    begin = time.monotonic()
    command = [args.python, "-I", str(NATIVE / script)]
    # Producer uses its own scope-local repair module. -I excludes cwd/PYTHONPATH;
    # an explicit bootstrap path is needed ONLY for the producer, not checker.
    if script == "producer.py":
        command = [args.python, "-I", "-c", "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[1]+'/producer.py',run_name='__main__')", str(NATIVE)]
    run = subprocess.run(command, input=json.dumps(request), text=True, capture_output=True, timeout=28)
    (out / (name + ".stderr")).write_text(run.stderr)
    (out / (name + ".stdout")).write_text(run.stdout)
    invocations.append({"case": name, "command": command, "exitCode": run.returncode, "elapsedMs": (time.monotonic() - begin) * 1000,
                        "inputDigest": hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                        "money": None, "moneyBasis": "UNMETERED"})
    if run.returncode != 0:
        raise AssertionError("CHILD_FAILED:%s:%s" % (script, run.stderr[-1000:]))
    value = json.loads(run.stdout)
    save(name + "-output", value)
    return value


def case(name, fn):
    try:
        observed = fn()
        results.append({"id": name, "status": "PASS", "observed": observed})
    except Exception as e:
        results.append({"id": name, "status": "FAIL", "error": str(e), "type": type(e).__name__})
    save("results", {"results": results, "invocations": invocations, "qualification": "NATIVE_MODEL_RELATIVE_ONLY_NOT_OWNER_WORK_OR_ADMISSION"})
    print(json.dumps(results[-1], sort_keys=True))


def full():
    p = fixture()
    produced = child("full", "producer.py", {"problem": p, "seconds": 24})
    assert produced["rule"], produced
    checked = child("full-check", "checker.py", {"problem": p, "rule": produced["rule"]})
    assert checked["accepted"], checked
    assert checked["counts"] == {"profiles": 81, "deviations": 648, "participation": 324}
    assert produced["trace"]["counts"]["outcomeBinaries"] == 243
    assert produced["trace"]["counts"]["scalarTransfers"] == 324
    assert len({row["outcomeId"] for row in produced["rule"]["table"]}) >= 2
    return {"counts": checked["counts"], "objective": checked["objective"], "optimum": checked["optimum"], "gap": checked["optimizationGap"]}


case("full-interacting-81", full)


def small():
    p = fixture("small")
    reference = enumerate_small(p)
    save("small-reference", reference)
    assert reference["examined"] == 4096
    proposed = child("small", "producer.py", {"problem": p, "seconds": 24})
    assert proposed["rule"], proposed
    checked = child("small-check", "checker.py", {"problem": p, "rule": proposed["rule"]})
    assert checked["accepted"], checked
    assert checked["objective"] == reference["optimum"], (checked, reference)
    return reference


case("small-complete-reference", small)
p = fixture("posted")
rule = posted_rule(p)


def posted():
    checked = child("posted", "checker.py", {"problem": p, "rule": rule})
    assert checked["accepted"], checked
    bad = copy.deepcopy(rule)
    for row in bad["table"]:
        if row["reports"][0] == "1":
            row["schedule"][0]["amount"] = q()
    failed = child("rebate", "checker.py", {"problem": p, "rule": bad})
    lies = [w for w in failed["failures"] if w["constraint"] == "UNILATERAL_DEVIATION"]
    assert len(lies) == 27 and all(w["gain"] == q(1) for w in lies), failed
    return {"passCounts": checked["counts"], "beneficialLies": len(lies), "gain": q(1)}


case("posted-price-and-rebate", posted)


def mutate(name, change, original=False, expected=None):
    problem, proposed = copy.deepcopy(p), copy.deepcopy(rule)
    change(problem, proposed)
    if original:
        proposed["inputDigest"] = hashlib.sha256(json.dumps(problem, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        proposed["binding"] = problem["binding"]
    checked = child(name, "checker.py", {"problem": problem, "rule": proposed})
    assert not checked["accepted"], checked
    if expected:
        assert any(w["constraint"] == expected for w in checked["failures"]), checked
    return checked["failures"][0]


mutations = [
    ("missing-profile", lambda p, r: r["table"].pop(), False, "PROFILE_COUNT_MISMATCH"),
    ("duplicate-profile", lambda p, r: r["table"].__setitem__(1, copy.deepcopy(r["table"][0])), False, "DUPLICATE_OR_FOREIGN_PROFILE"),
    ("hidden-type", lambda p, r: r["table"][0].__setitem__("trueTypePredicate", "0"), False, "DETERMINISTIC_RULE_ONLY_NO_HIDDEN_PREDICATES"),
    ("randomized-outcome", lambda p, r: r["table"][0].__setitem__("outcomeId", ["A", "wait"]), False, None),
    ("reversed-payment", lambda p, r: r["table"][27]["schedule"][0].__setitem__("amount", q(1)), False, "PARTY_PAYMENT_BOUND"),
    ("currency", lambda p, r: r["table"][0]["schedule"][0].__setitem__("currency", "EUR"), False, "PAYMENT_EVENT_UNIT_CURRENCY_TIME_MISMATCH"),
    ("date", lambda p, r: r["table"][0]["schedule"][0].__setitem__("dueAt", "2026-10-11T00:00:00.000Z"), False, "PAYMENT_EVENT_UNIT_CURRENCY_TIME_MISMATCH"),
    ("unobservable-event", lambda p, r: r["table"][0]["schedule"][0].__setitem__("eventId", "hidden-preference"), False, "PAYMENT_EVENT_UNIT_CURRENCY_TIME_MISMATCH"),
    ("outside-option", lambda p, r: p["parties"][0]["types"][0]["outsideOptions"][0].__setitem__("utility", q(1)), True, "EX_POST_PARTICIPATION"),
    ("resource", lambda p, r: p["resources"][1].__setitem__("availability", [q(), q()]), True, "HARD_RESOURCE"),
    ("proof", lambda p, r: r["search"].__setitem__("proof", {"solver": "optimal"}), False, "UNADMITTED_BACKEND_PROOF_OR_SEARCH_BASIS"),
    ("unproved-optimum", lambda p, r: r["search"].__setitem__("optimum", "ORIGINAL_ANALYTIC_BOUND_ATTAINED"), False, "UNPROVED_OPTIMUM"),
    ("checker-version", lambda p, r: p["binding"].__setitem__("checkerDigest", "0" * 64), True, "CHECKER_VERSION_CUSTODY_MISMATCH"),
    ("input-digest", lambda p, r: r.__setitem__("inputDigest", "0" * 64), False, "ORIGINAL_INPUT_OWNER_METHOD_BINDING_MISMATCH"),
    ("collusive-claim", lambda p, r: p["model"].__setitem__("guarantee", "COLLUSION_PROOF"), True, "UNSUPPORTED_PREFERENCE_EVENT_OR_STRATEGIC_CLAIM"),
    ("expected-event", lambda p, r: p["model"].__setitem__("events", "ASSUMED_SUCCESS"), True, "UNSUPPORTED_PREFERENCE_EVENT_OR_STRATEGIC_CLAIM"),
]
for name, fn, original, expected in mutations:
    case(name, lambda name=name, fn=fn, original=original, expected=expected: mutate(name, fn, original, expected))


def infeasible():
    original = copy.deepcopy(p)
    original["parties"][0]["types"][0]["outsideOptions"][0]["utility"] = q(100)
    accepted = child("contradiction", "checker.py", {"operation": "contradiction", "problem": original})
    unknown = child("no-proof", "checker.py", {"operation": "contradiction", "problem": p})
    assert accepted["status"] == "INFEASIBLE" and unknown["status"] == "UNKNOWN"
    return {"checked": accepted, "noProof": unknown}


case("infeasible-and-unknown", infeasible)

def original_rule(problem, proposed):
    proposed["inputDigest"]=hashlib.sha256(json.dumps(problem,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
    proposed["binding"]=problem["binding"]
    return proposed

def rational_boundary():
    problem,proposed=fixture("posted"),posted_rule(fixture("posted"))
    for t in problem["parties"][0]["types"]:
        t["values"]["A"]=q(int(t["id"]),3)
        t["outsideOptions"]=[{"otherReports":o["otherReports"],"utility":q(int(t["id"])==2,3)} for o in t["outsideOptions"]]
    for row in proposed["table"]:
        if row["outcomeId"]=="A":row["schedule"][0]["amount"]=q(-1,3)
    original_rule(problem,proposed)
    checked=child("rational-boundary","checker.py",{"problem":problem,"rule":proposed})
    assert checked["accepted"] and checked["minimumParticipationMargin"]==q(),checked
    bad=copy.deepcopy(proposed)
    for row in bad["table"]:
        if row["reports"][0]=="1":row["schedule"][0]["amount"]=q(-100000000000000000,300000000000000003)
    failed=child("rational-boundary-lie","checker.py",{"problem":problem,"rule":bad})
    assert not failed["accepted"] and any(w["constraint"]=="UNILATERAL_DEVIATION" and Fraction(int(w["gain"]["numerator"]),int(w["gain"]["denominator"]))>0 for w in failed["failures"]),failed
    return {"exactPrice":q(1,3),"weakTieNotAcceptance":True,"subFloatLieRejected":True}
case("rational-boundary-nonzero-outside-option-tie",rational_boundary)

extra_mutations=[
 ("net-subsidy",lambda p,r:p["constraints"].__setitem__("netTransferMinimum",q()),True,"NET_TRANSFER_SUBSIDY_OR_BALANCE"),
 ("unit",lambda p,r:r["table"][0]["schedule"][0].__setitem__("unit","utility"),False,"PAYMENT_EVENT_UNIT_CURRENCY_TIME_MISMATCH"),
 ("hard-covenant",lambda p,r:p["covenants"].append({"id":"finite-capacity","sourceRef":p["binding"]["mandateRef"],"unit":"unit","periods":[0,1],"terms":[{"resourceId":"capacity","coefficient":q(1)}],"maximum":q(),"safetyMargin":q()}),True,"HARD_COVENANT"),
 ("mandate-total",lambda p,r:p["mandateLimits"]["dimensions"][1].__setitem__("totalLimit",q()),True,"ORIGINAL_S4_MANDATE_ENVELOPE"),
 ("mandate-coupling",lambda p,r:p["mandateLimits"]["couplings"].append({"id":"original-pool","weights":{"capacity":q(1)},"maximum":q()}),True,"ORIGINAL_S4_MANDATE_COUPLING"),
 ("owner-value-floor",lambda p,r:p["objective"].__setitem__("minimumValue",q(100)),True,"ORIGINAL_OWNER_VALUE_FLOOR"),
 ("encoding-coefficient",lambda p,r:p["parties"][0]["types"][2]["values"].__setitem__("A",q(-2)),True,"UNILATERAL_DEVIATION"),
]
for name,fn,original,expected in extra_mutations:
    case(name,lambda name=name,fn=fn,original=original,expected=expected:mutate(name,fn,original,expected))

def gross_and_early_liquidity():
    problem,proposed=fixture("posted"),posted_rule(fixture("posted"))
    for party in problem["parties"]:
        party["payments"]=[{"dateId":"cash","minimum":q(-2),"maximum":q(2)}]
    for row in proposed["table"]:row["schedule"][1]["amount"]=q(1)
    problem["resources"][0]["availability"]=[q(),q(10)]
    original_rule(problem,proposed)
    checked=child("earlier-outgoing-later-funding","checker.py",{"problem":problem,"rule":proposed})
    assert not checked["accepted"] and any(w["constraint"]=="HARD_RESOURCE" and w["resourceId"]=="cash" and w["period"]==0 for w in checked["failures"]),checked
    problem["dates"][0]["grossOutflowCap"]=q()
    original_rule(problem,proposed)
    funding=child("gross-not-net-funding","checker.py",{"problem":problem,"rule":proposed})
    assert not funding["accepted"] and any(w["constraint"]=="DATED_GROSS_FUNDING_ESCROW" for w in funding["failures"]),funding
    return {"incomingPromiseNotLiquidity":True,"terminalNetDoesNotProveDatedFunding":True}
case("gross-liquidity-earlier-outgoing",gross_and_early_liquidity)

def finite_timeout():
    problem=fixture()
    timed=child("solver-time-budget","producer.py",{"problem":problem,"seconds":0.001})
    assert timed["status"] in ("UNKNOWN","INCOMPLETE"),timed
    if timed["rule"]:
        checked=child("timeout-incumbent","checker.py",{"problem":problem,"rule":timed["rule"]})
        assert checked["accepted"] and checked["optimum"]=="UNKNOWN",checked
    else:
        proof=child("timeout-no-proof","checker.py",{"operation":"contradiction","problem":problem})
        assert proof["status"]=="UNKNOWN",proof
    return {"status":timed["status"],"termination":timed.get("trace",{}).get("solverStatus"),"infeasibilityNotFabricated":True}
case("solver-timeout-not-infeasibility",finite_timeout)

manifest = {"schema": "finnor.r3.native-e2e.v1", "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "baseCommit": "517003a4396bc8101a90be4b425ee01de9446740", "python": platform.python_version(),
            "sources": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(list(NATIVE.glob("*.py")) + list(pathlib.Path(__file__).parent.glob("*.py")))},
            "elapsedMs": (time.monotonic() - started) * 1000, "peakChildRssBytes": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * (1 if sys.platform == "darwin" else 1024),
            "aggregatePeakMemory": None, "money": None, "meterGaps": ["Aggregate simultaneous memory", "USD pricebook", "Preparation human seconds"],
            "rerun": [args.python, str(pathlib.Path(__file__).resolve()), "--python", args.python, "--output", "<new-evidence-directory>"],
            "results": results, "invocations": invocations}
save("manifest", manifest)
raise SystemExit(1 if any(r["status"] != "PASS" for r in results) else 0)
