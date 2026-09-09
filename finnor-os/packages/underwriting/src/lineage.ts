import { fail } from "./errors";
import type {
  CompiledUnderwritingModel,
  InputProvenanceRef,
  OutputExplanationNode,
  UnderwritingInputSnapshot,
  UnderwritingRunResult,
} from "./types";

export function explainOutput(
  model: CompiledUnderwritingModel,
  snapshot: UnderwritingInputSnapshot,
  result: UnderwritingRunResult,
  outputNodeId: string,
): Readonly<OutputExplanationNode> {
  if (!result.outputs[outputNodeId]) fail("MISSING_DEPENDENCY", "Requested output does not exist in the Run", { outputNodeId });
  const active = new Set<string>();
  const build = (nodeId: string): OutputExplanationNode => {
    const executed = result.values[nodeId];
    if (!executed) fail("MISSING_DEPENDENCY", "Run lineage node is missing", { nodeId });
    if (active.has(nodeId)) {
      // Explicit solver cycles terminate at the repeated node; the compiled
      // circular block and solver diagnostics retain the circular semantics.
      return {
        nodeId,
        calculation: `${executed.calculation} [circular reference]`,
        value: executed.value,
        truthClass: executed.truthClass,
        directDependencies: executed.directDependencies,
        sourceProvenance: snapshot.values[nodeId]?.provenance ?? [],
        dependencies: [],
      };
    }
    active.add(nodeId);
    const dependencies = executed.directDependencies.filter((id) => result.values[id]).map(build);
    active.delete(nodeId);
    return {
      nodeId,
      calculation: executed.calculation,
      value: executed.value,
      truthClass: executed.truthClass,
      directDependencies: executed.directDependencies,
      sourceProvenance: (snapshot.values[nodeId]?.provenance ?? []) as readonly InputProvenanceRef[],
      dependencies,
    };
  };
  return Object.freeze(build(outputNodeId));
}

export function flattenExplanation(root: OutputExplanationNode): readonly OutputExplanationNode[] {
  const output: OutputExplanationNode[] = [];
  const seen = new Set<string>();
  const visit = (node: OutputExplanationNode) => {
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    output.push(node);
    node.dependencies.forEach(visit);
  };
  visit(root);
  return Object.freeze(output);
}
