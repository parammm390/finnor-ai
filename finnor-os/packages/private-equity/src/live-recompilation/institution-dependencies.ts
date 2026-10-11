import type { DigitalInstitutionProfile } from "../institution-program/contracts";
import type { InstitutionCandidate } from "../institution-program/checker";
import type { InstitutionResponsibility } from "../institution-program/responsibility";
import { institutionDigest } from "../institution-program/canonical-json";

export type InstitutionDependencyGraph = { schema: "finnor.p7.institution-dependencies.v1";
  nodes: Array<{ id: string; kind: "ORIGINAL" | "RULE" | "CANONICAL" | "PRINCIPAL" | "OPERATION" | "DUTY";
    semanticDigest: string }>; edges: Array<{ from: string; to: string }> };
const key = (kind: string, ...identity: string[]) => JSON.stringify([kind, ...identity]);

/** Versioned P7 domain: dependencies point toward affected duties. It does not
 * pass an arbitrary institution graph through the old 256-node analytical port. */
export function buildInstitutionDependencyGraph(candidate: InstitutionCandidate,
  duties: InstitutionResponsibility[], profile: DigitalInstitutionProfile): InstitutionDependencyGraph {
  const nodes = new Map<string, InstitutionDependencyGraph["nodes"][number]>(), edges = new Map<string, { from: string; to: string }>();
  const add = (id: string, kind: InstitutionDependencyGraph["nodes"][number]["kind"], value: unknown) => {
    const next = { id, kind, semanticDigest: institutionDigest(value) }, old = nodes.get(id);
    if (old && old.semanticDigest !== next.semanticDigest) throw Error("X1_P7_DEPENDENCY_IDENTITY_COLLISION");
    nodes.set(id, next); return id;
  };
  // Material model changes remain semantic even if no creation duty depends
  // on that quantity/relation. Grouped source nodes keep the declared graph
  // bound while preserving their complete checked original-record population.
  for(const sourceId of candidate.coverage){
    const canonical=(items:unknown[])=>items.sort((a,b)=>institutionDigest(a).localeCompare(institutionDigest(b)));
    add(key("source-semantics",sourceId),"ORIGINAL",{
      mappings:canonical(candidate.mappings.filter(m=>m.sourceId===sourceId)),
      quantities:canonical(candidate.quantities.filter(q=>q.sourceId===sourceId)),
      relations:canonical((candidate.relations??[]).filter(r=>r.sourceId===sourceId)),
      contradictions:canonical(candidate.contradictions.filter(c=>c.leftRef.sourceId===sourceId||c.rightRef.sourceId===sourceId)),
      unresolved:canonical((candidate.unresolved??[]).filter(r=>r.sourceId===sourceId)),
    });
  }
  for (const responsibility of duties) {
    const d = responsibility.obligation;
    // A source revision alone is transport drift. These checked semantic fields
    // determine whether its original record actually changed business meaning.
    const record = { mapping: candidate.mappings.filter(m => m.sourceId === d.trigger.sourceId && m.recordId === d.trigger.recordId),
      quantities: candidate.quantities.filter(q => q.sourceId === d.trigger.sourceId && q.recordId === d.trigger.recordId),
      relations: (candidate.relations ?? []).filter(r => r.sourceId === d.trigger.sourceId && r.recordId === d.trigger.recordId),
      trigger: { ...d.trigger, availableAt: undefined },
      contradiction: candidate.contradictions.filter(c => c.leftRef.sourceId === d.trigger.sourceId && c.leftRef.recordId === d.trigger.recordId
        || c.rightRef.sourceId === d.trigger.sourceId && c.rightRef.recordId === d.trigger.recordId) };
    const target = add(key("duty", d.stableIdentity), "DUTY", { ...d, derivationRevision: undefined,
      trigger: { ...d.trigger, availableAt: undefined }, rule: { ...d.rule, mandateRevision: undefined } });
    const dependencies = [
      add(key("original", d.trigger.sourceId, d.trigger.recordId), "ORIGINAL", record),
      add(key("rule", d.rule.mandateId, d.rule.id), "RULE", { id: d.rule.id, triggerKind: d.rule.triggerKind,
        materiality: d.materiality, originalDeadline: d.originalDeadline, operation: d.permissibleOperationClass,
        principal: d.responsiblePrincipal, postcondition: d.postcondition.contractRef, observer: d.independentObserver.ref }),
      ...d.preconditions.map(p => add(key("canonical", p.ref), "CANONICAL", p)),
      add(key("principal", d.responsiblePrincipal), "PRINCIPAL", d.responsiblePrincipal),
      add(key("operation", d.permissibleOperationClass), "OPERATION", d.permissibleOperationClass),
    ];
    for (const from of dependencies) edges.set(key("edge", from, target), { from, to: target });
  }
  if (nodes.size > profile.bounds.institutionDependencyNodes || edges.size > profile.bounds.institutionDependencyEdges)
    throw Error("X1_P7_INSTITUTION_GRAPH_BOUND");
  return { schema: "finnor.p7.institution-dependencies.v1", nodes: [...nodes.values()].sort((a,b)=>a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a,b)=>key(a.from,a.to).localeCompare(key(b.from,b.to))) };
}

