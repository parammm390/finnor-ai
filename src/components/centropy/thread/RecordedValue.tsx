import type { ReactNode } from "react"

const label = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ")
function valueNode(value: unknown, depth: number): ReactNode {
  if (value == null) return <span>Not recorded</span>
  if (typeof value === "boolean") return <span>{value ? "True" : "False"}</span>
  if (typeof value === "string" || typeof value === "number") return <span>{String(value)}</span>
  if (depth > 8) return <span>Nested record exceeds the display bound; inspect its source before approving.</span>
  if (Array.isArray(value)) return <ol>{value.map((item, index) => <li key={index}>{valueNode(item, depth + 1)}</li>)}</ol>
  if (typeof value === "object") return <dl>{Object.entries(value).map(([key, item]) => <div key={key}><dt>{label(key)}</dt><dd>{valueNode(item, depth + 1)}</dd></div>)}</dl>
  return <span>Value unavailable</span>
}

/** Frozen action values rendered as labelled records rather than source code. */
export function RecordedValue({ serialized }: { serialized: string }) {
  let value: unknown
  try { value = JSON.parse(serialized) } catch { return <p>The exact structured values could not be read. Refresh the effect before approving.</p> }
  return <div className="ct-recorded-value">{valueNode(value, 0)}</div>
}
