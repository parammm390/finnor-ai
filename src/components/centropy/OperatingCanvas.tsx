"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowRight, BrainCircuit, LockKeyhole, LogOut, PanelLeftClose, PanelLeftOpen, Search, Settings2 } from "lucide-react"
import { WorkspaceSettingsButton } from "./WorkspaceConfigProvider"
import { useCentropyAuth } from "./lib/centropy-auth"
import { usePeOperatingContext } from "./pe/PeOperatingContextProvider"
import { humanize, isInspectionTarget, refKey, type CompanyBrainNode } from "./pe/contracts"
import { withPeOperatingContext } from "./pe/context-routing"
import { OperationalSurfaceNav, type OperationalSurface } from "./surfaces/OperationalSurfaceNav"
import { CommandInterfaceProvider, useCommandInterface } from "./product/CommandInterface"
import { usePeProductData } from "./product/ProductDataProvider"
import { productNodeLabel } from "./product/deal-model"
import { ErrorState, Skeleton, SourceHealth, Status, TruthState } from "./product/primitives"
import { UniversalInspector } from "./product/UniversalInspector"
import "./product/workstation.css"

const OBJECT_GROUPS: Array<{ label: string; section: string; types: ReadonlySet<string> }> = [
  { label: "Deal", section: "overview", types: new Set(["pe_deal"]) },
  { label: "Investment Case", section: "overview", types: new Set(["pe_investment_case", "pe_thesis", "pe_assumption", "pe_decision"]) },
  { label: "Workstreams", section: "diligence", types: new Set(["pe_workstream", "pe_request", "pe_deliverable", "pe_dependency", "pe_milestone"]) },
  { label: "Findings / Risks", section: "diligence", types: new Set(["pe_finding", "pe_deal_risk", "pe_finding_risk_link"]) },
  { label: "IC", section: "ic", types: new Set(["pe_ic_case", "pe_ic_memo", "pe_ic_question", "pe_ic_recommendation", "pe_ic_vote", "pe_ic_dissent", "pe_ic_condition", "pe_ic_decision_proposal"]) },
  { label: "Closing", section: "closing", types: new Set(["pe_closing_condition", "pe_closing_item"]) },
  { label: "Linked Work", section: "work", types: new Set(["work"]) },
]

function activeSurface(pathname: string): OperationalSurface {
  if (pathname.startsWith("/centropy/deals")) return "deals"
  if (pathname.startsWith("/centropy/work")) return "work"
  if (pathname.startsWith("/centropy/agents")) return "agents"
  return "home"
}

function ObjectTree({ nodes, edges, onNavigate }: { nodes: CompanyBrainNode[]; edges: NonNullable<ReturnType<typeof usePeProductData>["brain"]["data"]>["edges"]; onNavigate?: () => void }) {
  const operating = usePeOperatingContext()
  const selected = operating.context.selectedObject ? refKey(operating.context.selectedObject) : null
  if (operating.context.root?.entityType !== "pe_deal") return null
  return <section className="pw-object-tree" aria-label="Active Deal object tree"><header><span>DEAL OBJECT TREE</span><TruthState state={nodes.length ? "KNOWN" : "KNOWN_EMPTY"} compact /></header>{OBJECT_GROUPS.map((group) => {
    const matches = nodes.filter((node) => group.types.has(node.type))
    const href = withPeOperatingContext(`/centropy/deals/${operating.context.root!.entityId}/${group.section}`, operating.context)
    return <div className="pw-object-group" key={group.label}><Link href={href} onClick={onNavigate}><span>{group.label}</span><b>{matches.length}</b></Link>{matches.slice(0, 3).map((node) => isInspectionTarget(node.inspectionTarget) ? <button type="button" key={refKey(node.ref)} data-active={selected === refKey(node.ref) ? "true" : undefined} onClick={() => { operating.inspect(node.inspectionTarget, node.ref); onNavigate?.() }}><i /><span>{productNodeLabel(node, nodes, edges)}</span></button> : null)}{matches.length > 3 ? <small>+{matches.length - 3} more in workspace</small> : null}</div>
  })}</section>
}

function ProtectedState({ kind, detail, retry }: { kind: "loading" | "signed-out" | "auth-error" | "role-error" | "denied"; detail?: string; retry?: () => void }) {
  if (kind === "loading") return <div className="pw-protected-state"><Skeleton rows={6} label="Restoring authenticated workspace" /></div>
  if (kind === "signed-out") return <div className="pw-protected-state pe-state"><section className="pw-empty-state"><LockKeyhole size={20} /><h1>Decision context stays private by default.</h1><p>Sign in to inspect tenant-scoped Deals, Work, evidence, decisions, and governed agents.</p></section><Link className="pw-primary-action" href="/centropy/login">Sign in <ArrowRight size={14} /></Link></div>
  return <div className="pw-protected-state"><ErrorState title={kind === "denied" ? "No active Workspace V3 surface" : kind === "role-error" ? "Workspace authority is unavailable" : "Centropy could not restore sign-in"} detail={detail ?? "The authenticated boundary did not resolve."} state={kind === "denied" ? "DENIED" : "UNAVAILABLE"} onRetry={retry} /></div>
}

