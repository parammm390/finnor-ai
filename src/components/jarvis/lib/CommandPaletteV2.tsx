"use client"

// D7.T2 — one keyboard-first surface for navigation, tenant-scoped retrieval, and
// instruct. It uses the normal /actions gate; rendering a card is never execution.

import { useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Activity, Clock, Command, FileText, Home, Search, Send, Workflow } from "lucide-react"
import { jarvisClient, JarvisApiError } from "@/lib/jarvis-client"
import { ActionRenderer } from "../ui/renderers/ActionRenderer"
import { ErrorState, EmptyState } from "../ui/primitives"
import { Press } from "../ui/motion/primitives"
import { useJarvis } from "./data-core"

type Planned = { id: string; actionType: string; payload: Record<string, unknown>; status: string; createdAt: string }
type Mode = "navigate" | "search" | "instruct"

export function useCommandPaletteV2() {
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setOpen((v) => !v) } }
    window.addEventListener("keydown", onKey)
    setReady(true)
    return () => { setReady(false); window.removeEventListener("keydown", onKey) }
  }, [])
  return { open, setOpen, ready }
}

export function CommandPaletteV2({
  onClose,
  onNavigate,
  onOpenOps,
  onOpenRecentThreads,
  onInstruct,
}: {
  onClose: () => void
  onNavigate: (scene: "overview" | "pipeline") => void
  /** jarvis-v3 P4.T7 — "⌘K → Ops": a single deliberate destination, never a
   *  landing page. Optional and additive: /jarvis/bridge's own `chooseScene`
   *  (typed `SceneId = "overview" | "pipeline"`, no "ops" value) is untouched
   *  by not supplying this; /jarvis/next's CommandRail supplies it to open the
   *  real OpsPanel overlay instead of navigating anywhere. */
  onOpenOps?: () => void
  /** jarvis-v3 P5.T8 — "⌘K → recent threads" (§8 P5.T8), same additive
   *  pattern as `onOpenOps` above: /jarvis/bridge never supplies this. */
  onOpenRecentThreads?: () => void
  /** The Instruction Thread's single submission path. When supplied, Cmd-K
   *  must create the same trace/thread/run state as the pinned rail rather than
   *  posting directly and injecting an optimistic tenant-wide pending row. */
  onInstruct?: (text: string) => Promise<void>
}) {
  const data = useJarvis(); const reduced = useReducedMotion(); const input = useRef<HTMLInputElement>(null); const dialog = useRef<HTMLElement>(null); const priorFocus = useRef<HTMLElement | null>(null)
  const [mode, setMode] = useState<Mode>("navigate"); const [query, setQuery] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [planned, setPlanned] = useState<Planned[]>([]); const [results, setResults] = useState<string[]>([])
  useEffect(() => { priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; input.current?.focus(); return () => priorFocus.current?.focus() }, [])
  const trapFocus = (event: React.KeyboardEvent) => { if (event.key === "Escape") { onClose(); return }; if (event.key !== "Tab" || !dialog.current) return; const all = dialog.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"); if (!all.length) return; const first = all[0]!; const last = all[all.length - 1]!; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() } }
  const navigation = useMemo(
    () =>
      ([
        { label: "Overview", scene: "overview" as const, icon: Home },
        { label: "Pipeline theater", scene: "pipeline" as const, icon: Workflow },
        ...(onOpenOps ? [{ label: "Ops", scene: "ops" as const, icon: Activity }] : []),
        ...(onOpenRecentThreads ? [{ label: "Recent threads", scene: "recent-threads" as const, icon: Clock }] : []),
      ]).filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    [query, onOpenOps, onOpenRecentThreads],
  )
  function selectNavigation(scene: "overview" | "pipeline" | "ops" | "recent-threads") {
    if (scene === "ops") onOpenOps?.()
    else if (scene === "recent-threads") onOpenRecentThreads?.()
    else onNavigate(scene)
    onClose()
  }
  async function search() { setBusy(true); setError(null); try { const [receipts, households, runs] = await Promise.all([jarvisClient.receipts({}), jarvisClient.resources("households"), jarvisClient.workflowRuns()]); const q = query.toLowerCase(); const matched = [`${receipts.receipts.filter((r) => `${r.objective} ${r.id}`.toLowerCase().includes(q)).length} receipts`, `${households.rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)).length} households`, `${runs.runs.filter((r) => JSON.stringify(r).toLowerCase().includes(q)).length} runs`]; setResults(matched) } catch (e) { setError(e instanceof Error ? e.message : "Search failed") } finally { setBusy(false) } }
  async function instruct() {
    const instruction = query.trim()
    if (!instruction) return
    setBusy(true)
    setError(null)
    try {
      if (onInstruct) {
        await onInstruct(instruction)
        onClose()
        return
      }
      const result = await jarvisClient.submitAction({ instruction, channel: "console" }) as { planned: Planned[] }
      const actions = result.planned ?? []
      setPlanned(actions)
      data.injectOptimisticPending(actions.map((action) => ({ ...action, summary: null, groundedPayload: undefined })))
    } catch (e) {
      setError(e instanceof JarvisApiError && e.status === 401 ? "Sign in to plan an instruction." : e instanceof Error ? e.message : "Instruction could not be planned.")
    } finally {
      setBusy(false)
    }
  }
  const submit = () => mode === "navigate" ? navigation[0] && selectNavigation(navigation[0].scene) : mode === "search" ? void search() : void instruct()
  return <AnimatePresence><motion.div className="pointer-events-auto fixed inset-0 z-[100] flex items-start justify-center bg-black/70 px-4 pt-[12vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}><motion.section ref={dialog} role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={trapFocus} className="w-full max-w-2xl overflow-hidden rounded-2xl border border-cyan-300/30 bg-[#07101d] shadow-[0_25px_100px_rgba(0,0,0,.6)]" initial={{ y: -10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -10, opacity: 0 }} transition={reduced ? { duration: .1 } : { type: "spring", stiffness: 340, damping: 28 }} onMouseDown={(event) => event.stopPropagation()}>
    <div className="flex border-b border-white/10"><PaletteTab active={mode === "navigate"} onClick={() => setMode("navigate")} label="Navigate"/><PaletteTab active={mode === "search"} onClick={() => setMode("search")} label="Search"/><PaletteTab active={mode === "instruct"} onClick={() => setMode("instruct")} label="Instruct"/></div>
    {/* F2.T3 — FLOW-48 CommandGravity: real focus state (`focus-within`, no JS) lifts
        + glows this bar. The modal's own `bg-black/70` backdrop above already dims
        the whole stage the instant the palette opens (which happens in the same beat
        as this input auto-focusing on mount) — a real, honest superset of the plan's
        literal "8%", not a second competing dim. */}
    <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 transition-[box-shadow,transform] duration-200 focus-within:-translate-y-px focus-within:shadow-[0_0_0_1px_rgba(34,211,238,0.5),0_0_28px_-6px_rgba(34,211,238,0.35)]"><Command className="h-4 w-4 text-cyan-300"/><input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit() } }} placeholder={mode === "instruct" ? "Describe what you need — JARVIS will propose actions for approval" : mode === "search" ? "Search receipts, households, and runs" : "Jump to a scene"} className="h-7 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"/><Press className="rounded-lg"><button onClick={submit} disabled={busy} className="rounded-lg bg-cyan-300 px-2.5 py-1 j-fs-micro font-black text-slate-950 disabled:opacity-40">{mode === "instruct" ? <Send className="h-3.5 w-3.5"/> : <Search className="h-3.5 w-3.5"/>}</button></Press></div>
    <div className="max-h-[55vh] overflow-y-auto p-3">{error && <ErrorState message={error} onRetry={submit}/>} {mode === "navigate" && navigation.map(({ label, scene, icon: Icon }) => <button key={scene} onClick={() => selectNavigation(scene)} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-white hover:bg-cyan-300/10"><Icon className="h-4 w-4 text-cyan-300"/>{label}</button>)} {mode === "search" && results.length > 0 && <div className="space-y-2">{results.map((result) => <div key={result} className="rounded-lg border border-white/8 bg-white/[.03] px-3 py-2 text-xs text-white/70">{result}</div>)}</div>} {mode === "instruct" && (planned.length ? <div className="space-y-3"><p className="j-fs-micro text-teal-200">Proposed actions — press Enter on an action in the Approval Cockpit to review its gate. Nothing has executed here.</p>{planned.map((action) => <ActionRenderer key={action.id} actionType={action.actionType} payload={action.payload} compact />)}</div> : <EmptyState title="Describe the outcome" description="JARVIS will plan real actions, then send consequential work to the normal approval gate." />)}</div>
    <div className="border-t border-white/10 px-4 py-2 j-fs-micro uppercase tracking-widest text-white/35">⌘K close · enter select · approval is always explicit</div>
  </motion.section></motion.div></AnimatePresence>
}
function PaletteTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) { return <Press><button onClick={onClick} className={`px-4 py-2 j-fs-micro font-black uppercase tracking-wider ${active ? "border-b-2 border-cyan-300 text-cyan-200" : "text-white/40"}`}>{label}</button></Press> }
