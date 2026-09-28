"use client"

import { useId, useState } from "react"
import { z } from "zod"
import { centropyGet } from "@/components/centropy/lib/api"
import { HumanControlDesk } from "../controls/HumanControlDesk"

const RowsSchema = z.array(z.record(z.unknown()))
type Anchor = { id: string; hash: string; kind: string }

export function ArtifactRecordControls({ documentId, versionId, kind, anchors }: { documentId: string; versionId: string; kind: string; anchors: Anchor[] }) {
  const id = useId()
  const [selectedId, setSelectedId] = useState(anchors.find((node) => ["cell", "paragraph", "shape", "tableCell"].includes(node.kind))?.id ?? anchors[0]?.id ?? "")
  const selected = anchors.find((node) => node.id === selectedId)
  const routes = ["artifact-templates", "documents/:id/artifact/bindings", "documents/:id/artifact/lineage", "documents/:id/artifact/publish", ...(["xlsx", "xlsm"].includes(kind) ? ["documents/:id/artifact/recalculate"] : [])]
  return <details className="ct-artifact__section"><summary>Manage exact artifact records</summary><section aria-label="Artifact source records">
    <p>Record source bindings, an explicit version relationship, or an exact template version. Registration records this version; it does not certify firm approval.</p>
    <label htmlFor={`${id}-anchor`}>Exact loaded anchor<select id={`${id}-anchor`} value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{anchors.map((node) => <option key={node.id} value={node.id}>{node.kind} · {node.id}</option>)}</select></label>
    <HumanControlDesk groups={["artifact-records"]} routePatterns={routes} paths={{ id: documentId }} context={{ documentId, versionId, targetVersionId: versionId, localVersionId: versionId, ...(selected ? { anchorId: selected.id, anchorHash: selected.hash } : {}) }} fixedFields={["documentId", "versionId", "targetVersionId", "localVersionId", "anchorId", "anchorHash"]} verify={async (form, response, body) => {
      if (form.routePattern.endsWith("/publish")) {
        const submitted = z.object({ id: z.string().uuid(), status: z.string() }).parse(response)
        const read = z.object({ id: z.string().uuid(), documentId: z.string().uuid(), localVersionId: z.string().uuid(), baseVersionId: z.string().uuid(), mode: z.string(), status: z.string(), readbackVersionId: z.string().uuid().nullable() }).passthrough().parse(await centropyGet<unknown>(`documents/${documentId}/artifact/publications/${submitted.id}`))
        if (read.documentId !== documentId || read.localVersionId !== versionId || read.baseVersionId !== body.baseVersionId || read.mode !== body.mode || !["verified", "verified_provider_normalized"].includes(read.status) || !read.readbackVersionId) throw new Error(`The linked Microsoft replacement is not verified: ${read.status}. Inspect its recorded publication before retrying.`)
        await centropyGet<unknown>(`documents/${documentId}/artifact`, { versionId: read.readbackVersionId })
        return read
      }
      if (form.routePattern === "artifact-templates") {
        const rows = RowsSchema.parse(await centropyGet<unknown>("artifact-templates")), found = rows.find((row) => row.template_key === body.templateKey && row.version_id === versionId && row.kind === kind && row.status === "active")
        if (!found) throw new Error("The template catalog did not contain the reviewed exact version.")
        return found
      }
      if (form.routePattern.endsWith("/bindings")) {
        const rows = RowsSchema.parse(await centropyGet<unknown>(`documents/${documentId}/artifact/bindings`, { versionId })), found = rows.find((row) => row.version_id === versionId && row.anchor_id === body.anchorId && row.anchor_hash === body.anchorHash && row.target_kind === body.targetKind && row.target_id === body.targetId && (!body.targetEntityType || row.target_entity_type === body.targetEntityType) && (!body.targetAnchor || row.target_anchor === body.targetAnchor))
        if (!found) throw new Error("The source binding did not match the reviewed anchor and target.")
        return found
      }
      if (form.routePattern.endsWith("/lineage")) {
        const rows = RowsSchema.parse(await centropyGet<unknown>(`documents/${documentId}/artifact/lineage`, { versionId })), found = rows.find((row) => row.source_version_id === body.sourceVersionId && row.target_version_id === versionId && row.relation === body.relation)
        if (!found) throw new Error("The version relationship did not match the reviewed pair.")
        return found
      }
      const result = z.object({ status: z.string(), versionId: z.string().uuid(), reason: z.string().optional() }).parse(response)
      if (result.status !== "verified") throw new Error(`Excel calculation was not verified: ${result.reason ?? result.status}. The stored formula remains unverified.`)
      const meta = z.object({ documentId: z.string().uuid(), version: z.object({ id: z.string().uuid() }), semantic: z.object({ calculationStatus: z.string() }) }).parse(await centropyGet<unknown>(`documents/${documentId}/artifact`, { versionId: result.versionId }))
      if (meta.documentId !== documentId || meta.version.id !== result.versionId || meta.semantic.calculationStatus !== "verified") throw new Error("The returned calculated version was not independently verified.")
      return meta
    }} onRecorded={() => undefined} />
  </section></details>
}
