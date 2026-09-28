"use client"

import { useEffect, useState } from "react"
import { ArrowRight, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"

const UUID = z.string().uuid()
const ScopeSchema = z.object({
  sourceScopeId: UUID, integrationId: UUID, sourceKind: z.string(), scopeKey: z.string(), enabled: z.boolean(),
  rootBinding: z.object({ type: z.string(), id: UUID }).nullable(),
  configuration: z.object({ driveId: z.string().optional(), rootItemId: z.string().optional() }).passthrough(),
  permission: z.object({ verifiedAt: z.string().nullable(), required: z.array(z.string()), effective: z.array(z.string()) }).passthrough(),
  integrationHealth: z.object({ health: z.string() }).passthrough(),
}).passthrough()
const ScopePageSchema = z.object({ sourceScopes: z.array(ScopeSchema), nextCursor: UUID.nullable() }).passthrough()
const CreationSchema = z.object({
  id: UUID, documentId: UUID, localVersionId: UUID, integrationId: UUID, sourceScopeId: UUID,
  driveId: z.string(), parentItemId: z.string(), name: z.string(), mode: z.string(), status: z.string(),
  readbackVersionId: UUID.nullable(), providerItemId: z.string().nullable(), failure: z.string().nullable(),
}).passthrough()
const ArtifactSchema = z.object({
  documentId: UUID, version: z.object({ id: UUID }).passthrough(),
  semantic: z.object({ kind: z.string(), semanticHash: z.string() }).passthrough(),
}).passthrough()
const ReviewsSchema = z.array(z.object({ id: UUID, state: z.string() }).passthrough())

type Scope = z.infer<typeof ScopeSchema>
type Creation = z.infer<typeof CreationSchema>
type Mode = "APP_ONLY_FILE_CREATE" | "DELEGATED_FILE_CREATE"
type Intent = {
  documentId: string; localVersionId: string; semanticHash: string; integrationId: string; sourceScopeId: string;
  driveId: string; parentItemId: string; name: string; mode: Mode; conflictBehavior: "fail"
}

function rowField(row: Record<string, unknown>, key: string): string | null {
  const raw = row[key] ?? row[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]
  return typeof raw === "string" && raw.trim() ? raw : null
}

function destinationReady(scope: Scope, dealId: string | null): boolean {
  const required = scope.permission.required
  const effective = new Set(scope.permission.effective)
  return scope.sourceKind === "sharepoint_drive" && scope.enabled && Boolean(scope.permission.verifiedAt)
    && required.every((permission) => effective.has(permission))
    && Boolean(scope.configuration.driveId?.trim() && scope.configuration.rootItemId?.trim())
    && (!scope.rootBinding || scope.rootBinding.type === "pe_deal" && scope.rootBinding.id === dealId)
}

async function readScopes(): Promise<{ scopes: Scope[]; partial: boolean }> {
  const scopes: Scope[] = []
  let cursor: string | null = null
  for (let page = 0; page < 10; page += 1) {
    const value: unknown = await centropyGet("integrations/microsoft-graph/source-scopes", { limit: "100", ...(cursor ? { cursor } : {}) })
    const result = ScopePageSchema.parse(value)
    scopes.push(...result.sourceScopes)
    cursor = result.nextCursor
    if (!cursor) return { scopes, partial: page > 0 }
  }
  return { scopes, partial: true }
}

function validFileName(name: string): boolean {
  return name.length > 5 && name.length <= 255 && name.toLowerCase().endsWith(".pptx") && !/[\\/\u0000-\u001f]/.test(name)
}

export function ArtifactPublicationDesk({ documentId, versionId, semanticHash, title, dealId, reviews, providerCreations, onRecorded, onVersionChange }: {
  documentId: string; versionId: string; semanticHash: string; title: string; dealId: string | null;
  reviews: Record<string, unknown>[]; providerCreations: Record<string, unknown>[];
  onRecorded: () => void; onVersionChange: (versionId: string) => void
}) {
  const [catalog, setCatalog] = useState<{ scopes: Scope[]; partial: boolean } | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [scopeId, setScopeId] = useState("")
  const [name, setName] = useState(() => {
    const base = title.replace(/\.pptx$/i, "").trim()
    return `${base || "IC presentation"}.pptx`
  })
  const [mode, setMode] = useState<Mode>("APP_ONLY_FILE_CREATE")
  const [intent, setIntent] = useState<Intent | null>(null)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [result, setResult] = useState<Creation | null>(null)
  const approved = reviews.length < 200 && rowField(reviews.at(-1) ?? {}, "state") === "approved"
  const ready = catalog?.scopes.filter((scope) => destinationReady(scope, dealId)) ?? []
  const selected = ready.find((scope) => scope.sourceScopeId === scopeId) ?? null
  const recorded = providerCreations.filter((row) => rowField(row, "localVersionId") === versionId || rowField(row, "readbackVersionId") === versionId)
  const unresolvedHistory = recorded.some((row) => ["prepared", "writing", "acknowledged", "unknown_delivery"].includes(rowField(row, "status") ?? ""))

  useEffect(() => {
    let active = true
    setCatalogLoading(true)
    setCatalogError(null)
    void readScopes().then((value) => { if (active) setCatalog(value) })
      .catch((cause) => { if (active) { setCatalog(null); setCatalogError(cause instanceof Error ? cause.message : "Destination catalog unavailable") } })
      .finally(() => { if (active) setCatalogLoading(false) })
    return () => { active = false }
  }, [catalogRevision])

  function prepare() {
    if (!approved || !selected || !validFileName(name.trim()) || busy || uncertain || unresolvedHistory) return
    setIntent({ documentId, localVersionId: versionId, semanticHash, integrationId: selected.integrationId,
      sourceScopeId: selected.sourceScopeId, driveId: selected.configuration.driveId!, parentItemId: selected.configuration.rootItemId!,
      name: name.trim(), mode, conflictBehavior: "fail" })
    setNotice(null)
  }

  async function publish() {
    if (!intent || busy || uncertain || unresolvedHistory) return
    setBusy(true)
    setNotice(null)
    try {
      const [artifactValue, reviewValue, scopeValue] = await Promise.all([
        centropyGet<unknown>(`documents/${documentId}/artifact`, { versionId }),
        centropyGet<unknown>(`documents/${documentId}/artifact/reviews`, { versionId }),
        centropyGet<unknown>(`integrations/microsoft-graph/source-scopes/${intent.sourceScopeId}`),
      ])
      const artifact = ArtifactSchema.parse(artifactValue)
      const freshReviews = ReviewsSchema.parse(reviewValue)
      const scope = ScopeSchema.parse(scopeValue)
      if (artifact.documentId !== intent.documentId || artifact.version.id !== intent.localVersionId
        || artifact.semantic.kind !== "pptx" || artifact.semantic.semanticHash !== intent.semanticHash) throw new Error("The exact presentation version changed. Review it again.")
      if (freshReviews.length >= 200 || freshReviews.at(-1)?.state !== "approved") throw new Error("The exact version's latest review is no longer approved.")
      if (!destinationReady(scope, dealId) || scope.integrationId !== intent.integrationId
        || scope.configuration.driveId !== intent.driveId || scope.configuration.rootItemId !== intent.parentItemId) throw new Error("The publication destination or its verified permission changed.")
      const submitted = CreationSchema.parse(await centropyPost<unknown>(`documents/${documentId}/artifact/publish-new`, {
        localVersionId: intent.localVersionId, integrationId: intent.integrationId, sourceScopeId: intent.sourceScopeId,
        driveId: intent.driveId, parentItemId: intent.parentItemId, name: intent.name, mode: intent.mode, conflictBehavior: "fail",
      }))
      const persisted = CreationSchema.parse(await centropyGet<unknown>(`documents/${documentId}/artifact/provider-creations/${submitted.id}`))
      if (persisted.documentId !== intent.documentId || persisted.localVersionId !== intent.localVersionId
        || persisted.integrationId !== intent.integrationId || persisted.sourceScopeId !== intent.sourceScopeId
        || persisted.driveId !== intent.driveId || persisted.parentItemId !== intent.parentItemId || persisted.name !== intent.name
        || persisted.mode !== intent.mode || persisted.status !== submitted.status) throw new Error("Publication readback did not match the reviewed intent.")
      setResult(persisted)
      onRecorded()
      if (persisted.status === "verified" || persisted.status === "verified_provider_normalized") {
        if (!persisted.readbackVersionId || !persisted.providerItemId) throw new Error("Verified publication lacks a provider item or exact readback version.")
        const readback = ArtifactSchema.parse(await centropyGet<unknown>(`documents/${documentId}/artifact`, { versionId: persisted.readbackVersionId }))
        if (readback.documentId !== documentId || readback.version.id !== persisted.readbackVersionId || readback.semantic.kind !== "pptx") throw new Error("Provider readback is not a verifiable presentation version.")
        setIntent(null)
        setNotice(`Microsoft 365 returned and verified version ${persisted.readbackVersionId}. Inspect and review that exact version before selecting it into IC.`)
      } else {
        setUncertain(true)
        setNotice(`Publication ${persisted.id} is ${persisted.status.replaceAll("_", " ")}${persisted.failure ? ` · ${persisted.failure}` : ""}. Inspect the recorded operation before another attempt.`)
      }
    } catch (cause) {
      setUncertain(true)
      setNotice(`${cause instanceof Error ? cause.message : "Publication could not be verified"} The provider action may have committed. Refresh recorded publication history before another attempt.`)
      onRecorded()
    } finally { setBusy(false) }
  }

  return <section className="ct-artifact__section ct-artifact-publication" aria-label="Publish exact presentation version">
    <header><div><span className="ct-eyebrow">ARTIFACT → MICROSOFT 365</span><h3>Publish and verify this presentation</h3></div><ShieldCheck size={20} aria-hidden="true" /></header>
    <p>Publication creates a file in the selected SharePoint folder and records the provider readback as a new exact version. IC selection and committee approval remain separate actions.</p>
    {recorded.length ? <div className="ct-artifact-publication__history"><strong>Recorded publication attempts for this version</strong>{recorded.map((row, index) => {
      const id = rowField(row, "id")
      const status = rowField(row, "status") ?? "unknown"
      const readbackId = rowField(row, "readbackVersionId")
      return <div key={id ?? index}><span>{status.replaceAll("_", " ")} · {id ?? "record unavailable"}</span>{readbackId ? <button type="button" onClick={() => onVersionChange(readbackId)}>Open provider readback <ExternalLink size={12} /></button> : null}</div>
    })}</div> : null}
    {unresolvedHistory ? <p role="alert">A prior provider creation for this version has no terminal verification. Inspect its recorded status before starting another publication.</p> : null}
    {!approved ? <p role="status">The latest review of this exact version must be approved before publication. {reviews.length >= 200 ? "The review history has reached its verification limit." : "The current review is not approved."}</p> : null}
    {catalogLoading ? <p role="status">Reading configured Microsoft destinations…</p> : null}
    {catalogError ? <p role="alert">Destination catalog unavailable · {catalogError}</p> : null}
    {catalog && !ready.length ? <p role="status">No configured SharePoint folder has verified permission for this Deal. Register a Microsoft connection and a SharePoint drive scope with a destination folder before publishing.</p> : null}
    {catalog?.partial ? <p>Destination catalog spans multiple pages or reached its read limit. Confirm the selected folder before publishing.</p> : null}
    {ready.length ? <div className="ct-artifact-publication__fields">
      <label>Destination folder<select value={scopeId} disabled={busy || !!intent || uncertain} onChange={(event) => setScopeId(event.target.value)}><option value="">Choose a verified destination</option>{ready.map((scope) => <option key={scope.sourceScopeId} value={scope.sourceScopeId}>{scope.scopeKey} · {scope.rootBinding ? "Deal scoped" : "Tenant scope"} · {scope.integrationHealth.health}</option>)}</select></label>
      <label>Published file name<input value={name} maxLength={255} disabled={busy || !!intent || uncertain} onChange={(event) => setName(event.target.value)} /></label>
      <label>Microsoft access<select value={mode} disabled={busy || !!intent || uncertain} onChange={(event) => setMode(event.target.value as Mode)}><option value="APP_ONLY_FILE_CREATE">Connected service</option><option value="DELEGATED_FILE_CREATE">My Microsoft connection</option></select></label>
    </div> : null}
    {selected ? <p>Selected drive {selected.configuration.driveId} · folder {selected.configuration.rootItemId} · permission verified {selected.permission.verifiedAt}. The backend checks authority and provider scope again before any write.</p> : null}
    {!intent && ready.length ? <button type="button" disabled={!approved || !selected || !validFileName(name.trim()) || busy || uncertain || unresolvedHistory} onClick={prepare}>Review exact publication <ArrowRight size={14} /></button> : null}
    {intent ? <div className="ct-artifact-publication__review"><strong>Confirm the provider write</strong><dl><div><dt>Artifact version</dt><dd>{intent.localVersionId}</dd></div><div><dt>Semantic hash</dt><dd>{intent.semanticHash}</dd></div><div><dt>Destination</dt><dd>{intent.driveId} / {intent.parentItemId}</dd></div><div><dt>File</dt><dd>{intent.name}</dd></div><div><dt>Access</dt><dd>{intent.mode === "APP_ONLY_FILE_CREATE" ? "Connected service" : "My Microsoft connection"}</dd></div></dl><p>The file will be created only if the target name is available. The returned provider item and exact readback version will be verified.</p><div><button type="button" disabled={busy || uncertain} onClick={() => setIntent(null)}>Back</button><button type="button" disabled={busy || uncertain || unresolvedHistory} onClick={() => void publish()}>{busy ? "Publishing…" : "Publish to Microsoft 365"}</button></div></div> : null}
    {notice ? <p role={uncertain ? "alert" : "status"} className="ct-artifact-publication__notice">{notice}</p> : null}
    {result?.readbackVersionId && (result.status === "verified" || result.status === "verified_provider_normalized") ? <button type="button" onClick={() => onVersionChange(result.readbackVersionId!)}>Inspect verified provider version <ExternalLink size={13} /></button> : null}
    {uncertain ? <button type="button" onClick={() => { setCatalogRevision((value) => value + 1); onRecorded() }}><RefreshCw size={13} /> Refresh recorded state</button> : null}
  </section>
}
