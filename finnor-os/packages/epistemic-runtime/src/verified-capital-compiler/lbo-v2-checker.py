#!/usr/bin/env python3
"""Independent native-standard-LBO-v2 trace/congruence/whole-domain checker.

Only Python stdlib/Fraction is used. Native code, Decimal, producer arithmetic,
transcendental approximations and supplied expected numeric answers are not
imported. Frozen independent helpers reconstruct the compiled graph/calendar,
complete domain, state/obligation inventory and owner bindings.

Congruence is deliberately structural: the same complete native deterministic
runtime/ordered graph and bijective input projection. Whole-domain successful
validity is a separate checked invariant/contraction/bracket rule, NOT witness
sampling. The audited profile retains the original full cent lattices, all
exits, 110/124 nodes, ten checks and 33 outputs. Other configurations refuse.
This remains conditional mechanical development evidence, never admission or
an independently approved financial reference.
"""
import argparse
from fractions import Fraction as F
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import resource
import sys
import time

MAX_BYTES = 8 * 1024 * 1024
MAX_TERMS = 250000
COMMON_DIGEST = "01a8f9c988b75882453077bca8277fcf051ec9a1c4be48830a93840d535cfa03"
INVENTORY_CHECKER_DIGEST = "1c9049c51127bcdf124aa60f8bd2db7246e83c61ce0d22d46b379426f87f4471"
METHOD = "decimal34_horner_npv_v2"
MIN_RATE, MAX_RATE = F("-0.999999999999"), F(1000)
RATE_TOLERANCE, NPV_TOLERANCE = F("1e-24"), F("1e-24")
ROOT_WIDTH = F("1e-32")
EPSILON = F("1e-30")  # > half an ulp for every |finance operation| < 1000.
NODE_GRAPHS = {
    False: "sha256:5ef7744fca84cc879abf5d7a5417e2ed9d7aee66d250115578b5f4aff9d3e6a9",
    True: "sha256:f35962c8822480e746b07e3be90ab4538052f4b26cb443047ce5c7d2a29f5f8d",
}
RUNTIME_GRAPHS = {
    False: "sha256:62ec1e0c66de6f923951ec9b687396a087912e862229ed6773637bd1dc15ab5a",
    True: "sha256:f6b7db4df2ad819a156a763ac32d97f79be0d3ab68bf3ac40dc7fede2ba73096",
}
BLOCK_GRAPHS = {
    False: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    True: "sha256:070a01440f0d26583a81c77747f19c471ddb8b4fe4d9f007d81de81681dd9c62",
}
# Only explicitly audited native semantics, not caller-supplied code pins.
NATIVE_DIGESTS = {
    "package.json": "0223d6311820055125a0ea7ead89ce8231b4529e041f3b9aac7961a48027cab1",
    "src/canonical.ts": "0e96266034a7f05a570b569f5d5c239e23da2c138232dc2b30d8058f876b99b0",
    "src/compiler.ts": "6081ce910199002bcc5a23c3e09c403a1f2a2a9c36d8c016d138ea06c968989c",
    "src/decimal.ts": "301604f5f53b92b1908db00e12d600716bc8f3ab1e5233fb7516e8630282b572",
    "src/errors.ts": "0c5e26fdc4ecb969a47685f9a2d123a2358a5b5873e889e21a540d2a100f3fa2",
    "src/executor.ts": "0146a271061fc0881716bcb8cc7cb3856400e53b54dd59ef44a5a036efa791fe",
    "src/index.ts": "90d626a09a62cf063ced2e793653d7d0d31ba406d49f5090d71a2229a65a3cda",
    "src/periods.ts": "987ec7b6ad5cb466932fc7530b3e78ef3438dad1b59bdee46f11a25c135c91d3",
    "src/result.ts": "57d0ccf43a5c258075f28af9004ce75d7eaab411033f07b313ec8549afdc6114",
    "src/snapshot.ts": "721a4e0ba82cbab9480e28601f8397ec97192a20d7cc39004ef8e9ccc1885cf6",
    "src/standard-lbo.ts": "f990b82d97adc194663eaa763d778521840ac26e8f9772d8e8e07fce9c4e33de",
    "src/returns.ts": "9e82a4316ccddfaa360fc80996f572d5ad26d6401d21611c97777f72938e89de",
    "src/types.ts": "8ab50ed904cbd10c6b8006f72979fd5a237b5e691576744012a1d51bf8ef506c",
    "src/returns-v2.ts": "5325e6a13c3e2002e3fb0c881fcd0d762246961f4b850dd29fa51cb2735fee55",
}
LOCK_DIGEST = "aebbbac3741b6cf7f2424447bf2bc12524eab526e041b6baada5d167003855c5"
DECIMAL_DIGEST = "45e6ecc0a500fee6439acdf67ee2e9322aab57e6ea0409ef52993dedbba8cf19"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def independent_module(name, filename, expected):
    path = Path(__file__).resolve().with_name(filename)
    if digest(path) != expected:
        raise RuntimeError("Independent dependency bytes differ: " + filename)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class Arithmetic:
    """Actual native primitive rounding/saturation, no host decimal library."""
    def __init__(self, common):
        self.c, self.operations = common, 0

    def r(self, value):
        self.operations += 1
        self.c.require(self.operations <= MAX_TERMS, "PROOF_TERMS")
        result = self.c.significant(value)
        if result:
            exponent = self.c.floor_log10(abs(result))
            if exponent < -100:
                return F(0)
            self.c.require(exponent <= 100, "NATIVE_FINITE_ARITHMETIC")
        return result

    def add(self, *values):
        result = F(0)
        for value in values:
            result = self.r(result + value)
        return result

    def sub(self, left, right):
        return self.r(left - right)

    def mul(self, *values):
        result = F(1)
        for value in values:
            result = self.r(result * value)
        return result

    def div(self, left, right):
        self.c.require(right != 0, "NATIVE_NONZERO_DENOMINATOR")
        return self.r(left / right)

    def text(self, value):
        # Traces are raw native toFixed() intermediates; unlike financial input
        # normalization, minE=-100 plus 34 digits may need up to 135 characters.
        result = self.c.decimal_text(value)
        self.c.require(len(result) <= 256, "BOUNDED_NATIVE_TRACE_DECIMAL")
        return result

    def normalized(self, value):
        result = self.text(value)
        self.c.require(len(result) <= 128, "NATIVE_FINANCIAL_NORMALIZATION")
        return result

    def power(self, base, exponent):
        self.c.require(type(exponent) is int and 0 <= exponent <= 5000, "V2_NATURAL_POWER_BOUND")
        value, factor, power = F(1), base, exponent
        while power:
            if power % 2:
                value = self.r(value * factor)
            power //= 2
            if power:
                factor = self.r(factor * factor)
        return value

    def daily_bracket(self, target):
        left, right, steps = F(0), F(1 if target <= 1 else 2), []
        for _ in range(200):
            midpoint = self.div(self.r(left + right), F(2))
            if self.sub(right, left) <= ROOT_WIDTH or midpoint in (left, right):
                return {"target": self.text(target), "left": self.text(left), "right": self.text(right), "steps": steps}
            power = self.power(midpoint, 365)
            side = "LEFT" if power <= target else "RIGHT"
            steps.append({"left": self.text(left), "right": self.text(right), "midpoint": self.text(midpoint),
                          "power": self.text(power), "side": side})
            if side == "LEFT":
                left = midpoint
            else:
                right = midpoint
        raise self.c.Refusal("V2_DAILY_ROOT_TERMINATION", "Independent daily bracket did not terminate")

    def returns(self, flows, mode):
        amounts = [self.c.decimal_value(flow["amount"]) for flow in flows]
        self.c.require(2 <= len(amounts) <= 13 and amounts[0] < 0
                       and all(value >= 0 for value in amounts[1:]) and any(value > 0 for value in amounts[1:]),
                       "V2_NATIVE_CASH_FLOW_SIGNS")
        gaps = [1 if mode == "PERIODIC" else (self.c.civil(flows[i]["date"])
                - self.c.civil(flows[i - 1]["date"])).days for i in range(1, len(flows))]
        self.c.require(all(0 <= gap <= 5000 for gap in gaps) and sum(gaps) <= 5000, "V2_DATED_TIMELINE")
        brackets = [] if mode == "PERIODIC" else [
            self.daily_bracket(self.r(MIN_RATE + 1)), self.daily_bracket(self.r(MAX_RATE + 1))]
        left, right = (self.r(MIN_RATE + 1), self.r(MAX_RATE + 1)) if not brackets else (
            F(brackets[0]["left"]), F(brackets[1]["right"]))
        trace = {"method": METHOD, "mode": mode, "gaps": gaps, "dailyBrackets": brackets,
                 "npvs": [], "iterations": [], "finalBase": None, "rate": None}

        def npv(base):
            self.c.require(base > 0, "V2_POSITIVE_RETURN_BASE")
            total, powers, partials = amounts[0], [], [self.text(amounts[0])]
            for exponent, amount in zip(gaps, amounts[1:]):
                power = self.power(base, exponent)
                total = self.r(self.r(total * power) + amount)
                powers.append(self.text(power)); partials.append(self.text(total))
            trace["npvs"].append({"base": self.text(base), "powers": powers, "partials": partials})
            return total

        left_value, right_value = npv(left), npv(right)
        sign = lambda value: (value > 0) - (value < 0)
        self.c.require(sign(left_value) != sign(right_value), "V2_NATIVE_RETURN_BRACKET")
        tolerance = self.r(NPV_TOLERANCE * max([F(1)] + [abs(v) for v in amounts]))
        for _ in range(200):
            midpoint = self.div(self.r(left + right), F(2))
            value = npv(midpoint)
            converted_left = left if mode == "PERIODIC" else self.power(left, 365)
            converted_right = right if mode == "PERIODIC" else self.power(right, 365)
            width = abs(self.sub(converted_right, converted_left))
            terminate = abs(value) <= tolerance or width <= RATE_TOLERANCE
            trace["iterations"].append({"left": self.text(left), "right": self.text(right),
                                        "midpoint": self.text(midpoint), "value": self.text(value),
                                        "width": self.text(width), "terminate": terminate})
            if terminate:
                rate = self.sub(midpoint if mode == "PERIODIC" else self.power(midpoint, 365), F(1))
                self.c.require(MIN_RATE <= rate <= MAX_RATE, "V2_UNCHANGED_REPORTED_RATE_DOMAIN")
                trace["finalBase"], trace["rate"] = self.text(midpoint), self.normalized(rate)
                return rate, trace
            if sign(left_value) == sign(value):
                left, left_value = midpoint, value
            else:
                right = midpoint
        raise self.c.Refusal("V2_RETURN_TERMINATION", "Independent native return did not terminate")


