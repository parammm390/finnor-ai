#!/usr/bin/env python3
"""Independent negative obligation checker; NEVER a positive financial proof.

The frozen native periodic-IRR endpoint computes 10^-108 at flow index 9,
below native minE=-100. Every nonnegative numerator divided by the resulting
zero is nonfinite. A one-sign-change standard-LBO solve therefore cannot pass
its finite lower-endpoint test. Earlier failures cannot restore totality.

Reuse only the existing independent stdlib/Fraction checker's canonical,
calendar, snapshot and complete-domain machinery. No native/producer/Decimal
library or expected numeric answers are imported. Both checker byte sets and
the audited native/dependency source cut are enrolled explicitly.
"""
import argparse
import hashlib
import heapq
import importlib.util
import json
import os
from pathlib import Path
import platform
import resource
import sys
import time

MAX_BYTES = 8 * 1024 * 1024
COMMON_DIGEST = "58ab3b567e7487c9a150feeaacd4c8b4db70bc0a81736bc26c3970d9ab3043a9"
DECIMAL_MODULE_DIGEST = "45e6ecc0a500fee6439acdf67ee2e9322aab57e6ea0409ef52993dedbba8cf19"
LOCK_DIGEST = "aebbbac3741b6cf7f2424447bf2bc12524eab526e041b6baada5d167003855c5"
NATIVE_DIGESTS = {
    "package.json": "0223d6311820055125a0ea7ead89ce8231b4529e041f3b9aac7961a48027cab1",
    "src/canonical.ts": "0e96266034a7f05a570b569f5d5c239e23da2c138232dc2b30d8058f876b99b0",
    "src/compiler.ts": "3264e28a68402a99efebc7f7edf55b3990f3137bbc244b6ba71aaf220170d2a9",
    "src/decimal.ts": "301604f5f53b92b1908db00e12d600716bc8f3ab1e5233fb7516e8630282b572",
    "src/errors.ts": "0c5e26fdc4ecb969a47685f9a2d123a2358a5b5873e889e21a540d2a100f3fa2",
    "src/executor.ts": "0146a271061fc0881716bcb8cc7cb3856400e53b54dd59ef44a5a036efa791fe",
    "src/index.ts": "5f455c208b795f3e23f0e99c308c9ea39ae43360b0f4cfb9e2717c4d2e0704bb",
    "src/periods.ts": "987ec7b6ad5cb466932fc7530b3e78ef3438dad1b59bdee46f11a25c135c91d3",
    "src/result.ts": "0eaffc27a917987a900bed05b1be1e1726cf45d8b8b8d95c1521e2bfb98dbd17",
    "src/snapshot.ts": "721a4e0ba82cbab9480e28601f8397ec97192a20d7cc39004ef8e9ccc1885cf6",
    "src/standard-lbo.ts": "702f47aa8640923a4f25637a9df1ac59dbaf4c6ecef7d6e607677b8d11a32cd9",
    "src/returns.ts": "9e82a4316ccddfaa360fc80996f572d5ad26d6401d21611c97777f72938e89de",
    "src/types.ts": "3f348ee5defc8d629e599cce917b21acde194bde46ead15e5e265d7251494f3f",
}
OUTPUT_SOURCES = [
    "returns.gross_sponsor_moic", "returns.gross_sponsor_irr", "returns.gross_sponsor_xirr",
    "transaction.entry_enterprise_value", "transaction.purchase_equity_value",
    "sources_uses.total_uses", "sources_uses.debt_sources", "sources_uses.sponsor_equity", "sources_uses.total_sources",
    "forecast.revenue", "forecast.ebitda", "forecast.ebit", "forecast.cash_taxes", "forecast.capex",
    "forecast.nwc", "forecast.change_in_nwc", "forecast.unlevered_fcf", "forecast.levered_fcf",
    "debt.total.opening_principal", "debt.total.cash_interest", "debt.total.pik_interest", "debt.total.draw",
    "debt.total.mandatory_amortization", "debt.total.cash_sweep", "debt.total.ending_principal", "cash.ending",
    "exit.metric_value", "exit.enterprise_value", "exit.debt", "exit.cash", "exit.net_debt", "exit.equity_value",
    "returns.sponsor_exit_proceeds",
]
CHECK_CODES = {
    "sources_uses": "SOURCES_USES_IMBALANCE", "ownership": "OWNERSHIP_MISMATCH",
    "debt_roll_forward": "DEBT_ROLL_FORWARD_MISMATCH", "minimum_cash": "LIQUIDITY_SHORTFALL",
    "revolver_capacity": "REVOLVER_EXHAUSTED", "cash_sweep": "CASH_SWEEP_EXCEEDED",
    "debt_maturity": "MODEL_UNSUPPORTED_MATURITY", "solver_convergence": "NON_CONVERGENT",
    "exit_bridge": "EXIT_BRIDGE_MISMATCH", "sponsor_cash_flows": "SPONSOR_CASH_FLOW_INVALID",
}
DEBT_FIELDS = ("opening_principal", "effective_rate", "cash_interest", "pik_interest",
               "draw", "mandatory_amortization", "cash_sweep", "ending_principal")


