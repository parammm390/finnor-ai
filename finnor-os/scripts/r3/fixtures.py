"""Registered synthetic declared preferences, never field/business truth."""
import hashlib
import itertools
import json
import pathlib
from fractions import Fraction

ROOT = pathlib.Path(__file__).resolve().parents[3]
NATIVE = ROOT / "finnor-os/packages/epistemic-runtime/src/incentive-rule-synthesis"


def q(n=0, d=1):
    value = Fraction(n, d)
    return {"numerator": str(value.numerator), "denominator": str(value.denominator)}


def ref(owner, label):
    return {"owner": owner, "id": label, "version": "r3-synthetic-source-v1",
            "contentDigest": hashlib.sha256(label.encode()).hexdigest()}


def fixture(mode="interacting"):
    small = mode == "small"
    n, k = (2, 2) if small else (4, 3)
    start = "2026-10-10T00:00:00.000Z"
    contract = ref("BUSINESS_OWNER", "synthetic-unconditional-payment-contract")
    binding = {"tenantId": "00000000-0000-4000-8000-000000000001", "principalId": "00000000-0000-4000-8000-000000000002",
               "workId": "00000000-0000-4000-8000-000000000003", "workRevision": "00000000-0000-4000-8000-000000000004",
               "workDigest": "a" * 64, "root": {"entityType": "external_organization", "entityId": "00000000-0000-4000-8000-000000000005"},
               "preferenceRef": ref("S3", "synthetic-finite-declaration"), "mandateRef": ref("S4", "synthetic-unchanged-mandate"),
               "domainRef": ref("S3", "synthetic-quasilinear-domain"), "paymentContractRef": contract, "rightsRef": "synthetic-rights-only",
               "backendDigest": "b" * 64, "checkerDigest": hashlib.sha256((NATIVE / "checker.py").read_bytes()).hexdigest(),
               "producerDigest": hashlib.sha256((NATIVE / "producer.py").read_bytes()).hexdigest(),
               "schemaDigest": "c" * 64, "sourceManifestDigest": "d" * 64}
    domain = [str(t) for t in range(k)]
    reports = list(itertools.product(domain, repeat=n))
    outcomes = ["wait", "A"] if small else ["wait", "A", "B"]
    parties = []
    for i in range(n):
        types = []
        other = list(itertools.product(domain, repeat=n - 1))
        for t in range(k):
            values = {o: q() for o in outcomes}
            if mode in ("posted", "small"):
                if i == 0:
                    values["A"] = q(t)
            elif i in (0, 1):
                values["A" if i == 0 else "B"] = q(2 * t)
            else:
                values["A" if i == 2 else "B"] = q(-t)
            types.append({"id": str(t), "values": values, "dateMultipliers": {"cash": q(1)},
                          "outsideOptions": [{"otherReports": list(r), "utility": q()} for r in other]})
        low, high = (-2, 2) if mode == "interacting" else ((-1, 0) if i == 0 else (0, 0))
        parties.append({"id": "party-%d" % i, "entityType": "external_organization",
                        "entityId": "00000000-0000-4000-8000-%012d" % (10 + i),
                        "reportingPrincipalId": "00000000-0000-4000-8000-%012d" % (20 + i),
                        "rightsRef": "synthetic-party-rights-%d" % i,
                        "sourceRef": ref("S1", "synthetic-party-source-%d" % i),
                        "assumptionRef": ref("S3", "synthetic-party-assumption-%d" % i),
                        "types": types, "payments": [{"dateId": "cash", "minimum": q(low), "maximum": q(high)}],
                        "liabilityCap": q(2)})
    horizon = {"startAt": start, "periodMs": 86400000, "periods": 1}
    resources = [{"ref": ref("S5", "synthetic-" + name), "resourceId": name, "unit": unit, "kind": "STOCK",
                  "horizon": horizon, "availability": [q(cap), q(cap)], "baseline": [q(), q()],
                  "minimumBaseline": [q(), q()], "safetyMargin": q()}
                 for name, unit, cap in [("cash", "USD", 10), ("capacity", "unit", 1)]]
    outcome_rows = []
    for o in outcomes:
        eligibility = "ALL_REPORTS"
        if mode == "interacting" and o != "wait":
            buyer, supplier = (0, 2) if o == "A" else (1, 3)
            eligibility = [list(r) for r in reports if int(r[buyer]) >= 1 and int(r[supplier]) <= 1]
        outcome_rows.append({"id": o, "meaningRef": ref("BUSINESS_OWNER", "synthetic-outcome-" + o),
                             "eligibility": eligibility,
                             "demands": {"cash": [q(), q()], "capacity": [q(int(o != "wait")), q()]},
                             "costs": [q(), q()], "liabilities": [q(), q()]})
    owner_values = {}
    for r in reports:
        if mode == "interacting":
            active = (int(r[0]) >= 1 and int(r[2]) <= 1) or (int(r[1]) >= 1 and int(r[3]) <= 1)
            values = {"wait": q(0 if active else 10), "A": q(10), "B": q(10)}
        else:
            values = {o: q((int(r[0]) + 1) if o == "A" else 0) for o in outcomes}
        owner_values[json.dumps(list(r), separators=(",", ":"))] = values
    p = {"schema": "finnor.r3.problem.v1", "binding": binding,
         "model": {"utility": "SUPPLIED_QUASILINEAR", "participation": "EX_POST_ALL_OTHER_REPORTS",
                   "events": "UNCONDITIONAL_DUE_TIME", "guarantee": "INDIVIDUAL_WEAK_DSIC"},
         "money": {"currency": "USD", "unit": "USD", "valuationDate": start, "ownerId": binding["principalId"],
                   "timeConvention": "EXACT_SUPPLIED_PERIOD_EDGES", "discountConvention": "SUPPLIED_UNIT_MULTIPLIERS_NOT_MARKET_RATE",
                   "ownerDateMultipliers": {"cash": q(1)}, "ownerPeriodMultipliers":[q(1),q(1)]},
         "parties": parties,
         "dates": [{"id": "cash", "at": start, "period": 0, "trigger": "DUE_TIME", "observableBy": "OWNER_CLOCK",
                    "contractRef": contract, "defaultCondition": "RETAIN_OUTSTANDING_LIABILITY",
                    "grossOutflowCap": q(4), "escrowCap": q(4)}],
         "outcomes": outcome_rows, "resources": resources, "covenants": [],
         "constraints": {"cashResourceId": "cash", "netTransferMinimum": q(-4), "netTransferMaximum": q(4),
                         "incomingPromisesMayFund": False, "ownerLiabilityCap": q(8)},
         "mandateLimits": {"dimensions": [{"resourceId": "cash", "unit": "USD", "totalLimit": q(10), "capacity": q(10)},
                                           {"resourceId": "capacity", "unit": "unit", "totalLimit": q(1), "capacity": q(1)}], "couplings": []},
         "objective": {"kind": "MAXIMIN", "valueByProfile": owner_values, "weights": None, "distributionRef": None,
                       "range": [q(-20), q(20)], "normalization": q(40),
                       "minimumValue": q(-20),
                       "tieConvention": "NO_STRICT_TRUTH_OR_CONSENT_FROM_TIES"},
         "assumptions": ["SYNTHETIC_REGISTERED_DIAGNOSTIC_NOT_PRD_PRIVATE_PREFERENCES",
                         "Each supplied quasilinear type/outside option is a hypothesis, not observed truth.",
                         "Four-party general-sum, individual weak DSIC only; no consent or collusion guarantee."]}
    if small:
        p["referenceGrid"] = [q(-1), q()]
        for a in p["parties"]:
            a["payments"][0].update(minimum=q(-1), maximum=q())
    return p


def posted_rule(p):
    table = []
    for reports in itertools.product(*[[t["id"] for t in a["types"]] for a in p["parties"]]):
        trade = int(reports[0]) >= 1
        table.append({"reports": list(reports), "outcomeId": "A" if trade else "wait",
                      "schedule": [{"partyId": a["id"], "dateId": "cash", "amount": q(-1 if trade and i == 0 else 0),
                                    "eventId": "due:cash", "currency": "USD", "unit": "USD", "dueAt": p["dates"][0]["at"]}
                                   for i, a in enumerate(p["parties"])]})
    raw = json.dumps(p, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return {"schema": "finnor.r3.rule.v1", "inputDigest": hashlib.sha256(raw).hexdigest(), "binding": p["binding"], "table": table,
            "search": {"status": "registered-diagnostic", "numericalSemantics": "SCIP_FLOAT64_PROPOSAL", "optimum": "UNKNOWN",
                       "claimedObjective": q(), "claimedUpper": None, "proof": None, "trace": {"basis": "POSTED_PRICE_DIAGNOSTIC_ONLY"}}}
