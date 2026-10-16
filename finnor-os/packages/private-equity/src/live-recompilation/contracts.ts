/** Ordinary continuation IR. It grants neither effect authority nor admission. */
import { z } from 'zod';
import type { EvidenceDependency, Phase2Envelope } from '@finnor/shared-types';
import type { HarnessNode } from '../program-synthesis/contracts';
import { sha } from '../evidence-execution/store';
import { PE_WORLD_ROOT_TYPES } from '../types';

export const P7_VERSION = 'p7-native-analytical-continuation-v1' as const;
export const SubmitSchema = z.object({ priorProgramId: z.string().uuid() }).strict();
export const ReadSchema = z.object({ continuationId: z.string().uuid() }).strict();
export const ProjectionSchema = z.object({
  root: z.object({entityType: z.enum(PE_WORLD_ROOT_TYPES), entityId: z.string().uuid()}).strict(),
  workId: z.string().uuid(),
}).strict();
export interface ContinuationRef {
  owner: 'P1' | 'P7'; id: string; version: string; contentDigest: string;
}
export function ref(owner: ContinuationRef['owner'], id: string, body: unknown): ContinuationRef {
  return { owner, id, version: owner === 'P7' ? P7_VERSION : 'finnor.harness-program.v1', contentDigest: sha(body) };
}
export interface ContinuationPatch extends Phase2Envelope<
  { version: typeof P7_VERSION; digest: string; schemaDigest: string },
  { kind: 'NATIVE_ANALYTICAL_CONTINUATION'; admission: null },
  { entityScope: string[]; interface: typeof P7_VERSION; horizon: 'H0'; businessTruthCertified: false }
> {
  schema: 'finnor.continuation-patch.v1';
  priorProgram: ContinuationRef;
  nextProgram: ContinuationRef;
  trigger: ContinuationRef;
  affectedNodes: ContinuationRef[];
  keptNodes: ContinuationRef[];
  consistencyVector: { dependencies: EvidenceDependency[]; workInputId: string; workInputDigest: string };
  obligationChanges: { ref: ContinuationRef; action: string }[];
  reservationChanges: ContinuationRef[];
  publication: ContinuationRef;
  supportedState: 'PUBLISHED_ORDINARY_ANALYTICAL';
}

/** Enumerate the whole graph, never return a silently truncated reuse set. */
export function affectedClosure<T extends Pick<HarnessNode,'id'|'dependsOn'>>(graph: T[], seeds: string[]) {
  if (!graph.length || graph.length > 256) throw Error('P7_GRAPH_BOUND_OR_UNAVAILABLE');
  const nodes = new Map(graph.map(node => [node.id, node]));
  if (nodes.size !== graph.length) throw Error('P7_GRAPH_DUPLICATE_MEMBER');
  const downstream = new Map<string, string[]>();
  let edges = 0;
  for (const node of graph) for (const parent of node.dependsOn) {
    if (!nodes.has(parent)) throw Error('P7_GRAPH_DEPENDENCY_COVERAGE_GAP');
    if (++edges > 4096) throw Error('P7_GRAPH_EDGE_BOUND');
    downstream.set(parent, [...(downstream.get(parent) ?? []), node.id]);
  }
  if (seeds.some(id => !nodes.has(id))) throw Error('P7_GRAPH_SEED_NOT_A_MEMBER');
  const affected = new Set<string>(), todo = [...seeds];
  while (todo.length) {
    const id = todo.pop()!;
    if (affected.has(id)) continue;
    affected.add(id);
    todo.push(...(downstream.get(id) ?? []));
  }
  return { affectedNodes: graph.filter(node => affected.has(node.id)),
    keptNodes: graph.filter(node => !affected.has(node.id)) };
}
