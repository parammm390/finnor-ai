"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Check, Settings2, X } from "lucide-react"
import { useCentropyAuth } from "./lib/centropy-auth"
import { centropyGet, centropyPut } from "./lib/api"
import { onBusinessInvalidation } from "./lib/business-invalidation"
import { DEFAULT_TENANT_WORKSPACE_CONFIG, normalizeWorkspaceConfig, type TenantWorkspaceConfig } from "./lib/workspace-config"
import "./centropy-theme.css"

type ConfigStatus = "idle" | "loading" | "ready" | "saving" | "error"
interface WorkspaceConfigState {
  config: TenantWorkspaceConfig
  revision: string | null
  editable: boolean
  status: ConfigStatus
  error: string | null
  settingsOpen: boolean
  openSettings: () => void
  closeSettings: () => void
  save: (config: TenantWorkspaceConfig) => Promise<boolean>
}

const WorkspaceConfigContext = createContext<WorkspaceConfigState>({
  config: DEFAULT_TENANT_WORKSPACE_CONFIG, revision: null, editable: false, status: "idle", error: null, settingsOpen: false,
  openSettings: () => {}, closeSettings: () => {}, save: async () => false,
})

export function useWorkspaceConfig(): WorkspaceConfigState {
  return useContext(WorkspaceConfigContext)
}

export function WorkspaceSettingsButton({ compact = false }: { compact?: boolean }) {
  const workspace = useWorkspaceConfig()
  if (!workspace.editable) return null
  return <button type="button" className="centropy-workspace-settings-button" data-compact={compact ? "true" : undefined} onClick={workspace.openSettings} aria-label="Open workspace settings" title="Workspace settings"><Settings2 size={15} aria-hidden /><span>{compact ? "" : "Workspace"}</span></button>
}

function WorkspaceSettingsDrawer() {
  const { config, settingsOpen, closeSettings, save, status, error } = useWorkspaceConfig()
  const [draft, setDraft] = useState(config)
  const [saved, setSaved] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (settingsOpen && !wasOpenRef.current) {
      setDraft(config)
      setSaved(false)
    }
    wasOpenRef.current = settingsOpen
  }, [config, settingsOpen])

  useEffect(() => {
    if (!settingsOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }))
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeSettings() }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [closeSettings, settingsOpen])

  if (!settingsOpen) return null
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const ok = await save(draft)
    setSaved(ok)
  }
  return (
    <div className="centropy-workspace-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSettings() }}>
      <aside className="centropy-workspace-settings" role="dialog" aria-modal="true" aria-labelledby="centropy-workspace-settings-title">
        <header><div><span>Tenant workspace</span><h2 id="centropy-workspace-settings-title">Operational presentation</h2><p>Small, tenant-wide controls only. Authority and backend behavior do not change here.</p></div><button ref={closeButtonRef} type="button" onClick={closeSettings} aria-label="Close workspace settings"><X size={17} /></button></header>
        <form onSubmit={submit}>
          <section><div className="centropy-workspace-settings__heading"><strong>Canonical navigation</strong><span>Home · Deals · Work · Agents</span></div><p>Workspace V3 fixes the institutional operating surfaces and their order. Tenant preferences cannot hide, rename, or reorder them.</p></section>
          <section className="centropy-workspace-settings__split"><div><div className="centropy-workspace-settings__heading"><strong>Voice availability</strong></div><label className="centropy-workspace-settings__toggle"><input type="checkbox" checked={draft.voiceEnabled} onChange={(event) => setDraft((current) => ({ ...current, voiceEnabled: event.target.checked }))} /><span>Voice command input</span></label></div><div><div className="centropy-workspace-settings__heading"><strong>Inspector visibility</strong></div><label className="centropy-workspace-settings__toggle"><input type="checkbox" checked={draft.visibility.policy} onChange={(event) => setDraft((current) => ({ ...current, visibility: { ...current.visibility, policy: event.target.checked } }))} /><span>Policy context</span></label><label className="centropy-workspace-settings__toggle"><input type="checkbox" checked={draft.visibility.authority} onChange={(event) => setDraft((current) => ({ ...current, visibility: { ...current.visibility, authority: event.target.checked } }))} /><span>Authority context</span></label></div></section>
          <section><div className="centropy-workspace-settings__heading"><strong>Brand tokens</strong><span>Bounded tokens, never arbitrary CSS</span></div><div className="centropy-workspace-settings__brand"><label><span>Accent</span><select value={draft.brand.accent} onChange={(event) => setDraft((current) => ({ ...current, brand: { ...current.brand, accent: event.target.value as TenantWorkspaceConfig["brand"]["accent"] } }))}><option value="cyan">Cyan</option><option value="teal">Teal</option><option value="amber">Amber</option><option value="violet">Violet</option></select></label><label><span>Corner tone</span><select value={draft.brand.radius} onChange={(event) => setDraft((current) => ({ ...current, brand: { ...current.brand, radius: event.target.value as TenantWorkspaceConfig["brand"]["radius"] } }))}><option value="soft">Soft</option><option value="precise">Precise</option></select></label><label><span>Mark</span><input value={draft.brand.mark} maxLength={3} required onChange={(event) => setDraft((current) => ({ ...current, brand: { ...current.brand, mark: event.target.value } }))} /></label></div></section>
          {error && <p className="centropy-workspace-settings__error" role="alert">{error}</p>}
          <footer><span>{saved ? <><Check size={13} /> Saved for this tenant</> : "Presentation only · policy remains authoritative"}</span><button type="button" onClick={closeSettings}>Cancel</button><button type="submit" disabled={status === "saving"}>{status === "saving" ? "Saving…" : "Save workspace"}</button></footer>
        </form>
      </aside>
    </div>
  )
}

