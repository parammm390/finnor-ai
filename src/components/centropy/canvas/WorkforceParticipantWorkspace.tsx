"use client"

import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { z } from "zod"
import { useCentropyAuth } from "../lib/centropy-auth"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"
import { centropyGet, centropyPost } from "../lib/api"
import { WorkforceExecutionPanel } from "./WorkforceExecutionPanel"
import "../centropy-theme.css"

const enrollment = z.object({ id: z.string().uuid(), contactId: z.string().uuid(),
  recipientPrincipalId: z.string().uuid(), purpose: z.string(), validUntil: z.string(),
  proposalDigest: z.string(), status: z.enum(["PROPOSED", "CONFIRMED", "REVOKED", "EXPIRED"]), revision: z.number().int().nonnegative() })
const enrollments = z.object({ complete: z.literal(true), data: z.array(enrollment).max(128) })
export function WorkforceParticipantWorkspace() {
  const auth = useCentropyAuth(), query = useSearchParams()
  const candidate = z.string().uuid().safeParse(query.get("workId")), workId = candidate.success ? candidate.data : null
  const scope = usePrivateRequestScope("workforce-participant:" + (workId ?? "enrollments"), "WORKFORCE_PARTICIPANT")
  const [read, setRead] = useState<{ key: string; data: z.infer<typeof enrollment>[] } | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const [refresh, setRefresh] = useState(0), [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    const key = scope.key
    let cancelled = false
    if (scope.allowed && navigator.onLine && document.visibilityState !== "hidden") void centropyGet("workforce/participants").then(value => {
      const result = enrollments.parse(value)
      if (!cancelled && scope.isCurrent(key)) setRead({ key, data: result.data })
    }).catch(cause => {
      if (!cancelled && scope.isCurrent(key)) setError({ key, message: cause instanceof Error ? cause.message : "Enrollment unavailable" })
    })
    const withdraw = () => { setRead(null); setError(null); scope.invalidate() }
    window.addEventListener("offline", withdraw)
    window.addEventListener("online", withdraw)
    document.addEventListener("visibilitychange", withdraw)
    return () => { cancelled = true; window.removeEventListener("offline", withdraw); window.removeEventListener("online", withdraw)
      document.removeEventListener("visibilitychange", withdraw) }
  }, [scope.allowed, scope.key, scope.isCurrent, scope.invalidate, refresh])
  async function respond(item: z.infer<typeof enrollment>, action: "CONFIRM" | "REVOKE") {
    if (busy === scope.key || !scope.isCurrent(scope.key)) return
    const key = scope.key
    setBusy(key); setRead(null); setError(null)
    try {
      await centropyPost("workforce/participants/" + item.id, { action, proposalDigest: item.proposalDigest,
        expectedRevision: item.revision, idempotencyKey: "workforce-enrollment-ui:" + crypto.randomUUID() })
      if (scope.isCurrent(key)) setRefresh(value => value + 1)
    } catch (cause) {
      if (scope.isCurrent(key)) setError({ key, message: cause instanceof Error ? cause.message : "Response uncertain; refresh before retry" })
    } finally { if (scope.isCurrent(key)) setBusy(null) }
  }
  return <main className="ct-auth-state" aria-label="Your accountable workforce contracts">
    <h1>Your workforce contracts</h1>
    <p>This participant workspace does not open the institutional owner shell or grant new authority.</p>
    {auth.session ? <button type="button" onClick={() => void auth.signOut()}>Sign out</button> : <Link href="/centropy/login">Sign in</Link>}
    {!scope.allowed ? <p role="status">{auth.roleError ?? auth.authError ?? "Verify your authenticated role to read your contracts."}</p> : <>
      {workId ? <WorkforceExecutionPanel key={scope.key + workId} workId={workId} participant /> :
        <p>Open the exact Work link supplied through your authorized channel. No other participant&apos;s Work is listed here.</p>}
      <section aria-label="Your external identity enrollments"><h2>Existing contact bindings</h2>
        <p>Confirm only your actual identity and stated purpose. Enrollment is not acceptance of any assignment, employment, payment or a new grant.</p>
        {read?.key === scope.key ? read.data.map(item => <article key={item.id}>
          <h3>{item.status.toLowerCase()}: {item.purpose}</h3>
          <p>Contact {item.contactId}. Valid until {item.validUntil}. Exact proposal {item.proposalDigest}.</p>
          {item.recipientPrincipalId === auth.session?.user.id && item.status === "PROPOSED" ?
            <button type="button" disabled={busy === scope.key} onClick={() => void respond(item, "CONFIRM")}>Confirm my existing identity binding</button> : null}
          {item.status === "PROPOSED" || item.status === "CONFIRMED" ? <button type="button" disabled={busy === scope.key} onClick={() => void respond(item, "REVOKE")}>Revoke this binding without erasing obligations</button> : null}
        </article>) : <p>Reading current enrollments…</p>}
        {error?.key === scope.key ? <p role="alert">{error.message}</p> : null}
      </section>
    </>}
  </main>
}
