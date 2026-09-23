"use client"

import Link from "next/link"
import { useMemo } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ArrowDownUp, BriefcaseBusiness, Search } from "lucide-react"
import { usePeProductData } from "../product/ProductDataProvider"
import { buildDealMasterRows, type DealMasterRow } from "../product/deal-model"
import { DataTable, EmptyState, ErrorState, PageHeader, Skeleton, Status, TruthState } from "../product/primitives"
import { useFirmDealProjections } from "./use-pe-data"
import { withPeOperatingContext } from "./context-routing"

type SortKey = "updated" | "name" | "risk" | "closing"

function setQuery(current: URLSearchParams, values: Record<string, string>, pathname: string, replace: (href: string) => void) {
  const next = new URLSearchParams(current)
  for (const [key, value] of Object.entries(values)) value ? next.set(key, value) : next.delete(key)
  replace(`${pathname}${next.size ? `?${next}` : ""}`)
}

function sortRows(rows: DealMasterRow[], sort: SortKey): DealMasterRow[] {
  const copy = [...rows]
  if (sort === "name") return copy.sort((a, b) => a.label.localeCompare(b.label))
  if (sort === "risk") return copy.sort((a, b) => b.criticalRisks - a.criticalRisks || a.label.localeCompare(b.label))
  if (sort === "closing") return copy.sort((a, b) => a.closingReadiness.localeCompare(b.closingReadiness) || a.label.localeCompare(b.label))
  return copy.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.label.localeCompare(b.label))
}

export default function DealsSurface() {
  const pathname = usePathname()
  const router = useRouter()
  const search = useSearchParams()
  const product = usePeProductData()
  const firm = useFirmDealProjections(product.roots.data)
  const query = search.get("q") ?? ""
  const status = search.get("status") ?? "all"
  const truth = search.get("truth") ?? "all"
  const sort = (["updated", "name", "risk", "closing"].includes(search.get("sort") ?? "") ? search.get("sort") : "updated") as SortKey
  const allRows = useMemo(() => buildDealMasterRows(product.roots.data ?? [], firm.data), [firm.data, product.roots.data])
  const rows = useMemo(() => sortRows(allRows.filter((row) => {
    const haystack = [row.label, row.stageState, row.investmentCaseState, row.latestUnderwritingState, row.icState, row.riskPosture, row.closingReadiness, row.owner, row.lastMaterialChange].join(" ").toLocaleLowerCase()
    return (!query || haystack.includes(query.toLocaleLowerCase())) && (status === "all" || row.status === status) && (truth === "all" || row.truthHealth === truth)
  }), sort), [allRows, query, sort, status, truth])
  const statuses = [...new Set(allRows.map((row) => row.status))].sort()

  function dealHref(row: DealMasterRow): string {
    return withPeOperatingContext(`/centropy/deals/${row.root.entityId}/overview`, { root: row.root, selectedObject: null, workId: null })
  }

  return <main className="pw-page pw-deals-master">
    <PageHeader eyebrow="DEALS · MASTER" title="Firm Deal book" description="Dense, source-backed Deal comparison. Filters, search, and sorting are encoded in the URL; missing facts remain visible as unknown or known empty." />
    <form className="pw-filter-bar" role="search" onSubmit={(event) => event.preventDefault()}>
      <label className="pw-search-field"><Search size={14} /><span className="sr-only">Search Deals</span><input value={query} onChange={(event) => setQuery(new URLSearchParams(search), { q: event.target.value }, pathname, (href) => router.replace(href, { scroll: false }))} placeholder="Search Deal, team, state, risk…" /></label>
      <label><span>Status</span><select value={status} onChange={(event) => setQuery(new URLSearchParams(search), { status: event.target.value }, pathname, (href) => router.replace(href, { scroll: false }))}><option value="all">All statuses</option>{statuses.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      <label><span>Truth</span><select value={truth} onChange={(event) => setQuery(new URLSearchParams(search), { truth: event.target.value }, pathname, (href) => router.replace(href, { scroll: false }))}><option value="all">All truth states</option>{["KNOWN", "KNOWN_EMPTY", "UNKNOWN", "PARTIAL", "STALE", "CONFLICTING", "UNAVAILABLE", "DENIED"].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      <label><ArrowDownUp size={13} /><span>Sort</span><select value={sort} onChange={(event) => setQuery(new URLSearchParams(search), { sort: event.target.value }, pathname, (href) => router.replace(href, { scroll: false }))}><option value="updated">Recently updated</option><option value="name">Deal name</option><option value="risk">Critical risk first</option><option value="closing">Closing readiness</option></select></label>
      <strong>{rows.length} / {allRows.length} Deals</strong>
    </form>
    {firm.status === "loading" && !firm.data ? <Skeleton rows={9} label="Composing canonical Deal master" /> : null}
    {firm.status === "error" && !firm.data ? <ErrorState title="Deal master unavailable" detail={firm.error ?? "Every canonical Deal projection failed."} state={firm.truthState} onRetry={firm.reload} /> : null}
    {firm.data?.failedRoots.length || firm.data?.failedActivityRoots.length ? <ErrorState title="Deal master is partial" detail={`${firm.data.failedRoots.length} of ${firm.data.requested} Deal projections and ${firm.data.failedActivityRoots.length} Activity projection(s) could not be confirmed. Rows and unavailable cells remain visible.`} state="PARTIAL" onRetry={firm.reload} /> : null}
    {rows.length ? <DataTable label="Firm Deal master"><thead><tr><th>Deal</th><th>Stage / state</th><th>Investment Case</th><th>Latest underwriting</th><th>Critical risks</th><th>Open findings</th><th>Open requests</th><th>IC state</th><th>Closing readiness</th><th>Owner</th><th>Last material change</th><th>Truth health</th></tr></thead><tbody>{rows.map((row) => <tr key={row.root.entityId}>
      <td><Link className="pw-deal-link" href={dealHref(row)}><BriefcaseBusiness size={14} /><span><strong>{row.label}</strong><small><Status value={row.status} /></small></span></Link></td>
      <td><Status value={row.stageState} /></td><td><Status value={row.investmentCaseState} /></td><td><Status value={row.latestUnderwritingState} /></td><td>{row.criticalRisks}</td><td>{row.openFindings}</td><td>{row.openRequests}</td><td><Status value={row.icState} /></td><td>{row.closingReadiness}</td><td>{row.owner}</td><td>{row.lastMaterialChange}<small className="pw-cell-meta">{row.updatedAt ? <time dateTime={row.updatedAt}>{new Date(row.updatedAt).toLocaleString()}</time> : "No confirmed Activity timestamp"}</small></td><td><TruthState state={row.truthHealth} compact /></td>
    </tr>)}</tbody></DataTable> : firm.status === "ready" ? <EmptyState icon={<BriefcaseBusiness size={20} />} title={allRows.length ? "No Deal matches these URL filters." : "Known empty: no canonical Deal root is available."} detail={allRows.length ? "Change or clear a filter; no rows were silently substituted." : "Deal creation remains owned by the existing P1 backend."} /> : null}
  </main>
}
