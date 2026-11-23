"""Pre-code public fixture registration. Refuses to overwrite a frozen sweep."""
import copy
import hashlib
import json
from pathlib import Path
import secrets
import sys

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / "scope-z/phase-evidence/z5/frozen"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def ref(cell):
    return {"cell": cell}


def loc(component):
    return {"local": component}


def lit(value):
    return {"const": value}


def op(name, *args):
    return {"op": name, "args": list(args)}


def eq(cell, value):
    return op("eq", ref(cell), lit(value))


TRUE = lit(True)


def cell(name, values, kind="state", public=True, immutable=False):
    return {"id": name, "identity": "original:" + name, "values": values,
            "kind": kind, "public": public, "immutable": immutable}


def transition(name, start, end, guard=TRUE, writes=None, port="tau", direction="internal", modality="may"):
    return {"id": name, "from": start, "to": end, "guard": guard,
            "writes": writes or {}, "port": port, "direction": direction, "modality": modality}


def component(name, transitions, states=None, revision="r1", assumption=TRUE):
    if states is None:
        names = sorted({v for t in transitions for v in (t["from"], t["to"])})
        states = [{"id": n, "terminal": n == "done", "quiescent": False} for n in names]
    return {"id": name, "revision": revision, "states": states,
            "transitions": transitions, "assumption": assumption,
            "correspondence": {"kind": "BOUNDED_TYPED_KERNEL_V1", "scope": "EXACT_LISTED_KERNEL_ONLY",
                               "admission": "PUBLIC_OFFLINE_FIXED_FIXTURE", "implementationDigest": digest(transitions)},
            "bridges": []}


def model(components, cells=None, values=None, safety=None, initials=None):
    cells = cells or [cell("world", ["w0", "w1"], "world", immutable=True)]
    values = values or {c["id"]: c["values"][0] for c in cells}
    locals_ = {c["id"]: c["states"][0]["id"] for c in components}
    initials = initials or [{"locals": locals_, "cells": values}]
    labels = sorted({t["port"] for c in components for t in c["transitions"]} | {"tau"})
    return {"schema": "finnor.z5.composition-input.v1", "claim": "SOUND_SUBSET",
            "domain": "PUBLIC_OFFLINE_FIXED_KERNELS", "components": components, "cells": cells,
            "ports": [{"label": p, "environment": False, "public": True} for p in labels],
            "initial": initials, "safety": safety or [TRUE], "observe": [c["id"] for c in cells if c["public"]],
            "excludedEnvironmentActions": [], "replacementCandidates": [], "live": copy.deepcopy(initials[0]),
            "limits": {"maxProductStates": 16384, "maxContextStates": 4096,
                       "maxTransitions": 131072, "maxOperations": 2000000, "wallMs": 20000,
                       "maxRelationPairs": 65536, "maxTranslationRows": 131072}}


def environment(m, label):
    next(p for p in m["ports"] if p["label"] == label)["environment"] = True


def chain(width=3, fork=False):
    cells = [cell("stage" + str(i), ["0", "1"]) for i in range(width)]
    cs = []
    for i in range(width):
        guards = [eq("stage" + str(i), "0")]
        if i:
            guards.append(eq("stage" + str(i - 1), "1"))
        if fork and i == width - 1:
            guards.extend(eq("stage" + str(j), "1") for j in range(width - 1))
        cs.append(component("C" + str(i), [transition("advance", "start", "done", op("and", *guards),
                                                    {"stage" + str(i): lit("1")})],
                            [{"id": "start", "terminal": False, "quiescent": False},
                             {"id": "done", "terminal": True, "quiescent": False}]))
    return model(cs, cells)