def checked_profile(c, compiled, domain):
    model, runtime = compiled["model"], compiled["model"]["runtime"]
    c.require(runtime.get("returnMethod") == METHOD, "EXPLICIT_NATIVE_V2_METHOD")
    debt = bool(runtime["debtTranches"])
    c.require(c.h(model["nodes"]) == NODE_GRAPHS[debt]
              and c.h(runtime) == RUNTIME_GRAPHS[debt]
              and c.h(model["circularBlocks"]) == BLOCK_GRAPHS[debt],
              "AUDITED_COMPLETE_NATIVE_FACTORY_PROFILE", "Unregistered native schedule/solver/input policy", "UNSUPPORTED")
    c.require(model["financialConventionVersion"] == "finnor-pe-lbo/1.0.0"
              and model["minimumEngineVersion"] == "finnor-underwriting-engine/1.0.0", "NATIVE_FINANCIAL_VERSION")
    definition = model["periodDefinition"]
    c.require(definition["forecastStart"] == "2026-01-01"
              and definition["frequency"] in {"annual", "quarterly", "monthly"}
              and 1 <= definition["count"] <= 12, "CHECKED_CALENDAR_PROFILE", disposition="UNSUPPORTED")
    bindings = {b["programmeNodeId"]: b for b in domain["inputs"]}
    c.require(all(b["programmeNodeId"] == b["referenceNodeId"] for b in bindings.values()), "NATIVE_INPUT_ID_CONGRUENCE")
    variable = {"entry.enterprise_value": ("100", "101"), "operating.revenue_explicit": ("50", "51"),
                "operating.ebitda_explicit": ("20", "21")}
    fixed = {"ownership.sponsor": "1", "exit.multiple": "6", "cash.sweep_percentage": "1" if debt else "0"}
    if debt:
        fixed.update({"debt_input.term.opening_principal": "50", "debt_input.term.fixed_rate": "0.1",
                      "debt_input.term.cash_interest_share": "1"})
    for identity, binding in bindings.items():
        for raw in binding["components"].values():
            if binding["valueType"] == "decimal":
                low, high = variable.get(identity, (fixed.get(identity, "0"), fixed.get(identity, "0")))
                c.require(raw == {"kind": "DECIMAL_LATTICE", "minimum": low, "maximum": high, "decimalPlaces": 2},
                          "UNCHANGED_ORIGINAL_COMPLETE_LATTICES", identity, "UNSUPPORTED")
            else:
                expected = [p["id"] for p in compiled["periods"]] if identity == "exit.period_id" else (
                    ["2050-12-31"] if identity == "debt_input.term.maturity_date" else ["2026-01-01"])
                c.require(raw == {"kind": "ENUMERATION", "values": expected}, "UNCHANGED_ALL_EXIT_DATE_CHOICES", identity)
    return debt


