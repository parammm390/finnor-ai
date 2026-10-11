// finnor-os/packages/epistemic-runtime/src/source-precedence.ts
import { createHash } from "node:crypto";
function canonicalJson(value) {
  if (value === void 0) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, nested]) => nested !== void 0).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
}
function epistemicHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// finnor-os/packages/epistemic-runtime/src/experiment-numerics.ts
function gcd(a, b) {
  a = a < 0n ? -a : a;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}
var ExperimentRational = class _ExperimentRational {
  n;
  d;
  constructor(n, d = 1n) {
    if (d <= 0n) throw new Error("Invalid rational denominator");
    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }
  static decimal(s) {
    if (typeof s !== "string" || s.length > 32 || !/^\d+(?:\.\d{1,12})?$/.test(s)) throw new Error("Unsupported finite decimal");
    const [w, f = ""] = s.split(".");
    return new _ExperimentRational(BigInt(w + f), 10n ** BigInt(f.length));
  }
  add(b) {
    return new _ExperimentRational(this.n * b.d + b.n * this.d, this.d * b.d);
  }
  sub(b) {
    return new _ExperimentRational(this.n * b.d - b.n * this.d, this.d * b.d);
  }
  mul(b) {
    const g1 = gcd(this.n, b.d), g2 = gcd(b.n, this.d);
    return new _ExperimentRational(this.n / g1 * (b.n / g2), this.d / g2 * (b.d / g1));
  }
  div(b) {
    if (b.n <= 0n) throw new Error("Unsupported zero rational divisor");
    return new _ExperimentRational(this.n * b.d, this.d * b.n);
  }
  pow(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > 24) throw new Error("Unsupported exponent");
    return new _ExperimentRational(this.n ** BigInt(n), this.d ** BigInt(n));
  }
  compare(b) {
    const v = this.n * b.d - b.n * this.d;
    return v === 0n ? 0 : v > 0n ? 1 : -1;
  }
  exact(unit = "probability") {
    const scale = 10n ** 12n, magnitude = this.n < 0n ? -this.n : this.n, truncated = magnitude * scale / this.d;
    const text = truncated.toString().padStart(13, "0");
    const whole = text.slice(0, -12);
    const fraction = text.slice(-12).replace(/0+$/, "");
    return { numerator: this.n.toString(), denominator: this.d.toString(), display: `${this.n < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`, unit };
  }
  /** Accounting inputs are terminating decimals; do not round an actual quantity. */
  decimalString() {
    const scale = 10n ** 12n;
    if (scale % this.d) throw new Error("Nonterminating accounting quantity");
    return this.exact().display;
  }
};
var ER_ZERO = new ExperimentRational(0n);
var ER_ONE = new ExperimentRational(1n);

// finnor-os/packages/epistemic-runtime/src/r2-rational.ts
function r2Quantity(value) {
  if (typeof value !== "string" || value.length > 1025 || !/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:\/[1-9]\d*)?$/.test(value)) throw Error("R2_INVALID_RATIONAL");
  const [top, bottom] = value.split("/");
  if (bottom && top.includes(".")) throw Error("R2_INVALID_RATIONAL");
  let n, d;
  if (bottom) {
    n = BigInt(top);
    d = BigInt(bottom);
  } else {
    const [a, b = ""] = top.split(".");
    d = 10n ** BigInt(b.length);
    n = BigInt(a.replace(/^[+]/, "")) * d + (a.startsWith("-") ? -1n : 1n) * BigInt(b || "0");
  }
  if (n.toString().length > 512 || d.toString().length > 512) throw Error("R2_RATIONAL_PRECISION_LIMIT");
  return new ExperimentRational(n, d);
}
var r2String = (q) => {
  if (q.n.toString().length > 512 || q.d.toString().length > 512) throw Error("R2_RATIONAL_PRECISION_LIMIT");
  return q.d === 1n ? q.n.toString() : `${q.n}/${q.d}`;
};

