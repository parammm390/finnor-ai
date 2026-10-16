import { createHash } from "node:crypto";
import { ClosingSpecSchema, type ClosingGraph, type ClosingSpec } from "@finnor/shared-types";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export const closingDigest = (value: unknown): string =>
  createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
export const closingCanonical = canonical;

/** Compilation is a proposal. The independent owner reconstructs the original
 * requirements without importing this module or trusting its completeness bit. */
export function compileClosingGraph(value: unknown): ClosingGraph {
  const spec: ClosingSpec = ClosingSpecSchema.parse(value);
  const classes = [
    ["documents", spec.documents], ["conditions", spec.conditions],
    ["fundsFlows", spec.fundsFlows], ["rightsTransfers", spec.rightsTransfers],
    ["legalEffectiveness", spec.legalEffectiveness], ["funding", spec.funding],
    ["beneficiaries", spec.beneficiaries],
  ] as const;
  const requirementKeys = new Set(classes.flatMap(([, entries]) => entries.map(r => r.key)));
  const stepKeys = new Set(spec.steps.map(s => s.key));
  const nodes: ClosingGraph["nodes"] = [];
  const edge = (key: string): string => requirementKeys.has(key) ? `requirement:${key}`
    : stepKeys.has(key) ? `operation:${key}` : `unresolved:${key}`;
  for (const [requirementClass, entries] of classes) {
    for (const r of entries) {
      nodes.push({
        key: `requirement:${r.key}`, kind: "REQUIREMENT", requirementClass,
        originalDigest: closingDigest(r),
        actorIds: requirementClass === "documents"
          ? (r as ClosingSpec["documents"][number]).signers.map(s => s.principalId).sort() : [],
        dependsOn: r.dependsOn.map(edge).sort(), irreversible: false,
      });
    }
  }
  for (const step of spec.steps) {
    nodes.push({
      key: `operation:${step.key}`, kind: "OPERATION", requirementClass: step.kind,
      originalDigest: closingDigest(step), actorIds: [step.actor.principalId],
      dependsOn: [...new Set(step.dependsOn.map(edge))].sort(), irreversible: step.irreversible,
    });
  }
  for (const duty of spec.continuingDuties) {
    nodes.push({
      key: `duty:${duty.key}`, kind: "CONTINUING_DUTY", requirementClass: "continuingDuties",
      originalDigest: closingDigest(duty), actorIds: [duty.ownerPrincipalId],
      dependsOn: [], irreversible: false,
    });
  }
  nodes.push({
    key: "independent-close-check", kind: "INDEPENDENT_CLOSE_CHECK", requirementClass: "completeConjunction",
    originalDigest: closingDigest(spec), actorIds: [], irreversible: false,
    dependsOn: [
      ...classes.flatMap(([, entries]) => entries.filter(r => r.required).map(r => `requirement:${r.key}`)),
      ...spec.continuingDuties.map(d => `duty:${d.key}`),
    ].sort(),
  });
  if (nodes.length > 1024) throw Error("CLOSING_GRAPH_BOUND_UNSUPPORTED");
  if (new Set(nodes.map(n => n.key)).size !== nodes.length) throw Error("CLOSING_DUPLICATE_SEMANTIC_KEY");
  const known = new Set(nodes.map(n => n.key));
  if (nodes.some(n => n.dependsOn.some(k => !known.has(k)))) throw Error("CLOSING_DEPENDENCY_UNRESOLVED");
  const visited = new Set<string>(), active = new Set<string>(), byKey = new Map(nodes.map(n => [n.key, n]));
  const walk = (key: string): void => {
    if (active.has(key)) throw Error("CLOSING_DEPENDENCY_CYCLE");
    if (visited.has(key)) return;
    active.add(key);
    byKey.get(key)!.dependsOn.forEach(walk);
    active.delete(key);
    visited.add(key);
  };
  nodes.forEach(n => walk(n.key));
  return {
    schema: "finnor.closing-graph.v1", specDigest: closingDigest(spec), nodes,
    bounds: { nodes: nodes.length, maxNodes: 1024, allOriginalRequirementsIncluded: true },
  };
}