def universal_rules(c, a, compiled, debt):
    """Checked quantified rules. Each exit branch covers ALL cent inputs.

    Finance rounding: for |z|<1000, HALF_EVEN absolute error <=5e-32,
    saturated errors <=1e-100. EPS=1e-30 strictly dominates both. Addition
    of zero/one multiplication is idempotent on a normalized 34-digit value.
    Min/max are monotone, nonexpansive and preserve nonnegative bounds.

    Average-balance map: F(x)=R(O-min(R(K+B-R(R(R((O+x)/2)*.1)*Y)),O)).
    With 0<=O,x<=50, 20<=B<=21, K>=0 and Y<=366/365, its rounded residual
    contracts by q=.051 plus <=16 EPS per step. The recurrence bound below
    is evaluated exactly, rather than using observed native iteration counts.
    """
    periods = compiled["periods"]
    c.require(len(periods) <= 12 and EPSILON > F("5e-32") + F("1e-100"), "DECIMAL34_ABSOLUTE_ERROR_LEMMA")
    c.require(F(252) + F(21) + F(50) + F(6) * F(21) < 1000, "ALL_FINANCE_OPERATION_MAGNITUDES")
    # Integer-cent forecast, EV and entry plug operations have <=6 digits;
    # their required zero adjustments are exact and do not create division.
    c.require(6 < 34 and F(100) - (F(50) if debt else 0) > 0, "EXACT_CENT_ENTRY_FORECAST_AND_POSITIVE_INVESTMENT")
    day_fractions = [a.div(F((c.civil(p["endDate"]) - c.civil(p["startDate"])).days + 1), F(365)) for p in periods]
    c.require(all(0 < value <= F(366, 365) + EPSILON for value in day_fractions), "EXACT_NATIVE_INTEREST_YEAR_FRACTIONS")
    q = F(51, 1000)
    c.require(F(1, 20) * (max(day_fractions) if day_fractions else F(0)) < q < 1, "DEBT_MAP_CONTRACTION_FACTOR")
    residual = F(50) * q ** 99 + 16 * EPSILON / (1 - q)
    c.require(residual < F("1e-8"), "ALL_INPUT_FIXED_POINT_CONVERGES_WITHIN_ORIGINAL_100_ITERATIONS")
    # Componentwise interval induction over every modeled period, including
    # those after an early exit, because native execution computes them all.
    opening_high, opening_low, cash_high = (F(50) if debt else F(0)), (F(50) if debt else F(0)), F(0)
    bounds, money_scale = [], 2
    for index, (period, year) in enumerate(zip(periods, day_fractions)):
        interest_high = a.mul(opening_high, F("0.1"), year) + 8 * EPSILON if debt and opening_high else F(0)
        pre_cash_low = F(20) - interest_high - 2 * EPSILON
        c.require(pre_cash_low > 0, "ALL_INPUT_NO_LIQUIDITY_BRANCH", period["id"])
        if debt and pre_cash_low > opening_high:
            ending_high = F(0)  # min(cash,O)==O, R(O-O)==0, EXACT.
        else:
            ending_high = max(opening_high - pre_cash_low, F(0)) + 2 * EPSILON if debt else F(0)
        # Relational sweep invariant: if all inputs leave positive debt,
        # ALL available cash was repaid, so ending cash is exactly zero.
        # Losing this relation would falsely admit a large opening-cash
        # interval and destroy the later normalization/contraction bounds.
        pre_cash_high = cash_high + 21
        ending_low = max(opening_low - pre_cash_high, F(0)) if debt else F(0)
        cash_high = (F(0) if ending_low > 0 else max(pre_cash_high - opening_low, F(0)) + 4 * EPSILON) if debt else pre_cash_high
        c.require(0 <= ending_low <= ending_high <= 50 and cash_high < 300,
                  "DEBT_CASH_NONNEGATIVE_INDUCTIVE_BOUNDS", period["id"])
        # Opening debt >=8 in the first three annual/quarterly/monthly rows;
        # interest then has magnitude >=.03, so native output scale <=35.
        # A later tiny opening is >=1e-35; its final interest uses <=70 places
        # and the full-sweep map repays it exactly. No <=128 normalizer fails.
        if debt and opening_high:
            c.require(index < 4 and (opening_low >= 8 if index < 3 else pre_cash_low > opening_high),
                      "DEBT_NORMALIZATION_CANCELLATION_BOUND", period["id"])
            money_scale = 35 if index < 3 else 70
        c.require(money_scale + 5 < 128, "ALL_INPUT_FINANCIAL_NORMALIZATION_LENGTH")
        c.require(period["endDate"] < "2050-12-31", "ALL_INPUT_MATURITY_NOT_CROSSED")
        bounds.append({"periodId": period["id"], "openingDebtUpper": a.text(opening_high),
                       "endingDebtUpper": a.text(ending_high), "interestUpper": a.text(interest_high),
                       "endingCashUpper": a.text(cash_high), "maximumMoneyScale": money_scale})
        opening_high, opening_low = ending_high, ending_low
    c.require(not debt or len(periods) < 4 or opening_high == 0, "DEBT_ZERO_AFTER_FOURTH_PERIOD_OR_SHORT_HORIZON")
    # Every full-sweep min is bounded by available principal and by cash;
    # exact zero PIK/draw/amortization makes the roll-forward identical.
    # Source/exit bridge reassociation introduces at most 8 EPS << hard tol.
    c.require(8 * EPSILON < F("1e-8"), "ALL_TEN_NATIVE_HARD_CHECKS_ROUNDING_TOLERANCE")
    minimum_daily = a.daily_bracket(F("1e-12"))
    maximum_daily = a.daily_bracket(F(1001))
    lower, upper = F(minimum_daily["left"]), F(maximum_daily["right"])
    c.require(F("0.9") < lower < 1 < upper < F("1.02"), "FINITE_DAILY_BASE_ENDPOINT_BRACKETS")
    # Natural-power forward error: <= (n*u)/(1-n*u) times the exact power;
    # square-and-multiply error weights total <2n, with u<=1e-33. No power
    # of these daily bases underflows or overflows at n<=365. At longer
    # lower-base gaps the explicitly modeled saturation can only reduce the
    # negative Horner contribution; its absolute tail is separately bounded.
    c.require(F(2 * 365) * F("1e-33") < 1, "NATURAL_POWER_RELATIVE_ERROR_FACTOR")
    power_error = F(2 * 365) * F("1e-33") / (1 - F(2 * 365) * F("1e-33")) * F("1.02") ** 365
    c.require(power_error < F("1e-26"), "DAILY_ANNUALIZATION_ABSOLUTE_ERROR_BOUND")
    c.require(F(365) * F("1.02") ** 364 < 1000000, "DAILY_ANNUALIZATION_LIPSCHITZ_BOUND")
    base_width_100 = F(1001) / 2 ** 100 + 8 * EPSILON
    daily_width_100 = (upper - lower) / 2 ** 100 + F("1e-31")
    c.require(base_width_100 < RATE_TOLERANCE
              and F(1000000) * daily_width_100 + 2 * power_error + EPSILON < RATE_TOLERANCE,
              "EVERY_RETURN_BISECTION_STOPS_BY_101_WITH_ORIGINAL_MAX_200")
    c.require(F(2) / 2 ** 110 + F("4e-33") < ROOT_WIDTH, "EVERY_CONSTANT_DAILY_ROOT_STOPS_BY_111")
    # Checked guards inside the original annual-rate domain; not new limits.
    guard_low, guard_high = F("1.000000002"), F("1.014")
    c.require(a.power(guard_high + F("0.001"), 365) - 1 < MAX_RATE, "FITTED_DATED_RETURN_INSIDE_ORIGINAL_MAXIMUM_RATE")
    c.require(a.power(guard_low, 365) - 1 > 0, "FITTED_DATED_RETURN_INSIDE_ORIGINAL_MINIMUM_RATE")
    brackets = []
    for index, period in enumerate(periods):
        k = index + 1
        sponsor_low, sponsor_high = (F(50), F(51)) if debt else (F(100), F(101))
        proceeds_low = F(120) - F(bounds[index]["endingDebtUpper"]) if debt else F(120 + 20 * k)
        proceeds_high = F(126) + F(bounds[index]["endingCashUpper"])
        days = (c.civil(period["endDate"]) - c.civil("2026-01-01")).days
        c.require(0 < days <= 5000 and proceeds_low > sponsor_high + 10, "ALL_EXIT_STRICTLY_POSITIVE_DISTRIBUTIONS", period["id"])
        # Conservative per-operation absolute Horner error. Negative partials
        # times the lower periodic base can saturate to zero; this only raises
        # the numerator toward its positive final proceeds, with <=1e-100
        # absolute error at the saturation point. All intermediate magnitudes
        # are <1e40, so <=1e-26 rounding error, propagated by the positive base.
        periodic_error = F(10000) * F(1001) ** k * F("1e-26")
        c.require(F(101) * F(1001) ** 12 + F(400) < F("1e40"), "ALL_HORNER_INTERMEDIATES_FINITE")
        periodic_lower = proceeds_low - sponsor_high * F("1e-12") ** k - F("1e-20")
        periodic_upper = proceeds_high - sponsor_low * F(1001) ** k + periodic_error
        dated_lower = proceeds_low - sponsor_high * a.power(lower, days) - F("1e-20")
        upper_power = a.power(upper, days)
        relative_error = F(2 * 5000 + 50) * F("1e-33") / (1 - F(2 * 5000 + 50) * F("1e-33"))
        c.require(relative_error < F("1e-26"), "WHOLE_DATED_HORNER_RELATIVE_FORWARD_ERROR")
        # Upper-base late-exit magnitudes can reach 1e38: use a scaled
        # relative error, never an unjustified fixed absolute epsilon.
        dated_upper_error = (proceeds_high + sponsor_high * upper_power) * F("1e-26")
        dated_upper = proceeds_high - sponsor_low * upper_power + dated_upper_error
        c.require(periodic_lower > 0 > periodic_upper and dated_lower > 0 > dated_upper,
                  "ALL_EXIT_WHOLE_DOMAIN_NATIVE_RETURN_BRACKETS", period["id"], "INCOMPLETE")
        low_guard_value = proceeds_low - sponsor_high * a.power(guard_low, days) - F("1e-18")
        high_guard_power = a.power(guard_high, days)
        high_guard_error = (proceeds_high + sponsor_high * high_guard_power) * F("1e-26")
        high_guard_value = proceeds_high - sponsor_low * high_guard_power + high_guard_error
        c.require(low_guard_value > 0 > high_guard_value, "ALL_EXIT_FITTED_RATE_GUARDS", period["id"], "INCOMPLETE")
        c.require(proceeds_low - sponsor_high * a.power(guard_low, k) > 10
                  and proceeds_high - sponsor_low * a.power(F(10), k) < -10,
                  "ALL_EXIT_PERIODIC_FITTED_RATE_AND_NORMALIZATION_GUARDS")
        c.require(a.power(F(11), 12) < F("1e100"), "DECLARED_FREQUENCY_ANNUALIZATION_FINITE")
        # <=400 cash scale means numerator early termination cannot cross the
        # >10 guard margin. Width termination leaves <1e-24 annual base width.
        c.require(min(low_guard_value, -high_guard_value) > F(400) * NPV_TOLERANCE + F("1e-18"),
                  "NPV_TOLERANCE_CANNOT_ESCAPE_REPORTED_RATE_GUARDS")
        brackets.append({"exitId": period["id"], "allDecimalInputsCovered": True,
                         "days": days, "sponsorBounds": [a.text(sponsor_low), a.text(sponsor_high)],
                         "proceedsBounds": [a.text(proceeds_low), a.text(proceeds_high)],
                         "periodicEndpointMargins": [a.text(periodic_lower), a.text(-periodic_upper)],
                         "datedEndpointMargins": [a.text(dated_lower), a.text(-dated_upper)]})
    return {"rule": "COMPONENTWISE_DECIMAL34_INVARIANT_CONTRACTION_AND_SIGN_BRACKETS",
            "decimal34FinanceAbsoluteError": a.text(EPSILON), "fixedPointFactor": a.text(q),
            "residualUpperAt100": {"numerator": str(residual.numerator), "denominator": str(residual.denominator)},
            "financeBounds": bounds, "allExitBranches": brackets,
            "returnStopIterationUpper": 101, "dailyRootStopIterationUpper": 111,
            "allOriginalInputsAndExitChoicesPreserved": True, "noSampledUniversalProof": True}


