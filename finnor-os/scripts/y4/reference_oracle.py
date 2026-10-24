"""Authorized verification-administrator oracle. Never imported by product code."""
from fractions import Fraction


def evaluate(expression, inputs):
    kind = expression["kind"]
    if kind == "input":
        return Fraction(inputs[expression["key"]])
    if kind == "literal":
        return Fraction(expression["value"])
    if kind == "if":
        c = expression["condition"]
        a, b = evaluate(c["left"], inputs), evaluate(c["right"], inputs)
        choice = {"lt": a < b, "lte": a <= b, "eq": a == b, "gte": a >= b, "gt": a > b}[c["comparison"]]
        return evaluate(expression["whenTrue"] if choice else expression["whenFalse"], inputs)
    a, b = evaluate(expression["left"], inputs), evaluate(expression["right"], inputs)
    if kind == "add":
        return a + b
    if kind == "subtract":
        return a - b
    if kind == "multiply":
        return a * b
    if kind == "min":
        return min(a, b)
    if kind == "max":
        return max(a, b)
    if kind == "ratio":
        if not b:
            raise ValueError("ZERO_DENOMINATOR")
        value = a / b
        if (value * 10 ** 18).denominator != 1:
            raise ValueError("NON_TERMINATING_RATIO_AT_DECLARED_PRECISION")
        return value
    raise ValueError("UNSUPPORTED_NATIVE_EXPRESSION")
