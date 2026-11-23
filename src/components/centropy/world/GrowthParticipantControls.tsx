"use client"

import { useState } from "react"
import { centropyPost } from "../lib/api"
import { growthAmount, growthLabel, growthMoney, growthS1Ref, growthSource,
  type GrowthMutation, type GrowthProgress, type GrowthProtocol, type GrowthSource } from "./growth-program-contracts"

const categories = ["ACQUISITION", "IMPLEMENTATION", "FULFILLMENT", "SUPPORT", "HUMAN_TIME", "COMPUTE",
  "STORAGE", "RETURNS", "CANNIBALIZATION", "FINANCING", "TAX", "WORKING_CAPITAL", "RESIDUAL"] as const
const initial = { quantity: "1", amount: "", choice: "", invoice: "", issue: "", state: "OPEN",
  response: "INTEREST", accepted: "yes", liability: "", category: "", expense: "", cash: "", terminal: "",
  revision: "", reason: "" }
type Mode = "response" | "delivery" | "accept-delivery" | "support" | "request-refund" | "settle-refund"
  | "invoice" | "collect" | "recognize" | "cost" | "close-test" | "market-change"
const titles: Record<Mode, string> = { response: "Respond to the exact offer", delivery: "Report original delivery",
  "accept-delivery": "Inspect and accept or reject delivery", support: "Record a support issue",
  "request-refund": "Request a refund", "settle-refund": "Record a verified refund",
  invoice: "Record an original invoice", collect: "Record original collection",
  recognize: "Record revenue recognition", cost: "Record an original lifecycle cost",
  "close-test": "Close the original test", "market-change": "Record a market change" }