def concrete_native(c, a, compiled, snapshot, debt, inventory):
    """Independent native witness replay; not the universal proof."""
    values = {}
    for identity, raw in snapshot["values"].items():
        node = compiled["nodeById"][identity]
        value = raw["value"]
        values[identity] = ({key: c.decimal_value(v) for key, v in value.items()} if node["shape"] == "series"
                            else c.decimal_value(value)) if node["valueType"] == "decimal" else value
    get = lambda identity: values[identity]
    ev, sponsor = get("entry.enterprise_value"), a.sub(get("entry.enterprise_value"), F(50) if debt else F(0))
    values.update({"transaction.entry_enterprise_value": ev, "transaction.purchase_equity_value": ev,
                   "sources_uses.total_uses": ev, "sources_uses.debt_sources": F(50) if debt else F(0),
                   "sources_uses.sponsor_equity": sponsor, "sources_uses.total_sources": a.add(F(50) if debt else F(0), sponsor, F(0))})
    period_ids = [p["id"] for p in compiled["periods"]]
    zero = {identity: F(0) for identity in period_ids}
    ebitda, revenue = get("operating.ebitda_explicit"), get("operating.revenue_explicit")
    for identity in ("forecast.revenue", "forecast.ebitda", "forecast.ebit", "forecast.unlevered_fcf"):
        values[identity] = dict(revenue if identity == "forecast.revenue" else ebitda)
    for identity in ("forecast.cash_taxes", "forecast.capex", "forecast.nwc", "forecast.change_in_nwc"):
        values[identity] = dict(zero)
    totals = {field: {} for field in inventory.DEBT_FIELDS if field != "effective_rate"}
    cash_ending, levered, diagnostics, cash, opening = {}, {}, [], F(0), F(50) if debt else F(0)
    for period in compiled["periods"]:
        identity, b = period["id"], ebitda[period["id"]]
        year = a.div(F((c.civil(period["endDate"]) - c.civil(period["startDate"])).days + 1), F(365))
        assumed, difference, relative = opening, F(0), F(0)
        for iteration in range(1, 101):
            interest = a.mul(a.div(a.add(opening, assumed), F(2)), F("0.1"), year, F(1)) if debt else F(0)
            before = a.sub(a.sub(a.add(cash, b), interest), F(0))
            sweep = min(a.mul(max(a.sub(before, F(0)), F(0)), F(1) if debt else F(0)), opening)
            ending, ending_cash = a.sub(opening, sweep), a.sub(before, sweep)
            difference = abs(a.sub(ending, assumed)) if debt else F(0)
            relative = a.div(difference, max(abs(ending), abs(assumed), F(1))) if debt else F(0)
            if not debt or difference <= F("1e-8") or relative <= F("1e-12"):
                break
            assumed = ending
        else:
            raise c.Refusal("INDEPENDENT_NATIVE_DEBT_WITNESS", "Actual rounded fixed point did not converge")
        rows = {"opening_principal": opening, "cash_interest": interest, "pik_interest": F(0), "draw": F(0),
                "mandatory_amortization": F(0), "cash_sweep": sweep, "ending_principal": ending}
        for field, value in rows.items():
            totals[field][identity] = value
            if debt:
                values.setdefault("debt.term." + field, {})[identity] = value
        if debt:
            values.setdefault("debt.term.effective_rate", {})[identity] = F("0.1")
        cash_ending[identity], levered[identity] = ending_cash, a.sub(b, interest)
        diagnostics.append({"blockId": "debt_interest_cash_sweep", "periodId": identity, "algorithm": "fixed_point",
                            "iterations": iteration, "converged": True, "absoluteError": a.normalized(difference),
                            "relativeError": a.normalized(relative)})
        cash, opening = ending_cash, ending
    values.update({"debt.total." + field: components for field, components in totals.items()})
    values.update({"cash.ending": cash_ending, "forecast.levered_fcf": levered})
    exit_id = get("exit.period_id")
    metric, exit_debt, exit_cash = ebitda[exit_id], totals["ending_principal"][exit_id], cash_ending[exit_id]
    exit_ev, net = a.mul(metric, F(6)), a.sub(exit_debt, exit_cash)
    equity = a.add(a.sub(exit_ev, exit_debt), exit_cash, F(0))
    proceeds = a.mul(equity, F(1))
    values.update({"exit.metric_value": metric, "exit.enterprise_value": exit_ev, "exit.debt": exit_debt,
                   "exit.cash": exit_cash, "exit.net_debt": net, "exit.equity_value": equity,
                   "returns.sponsor_exit_proceeds": proceeds})
    flows = [{"amount": a.normalized(a.sub(F(0), sponsor)), "date": get("entry.valuation_date"), "type": "initial_investment"}]
    for period in compiled["periods"]:
        flows.append({"amount": a.normalized(proceeds if period["id"] == exit_id else F(0)),
                      "date": period["endDate"], "periodId": period["id"],
                      "type": "exit_distribution" if period["id"] == exit_id else "interim_distribution"})
        if period["id"] == exit_id:
            break
    periodic, p_trace = a.returns(flows, "PERIODIC")
    dated, d_trace = a.returns(flows, "ACT365F_DAILY")
    frequency = {"annual": 1, "quarterly": 4, "monthly": 12}[compiled["model"]["periodDefinition"]["frequency"]]
    values.update({"returns.gross_sponsor_moic": a.div(proceeds, sponsor),
                   "returns.gross_sponsor_irr": a.sub(a.power(a.r(periodic + 1), frequency), F(1)),
                   "returns.gross_sponsor_xirr": dated})
    checks = {line: True for line in inventory.CHECK_CODES}
    checks["sources_uses"] = abs(a.sub(ev, a.add(F(50) if debt else F(0), sponsor, F(0)))) <= F("1e-8")
    checks["debt_roll_forward"] = all(abs(a.sub(a.sub(totals["opening_principal"][p], totals["cash_sweep"][p]),
                                                    totals["ending_principal"][p])) <= F("1e-8") and totals["ending_principal"][p] >= 0 for p in period_ids)
    checks["minimum_cash"] = all(value >= 0 for value in cash_ending.values())
    checks["cash_sweep"] = all(0 <= totals["cash_sweep"][p] <= totals["opening_principal"][p] for p in period_ids)
    checks["exit_bridge"] = abs(a.sub(equity, a.sub(exit_ev, net))) <= F("1e-8")
    checks["sponsor_cash_flows"] = sponsor > 0 and proceeds >= 0
    for line, passed in checks.items():
        values["checkcalc." + line] = passed
        values["check." + line] = passed
    for source in inventory.OUTPUT_SOURCES:
        identity = source.removeprefix("returns.") if source.startswith("returns.") else "output." + source
        values[identity] = values[source]
    c.require(set(values) == set(compiled["nodeById"]), "INDEPENDENT_FULL_NATIVE_WITNESS_REPLAY")
    encoded = {identity: ({key: a.normalized(v) for key, v in value.items()} if isinstance(value, dict)
               else a.normalized(value) if isinstance(value, F) else value) for identity, value in values.items()}
    return encoded, diagnostics, flows, [p_trace, d_trace]