def pipeline(callback=False, replacement=False):
    cells = [cell("terms", ["v1", "v2"], "source"), cell("proposal", ["v1", "v2"]),
             cell("occupation", ["0", "1", "2"], "resource"),
             cell("pending", ["0", "1"], "obligation"),
             cell("reservation", ["original-reservation"], "reservation", immutable=True),
             cell("grant", ["original-grant"], "authorization", immutable=True)]
    s4 = component("S4", [
        transition("propose", "start", "done", writes={"proposal": ref("terms")}),
        transition("refresh", "done", "done", op("and", eq("pending", "0"), op("ne", ref("proposal"), ref("terms"))),
                   {"proposal": ref("terms")})],
        [{"id": "start", "terminal": False, "quiescent": False}, {"id": "done", "terminal": True, "quiescent": False}])
    s5 = component("S5", [transition("reserve", "start", "held",
                                   op("and", op("eq", loc("S4"), lit("done")), eq("occupation", "0")),
                                   {"occupation": lit("1")})],
                   [{"id": "start", "terminal": False, "quiescent": False}, {"id": "held", "terminal": True, "quiescent": False}])
    ts = [transition("dispatch", "ready", "waiting", op("eq", loc("S5"), lit("held")),
                     {"pending": lit("1")}, modality="must"),
          transition("callback", "waiting", "done", TRUE, {"pending": lit("0")}, "callback", "input")]
    s6 = component("S6", ts, [{"id": "ready", "terminal": False, "quiescent": False},
                            {"id": "waiting", "terminal": False, "quiescent": callback},
                            {"id": "done", "terminal": True, "quiescent": False}], revision="s6-original")
    terms = component("Terms", [transition("change", "open", "closed", eq("pending", "0"),
                                          {"terms": lit("v2")}, "terms-change", "input")],
                      [{"id": "open", "terminal": True, "quiescent": False},
                       {"id": "closed", "terminal": True, "quiescent": False}])
    m = model([s4, s5, s6, terms], cells,
              {"terms": "v1", "proposal": "v1", "occupation": "0", "pending": "0",
               "reservation": "original-reservation", "grant": "original-grant"},
              [op("implies", eq("pending", "1"), op("eq", ref("terms"), ref("proposal"))),
               op("lte", ref("occupation"), lit("1"))])
    environment(m, "callback")
    environment(m, "terms-change")
    if replacement:
        revised = copy.deepcopy(s6)
        revised["revision"] = "s6-existing-fenced"
        revised["transitions"][0]["guard"] = op("and", revised["transitions"][0]["guard"],
                                               op("eq", ref("terms"), ref("proposal")))
        revised["correspondence"]["implementationDigest"] = digest(revised["transitions"])
        revised["bridges"] = [{"fromRevision": "s6-original", "fromState": x, "toState": x}
                              for x in ["ready", "waiting", "done"]]
        m["replacementCandidates"] = [revised]
        if callback:
            m["live"] = {"locals": {"S4": "done", "S5": "held", "S6": "waiting", "Terms": "open"},
                         "cells": {**m["initial"][0]["cells"], "occupation": "1", "pending": "1"}}
    return m


def locks(hierarchy):
    cells = [cell("left", ["free", "A", "B"], "lock"), cell("right", ["free", "A", "B"], "lock")]
    cs = []
    for name, first, second in [("A", "left", "right"), ("B", "left" if hierarchy else "right", "right" if hierarchy else "left")]:
        cs.append(component(name, [
            transition("first", "start", "held", eq(first, "free"), {first: lit(name)}),
            transition("second", "held", "both", eq(second, "free"), {second: lit(name)}),
            transition("release", "both", "done", TRUE, {first: lit("free"), second: lit("free")})],
            [{"id": x, "terminal": x == "done", "quiescent": False} for x in ["start", "held", "both", "done"]]))
    return model(cs, cells)


def port_pair(broken=False, may=False):
    a = component("Sender", [transition("send", "start", "done", port="message", direction="output",
                                       modality="may" if may else "must")],
                  [{"id": "start", "terminal": False, "quiescent": False},
                   {"id": "done", "terminal": True, "quiescent": False}])
    b = component("Receiver", [transition("receive", "start" if not broken else "other", "done",
                                         port="message", direction="input")],
                  [{"id": "start", "terminal": False, "quiescent": False},
                   {"id": "other", "terminal": False, "quiescent": False},
                   {"id": "done", "terminal": True, "quiescent": False}])
    return model([a, b])


