import { z } from "zod";

const Source = z.object({ id: z.string(), label: z.string(), quote: z.string(), literal: z.string() }).strict();
const Calculation = z.object({
  id: z.string(), label: z.string(), formula: z.string(), inputRefs: z.array(z.string()),
  value: z.object({ numerator: z.string().regex(/^-?\d+$/), denominator: z.string().regex(/^[1-9]\d*$/), unit: z.string(), formatted: z.string() }).strict(),
}).strict();
const Base = z.object({
  version: z.literal(1), title: z.string(), basis: z.literal("ARITHMETIC_ONLY_CONDITIONAL_ON_SUPPLIED_INPUTS"),
  sources: z.array(Source), assumptions: z.array(z.string()), gaps: z.array(z.string()),
}).strict();

export const FinancialExplanationSchema = z.discriminatedUnion("status", [
  Base.extend({ status: z.literal("checked"), calculations: z.array(Calculation).min(1) }).strict(),
  Base.extend({ status: z.literal("incomplete"), calculations: z.tuple([]), gaps: z.array(z.string()).min(1) }).strict(),
]);
export type FinancialExplanation = z.infer<typeof FinancialExplanationSchema>;