def check_witness(c, raw, snapshot, compiled, encoded, diagnostics, flows, traces):
    c.require(raw["status"] == "SUCCEEDED" and raw["validity"] == "VALID" and "failure" not in raw,
              "ACTUAL_NATIVE_V2_VALID_WITNESS", disposition="INCOMPLETE")
    c.require(raw["engineVersion"] == "finnor-underwriting-engine/1.0.0"
              and raw["modelSemanticHash"] == compiled["semanticHash"] and raw["inputSemanticHash"] == snapshot["semanticHash"]
              and raw["resultSemanticHash"] == c.h({k: v for k, v in raw.items() if k != "resultSemanticHash"}),
              "ACTUAL_NATIVE_V2_RESULT_HASH_IDENTITY")
    c.require(raw.get("returnSolverTraces") == traces, "EXACT_INDEPENDENT_NATIVE_RETURN_TRACES")
    c.require(raw.get("sponsorCashFlows") == flows and raw["solverDiagnostics"] == diagnostics, "EXACT_NATIVE_SOLVER_CASH_FLOW_TRACES")
    c.require(set(raw["values"]) == set(encoded), "EVERY_NATIVE_V2_NODE_REPLAYED")
    for identity, expected in encoded.items():
        node, observed = compiled["nodeById"][identity], raw["values"][identity]
        c.require(observed["nodeId"] == identity and observed["value"] == expected
                  and c.metadata(observed) == c.metadata(node) and ("currency" in observed) == ("currency" in node)
                  and observed["directDependencies"] == node["dependencies"]
                  and observed["truthClass"] == (snapshot["values"][identity]["truthClass"]
                      if node["kind"] == "input" else "DERIVED_VALUE"),
                  "EXACT_INDEPENDENT_NATIVE_NODE_VALUE", identity)
    outputs = {identity for identity, node in compiled["nodeById"].items() if node["kind"] == "output"}
    c.require(set(raw["outputs"]) == outputs and all(raw["outputs"][i] == raw["values"][i] for i in outputs),
              "ALL_33_NATIVE_V2_OUTPUTS")
    checks = {identity for identity, node in compiled["nodeById"].items() if node["kind"] == "check"}
    c.require(len(raw["checks"]) == 10 and {v["nodeId"] for v in raw["checks"]} == checks, "ALL_TEN_NATIVE_V2_CHECKS")
    for observed in raw["checks"]:
        node = compiled["nodeById"][observed["nodeId"]]
        c.require(observed["passed"] is encoded[node["id"]] is True and observed["severity"] == node["severity"]
                  and observed["code"] == node["failureCode"], "ACTUAL_NATIVE_V2_HARD_CHECK_TRUE")