def family(f, j):
    bad = j >= 6
    expected = "CHECKED_CANDIDATE"
    reason = "All original uncontrollable transitions preserve the invariant; completion has a finite path."
    bridge = None
    if f in [1, 2, 15, 16, 30, 31, 32]:
        m = pipeline(callback=f in [16, 30, 31, 32], replacement=f in [30, 31, 32])
        if f in [30, 31, 32]:
            bridge = "BRIDGED"
        if f == 15:
            m["cells"].append(cell("calendar", ["open", "expired"], "calendar", immutable=True))
            for state in m["initial"] + [m["live"]]:
                state["cells"]["calendar"] = "open"
            m["observe"].append("calendar")
            m["components"][2]["transitions"][0]["guard"] = op("and", m["components"][2]["transitions"][0]["guard"], eq("calendar", "open"))
        if bad and f in [30, 31, 32]:
            m["replacementCandidates"][0]["bridges"] = []
            bridge = "RETAIN_OLD"
            reason = "No supplied bridge is authorized; the checked old component and liabilities remain."
        elif bad:
            m["initial"][0]["cells"]["pending"] = "1"
            m["initial"][0]["cells"]["proposal"] = "v2"
            m["live"] = copy.deepcopy(m["initial"][0])
            expected = "CHECKED_INFEASIBLE"
            reason = "An actual original initial tuple already violates safety; no assumptions can erase it."
    elif f in [5, 6, 7, 8]:
        m = chain(4 + j % 3, fork=f in [5, 6])
        if f == 6:
            m["cells"].append(cell("reservation", ["one-original-reservation"], "reservation", immutable=True))
        elif f == 7:
            m["cells"].append(cell("capital", ["0", "1"], "resource"))
            for c in m["components"]:
                c["transitions"][0]["guard"] = op("and", c["transitions"][0]["guard"], eq("capital", "0"))
                c["transitions"][0]["writes"]["capital"] = lit("0")
        elif f == 8:
            m["cells"].append(cell("source", ["rev1", "rev2"], "source", immutable=True))
        if f != 5:
            extra = m["cells"][-1]
            m["initial"][0]["cells"][extra["id"]] = extra["values"][0]
            m["live"] = copy.deepcopy(m["initial"][0])
            m["observe"].append(extra["id"])
        if bad:
            m["safety"] = [op("ne", ref("stage0"), lit("1"))]
            expected, reason = "CHECKED_INFEASIBLE", "A mandatory original internal path violates the stated property."
    elif f == 3:
        cs = [component(n, [transition("occupy", "start", "done", eq("exposure", "0"),
                                        {"exposure": lit("2" if bad else "1")})],
                        [{"id": "start", "terminal": False, "quiescent": True},
                         {"id": "done", "terminal": True, "quiescent": False}]) for n in ["A", "B"]]
        m = model(cs, [cell("exposure", ["0", "1", "2"], "resource")], safety=[op("lte", ref("exposure"), lit("1"))])
        if bad:
            expected, reason = "CHECKED_INFEASIBLE", "One shared exposure cell cannot be replaced with two independent allowances."
    elif f == 4:
        m = chain(3 + j % 4)
        m["components"][0]["transitions"][0]["guard"] = eq("stage" + str(len(m["components"]) - 1), "1")
        if not bad:
            m["initial"][0]["cells"]["stage" + str(len(m["components"]) - 1)] = "1"
            m["initial"][0]["locals"]["C" + str(len(m["components"]) - 1)] = "done"
            m["live"] = copy.deepcopy(m["initial"][0])
        else:
            expected, reason = "CHECKED_INFEASIBLE", "The original empty circular wait has no completion-enabling transition."
    elif f in [9, 10]:
        m = locks(f == 10)
        if f == 9 or bad:
            if f == 10:
                m = locks(False)
            expected, reason = "CHECKED_INFEASIBLE", "An original interleaving reaches the opposite-order lock deadlock."
    elif f in [11, 12]:
        m = chain(2 + j % 3)
        count = 1 if f == 11 else 2
        for k in range(count):
            c = cell("world" + str(k), ["w0", "w1"], "world", immutable=True)
            m["cells"].append(c)
            m["initial"][0]["cells"][c["id"]] = "w" + str(j % 2)
            m["observe"].append(c["id"])
        if f == 12:
            m["safety"] = [op("eq", ref("world0"), ref("world1"))]
        if bad:
            if f == 11:
                other = copy.deepcopy(m["cells"][-1])
                other["id"] = "aliasedWorld"
                m["cells"].append(other)
                m["initial"][0]["cells"]["aliasedWorld"] = "w0"
                expected, reason = "UNSUPPORTED", "Two distinct cells alias the same original world identity."
            else:
                m["initial"][0]["cells"]["world1"] = "w" + str(1 - j % 2)
                expected, reason = "CHECKED_INFEASIBLE", "Explicit joint-world coupling fails at an original initial tuple."
        m["live"] = copy.deepcopy(m["initial"][0])
    elif f in [13, 14]:
        m = chain(2)
        m["cells"].append(cell("private", ["p0", "p1"], "private", public=False, immutable=True))
        m["initial"][0]["cells"]["private"] = "p0"
        second = copy.deepcopy(m["initial"][0])
        second["cells"]["private"] = "p1"
        m["initial"].append(second)
        m["live"] = copy.deepcopy(m["initial"][0])
        if f == 14 or not bad:
            m["components"][0]["transitions"][0]["writes"]["stage0"] = lit("1")
        else:
            t = m["components"][0]["transitions"][0]
            t.update({"port": "private-choice", "direction": "input", "guard": eq("private", "p0")})
            m["ports"].append({"label": "private-choice", "environment": True, "public": False})
            expected, reason = "UNSUPPORTED", "A context cannot receive an undisclosed private environmental port."
    elif f in [17, 18, 22]:
        m = port_pair(broken=bad and f != 22, may=f == 18)
        if bad:
            if f == 22:
                m["components"][1]["transitions"][0]["port"] = "renamed-without-contract"
                expected, reason = "UNSUPPORTED", "A changed original port has no declared interface revision."
            else:
                expected, reason = "CHECKED_INFEASIBLE", "An original possible output has no matching current input."
    elif f in [19, 20]:
        cells = [cell("x", ["0", "1"]), cell("y", ["0", "1"])]
        ts = [transition("atomic", "start", "done", writes={"x": lit("1"), "y": lit("1")})] if f == 19 else [
            transition("first", "start", "half", writes={"x": lit("1")}),
            transition("second", "half", "done", writes={"y": lit("1")})]
        a = component("Update", ts, [{"id": x, "terminal": x == "done", "quiescent": False}
                                    for x in (["start", "done"] if f == 19 else ["start", "half", "done"])])
        b = component("Observe", [transition("read", "start", "done")],
                      [{"id": "start", "terminal": False, "quiescent": False}, {"id": "done", "terminal": True, "quiescent": False}])
        prop = op("eq", ref("x"), ref("y"))
        m = model([a, b], cells, safety=[prop if f == 19 or bad else op("implies", op("eq", loc("Update"), lit("done")), prop)])
        if bad and f == 19:
            m["safety"] = [eq("x", "0")]
        if bad:
            expected, reason = "CHECKED_INFEASIBLE", "The exact original atomic/intermediate transition violates the selected invariant."
    elif f == 21:
        m = port_pair(broken=bad)
        if j % 2:
            m = chain(3)
            m["cells"][1]["kind"] = "buffer"
            if bad:
                m["safety"] = [eq("stage1", "0")]
        if bad:
            expected, reason = "CHECKED_INFEASIBLE", "The original rendezvous refusal or explicit buffer transition is unsafe."
    elif f in [23, 24, 25]:
        m = chain(2)
        t = m["components"][0]["transitions"][0]
        t.update({"port": "completion-input", "direction": "input"})
        m["ports"].append({"label": "completion-input", "environment": True, "public": True})
        if f == 24:
            extra = copy.deepcopy(t)
            extra["id"], extra["port"] = "other-input", "other-input"
            m["components"][0]["transitions"].append(extra)
            m["ports"].append({"label": "other-input", "environment": True, "public": True})
            m["excludedEnvironmentActions"] = ["other-input"]
            reason = "A nonempty declared sound subset may exclude a separately represented compatible environment."
        if bad:
            if f == 25:
                m["claim"] = "MAXIMALLY_PERMISSIVE"
                expected, reason = "UNSUPPORTED", "Soundness alone cannot establish a weakest/maximal context."
            else:
                m["excludedEnvironmentActions"] = ["completion-input"] + (["other-input"] if f == 24 else [])
                expected, reason = "CHECKED_INFEASIBLE", "No remaining admitted context can offer completion."
    elif f == 26:
        m = port_pair()
        for c in m["components"]:
            c["assumption"] = op("eq", loc("Sender"), loc("Receiver"))
        if bad:
            for c in m["components"]:
                c["assumption"] = op("eq", loc("Sender"), lit("done"))
            expected, reason = "CHECKED_INFEASIBLE", "Mutual assumptions false initially cannot discharge one another."
    elif f == 27:
        m = chain(2)
        second = copy.deepcopy(m["initial"][0])
        second["cells"]["stage0"] = "1"
        second["locals"]["C0"] = "done"
        m["initial"].append(second)
        if bad:
            m["safety"] = [eq("stage0", "0")]
            expected, reason = "CHECKED_INFEASIBLE", "All original initial tuples must be covered, not just a favorable tuple."
    elif f == 28:
        m = chain(2 + j % 5)
        if bad:
            m["limits"]["maxOperations"] = 1
            expected, reason = "INCOMPLETE", "Exhausting the original bound is not an infeasibility proof."
    elif f == 29:
        m = chain(2)
        m["components"][0]["correspondence"]["kind"] = "ARBITRARY_TYPESCRIPT_HASH"
        expected, reason = "UNSUPPORTED", "Adjacent qualified kernels do not qualify broad source correspondence."
    else:
        raise AssertionError(f)
    return m, {"disposition": expected, "replacement": bridge, "reason": reason,
               "usefulSupportedPositive": expected == "CHECKED_CANDIDATE"}


