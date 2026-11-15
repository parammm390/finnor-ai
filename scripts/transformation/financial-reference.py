"""Independent exact expectations. Does not import FINNOR arithmetic or producer output."""
from fractions import Fraction as Q
import json

cases = {
    "fin01": [Q(20_000_000)*8, Q(20_000_000)*8-60_000_000, Q(20_000_000)*8-60_000_000+5_000_000,
              Q(18_000_000)*8, Q(18_000_000)*8-60_000_000, Q(18_000_000)*8-60_000_000+5_000_000, (Q(20_000_000)-18_000_000)*8],
    "fractional": [Q("0.1")*1_000_000*3, Q("0.1")*1_000_000*3-Q("0.4")*1_000_000],
    "margin": [Q("1.25")*1_000_000*Q("12.5")/100, Q(625_000)/(Q("1.25")*1_000_000*Q("12.5")/100)],
    "recurring": [Q(1)/3],
    "total": [Q("1.1")+Q("2.2")],
}
print(json.dumps({name: [{"numerator": str(v.numerator), "denominator": str(v.denominator)} for v in values] for name, values in cases.items()}, indent=2))