def check(packet, args, receipt, c, inventory):
    c.exact_keys(packet, ("schema", "programme", "reference", "domain", "programmeBindings", "witness",
                         "nativeIdentity", "compiledProgramme", "compiledReference", "nativeWitness", "proof"), "PACKET_SCHEMA")
    c.require(packet["schema"] == "finnor.r6.proof-packet.v1", "PACKET_VERSION")
    c.validate_identity(packet, args, Path(__file__).resolve())
    c.validate_proof(packet)
    pins = {p["path"].removeprefix("finnor-os/packages/underwriting/"): p["sha256"] for p in packet["nativeIdentity"]["sourcePins"]}
    c.require(pins == NATIVE_DIGESTS, "AUDITED_REVISED_NATIVE_SOURCE_CUT")
    c.require(packet["nativeIdentity"]["dependencyLockDigest"] == "sha256:" + LOCK_DIGEST
              and packet["nativeIdentity"]["decimalModuleDigest"] == "sha256:" + DECIMAL_DIGEST, "AUDITED_NATIVE_DEPENDENCY_CUT")
    native_p = {"model": packet["programme"], "compiled": packet["compiledProgramme"], "inventory": packet["reference"]["stateInventory"]}
    native_r = {"model": packet["reference"]["model"], "compiled": packet["compiledReference"], "inventory": packet["reference"]["stateInventory"]}
    try:
        programme = inventory.checked_compiled(native_p, c)
        reference = inventory.checked_compiled(native_r, c)
        inventory.checked_inventory(native_r, reference, c)
    except inventory.Rejection as error:
        raise c.Refusal(error.predicate, error.reason)
    # Complete executable-model equality is stronger than a scalar-output
    # comparison; display key/version may differ, no operation/order can.
    c.require(programme["semanticHash"] == reference["semanticHash"]
              and programme["periods"] == reference["periods"], "FULL_ORDERED_NATIVE_V2_PROGRAM_CONGRUENCE")
    arena = c.Arena()
    p_inputs, r_inputs, cardinality = c.validate_domain(packet, programme, reference, arena)
    receipt["nonemptyDomain"], receipt["domainCardinality"] = True, str(cardinality)
    c.require(p_inputs == r_inputs, "COMPLETE_NATIVE_V2_INPUT_CONGRUENCE")
    debt = checked_profile(c, programme, packet["domain"])
    token = c.h({"nativeIdentity": packet["nativeIdentity"], "semanticModel": programme["semanticHash"],
                 "inputs": p_inputs, "method": METHOD})
    values = {identity: {component: (token, identity, component) for component in
              (["$scalar"] if node["shape"] == "scalar" else [p["id"] for p in programme["periods"]])}
              for identity, node in programme["nodeById"].items()}
    c.validate_money(packet["reference"], programme, reference)
    c.validate_states(packet, programme, reference, values, values)
    receipt["allInputEquivalence"] = True
    a = Arithmetic(c)
    certificate = universal_rules(c, a, programme, debt)
    encoded, diagnostics, flows, traces = concrete_native(c, a, programme, packet["witness"], debt, inventory)
    check_witness(c, packet["nativeWitness"]["programme"], packet["witness"], programme, encoded, diagnostics, flows, traces)
    check_witness(c, packet["nativeWitness"]["reference"], packet["nativeWitness"]["referenceSnapshot"],
                  reference, encoded, diagnostics, flows, traces)
    receipt.update({
        "disposition": "ACCEPTED", "predicate": "ALL_INPUT_NATIVE_LBO_V2_TRANSLATION_AND_VALIDITY",
        "universallyValid": True, "witnessValues": encoded,
        "witnessChecks": [{"nodeId": check["nodeId"], "passed": True} for check in packet["nativeWitness"]["programme"]["checks"]],
        "coverage": {"nativeNodes": 2 * len(values), "financialStates": len(packet["reference"]["stateInventory"]),
                     "periods": len(programme["periods"]), "terms": a.operations + len(arena.terms)},
        "checkedInvariants": [
            "NONEMPTY_UNCHANGED_COMPLETE_NATIVE_INPUT_DOMAIN", "ALL_INPUT_ORDERED_NATIVE_V2_CASH_LIABILITY_CONSTRAINT_EQUIVALENCE",
            "EVERY_110_OR_124_NATIVE_NODE_EVERY_33_OUTPUTS_EVERY_10_CHECKS",
            "NO_OMITTED_LIABILITY_OR_DUPLICATED_DECLARED_CASH_PROJECTION", "EXACT_NATIVE_CALENDAR_AND_SETTLEMENT_TIMING",
            "ALL_PERIOD_FINANCE_NONNEGATIVITY_AND_NORMALIZATION_INVARIANTS",
            "ROUNDED_AVERAGE_BALANCE_FIXED_POINT_CONTRACTION_WITH_ORIGINAL_TOLERANCES",
            "ALL_ORIGINAL_EXIT_BRANCHES_NATIVE_HORNER_SIGN_BRACKETS",
            "BOUNDED_DAILY_ROOT_AND_PERIODIC_DATED_BISECTION_TERMINATION",
            "ACTUAL_NATIVE_V2_NATURAL_POWER_ROOT_HORNER_BISECTION_TRACE_REPLAY",
            "ALL_TEN_NATIVE_HARD_FINANCIAL_CHECKS_TRUE_EVERY_INPUT",
            "NO_FRACTIONAL_POWER_AXIOM_NO_UNAPPROVED_AXIOM_NO_UNRESOLVED_GOAL",
        ],
        "specializedCertificate": certificate, "nativeReturnMethod": METHOD,
        "independentDependencyDigests": {"common": "sha256:" + COMMON_DIGEST, "inventory": "sha256:" + INVENTORY_CHECKER_DIGEST},
        "sampledOrEnumeratedInputsUsedForUniversalProof": False,
    })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--packet", required=True)
    parser.add_argument("--decimal-module", required=True, type=Path)
    args = parser.parse_args()
    started, cpu = time.monotonic(), resource.getrusage(resource.RUSAGE_SELF)
    receipt = {
        "schema": "finnor.r6.independent-check.v1", "disposition": "UNKNOWN", "predicate": "NOT_CHECKED", "reason": None,
        "packetDigest": "", "proofDigest": "", "checkerDigest": "sha256:" + digest(Path(__file__).resolve()),
        "nativeIdentityDigest": "", "allInputEquivalence": False, "universallyValid": False, "nonemptyDomain": False,
        "domainCardinality": None, "checkedInvariants": [],
        "coverage": {"nativeNodes": 0, "financialStates": 0, "periods": 0, "terms": 0},
        "witnessValues": None, "witnessChecks": [], "basis": "INDEPENDENT_ORDERED_TERM_CONGRUENCE_EXACT_FRACTION_ENCLOSURES",
        "qualification": "ORDINARY_DEVELOPMENT_EVIDENCE_NOT_ADMITTED", "physical": None,
    }
    c = None
    try:
        c = independent_module("_r6_v2_fraction_common", "checker.py", COMMON_DIGEST)
        inventory = independent_module("_r6_v2_independent_inventory", "lbo-obligation-checker.py", INVENTORY_CHECKER_DIGEST)
        if args.packet == "-":
            raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        else:
            with Path(args.packet).open("rb") as source:
                raw = source.read(MAX_BYTES + 1)
        c.require(len(raw) <= MAX_BYTES, "PACKET_BYTES")
        packet = json.loads(raw, object_pairs_hook=c.strict_pairs)
        receipt.update({"packetDigest": c.h(packet), "proofDigest": c.h(packet.get("proof")),
                        "nativeIdentityDigest": c.h(packet.get("nativeIdentity"))})
        check(packet, args, receipt, c, inventory)
    except Exception as error:
        if c is not None and isinstance(error, c.Refusal):
            receipt["disposition"], receipt["predicate"], receipt["reason"] = error.disposition, error.predicate, error.reason
        else:
            receipt["predicate"], receipt["reason"] = "CHECKER_FAILURE", type(error).__name__ + ": " + str(error)
    usage = resource.getrusage(resource.RUSAGE_SELF)
    receipt["physical"] = {
        "pid": os.getpid(), "parentPid": os.getppid(), "pythonVersion": platform.python_version(),
        "executable": sys.executable, "executableDigest": "sha256:" + digest(Path(sys.executable).resolve()),
        "platform": platform.platform(), "elapsedMs": round((time.monotonic() - started) * 1000),
        "cpuUserMicros": round((usage.ru_utime - cpu.ru_utime) * 1000000),
        "cpuSystemMicros": round((usage.ru_stime - cpu.ru_stime) * 1000000),
        "maxRssNative": usage.ru_maxrss, "maxRssUnit": "PLATFORM_NATIVE", "aggregateSimultaneousPeakKnown": False, "usd": None,
    }
    print(json.dumps(receipt, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
