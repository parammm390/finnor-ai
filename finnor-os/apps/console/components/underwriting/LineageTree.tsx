import type { UnderwritingLineage } from "../../lib/underwriting";
import { renderExactValue } from "../../lib/underwriting";

export default function LineageTree({ node, depth = 0 }: { node: UnderwritingLineage; depth?: number }) {
  const value = typeof node.value === "object" ? `${Object.keys(node.value).length} modeled periods` : renderExactValue(node.value, "text");
  return (
    <div className="uw-lineage-node" data-depth={depth}>
      <div className="uw-lineage-title"><code>{node.nodeId}</code> <span>{value}</span></div>
      <div className="uw-lineage-calculation">{node.calculation} · {node.truthClass}</div>
      {node.sourceProvenance.length > 0 ? (
        <ul className="uw-lineage-sources">
          {node.sourceProvenance.map((source, index) => (
            <li key={`${source.kind}:${source.id}:${index}`}>{source.kind}: {source.id}{source.versionId ? ` @ ${source.versionId}` : ""}{source.anchorId ? ` · ${source.anchorId}` : ""}</li>
          ))}
        </ul>
      ) : null}
      {node.dependencies.length > 0 ? (
        <div className="uw-lineage-children">
          {node.dependencies.map((dependency) => <LineageTree key={dependency.nodeId} node={dependency} depth={depth + 1} />)}
        </div>
      ) : null}
    </div>
  );
}
