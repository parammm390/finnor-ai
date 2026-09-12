"use client"

import Link from "next/link"
import { useEffect, useState, type ReactNode } from "react"
import { AlertTriangle, ArrowRight, LockKeyhole, RotateCcw } from "lucide-react"
import { OperationalSurfaceNav } from "../surfaces/OperationalSurfaceNav"
import { useJarvisAuth } from "../lib/jarvis-auth"
import type { OperationalSurface } from "../surfaces/surface-routes"
import "./pe-surfaces.css"

export function PeSurfaceFrame({ active, children }: { active: OperationalSurface; children: ReactNode }) {
  return <div className="pe-shell" data-pe-surface={active}><OperationalSurfaceNav active={active} />{children}</div>
}

export function PeOwnerBoundary({ active, children }: { active: OperationalSurface; children: ReactNode }) {
  const [mounted, setMounted] = useState(false)
  const { session, loading, authError, retryAuth, role, roleLoading, roleError, retryRole } = useJarvisAuth()
  useEffect(() => setMounted(true), [])
  if (!mounted) return <PeSurfaceFrame active={active}><main className="pe-state"><span className="pe-state__pulse" /><h1>Restoring your operating session</h1><p>No private source is read until authentication resolves.</p></main></PeSurfaceFrame>
  if (loading && !session) return <PeSurfaceFrame active={active}><main className="pe-state"><span className="pe-state__pulse" /><h1>Restoring your operating session</h1><p>No private source is read until authentication resolves.</p></main></PeSurfaceFrame>
  if (authError) return <PeSurfaceFrame active={active}><main className="pe-state"><AlertTriangle /><h1>JARVIS could not restore sign-in</h1><p>{authError}</p><button type="button" onClick={retryAuth}><RotateCcw size={14} /> Retry connection</button></main></PeSurfaceFrame>
  if (!session) return <PeSurfaceFrame active={active}><main className="pe-state pe-state--public"><LockKeyhole /><span className="pe-kicker">PRIVATE EQUITY OPERATING SYSTEM</span><h1>Decision context stays private by default.</h1><p>Sign in to inspect tenant-scoped deals, Work, evidence, decisions, and governed agents. This signed-out state contains no sample operating facts.</p><Link href="/jarvis/login">Sign in <ArrowRight size={14} /></Link></main></PeSurfaceFrame>
  if (roleLoading && !role) return <PeSurfaceFrame active={active}><main className="pe-state"><span className="pe-state__pulse" /><h1>Resolving workspace authority</h1><p>The surface remains closed until the authenticated role is known.</p></main></PeSurfaceFrame>
  if (roleError && !role) return <PeSurfaceFrame active={active}><main className="pe-state"><AlertTriangle /><h1>Workspace authority is unavailable</h1><p>{roleError}</p><button type="button" onClick={retryRole}><RotateCcw size={14} /> Retry authority</button></main></PeSurfaceFrame>
  if (role !== "owner") return <PeSurfaceFrame active={active}><main className="pe-state"><LockKeyhole /><h1>No active Workspace V3 surface</h1><p>The active Private Equity workspace currently defines the owner role only. No legacy role experience is being substituted.</p></main></PeSurfaceFrame>
  return <PeSurfaceFrame active={active}>{children}</PeSurfaceFrame>
}

export function PeSourceState({ title, detail, retry }: { title: string; detail: string; retry?: () => void }) {
  return <div className="pe-source-state" role="status"><AlertTriangle size={16} /><div><strong>{title}</strong><p>{detail}</p></div>{retry ? <button type="button" onClick={retry}><RotateCcw size={13} /> Retry</button> : null}</div>
}
