"use client"

import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowRight, Globe2, History, LockKeyhole, LogOut, PanelsTopLeft, Plus, Settings } from "lucide-react"
import { useCentropyAuth } from "@/components/centropy/lib/centropy-auth"
import { centropyPost, CentropyApiError } from "@/components/centropy/lib/api"
import { readPeOperatingContext } from "@/components/centropy/pe/context-routing"
import { isPeWorldRootRef, type CompanyBrainNode, type CompanyBrainObjectRef, type PeWorldRootRef } from "@/components/centropy/pe/contracts"
import { InstructionTraceRuntime, type InstructionTraceSnapshot } from "../runtime/instruction-events"
import { presenceFromRuntime } from "../runtime/presence-state"
import { CanvasDocument, type CanvasSourceError } from "../canvas/CanvasDocument"
import { CausalReplayPanel } from "../canvas/CausalReplayPanel"
import { composeCanvasDocument } from "../canvas/canvas-compose"
import { useCanvasSources } from "../canvas/use-canvas-sources"
import { WorldExplorer } from "../world/WorldExplorer"
import { canonicalWorldFocus, operatingSelection } from "../world/world-context"
import { createInvestigation, listInvestigations } from "../thread/thread-api"
import type { ConversationThreadSummary } from "../thread/thread-contract"
import { useInvestigation } from "../thread/use-investigation"
import { Composer } from "../thread/Composer"
import { ExecutionObject } from "../thread/ExecutionObject"
import { ObjectiveControl } from "../thread/ObjectiveControl"
import { VerifiedIcOutcome } from "../thread/VerifiedIcOutcome"
import { VerifiedUnderwritingOutcome } from "../thread/VerifiedUnderwritingOutcome"
import { HomeCanvas } from "./HomeCanvas"
import { CentropyPresence } from "./CentropyPresence"
import "./centropy.css"

const WorkRecovery = lazy(() => import("../thread/WorkRecovery").then((module) => ({ default: module.WorkRecovery })))
const PendingEffects = lazy(() => import("../thread/PendingEffects").then((module) => ({ default: module.PendingEffects })))
const WorkforceAssignments = lazy(() => import("../thread/WorkforceAssignments").then((module) => ({ default: module.WorkforceAssignments })))
const OutcomePacks = lazy(() => import("../thread/OutcomePacks").then((module) => ({ default: module.OutcomePacks })))
const SettingsDialog = lazy(() => import("../controls/SettingsDialog").then((module) => ({ default: module.SettingsDialog })))

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface SubmissionResponse {
  instructionId: string
  threadId: string
  workId: string
  objective?: { objectiveLoopId: string; state: string }
  projectionWarnings?: Array<{ code: string; stage: string }>
}

interface PendingTurn { instructionId: string; threadId: string; text: string; failed: boolean }

function routeThreadId(pathname: string): string | null {
  const match = /^\/centropy\/investigations\/([^/]+)$/.exec(pathname)
  return match?.[1] && UUID.test(match[1]) ? match[1] : null
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" })
}

