"use client"

import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"

const Source = z.object({ integration_id: z.string().uuid(), source_scope_id: z.string().uuid(), provider_config_key: z.string(), model: z.string(), status: z.enum(["ACTIVE", "DISABLED"]), revision: z.number().int(), cache_enumeration_completed: z.boolean(), history_limited: z.boolean(), updated_at: z.string() })
const Catalog = z.object({ sources: z.array(Source), providers: z.array(z.object({ providerConfigKey: z.string(), models: z.array(z.string()), readOnly: z.literal(true) })) })
type CatalogValue = z.infer<typeof Catalog>
function reason(cause: unknown) { return cause instanceof Error ? cause.message : "The connection request could not be completed." }

export function NangoConnectionDesk() {
  const [catalog, setCatalog] = useState<CatalogValue | null>(null)
  const [provider, setProvider] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const alive = useRef(true)
  const syncKeys = useRef(new Map<string, string>())
  useEffect(() => {
    let current = true; alive.current = true
    void centropyGet<unknown>("capabilities/nango/sources").then(value => {
      const parsed = Catalog.parse(value)
      if (current) { setCatalog(parsed); setProvider(previous => parsed.providers.some(item => item.providerConfigKey === previous) ? previous : parsed.providers[0]?.providerConfigKey ?? ""); setError(null) }
    }).catch(cause => { if (current) { setCatalog(null); setError(reason(cause)) } })
    return () => { current = false; alive.current = false }
  }, [refresh])
  async function connect() {
    setBusy(true); setError(null); setLink(null)
    try {
      const parsed = z.object({ session: z.object({ connect_link: z.string().url().optional(), expires_at: z.string() }) }).parse(await centropyPost<unknown>("capabilities/nango/connect", { providerConfigKey: provider, idempotencyKey: crypto.randomUUID() }))
      const url = parsed.session.connect_link ? new URL(parsed.session.connect_link) : null
      if (!url || url.protocol !== "https:") throw new Error("The provider did not return a secure authorization link. Configure its hosted Connect flow.")
      if (alive.current) setLink(url.toString())
    } catch (cause) { if (alive.current) setError(reason(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function sync(source: z.infer<typeof Source>) {
    setBusy(true); setError(null); setNotice(null)
    const key = syncKeys.current.get(source.source_scope_id) ?? crypto.randomUUID(); syncKeys.current.set(source.source_scope_id, key)
    try {
      const parsed = z.object({ run: z.object({ id: z.string().uuid(), request: z.object({ kind: z.literal("nango_sync"), integrationId: z.literal(source.integration_id), sourceScopeId: z.literal(source.source_scope_id), model: z.literal(source.model) }) }) }).parse(await centropyPost<unknown>("capabilities/runs", { kind: "nango_sync", integrationId: source.integration_id, sourceScopeId: source.source_scope_id, model: source.model, idempotencyKey: key, timeoutMs: 300_000 }))
      syncKeys.current.delete(source.source_scope_id)
      if (alive.current) setNotice(`Sync accepted · run ${parsed.run.id}. Refresh sources to read its checkpoint after processing.`)
    } catch (cause) { if (alive.current) setError(`${reason(cause)} Retrying this source reuses the submission key.`) }
    finally { if (alive.current) setBusy(false) }
  }
  return <details><summary>Connect more read-only sources</summary><section className="ct-source-diagnostics" aria-label="Read-only connected sources">
    <header><div><span className="ct-eyebrow">CONNECTED SOURCES / NANGO</span><h3>Read-only source connections</h3></div><button type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Refresh sources</button></header>
    <p>Connect an approved service, then sync its configured read-only models. Synced records retain their source and checkpoint.</p>
    {catalog?.providers.length ? <form onSubmit={event => { event.preventDefault(); void connect() }}><label>Service<select aria-label="Service" value={provider} onChange={event => setProvider(event.target.value)}>{catalog.providers.map(item => <option key={item.providerConfigKey} value={item.providerConfigKey}>{item.providerConfigKey}</option>)}</select></label><button type="submit" disabled={busy || !provider}>Create authorization link</button></form> : null}
    {link ? <p><a href={link} target="_blank" rel="noopener noreferrer">Open secure authorization</a><small> · Return here and refresh sources after authorization.</small></p> : null}
    {busy ? <p role="status">Processing connection request…</p> : null}
    {error ? <p role="alert" className="ct-source-diagnostics__error">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {catalog ? <ul>{catalog.sources.map(source => <li key={source.source_scope_id}><strong>{source.provider_config_key} · {source.model}</strong><p>{source.status.toLowerCase()} · checkpoint {source.revision}{source.history_limited ? " · provider history is limited" : ""}{source.cache_enumeration_completed ? " · cached enumeration completed" : ""}</p><button type="button" disabled={busy || source.status !== "ACTIVE"} onClick={() => void sync(source)}>Sync this source</button></li>)}{!catalog.sources.length ? <li>No connection has completed authorization yet.</li> : null}</ul> : null}
  </section></details>
}
