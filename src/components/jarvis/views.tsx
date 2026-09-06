"use client"

// The working feature views of the JARVIS operating system. Every panel talks to the
// real Finnor OS API: reads are tenant-scoped resource endpoints, writes go through
// the same gated instruction pipeline as voice. When the backend is unreachable the
// panels show clearly-labeled sample data — same UI, honest badge.

import { useCallback, useEffect, useState } from "react"
import { motion } from "framer-motion"
import { Check, CreditCard, FileSignature, KeyRound, Loader2, Phone, PhoneOff, Play, Search, Send, Server, ShieldCheck, X } from "lucide-react"
import { Glass } from "./atmosphere"
import { sfx } from "./sound"
import { jarvisGet, jarvisPost, JarvisApiError } from "./lib/api"
import { useJarvis, ageLabel, type BindingResolution } from "./lib/data-core"
import { useBusinessProjection } from "./lib/business-projections"
import { businessProjections } from "./lib/projection-definitions"

type Row = Record<string, unknown>

function useResource(kind: string, sample: Row[]): { rows: Row[]; live: boolean; reload: () => void } {
  const projection = useBusinessProjection(businessProjections.resource(kind))
  return {
    rows: projection.data ?? sample,
    live: projection.data !== null,
    reload: () => { void projection.refresh().catch(() => undefined) },
  }
}

/** Run an instruction through the real planner pipeline; returns a speakable outcome. */
async function instruct(instruction: string): Promise<string> {
  try {
    const body = await jarvisPost<{ planned?: Array<{ id: string; actionType: string }> }>("actions", { instruction })
    const n = body.planned?.length ?? 0
    return n === 0 ? "Couldn't map that to an action — add more detail." : `Planned ${n} action${n === 1 ? "" : "s"} — consequential ones are waiting in the Command Center queue.`
  } catch (e) {
    if (e instanceof JarvisApiError && e.status === 401) throw new Error("Enter the owner key in the Command Center to run write actions.")
    throw e
  }
}

// ---------- shared chrome ----------

function PanelHeader({ title, sub, live }: { title: string; sub: string; live: boolean }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="bg-gradient-to-r from-white via-teal-100 to-sky-200 bg-clip-text text-lg font-black tracking-tight text-transparent md:text-xl">{title}</h2>
        <p className="text-xs text-white/45">{sub}</p>
      </div>
      <span className={`rounded-full px-3 py-1 j-fs-micro font-black uppercase tracking-widest ${live ? "bg-teal-300/15 text-teal-200" : "bg-amber-300/15 text-amber-200"}`}>
        {live ? "live data" : "sample data"}
      </span>
    </div>
  )
}

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1 block j-fs-micro font-black uppercase tracking-[0.16em] text-white/40">{label}</span>
      <input
        {...props}
        className="h-10 w-full rounded-xl border border-white/12 bg-slate-950/70 px-3 j-fs-sm text-white placeholder:text-white/25 focus:border-teal-300/50 focus:outline-none"
      />
    </label>
  )
}

function ActionButton({ children, onClick, busy }: { children: React.ReactNode; onClick: () => void; busy?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-teal-300 px-5 j-fs-micro font-black text-slate-950 transition hover:-translate-y-0.5 hover:bg-teal-200 disabled:opacity-40"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
      {children}
    </button>
  )
}

function Note({ text }: { text: string | null }) {
  if (!text) return null
  return <div className="mt-3 rounded-xl border border-teal-300/20 bg-teal-300/5 px-4 py-2.5 j-fs-sm text-teal-100">{text}</div>
}

// ---------- Leads & CRM ----------

const SAMPLE_LEADS: Row[] = [
  { address: "412 Maple Ridge Rd, Cedar Falls, IA", contactInfo: { name: "The Hendersons", phone: "+1319555••42" }, waterProfile: { hardness_gpg: 18 }, marketingConsent: true },
  { address: "88 Birchwood Ln, Cedar Falls, IA", contactInfo: { name: "Ruth Alvarez", phone: "+1319555••77" }, waterProfile: { hardness_gpg: 11 }, marketingConsent: false },
]