export function GrowthParticipantControls({ protocol, progress, busy, mutate, evidenceProtocolFor }: {
  protocol: GrowthProtocol; progress: GrowthProgress; busy: boolean; mutate: GrowthMutation
  evidenceProtocolFor: (kind: "INVOICE" | "ACCOUNTING") => string | null
}) {
  const [draft, setDraft] = useState(initial), [mode, setMode] = useState<Mode>("response")
  const disclosure = protocol.disclosure
  if (!disclosure || protocol.status !== "CONSENTED") return null
  const offer = disclosure.offer, currency = offer?.unitPrice.currency ?? (
    typeof disclosure.currency === "string" ? disclosure.currency : "")
  const options: Mode[] = []
  const permits = (kind: string) => protocol.permittedKinds.includes(kind)
  if (permits("RESPONSE") && offer) options.push("response")
  if (permits("DELIVERY") && offer) options.push("delivery")
  if (permits("DELIVERY_ACCEPTANCE") && offer) options.push("accept-delivery")
  if (permits("SUPPORT") && offer) options.push("support")
  if (permits("REFUND") && offer) options.push(protocol.role === "BUYER" ? "request-refund" : "settle-refund")
  if (protocol.role === "ACCOUNTANT" && offer && evidenceProtocolFor("INVOICE")) options.push("invoice")
  if (permits("COLLECTION") && offer) options.push("collect")
  if (permits("RECOGNITION") && offer) options.push("recognize")
  if (permits("COST")) options.push("cost")
  if (permits("TEST_CLOSED") && disclosure.populationSource) options.push("close-test")
  if (permits("MARKET_CHANGE")) options.push("market-change")
  const selected = options.includes(mode) ? mode : options[0]
  if (!selected) return <p>This evidence-only protocol grants no Work access. Its upstream originals remain with their authenticated owners.</p>
  const set = (key: keyof typeof initial, value: string) => setDraft(d => ({ ...d, [key]: value }))
  const nativeKind = selected === "delivery" ? "DELIVER" : selected === "collect" ? "COLLECT" : "REFUND"
  const natives = progress.executions.filter(e => e.operation === nativeKind)
  const native = natives.find(e => e.obligationRef.id === draft.choice)
  const cited = progress.events.find(e => e.source.sourceId === draft.choice)
  const invoices = progress.evidence.filter(e => e.kind === "INVOICE" && e.data.buyerId === disclosure.buyerId
    && e.data.offerId === offer?.id && e.data.termsDigest === offer?.termsDigest)
  const invoice = invoices.find(e => e.source.versionId === draft.invoice)
  const refundRequests = progress.events.filter(e => e.body.kind === "REFUND" && e.body.status === "REQUESTED")
  const refundRequest = refundRequests.find(e => e.source.sourceId === draft.invoice)
  const financial = ["collect", "recognize", "settle-refund", "cost"].includes(selected)
  const unavailable = busy || !progress.complete || Date.parse(protocol.expiresAt) <= Date.now()
    || financial && !evidenceProtocolFor("ACCOUNTING")
    || ["delivery", "collect", "settle-refund"].includes(selected) && !native
    || ["accept-delivery", "recognize"].includes(selected) && !cited
    || selected === "collect" && !invoice || selected === "settle-refund" && !refundRequest
    || selected === "close-test" && (!disclosure.testClosesAt || Date.now() < Date.parse(disclosure.testClosesAt))
  const money = (minor: string) => growthMoney.parse({ currency, minor })
  const quantity = () => {
    const n = Number(draft.quantity)
    if (!Number.isSafeInteger(n) || n <= 0 || n > 1_000_000) throw Error("Invalid original quantity")
    return n
  }
  const writeEvidence = async (kind: "ACCOUNTING" | "INVOICE", data: Record<string, unknown>,
    at: string, nonce: string, current: () => boolean, basis: GrowthSource[] = []) => {
    const sourceProtocol = evidenceProtocolFor(kind)
    if (!current() || !sourceProtocol) throw Error("Current independent source protocol required")
    const result = await centropyPost<{ source: unknown }>("demand-to-business/source", {
      workId: disclosure.scope.workId, idempotencyKey: `w4-ui-${kind.toLowerCase()}:${nonce}`,
      purpose: protocol.purpose, protocolId: sourceProtocol, body: {
        schema: "finnor.growth-evidence.v1", scope: disclosure.scope, kind, subjectId: "record:" + nonce,
        validFrom: new Date(Date.parse(at) - 1000).toISOString(), validUntil: protocol.expiresAt,
        data, basis, nativeRefs: [], limitations: [
          "Authenticated author record, not independent proof of payment, delivery or market truth.",
          "Controlled development only. No genuine market, causal or realized-profit qualification.",
        ],
      },
    })
    if (!current()) throw Error("Private context changed")
    return growthSource.parse(result.source)
  }
  const submit = () => mutate(async current => {
    const at = new Date().toISOString(), nonce = crypto.randomUUID()
    const common = () => {
      if (!offer || !disclosure.buyerId) throw Error("Exact original buyer and offer required")
      return { scope: disclosure.scope, buyerId: disclosure.buyerId, offerId: offer.id, termsDigest: offer.termsDigest, at }
    }
    let event: Record<string, unknown>
    switch (selected) {
      case "invoice":
        await writeEvidence("INVOICE", { buyerId: disclosure.buyerId, offerId: offer!.id,
          termsDigest: offer!.termsDigest, amount: money(draft.amount) }, at, nonce, current)
        return
      case "response":
        event = { ...common(), kind: "RESPONSE", response: draft.response, quantity: quantity() }; break
      case "delivery":
        event = { ...common(), kind: "DELIVERY", quantity: quantity(), effectRef: native!.obligationRef }; break
      case "accept-delivery":
        event = { ...common(), kind: "DELIVERY_ACCEPTANCE", quantity: quantity(), accepted: draft.accepted === "yes",
          deliveredSourceIds: [cited!.source.sourceId] }; break
      case "support":
        event = { ...common(), kind: "SUPPORT", issueId: draft.issue, state: draft.state,
          residualLiability: draft.liability ? money(draft.liability) : null }; break
      case "request-refund":
        event = { ...common(), kind: "REFUND", amount: money(draft.amount), status: "REQUESTED",
          requestSourceId: null, accountingRef: null, effectRef: null }; break
      case "settle-refund":
        event = { ...common(), kind: "REFUND", amount: money(draft.amount), status: "SETTLED",
          requestSourceId: refundRequest!.source.sourceId, effectRef: native!.obligationRef }; break
      case "collect":
        event = { ...common(), kind: "COLLECTION", amount: money(draft.amount),
          invoiceRef: growthS1Ref(invoice!.source), effectRef: native!.obligationRef }; break
      case "recognize":
        event = { ...common(), kind: "RECOGNITION", amount: money(draft.amount),
          accountingPolicySource: offer!.accountingPolicySource, acceptedSourceIds: [cited!.source.sourceId] }; break
      case "cost":
        event = { scope: disclosure.scope, at, kind: "COST", itemId: draft.issue, category: draft.category,
          expense: draft.expense ? money(draft.expense) : null, cash: draft.cash ? money(draft.cash) : null,
          additionalTerminalLiability: draft.terminal ? money(draft.terminal) : null,
          treatment: "NO_DUPLICATE_EXPENSE_OR_TERMINAL_LIABILITY" }; break
      case "close-test":
        event = { scope: disclosure.scope, at, kind: "TEST_CLOSED", originalPopulationSource: disclosure.populationSource }; break
      case "market-change":
        event = { scope: disclosure.scope, at, kind: "MARKET_CHANGE", previousRevision: disclosure.marketRevision,
          currentRevision: draft.revision, reason: draft.reason }; break
    }
    if (financial) {
      const original = await writeEvidence("ACCOUNTING", event, at, nonce, current,
        cited ? [cited.source] : invoice ? [invoice.source] : [])
      event = { ...event, accountingRef: growthS1Ref(original) }
    }
    if (!current()) throw Error("Private context changed")
    await centropyPost("demand-to-business/report", { protocolId: protocol.id,
      idempotencyKey: "w4-ui-event:" + nonce, event })
  })
  return <form onSubmit={event => { event.preventDefault(); if (!unavailable) void submit() }}
    aria-label="Record exact business evidence">
    <label>What do you want to record?<select value={selected} disabled={busy} onChange={event => {
      setMode(event.target.value as Mode); setDraft(initial)
    }}>{options.map(option => <option key={option} value={option}>{titles[option]}</option>)}</select></label>
    {selected === "response" ? <label>Your response<select value={draft.response} onChange={e => set("response", e.target.value)}>
      <option value="INTEREST">Interested, not committed</option><option value="DECLINED">Decline</option>
      <option value="ACCEPTED">Accept the exact terms</option><option value="NONRESPONSE">Record no response</option>
    </select></label> : null}
    {["response", "delivery", "accept-delivery"].includes(selected) ? <label>Quantity<input type="number" min="1" step="1"
      max={offer?.maximumUnits ?? 1_000_000} value={draft.quantity} required onChange={e => set("quantity", e.target.value)} /></label> : null}
    {["delivery", "collect", "settle-refund"].includes(selected) ? <label>Original native operation<select required
      value={draft.choice} onChange={e => set("choice", e.target.value)}><option value="">Select an original operation</option>
      {natives.map((e, i) => <option key={e.obligationRef.id} value={e.obligationRef.id}>
        {growthLabel(e.operation)} {i + 1}, {e.amount ? growthAmount(e.amount) : `${e.quantity} units`}
      </option>)}</select></label> : null}
    {["accept-delivery", "recognize"].includes(selected) ? <label>Original evidence<select required
      value={draft.choice} onChange={e => set("choice", e.target.value)}><option value="">Select original evidence</option>
      {progress.events.filter(e => selected === "accept-delivery" ? e.body.kind === "DELIVERY"
        : e.body.kind === "DELIVERY_ACCEPTANCE" && e.body.accepted).map((e, i) =>
        <option key={e.source.sourceId} value={e.source.sourceId}>{selected === "recognize" ? "Accepted delivery" : "Delivery report"} {i + 1},
          {" "}{e.body.quantity} units, {new Date(e.body.at).toLocaleString()}</option>)}</select></label> : null}
    {selected === "accept-delivery" ? <label>Inspection result<select value={draft.accepted} onChange={e => set("accepted", e.target.value)}>
      <option value="yes">I accept this delivery</option><option value="no">I reject this delivery</option>
    </select></label> : null}
    {selected === "collect" ? <label>Your original invoice<select required value={draft.invoice}
      onChange={e => set("invoice", e.target.value)}><option value="">Select the exact invoice</option>
      {invoices.map((e, i) => <option key={e.source.versionId} value={e.source.versionId}>Invoice {i + 1},
        {" "}{e.data.amount ? growthAmount(e.data.amount) : "amount unavailable"}</option>)}</select></label> : null}
    {selected === "settle-refund" ? <label>Original buyer request<select required value={draft.invoice}
      onChange={e => set("invoice", e.target.value)}><option value="">Select a refund request</option>
      {refundRequests.map((e, i) => <option key={e.source.sourceId} value={e.source.sourceId}>Refund request {i + 1},
        {" "}{e.body.amount ? growthAmount(e.body.amount) : "amount unavailable"}</option>)}</select></label> : null}
    {["invoice", "collect", "recognize", "request-refund", "settle-refund"].includes(selected) ? <label>Amount in minor {currency} units
      <input inputMode="numeric" pattern="(0|[1-9][0-9]{0,14})" required value={draft.amount}
        onChange={e => set("amount", e.target.value)} /></label> : null}
    {["support", "cost"].includes(selected) ? <label>{selected === "support" ? "Support issue" : "Stable original cost item"}
      <input required maxLength={160} value={draft.issue} onChange={e => set("issue", e.target.value)} /></label> : null}
    {selected === "support" ? <>
      <label>Issue state<select value={draft.state} onChange={e => set("state", e.target.value)}>
        <option value="OPEN">Open</option><option value="RESOLVED">Resolved</option></select></label>
      <label>Additional liability in minor {currency} units, leave blank if unknown<input inputMode="numeric"
        pattern="(0|[1-9][0-9]{0,14})" value={draft.liability} onChange={e => set("liability", e.target.value)} /></label>
    </> : null}
    {selected === "cost" ? <>
      <label>Lifecycle category<select required value={draft.category} onChange={e => set("category", e.target.value)}>
        <option value="">Choose the actual category</option>{categories.map(c => <option key={c} value={c}>{growthLabel(c)}</option>)}</select></label>
      {(["expense", "cash", "terminal"] as const).map(field => <label key={field}>{field === "terminal" ? "Additional terminal liability" : growthLabel(field)}
        {" "}in minor {currency} units, blank means unknown<input inputMode="numeric" pattern="(0|[1-9][0-9]{0,14})"
          value={draft[field]} onChange={e => set(field, e.target.value)} /></label>)}
    </> : null}
    {selected === "market-change" ? <>
      <label>New original market revision<input required maxLength={160} value={draft.revision}
        onChange={e => set("revision", e.target.value)} /></label>
      <label>What changed?<textarea required maxLength={2000} value={draft.reason} onChange={e => set("reason", e.target.value)} /></label>
    </> : null}
    <p>Records establish authenticated authorship, not physical delivery, payment, causal increment or profit.
      Blank cost amounts remain unknown. Native identity and accounting conditions are checked independently.</p>
    {!progress.complete ? <p role="status">This bounded evidence read is incomplete. Recording is paused.</p> : null}
    {financial && !evidenceProtocolFor("ACCOUNTING") ? <p>A current independent accounting-source consent is required.</p> : null}
    <button type="submit" disabled={unavailable}>{titles[selected]}</button>
  </form>
}
