import { Profiler, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { CanvasDocument } from "../../src/components/centropy/canvas/CanvasDocument"
import { CanvasDocumentSchema, type CanvasBlock } from "../../src/components/centropy/canvas/canvas-contract"
import { WorldRelationships } from "../../src/components/centropy/world/WorldRelationships"
import { CentropyPresence } from "../../src/components/centropy/shell/CentropyPresence"
import type { CompanyBrainEdge, CompanyBrainNode } from "../../src/components/centropy/pe/contracts"

type Mode = "blocks" | "underwriting" | "relationships" | "orb"
declare global { interface Window { __centropyBench: { fixtureOnly: true; ready: boolean; mode: Mode; startedAt: number; renders: Array<{ mode: Mode; phase: string; durationMs: number }>; timings: Record<string, number>; longTasks: number[]; longTaskSupported: boolean } } }
window.__centropyBench = { fixtureOnly: true, ready: false, mode: "blocks", startedAt: performance.now(), renders: [], timings: {}, longTasks: [], longTaskSupported: PerformanceObserver.supportedEntryTypes.includes("longtask") }
if (window.__centropyBench.longTaskSupported) new PerformanceObserver((list) => window.__centropyBench.longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask", buffered: true })
const clock = new Date().toISOString()
const base = { schemaVersion: 1 as const, sourceKind: "company_brain" as const, entityRefs: [], sourceRefs: [], workRefs: [], truthState: "UNKNOWN" as const, asOf: clock, createdAt: clock, updatedAt: clock }
const blocks: CanvasBlock[] = Array.from({ length: 20 }, (_, index) => ({ ...base, id: `authored-stress-${index + 1}`, type: "risk_register" as const, title: `Authored UNKNOWN block ${index + 1}`, payload: { risks: Array.from({ length: 5 }, (_, row) => ({ id: `row-${index}-${row}`, label: `Authored stress row ${row + 1}`, state: "UNKNOWN", detail: "Renderer input only. No business assertion or source evidence." })) } }))
const outputs = Array.from({ length: 1000 }, (_, index) => ({ nodeId: `authored-output-${index + 1}`, label: `Authored UNKNOWN output ${index + 1}`, value: "UNKNOWN", unit: "fixture", truthClass: "UNAVAILABLE" }))
const underwriting: CanvasBlock[] = [{ ...base, sourceKind: "underwriting", id: "authored-large-underwriting", type: "underwriting_summary", title: "Authored large underwriting renderer input", payload: { investmentCaseTitle: "No investment assertion", modelName: "Renderer stress input", modelVersion: null, scenarioName: "No calculated scenario", runId: null, status: "UNAVAILABLE", validity: "UNKNOWN", outputs, failedChecks: [] } }]
const buildDocument = (input: CanvasBlock[]) => CanvasDocumentSchema.parse({ schemaVersion: 1, threadId: "00000000-0000-4000-8000-000000000099", title: "Authored renderer stress document", revision: { uiRevision: 0, canonicalSignature: "authored-ui-stress-not-business-truth", builtAt: clock }, layout: { mode: "document", blockIds: input.map((block) => block.id) }, blocks: input })
const blockDocument = buildDocument(blocks), underwritingDocument = buildDocument(underwriting)
const nodes: CompanyBrainNode[] = Array.from({ length: 10_000 }, (_, index) => {
  const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
  return { ref: { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_request", id }, type: "pe_request", label: `Authored UNKNOWN relationship object ${index + 1}`, state: null, rootRefs: [], version: null, revision: null, facts: [], asOf: clock, temporal: { support: "none", completeness: "unknown", baseline: null, reasons: ["Authored renderer input"] }, epistemicState: "UNKNOWN", epistemicWarnings: [], provenanceRefs: [], workRefs: [], inspectionTarget: { kind: "brain_object", ref: { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_request", id } }, availableActions: [] } satisfies CompanyBrainNode
})
const edges: CompanyBrainEdge[] = Array.from({ length: 20_000 }, (_, index) => ({ fromRef: nodes[index % 10_000].ref, toRef: nodes[(index + 1) % 10_000].ref, relationship: "authored_fixture_link", sourceRef: { owner: "@finnor/db", table: "authored_renderer_input_not_source_evidence", id: `authored-edge-${index + 1}` }, asOf: clock }))

function App() {
  const [mode, setMode] = useState<Mode>("blocks")
  const select = (next: Mode) => { window.__centropyBench.ready = false; window.__centropyBench.mode = next; window.__centropyBench.startedAt = performance.now(); setMode(next) }
  useEffect(() => { let second = 0; const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { window.__centropyBench.timings[mode] = performance.now() - window.__centropyBench.startedAt; window.__centropyBench.ready = true }) }); return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) } }, [mode])
  return <div className="ct-app"><header style={{ padding: "20px", maxWidth: "100%" }}><h1>Component benchmark — authored UNKNOWN inputs</h1><p>No business Work, financial calculation, active agent, receipt, provider observation, or business API exists in this harness.</p><div role="group" aria-label="Renderer measurements">{([["blocks", "20 Canvas blocks"], ["underwriting", "Large underwriting table"], ["relationships", "Large relationship view"], ["orb", "Orb active"]] as const).map(([key, title]) => <button type="button" key={key} onClick={() => select(key)} disabled={mode === key}>{title}</button>)}</div></header>
    <Profiler id="production-renderer" onRender={(_, phase, durationMs) => window.__centropyBench.renders.push({ mode, phase, durationMs })}>
      {mode === "blocks" || mode === "underwriting" ? <CanvasDocument key={mode} document={mode === "blocks" ? blockDocument : underwritingDocument} sourceErrors={[]} refreshing={false} onRefresh={() => {}} /> : mode === "relationships" ? <section className="ct-world__detail" style={{ padding: 24 }}><h2>Authored 10,000-object / 20,000-link stress input</h2><WorldRelationships nodes={nodes} edges={edges} selected={nodes[0]} onSelect={() => {}} /></section> : <section style={{ padding: 32 }}><h2>Authored Orb state input</h2><p>This is a component animation benchmark. It does not represent active business Work.</p><CentropyPresence state="WORKING" size={98} /></section>}
    </Profiler>
  </div>
}
createRoot(document.getElementById("root")!).render(<App />)