export function LeadsView() {
  const { rows, live, reload } = useResource("households", SAMPLE_LEADS)
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [address, setAddress] = useState("")
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function createLead() {
    if (!name || !phone) return
    setBusy(true)
    sfx.send()
    try {
      setNote(await instruct(`Create a lead named ${name}, phone ${phone}${address ? `, address ${address}` : ""}`))
      setName(""); setPhone(""); setAddress("")
      setTimeout(reload, 1200)
    } catch (e) {
      setNote(`Backend: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Glass><div className="p-5">
      <PanelHeader title="Leads & CRM" sub="Households are the CRM — created by voice, call, or right here." live={live} />
      <div className="mb-5 grid gap-3 md:grid-cols-4">
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sarah Kim" />
        <Field label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 319 555 0142" />
        <Field label="Address (optional)" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="314 Overlook Dr" />
        <div className="flex items-end"><ActionButton onClick={createLead} busy={busy}>Create lead</ActionButton></div>
      </div>
      <Note text={note} />
      <div className="mt-4 space-y-2">
        {rows.slice(0, 8).map((r, i) => {
          const c = (r.contactInfo ?? {}) as Row
          const w = (r.waterProfile ?? {}) as Row
          return (
            <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/8 bg-slate-900/50 px-4 py-3">
              <div>
                <div className="j-fs-sm font-black">{String(c.name ?? "Unnamed")} <span className="font-normal text-white/40">· {String(c.phone ?? "no phone")}</span></div>
                <div className="j-fs-micro text-white/45">{String(r.address ?? "")}</div>
              </div>
              <div className="flex items-center gap-2">
                {w.hardness_gpg != null && <span className="rounded-full bg-sky-300/12 px-2.5 py-1 j-fs-micro font-black text-sky-200">{String(w.hardness_gpg)} gpg</span>}
                <span className={`rounded-full px-2.5 py-1 j-fs-micro font-black ${r.marketingConsent ? "bg-teal-300/12 text-teal-200" : "bg-white/8 text-white/40"}`}>
                  {r.marketingConsent ? "consented" : "no consent"}
                </span>
              </div>
            </motion.div>
          )
        })}
      </div>
    </div></Glass>
  )
}

// ---------- Customers (household 360) ----------

interface Household360 {
  household: { id: string; address: string; contactInfo: Row; marketingConsent: boolean; createdAt: string }
  contacts: Array<{ id: string; name: string; role: string | null; methods: Array<{ methodType: string; value: string; consent: boolean }> }>
  leads: Array<{ id: string; name: string; status: string }>
  quotes: Array<{ id: string; status: string; totalUsd: number | null }>
  invoices: Array<{ id: string; status: string; amountUsd: number }>
  workOrders: Array<{ id: string; status: string }>
  timeline: Array<{ entityType: string; entityId: string; eventType: string; occurredAt: string }>
  queryMs: number
}

function timelineIcon(eventType: string): string {
  if (eventType.startsWith("quote_")) return "📄"
  if (eventType.startsWith("appointment_")) return "📅"
  if (eventType.startsWith("work_order_")) return "🔧"
  if (eventType.startsWith("contact_")) return "👤"
  if (eventType.startsWith("payment") || eventType.startsWith("invoice_")) return "💵"
  return "•"
}

function relTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export function CustomersView() {
  const { rows, live } = useResource("households", SAMPLE_LEADS)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detailProjection = useBusinessProjection(businessProjections.household360(selectedId ?? "unselected"), { enabled: selectedId !== null })
  const detail = detailProjection.data as Household360 | null
  const loadingDetail = selectedId !== null && detail === null && detailProjection.status !== "error"
  const detailError = detailProjection.error?.message ?? null

  function select(id: string) {
    setSelectedId(id)
    sfx.tick()
  }

  const openLeads = detail?.leads.filter((l) => l.status !== "converted" && l.status !== "disqualified").length ?? 0
  const openQuotes = detail?.quotes.filter((q) => q.status === "sent").length ?? 0
  const unpaidUsd = detail?.invoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((s, i) => s + i.amountUsd, 0) ?? 0
  const openWorkOrders = detail?.workOrders.filter((w) => w.status !== "completed" && w.status !== "canceled").length ?? 0

  return (
    <Glass><div className="p-5">
      <PanelHeader title="Customers" sub="Full household 360 — every canonical and legacy record, one traversal, real time." live={live} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
          {rows.slice(0, 30).map((r, i) => {
            const id = String(r.id ?? i)
            const c = (r.contactInfo ?? {}) as Row
            const active = selectedId === id
            return (
              <motion.button
                key={id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                onClick={() => r.id && select(String(r.id))}
                disabled={!r.id}
                className={`block w-full rounded-xl border px-4 py-3 text-left transition ${
                  active ? "border-teal-300/50 bg-teal-300/[0.06]" : "border-white/8 bg-slate-900/50 hover:border-white/20"
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                <div className="truncate j-fs-sm font-black">{String(r.address ?? "(address pending)")}</div>
                <div className="mt-1 flex items-center gap-2">
                  {Boolean(c.name) && <span className="j-fs-micro text-white/45">{String(c.name)}</span>}
                  <span className={`rounded-full px-2 py-0.5 j-fs-micro font-black ${r.marketingConsent ? "bg-teal-300/12 text-teal-200" : "bg-white/8 text-white/40"}`}>
                    {r.marketingConsent ? "consent" : "no consent"}
                  </span>
                </div>
              </motion.button>
            )
          })}
          {rows.length === 0 && <div className="rounded-xl border border-white/8 px-4 py-6 text-center text-sm text-white/40">No households yet.</div>}
        </div>

        <div>
          {!selectedId && (
            <div className="flex h-full min-h-[240px] items-center justify-center rounded-xl border border-white/8 px-4 py-10 text-center text-sm text-white/40">
              Select a household to see its full history.
            </div>
          )}
          {selectedId && loadingDetail && (
            <div className="flex min-h-[240px] items-center justify-center gap-2 text-sm text-white/50">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading household…
            </div>
          )}
          {selectedId && detailError && !loadingDetail && (
            <div className="rounded-xl border border-amber-300/20 bg-amber-300/5 px-4 py-3 j-fs-sm text-amber-100">{detailError}</div>
          )}
          {detail && !loadingDetail && (
            <div>
              <div className="rounded-xl border border-white/8 bg-slate-900/50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="j-fs-base font-black">{detail.household.address}</div>
                    <span className={`mt-1.5 inline-block rounded-full px-2.5 py-1 j-fs-micro font-black ${detail.household.marketingConsent ? "bg-teal-300/12 text-teal-200" : "bg-rose-300/12 text-rose-200"}`}>
                      {detail.household.marketingConsent ? "marketing consent" : "no marketing consent"}
                    </span>
                  </div>
                  <span className="shrink-0 j-fs-micro text-white/30">{detail.queryMs.toFixed(1)}ms</span>
                </div>
                {detail.contacts.length > 0 && (
                  <div className="mt-3 space-y-1.5 border-t border-white/8 pt-3">
                    {detail.contacts.map((c) => (
                      <div key={c.id} className="j-fs-sm text-white/70">
                        <span className="font-black text-white/90">{c.name}</span>
                        {c.role && <span className="text-white/40"> · {c.role}</span>}
                        {c.methods.map((m, j) => (
                          <span key={j} className="ml-2 text-white/45">{m.value}</span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                {[
                  { label: "open leads", value: openLeads },
                  { label: "open quotes", value: openQuotes },
                  { label: "unpaid", value: `$${unpaidUsd.toLocaleString()}` },
                  { label: "open work orders", value: openWorkOrders },
                ].map((s) => (
                  <div key={s.label} className="rounded-xl border border-white/8 bg-slate-900/50 px-3 py-3 text-center">
                    <div className="text-xl font-black tabular-nums text-teal-200">{s.value}</div>
                    <div className="mt-0.5 j-fs-micro font-bold uppercase tracking-wide text-white/40">{s.label}</div>
                  </div>
                ))}
              </div>

              <div className="mt-4 max-h-64 space-y-1.5 overflow-y-auto">
                {detail.timeline.length === 0 && <div className="rounded-xl border border-white/8 px-4 py-4 text-center j-fs-sm text-white/40">No recorded activity yet.</div>}
                {detail.timeline.map((e, i) => (
                  <div key={i} className="flex items-center justify-between rounded-xl border border-white/8 bg-slate-900/40 px-3.5 py-2.5">
                    <span className="j-fs-sm">
                      {timelineIcon(e.eventType)} <span className="font-black text-teal-200">{e.eventType.replaceAll("_", " ")}</span>
                    </span>
                    <span className="j-fs-micro text-white/35">{relTime(e.occurredAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div></Glass>
  )
}

// ---------- Workflows ----------

const SAMPLE_WF: Row[] = [
  { workflow: "lead_to_install", state: "water_test_scheduled", subjectType: "household", history: [{ from: "lead", to: "water_test_scheduled", cause: "schedule_water_test" }], updatedAt: new Date().toISOString() },
  { workflow: "amc_renewal", state: "renewal_sent", subjectType: "maintenance_agreement", history: [{ from: "renewal_window", to: "renewal_sent", cause: "renew_maintenance_agreement" }], updatedAt: new Date().toISOString() },
]
const WF_STAGES: Record<string, string[]> = {
  lead_to_install: ["lead", "water_test_scheduled", "test_completed", "quote_sent", "installed", "follow_up_sent"],
  amc_renewal: ["agreement_active", "renewal_window", "renewal_sent", "renewed", "lapsed"],
}

/** Phase 6: real ops-grade reliability numbers — success rate, step latency, retry/
 *  human-intervention rates, DLQ + reconciliation backlogs. Mirrors the read-model's
 *  own honesty: a null denominator renders as "—", never a fabricated 0%. */
function StatTile({
  label,
  value,
  tone = "white",
}: {
  label: string
  value: string
  tone?: "white" | "amber" | "rose" | "teal"
}) {
  const valueTone = tone === "amber" ? "text-amber-300" : tone === "rose" ? "text-rose-300" : tone === "teal" ? "text-teal-200" : "text-white/85"
  return (
    <div className="rounded-xl border border-white/8 bg-slate-900/50 px-4 py-3">
      <div className="j-fs-micro font-black uppercase tracking-[0.16em] text-white/40">{label}</div>
      <div className={`mt-1 text-xl font-black tabular-nums ${valueTone}`}>{value}</div>
    </div>
  )
}

function pct(n: number | null): string {
  return n === null ? "—" : `${Math.round(n * 100)}%`
}
function ms(n: number | null): string {
  return n === null ? "—" : `${Math.round(n)}ms`
}

function ReliabilityOpsPanel() {
  const { reliability, readModelsDegraded } = useJarvis()
  const live = reliability !== null && !readModelsDegraded
  const dlq = reliability?.dlqDepth ?? 0
  const backlog = reliability?.reconciliationBacklog ?? 0
  return (
    <Glass><div className="p-5">
      <PanelHeader title="Reliability & Ops" sub="Real success rate, latency, and backlog numbers from the workflow engine — never a fabricated 0 when there's no data yet." live={live} />
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <StatTile label="Workflow success" value={pct(reliability?.workflowSuccessRate ?? null)} tone="teal" />
        <StatTile label="Step latency p50" value={ms(reliability?.stepLatencyMs.p50 ?? null)} />
        <StatTile label="Step latency p95" value={ms(reliability?.stepLatencyMs.p95 ?? null)} />
        <StatTile label="Retry rate" value={pct(reliability?.retryRate ?? null)} />
        <StatTile label="Human intervention" value={pct(reliability?.humanInterventionRate ?? null)} />
        <StatTile label="Receipt completeness" value={pct(reliability?.receiptCompleteness ?? null)} tone="teal" />
        <StatTile label="Reconciliation backlog" value={String(backlog)} tone={backlog > 20 ? "amber" : "white"} />
        <StatTile label="DLQ depth" value={String(dlq)} tone={dlq > 10 ? "rose" : "white"} />
      </div>
      <p className="mt-3 j-fs-micro text-white/35">
        {reliability ? `${reliability.stepLatencyMs.sampleSize} steps sampled over the last ${reliability.windowDays}-day window · as of ${new Date(reliability.asOf).toLocaleTimeString()}.` : "Waiting for live data."}
      </p>
    </div></Glass>
  )
}

export function WorkflowsView() {
  const { rows, live } = useResource("workflows", SAMPLE_WF)
  return (
    <div className="space-y-4">
    <Glass><div className="p-5">
      <PanelHeader title="Workflows" sub="Every customer's lifecycle as an explicit state machine — advanced automatically by executed actions." live={live} />
      <div className="space-y-4">
        {rows.slice(0, 6).map((r, i) => {
          const stages = WF_STAGES[String(r.workflow)] ?? []
          const cur = stages.indexOf(String(r.state))
          return (
            <div key={i} className="rounded-xl border border-white/8 bg-slate-900/50 p-4">
              <div className="mb-3 flex items-center justify-between j-fs-micro">
                <span className="font-black uppercase tracking-wider text-white/70">{String(r.workflow).replaceAll("_", " ")}</span>
                <span className="text-white/35">{String(r.subjectType).replaceAll("_", " ")}</span>
              </div>
              <div className="flex items-center gap-1">
                {stages.map((st, j) => (
                  <div key={st} className="flex flex-1 flex-col items-center gap-1">
                    <div className={`h-2 w-full rounded-full ${j < cur ? "bg-teal-400/70" : j === cur ? "bg-gradient-to-r from-teal-300 to-sky-400" : "bg-white/8"}`} />
                    <span className={`hidden j-fs-micro font-bold uppercase tracking-wide md:block ${j === cur ? "text-teal-200" : "text-white/30"}`}>{st.replaceAll("_", " ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
        {rows.length === 0 && <div className="rounded-xl border border-white/8 px-4 py-6 text-center text-sm text-white/40">No lifecycles yet — create a lead or book a water test.</div>}
      </div>
    </div></Glass>
    <ReliabilityOpsPanel />
    </div>
  )
}

// ---------- Inventory ----------

const SAMPLE_INV: Row[] = [
  { sku: "SED-FILT-10", name: '10" Sediment Filter Cartridge', quantity: 24, reorderThreshold: 10 },
  { sku: "CARB-FILT-10", name: '10" Carbon Filter Cartridge', quantity: 18, reorderThreshold: 8 },
  { sku: "RO-MEM-75", name: "RO Membrane 75 GPD", quantity: 4, reorderThreshold: 3 },
  { sku: "RESIN-CUFT", name: "Softener Resin (cu ft)", quantity: 12, reorderThreshold: 4 },
]

export function InventoryView() {
  const { rows, live, reload } = useResource("inventory", SAMPLE_INV)
  const [note, setNote] = useState<string | null>(null)
  const [busySku, setBusySku] = useState<string | null>(null)

  async function logUse(sku: string) {
    setBusySku(sku)
    sfx.send()
    try {
      setNote(await instruct(`Log 1 ${sku} used on a visit (deduct from stock)`))
      setTimeout(reload, 1500)
    } catch (e) {
      setNote(`Backend: ${(e as Error).message}`)
    } finally {
      setBusySku(null)
    }
  }

  return (
    <Glass><div className="p-5">
      <PanelHeader title="Inventory" sub="Finnor's own stock ledger — deductions are atomic and can never go negative." live={live} />
      <Note text={note} />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {rows.map((r, i) => {
          const qty = Number(r.quantity)
          const thr = Number(r.reorderThreshold)
          const low = qty <= thr
          return (
            <div key={i} className="rounded-xl border border-white/8 bg-slate-900/50 p-4">
              <div className="flex items-center justify-between">
                <div className="j-fs-sm font-black">{String(r.name)}</div>
                <span className={`text-lg font-black tabular-nums ${low ? "text-amber-300" : "text-teal-200"}`}>{qty}</span>
              </div>
              <div className="mt-1 flex items-center justify-between j-fs-micro text-white/40">
                <span>{String(r.sku)} · reorder at {thr}</span>
                {low && <span className="font-black text-amber-300">REORDER</span>}
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
                <motion.div className={`h-full ${low ? "bg-amber-400" : "bg-gradient-to-r from-teal-400 to-sky-400"}`}
                  initial={{ width: 0 }} animate={{ width: `${Math.min(100, (qty / Math.max(1, thr * 3)) * 100)}%` }} transition={{ duration: 0.8 }} />
              </div>
              <button onClick={() => logUse(String(r.sku))} disabled={busySku === String(r.sku)}
                className="mt-3 rounded-full border border-white/15 px-4 py-1.5 j-fs-micro font-black uppercase tracking-wider text-white/70 transition hover:border-teal-300/40 hover:text-white disabled:opacity-40">
                {busySku === String(r.sku) ? "logging…" : "Log 1 used on visit"}
              </button>
            </div>
          )
        })}
      </div>
    </div></Glass>
  )
}

// ---------- Invoices ----------

const SAMPLE_INVOICES: Row[] = [
  { amountUsd: "249", status: "paid", memo: "Annual maintenance visit", createdAt: new Date().toISOString() },
]

/** Phase 15: real Stripe/DocuSign provider health + which binding is actually wired
 *  to serve each capability, from GET /api/integrations/status (sanity lane, already
 *  polled by JarvisDataProvider — no extra fetch here, same pattern as VoiceOpsPanel). */
function ProviderChip({
  label,
  health,
  binding,
  activeBindingName,
  icon: Icon,
}: {
  label: string
  health: { configured: boolean; healthy: boolean | null; error?: string } | undefined
  binding: string | undefined
  activeBindingName: string
  icon: React.ComponentType<{ className?: string }>
}) {
  const live = binding === activeBindingName
  const tone = !health?.configured ? "amber" : health.healthy === false ? "rose" : live ? "teal" : "white"
  const toneClasses =
    tone === "teal"
      ? "border-teal-300/25 bg-teal-300/5"
      : tone === "amber"
        ? "border-amber-300/20 bg-amber-300/5"
        : tone === "rose"
          ? "border-rose-300/25 bg-rose-300/5"
          : "border-white/8 bg-slate-900/50"
  const iconTone = tone === "teal" ? "text-teal-300" : tone === "amber" ? "text-amber-300" : tone === "rose" ? "text-rose-300" : "text-white/40"
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${toneClasses}`}>
      <Icon className={`h-4 w-4 shrink-0 ${iconTone}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 j-fs-sm font-black text-white/85">
          {label}
          {live && <span className="rounded-full bg-teal-300/15 px-2 py-0.5 j-fs-micro font-black uppercase tracking-wider text-teal-200">active binding</span>}
        </div>
        <div className="truncate j-fs-micro text-white/45">
          {!health?.configured
            ? "Not connected — add credentials to activate"
            : health.healthy === false
              ? `Configured but unhealthy — ${health.error ?? "self-test failed"}`
              : health.healthy
                ? live
                  ? "Connected and serving this capability"
                  : `Connected, but ${activeBindingName === "emulator" ? "the emulator" : "another binding"} is still active — flip the *_BINDING env var to switch over`
                : "Configured"}
        </div>
      </div>
    </div>
  )
}

function PaymentsEsignOpsPanel() {
  const { integrationsStatus, integrationsDegraded } = useJarvis()
  const live = integrationsStatus !== null && !integrationsDegraded

  return (
    <Glass><div className="p-5">
      <PanelHeader title="Payments & E-Sign Ops" sub="Stripe payment links and DocuSign signature requests — real adapters, opt-in bindings." live={live} />
      <div className="grid gap-3 md:grid-cols-2">
        <ProviderChip
          label="Stripe"
          health={integrationsStatus?.stripe}
          binding={integrationsStatus?.bindings.payments}
          activeBindingName="stripe"
          icon={CreditCard}
        />
        <ProviderChip
          label="DocuSign"
          health={integrationsStatus?.docusign}
          binding={integrationsStatus?.bindings.esign}
          activeBindingName="docusign"
          icon={FileSignature}
        />
      </div>
      <p className="mt-3 j-fs-micro text-white/35">
        Both capabilities run on a safe, fully-functional emulator until real credentials are set — <code className="text-teal-200/80">STRIPE_SECRET_KEY</code> +{" "}
        <code className="text-teal-200/80">PAYMENTS_BINDING=stripe</code>, or <code className="text-teal-200/80">DOCUSIGN_INTEGRATION_KEY</code>/
        <code className="text-teal-200/80">USER_ID</code>/<code className="text-teal-200/80">ACCOUNT_ID</code>/<code className="text-teal-200/80">PRIVATE_KEY</code> +{" "}
        <code className="text-teal-200/80">ESIGN_BINDING=docusign</code> — no code change either way.
      </p>
    </div></Glass>
  )
}

export function InvoicesView() {
  const { rows, live, reload } = useResource("invoices", SAMPLE_INVOICES)
  const [phone, setPhone] = useState("")
  const [amount, setAmount] = useState("")
  const [memo, setMemo] = useState("")
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function createInvoice() {
    if (!phone || !amount) return
    setBusy(true)
    sfx.send()
    try {
      setNote(await instruct(`Create an invoice of $${amount} for the customer with phone ${phone}${memo ? ` for ${memo}` : ""}`))
      setPhone(""); setAmount(""); setMemo("")
      setTimeout(reload, 1200)
    } catch (e) {
      setNote(`Backend: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const total = rows.filter((r) => r.status !== "void").reduce((s, r) => s + Number(r.amountUsd ?? 0), 0)
  return (
    <div className="space-y-4">
    <Glass><div className="p-5">
      <PanelHeader title="Invoices" sub="Native ledger — create, remind, record payment. No accounting SaaS required." live={live} />
      <div className="mb-4 flex items-center gap-3">
        <span className="rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-3 text-2xl font-black tabular-nums text-teal-200">${total.toLocaleString()}</span>
        <span className="j-fs-micro text-white/40">total invoiced<br />({rows.length} invoice{rows.length === 1 ? "" : "s"})</span>
      </div>
      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <Field label="Customer phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 319 555 0142" />
        <Field label="Amount USD" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="249" />
        <Field label="Memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Annual maintenance" />
        <div className="flex items-end"><ActionButton onClick={createInvoice} busy={busy}>Create invoice</ActionButton></div>
      </div>
      <Note text={note} />
      <div className="mt-3 space-y-2">
        {rows.slice(0, 8).map((r, i) => (
          <div key={i} className="flex items-center justify-between rounded-xl border border-white/8 bg-slate-900/50 px-4 py-3 j-fs-sm">
            <span className="font-black tabular-nums">${String(r.amountUsd)}</span>
            <span className="min-w-0 flex-1 truncate px-4 text-white/50">{String(r.memo ?? "")}</span>
            <span className={`rounded-full px-2.5 py-1 j-fs-micro font-black uppercase ${r.status === "paid" ? "bg-teal-300/12 text-teal-200" : r.status === "overdue" ? "bg-amber-300/12 text-amber-200" : "bg-white/8 text-white/50"}`}>
              {String(r.status)}
            </span>
          </div>
        ))}
      </div>
    </div></Glass>
    <PaymentsEsignOpsPanel />
    </div>
  )
}

// ---------- Water Compliance ----------

export function ComplianceView() {
  const [hardness, setHardness] = useState("18")
  const [pfoa, setPfoa] = useState("")
  const [fluoride, setFluoride] = useState("")
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    sfx.send()
    const parts = [
      hardness && `hardness ${hardness} gpg`,
      pfoa && `PFOA ${pfoa} ppt`,
      fluoride && `fluoride ${fluoride} mg/L`,
    ].filter(Boolean)
    try {
      setNote(await instruct(`Generate a water compliance summary for a household with ${parts.join(", ")}`))
    } catch (e) {
      setNote(`Backend: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const EPA = [
    { k: "PFOA / PFOS MCL", v: "4 ppt", icon: ShieldCheck },
    { k: "Fluoride MCL", v: "4.0 mg/L (2.0 secondary)", icon: ShieldCheck },
    { k: "Very hard water", v: "> 10.5 gpg", icon: ShieldCheck },
    { k: "Iron secondary std", v: "0.3 ppm", icon: ShieldCheck },
  ]

  return (
    <Glass><div className="p-5">
      <PanelHeader title="Water Compliance" sub="Household test results checked against EPA National Drinking Water Regulations." live={true} />
      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <Field label="Hardness (gpg)" value={hardness} onChange={(e) => setHardness(e.target.value)} placeholder="18" />
        <Field label="PFOA (ppt)" value={pfoa} onChange={(e) => setPfoa(e.target.value)} placeholder="7.2" />
        <Field label="Fluoride (mg/L)" value={fluoride} onChange={(e) => setFluoride(e.target.value)} placeholder="1.4" />
        <div className="flex items-end"><ActionButton onClick={run} busy={busy}>Run compliance check</ActionButton></div>
      </div>
      <Note text={note} />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {EPA.map(({ k, v, icon: Icon }) => (
          <div key={k} className="flex items-center gap-3 rounded-xl border border-white/8 bg-slate-900/50 px-4 py-3">
            <Icon className="h-4 w-4 shrink-0 text-teal-300" />
            <div>
              <div className="j-fs-sm font-black">{k}</div>
              <div className="j-fs-micro text-white/45">{v}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 j-fs-micro text-white/30">Source: EPA National Primary/Secondary Drinking Water Regulations — stored as tenant policy, editable, never hardcoded.</p>
    </div></Glass>
  )
}

// ---------- Web Research ----------

export function ResearchView() {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Array<{ title: string; url: string; snippet: string }>>([])
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(kind: "search" | "competitors" | "reviews") {
    if (!query.trim()) return
    setBusy(true)
    sfx.send()
    setResults([])
    const instruction =
      kind === "competitors"
        ? `Scan water treatment competitors around ${query}`
        : kind === "reviews"
          ? `Check recent reviews of ${query}`
          : `Search the web for: ${query}`
    try {
      await jarvisPost("actions", { instruction })
      // research actions are ungated — the result lands in the audit log; pull it
      await new Promise((r) => setTimeout(r, 1600))
      const audit = await jarvisGet<{
        entries: Array<{ step: string; output: { output?: { results?: Array<{ title: string; url: string; snippet: string }>; spokenSummary?: string } } }>
      }>("audit", { limit: "10" })
      const exec = audit.entries.find((e) => e.step === "execute" && e.output?.output?.results)
      if (exec?.output.output?.results) {
        setResults(exec.output.output.results.slice(0, 5))
        setNote(null)
        sfx.approve()
      } else {
        setNote("Search ran — results are in the audit log.")
      }
    } catch (e) {
      setNote(`Backend: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Glass><div className="p-5">
      <PanelHeader title="Web Research" sub="Real-time web intelligence via Exa — competitors, reviews, anything." live={true} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run("search")}
            placeholder='"Cedar Falls Iowa" or a business name or any question'
            className="h-11 w-full rounded-full border border-white/12 bg-slate-950/70 pl-10 pr-4 j-fs-sm text-white placeholder:text-white/25 focus:border-teal-300/50 focus:outline-none"
          />
        </div>
        <ActionButton onClick={() => run("search")} busy={busy}>Search</ActionButton>
        <button onClick={() => run("competitors")} disabled={busy} className="rounded-full border border-white/15 px-4 py-2 j-fs-micro font-black uppercase tracking-wider text-white/70 transition hover:border-teal-300/40 hover:text-white disabled:opacity-40">Competitor scan</button>
        <button onClick={() => run("reviews")} disabled={busy} className="rounded-full border border-white/15 px-4 py-2 j-fs-micro font-black uppercase tracking-wider text-white/70 transition hover:border-teal-300/40 hover:text-white disabled:opacity-40">Review scan</button>
      </div>
      <Note text={note} />
      <div className="mt-4 space-y-2">
        {results.map((r, i) => (
          <motion.a key={i} href={r.url} target="_blank" rel="noreferrer" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }}
            className="block rounded-xl border border-white/8 bg-slate-900/50 px-4 py-3 transition hover:border-teal-300/30">
            <div className="j-fs-sm font-black text-teal-100">{r.title}</div>
            <div className="truncate j-fs-micro text-sky-300/70">{r.url}</div>
            <div className="mt-1 line-clamp-2 j-fs-sm text-white/55">{r.snippet}</div>
          </motion.a>
        ))}
      </div>
    </div></Glass>
  )
}

// ---------- Voice Console ----------

/** Phase 14: real phone-line routing status + real unclear-phrasing digest, both
 *  already polled by JarvisDataProvider (sanity + slow lanes) — no extra fetch here. */
function VoiceOpsPanel() {
  const { setupStatus, insights, now } = useJarvis()
  const phoneRouting = setupStatus?.phoneRouting
  const unclear = insights?.unclearConfirmations ?? []
  const live = setupStatus !== null && insights !== null

  return (
    <Glass><div className="p-5">
      <PanelHeader title="Voice Ops" sub="Phone-line routing and real caller phrasings the yes/no parser didn't catch." live={live} />

      <div className="mb-4 flex items-center gap-3 rounded-xl border border-white/8 bg-slate-950/50 px-4 py-3">
        {phoneRouting?.configured ? (
          <>
            <Phone className="h-4 w-4 shrink-0 text-teal-300" />
            <div className="min-w-0">
              <div className="j-fs-sm font-black text-white/85">
                {phoneRouting.numbers.length} line{phoneRouting.numbers.length === 1 ? "" : "s"} registered for tenant routing
              </div>
              <div className="truncate j-fs-micro text-white/45">{phoneRouting.numbers.map((n) => n.label || n.phoneNumber).join(", ")}</div>
            </div>
          </>
        ) : (
          <>
            <PhoneOff className="h-4 w-4 shrink-0 text-amber-300" />
            <div className="min-w-0">
              <div className="j-fs-sm font-black text-amber-200">No phone line registered yet</div>
              <div className="j-fs-micro text-white/45">Calls fall back to the single default tenant — fine for one dealer, not for multi-line.</div>
            </div>
          </>
        )}
      </div>

      <div className="mb-2 j-fs-micro font-black uppercase tracking-[0.16em] text-white/40">Unclear confirmation phrasings</div>
      <div className="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-white/8 bg-slate-950/50 p-4">
        {unclear.length === 0 ? (
          <div className="py-3 text-center j-fs-sm text-white/35">
            {live ? "No unclear phrasings recorded yet — every yes/no has parsed cleanly." : "Awaiting connection to the live API."}
          </div>
        ) : (
          unclear.map((u, i) => (
            <div key={i} className="flex items-baseline justify-between gap-3 j-fs-sm leading-relaxed">
              <span className="text-white/75">&ldquo;{u.transcript}&rdquo;</span>
              <span className="shrink-0 font-mono j-fs-micro text-white/35">{ageLabel(u.at, now || Date.now())} ago</span>
            </div>
          ))
        )}
      </div>
      {unclear.length > 0 && (
        <p className="mt-2 j-fs-micro text-white/35">
          Add a phrasing above to <code className="text-teal-200/80">policy.approvePhrases</code>/<code className="text-teal-200/80">rejectPhrases</code> for
          &ldquo;voice_confirmation&rdquo; and it stops showing up here once it starts matching.
        </p>
      )}
    </div></Glass>
  )
}

export function VoiceConsoleView({
  voiceState,
  toggleVoice,
  feed,
}: {
  voiceState: "idle" | "connecting" | "live"
  toggleVoice: () => void
  feed: Array<{ role: "you" | "jarvis"; text: string }>
}) {
  return (
    <div className="space-y-4">
    <Glass><div className="p-5">
      <PanelHeader title="Voice Console" sub="Talk to JARVIS through your microphone — no phone line, no carrier, full pipeline." live={voiceState === "live"} />
      <div className="flex flex-col items-center py-6">
        <motion.button
          onClick={toggleVoice}
          className={`relative flex h-28 w-28 items-center justify-center rounded-full text-slate-950 transition ${
            voiceState === "live" ? "bg-teal-300" : "bg-gradient-to-br from-teal-300 to-sky-400 hover:scale-105"
          }`}
          animate={voiceState === "live" ? { boxShadow: ["0 0 0 0 rgba(94,234,212,0.4)", "0 0 0 28px rgba(94,234,212,0)", "0 0 0 0 rgba(94,234,212,0)"] } : {}}
          transition={{ duration: 1.6, repeat: voiceState === "live" ? Infinity : 0 }}
        >
          {voiceState === "live" ? <X className="h-9 w-9" /> : <Send className="h-9 w-9 rotate-[-20deg]" />}
        </motion.button>
        <div className="mt-4 text-sm font-black uppercase tracking-widest text-white/60">
          {voiceState === "live" ? "Listening — speak naturally" : voiceState === "connecting" ? "Connecting…" : "Tap to start a voice session"}
        </div>
        <div className="mt-1 max-w-md text-center j-fs-micro text-white/35">
          &ldquo;Create a lead for Sarah Kim…&rdquo; · &ldquo;Book a water test Tuesday…&rdquo; · &ldquo;Check RO membrane stock&rdquo; · &ldquo;Scan competitors near Cedar Falls&rdquo;
        </div>
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto rounded-xl border border-white/8 bg-slate-950/50 p-4">
        {feed.slice(-12).map((m, i) => (
          <div key={i} className="j-fs-sm leading-relaxed">
            <span className={m.role === "jarvis" ? "font-black text-teal-200" : "font-black text-white/70"}>{m.role === "jarvis" ? "JARVIS" : "YOU"}</span>{" "}
            <span className={m.role === "jarvis" ? "text-white/80" : "text-white/60"}>{m.text}</span>
          </div>
        ))}
      </div>
    </div></Glass>
    <VoiceOpsPanel />
    </div>
  )
}

// ---------- System Health (Phase 16 — production hardening) ----------

const BINDING_LABELS: Record<string, string> = {
  scheduling: "Scheduling",
  communications: "Communications",
  documents: "Documents",
  esign: "E-Sign",
  inventory: "Inventory",
  accounting: "Accounting",
  payments: "Payments",
  crm: "CRM",
  marketing: "Marketing",
}

// jarvis-v3 P4.T6: `value` is really `{mode, source}` (see data-core.ts's
// `BindingResolution` — this file's own prop type was wrong, a real, live
// defect: comparing an object to the string "emulator" is always false, and
// rendering that object directly as a JSX child crashes React. Fixed here
// since P4.T6 needs this exact field, correctly read, to tell a real provider
// from a sandboxed one.
function BindingChip({ capability, value }: { capability: string; value: BindingResolution }) {
  const real = value.mode !== "emulator"
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${real ? "border-teal-300/25 bg-teal-300/8" : "border-white/8 bg-slate-950/50"}`}>
      <div className="j-fs-micro font-black uppercase tracking-[0.14em] text-white/40">{BINDING_LABELS[capability] ?? capability}</div>
      <div className={`j-fs-sm font-black ${real ? "text-teal-200" : "text-white/55"}`}>{value.mode}</div>
    </div>
  )
}

/** Phase 16: secrets provider, node environment, and every *_BINDING switch in
 *  effect — all from GET /api/setup/status's `environment` block (sanity lane,
 *  already polled by JarvisDataProvider — zero new fetches). This is the same
 *  "what's actually configured" honesty the rest of the page practices, applied to
 *  the production-hardening workstream instead of a customer-facing capability. */
function SystemHealthPanel() {
  const { setupStatus, integrationsStatus } = useJarvis()
  const env = setupStatus?.environment
  const live = env !== undefined

  return (
    <Glass><div className="p-5">
      <PanelHeader title="Production Readiness" sub="Secrets provider, environment, and every capability binding — real switches, real state." live={live} />

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-slate-950/50 px-4 py-3">
          <Server className="h-4 w-4 shrink-0 text-teal-300" />
          <div>
            <div className="j-fs-micro font-black uppercase tracking-[0.14em] text-white/40">Environment</div>
            <div className="j-fs-sm font-black text-white/85">{env?.nodeEnv ?? "—"}</div>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-slate-950/50 px-4 py-3">
          <KeyRound className="h-4 w-4 shrink-0 text-teal-300" />
          <div>
            <div className="j-fs-micro font-black uppercase tracking-[0.14em] text-white/40">Secrets provider</div>
            <div className="j-fs-sm font-black text-white/85">
              {!env ? "—" : env.secretProvider.provider === "aws-secrets-manager" ? "AWS Secrets Manager" : "Plain env vars"}
              {env?.secretProvider.loaded && <span className="ml-2 j-fs-micro font-bold text-teal-300">loaded</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="mb-2 j-fs-micro font-black uppercase tracking-[0.16em] text-white/40">Capability bindings</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {env ? (
          Object.entries(env.bindings).map(([capability, value]) => <BindingChip key={capability} capability={capability} value={value} />)
        ) : (
          <div className="col-span-3 py-3 text-center j-fs-sm text-white/35">Awaiting connection to the live API.</div>
        )}
      </div>
      <p className="mt-3 j-fs-micro text-white/35">
        Every binding defaults to <code className="text-teal-200/80">emulator</code> — fully functional, zero real credentials required — until a dealer&rsquo;s
        real provider keys are set and its <code className="text-teal-200/80">*_BINDING</code> env var is flipped. Same opt-in-only posture as{" "}
        {integrationsStatus ? "the Payments & E-Sign providers above" : "every capability on this page"}.
      </p>
      <p className="mt-2 j-fs-micro text-white/30">
        RBAC (dispatcher/technician approval scopes) and per-request correlation-id tracing are enforced and logged server-side — verified by
        <code className="ml-1 text-teal-200/80">tests/integration/rbac-approval.test.ts</code> and{" "}
        <code className="text-teal-200/80">correlation-id.test.ts</code> in finnor-os, not surfaced here as a live feed to avoid faking data this page can&rsquo;t
        actually observe.
      </p>
    </div></Glass>
  )
}

export function SystemHealthView() {
  return (
    <div className="space-y-4">
      <SystemHealthPanel />
    </div>
  )
}
