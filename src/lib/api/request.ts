import { NextResponse } from "next/server"

export class ApiRequestError extends Error {
  status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = "ApiRequestError"
    this.status = status
  }
}

export function cleanString(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : ""
}

export async function readJsonBody<T>(request: Request, maxBytes = 32_000): Promise<T> {
  assertBodySize(request, maxBytes)

  try {
    return (await request.json()) as T
  } catch {
    throw new ApiRequestError("Request body must be valid JSON.", 400)
  }
}

export function assertBodySize(request: Request, maxBytes: number) {
  const contentLength = Number(request.headers.get("content-length") || 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApiRequestError("Request body is too large.", 413)
  }
}

export function apiErrorResponse(error: unknown, fallbackMessage: string, fallbackStatus = 500) {
  if (error instanceof ApiRequestError) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }

  const message = error instanceof Error && error.message ? error.message : fallbackMessage
  return NextResponse.json({ error: message }, { status: fallbackStatus })
}

export function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export async function readTextBody(request: Request, maxBytes: number): Promise<string> {
  return (await readBoundedBody(request, maxBytes)).text()
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") || 0)
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApiRequestError("Request body is too large.", 413)
  }

  const chunks: Uint8Array[] = []
  let size = 0
  const reader = request.body?.getReader()
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          void reader.cancel().catch(() => {})
          throw new ApiRequestError("Request body is too large.", 413)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Response(body, { headers: { "content-type": request.headers.get("content-type") || "" } })
}
