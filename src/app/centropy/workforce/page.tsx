import { Suspense } from "react"
import { WorkforceParticipantWorkspace } from "@/components/centropy/canvas/WorkforceParticipantWorkspace"
export default function WorkforceParticipantPage() {
  return <Suspense fallback={<p>Reading your authenticated workforce scope…</p>}><WorkforceParticipantWorkspace /></Suspense>
}
