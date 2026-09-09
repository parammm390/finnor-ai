import type { UnderwritingInput, UnderwritingNodeResult } from "../../lib/underwriting";
import { renderExactValue, shortIdentity, statusClassName } from "../../lib/underwriting";

function ExactNodeValue({ node }: { node: UnderwritingNodeResult }) {
  if (typeof node.value !== "object") return <span>{renderExactValue(node.value, node.unit, node.currency)}</span>;
  return (
    <div className="uw-series-values">
      {Object.entries(node.value).map(([periodId, value]) => (
        <span key={periodId}><strong>{periodId}</strong> {renderExactValue(value, node.unit, node.currency)}</span>
      ))}
    </div>
  );
}

export function ValuePanel({
  title,
  nodes,
  runId,
  modelVersionId,
}: {
  title: string;
  nodes: UnderwritingNodeResult[];
  runId: string;
  modelVersionId: string;
}) {
  return (
    <section className="card uw-panel">
      <div className="uw-panel-heading">
        <h2>{title}</h2>
        <span>Run {shortIdentity(runId)} · ModelVersion {shortIdentity(modelVersionId)}</span>
      </div>
      {nodes.length === 0 ? <p className="uw-muted">This exact Run contains no values in this section.</p> : (
        <div className="table-wrap">
          <table className="table uw-value-table">
            <thead><tr><th>Exact node</th><th>Value</th><th>Unit / truth</th><th>Calculation</th></tr></thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.nodeId} data-run-id={runId} data-model-version-id={modelVersionId}>
                  <td><code>{node.nodeId}</code></td>
                  <td><ExactNodeValue node={node} /></td>
                  <td>{node.currency ? `${node.currency} · ` : ""}{node.unit}<br /><small>{node.truthClass}</small></td>
                  <td>{node.calculation}<br /><small>{node.directDependencies.join(" · ") || "no dependencies"}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function InputTruthPanel({
  inputs,
  bindings,
  runId,
  modelVersionId,
}: {
  inputs: UnderwritingInput[];
  bindings: Map<string, { sourceKind: string; anchorId: string | null; documentVersionId: string | null }>;
  runId: string;
  modelVersionId: string;
}) {
  return (
    <section className="card uw-panel">
      <div className="uw-panel-heading">
        <h2>InputSnapshot truth</h2>
        <span>Run {shortIdentity(runId)} · ModelVersion {shortIdentity(modelVersionId)}</span>
      </div>
      <div className="table-wrap">
        <table className="table uw-input-table">
          <thead><tr><th>Exact input</th><th>Value</th><th>Truth</th><th>Exact provenance</th></tr></thead>
          <tbody>
            {inputs.map((input) => {
              const binding = bindings.get(input.nodeId);
              return (
                <tr key={input.nodeId} className="uw-long-row" data-run-id={runId}>
                  <td><code>{input.nodeId}</code><br /><small>{input.currency ? `${input.currency} · ` : ""}{input.unit} · {input.shape}</small></td>
                  <td>{input.value === null ? "missing (never zero)" : typeof input.value === "object" ? `${Object.keys(input.value).length} exact periods` : renderExactValue(input.value, input.unit, input.currency)}</td>
                  <td><span className={statusClassName(input.status)}>{input.status}</span><br /><small>{input.truthClass}</small>{input.reason ? <p className="uw-reason">{input.reason}</p> : null}</td>
                  <td>
                    {binding ? <div className="uw-binding-source">binding: {binding.sourceKind}{binding.anchorId ? ` · ${binding.anchorId}` : ""}{binding.documentVersionId ? ` · version ${shortIdentity(binding.documentVersionId)}` : ""}</div> : null}
                    {input.provenance.length === 0 ? <span className="uw-muted">No source reference</span> : (
                      <details>
                        <summary>{input.provenance.length} pinned source{input.provenance.length === 1 ? "" : "s"}</summary>
                        {input.provenance.map((source, index) => (
                          <div className="uw-provenance" key={`${source.kind}:${source.id}:${index}`}>
                            <strong>{source.kind}</strong> · {source.id}<br />
                            {source.versionId ? <>version {source.versionId}<br /></> : null}
                            {source.anchorId ? <>anchor {source.anchorId}<br /></> : null}
                            {source.effectiveAt ?? source.observedAt ?? source.retrievedAt ?? "time not supplied"}
                          </div>
                        ))}
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
