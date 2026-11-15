import { z } from "zod";
import { ExperimentRational } from "@finnor/epistemic-runtime";
import type { FinancialExplanation } from "@finnor/shared-types";

const Id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const FinancialCalculationProposalSchema = z.object({
  status: z.enum(["ready", "needs_inputs"]), title: z.string().trim().min(1).max(200),
  inputs: z.array(z.object({ id: Id, label: z.string().min(1).max(160), quote: z.string().min(1).max(1000), literal: z.string().min(1).max(100) }).strict()).max(48),
  steps: z.array(z.object({ id: Id, label: z.string().min(1).max(160), op: z.enum(["add", "subtract", "multiply", "divide"]), left: Id, right: Id }).strict()).max(64),
  outputs: z.array(Id).max(32), assumptions: z.array(z.string().min(1).max(1000)).max(12), gaps: z.array(z.string().min(1).max(600)).max(12),
}).strict();

type Quantity = { amount: ExperimentRational; unit: string; label: string; inputRefs: string[]; formula: string };
const currencies = "USD|EUR|GBP|INR|JPY|CAD|AUD|CHF|SGD|HKD|CNY|AED";
const literalPattern = new RegExp(`^(?:(${currencies})\\s+|([€£])\\s*)?([+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,12})?)(?:\\s*(thousand|million|billion|bn|k|m|%|bps|x))?$`, "i");

function sourceAmount(input: { literal: string; quote: string }, instruction: string) {
  if (!instruction.includes(input.quote)) throw new Error("INPUT_NOT_SOURCED");
  let complete = false;
  for (let quoteAt = instruction.indexOf(input.quote); quoteAt >= 0 && !complete; quoteAt = instruction.indexOf(input.quote, quoteAt + 1)) {
    for (let literalAt = input.quote.indexOf(input.literal); literalAt >= 0; literalAt = input.quote.indexOf(input.literal, literalAt + 1)) {
      const start = quoteAt + literalAt, before = instruction.slice(0, start), after = instruction.slice(start + input.literal.length);
      if (!/[\p{L}\p{N}.,+−-]$/u.test(before) && !/^[\p{L}\p{N}%]/u.test(after) && !/^[.,]\d/.test(after)
        && !new RegExp(`(?:${currencies}|[$€£])\\s*$`, "i").test(before)
        && !new RegExp(`^\\s*(?:${currencies})\\b`, "i").test(after)
        && !/^\s*(?:[$€£]|percent(?:age)?\b|per\s+cent\b|pct\b|basis\s+points?\b|dollars?\b|euros?\b|pounds?\b|rupees?\b|yen\b|yuan\b|francs?\b|dirhams?\b)/i.test(after)
        && !/^\s*(?:thousand|million|billion|bn\b|k\b|m\b|%|bps\b|x\b)/i.test(after)) { complete = true; break; }
    }
  }
  if (!complete) throw new Error("INCOMPLETE_QUANTITY");
  const match = literalPattern.exec(input.literal.trim());
  if (!match) throw new Error("UNSUPPORTED_QUANTITY");
  const text = match[3]!.replaceAll(",", ""), negative = text.startsWith("-");
  const magnitude = ExperimentRational.decimal(text.replace(/^[+-]/, ""));
  const unit = match[1]?.toUpperCase() ?? (match[2] === "€" ? "EUR" : match[2] === "£" ? "GBP" : "scalar");
  const suffix = match[4]?.toLowerCase();
  if (unit !== "scalar" && ["%", "bps", "x"].includes(suffix ?? "")) throw new Error("UNSUPPORTED_QUANTITY");
  const factor = ["million", "m"].includes(suffix ?? "") ? 1000000n : ["billion", "bn"].includes(suffix ?? "") ? 1000000000n : ["thousand", "k"].includes(suffix ?? "") ? 1000n : 1n;
  const denominator = suffix === "%" ? 100n : suffix === "bps" ? 10000n : 1n;
  return { amount: magnitude.mul(new ExperimentRational(negative ? -factor : factor, denominator)), unit };
}

function combine(op: "add" | "subtract" | "multiply" | "divide", left: Quantity, right: Quantity) {
  let unit: string, amount: ExperimentRational;
  if (op === "add" || op === "subtract") {
    if (left.unit !== right.unit) throw new Error("INCOMPATIBLE_UNITS");
    unit = left.unit; amount = op === "add" ? left.amount.add(right.amount) : left.amount.sub(right.amount);
  } else if (op === "multiply") {
    if (left.unit !== "scalar" && right.unit !== "scalar") throw new Error("UNSUPPORTED_DIMENSION");
    unit = left.unit === "scalar" ? right.unit : left.unit; amount = left.amount.mul(right.amount);
  } else {
    if (right.amount.n === 0n) throw new Error("ZERO_DIVISOR");
    if (right.unit !== "scalar" && right.unit !== left.unit) throw new Error("INCOMPATIBLE_UNITS");
    unit = right.unit === "scalar" ? left.unit : "scalar";
    const sign = right.amount.n < 0n ? -1n : 1n;
    amount = new ExperimentRational(left.amount.n * right.amount.d * sign, left.amount.d * right.amount.n * sign);
  }
  if (amount.n.toString().length > 256 || amount.d.toString().length > 256) throw new Error("ARITHMETIC_BOUND");
  return { amount, unit };
}

