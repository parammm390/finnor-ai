"""Independent public arithmetic reference. No P1/P6 AST/compiler imports."""
import json
import sys
from fractions import Fraction


def exact(value):
    numerator, denominator = value.numerator, value.denominator
    exponent = 0
    while denominator % 2 == 0:
        denominator //= 2
        exponent += 1
    fives = 0
    while denominator % 5 == 0:
        denominator //= 5
        fives += 1
    if denominator != 1:
        return {"status": "NON_TERMINATING"}
    scale = max(exponent, fives)
    number = numerator * (2 ** (scale - exponent)) * (5 ** (scale - fives))
    negative = number < 0
    digits = str(abs(number)).rjust(scale + 1, "0")
    text = digits if scale == 0 else digits[:-scale] + "." + digits[-scale:]
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return {"status": "EXACT", "value": ("-" if negative else "") + text}


cases = json.load(open(sys.argv[1], encoding="utf-8"))
results = []
for case in cases:
    p, d, e, f, liability = [Fraction(case[key]) for key in
                           ["price", "debt", "ebitda", "fee", "liability"]]
    if e == 0:
        results.append({"id": case["id"], "status": "ZERO_DENOMINATOR"})
        continue
    results.append({
        "id": case["id"], "status": "EXACT",
        "equity": exact(p - d - f - liability),
        "leverage": exact((d + f) / e),
        "qualification": "INDEPENDENT_FRACTION_ARITHMETIC_NOT_BUSINESS_TRUTH",
    })
print(json.dumps(results, indent=2))
