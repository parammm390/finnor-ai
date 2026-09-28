"use client"

import { useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { z } from "zod"
import { centropyGet } from "@/components/centropy/lib/api"
import type { PeWorldRootRef } from "@/components/centropy/pe/contracts"

const ConnectionSchema = z.object({
  connections: z.array(z.object({
    authProfileRef: z.string(), status: z.string(), usable: z.boolean(),
    lastErrorCode: z.string().nullable(), lastVerifiedAt: z.string().nullable(),
    sourceScopes: z.object({ total: z.number(), enabled: z.number(), permissionVerified: z.number(), blocked: z.number() }),
    capabilityBindings: z.array(z.object({ capability: z.string(), health: z.string(), freshness: z.string(), reconciliation: z.string() }).passthrough()),
  }).passthrough()),
  summary: z.object({ total: z.number(), active: z.number(), degraded: z.number(), blocked: z.number() }),
}).passthrough()

const ScopeSchema = z.object({
  sourceScopeId: z.string().uuid(), sourceKind: z.string(), providerResourceId: z.string().nullable(),
  enabled: z.boolean(),
  rootBinding: z.object({ type: z.string(), id: z.string().uuid() }).nullable(),
  permission: z.object({ mode: z.string().nullable(), verifiedAt: z.string().nullable() }).passthrough(),
  freshness: z.object({ state: z.string(), lastSuccessfulSyncAt: z.string().nullable(), lastObservedAt: z.string().nullable() }).passthrough(),
  coverage: z.object({ state: z.string(), reason: z.string().nullable(), recoveryStrength: z.string(), unresolvedObservations: z.number(), ambiguousObservations: z.number() }).passthrough(),
  integrationHealth: z.object({ health: z.string(), syncStatus: z.string(), freshness: z.string(), reconciliation: z.string() }).passthrough(),
}).passthrough()
const CoverageSchema = z.object({ asOf: z.string(), sourceCoverage: z.array(ScopeSchema), nextCursor: z.string().nullable() }).passthrough()

type Connection = z.infer<typeof ConnectionSchema>
type Scope = z.infer<typeof ScopeSchema>
type CoverageState = { scopes: Scope[]; asOf: string; partial: boolean }
type ReadState<T> = { data: T | null; error: string | null; loading: boolean }

const empty = <T,>(): ReadState<T> => ({ data: null, error: null, loading: true })
const label = (value: string) => value.replaceAll("_", " ").toLowerCase()
function dateLabel(value: string | null): string { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not recorded" }
function errorLabel(cause: unknown): string { return cause instanceof Error ? cause.message : "Source read unavailable" }

async function readRootCoverage(root: PeWorldRootRef): Promise<CoverageState> {
  const scopes: Scope[] = []
  let cursor: string | null = null
  let asOf = ""
  let partial = false
  for (let page = 0; page < 3; page += 1) {
    const value: unknown = await centropyGet("integrations/microsoft-graph/coverage", {
      rootType: root.entityType, rootId: root.entityId, limit: "100", ...(cursor ? { cursor } : {}),
    })
    const parsed = CoverageSchema.parse(value)
    if (!Number.isFinite(Date.parse(parsed.asOf))) throw new Error("M365 coverage did not provide a valid as-of time.")
    if (page > 0) partial = true // The API does not bind separate pages to one snapshot.
    asOf = parsed.asOf
    if (parsed.sourceCoverage.some((scope) => scope.rootBinding?.type !== root.entityType || scope.rootBinding.id !== root.entityId)) throw new Error("M365 coverage included a source outside this selected context.")
    scopes.push(...parsed.sourceCoverage)
    cursor = parsed.nextCursor
    if (!cursor) return { scopes, asOf, partial }
  }
  return { scopes, asOf, partial: Boolean(cursor) }
}

export function SourceDiagnostics({ root }: { root: PeWorldRootRef | null }) {
  const [refresh, setRefresh] = useState(0)
  const [connections, setConnections] = useState<ReadState<Connection>>(empty)
  const [coverage, setCoverage] = useState<ReadState<CoverageState>>({ data: null, error: null, loading: Boolean(root) })
  const rootType = root?.entityType
  const rootId = root?.entityId

  useEffect(() => {
    let active = true
    setConnections(empty())
    void centropyGet<unknown>("connections/microsoft-graph/status")
      .then((value) => { const parsed = ConnectionSchema.parse(value); if (active) setConnections({ data: parsed, error: null, loading: false }) })
      .catch((cause) => { if (active) setConnections({ data: null, error: errorLabel(cause), loading: false }) })
    if (rootType && rootId) {
      setCoverage(empty())
      void readRootCoverage({ entityType: rootType, entityId: rootId })
        .then((value) => { if (active) setCoverage({ data: value, error: null, loading: false }) })
        .catch((cause) => { if (active) setCoverage({ data: null, error: errorLabel(cause), loading: false }) })
    } else setCoverage({ data: null, error: null, loading: false })
    return () => { active = false }
  }, [rootType, rootId, refresh])

  return <section className="ct-source-diagnostics" aria-labelledby="ct-source-diagnostics-title">
    <header><div><span className="ct-eyebrow">MICROSOFT 365 / SOURCE TRUTH</span><h3 id="ct-source-diagnostics-title">Connection and evidence coverage</h3></div><button type="button" aria-label="Refresh Microsoft 365 source diagnostics" onClick={() => setRefresh((value) => value + 1)} disabled={connections.loading || coverage.loading}><RefreshCw size={15} /></button></header>
    <p>These are recorded integration and source-scope states. A healthy connection alone does not verify an individual document.</p>
    {connections.loading ? <p role="status">Reading Microsoft connection status…</p> : null}
    {connections.error ? <p className="ct-source-diagnostics__error" role="alert">Connection status unavailable · {connections.error}</p> : null}
    {connections.data ? <div className="ct-source-diagnostics__connections"><strong>{connections.data.summary.active} active of {connections.data.summary.total} configured connection{connections.data.summary.total === 1 ? "" : "s"}</strong>{connections.data.connections.map((connection) => <div key={connection.authProfileRef}><span>{connection.authProfileRef} · {label(connection.status)}{connection.lastErrorCode ? ` · ${label(connection.lastErrorCode)}` : ""}</span><small>{connection.sourceScopes.enabled}/{connection.sourceScopes.total} scopes enabled · {connection.sourceScopes.permissionVerified} permission checked · last verified {dateLabel(connection.lastVerifiedAt)}</small></div>)}{!connections.data.connections.length ? <p>No Microsoft Graph connection is recorded for this tenant.</p> : null}</div> : null}
    {root ? <>
      <h4>Sources bound to {label(root.entityType)} {root.entityId.slice(0, 8)}</h4>
      {coverage.loading ? <p role="status">Reading scoped evidence coverage…</p> : null}
      {coverage.error ? <p className="ct-source-diagnostics__error" role="alert">Scoped coverage unavailable · {coverage.error}</p> : null}
      {coverage.data ? <><p className="ct-source-diagnostics__asof">As of {dateLabel(coverage.data.asOf)}{coverage.data.partial ? " · first 300 scopes shown; more exist" : ""}</p>{coverage.data.scopes.length ? <ol>{coverage.data.scopes.map((scope) => <li key={scope.sourceScopeId}><div><strong>{label(scope.sourceKind)}</strong><span data-state={scope.coverage.state}>{label(scope.coverage.state)}</span></div><p>{scope.providerResourceId ?? "Provider resource unavailable"}</p><dl><div><dt>Freshness</dt><dd>{label(scope.freshness.state)} · observed {dateLabel(scope.freshness.lastObservedAt)}</dd></div><div><dt>Permission</dt><dd>{scope.permission.mode ? label(scope.permission.mode) : "unknown"} · checked {dateLabel(scope.permission.verifiedAt)}</dd></div><div><dt>Integration</dt><dd>{label(scope.integrationHealth.health)} · {label(scope.integrationHealth.syncStatus)}</dd></div><div><dt>Enabled</dt><dd>{scope.enabled ? "Yes" : "No"}</dd></div></dl>{scope.coverage.reason ? <p className="ct-source-diagnostics__reason">Recorded reason · {scope.coverage.reason}</p> : null}{scope.coverage.unresolvedObservations || scope.coverage.ambiguousObservations ? <small>{scope.coverage.unresolvedObservations} unresolved · {scope.coverage.ambiguousObservations} ambiguous observations</small> : null}</li>)}</ol> : <p>No Microsoft source scope is bound to this selected root. This read does not assess unbound or differently bound sources.</p>}</> : null}
    </> : <p>Select an institutional root to inspect source-scope coverage. Connection status above remains tenant scoped.</p>}
  </section>
}
