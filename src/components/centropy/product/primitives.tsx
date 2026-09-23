"use client"

import { useRef, type KeyboardEvent, type ReactNode } from "react"
import { AlertTriangle, ArrowUpRight, DatabaseZap, FileSearch, RefreshCw } from "lucide-react"
import type { ProductAttentionRow } from "./attention-model"
import { aggregateSourceState, truthStateLabel, type ProductTruthState, type SourceHealthSnapshot } from "./source-health"

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="pw-page-header"><div><span>{eyebrow}</span><h1>{title}</h1>{description ? <p>{description}</p> : null}</div>{actions ? <div className="pw-page-header__actions">{actions}</div> : null}</header>
}

export function ContextHeader({ title, facts, asOf }: { title: string; facts: Array<{ label: string; value: ReactNode }>; asOf: string | null }) {
  return <header className="pw-context-header"><div className="pw-context-header__title"><span>ACTIVE INVESTMENT</span><h1>{title}</h1></div><dl>{facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl><time dateTime={asOf ?? undefined}>As of {asOf ? new Date(asOf).toLocaleString() : "UNKNOWN"}</time></header>
}

export function DataTable({ label, children, dense = true }: { label: string; children: ReactNode; dense?: boolean }) {
  return <div className="pw-table-wrap" data-dense={dense ? "true" : "false"}><table aria-label={label}>{children}</table></div>
}

export function EntityLink({ children, onOpen, label, muted = false }: { children: ReactNode; onOpen: () => void; label?: string; muted?: boolean }) {
  return <button className="pw-entity-link" data-muted={muted ? "true" : undefined} type="button" onClick={onOpen} aria-label={label}>{children}<ArrowUpRight size={12} aria-hidden /></button>
}

function semanticTone(value: string): "blocked" | "attention" | "active" | "verified" | "neutral" {
  if (/blocked|failed|invalid|critical|reject|denied|conflict|overdue|non_convergent/i.test(value)) return "blocked"
  if (/attention|stale|pending|open|question|condition|partial|await|unknown|waiv/i.test(value)) return "attention"
  if (/active|motion|working|running|executing|voting|planning|claimed|queued/i.test(value)) return "active"
  if (/verified|complete|completed|valid|succeeded|approved|resolved|satisfied|final|decided/i.test(value)) return "verified"
  return "neutral"
}

export function Status({ value, label }: { value: string | null | undefined; label?: string }) {
  const displayed = value?.trim() || "UNKNOWN"
  return <span className="pw-status" data-tone={semanticTone(displayed)} aria-label={label ? `${label}: ${displayed}` : undefined}><i />{displayed.replaceAll("_", " ")}</span>
}

export function TruthState({ state, compact = false }: { state: ProductTruthState; compact?: boolean }) {
  return <span className="pw-truth" data-state={state} data-compact={compact ? "true" : undefined}><i />{truthStateLabel(state)}</span>
}

export function EvidenceLink({ children, onOpen }: { children: ReactNode; onOpen: () => void }) {
  return <button className="pw-evidence-link" type="button" onClick={onOpen}><FileSearch size={13} aria-hidden />{children}</button>
}

export function AttentionRow({ item, onInspect, onOpen, onDeal }: {
  item: ProductAttentionRow
  onInspect: () => void
  onOpen: () => void
  onDeal?: () => void
}) {
  const key = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key === "Enter") { event.preventDefault(); onOpen() }
    if (event.key === " ") { event.preventDefault(); onInspect() }
  }
  return <tr className="pw-attention-row" tabIndex={0} onKeyDown={key} data-category={item.category}>
    <td><button type="button" className="pw-row-inspect" onClick={onInspect}><Status value={item.category} /><span>{item.impact}</span></button></td>
    <td>{onDeal ? <button type="button" className="pw-entity-link" onClick={onDeal}><strong>{item.deal}</strong><ArrowUpRight size={12} /></button> : <strong>{item.deal}</strong>}</td>
    <td>{item.object}</td>
    <td><p>{item.reason}</p><small>{item.impact}</small></td>
    <td>{item.owner}</td>
    <td>{item.deadline ? <time dateTime={item.deadline}>{new Date(item.deadline).toLocaleDateString()}</time> : "No recorded deadline"}</td>
    <td><TruthState state={item.evidenceState} compact /></td>
    <td><button type="button" className="pw-next-action" onClick={onOpen}>{item.nextAction}<ArrowUpRight size={12} /></button></td>
  </tr>
}

export function ActionBar({ children, label = "Available actions" }: { children: ReactNode; label?: string }) {
  return <div className="pw-action-bar" aria-label={label}>{children}</div>
}

export function SourceHealth({ sources, onRefresh }: { sources: SourceHealthSnapshot[]; onRefresh: () => void }) {
  const state = aggregateSourceState(sources)
  const details = useRef<HTMLDetailsElement>(null)
  function refresh() {
    onRefresh()
    details.current?.removeAttribute("open")
  }
  return <details ref={details} className="pw-source-health"><summary><DatabaseZap size={14} /><TruthState state={state} compact /><span>Sources</span></summary><div className="pw-source-health__panel"><header><strong>Source health</strong><button type="button" onClick={refresh}><RefreshCw size={13} /> Refresh</button></header>{sources.map((source) => <article key={source.key}><div><strong>{source.label}</strong><TruthState state={source.state} compact /></div><p>{source.detail}</p><time dateTime={source.lastConfirmedAt ?? undefined}>{source.lastConfirmedAt ? `Last confirmed ${new Date(source.lastConfirmedAt).toLocaleString()}` : "Never confirmed"}</time></article>)}</div></details>
}

export function Inspector({ label, children, open = false }: { label: string; children: ReactNode; open?: boolean }) {
  return <aside className="pw-inspector" aria-label={label} data-open={open ? "true" : "false"}>{children}</aside>
}

export function EmptyState({ title, detail, icon }: { title: string; detail: string; icon?: ReactNode }) {
  return <section className="pw-empty-state">{icon}<strong>{title}</strong><p>{detail}</p></section>
}

export function ErrorState({ title, detail, state = "UNAVAILABLE", onRetry }: { title: string; detail: string; state?: ProductTruthState; onRetry?: () => void }) {
  return <section className="pw-error-state" role="status"><AlertTriangle size={17} /><div><TruthState state={state} /><strong>{title}</strong><p>{detail}</p></div>{onRetry ? <button type="button" onClick={onRetry}><RefreshCw size={13} /> Retry</button> : null}</section>
}

export function Skeleton({ rows = 4, label = "Loading verified data" }: { rows?: number; label?: string }) {
  return <div className="pw-skeleton" role="status" aria-label={label}>{Array.from({ length: rows }, (_, index) => <span key={index} />)}</div>
}