const failureMessages: Record<string, string> = {
  INPUT_NOT_SOURCED: "A proposed input was not present in the supplied text.",
  INCOMPLETE_QUANTITY: "A proposed input omitted part of its number, currency or scale.",
  UNSUPPORTED_QUANTITY: "A supplied quantity could not be parsed without guessing its units or precision.",
  INCOMPATIBLE_UNITS: "The proposed formula mixes incompatible currencies or units.",
  UNSUPPORTED_DIMENSION: "The proposed formula has a dimension this calculation does not support.",
  ZERO_DIVISOR: "The proposed calculation divides by zero.",
  ARITHMETIC_BOUND: "The proposed calculation exceeds the supported exact arithmetic bound.",
  INVALID_DEPENDENCY: "The proposed formula has a duplicate, missing or forward reference.",
  UNSOURCED_ASSUMPTION: "A proposed assumption was not explicitly supplied.",
  NO_OUTPUT: "The proposed calculation did not identify a result to deliver.",
};

export function incompleteFinancialExplanation(reason: string): FinancialExplanation {
  return { version: 1, status: "incomplete", title: "Calculation needs clarification", basis: "ARITHMETIC_ONLY_CONDITIONAL_ON_SUPPLIED_INPUTS",
    calculations: [], sources: [], assumptions: [], gaps: [failureMessages[reason] ?? "The proposed calculation could not be checked. Please clarify the required inputs and formula."] };
}

/** Checks extraction and arithmetic, not whether a financial interpretation or source assertion is true. */
export function checkFinancialExplanation(instruction: string, proposed: unknown): FinancialExplanation {
  try {
    const plan = FinancialCalculationProposalSchema.parse(proposed);
    if (plan.status === "needs_inputs") return { ...incompleteFinancialExplanation("NO_OUTPUT"), title: plan.title, gaps: plan.gaps.length ? plan.gaps : ["Required inputs are missing."] };
    if (!plan.outputs.length || plan.gaps.length) throw new Error("NO_OUTPUT");
    const values = new Map<string, Quantity>();
    for (const input of plan.inputs) {
      if (values.has(input.id)) throw new Error("INVALID_DEPENDENCY");
      values.set(input.id, { ...sourceAmount(input, instruction), label: input.label, inputRefs: [input.id], formula: input.literal });
    }
    for (const step of plan.steps) {
      const left = values.get(step.left), right = values.get(step.right);
      if (values.has(step.id) || !left || !right) throw new Error("INVALID_DEPENDENCY");
      values.set(step.id, { ...combine(step.op, left, right), label: step.label,
        inputRefs: [...new Set([...left.inputRefs, ...right.inputRefs])],
        formula: `${left.label} ${{ add: "+", subtract: "−", multiply: "×", divide: "÷" }[step.op]} ${right.label}` });
    }
    if (plan.assumptions.some(quote => !instruction.includes(quote))) throw new Error("UNSOURCED_ASSUMPTION");
    if (new Set(plan.outputs).size !== plan.outputs.length) throw new Error("INVALID_DEPENDENCY");
    const calculations = plan.outputs.map(id => {
      const value = values.get(id); if (!value) throw new Error("INVALID_DEPENDENCY");
      let number: string;
      try { const [whole, fraction] = value.amount.decimalString().split("."); number = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : ""); }
      catch { number = `${value.amount.n}/${value.amount.d}`; }
      return { id, label: value.label, formula: value.formula, inputRefs: value.inputRefs,
        value: { numerator: value.amount.n.toString(), denominator: value.amount.d.toString(), unit: value.unit, formatted: value.unit === "scalar" ? number : `${value.unit} ${number}` } };
    });
    return { version: 1, status: "checked", title: plan.title, basis: "ARITHMETIC_ONLY_CONDITIONAL_ON_SUPPLIED_INPUTS", calculations,
      sources: plan.inputs, assumptions: plan.assumptions, gaps: [] };
  } catch (error) { return incompleteFinancialExplanation(error instanceof Error ? error.message : "INVALID_PROPOSAL"); }
}
