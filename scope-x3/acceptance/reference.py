"""Independent bounded model, not installed acceptance. Python stdlib only."""
import argparse
import copy
import hashlib
import json
import re
from decimal import Decimal, localcontext
from pathlib import Path

RELEASES = {"r1": {"USD": "100000", "INR": "100000"},
            "r2": {"USD": "50000", "INR": "50000", "EUR": "50000"}}


class Denied(Exception):
    pass


def require(predicate, code):
    if not predicate:
        raise Denied(code)


def total(lines):
    require(isinstance(lines, list) and 1 <= len(lines) <= 128, "INVALID_QUANTITY")
    require(all(isinstance(v, str) and re.fullmatch(r"(0|[1-9][0-9]{0,37})", v)
                for v in lines), "INVALID_QUANTITY")
    with localcontext() as ctx:
        ctx.prec = 80
        value = sum((Decimal(v) for v in lines), Decimal(0))
        require(value < Decimal("1e38"), "QUANTITY_OVERFLOW")
        return value


def replay(case_input, contexts):
    c = copy.deepcopy(contexts[case_input["context"]])
    c.update(copy.deepcopy(case_input.get("set", {})))
    for name, overrides in c.pop("actor_overrides", {}).items():
        c["actors"][name].update(overrides)
    r = c["record"]
    r.update(copy.deepcopy(case_input.get("record", {})))
    state, approvals, history, binding = "DRAFT", {}, [], None
    amount, delta, plans, reads, codes, readbacks = None, None, 0, 0, [], []

    def authorize(name, role=None):
        a = c["actors"].get(name)
        require(a is not None, "IDENTITY_DENIED")
        require(a["tenant"] == c["tenant"], "TENANT_DENIED")
        require(a["scope"] == c["scope"], "SCOPE_DENIED")
        require(a["current"], "AUTHORITY_REVOKED")
        require(role in a["roles"] if role else bool(a["roles"]), "ROLE_DENIED")
        return a

    def evidence():
        if r["source_refs"] != c["source_current"] or "STALE" in c["source_status"]:
            return "STALE"
        if "CONFLICTING" in c["source_status"]:
            return "CONFLICTING"
        return "KNOWN" if c["source_status"] == ["KNOWN", "KNOWN"] else "UNKNOWN"

    def fresh():
        status = evidence()
        require(status == "KNOWN", {"STALE": "SOURCE_STALE",
                "CONFLICTING": "EVIDENCE_CONFLICTING", "UNKNOWN": "EVIDENCE_UNKNOWN"}.get(status))

    def snapshot():
        return {"record_ref": r["record_ref"], "release": r["release"],
                "currency": r["currency"], "state": state, "amount_minor": amount,
                "book_minor": copy.deepcopy(r["book_minor"]), "bank_minor": copy.deepcopy(r["bank_minor"]),
                "approvers": sorted(c["actors"][a]["principal"] for a in approvals.values()),
                "source_refs": copy.deepcopy(r["source_refs"])}

    for e in case_input["events"]:
        try:
            op = e["op"]
            if op == "restart":
                c, r, state, approvals, history, binding, amount, delta, plans, reads = json.loads(
                    json.dumps([c, r, state, approvals, history, binding, amount, delta, plans, reads]))
                codes.append("RESTARTED")
                continue
            if op == "refresh":
                c["source_current"][e["source"]] = e["ref"]
                codes.append("REFRESHED")
                continue
            if op == "activate":
                require(e["release"] in RELEASES, "UNKNOWN_RELEASE")
                c["active_release"] = e["release"]
                codes.append("ACTIVATED")
                continue
            if op == "revoke":
                c["actors"][e["actor"]]["current"] = False
                codes.append("REVOKED")
                continue
            require(op != "execute", "EXECUTION_OUT_OF_SCOPE")
            require(op in {"read", "edit", "reconcile", "approve", "prepare"}, "UNKNOWN_COMMAND")
            actor = authorize(e.get("as"), "analyst" if op in {"edit", "reconcile", "prepare"} else None)
            require(e.get("ref", r["record_ref"]) == r["record_ref"], "RECORD_REF_MISMATCH")
            require(not e.get("race"), "COMMIT_CONFLICT")
            if op == "read":
                reads += 1
                readbacks.append(snapshot())
                codes.append("READ")
                continue
            if op == "edit":
                require(set(e["record"]) <= {"release", "currency", "book_currency",
                        "bank_currency", "book_minor", "bank_minor"}, "INVALID_EDIT")
                history.append(snapshot())
                prefix, revision = r["record_ref"].rsplit("/", 1)
                r = copy.deepcopy(r)
                r.update(e["record"])
                r.update(record_ref=f"{prefix}/{int(revision) + 1}", author=actor["principal"],
                         source_refs=copy.deepcopy(c["source_current"]))
                state, approvals, binding, amount, delta, plans = "DRAFT", {}, None, None, None, 0
                codes.append("EDITED")
                continue
            allowed = {"reconcile": {"DRAFT"}, "approve": {"RECONCILED", "APPROVED"},
                       "prepare": {"APPROVED", "PREPARED"}}
            require(state in allowed[op], "INVALID_STATE")
            require(r["release"] == c["active_release"], "RELEASE_CHANGED")
            fresh()
            if op == "reconcile":
                policy = RELEASES.get(r["release"], {})
                require(r["currency"] in policy, "UNSUPPORTED_CURRENCY")
                require(r["currency"] == r["book_currency"] == r["bank_currency"], "CURRENCY_MISMATCH")
                book, bank = total(r["book_minor"]), total(r["bank_minor"])
                with localcontext() as ctx:
                    ctx.prec = 80
                    amount, delta = format(book, "f"), format(book - bank, "f")
                require(book == bank, "AMOUNT_MISMATCH")
                binding = {"tenant": c["tenant"], "scope": c["scope"],
                           "record_ref": r["record_ref"], "release": r["release"],
                           "currency": r["currency"], "amount_minor": amount,
                           "source_refs": copy.deepcopy(r["source_refs"])}
                state = "RECONCILED"
            elif op == "approve":
                require(actor["principal"] != r["author"], "SELF_APPROVAL_DENIED")
                role = next((x for x in ("partner", "compliance") if x in actor["roles"]), None)
                require(role is not None, "ROLE_DENIED")
                require(all(other == role or c["actors"][name]["principal"] != actor["principal"]
                            for other, name in approvals.items()), "PRINCIPAL_SEPARATION_DENIED")
                approvals[role] = e["as"]
                required = {"partner"}
                if Decimal(amount) >= Decimal(RELEASES[r["release"]][r["currency"]]):
                    required.add("compliance")
                state = "APPROVED" if required <= set(approvals) else "RECONCILED"
            elif op == "prepare":
                for role, name in approvals.items():
                    try:
                        authorize(name, role)
                    except Denied:
                        raise Denied("APPROVER_AUTHORITY_REVOKED") from None
                state, plans = "PREPARED", 1
            codes.append("APPROVAL_RECORDED" if op == "approve" and state != "APPROVED" else state)
        except Denied as error:
            codes.append(str(error))
    return dict(snapshot(), codes=codes, delta_minor=delta, evidence=evidence(),
                currentness="STALE" if evidence() == "STALE" else "CURRENT",
                prepared_count=plans, executed_count=0, read_count=reads,
                binding=binding, history=history, readbacks=readbacks)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=Path(__file__).with_name("cases.json"))
    args = parser.parse_args()
    raw = args.cases.read_bytes()
    data = json.loads(raw)
    ids = [c["id"] for c in data["cases"]]
    require(bool(ids) and len(ids) == len(set(ids)), "EMPTY_OR_DUPLICATE_CASE_CENSUS")
    failures = []
    for case in data["cases"]:
        require(set(case) == {"id", "input", "expected"} and bool(case["expected"].get("codes")),
                "INVALID_CASE_CONTRACT")
        observed = replay(case["input"], data["contexts"])
        mismatch = {k: {"expected": v, "model_observed": observed.get(k)}
                    for k, v in case["expected"].items() if observed.get(k) != v}
        if mismatch:
            failures.append({"id": case["id"], "mismatch": mismatch})
    print(json.dumps({"status": "MODEL_ONLY_CONSISTENT" if not failures else "MODEL_INCONSISTENT",
                      "installed_acceptance": "NOT_RUN", "cases_sha256": hashlib.sha256(raw).hexdigest(),
                      "reference_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                      "command": f"python3 {Path(__file__).resolve()} --cases {args.cases.resolve()}",
                      "selected_case_ids": ids, "failures": failures}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
