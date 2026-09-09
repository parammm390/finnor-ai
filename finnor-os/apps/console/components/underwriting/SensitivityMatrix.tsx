import type { UnderwritingSensitivityDetail, UnderwritingValue } from "../../lib/underwriting";
import { renderExactValue, shortIdentity, statusClassName } from "../../lib/underwriting";

function axisValue(value: UnderwritingValue): string {
  return typeof value === "object" ? JSON.stringify(value) : renderExactValue(value, "text");
}

export default function SensitivityMatrix({ detail, onSelectRun }: { detail: UnderwritingSensitivityDetail; onSelectRun: (runId: string) => void }) {
  const columns = detail.definition.columnAxis?.values ?? ["result"];
  const cellByCoordinate = new Map(detail.cells.map((cell) => [`${cell.rowIndex}:${cell.columnIndex}`, cell]));
  const outputId = detail.definition.outputNodeIds[0];
  return (
    <section className="card uw-panel">
      <div className="uw-panel-heading">
        <h2>{detail.name}</h2>
        <span className={statusClassName(detail.status)}>{detail.status} · {detail.cells.length}/{detail.cellCount} cells</span>
      </div>
      <p className="uw-muted">Each cell is an immutable UnderwritingRun. Matrix shows <code>{outputId}</code>; open a cell to inspect its full Run.</p>
      <div className="table-wrap">
        <table className="table uw-sensitivity-table">
          <thead><tr><th>{detail.definition.rowAxis.nodeId} ↓ / {detail.definition.columnAxis?.nodeId ?? "one-way"} →</th>{columns.map((value, index) => <th key={index}>{axisValue(value)}</th>)}</tr></thead>
          <tbody>
            {detail.definition.rowAxis.values.map((rowValue, rowIndex) => (
              <tr key={rowIndex}>
                <th>{axisValue(rowValue)}</th>
                {columns.map((_column, columnIndex) => {
                  const cell = cellByCoordinate.get(`${rowIndex}:${columnIndex}`);
                  const output = outputId && cell?.result.outputs[outputId];
                  return (
                    <td key={columnIndex}>
                      {cell ? <button type="button" className="uw-cell-button" onClick={() => onSelectRun(cell.runId)}>
                        <strong>{output && typeof output.value !== "object" ? renderExactValue(output.value, output.unit, output.currency) : cell.runStatus}</strong>
                        <small>{shortIdentity(cell.runId)} · {cell.runValidity}</small>
                      </button> : "missing"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
