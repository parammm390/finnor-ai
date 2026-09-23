"use client"

import dynamic from "next/dynamic"
import { usePathname } from "next/navigation"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import { ArrowLeft, ArrowRight, CheckCircle2, Command, FileCheck2, LoaderCircle, Search, ShieldCheck, X } from "lucide-react"
import { centropyGet, centropyPost } from "../lib/api"
import { useWorkspaceConfig } from "../WorkspaceConfigProvider"
import { usePeOperatingContext } from "../pe/PeOperatingContextProvider"
import { humanize, isInspectionTarget, type CompanyBrainObjectRef, type InspectionTarget } from "../pe/contracts"
import { usePeProductData } from "./ProductDataProvider"
import type { CommandOpenOptions, WorkAggregateView } from "./contracts"
import { productNodeLabel } from "./deal-model"
import { Status, TruthState } from "./primitives"
import type { ProductTruthState } from "./source-health"

const CentropyVoiceInput = dynamic(() => import("./CentropyVoiceInput"), { ssr: false })

interface PlannedAction {
  id: string
  actionType: string
  status?: string
}

interface ActionResponse {
  planned?: PlannedAction[]
  answer?: { spokenSummary?: string; displaySummary?: string }
  workId?: string
  instructionId?: string
  threadId?: string
  projectionWarnings?: Array<{ stage: string; code: string }>
}

type CommandStage = "draft" | "review" | "executing" | "verifying" | "outcome" | "failure"

interface CommandContextValue {
  openCommand: (options?: CommandOpenOptions) => void
  closeCommand: () => void
  isOpen: boolean
}

const Context = createContext<CommandContextValue | null>(null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function canonicalEntity(ref: CompanyBrainObjectRef | null): { entityType: string; entityId: string } | null {
  return ref?.namespace === "private_equity" ? { entityType: ref.type, entityId: ref.id } : null
}

function verifiedState(aggregate: WorkAggregateView | null): ProductTruthState {
  if (!aggregate) return "PARTIAL"
  const proof = aggregate.planRevisions.some((revision) => {
    const value = revision.completionProof
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).verified === true)
  })
  const receipt = aggregate.receipts.some((item) => Boolean(item.finalizedAt) && !item.failure)
  if (proof || receipt) return "KNOWN"
  if (aggregate.work.failure) return "CONFLICTING"
  return "PARTIAL"
}

