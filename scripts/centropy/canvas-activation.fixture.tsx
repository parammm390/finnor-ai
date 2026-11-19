import { useState } from "react"
import { createRoot } from "react-dom/client"
import { CanvasDocument } from "../../src/components/centropy/canvas/CanvasDocument"
import { CanvasDocumentSchema } from "../../src/components/centropy/canvas/canvas-contract"

const timestamp = "2026-11-15T00:00:00.000Z"
const blocks = ["first", "second"].map(id => ({ schemaVersion: 1, id, type: "risk_register", title: `Open ${id} instrument`, sourceKind: "company_brain", entityRefs: [], sourceRefs: [], workRefs: [], truthState: "UNKNOWN", asOf: timestamp, createdAt: timestamp, updatedAt: timestamp, payload: { risks: [{ id, label: `Retained ${id} result`, state: "open", detail: "Authored rendering fixture; no business truth or API." }] } }))
function App() {
  const [generation, setGeneration] = useState(1)
  const document = CanvasDocumentSchema.parse({ schemaVersion: 1, threadId: `00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`, title: `Investigation ${generation}`, revision: { uiRevision: 0, canonicalSignature: `authored-${generation}`, builtAt: timestamp }, blocks, layout: { mode: "document", blockIds: blocks.map(block => block.id) } })
  return <><button onClick={() => setGeneration(value => value + 1)}>Change Investigation</button><main className="ct-canvas" aria-label="Investigation Canvas"><CanvasDocument document={document} root={null} sourceErrors={[]} refreshing={false} onRefresh={() => {}} /></main></>
}
createRoot(document.getElementById("root")!).render(<App />)