// finnor-os/packages/epistemic-runtime/src/coalition-programme-search/guards.ts
function requireCoalition(condition, boundary) {
  if (!condition) throw Error("R5_" + boundary);
}

// finnor-os/packages/epistemic-runtime/src/coalition-programme-search/programmes.ts
function atom(feature, members, step) {
  switch (feature.kind) {
    case "CONSTANT":
      return r2Quantity("1");
    case "MEMBER":
      return r2Quantity(members.includes(feature.partyId) ? "1" : "0");
    case "MEMBER_PAIR":
      requireCoalition(feature.parties[0] !== feature.parties[1], "ORIGINAL_DISTINCT_MEMBER_PAIR");
      return r2Quantity(feature.parties.every((party) => members.includes(party)) ? "1" : "0");
    case "TERM":
      requireCoalition(feature.id in step.terms, "ORIGINAL_TERM_BINDING");
      return r2Quantity(step.terms[feature.id]);
    case "GRANT":
      requireCoalition(step.grants[feature.resourceId]?.[feature.date] !== void 0, "ORIGINAL_GRANT_BINDING");
      return r2Quantity(step.grants[feature.resourceId][feature.date]);
  }
}
function evaluate(feature, members, step) {
  return feature.kind === "PRODUCT" ? atom(feature.left, members, step).mul(atom(feature.right, members, step)) : atom(feature, members, step);
}
function reconstructCoalitionProgramme(p, members, steps) {
  requireCoalition(steps.length > 0 && steps.length <= p.grammar.maxSteps, "ORIGINAL_PROGRAMME_LENGTH");
  const ids = p.parties.map((party) => party.id), dates = p.dates.length;
  requireCoalition(new Set(members).size === members.length && members.every((party) => ids.includes(party)), "ORIGINAL_MEMBERSHIP");
  const grossPayoffs = Object.fromEntries(p.worlds.map((world) => [world.id, Object.fromEntries(ids.map((party) => [party, "0"]))]));
  const cashFlows = Object.fromEntries(p.worlds.map((world) => [world.id, Object.fromEntries(ids.map((party) => [party, Array(dates).fill("0")]))]));
  const cashOutflows = Object.fromEntries(p.worlds.map((world) => [world.id, Object.fromEntries(ids.map((party) => [party, Array(dates).fill("0")]))]));
  const resourceUse = Object.fromEntries(p.resources.map((resource) => [resource.id, Array(dates).fill("0")]));
  const items = /* @__PURE__ */ new Set(), exclusive = /* @__PURE__ */ new Set(), consent = /* @__PURE__ */ new Set(), used = [];
  for (const step of steps) {
    const op = p.grammar.operators.find((op2) => op2.id === step.operatorId);
    requireCoalition(op && members.every((party) => op.eligibleParties.includes(party)) && op.requiredParties.every((party) => members.includes(party)) && members.length >= op.minMembers && members.length <= op.maxMembers, "INADMISSIBLE_COALITION_OPERATOR");
    requireCoalition(op.requiresAfter.every((id) => used.includes(id)) && (!used.length || p.grammar.operators.find((op2) => op2.id === used.at(-1)).kind !== "STOP"), "INADMISSIBLE_OPERATOR_ORDER");
    requireCoalition(op.termChoices.some((choice) => epistemicHash(choice) === epistemicHash(step.terms)) && op.grantChoices.some((choice) => epistemicHash(choice) === epistemicHash(step.grants)), "ORIGINAL_GRAMMAR_CHOICE");
    for (const resource of p.resources)
      for (let date = 0; date < dates; date++)
        resourceUse[resource.id][date] = r2String(r2Quantity(resourceUse[resource.id][date]).add(r2Quantity(step.grants[resource.id][date])));
    for (const { cost, equations } of [{ cost: false, equations: op.equations }, { cost: true, equations: op.costs }])
      for (const equation of equations) {
        let active = false;
        for (const world of p.worlds) {
          const value = equation.terms.reduce((value2, term) => value2.add(r2Quantity(world.coefficients[term.coefficientId]).mul(evaluate(term.feature, members, step))), r2Quantity("0"));
          requireCoalition(members.includes(equation.ownerPartyId) || value.n === 0n, "UNSUPPORTED_NONMEMBER_PAYOFF");
          requireCoalition(!cost || value.n >= 0n, "ORIGINAL_NONNEGATIVE_COST");
          const signed = cost || equation.kind === "LIABILITY" ? r2Quantity("0").sub(value) : value;
          grossPayoffs[world.id][equation.ownerPartyId] = r2String(
            r2Quantity(grossPayoffs[world.id][equation.ownerPartyId]).add(signed.mul(r2Quantity(p.discountFactors[equation.date])))
          );
          if (equation.kind === "CASH")
            cashFlows[world.id][equation.ownerPartyId][equation.date] = r2String(
              r2Quantity(cashFlows[world.id][equation.ownerPartyId][equation.date]).add(signed)
            );
          if (equation.kind === "CASH" && signed.n < 0n)
            cashOutflows[world.id][equation.ownerPartyId][equation.date] = r2String(
              r2Quantity(cashOutflows[world.id][equation.ownerPartyId][equation.date]).sub(signed)
            );
          active ||= value.n !== 0n;
        }
        if (active) {
          requireCoalition(!items.has(equation.itemId), "DUPLICATE_CANONICAL_ECONOMIC_ITEM");
          items.add(equation.itemId);
        }
      }
    op.exclusiveItems.forEach((item) => exclusive.add(item));
    op.consentRequired.forEach((party) => consent.add(party));
    used.push(op.id);
  }
  return {
    id: "option:" + epistemicHash({ members, steps }),
    members,
    steps,
    itemIds: [...items].sort(),
    exclusiveItems: [...exclusive].sort(),
    requiredConsents: [...consent].sort(),
    grossPayoffs,
    cashFlows,
    cashOutflows,
    resourceUse
  };
}
function constructCoalitionFamily(p, checkpoint2) {
  const result = { options: [], complete: true, unresolved: [], rejected: [], partitions: [] };
  const ids = p.parties.map((party) => party.id), seen = /* @__PURE__ */ new Set();
  const visit = (members, steps) => {
    checkpoint2();
    if (steps.length) {
      let option;
      try {
        option = reconstructCoalitionProgramme(p, members, steps);
      } catch (error) {
        const predicate = error instanceof Error ? error.message : "R5_UNSUPPORTED_ORIGINAL_PROGRAMME";
        if (!["R5_INADMISSIBLE_COALITION_OPERATOR", "R5_INADMISSIBLE_OPERATOR_ORDER", "R5_DUPLICATE_CANONICAL_ECONOMIC_ITEM"].includes(predicate))
          throw error;
        result.rejected.push({ members, stepsDigest: epistemicHash(steps), predicate });
        return;
      }
      if (!seen.has(option.id)) {
        requireCoalition(result.options.length < p.limits.maxProgrammeOptions, "ORIGINAL_FAMILY_GENERATION_CAP");
        seen.add(option.id);
        result.options.push(option);
      }
    }
    if (steps.length === p.grammar.maxSteps) return;
    for (const op of p.grammar.operators) {
      if (steps.length && p.grammar.operators.find((op2) => op2.id === steps.at(-1).operatorId).kind === "STOP") break;
      for (const terms of op.termChoices)
        for (const grants of op.grantChoices)
          visit(members, [...steps, { operatorId: op.id, terms, grants }]);
    }
  };
  try {
    for (let mask = 1; mask < 1 << ids.length; mask++)
      visit(ids.filter((_, i) => mask & 1 << i), []);
  } catch (error) {
    const predicate = error instanceof Error ? error.message : "R5_ORIGINAL_FAMILY_UNRESOLVED";
    if (!["R5_ORIGINAL_FAMILY_GENERATION_CAP", "R5_ORIGINAL_DEADLINE_EXHAUSTED"].includes(predicate)) throw error;
    result.complete = false;
    result.unresolved.push(predicate);
  }
  const counts = /* @__PURE__ */ new Map();
  for (const option of result.options) {
    const key = epistemicHash(option.members);
    counts.set(key, (counts.get(key) ?? 0n) + 1n);
  }
  const blocks = [];
  const partition = (index) => {
    checkpoint2();
    if (index === ids.length) {
      const originalBlocks = blocks.map((block) => [...block]);
      const combinations = originalBlocks.reduce((product, block) => product * (counts.get(epistemicHash(block)) ?? 0n), 1n);
      result.partitions.push({
        id: "partition:" + epistemicHash(originalBlocks),
        blocks: originalBlocks,
        programmeCombinations: combinations.toString(),
        disposition: !result.complete ? "UNRESOLVED" : combinations === 0n ? "NO_ADMITTED_LOCAL_PROGRAMME" : "COMPLETE_JOINT_ENCODING"
      });
      return;
    }
    for (const block of blocks) {
      block.push(ids[index]);
      partition(index + 1);
      block.pop();
    }
    blocks.push([ids[index]]);
    partition(index + 1);
    blocks.pop();
  };
  try {
    partition(0);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "R5_ORIGINAL_DEADLINE_EXHAUSTED") throw error;
    result.complete = false;
    result.unresolved.push("ORIGINAL_PARTITION_INDEX_UNVISITED");
    result.partitions.forEach((partition2) => {
      partition2.disposition = "UNRESOLVED";
    });
  }
  return result;
}