export function CentropyWorkspace() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const auth = useCentropyAuth()
  const ready = Boolean(auth.session && auth.role === "owner" && !auth.roleError)
  const fromRoute = routeThreadId(pathname)
  const worldMode = pathname === "/centropy/world"
  const worldThreadId = worldMode && UUID.test(searchParams.get("threadId") ?? "") ? searchParams.get("threadId") : null
  const draftArtifactInUrl = searchParams.get("artifactMode") === "draft" && UUID.test(searchParams.get("artifactDocumentId") ?? "") && UUID.test(searchParams.get("artifactVersionId") ?? "")
  const requestedReplayWorkId = UUID.test(searchParams.get("replayWorkId") ?? "") ? searchParams.get("replayWorkId") : null
  const [localThreadId, setThreadId] = useState<string | null>(fromRoute ?? worldThreadId)
  // URL identity wins during navigation. A render must never pair the previous
  // Investigation's cached Work or conversation with the next route.
  const threadId = fromRoute ?? (worldMode ? worldThreadId : pathname === "/centropy" ? null : localThreadId)
  const selectionScope = threadId ?? (worldMode ? "world" : "home")
  const routeQuery = searchParams.toString()
  const selectionKey = `${selectionScope}|${routeQuery}`
  const routeClearsContext = searchParams.get("context") === "none"
  const noticeScope = threadId ?? (worldMode ? "world" : "home")
  const routeSelection = useMemo(() => readPeOperatingContext(new URLSearchParams(routeQuery)), [routeQuery])
  const [refreshToken, setRefreshToken] = useState(0)
  const [canvasRefresh, setCanvasRefresh] = useState(0)
  const [underwritingRefresh, setUnderwritingRefresh] = useState(0)
  const [replayWork, setReplayWork] = useState<{ threadId: string; workId: string } | null>(null)
  const setReplayWorkId = (workId: string | null) => setReplayWork(workId && threadId ? { threadId, workId } : null)
  const selectReplayWorkId = (workId: string | null) => {
    if (!threadId || (workId && !UUID.test(workId))) return
    setReplayWorkId(workId)
    const query = new URLSearchParams(routeQuery)
    if (workId) query.set("replayWorkId", workId)
    else query.delete("replayWorkId")
    router.replace(`${pathname}${query.size ? `?${query}` : ""}`, { scroll: false })
  }
  const investigation = useInvestigation(threadId, ready, refreshToken)
  const [recent, setRecent] = useState<ConversationThreadSummary[]>([])
  const [recentError, setRecentError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [pending, setPending] = useState<PendingTurn | null>(null)
  const [submissionError, setSubmissionError] = useState<{ scope: string; message: string } | null>(null)
  const [controlNotice, setControlNotice] = useState<{ scope: string; message: string } | null>(null)
  const [redirecting, setRedirecting] = useState(false)
  const [voiceListening, setVoiceListening] = useState(false)
  const [assignmentsOpen, setAssignmentsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [responseWork, setResponseWork] = useState<{ threadId: string; workId: string } | null>(null)
  const [trace, setTrace] = useState<InstructionTraceSnapshot | null>(null)
  const traceRuntime = useRef<InstructionTraceRuntime | null>(null)
  const drawer = useRef<HTMLDialogElement>(null)
  const messagesEnd = useRef<HTMLDivElement>(null)
  const [mobilePane, setMobilePane] = useState<"thread" | "canvas">(worldMode || draftArtifactInUrl || requestedReplayWorkId ? "canvas" : "thread")
  const [rootSelection, setRootSelection] = useState<{ key: string; value: PeWorldRootRef | null; explicit: boolean }>(() => ({ key: selectionKey, value: routeSelection.root, explicit: Boolean(routeSelection.root) || routeClearsContext }))
  const [objectSelection, setObjectSelection] = useState<{ key: string; value: CompanyBrainObjectRef | null }>(() => ({ key: selectionKey, value: worldMode ? routeSelection.selectedObject : null }))
  const explicitRoot = rootSelection.key === selectionKey ? rootSelection.value : routeSelection.root
  const focusedObject = objectSelection.key === selectionKey ? objectSelection.value : routeSelection.selectedObject
  const setExplicitRoot = (value: PeWorldRootRef | null) => setRootSelection({ key: selectionKey, value, explicit: true })
  const setFocusedObject = (value: CompanyBrainObjectRef | null) => setObjectSelection({ key: selectionKey, value })
  const [composerSuggestion, setComposerSuggestion] = useState<{ id: string; text: string } | null>(null)

  useEffect(() => { if (draftArtifactInUrl) setMobilePane("canvas") }, [draftArtifactInUrl])

  useEffect(() => {
    if (fromRoute) {
      if (localThreadId !== fromRoute) { traceRuntime.current?.stop(); setResponseWork(null); setTrace(null); setReplayWorkId(null) }
      setThreadId(fromRoute)
    } else if (worldMode && worldThreadId) setThreadId(worldThreadId)
    else if (pathname === "/centropy") setThreadId(null)
    // Route identity, not a later local selection, determines when this reset runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromRoute, pathname, worldMode, worldThreadId])

  useEffect(() => {
    setRootSelection({ key: selectionKey, value: routeSelection.root, explicit: Boolean(routeSelection.root) || routeClearsContext })
    setObjectSelection({ key: selectionKey, value: routeSelection.selectedObject })
  }, [selectionKey, routeSelection, routeClearsContext])

  const refreshRecent = useCallback(async () => {
    if (!ready) return
    try { setRecent(await listInvestigations()); setRecentError(null) }
    catch (cause) { setRecentError(cause instanceof Error ? cause.message : "Investigations are unavailable") }
  }, [ready])

  useEffect(() => { void refreshRecent() }, [refreshRecent])
  useEffect(() => () => traceRuntime.current?.stop(), [])

  const startTrace = useCallback((instructionId: string) => {
    if (traceRuntime.current?.instructionId === instructionId) return
    traceRuntime.current?.stop()
    const runtime = new InstructionTraceRuntime(instructionId, setTrace)
    traceRuntime.current = runtime
    runtime.start()
  }, [])

  const messages = useMemo(() => investigation.loaded?.messages ?? [], [investigation.loaded?.messages])
  const latestInstructionMessage = [...messages].reverse().find((message) => message.instructionId)
  const latestInstructionId = latestInstructionMessage?.instructionId ?? null
  const visiblePending = pending?.threadId === threadId ? pending : null
  const visibleTrace = trace && (trace.instructionId === latestInstructionId || trace.instructionId === visiblePending?.instructionId) ? trace : null
  useEffect(() => {
    if (latestInstructionId && !visiblePending) startTrace(latestInstructionId)
  }, [latestInstructionId, visiblePending, startTrace])
  useEffect(() => {
    if (visiblePending && messages.some((message) => message.instructionId === visiblePending.instructionId && message.role === "user")) setPending(null)
  }, [messages, visiblePending])
  useEffect(() => { messagesEnd.current?.scrollIntoView({ block: "end" }) }, [messages.length, visiblePending?.instructionId])

  const activeWorkId = responseWork?.threadId === threadId ? responseWork.workId : investigation.loaded?.thread.activeWorkId ?? null
  // Restored replay must belong to this Investigation's selected canonical Work.
  const replayWorkId = requestedReplayWorkId === activeWorkId ? requestedReplayWorkId : replayWork?.threadId === threadId ? replayWork.workId : null
  const activeObjectiveId = investigation.loaded?.thread.activeWorkId === activeWorkId ? investigation.loaded.thread.activeObjectiveLoopId : null
  const selectedRootFromThread = useMemo(() => {
    const ref = investigation.loaded?.thread.activeReferences.find(isPeWorldRootRef)
    return ref && isPeWorldRootRef(ref) ? ref : null
  }, [investigation.loaded?.thread.activeReferences])
  const canvasRoot = rootSelection.key === selectionKey && rootSelection.explicit
    ? rootSelection.value : routeClearsContext ? null : explicitRoot ?? selectedRootFromThread
  const routeSelectedObject = routeSelection.selectedObject
  const selectedIcCaseId = UUID.test(searchParams.get("icCaseId") ?? "") ? searchParams.get("icCaseId") : null
  const canvasSources = useCanvasSources(activeWorkId, canvasRoot, ready && Boolean(threadId || worldMode || canvasRoot), canvasRefresh + refreshToken, underwritingRefresh, selectedIcCaseId)
  const contextLabel = canvasRoot ? canvasSources.projection.data?.nodes.find((item) => item.ref.type === canvasRoot.entityType && item.ref.id === canvasRoot.entityId)?.label
    ?? `Deal ${canvasRoot.entityId.slice(0, 8)}` : null
  const selectIcCase = (id: string) => {
    if (!UUID.test(id)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set("icCaseId", id)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    setMobilePane("canvas")
    setCanvasRefresh((value) => value + 1)
  }
  const canvasDocument = useMemo(() => {
    if (!investigation.loaded) return null
    try { return composeCanvasDocument({ thread: investigation.loaded.thread, work: canvasSources.work.data, projection: canvasSources.projection.data, underwriting: canvasSources.underwriting.data, ic: canvasSources.ic.data }) }
    catch { return null }
  }, [investigation.loaded, canvasSources.work.data, canvasSources.projection.data, canvasSources.underwriting.data, canvasSources.ic.data])
  const canvasErrors: CanvasSourceError[] = [
    ...(canvasSources.work.error ? [{ kind: "work" as const, message: canvasSources.work.error, retained: Boolean(canvasSources.work.data) }] : []),
    ...(canvasSources.projection.error ? [{ kind: "company_brain" as const, message: canvasSources.projection.error, retained: Boolean(canvasSources.projection.data) }] : []),
    ...(canvasSources.underwriting.error ? [{ kind: "underwriting" as const, message: canvasSources.underwriting.error, retained: Boolean(canvasSources.underwriting.data) }] : []),
    ...(canvasSources.ic.error ? [{ kind: "ic" as const, message: canvasSources.ic.error, retained: Boolean(canvasSources.ic.data) }] : []),
  ]
  const canvasLoading = canvasSources.work.status === "loading" || canvasSources.projection.status === "loading" || canvasSources.underwriting.status === "loading" || canvasSources.ic.status === "loading"
  const traceCanonicalWorkStatus = visibleTrace?.instructionId === latestInstructionId && latestInstructionMessage?.workId === canvasSources.work.data?.work.id
    ? canvasSources.work.data?.work.status ?? null : null
  const pendingActionSignature = canvasSources.work.data?.actions.filter((action) => ["pending", "needs_human_review", "blocked_integration_unavailable"].includes(action.status)).map((action) => `${action.id}:${action.status}`).join("|") ?? ""
  const presenceState = presenceFromRuntime({ voiceListening, submitting: busy || Boolean(visiblePending), trace: threadId ? visibleTrace : null, workStatus: threadId ? traceCanonicalWorkStatus : null })

  async function submit(instruction: string, channel: "text" | "voice"): Promise<void> {
    if (busy) return
    setBusy(true)
    setSubmissionError(null)
    setControlNotice(null)
    const instructionId = crypto.randomUUID()
    let currentThreadId = threadId
    try {
      if (redirecting) {
        if (!activeWorkId || !activeObjectiveId) throw new Error("No durable Objective is selected for redirection")
        const changed = await centropyPost<{ objective: { workId: string; state: string; revision: number } }>(`works/${activeWorkId}/objective`, { command: "redirect", objective: instruction, channel, instructionId, idempotencyKey: instructionId })
        if (changed.objective?.workId !== activeWorkId) throw new Error("Objective redirect returned a different Work")
        setRedirecting(false)
        setControlNotice({ scope: currentThreadId ?? noticeScope, message: `Objective redirected in Work revision ${changed.objective.revision}. Its updated state is linked to this Investigation.` })
        setRefreshToken((value) => value + 1)
        setCanvasRefresh((value) => value + 1)
        return
      }
      if (!currentThreadId) {
        const created = await createInvestigation(instruction.slice(0, 100))
        currentThreadId = created.id
        setThreadId(created.id)
        const carried = new URLSearchParams()
        if (canvasRoot) carried.set("root", JSON.stringify(canvasRoot))
        if (focusedObject && canvasRoot) carried.set("object", JSON.stringify(focusedObject))
        router.replace(`/centropy/investigations/${created.id}${carried.size ? `?${carried.toString()}` : ""}`)
        void refreshRecent()
      }
      setPending({ instructionId, threadId: currentThreadId, text: instruction, failed: false })
      startTrace(instructionId)
      const contextRoot = canvasRoot
      const selection = operatingSelection(contextRoot, focusedObject)
      const response = await centropyPost<SubmissionResponse>("actions", {
        instruction, instructionId, idempotencyKey: instructionId, threadId: currentThreadId, channel,
        activeContext: {
          version: 1, capturedAt: new Date().toISOString(), source: channel,
          ...selection,
          // Preserve an explicit empty selection for unscoped questions so the
          // validated context can be frozen on the Work input before planning.
          // The configured upstream currently accepts the legacy surface enum.
          excludedEntities: [], surface: { id: contextRoot ? "deals" : activeWorkId ? "work" : "home", spatialState: "canvas" }, filters: [],
        },
      })
      if (response.threadId !== currentThreadId || response.instructionId !== instructionId) throw new Error("The persisted response did not match this Investigation and instruction.")
      setResponseWork({ threadId: currentThreadId, workId: response.workId })
      if (response.projectionWarnings?.length) setSubmissionError({ scope: currentThreadId, message: "Work was accepted, but part of its conversation projection needs a refresh." })
      setRefreshToken((value) => value + 1)
      void refreshRecent()
    } catch (cause) {
      const recoverableWork = cause instanceof CentropyApiError && cause.details && typeof cause.details === "object" && "workId" in cause.details
        ? String((cause.details as { workId: unknown }).workId) : null
      if (recoverableWork && currentThreadId) setResponseWork({ threadId: currentThreadId, workId: recoverableWork })
      const definitivelyRejected = !recoverableWork && cause instanceof CentropyApiError && [400, 401, 403, 404, 422].includes(cause.status)
      if (definitivelyRejected) {
        traceRuntime.current?.stop()
        setTrace(null)
        setPending(null)
      } else setPending((current) => current?.instructionId === instructionId ? { ...current, failed: true } : current)
      setSubmissionError({ scope: currentThreadId ?? noticeScope, message: cause instanceof Error ? cause.message : "Instruction submission failed" })
      setRefreshToken((value) => value + 1)
      throw cause
    } finally { setBusy(false) }
  }

  async function startOutcomePack(packId: "deal_to_verified_closing_readiness" | "deal_request_resolution" | "critical_deal_dependency_resolution" | "general_operator_objective", mode: "shadow" | "approval" | "autopilot", title: string, input: Record<string, unknown>): Promise<void> {
    if (busy) throw new Error("Another instruction is still being submitted")
    if (!canvasRoot || canvasRoot.entityType !== "pe_deal") throw new Error("Select one exact Deal before starting a mission")
    setBusy(true)
    setSubmissionError(null)
    const instructionId = crypto.randomUUID()
    let currentThreadId = threadId
    try {
      if (!currentThreadId) {
        const created = await createInvestigation(title)
        currentThreadId = created.id
        setThreadId(created.id)
        router.replace(`/centropy/investigations/${created.id}?root=${encodeURIComponent(JSON.stringify(canvasRoot))}`)
        void refreshRecent()
      }
      setPending({ instructionId, threadId: currentThreadId, text: `Start ${title} for this Deal in ${mode} mode.`, failed: false })
      startTrace(instructionId)
      const response = await centropyPost<{ outcomePack?: { workId?: string; instructionId?: string }; threadId?: string; projectionWarnings?: Array<{ stage: string; code: string }> }>("outcome-packs", {
        packId,
        input,
        channel: "console",
        threadId: currentThreadId,
        instructionId,
        idempotencyKey: instructionId,
        activeContext: {
          version: 1,
          capturedAt: new Date().toISOString(),
          source: "console",
          selectedEntities: [{ entityType: "pe_deal", entityId: canvasRoot.entityId }],
          excludedEntities: [],
          surface: { id: "deals", spatialState: "canvas" },
          filters: [],
        },
      })
      if (response.threadId !== currentThreadId || response.outcomePack?.instructionId !== instructionId || !response.outcomePack.workId) throw new Error("Outcome Pack response did not confirm the selected Investigation and Work")
      setResponseWork({ threadId: currentThreadId, workId: response.outcomePack.workId })
      if (response.projectionWarnings?.length) {
        if (response.projectionWarnings.some((warning) => warning.stage === "conversation turn")) setPending(null)
        setSubmissionError({ scope: currentThreadId, message: "Work started, but some Investigation links need a refresh. Inspect the Work record before continuing." })
      }
      setRefreshToken((value) => value + 1)
      setCanvasRefresh((value) => value + 1)
      void refreshRecent()
    } catch (cause) {
      const recoverableWork = cause instanceof CentropyApiError && cause.details && typeof cause.details === "object" && "workId" in cause.details
        ? String((cause.details as { workId: unknown }).workId) : null
      if (recoverableWork && currentThreadId) setResponseWork({ threadId: currentThreadId, workId: recoverableWork })
      const definitivelyRejected = !recoverableWork && cause instanceof CentropyApiError && [400, 401, 403, 404, 409, 422].includes(cause.status)
      if (definitivelyRejected) {
        traceRuntime.current?.stop()
        setTrace(null)
        setPending(null)
      } else setPending((current) => current?.instructionId === instructionId ? { ...current, failed: true } : current)
      setSubmissionError({ scope: currentThreadId ?? noticeScope, message: cause instanceof Error ? cause.message : "Outcome Pack submission failed" })
      throw cause
    } finally { setBusy(false) }
  }

  async function stopInstruction() {
    if (!visibleTrace || visibleTrace.terminal || stopping) return
    setStopping(true)
    setSubmissionError(null)
    try { await centropyPost(`instructions/${visibleTrace.instructionId}/cancel`, {}); setRefreshToken((value) => value + 1) }
    catch (cause) { setSubmissionError({ scope: noticeScope, message: cause instanceof Error ? cause.message : "The instruction could not be stopped" }) }
    finally { setStopping(false) }
  }

  function openInvestigation(id: string) {
    drawer.current?.close()
    traceRuntime.current?.stop()
    setTrace(null)
    setPending(null)
    setResponseWork(null)
    setExplicitRoot(null)
    setFocusedObject(null)
    setRedirecting(false)
    setReplayWorkId(null)
    setThreadId(id)
    setMobilePane("thread")
    router.push(`/centropy/investigations/${id}`)
  }

  function openWorld() {
    setMobilePane("canvas")
    const params = new URLSearchParams()
    if (threadId) params.set("threadId", threadId)
    if (canvasRoot) params.set("root", JSON.stringify(canvasRoot))
    if (focusedObject && canvasRoot) params.set("object", JSON.stringify(focusedObject))
    if (!canvasRoot && routeClearsContext) params.set("context", "none")
    router.push(`/centropy/world${params.size ? `?${params.toString()}` : ""}`)
  }

  function openCanvas() {
    setMobilePane("canvas")
    setReplayWorkId(null)
    if (!threadId) { router.push("/centropy"); return }
    const params = new URLSearchParams()
    if (canvasRoot) params.set("root", JSON.stringify({ entityType: canvasRoot.entityType, entityId: canvasRoot.entityId }))
    if (focusedObject && canvasRoot) params.set("object", JSON.stringify(focusedObject))
    if (!canvasRoot && routeClearsContext) params.set("context", "none")
    router.push(`/centropy/investigations/${threadId}${params.size ? `?${params.toString()}` : ""}`)
  }

  function worldHref(root: PeWorldRootRef, object?: CompanyBrainObjectRef) {
    const params = new URLSearchParams()
    if (threadId) params.set("threadId", threadId)
    params.set("root", JSON.stringify({ entityType: root.entityType, entityId: root.entityId }))
    if (object) params.set("object", JSON.stringify(object))
    return `/centropy/world?${params.toString()}`
  }

  function clearOperatingContext() {
    setFocusedObject(null)
    setExplicitRoot(null)
    const params = new URLSearchParams(routeQuery)
    params.delete("root")
    params.delete("object")
    params.set("context", "none")
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  function selectWorldRoot(root: PeWorldRootRef) {
    setExplicitRoot(root)
    setFocusedObject(null)
    router.replace(worldHref(root))
  }

  function selectWorldObject(ref: CompanyBrainObjectRef) {
    if (!canvasRoot) return
    setFocusedObject(ref)
    router.replace(worldHref(canvasRoot, ref))
  }

  function askAboutWorldNode(node: CompanyBrainNode, prompt?: string) {
    setFocusedObject(node.ref)
    setComposerSuggestion({ id: crypto.randomUUID(), text: prompt ?? `Explain ${node.label} in this context. Show the sources, uncertainty, and consequences for the current objective.` })
    setMobilePane("thread")
  }

  if (auth.loading || auth.roleLoading && !auth.role) return <div className="ct-auth-state" role="status">Restoring your private workspace…</div>
  if (auth.authError || auth.roleError) return <div className="ct-auth-state"><LockKeyhole size={25} /><h1>Workspace unavailable</h1><p>{auth.authError ?? auth.roleError}</p><button type="button" onClick={auth.authError ? auth.retryAuth : auth.retryRole}>Retry</button><Link href="/centropy/login">Sign in again</Link></div>
  if (!auth.session) return <div className="ct-auth-state"><LockKeyhole size={25} /><h1>Your investment context stays private.</h1><p>Sign in to open your Investigations and verified work.</p><Link href="/centropy/login">Sign in <ArrowRight size={16} /></Link></div>
  if (auth.role !== "owner") return <div className="ct-auth-state"><h1>Workspace access unavailable</h1><p>The authenticated role has no active CENTROPY workspace.</p></div>

  return <div className="ct-app" data-mobile-pane={mobilePane}>
    <header className="ct-topbar">
      <Link className="ct-brand" href="/centropy" onClick={() => { traceRuntime.current?.stop(); setTrace(null); setPending(null); setThreadId(null); setResponseWork(null); setReplayWorkId(null); setExplicitRoot(null); setFocusedObject(null); setMobilePane("thread") }} aria-label="CENTROPY new Investigation"><CentropyPresence state={presenceState} size={26} animated={false} /><strong>CENTROPY</strong></Link>
      <div className="ct-topbar__actions">
        <button type="button" aria-label="Investigations" onClick={() => drawer.current?.showModal()}><History size={16} aria-hidden /><span>Investigations</span></button>
        {worldMode ? <button type="button" aria-label="Open Canvas" onClick={openCanvas}><PanelsTopLeft size={16} aria-hidden /><span>Canvas</span></button>
          : <button type="button" aria-label="Open WORLD" onClick={openWorld}><Globe2 size={16} aria-hidden /><span>WORLD</span></button>}
        <details className="ct-account"><summary aria-label="Account menu">{auth.session.user.email?.slice(0, 1).toUpperCase() ?? "•"}</summary><div><span>{auth.session.user.email}</span><button type="button" onClick={() => setSettingsOpen(true)}><Settings size={15} aria-hidden /> Settings</button><button type="button" onClick={() => void auth.signOut()}><LogOut size={15} aria-hidden /> Sign out</button></div></details>
      </div>
    </header>

    <div className="ct-mobile-switch" role="group" aria-label="Workspace view"><button type="button" aria-pressed={mobilePane === "thread"} onClick={() => setMobilePane("thread")}>Thread</button><button type="button" aria-pressed={mobilePane === "canvas"} onClick={() => setMobilePane("canvas")}>{worldMode ? "WORLD" : "Canvas"}</button></div>

    <div className="ct-split">
      <section className="ct-thread" aria-label="CENTROPY conversation">
        <header className="ct-thread__header"><div><span className="ct-eyebrow">INVESTIGATION</span><h1>{investigation.loaded?.thread.title || (threadId ? "Investigation" : "Start with an objective")}</h1></div><Link href="/centropy" aria-label="New Investigation" onClick={() => { traceRuntime.current?.stop(); setTrace(null); setPending(null); setThreadId(null); setResponseWork(null); setReplayWorkId(null); setExplicitRoot(null); setFocusedObject(null) }}><Plus size={18} /></Link></header>
        <div className="ct-thread__scroll">
          {investigation.status === "loading" ? <p className="ct-thread__notice" role="status">Restoring persisted conversation…</p> : null}
          {investigation.error ? <p className="ct-thread__notice ct-thread__notice--error" role="alert">{investigation.error} <button type="button" onClick={() => void investigation.refresh()}>Retry</button></p> : null}
          {investigation.hasOlder ? <button className="ct-thread__older" type="button" onClick={() => void investigation.loadOlder()} disabled={investigation.olderLoading}>{investigation.olderLoading ? "Loading earlier turns…" : "Load earlier turns"}</button> : null}
          {!messages.length && !threadId ? <div className="ct-thread__welcome"><span className="ct-thread__presence"><CentropyPresence state={presenceState} size={98} /></span><span className="ct-eyebrow">CENTROPY</span><h2>What needs to move forward?</h2><p>Ask about institutional context or give CENTROPY a bounded objective. The work and its evidence stay here.</p></div> : null}
          {messages.map((message) => <article className="ct-turn" data-role={message.role} key={message.id}><div className="ct-turn__identity"><span>{message.role === "user" ? "YOU" : "CENTROPY"}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><p>{message.originalText}</p>{message.workId && message.role === "assistant" ? <button type="button" className="ct-turn__link" onClick={() => setResponseWork(threadId ? { threadId, workId: message.workId! } : null)}>Inspect linked Work <ArrowRight size={13} /></button> : null}</article>)}
          {activeWorkId && canvasSources.work.data?.work.id === activeWorkId ? <VerifiedIcOutcome work={canvasSources.work.data} ic={canvasSources.ic.data} dealId={canvasRoot?.entityType === "pe_deal" ? canvasRoot.entityId : null} onOpenCanvas={() => setMobilePane("canvas")} /> : null}
          {activeWorkId && canvasSources.work.data?.work.id === activeWorkId ? <VerifiedUnderwritingOutcome work={canvasSources.work.data} underwriting={canvasSources.underwriting.data} dealId={canvasRoot?.entityType === "pe_deal" ? canvasRoot.entityId : null} onOpenCanvas={() => setMobilePane("canvas")} /> : null}
          {visiblePending && !messages.some((message) => message.instructionId === visiblePending.instructionId && message.role === "user") ? <article className="ct-turn" data-role="user" data-pending="true"><div className="ct-turn__identity"><span>YOU</span><span>{visiblePending.failed ? "Submission needs attention" : "Submitting"}</span></div><p>{visiblePending.text}</p></article> : null}
          {visibleTrace ? <ExecutionObject trace={visibleTrace} stopping={stopping} onStop={() => void stopInstruction()} canonicalWorkStatus={traceCanonicalWorkStatus} restoringHistory={!visiblePending && visibleTrace.instructionId === latestInstructionId} /> : null}
          {canvasRoot?.entityType === "pe_deal" || canvasSources.work.data?.outcomePack ? <Suspense fallback={<p className="ct-thread__notice">Reading bounded missions…</p>}><OutcomePacks root={canvasRoot} run={canvasSources.work.data?.work.id === activeWorkId ? canvasSources.work.data.outcomePack : null} onStart={startOutcomePack} /></Suspense> : null}
          {activeWorkId && canvasSources.work.data?.work.id === activeWorkId && ["failed", "recovery"].includes(canvasSources.work.data.work.status) ? <Suspense fallback={<p className="ct-thread__notice">Reading Work recovery…</p>}><WorkRecovery key={activeWorkId} aggregate={canvasSources.work.data} current={canvasSources.work.status === "ready"} onChanged={() => { setRefreshToken((value) => value + 1); setCanvasRefresh((value) => value + 1) }} /></Suspense> : null}
          {activeWorkId && canvasSources.work.data?.work.id === activeWorkId && pendingActionSignature ? <Suspense fallback={<p className="ct-thread__notice">Reading governed effects…</p>}><PendingEffects key={activeWorkId} aggregate={canvasSources.work.data} current={canvasSources.work.status === "ready"} refreshKey={pendingActionSignature} onChanged={() => { setRefreshToken((value) => value + 1); setCanvasRefresh((value) => value + 1) }} /></Suspense> : null}
          {activeWorkId ? <><button type="button" className="ct-workforce-toggle" aria-expanded={assignmentsOpen} onClick={() => setAssignmentsOpen((value) => !value)}>{assignmentsOpen ? "Close specialist assignments" : "Inspect specialist assignments"}</button>{assignmentsOpen ? <Suspense fallback={<p className="ct-thread__notice">Opening specialist assignments…</p>}><WorkforceAssignments key={activeWorkId} workId={activeWorkId} aggregate={canvasSources.work.data?.work.id === activeWorkId ? canvasSources.work.data : null} onChanged={() => { setRefreshToken((value) => value + 1); setCanvasRefresh((value) => value + 1) }} /></Suspense> : null}</> : null}
          {activeWorkId && activeObjectiveId ? <ObjectiveControl workId={activeWorkId} workStatus={canvasSources.work.status === "ready" && canvasSources.work.data?.work.id === activeWorkId ? canvasSources.work.data.work.status : null} refreshToken={refreshToken} redirecting={redirecting} onRedirectToggle={() => setRedirecting((value) => !value)} onChanged={() => { setRefreshToken((value) => value + 1); setCanvasRefresh((value) => value + 1) }} /> : null}
          {controlNotice?.scope === noticeScope ? <p className="ct-thread__notice" role="status">{controlNotice.message}</p> : null}
          {submissionError?.scope === noticeScope ? <p className="ct-thread__notice ct-thread__notice--error" role="alert">{submissionError.message}</p> : null}
          <div ref={messagesEnd} />
        </div>
        <Composer onSubmit={submit} busy={busy} contextLabel={focusedObject && canonicalWorldFocus(focusedObject) ? `${focusedObject.type.replaceAll("_", " ")} · ${focusedObject.id.slice(0, 8)}` : contextLabel} onClearContext={focusedObject || canvasRoot ? clearOperatingContext : undefined} redirecting={redirecting} onRedirectToggle={activeWorkId && activeObjectiveId ? () => setRedirecting((value) => !value) : undefined} suggestion={composerSuggestion} onVoiceListeningChange={setVoiceListening} />
      </section>

      <main className="ct-canvas" aria-label={worldMode ? "WORLD explorer" : "Investigation Canvas"}>
        {worldMode ? <WorldExplorer root={canvasRoot} projection={canvasSources.projection.data} projectionStatus={canvasSources.projection.status} projectionError={canvasSources.projection.error} initialObject={routeSelectedObject} onSelectRoot={selectWorldRoot} onSelectObject={selectWorldObject} onAsk={askAboutWorldNode} onRefresh={() => setCanvasRefresh((value) => value + 1)} />
          : threadId ? replayWorkId ? <CausalReplayPanel workId={replayWorkId} onClose={() => selectReplayWorkId(null)} /> : canvasDocument ? <CanvasDocument key={threadId} document={canvasDocument} root={canvasRoot} sourceErrors={canvasErrors} refreshing={canvasLoading} onRefresh={() => setCanvasRefresh((value) => value + 1)} onRefreshUnderwriting={() => setUnderwritingRefresh((value) => value + 1)} work={canvasSources.work.status === "ready" ? canvasSources.work.data : null} underwriting={canvasSources.underwriting.data} underwritingReady={canvasSources.underwriting.status === "ready"} ic={canvasSources.ic.data} icReady={canvasSources.ic.status === "ready"} onSelectIcCase={selectIcCase} onOpenReplay={selectReplayWorkId} onInspectEntity={(id) => { const node = canvasSources.projection.data?.nodes.find((item) => `${item.ref.type}:${item.ref.id}` === id); if (node && canvasRoot) { setFocusedObject(node.ref); router.push(worldHref(canvasRoot, node.ref)) } }} /> : investigation.status === "loading" || canvasLoading ? <p className="ct-canvas__loading" role="status">Assembling Canvas from persisted records…</p> : <div className="ct-canvas__invalid" role="alert"><h2>Canvas unavailable</h2><p>The typed document could not be composed from the current source records.</p><button type="button" onClick={() => setCanvasRefresh((value) => value + 1)}>Retry from sources</button></div>
          : <HomeCanvas recent={recent} recentError={recentError} onOpenInvestigation={openInvestigation} />}
      </main>
    </div>
    {settingsOpen ? <Suspense fallback={<p role="status">Opening Settings…</p>}><SettingsDialog onClose={() => setSettingsOpen(false)} onChanged={() => { setCanvasRefresh((value) => value + 1); setRefreshToken((value) => value + 1) }} /></Suspense> : null}

    <dialog className="ct-investigations" ref={drawer} aria-label="Recent Investigations"><header><div><span className="ct-eyebrow">CONTINUE WORK</span><h2>Investigations</h2></div><button type="button" onClick={() => drawer.current?.close()} aria-label="Close Investigations">×</button></header><button type="button" className="ct-investigations__new" onClick={() => { drawer.current?.close(); setThreadId(null); router.push("/centropy") }}><Plus size={17} aria-hidden /> New Investigation</button>{recentError ? <p role="alert">{recentError}</p> : null}<ol>{recent.map((item) => <li key={item.id}><button type="button" onClick={() => openInvestigation(item.id)}><strong>{item.title || "Untitled Investigation"}</strong><span>{item.activeWorkId ? "Active Work · " : ""}{formatDate(item.lastActivityAt)}</span></button></li>)}</ol></dialog>
  </div>
}
