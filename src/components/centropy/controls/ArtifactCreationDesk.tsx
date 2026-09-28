"use client"

import Link from "next/link"
import { useState } from "react"
import { z } from "zod"
import { centropyGet } from "@/components/centropy/lib/api"
import { HumanControlDesk } from "./HumanControlDesk"

const CreatedSchema = z.object({ documentId: z.string().uuid(), version: z.object({ id: z.string().uuid() }) })
const ReadbackSchema = z.object({ documentId: z.string().uuid(), document: z.object({ id: z.string().uuid(), title: z.string() }), version: z.object({ id: z.string().uuid() }), semantic: z.object({ kind: z.string() }) })
type Created = z.infer<typeof CreatedSchema> & { kind: string; title: string; verified: boolean }

export function ArtifactCreationDesk() {
  const [created, setCreated] = useState<Created | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function verify(value: Created) {
    const read = ReadbackSchema.parse(await centropyGet<unknown>(`documents/${value.documentId}/artifact`, { versionId: value.version.id }))
    if (read.documentId !== value.documentId || read.document.id !== value.documentId || read.version.id !== value.version.id || read.semantic.kind !== value.kind || read.document.title !== value.title) throw new Error("The created artifact did not match the exact draft readback.")
    setCreated({ ...value, verified: true }); setError(null)
    return read
  }
  return <section aria-label="Artifact draft creation">
    <p>Create a persisted blank file, then inspect its exact version in Canvas. New files contain no sourced business facts.</p>
    {!created ? <HumanControlDesk groups={["artifact-creation"]} verify={async (_form, response, body) => {
      const result = CreatedSchema.parse(response), kind = String(body.kind), title = String(body.title).trim()
      const value = { ...result, kind, title: title.toLowerCase().endsWith(`.${kind}`) ? title : `${title}.${kind}`, verified: false }
      setCreated(value)
      return await verify(value)
    }} onRecorded={() => undefined} /> : null}
    {created?.verified ? <p><Link href={`/centropy?artifactMode=draft&artifactDocumentId=${created.documentId}&artifactVersionId=${created.version.id}`}>Open verified draft</Link></p> : created ? <><p>The API returned a draft reference. Verify that record before creating another file.</p><button type="button" onClick={() => void verify(created).catch((cause) => setError(cause instanceof Error ? cause.message : "Draft readback unavailable"))}>Retry exact draft readback</button></> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