function CommandDialog({ onClose, initial }: { onClose: () => void; initial: CommandOpenOptions }) {
  const pathname = usePathname()
  const operating = usePeOperatingContext()
  const product = usePeProductData()
  const workspace = useWorkspaceConfig()
  const inputRef = useRef<HTMLInputElement>(null)
  const [instruction, setInstruction] = useState(initial.prompt ?? "")
  const [inputChannel, setInputChannel] = useState<"text" | "voice">("text")
  const [stage, setStage] = useState<CommandStage>("draft")
  const [result, setResult] = useState<ActionResponse | null>(null)
  const [verification, setVerification] = useState<WorkAggregateView | null>(null)
  const [outcomeState, setOutcomeState] = useState<ProductTruthState>("UNKNOWN")
  const [error, setError] = useState<string | null>(null)
  const root = operating.context.root
  const selected = canonicalEntity(operating.context.selectedObject)
  const selectedEntities = useMemo(() => root ? [...new Map([
    { entityType: root.entityType, entityId: root.entityId },
    ...(selected ? [selected] : []),
  ].map((value) => [`${value.entityType}:${value.entityId}`, value])).values()] : [], [root, selected])
  const localMatches = useMemo(() => {
    const query = instruction.trim().toLocaleLowerCase()
    if (!query || stage !== "draft") return []
    const roots = (product.roots.data ?? []).filter((item) => item.label.toLocaleLowerCase().includes(query))
      .map((item) => ({ label: item.label, meta: humanize(item.ref.type), target: item.inspectionTarget, ref: item.ref, root: item.rootRefs[0] }))
    const projection = product.brain.data
    const nodes = (projection?.nodes ?? []).map((node) => ({ node, label: productNodeLabel(node, projection!.nodes, projection!.edges) }))
      .filter(({ node, label }) => label.toLocaleLowerCase().includes(query) || humanize(node.type).toLocaleLowerCase().includes(query))
      .slice(0, 8).map(({ node, label }) => ({ label, meta: humanize(node.type), target: node.inspectionTarget, ref: node.ref, root: projection?.root }))
    return [...roots, ...nodes].filter((item) => item.root && isInspectionTarget(item.target)).slice(0, 8)
  }, [instruction, product.brain.data, product.roots.data, stage])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [onClose])

  function review(event: FormEvent) {
    event.preventDefault()
    if (!instruction.trim() || !root) return
    setError(null)
    setStage("review")
  }

  async function execute() {
    if (!root || !instruction.trim()) return
    setStage("executing")
    setError(null)
    setResult(null)
    setVerification(null)
    try {
      const response = await centropyPost<ActionResponse>("actions", {
        instruction: instruction.trim(),
        channel: inputChannel,
        instructionId: crypto.randomUUID(),
        ...(operating.context.workId && UUID.test(operating.context.workId) ? { workId: operating.context.workId } : {}),
        activeContext: {
          version: 1,
          capturedAt: new Date().toISOString(),
          source: inputChannel,
          ...(operating.context.workId && UUID.test(operating.context.workId) ? { activeWork: { workId: operating.context.workId } } : {}),
          focusedEntity: selected ?? { entityType: root.entityType, entityId: root.entityId },
          selectedEntities,
          excludedEntities: [],
          surface: { id: pathname.split("/")[2] || "home", route: pathname, spatialState: "detail" },
          filters: [],
        },
      })
      setResult(response)
      setStage("verifying")
      if (response.workId && UUID.test(response.workId)) {
        operating.setWork(response.workId)
        try {
          const aggregate = (await centropyGet<{ work: WorkAggregateView }>(`works/${response.workId}`)).work
          setVerification(aggregate)
          setOutcomeState(verifiedState(aggregate))
        } catch {
          setOutcomeState("PARTIAL")
        }
      } else {
        setOutcomeState("PARTIAL")
      }
      setStage("outcome")
      product.refreshAll()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CENTROPY could not submit the governed instruction.")
      setOutcomeState("UNAVAILABLE")
      setStage("failure")
    }
  }

  const rootLabel = (product.roots.data ?? []).find((item) => item.rootRefs.some((candidate) => candidate.entityType === root?.entityType && candidate.entityId === root.entityId))?.label
  const resultSummary = result?.answer?.displaySummary ?? result?.answer?.spokenSummary ?? (result?.planned?.length ? `${result.planned.length} governed action candidate${result.planned.length === 1 ? "" : "s"} recorded.` : "The instruction was accepted without a represented completion.")

  return <div className="pw-command-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="pw-command" role="dialog" aria-modal="true" aria-labelledby="pw-command-title" data-stage={stage}>
      <header><div><span className="pw-command__signal"><Command size={15} /></span><div><span>CENTROPY COMMAND LAYER</span><h2 id="pw-command-title">{stage === "draft" ? "Search, ask, or create governed Work" : stage === "review" ? "Review consequence and authority" : stage === "outcome" ? "Persisted outcome check" : stage === "failure" ? "Command failed safely" : stage === "verifying" ? "Verifying persisted evidence" : "Executing through governed systems"}</h2></div></div><button type="button" onClick={onClose} aria-label="Close command interface"><X size={16} /></button></header>
      {stage === "draft" ? <form onSubmit={review}>
        <label htmlFor="pw-global-command"><Search size={15} /><input ref={inputRef} id="pw-global-command" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={root ? "Why is this deal blocked?" : "Search for a Deal, then enter its operating context"} autoComplete="off" /></label>
        <div className="pw-command__context"><span>PE context</span><strong>{root ? rootLabel ?? humanize(root.entityType) : "No canonical root selected"}</strong>{workspace.config.voiceEnabled ? <CentropyVoiceInput onTranscript={(value) => { setInputChannel("voice"); setInstruction((current) => [current, value].filter(Boolean).join(" ")) }} /> : null}</div>
        {localMatches.length ? <div className="pw-command__matches" aria-label="Source-backed matching objects">{localMatches.map((item) => <button type="button" key={`${item.meta}:${item.label}:${item.ref.id}`} onClick={() => { operating.inspect(item.target, item.ref, item.root); onClose() }}><span><strong>{item.label}</strong><small>{item.meta}</small></span><ArrowRight size={13} /></button>)}</div> : null}
        <footer><span>⌘K anywhere · Enter reviews · Escape closes</span><button type="submit" disabled={!root || !instruction.trim()}>Review command <ArrowRight size={14} /></button></footer>
      </form> : null}
      {stage === "review" ? <div className="pw-command__review">
        <blockquote>{instruction}</blockquote>
        <dl><div><dt>Context</dt><dd>{root ? rootLabel ?? humanize(root.entityType) : "UNKNOWN"}</dd></div><div><dt>Input channel</dt><dd>{humanize(inputChannel)}</dd></div><div><dt>Consequence</dt><dd>May create or continue canonical Work and propose governed actions. It does not grant authority.</dd></div><div><dt>Boundary</dt><dd>Policy and Authority are evaluated by the backend at execution; selection never authorizes mutation.</dd></div><div><dt>Success standard</dt><dd>Only persisted evidence, a finalized receipt, or verified completion proof is shown as verified.</dd></div></dl>
        <footer><button type="button" onClick={() => setStage("draft")}><ArrowLeft size={13} /> Edit</button><button type="button" onClick={() => void execute()}><ShieldCheck size={14} /> Propose to CENTROPY</button></footer>
      </div> : null}
      {stage === "executing" || stage === "verifying" ? <div className="pw-command__progress"><LoaderCircle size={20} /><Status value={stage === "executing" ? "EXECUTING" : "VERIFYING"} /><p>{stage === "executing" ? "CENTROPY is planning and applying the existing authority boundary." : "Reading the canonical Work aggregate for receipt or completion proof."}</p></div> : null}
      {stage === "outcome" ? <div className="pw-command__outcome"><TruthState state={outcomeState} /><h3>{outcomeState === "KNOWN" ? "Verified outcome" : "Accepted; verification is not complete"}</h3><p>{resultSummary}</p>{verification ? <dl><div><dt>Work state</dt><dd><Status value={verification.work.status} /></dd></div><div><dt>Finalized receipts</dt><dd>{verification.receipts.filter((item) => item.finalizedAt).length}</dd></div><div><dt>Completion proof</dt><dd>{verification.planRevisions.some((item) => Boolean(item.completionProof)) ? "Recorded" : "No recorded proof"}</dd></div></dl> : <p>The Work aggregate could not be confirmed. No optimistic success is shown.</p>}<footer>{result?.workId ? <button type="button" onClick={() => { operating.inspect({ kind: "work", workId: result.workId! }); onClose() }}><FileCheck2 size={14} /> Inspect Work</button> : null}{result?.planned?.map((action) => result.workId ? <button type="button" key={action.id} onClick={() => { operating.inspect({ kind: "domain_action", workId: result.workId!, domainActionId: action.id }); onClose() }}>Inspect {humanize(action.actionType)} <ArrowRight size={13} /></button> : null)}</footer></div> : null}
      {stage === "failure" ? <div className="pw-command__outcome"><TruthState state="UNAVAILABLE" /><h3>No success was recorded</h3><p>{error}</p><footer><button type="button" onClick={() => setStage("review")}><ArrowLeft size={13} /> Review again</button></footer></div> : null}
      <ol className="pw-command__stages" aria-label="Governed action lifecycle">{["PROPOSE", "REVIEW CONSEQUENCE", "AUTHORITY", "EXECUTING", "VERIFYING", "OUTCOME", "RECEIPT"].map((label) => <li key={label}><CheckCircle2 size={11} />{label}</li>)}</ol>
    </section>
  </div>
}

export function CommandInterfaceProvider({ children }: { children: ReactNode }) {
  const [initial, setInitial] = useState<CommandOpenOptions>({})
  const [isOpen, setOpen] = useState(false)
  const openCommand = useCallback((options: CommandOpenOptions = {}) => { setInitial(options); setOpen(true) }, [])
  const closeCommand = useCallback(() => setOpen(false), [])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault()
        setInitial({})
        setOpen(true)
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [])

  const value = useMemo(() => ({ openCommand, closeCommand, isOpen }), [closeCommand, isOpen, openCommand])
  return <Context.Provider value={value}>{children}{isOpen ? <CommandDialog key={JSON.stringify(initial)} initial={initial} onClose={closeCommand} /> : null}</Context.Provider>
}

export function useCommandInterface(): CommandContextValue {
  const value = useContext(Context)
  if (!value) throw new Error("useCommandInterface must be used inside CommandInterfaceProvider")
  return value
}