export function WorkspaceConfigProvider({ children }: { children: ReactNode }) {
  const { session, role } = useCentropyAuth()
  const sessionUserId = session?.user.id ?? null
  const [config, setConfig] = useState(DEFAULT_TENANT_WORKSPACE_CONFIG)
  const [revision, setRevision] = useState<string | null>(null)
  const [editable, setEditable] = useState(false)
  const [status, setStatus] = useState<ConfigStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const requestSequenceRef = useRef(0)

  const refresh = useCallback(async (preserveOnError: boolean) => {
    if (!sessionUserId || !role) return
    const sequence = ++requestSequenceRef.current
    setStatus((current) => preserveOnError && current === "ready" ? current : "loading")
    setError(null)
    try {
      const response = await centropyGet<{ config: unknown; editable: boolean; revision: string | null }>("workspace-config")
      if (sequence !== requestSequenceRef.current) return
      setConfig(normalizeWorkspaceConfig(response.config))
      setRevision(response.revision)
      setEditable(response.editable)
      setStatus("ready")
    } catch {
      if (sequence !== requestSequenceRef.current) return
      if (!preserveOnError) {
        setConfig(DEFAULT_TENANT_WORKSPACE_CONFIG)
        setRevision(null)
        setEditable(role === "owner")
      }
      setStatus("error")
      setError(preserveOnError ? "The latest tenant experience refresh was delayed. The last valid presentation remains active." : "Tenant workspace controls are not available from the current backend.")
    }
  }, [role, sessionUserId])

  useEffect(() => {
    if (!sessionUserId || !role) {
      requestSequenceRef.current += 1
      setConfig(DEFAULT_TENANT_WORKSPACE_CONFIG); setRevision(null); setEditable(false); setStatus("idle")
      return
    }
    void refresh(false)
  }, [refresh, role, sessionUserId])

  useEffect(() => onBusinessInvalidation((signal) => {
    if (!sessionUserId || !signal.tags.includes("preferences")) return
    void refresh(true)
  }), [refresh, sessionUserId])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.centropyTenantAccent = config.brand.accent
    root.dataset.centropyWorkspaceRadius = config.brand.radius
    root.dataset.centropySurfaceTone = config.brand.surfaceTone
    root.dataset.centropyExperienceDensity = config.brand.density
    root.dataset.centropyExperienceTypography = config.brand.typography
    root.dataset.centropyExperienceMotion = config.brand.motion
    return () => {
      delete root.dataset.centropyTenantAccent; delete root.dataset.centropyWorkspaceRadius; delete root.dataset.centropySurfaceTone
      delete root.dataset.centropyExperienceDensity; delete root.dataset.centropyExperienceTypography; delete root.dataset.centropyExperienceMotion
    }
  }, [config.brand.accent, config.brand.density, config.brand.motion, config.brand.radius, config.brand.surfaceTone, config.brand.typography])

  const save = useCallback(async (next: TenantWorkspaceConfig) => {
    setStatus("saving"); setError(null)
    try {
      const response = await centropyPut<{ config: unknown; editable: boolean; revision: string | null }>("workspace-config", next)
      requestSequenceRef.current += 1
      setConfig(normalizeWorkspaceConfig(response.config)); setRevision(response.revision); setEditable(response.editable); setStatus("ready")
      return true
    } catch (saveError) {
      setStatus("error"); setError(saveError instanceof Error ? saveError.message : "Workspace configuration could not be saved.")
      return false
    }
  }, [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const value = useMemo<WorkspaceConfigState>(() => ({ config, revision, editable, status, error, settingsOpen, openSettings: () => setSettingsOpen(true), closeSettings, save }), [closeSettings, config, editable, error, revision, save, settingsOpen, status])
  return <WorkspaceConfigContext.Provider value={value}>{children}<WorkspaceSettingsDrawer /></WorkspaceConfigContext.Provider>
}

/** Deterministic test-only composition seam for the build-gated fixture route.
 * It exercises the production registries/components with a validated static
 * manifest and never grants edit authority or bypasses backend authorization. */
export function WorkspaceConfigFixtureProvider({ config: input, children }: { config: unknown; children: ReactNode }) {
  const config = useMemo(() => normalizeWorkspaceConfig(input), [input])
  const value = useMemo<WorkspaceConfigState>(() => ({
    config, revision: "fixture", editable: false, status: "ready", error: null, settingsOpen: false,
    openSettings: () => {}, closeSettings: () => {}, save: async () => false,
  }), [config])
  return <WorkspaceConfigContext.Provider value={value}>{children}</WorkspaceConfigContext.Provider>
}