def main():
    if OUT.exists():
        raise SystemExit("FROZEN_REGISTRATION_EXISTS")
    public = json.loads((ROOT / "scope-z/prompts/qualification-families.json").read_text())["phases"]["Z5"]
    OUT.mkdir(parents=True, mode=0o700)
    seed = secrets.token_hex(32)
    entries = []
    for f, title in enumerate(public["families"], 1):
        for j in range(8):
            m, expected = family(f, j)
            for c in m["components"] + m["replacementCandidates"]:
                c["correspondence"]["implementationDigest"] = digest(c["transitions"])
            nonce = digest([seed, f, j])
            case = {"schema": "finnor.z5.public-frozen-case.v1", "id": f"F{f:02d}-{j+1:02d}",
                    "family": title, "freshNonce": nonce, "input": m, "expected": expected,
                    "oracle": "PRE_CODE_FINITE_OPERATIONAL_ARGUMENT_NOT_PROTECTED_CUSTODY"}
            name = case["id"] + ".json"
            data = (json.dumps(case, sort_keys=True, separators=(",", ":")) + "\n").encode()
            (OUT / name).write_bytes(data)
            entries.append({"id": case["id"], "path": name, "sha256": hashlib.sha256(data).hexdigest(),
                            "expected": expected["disposition"], "usefulSupportedPositive": expected["usefulSupportedPositive"]})
    registration = {"schema": "finnor.z5.pre-code-registration.v1", "seed": seed,
                    "productCodeWritten": False, "families": 32, "casesPerFamily": 8,
                    "oracleIndependence": "BUILDER_PUBLIC_RECOMPUTATION_NOT_PROTECTED",
                    "usefulPositiveDenominator": sum(e["usefulSupportedPositive"] for e in entries),
                    "threshold": ">=95% useful supported positives; all critical falsifiers rejected",
                    "stopRule": "One complete frozen sweep, retained failures and diagnosed affected reruns only",
                    "entries": entries}
    (OUT / "registration.json").write_text(json.dumps(registration, indent=2) + "\n")
    print(json.dumps({"registration": str(OUT / "registration.json"), "cases": len(entries),
                      "positiveDenominator": registration["usefulPositiveDenominator"],
                      "digest": digest(registration)}))


if __name__ == "__main__":
    main()
