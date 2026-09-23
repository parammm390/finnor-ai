"use client"

import Link from "next/link"
import { useMemo } from "react"
import { ArrowRight, CircleAlert, Command, ListChecks } from "lucide-react"
import { useRouter } from "next/navigation"
import { usePeOperatingContext } from "./pe/PeOperatingContextProvider"
import { withPeOperatingContext } from "./pe/context-routing"
import { useCommandInterface } from "./product/CommandInterface"
import { usePeProductData } from "./product/ProductDataProvider"
import { buildAttentionRows } from "./product/attention-model"
import { AttentionRow, DataTable, EmptyState, ErrorState, PageHeader, Skeleton, TruthState } from "./product/primitives"

export default function PersonalizedHome() {
  const router = useRouter()
  const product = usePeProductData()
  const operating = usePeOperatingContext()
  const command = useCommandInterface()
  const rows = useMemo(() => buildAttentionRows({
    queue: product.attention.data,
    roots: product.roots.data ?? [],
    projection: product.brain.data,
    activity: product.activity.data,
  }), [product.activity.data, product.attention.data, product.brain.data, product.roots.data])

  function inspect(row: (typeof rows)[number]) {
    operating.inspect(row.target, undefined, row.root ?? undefined)
  }

  function open(row: (typeof rows)[number]) {
    if (row.workId) {
      router.push(withPeOperatingContext("/centropy/work", { root: row.root, selectedObject: null, workId: row.workId }), { scroll: false })
      return
    }
    inspect(row)
  }

  function openDeal(row: (typeof rows)[number]) {
    if (!row.root) return
    router.push(withPeOperatingContext(`/centropy/deals/${row.root.entityId}/overview`, { root: row.root, selectedObject: null, workId: null }), { scroll: false })
  }

  const hasUnconfirmed = [product.roots, product.attention].some((resource) => resource.status === "error" && !resource.data)
  return <main className="pw-page pw-home">
    <PageHeader
      eyebrow="HOME · RANKED ATTENTION"
      title="What needs a decision now?"
      description="One canonical queue across your assigned Work, authority boundaries, and the selected Deal context. Category order is fixed; source rank remains intact inside each category."
      actions={<><button type="button" className="pw-secondary-action" onClick={product.refreshAll}>Refresh truth</button><button type="button" className="pw-primary-action" onClick={() => command.openCommand()}><Command size={14} /> Ask CENTROPY</button></>}
    />
    <section className="pw-attention-summary" aria-label="Attention summary">
      <article><span>Decision or evidence</span><strong>{rows.filter((row) => row.category === "NEEDS DECISION" || row.category === "NEEDS EVIDENCE").length}</strong><TruthState state={product.attention.truthState} compact /></article>
      <article><span>Selected-context blockers</span><strong>{rows.filter((row) => ["CRITICAL RISK", "CLOSING BLOCKER", "BLOCKED WORK"].includes(row.category)).length}</strong><TruthState state={operating.context.root ? product.brain.truthState : "UNKNOWN"} compact /></article>
      <article><span>Verified outcomes</span><strong>{rows.filter((row) => row.category === "VERIFIED OUTCOME").length}</strong><TruthState state={operating.context.root ? product.activity.truthState : "UNKNOWN"} compact /></article>
    </section>
    {hasUnconfirmed ? <ErrorState title="The ranked queue is unavailable" detail={product.attention.error ?? product.roots.error ?? "Canonical attention could not be read."} state={product.attention.truthState} onRetry={product.refreshAll} /> : null}
    {(product.roots.status === "loading" || product.attention.status === "loading") && !rows.length ? <Skeleton rows={8} label="Loading server-ranked attention" /> : null}
    {rows.length ? <section className="pw-section">
      <header className="pw-section__heading"><div><span>RANKED ATTENTION TABLE</span><h2>Decision-useful conditions, not dashboard decoration</h2></div><p>{rows.length} canonical condition{rows.length === 1 ? "" : "s"} · Enter opens Work · Space inspects</p></header>
      <DataTable label="Ranked attention">
        <thead><tr><th>Priority</th><th>Deal</th><th>Object</th><th>Why now / impact</th><th>Owner</th><th>Deadline</th><th>Evidence</th><th>Next governed action</th></tr></thead>
        <tbody>{rows.map((row) => <AttentionRow key={row.key} item={row} onInspect={() => inspect(row)} onOpen={() => open(row)} onDeal={row.root ? () => openDeal(row) : undefined} />)}</tbody>
      </DataTable>
    </section> : product.attention.status === "ready" ? <EmptyState icon={<ListChecks size={20} />} title="Known empty: no ranked attention is assigned." detail={operating.context.root ? "The selected Deal has no additional non-terminal risk, closing, or Activity row to add." : "Select a Deal to add its exact risk, closing, in-motion, and verified-outcome context."} /> : null}
    {!operating.context.root ? <section className="pw-context-callout"><CircleAlert size={17} /><div><strong>Selected-context status is UNKNOWN</strong><p>Firm attention remains available. Select a Deal to add its source-backed risks, closing blockers, movement, and outcomes.</p></div><Link href="/centropy/deals">Open Deals <ArrowRight size={13} /></Link></section> : null}
  </main>
}