function Workstation({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const command = useCommandInterface()
  const operating = usePeOperatingContext()
  const product = usePeProductData()
  const auth = useCentropyAuth()
  const [mounted, setMounted] = useState(false)
  const [railOpen, setRailOpen] = useState(false)
  const previousPathname = useRef(pathname)
  useEffect(() => setMounted(true), [])
  useEffect(() => {
    if (previousPathname.current !== pathname) setRailOpen(false)
    previousPathname.current = pathname
  }, [pathname])
  const surface = activeSurface(pathname)
  const roots = product.roots.data ?? []
  const deals = roots.filter((item) => item.rootRefs[0]?.entityType === "pe_deal")
  const activeRootResult = roots.find((item) => item.rootRefs.some((root) => root.entityType === operating.context.root?.entityType && root.entityId === operating.context.root?.entityId))
  const selectedDeal = operating.context.root?.entityType === "pe_deal" ? operating.context.root.entityId : ""
  const isAuthRoute = pathname === "/centropy/login" || pathname === "/centropy/reset-password"
  // Supabase can restore a persisted browser session before a streamed shell
  // finishes hydrating. Keep the server and first client paint deterministic;
  // the real identity replaces this neutral label immediately after mount.
  const userLabel = mounted ? auth.session?.user.email ?? "Authenticated user" : "Authenticated user"

  const center = useMemo(() => {
    if (!mounted || (auth.loading && !auth.session)) return <ProtectedState kind="loading" />
    if (auth.authError) return <ProtectedState kind="auth-error" detail={auth.authError} retry={auth.retryAuth} />
    if (!auth.session) return <ProtectedState kind="signed-out" />
    if (auth.roleLoading && !auth.role) return <ProtectedState kind="loading" />
    if (auth.roleError && !auth.role) return <ProtectedState kind="role-error" detail={auth.roleError} retry={auth.retryRole} />
    if (auth.role !== "owner") return <ProtectedState kind="denied" detail="The active Private Equity workspace defines the owner product role only. No legacy role surface is substituted." />
    return children
  }, [auth, children, mounted])

  if (isAuthRoute) return <>{children}</>

  function switchDeal(id: string) {
    const root = deals.find((item) => item.rootRefs[0]?.entityId === id)?.rootRefs[0]
    if (!root) return
    if (pathname.startsWith("/centropy/deals/")) {
      router.push(withPeOperatingContext(`/centropy/deals/${id}/overview`, { root, selectedObject: null, workId: null }), { scroll: false })
    } else {
      operating.selectRoot(root)
    }
  }

  return <div className="pw-shell" data-surface={surface}>
    <header className="pw-global-bar">
      <Link className="pw-brand" href={withPeOperatingContext("/centropy", operating.context)} aria-label="Centropy home"><span>C</span><strong>Centropy</strong></Link>
      <label className="pw-deal-switcher"><span>Deal</span><select aria-label="Deal switcher" value={selectedDeal} onChange={(event) => switchDeal(event.target.value)}><option value="">Select a Deal</option>{deals.map((deal) => {
        const root = deal.rootRefs[0]!
        return <option key={root.entityId} value={root.entityId}>{deal.label}</option>
      })}</select></label>
      <button className="pw-command-trigger" type="button" onClick={() => command.openCommand()}><Search size={14} /><span>Search or command</span><kbd>⌘K</kbd></button>
      <div className="pw-current-context"><BrainCircuit size={14} /><span><small>Current PE context</small><strong>{activeRootResult?.label ?? (operating.context.root ? humanize(operating.context.root.entityType) : "No Deal selected")}</strong></span></div>
      <SourceHealth sources={product.sources} onRefresh={product.refreshAll} />
      <details className="pw-user-menu"><summary><span>{userLabel.slice(0, 1).toUpperCase()}</span><strong>{userLabel}</strong></summary><div><WorkspaceSettingsButton /><button type="button" onClick={() => void auth.signOut()}><LogOut size={14} /> Sign out</button></div></details>
    </header>
    <div className="pw-workstation">
      <aside className="pw-context-rail" id="pw-context-rail" data-expanded={railOpen ? "true" : "false"}>
        <div className="pw-context-rail__heading"><span>WORKSPACE</span><button type="button" disabled={!mounted} onClick={() => setRailOpen((open) => !open)} aria-controls="pw-context-rail" aria-expanded={railOpen} aria-label={railOpen ? "Close workspace context" : "Open workspace context"}>{railOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}</button></div>
        <OperationalSurfaceNav active={surface} />
        {operating.context.root ? <div className="pw-context-summary"><span>ACTIVE ROOT</span><strong>{activeRootResult?.label ?? humanize(operating.context.root.entityType)}</strong><Status value={product.brain.data?.nodes.find((node) => node.ref.type === operating.context.root?.entityType && node.ref.id === operating.context.root.entityId)?.state} /></div> : null}
        <ObjectTree nodes={product.brain.data?.nodes ?? []} edges={product.brain.data?.edges ?? []} onNavigate={() => setRailOpen(false)} />
        <footer><Settings2 size={13} /><span>Workspace V3 · authority remains backend-owned</span></footer>
      </aside>
      <main className="pw-active-workspace" id="main-workspace">{center}</main>
      <UniversalInspector />
    </div>
  </div>
}

export default function OperatingCanvas({ children }: { children: ReactNode }) {
  return <CommandInterfaceProvider><Workstation>{children}</Workstation></CommandInterfaceProvider>
}
