import type { ExperimentCandidate, ExperimentExact, ExperimentDesignRequest, ExperimentMetrics } from "@finnor/shared-types";

/** Small exact arithmetic adapter, deliberately not a general inference library.
 * Input decimal support and state cardinality are enforced by the producer. */
function gcd(a: bigint, b: bigint): bigint { a = a < 0n ? -a : a; while (b) { const t = a % b; a = b; b = t; } return a; }
export class ExperimentRational {
  readonly n: bigint; readonly d: bigint;
  constructor(n: bigint, d = 1n) { if (d <= 0n) throw new Error("Invalid rational denominator"); const g = gcd(n, d); this.n = n / g; this.d = d / g; }
  static decimal(s: string): ExperimentRational {
    if (typeof s !== "string" || s.length > 32 || !/^\d+(?:\.\d{1,12})?$/.test(s)) throw new Error("Unsupported finite decimal");
    const [w, f = ""] = s.split("."); return new ExperimentRational(BigInt(w! + f), 10n ** BigInt(f.length));
  }
  add(b: ExperimentRational): ExperimentRational { return new ExperimentRational(this.n * b.d + b.n * this.d, this.d * b.d); }
  sub(b: ExperimentRational): ExperimentRational { return new ExperimentRational(this.n * b.d - b.n * this.d, this.d * b.d); }
  mul(b: ExperimentRational): ExperimentRational {
    const g1 = gcd(this.n, b.d), g2 = gcd(b.n, this.d); return new ExperimentRational((this.n / g1) * (b.n / g2), (this.d / g2) * (b.d / g1));
  }
  div(b: ExperimentRational): ExperimentRational { if (b.n <= 0n) throw new Error("Unsupported zero rational divisor"); return new ExperimentRational(this.n * b.d, this.d * b.n); }
  pow(n: number): ExperimentRational { if (!Number.isSafeInteger(n) || n < 0 || n > 24) throw new Error("Unsupported exponent"); return new ExperimentRational(this.n ** BigInt(n), this.d ** BigInt(n)); }
  compare(b: ExperimentRational): number { const v = this.n * b.d - b.n * this.d; return v === 0n ? 0 : v > 0n ? 1 : -1; }
  exact(unit = "probability"): ExperimentExact {
    const scale = 10n ** 12n, magnitude = this.n < 0n ? -this.n : this.n, truncated = magnitude * scale / this.d;
    const text = truncated.toString().padStart(13, "0"); const whole = text.slice(0, -12); const fraction = text.slice(-12).replace(/0+$/, "");
    return { numerator: this.n.toString(), denominator: this.d.toString(), display: `${this.n < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`, unit };
  }
  /** Accounting inputs are terminating decimals; do not round an actual quantity. */
  decimalString(): string {
    const scale = 10n ** 12n; if (scale % this.d) throw new Error("Nonterminating accounting quantity"); return this.exact().display;
  }
}
export const ER_ZERO = new ExperimentRational(0n), ER_ONE = new ExperimentRational(1n);
export const sumRationals = (a: ExperimentRational[]) => a.reduce((x, y) => x.add(y), ER_ZERO);
const minimum = (a: ExperimentRational[]) => a.reduce((x, y) => x.compare(y) <= 0 ? x : y);
const factorial = (n: number) => { let f = 1n; for (let i = 2; i <= n; i++) f *= BigInt(i); return f; };
function countVectors(total: number, size: number, prefix: number[] = []): number[][] {
  if (size === 1) return [[...prefix, total]]; const result: number[][] = [];
  for (let i = 0; i <= total; i++) result.push(...countVectors(total - i, size - 1, [...prefix, i])); return result;
}
function likelihoods(law: ExperimentRational[][], counts: number[]): ExperimentRational[] {
  return law.map(row => row.reduce((p, q, k) => p.mul(q.pow(counts[k]!)), ER_ONE));
}
export function registeredStatisticalStop(candidate: ExperimentCandidate, counts: number[], hypotheses: number): "CONTINUE" | "REJECT_H0" | "REJECT_H1" | "SAMPLE_LIMIT" {
  const size = counts.reduce((a, b) => a + b, 0);
  if (candidate.likelihood.status !== "SUPPLIED_CONDITIONAL") throw new Error("Unknown likelihood");
  if (hypotheses === 2 && (candidate.stopping.method === "ANYTIME_LR" || size === candidate.samples)) {
    const p = likelihoods(candidate.likelihood.probabilities.map(row => row.map(ExperimentRational.decimal)), counts);
    if (p[1]!.n > 0n && p[1]!.mul(ExperimentRational.decimal(candidate.stopping.alpha)).compare(p[0]!) >= 0) return "REJECT_H0";
    if (p[0]!.n > 0n && p[0]!.mul(ExperimentRational.decimal(candidate.stopping.beta)).compare(p[1]!) >= 0) return "REJECT_H1";
  }
  return size === candidate.samples ? "SAMPLE_LIMIT" : "CONTINUE";
}
export function conditionalMeasurementAnalysis(input: { hypotheses: ExperimentDesignRequest["hypotheses"]; decisionContext: ExperimentDesignRequest["decisionContext"]; candidate: ExperimentCandidate }, counts: number[]) {
  if (input.candidate.likelihood.status !== "SUPPLIED_CONDITIONAL") throw new Error("Unknown likelihood");
  const law = input.candidate.likelihood.probabilities.map(row => row.map(ExperimentRational.decimal));
  const weighted = likelihoods(law, counts).map((p, h) => p.mul(ExperimentRational.decimal(input.hypotheses[h]!.prior)));
  const mass = sumRationals(weighted); if (!mass.n) return null;
  const posterior = weighted.map(p => p.div(mass));
  const losses = input.decisionContext.actionIds.map((_, a) => sumRationals(posterior.map((p, h) => p.mul(ExperimentRational.decimal(input.decisionContext.lossByHypothesis[h]![a]!)))));
  return { posteriorByHypothesis: posterior.map(p => p.exact()), conditionalLossByAction: losses.map(p => p.exact(input.decisionContext.lossUnit)) };
}

