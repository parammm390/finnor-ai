#!/usr/bin/env python3
"""Independent H1 fixture oracle: fractions only, no FINNOR imports.

Input: {"fixture": <native-fixtures case>, "request": <request with base pin>}.
Output: complete finite descriptor enumeration, rational native cash flows/costs,
canonical economic duplicate classification, and cost-aware incumbent choice.
This oracle deliberately does not compute IRR/XIRR or owner admissibility.
"""

import copy
import datetime
import itertools
import json
import sys
from fractions import Fraction as F


def stable(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def rational(value):
    return str(F(value))


def decimal(value):
    value = F(value)
    denominator = value.denominator
    places = 0
    while denominator % 2 == 0:
        denominator //= 2
        places += 1
    fives = 0
    while denominator % 5 == 0:
        denominator //= 5
        fives += 1
    if denominator != 1:
        raise ValueError("Only terminating fixture terms may be serialized as decimals")
    places = max(places, fives)
    scaled = value * 10 ** places
    digits = str(abs(scaled.numerator)).rjust(places + 1, "0")
    text = digits if places == 0 else digits[:-places] + "." + digits[-places:]
    text = text.rstrip("0").rstrip(".") if "." in text else text
    return ("-" if value < 0 else "") + text


def grid(bounds):
    low, high, step = (F(bounds[key]) for key in ("minimum", "maximum", "step"))
    if step <= 0 or high < low:
        raise ValueError("Invalid independent grid")
    count = (high - low) // step + 1
    if count > 16:
        raise ValueError("Independent grid exceeds registered bound")
    return [decimal(low + index * step) for index in range(count)]


def periods(fixture):
    # Civil dates come directly from fixture period IDs, not a finance helper.
    rows = []
    for period_id in fixture["inputs"]["operating"]["ebitda"]:
        _, start, end = period_id.split(":")
        rows.append({"id": period_id, "start": start, "end": end})
    return sorted(rows, key=lambda row: row["start"])


def descriptors(fixture):
    permitted = fixture["permitted"]
    offers = [None] + (grid(permitted["entryEnterpriseValue"]) if permitted.get("entryEnterpriseValue") else [])
    financing = [None]
    for option in sorted(permitted["financing"], key=lambda row: row["id"]):
        for principal, rate in itertools.product(grid(option["principal"]), grid(option["annualRate"])):
            financing.append({
                "optionId": option["id"], "mode": option["mode"], "trancheId": option["trancheId"],
                "principal": principal, "fixedAnnualRate": rate,
                "upfrontFee": decimal(F(principal) * F(option["upfrontFeeFraction"])),
            })
    timing = [None]
    if permitted.get("interimDistribution"):
        timing += sorted(set(permitted["interimDistribution"]["allowedDates"]))
    return [{"entryEnterpriseValue": offer, "financing": loan, "distributionDate": date}
            for offer, loan, date in itertools.product(offers, financing, timing)]


def effective(fixture, descriptor):
    values = copy.deepcopy(fixture["inputs"])
    if descriptor["entryEnterpriseValue"] is not None:
        values["entry"]["enterpriseValue"] = descriptor["entryEnterpriseValue"]
    if descriptor["financing"] is not None:
        loan = descriptor["financing"]
        option = next(row for row in fixture["permitted"]["financing"] if row["id"] == loan["optionId"])
        values["entry"]["financingFees"] = decimal(
            F(values["entry"]["financingFees"]) - F(option["replacedBaseFee"]) + F(loan["upfrontFee"]))
        if loan["mode"] == "ADD_FIXED_TERM":
            values["debt"][loan["trancheId"]] = {
                "openingPrincipal": loan["principal"], "fixedRate": loan["fixedAnnualRate"],
                "maturityDate": option["maturityDate"],
            }
        else:
            values["debt"][loan["trancheId"]]["openingPrincipal"] = loan["principal"]
            values["debt"][loan["trancheId"]]["fixedRate"] = loan["fixedAnnualRate"]
    if descriptor["distributionDate"] is not None:
        rows = periods(fixture)
        rule = fixture["permitted"]["interimDistribution"]
        source = next(row["id"] for row in rows if row["end"] == rule["fromDate"])
        target = next(row["id"] for row in rows if row["end"] == descriptor["distributionDate"])
        if source != target:
            amount = values["interimDistributions"][source]
            values["interimDistributions"][source] = "0"
            values["interimDistributions"][target] = decimal(F(values["interimDistributions"][target]) + F(amount))
    return values


def economics(fixture, request, values):
    entry, operating = values["entry"], values["operating"]
    debt = sum((F(row["openingPrincipal"]) for row in values["debt"].values()), F(0))
    uses = F(entry["enterpriseValue"]) + F(entry["cashAcquired"]) + F(entry["transactionFees"]) \
        + F(entry["financingFees"]) + F(entry["minimumCashFunding"])
    equity = uses - debt - F(entry["rolloverEquity"])
    if equity < 0:
        return None, "SOURCES_USES_IMBALANCE"
    cash = F(entry["cashAcquired"]) + F(entry["minimumCashFunding"])
    prior_nwc = F(operating["openingNwc"])
    flows = [{"date": entry["valuationDate"], "periodId": None, "amount": rational(-equity)}]
    cash_by_period, interest_by_period = {}, {}
    rows = periods(fixture)
    for index, period in enumerate(rows):
        period_id = period["id"]
        day_count = (datetime.date.fromisoformat(period["end"]) - datetime.date.fromisoformat(period["start"])).days + 1
        interest = sum((F(row["openingPrincipal"]) * F(row["fixedRate"]) * F(day_count, 365)
                        for row in values["debt"].values()), F(0))
        ebitda = F(operating["ebitda"][period_id])
        nwc = F(operating["nwc"][period_id])
        fcf = ebitda - max(ebitda, F(0)) * F(operating["cashTaxRates"][period_id]) \
            - F(operating["capex"][period_id]) - (nwc - prior_nwc) + F(operating["otherCashAdjustments"][period_id])
        prior_nwc = nwc
        distribution = F(values["interimDistributions"][period_id])
        cash += fcf - interest - distribution
        cash_by_period[period_id], interest_by_period[period_id] = rational(cash), rational(interest)
        if cash < F(values["cash"]["minimum"]):
            return None, "LIQUIDITY_SHORTFALL"
        if index == len(rows) - 1:
            exit_equity = ebitda * F(values["exit"]["multiple"]) - debt + cash + F(values["exit"]["adjustments"])
            if exit_equity < 0:
                return None, "NEGATIVE_EXIT_EQUITY"
            distribution += exit_equity
        flows.append({"date": period["end"], "periodId": period_id, "amount": rational(distribution)})
    if equity == 0:
        return None, "MOIC_UNDEFINED"
    discounted = sum((F(row["amount"]) / (1 + F(request["objective"]["discountFraction"])) ** index
                      for index, row in enumerate(flows)), F(0))
    costs = request["costs"]
    original = fixture["inputs"]
    offer_changed = F(entry["enterpriseValue"]) != F(original["entry"]["enterpriseValue"])
    financing_changed = stable(values["debt"]) != stable(original["debt"]) or F(entry["financingFees"]) != F(original["entry"]["financingFees"])
    timing_changed = values["interimDistributions"] != original["interimDistributions"]
    implementation = (F(costs["offerChange"]) if offer_changed else 0) \
        + (F(costs["financingChange"]) if financing_changed else 0) \
        + (F(costs["distributionTimingChange"]) if timing_changed else 0)
    return {
        "entryEnterpriseValue": rational(entry["enterpriseValue"]),
        "financingFees": rational(entry["financingFees"]),
        "sponsorEquity": rational(equity), "exitEquity": rational(exit_equity),
        "cashByPeriod": cash_by_period, "cashInterestByPeriod": interest_by_period,
        "sponsorCashFlows": flows, "discountedSponsorCashFlow": rational(discounted),
        "implementationCost": rational(implementation),
        "localValueBeforeSearchCost": rational(discounted - implementation),
    }, None


def signature(values):
    # Economic novelty ignores descriptor option labels and decimal spellings.
    return stable({
        "entry": decimal(values["entry"]["enterpriseValue"]),
        "fee": decimal(values["entry"]["financingFees"]),
        "debt": [{"id": key, "principal": decimal(row["openingPrincipal"]), "rate": decimal(row["fixedRate"]),
                  "maturityDate": row["maturityDate"]}
                 for key, row in sorted(values["debt"].items())],
        "distributions": {key: decimal(value) for key, value in values["interimDistributions"].items()},
    })


def evaluate(payload):
    fixture, request = payload["fixture"], payload["request"]
    incumbent_descriptor = {"entryEnterpriseValue": None, "financing": None, "distributionDate": None}
    all_descriptors = [incumbent_descriptor] + descriptors(fixture)
    seen, rows, valid = {}, [], []
    for index, descriptor in enumerate(all_descriptors):
        values = effective(fixture, descriptor)
        key = signature(values)
        if key in seen:
            rows.append({"candidate": descriptor, "disposition": "DUPLICATE", "duplicateOf": seen[key], "economics": None})
            continue
        seen[key] = index
        calculated, failure = economics(fixture, request, values)
        rows.append({"candidate": descriptor, "disposition": "FAILED" if failure else "EVALUATED",
                     "failureCode": failure, "economics": calculated})
        if calculated is not None:
            valid.append((index, F(calculated["localValueBeforeSearchCost"])))
    executions = len(seen)
    liability = executions * F(request["costs"]["perNativeExecution"])
    incumbent = next((value for index, value in valid if index == 0), None)
    best = max(valid, key=lambda item: (item[1], -item[0])) if valid else None
    selected = 0
    improvement = None if incumbent is None or best is None else best[1] - incumbent - liability
    if improvement is not None and improvement > F(request["objective"]["minimumNetImprovement"]):
        selected = best[0]
    return {
        "schema": "finnor.m3.independent-fraction-reference.v1", "qualification": "H1_FIXTURE_ONLY",
        "rows": rows, "nativeExecutions": executions, "evaluationLiability": rational(liability),
        "incumbentIndex": 0, "bestIndex": None if best is None else best[0], "selectedIndex": selected,
        "costAdjustedImprovement": None if improvement is None else rational(improvement),
    }


if __name__ == "__main__":
    print(stable(evaluate(json.load(sys.stdin))))