// finnor-os/packages/epistemic-runtime/src/coalition-programme-search/selected-programme.ts
function compileSelectedCoalitionProgramme(original2, candidate2, selectionRef2) {
  requireCoalition(candidate2.originalDigest === epistemicHash(original2), "SELECTED_ORIGINAL_PREIMAGE");
  requireCoalition(selectionRef2.owner === "S4" && selectionRef2.version === original2.version, "SELECTED_S4_OWNER");
  const programmes = candidate2.selectedOptionIds.map((id) => {
    const option = candidate2.programmeOptions.find((option2) => option2.id === id);
    requireCoalition(option, "SELECTED_ORIGINAL_OPTION");
    return option;
  });
  requireCoalition(
    programmes.length <= original2.parties.length && programmes.every((option) => option.steps.length <= original2.grammar.maxSteps),
    "SELECTED_PROGRAMME_STEP_BOUND"
  );
  return {
    schema: "finnor.p1.coalition-owner-programme.v1",
    originalDigest: candidate2.originalDigest,
    candidateDigest: epistemicHash(candidate2),
    selectionRef: selectionRef2,
    programmes,
    division: candidate2.division,
    stages: ["READ_S4_SELECTION", "RESERVE_SINGLE_S5", "INTEND_SINGLE_S5_CONSUMPTION", "PROPOSE_S6_SCHEDULE", "STOP_UNADMITTED_EFFECT"],
    quantityEncoding: "ORIGINAL_CANONICAL_RATIONAL_STRINGS",
    qualification: "ORDINARY_SELECTED_OWNER_PLANNING_NOT_BUSINESS_EXECUTION",
    executionAuthorityGranted: false
  };
}

// finnor-os/packages/epistemic-runtime/src/coalition-programme-search/programme-child.ts
var chunks = [];
var size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 8388608) throw Error("R5_ORIGINAL_INPUT_BYTE_CAP");
  chunks.push(chunk);
}
var request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (request.histories.length !== 1) throw Error("R5_ONE_ORIGINAL_COMPILATION_REQUIRED");
var { original, deadlineAt, candidate, selectionRef } = request.histories[0];
var checkpoint = () => {
  if (Date.now() >= deadlineAt) throw Error("R5_ORIGINAL_DEADLINE_EXHAUSTED");
};
checkpoint();
var output = candidate && selectionRef ? compileSelectedCoalitionProgramme(original, candidate, selectionRef) : constructCoalitionFamily(original, checkpoint);
checkpoint();
process.stdout.write(JSON.stringify(output));