/** Exhaustive finite design certificate. Sequential multiplicities count only
 * prefixes that have not already stopped; fixed multinomial coefficients cannot
 * be used to compute an optional stopping distribution. */
export function exactExperimentMetrics(request: ExperimentDesignRequest, candidate: ExperimentCandidate): ExperimentMetrics {
  if (candidate.likelihood.status !== "SUPPLIED_CONDITIONAL") throw new Error("Unknown likelihood");
  const h = request.hypotheses.length, k = candidate.endpoint.categories.length, n = candidate.samples;
  const law = candidate.likelihood.probabilities.map(row => row.map(ExperimentRational.decimal));
  const priors = request.hypotheses.map(row => ExperimentRational.decimal(row.prior));
  const losses = request.decisionContext.lossByHypothesis.map(row => row.map(ExperimentRational.decimal));
  const baseline = minimum(request.decisionContext.actionIds.map((_, a) => sumRationals(priors.map((p, hi) => p.mul(losses[hi]![a]!)))));
  const terminal: Array<{ counts: number[]; ways: bigint; stop: string }> = [];
  if (candidate.stopping.method === "FIXED_SAMPLE") {
    for (const counts of countVectors(n, k)) terminal.push({ counts, ways: factorial(n) / counts.reduce((v, c) => v * factorial(c), 1n), stop: registeredStatisticalStop(candidate, counts, h) });
  } else {
    let live = new Map<string, { counts: number[]; ways: bigint }>([[Array(k).fill(0).join(","), { counts: Array(k).fill(0), ways: 1n }]]);
    for (let size = 1; size <= n; size++) {
      const next = new Map<string, { counts: number[]; ways: bigint }>();
      for (const prefix of live.values()) for (let outcome = 0; outcome < k; outcome++) {
        const counts = [...prefix.counts]; counts[outcome]!++;
        const key = counts.join(","); const existing = next.get(key); if (existing) existing.ways += prefix.ways; else next.set(key, { counts, ways: prefix.ways });
      }
      live = new Map();
      for (const [key, state] of next) {
        if (likelihoods(law, state.counts).every(p => p.n === 0n)) continue;
        const stop = registeredStatisticalStop(candidate, state.counts, h);
        if (stop === "CONTINUE") live.set(key, state); else terminal.push({ ...state, stop });
      }
    }
  }
  let risk = ER_ZERO, expectedN = ER_ZERO;
  const mass = Array<ExperimentRational>(h).fill(ER_ZERO), reject0 = [...mass], reject1 = [...mass], inconclusive = [...mass];
  const observations: ExperimentMetrics["observations"] = [];
  for (const state of terminal) {
    const probability = likelihoods(law, state.counts).map(p => p.mul(new ExperimentRational(state.ways)));
    const joint = probability.map((p, hi) => p.mul(priors[hi]!)); const marginal = sumRationals(joint); if (marginal.n === 0n) continue;
    const conditionalLoss = request.decisionContext.actionIds.map((_, a) => sumRationals(joint.map((p, hi) => p.mul(losses[hi]![a]!))));
    risk = risk.add(minimum(conditionalLoss)); const size = state.counts.reduce((a, b) => a + b, 0); expectedN = expectedN.add(marginal.mul(new ExperimentRational(BigInt(size))));
    const bucket = state.stop === "REJECT_H0" ? reject0 : state.stop === "REJECT_H1" ? reject1 : inconclusive;
    for (let hi = 0; hi < h; hi++) { mass[hi] = mass[hi]!.add(probability[hi]!); bucket[hi] = bucket[hi]!.add(probability[hi]!); }
    observations.push({ counts: state.counts, sampleSize: size, stop: state.stop, sequenceMultiplicity: state.ways.toString() });
  }
  if (mass.some(p => p.compare(ER_ONE) !== 0) || risk.compare(baseline) > 0) throw new Error("Finite design invariant failed");
  return { basis: "EXACT_SUPPLIED_FINITE_MODEL", empiricallyCalibrated: false, baselineRisk: baseline.exact(request.decisionContext.lossUnit), terminalRisk: risk.exact(request.decisionContext.lossUnit),
    riskReduction: baseline.sub(risk).exact(request.decisionContext.lossUnit), expectedSamples: expectedN.exact("measurement-units"),
    massByHypothesis: mass.map(p => p.exact()), rejectH0ByHypothesis: reject0.map(p => p.exact()), rejectH1ByHypothesis: reject1.map(p => p.exact()), inconclusiveByHypothesis: inconclusive.map(p => p.exact()),
    criterion: "SUPPLIED_TERMINAL_BAYES_LOSS", discrimination: { method: h === 2 ? "TWO_SIMPLE_LR" : "NOT_REGISTERED_FOR_COMPOSITE", alpha: candidate.stopping.alpha, beta: candidate.stopping.beta,
      threshold: h === 2 ? "LR_GE_1_OVER_ALPHA_OR_RECIPROCAL_GE_1_OVER_BETA" : null, optionalStoppingValid: candidate.stopping.method === "ANYTIME_LR", multiplicityScope: "ONE_REGISTERED_ENDPOINT_ONE_PROTOCOL" },
    numerical: { arithmetic: "BIGINT_RATIONAL", displayAbsoluteErrorBound: "0.000000000001", approximation: "NONE_FOR_RATIONAL_TOTALS", states: observations.length }, distributionEncoding: "EXACT_COUNTS_AND_SURVIVING_PATH_MULTIPLICITY", observations,
    limitations: ["SUPPLIED_LIKELIHOOD_AND_PRIOR_ARE_ASSUMPTIONS_NOT_S1_POSTERIOR", "NO_FIELD_CALIBRATION_OR_CAUSAL_IDENTIFICATION", "TERMINAL_LOSS_REFERENCE_IS_NOT_S4_POLICY", "COSTS_AND_CONTINUATION_VALUE_NOT_SUBTRACTED_FROM_INFORMATION_SCORE",
      "DESIGN_OPTIMUM_ONLY_AMONG_SUPPLIED_FEASIBLE_CANDIDATES", "NO_EMPIRICAL_TRANSPORT_OR_NUISANCE_ESTIMATION", "NO_CROSS_PROTOCOL_OR_MULTIPLE_ENDPOINT_ERROR_GUARANTEE", ...(h > 2 ? ["NO_REGISTERED_COMPOSITE_POWER_TEST"] : ["CONSERVATIVE_LR_CRITERION_NOT_MOST_POWERFUL_FIXED_SAMPLE_TEST"])] };
}