export function institutionAffectedClosure(graph: InstitutionDependencyGraph, changedIds: string[], profile: DigitalInstitutionProfile) {
  if (graph.nodes.length > profile.bounds.institutionDependencyNodes || graph.edges.length > profile.bounds.institutionDependencyEdges
      || new Set(graph.nodes.map(n=>n.id)).size !== graph.nodes.length) throw Error("X1_P7_INSTITUTION_GRAPH_BOUND");
  const ids = new Set(graph.nodes.map(n=>n.id)), forward = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw Error("X1_P7_DEPENDENCY_ENDPOINT_MISSING");
    forward.set(e.from, [...(forward.get(e.from) ?? []), e.to]);
  }
  if (changedIds.some(id=>!ids.has(id))) throw Error("X1_P7_CHANGED_DEPENDENCY_UNKNOWN");
  const affected = new Set(changedIds), queue = [...affected];
  for (let cursor=0;cursor<queue.length;cursor++) for (const next of forward.get(queue[cursor]!) ?? [])
    if (!affected.has(next)) { affected.add(next); queue.push(next); }
  return { affectedNodeIds: [...affected].sort(), affectedDutyIds: graph.nodes.filter(n=>n.kind==="DUTY"&&affected.has(n.id))
    .map(n=>(JSON.parse(n.id) as string[])[1]!).sort(), preservedDutyIds: graph.nodes.filter(n=>n.kind==="DUTY"&&!affected.has(n.id))
    .map(n=>(JSON.parse(n.id) as string[])[1]!).sort() };
}

export function compareInstitutionDependencies(previous: InstitutionDependencyGraph, next: InstitutionDependencyGraph,
  profile: DigitalInstitutionProfile) {
  const old = new Map(previous.nodes.map(n=>[n.id,n])), current = new Map(next.nodes.map(n=>[n.id,n]));
  const changed = [...new Set([...old.keys(),...current.keys()])].filter(id=>old.get(id)?.semanticDigest!==current.get(id)?.semanticDigest);
  const before = institutionAffectedClosure(previous, changed.filter(id=>old.has(id)), profile);
  const after = institutionAffectedClosure(next, changed.filter(id=>current.has(id)), profile);
  return { schema: "finnor.p7.institution-affected-update.v1", change: changed.length ? "SEMANTIC" : "COSMETIC_OR_TRANSPORT",
    changedDependencyIds: changed, affectedPriorDutyIds: before.affectedDutyIds, affectedCurrentDutyIds: after.affectedDutyIds,
    preservedCurrentDutyIds: after.preservedDutyIds, newDutyIds: next.nodes.filter(n=>n.kind==="DUTY"&&!old.has(n.id))
      .map(n=>(JSON.parse(n.id) as string[])[1]!), removedDutyIds: previous.nodes.filter(n=>n.kind==="DUTY"&&!current.has(n.id))
      .map(n=>(JSON.parse(n.id) as string[])[1]!), priorEffectsAndCostsRetained: true,
    authorityGranted: false, previousDigest: institutionDigest(previous), nextDigest: institutionDigest(next) };
}