class Rejection(Exception):
    def __init__(self, predicate, reason=None):
        self.predicate, self.reason = predicate, reason or predicate


def require(condition, predicate, reason=None):
    if not condition:
        raise Rejection(predicate, reason)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def common_checker():
    path = Path(__file__).resolve().with_name("checker.py")
    require(digest(path) == COMMON_DIGEST, "INDEPENDENT_COMMON_CHECKER_PIN")
    spec = importlib.util.spec_from_file_location("_r6_independent_fraction_common", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def checked_native_cut(packet, args, c):
    identity = packet["nativeIdentity"]
    expected_paths = {"finnor-os/packages/underwriting/" + k: v for k, v in NATIVE_DIGESTS.items()}
    require(identity["sourcePins"] == [{"path": path, "sha256": value}
                                     for path, value in expected_paths.items()], "FROZEN_NATIVE_SOURCE_CUT")
    for path, expected in expected_paths.items():
        require(digest(args.repo.resolve() / path) == expected, "ACTUAL_NATIVE_SOURCE_CUT", path)
    require(identity["engineVersion"] == "finnor-underwriting-engine/1.0.0"
            and identity["irSchema"] == "underwriting-model-ir.v1", "NATIVE_VERSION")
    require(identity["checkerDigest"] == "sha256:" + COMMON_DIGEST, "COMMON_CHECKER_IDENTITY")
    require(identity["decimalPolicy"] == {
        "precision": 34, "rounding": "ROUND_HALF_EVEN", "maxInputCharacters": 128, "maxAbsoluteExponent": 100,
    }, "NATIVE_DECIMAL_POLICY")
    require(packet["numericPolicy"] == {"precision": 34, "rounding": 6, "minE": -100, "maxE": 100},
            "LIVE_NATIVE_POLICY")
    require(identity["dependencyLockDigest"] == "sha256:" + LOCK_DIGEST
            and digest(args.repo.resolve() / "finnor-os/package-lock.json") == LOCK_DIGEST, "LOCK_PIN")
    module = args.decimal_module.resolve()
    require(module.name == "decimal.mjs" and digest(module) == DECIMAL_MODULE_DIGEST
            and identity["decimalModuleDigest"] == "sha256:" + DECIMAL_MODULE_DIGEST, "DECIMAL_MODULE_PIN")
    package = json.loads(module.with_name("package.json").read_text())
    require(package["name"] == "decimal.js" and package["version"] == identity["decimalPackageVersion"] == "10.6.0",
            "DECIMAL_VERSION")
    return c.h(identity)


def required_node_ids(runtime):
    ids = {
        "entry.valuation_date", "entry.cash_acquired", "entry.existing_debt", "entry.other_debt_like",
        "entry.transaction_fees", "entry.financing_fees", "entry.minimum_cash_funding", "entry.rollover_equity",
        "operating.opening_nwc", "operating.cash_tax_rate", "operating.other_cash_adjustments",
        "cash.minimum", "cash.sweep_percentage", "ownership.sponsor", "ownership.other",
        "distributions.interim", "exit.period_id", "exit.multiple", "exit.adjustments",
    }
    ids.update(("entry.metric_value", "entry.multiple") if runtime["entryValuationMethod"] == "metric_multiple"
               else ("entry.enterprise_value",))
    ids.update(("operating.base_revenue", "operating.revenue_growth") if runtime["revenueMethod"] == "growth"
               else ("operating.revenue_explicit",))
    ids.add("operating.ebitda_margin" if runtime["ebitdaMethod"] == "margin" else "operating.ebitda_explicit")
    ids.add("operating.capex_rate" if runtime["capexMethod"] == "percent_revenue" else "operating.capex_explicit")
    ids.add("operating.nwc_rate" if runtime["workingCapitalMethod"] == "percent_revenue" else "operating.nwc_explicit")
    if runtime["dAndATreatment"] == "explicit":
        ids.update(("operating.d_and_a", "forecast.d_and_a"))
    ids.update(OUTPUT_SOURCES)
    ids.update("checkcalc." + line for line in CHECK_CODES)
    ids.update("check." + line for line in CHECK_CODES)
    ids.update(source.removeprefix("returns.") if source.startswith("returns.") else "output." + source
               for source in OUTPUT_SOURCES)
    for tranche in runtime["debtTranches"]:
        prefix = "debt_input." + tranche["id"] + "."
        ids.update(prefix + field for field in ("opening_principal", "cash_interest_share", "pik_interest_share", "maturity_date"))
        if tranche["kind"] == "revolver":
            ids.add(prefix + "commitment")
        ids.update((prefix + "fixed_rate",) if tranche["rateType"] == "fixed"
                   else (prefix + "base_rate", prefix + "spread", prefix + "floor"))
        ids.add(prefix + ("mandatory_amortization_rate" if tranche["amortization"] == "original_principal_percent"
                          else "mandatory_amortization_amount"))
        ids.update("debt." + tranche["id"] + "." + field for field in DEBT_FIELDS)
    return ids


def checked_compiled(native, c):
    model, compiled = native["model"], native["compiled"]
    runtime = model.get("runtime")
    require(isinstance(runtime, dict) and runtime.get("kind") == "standard_lbo_v1", "NATIVE_STANDARD_LBO")
    require(1 <= model["periodDefinition"]["count"] <= 12, "ORIGINAL_HORIZON")
    require(len(runtime["debtTranches"]) <= 32, "NATIVE_DEBT_TRANCHE_BOUND")
    nodes = {n["id"]: n for n in model["nodes"]}
    require(len(nodes) == len(model["nodes"]) <= 10000 and set(nodes) == required_node_ids(runtime),
            "FULL_STANDARD_LBO_NODE_INVENTORY")
    require(compiled["model"] == model and compiled["nodeById"] == nodes, "COMPILED_NATIVE_NODE_BINDING")
    require(compiled["periods"] == c.periods(model["periodDefinition"]), "INDEPENDENT_NATIVE_CALENDAR")
    semantic = {k: model[k] for k in ("schemaVersion", "financialConventionVersion", "minimumEngineVersion",
                                    "periodDefinition", "nodes", "circularBlocks", "runtime")}
    require(compiled["semanticHash"] == c.h(semantic), "INDEPENDENT_NATIVE_MODEL_HASH")
    membership, blocks = {}, {}
    for block in model["circularBlocks"]:
        require(block["id"] not in blocks and len(block["nodeIds"]) >= 2
                and set(block["iterationOrder"]) == set(block["nodeIds"])
                and len(block["nodeIds"]) == len(set(block["nodeIds"])) == len(block["iterationOrder"]), "SOLVER_BLOCK")
        blocks[block["id"]] = block
        for node in block["nodeIds"]:
            require(node in nodes and node not in membership, "SOLVER_BLOCK_MEMBERSHIP")
            membership[node] = block["id"]
    component = lambda identity: "block:" + membership[identity] if identity in membership else "node:" + identity
    incoming = {component(identity): set() for identity in nodes}
    outgoing = {identity: set() for identity in incoming}
    dependents = {identity: [] for identity in nodes}
    for identity, node in nodes.items():
        require(len(node["dependencies"]) == len(set(node["dependencies"])), "DEPENDENCY_DUPLICATE")
        for dep in node["dependencies"]:
            require(dep in nodes, "MISSING_DEPENDENCY")
            dependents[dep].append(identity)
            source, target = component(dep), component(identity)
            if source != target:
                incoming[target].add(source)
                outgoing[source].add(target)
            else:
                require(identity in membership, "UNDECLARED_NATIVE_CYCLE")
        if node["kind"] == "schedule":
            require(node["schedule"] == {"kind": "standard_lbo_v1", "line": identity}, "NATIVE_SCHEDULE_LINE")
        if node["kind"] == "check":
            line = identity.removeprefix("check.")
            require(line in CHECK_CODES and node["severity"] == "error"
                    and node["failureCode"] == CHECK_CODES[line]
                    and node["assertion"] == {"op": "ref", "nodeId": "checkcalc." + line}, "FULL_HARD_CHECKS")
    ready = [identity for identity, deps in incoming.items() if not deps]
    heapq.heapify(ready)
    order = []
    while ready:
        identity = heapq.heappop(ready)
        order.extend(blocks[identity[6:]]["iterationOrder"] if identity.startswith("block:") else [identity[5:]])
        for following in sorted(outgoing[identity]):
            incoming[following].remove(identity)
            if not incoming[following]:
                heapq.heappush(ready, following)
    require(len(order) == len(nodes) and order == compiled["executionOrder"], "INDEPENDENT_NATIVE_EXECUTION_ORDER")
    require(compiled["dependencyGraph"] == {identity: node["dependencies"] for identity, node in nodes.items()}
            and compiled["dependentsGraph"] == {identity: sorted(deps) for identity, deps in dependents.items()},
            "INDEPENDENT_NATIVE_GRAPHS")
    for source in OUTPUT_SOURCES:
        output = source.removeprefix("returns.") if source.startswith("returns.") else "output." + source
        require(nodes[output]["kind"] == "output" and nodes[output]["sourceNodeId"] == source
                and nodes[output]["dependencies"] == [source]
                and c.metadata(nodes[output]) == c.metadata(nodes[source]), "FULL_RETURN_CASH_DEBT_OUTPUTS")
    # The saturation theorem uses native future-cash-flow nonnegativity, not
    # an unapproved assumption. The factory policy and complete D both bind it.
    for identity in ("distributions.interim", "ownership.sponsor"):
        node = nodes[identity]
        require(node["kind"] == "input" and node["minimum"] == "0", "FUTURE_FLOW_NATIVE_NONNEGATIVITY")
    return compiled


def checked_inventory(native, compiled, c):
    inventory = native["inventory"]
    nodes = compiled["nodeById"]
    require(len(inventory) == len(nodes) and {s["nodeId"] for s in inventory} == set(nodes),
            "COMPLETE_CASH_LIABILITY_CONSTRAINT_INVENTORY")
    require(len({c.canonical(s["ledgerRef"]) for s in inventory}) == len(inventory), "UNIQUE_LEDGER_INVENTORY")
    for state in inventory:
        node = nodes[state["nodeId"]]
        c.owner_ref(state["ledgerRef"])
        require(state["sourceClauseRefs"], "SOURCE_CLAUSE_INVENTORY")
        for clause in state["sourceClauseRefs"]:
            c.owner_ref(clause)
        liability = node["unit"] == "money" and (
            node["id"].startswith(("debt.", "debt_input."))
            or any(part in node["id"] for part in ("existing_debt", "other_debt_like", "financing_fees", "transaction_fees")))
        expected = "CONSTRAINT" if node["valueType"] == "boolean" else (
            "TIMING" if node["valueType"] in {"date", "text"} else
            "LIABILITY" if liability else "CASH" if node["unit"] == "money" else "OBJECTIVE")
        require(state["role"] == expected, "REQUIRED_FINANCIAL_ROLE")
        require(state["obligationStatus"] == ("REPRESENTED" if liability else "NOT_APPLICABLE"),
                "UNKNOWN_OR_MISSING_LIABILITY")
        if liability:
            c.owner_ref(state["obligationRef"])
        else:
            require(state["obligationRef"] is None, "EXTRA_OBLIGATION")
        expected_time = {"kind": "PERIOD_END"} if node["shape"] == "series" else {"kind": "AS_OF", "date": "2026-01-01"}
        require(state["timing"] == expected_time, "EXACT_RETAINED_TIMING_INVENTORY")


def check(packet, args, c, receipt):
    c.exact_keys(packet, ("schema", "native", "nativeIdentity", "numericPolicy", "claim"), "OBLIGATION_PACKET_SCHEMA")
    require(packet["schema"] == "finnor.r6.lbo-totality-obligation.v1", "OBLIGATION_PACKET_VERSION")
    receipt["nativeIdentityDigest"] = checked_native_cut(packet, args, c)
    native = packet["native"]
    c.exact_keys(native, ("config", "model", "compiled", "snapshot", "domain", "inventory", "result"), "RETAINED_NATIVE_SCHEMA")
    compiled = checked_compiled(native, c)
    checked_inventory(native, compiled, c)
    arena = c.Arena()
    # Same independent complete-domain checker, no fake reference assertion:
    # this invocation checks membership/bijection only and cannot issue ACCEPTED.
    _, _, cardinality = c.validate_domain({
        "domain": native["domain"], "witness": native["snapshot"],
        "nativeWitness": {"referenceSnapshot": native["snapshot"]},
    }, compiled, compiled, arena)
    receipt["domainDigest"], receipt["domainCardinality"] = c.h(native["domain"]), str(cardinality)
    result, snapshot = native["result"], native["snapshot"]
    require(result["modelSemanticHash"] == compiled["semanticHash"]
            and result["inputSemanticHash"] == snapshot["semanticHash"]
            and result["resultSemanticHash"] == c.h({k: v for k, v in result.items() if k != "resultSemanticHash"}),
            "ACTUAL_NATIVE_RESULT_BINDING")
    require(result["status"] == "FAILED" and result["validity"] == "INCOMPLETE"
            and result["failure"]["code"] == "IRR_UNDEFINED", "ACTUAL_NATIVE_FAILURE_REQUIRED")
    require(result["failure"]["details"] == {"minimumRate": "-0.999999999999", "maximumRate": "1000"},
            "ACTUAL_NATIVE_ENDPOINT_FAILURE")
    exit_id = snapshot["values"]["exit.period_id"]["value"]
    period_ids = [p["id"] for p in compiled["periods"]]
    require(exit_id in period_ids and period_ids.index(exit_id) >= 8, "COUNTEREXAMPLE_LATE_EXIT")
    exit_domain = next(b for b in native["domain"]["inputs"] if b["programmeNodeId"] == "exit.period_id")
    permitted = exit_domain["components"]["$scalar"]
    require(permitted["kind"] == "ENUMERATION" and exit_id in permitted["values"], "ORIGINAL_DOMAIN_MEMBERSHIP")
    late_exits = [p for p in period_ids[8:] if p in permitted["values"]]
    claim = packet["claim"]
    require(claim == {"rule": "NATIVE_LOWER_NPV_SATURATION_DISPROVES_TOTALITY",
                      "minimumRate": "-0.999999999999", "flowIndex": 9, "minimumExponent": -100,
                      "scope": "EVERY_STANDARD_LBO_INPUT_WITH_EXIT_ORDINAL_GE_9",
                      "noFinancialAcceptance": True, "domainDigest": c.h(native["domain"]),
                      "axioms": [], "unresolvedGoals": []}, "EXACT_NEGATIVE_PROOF_CLAIM")
    base = c.significant(c.decimal_value(claim["minimumRate"]) + 1)
    require(base == c.power10(-12), "EXACT_NATIVE_LOWER_BASE")
    power = base ** claim["flowIndex"]
    require(power == c.power10(-108) and c.floor_log10(power) < claim["minimumExponent"],
            "EXACT_NATIVE_POWER_UNDERFLOW")
    # Integer powers of a pure decimal power of ten incur no digit-rounding
    # ambiguity. Under the pinned decimal.js minE policy the final exponent
    # -108 clamps to zero. 0/0=>NaN; positive/0=>Infinity. Both remain nonfinite
    # through the remaining nonnegative terms. The pinned solve() finite guard
    # fails before bisection; zero sign changes fail even earlier.
    receipt.update({
        "disposition": "DISPROVED", "predicate": "NATIVE_PERIODIC_IRR_LOWER_NPV_UNDERFLOW",
        "successfulUniversalValidityDisproved": True, "allInputFinancialProofPassed": False,
        "negativeRuleScope": claim["scope"], "certifiedLateExitSetInUnchangedDomain": late_exits,
        "exactObligation": "forall x in D: native.status == SUCCEEDED and native.validity == VALID",
        "counterexampleInputDigest": snapshot["semanticHash"], "nativeModelDigest": compiled["semanticHash"],
        "coverage": {"nativeNodes": len(compiled["nodeById"]), "inventory": len(native["inventory"]),
                     "inputs": len(native["domain"]["inputs"]), "periods": len(compiled["periods"]),
                     "checks": len(CHECK_CODES), "outputs": len(OUTPUT_SOURCES)},
        "arithmetic": {"base": "0.000000000001", "flowIndex": 9, "exactPower": "1/10^108",
                       "mathematicalExponent": -108, "nativeMinimumExponent": -100,
                       "nativeDenominator": "0", "zeroNumeratorQuotient": "NaN",
                       "positiveNumeratorQuotient": "Infinity", "nativeFailure": "IRR_UNDEFINED"},
        "noSampledOrEnumeratedPositiveProof": True, "originalDomainNarrowed": False,
        "internalEngineeringStatus": "BLOCKED_FALSE_NATIVE_TOTALITY_OBLIGATION",
    })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--decimal-module", required=True, type=Path)
    parser.add_argument("--packet", required=True)
    args = parser.parse_args()
    started = time.monotonic()
    receipt = {
        "schema": "finnor.r6.lbo-totality-obligation-receipt.v1", "disposition": "UNKNOWN",
        "predicate": "NOT_CHECKED", "reason": None, "packetDigest": "",
        "checkerDigest": "sha256:" + digest(Path(__file__).resolve()),
        "independentCommonCheckerDigest": "sha256:" + COMMON_DIGEST,
        "allInputFinancialProofPassed": False,
        "qualification": "ORDINARY_DEVELOPMENT_EVIDENCE_NOT_ADMITTED",
        "referenceApproval": "NOT_ESTABLISHED", "checkerAdmission": "NOT_ESTABLISHED",
        "executionAuthorityGranted": False,
    }
    c = None
    try:
        c = common_checker()
        if args.packet == "-":
            raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        else:
            with Path(args.packet).open("rb") as source:
                raw = source.read(MAX_BYTES + 1)
        require(len(raw) <= MAX_BYTES, "OBLIGATION_PACKET_BYTES")
        packet = json.loads(raw, object_pairs_hook=c.strict_pairs)
        receipt["packetDigest"] = c.h(packet)
        check(packet, args, c, receipt)
    except Rejection as error:
        receipt["disposition"], receipt["predicate"], receipt["reason"] = "REJECTED", error.predicate, error.reason
    except Exception as error:
        if c is not None and isinstance(error, c.Refusal):
            receipt["disposition"], receipt["predicate"], receipt["reason"] = "REJECTED", error.predicate, error.reason
        else:
            receipt["predicate"], receipt["reason"] = "CHECKER_FAILURE", type(error).__name__ + ": " + str(error)
    usage = resource.getrusage(resource.RUSAGE_SELF)
    receipt["physical"] = {
        "pid": os.getpid(), "parentPid": os.getppid(), "pythonVersion": platform.python_version(),
        "executable": sys.executable, "executableDigest": "sha256:" + digest(Path(sys.executable).resolve()),
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "cpuUserMicros": round(usage.ru_utime * 1000000), "cpuSystemMicros": round(usage.ru_stime * 1000000),
        "maxRssNative": usage.ru_maxrss, "usd": None,
    }
    print(json.dumps(receipt, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
