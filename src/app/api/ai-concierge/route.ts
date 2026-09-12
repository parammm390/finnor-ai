import { NextResponse } from "next/server"
import {
  buildFinnorConciergeReply,
  type ConciergeCollectedFields,
  type ConciergeMessage,
  type ConciergeRole,
} from "@/lib/llm/concierge"
import { ApiRequestError, cleanString, readJsonBody } from "@/lib/api/request"
import { rateLimit } from "@/lib/api/rate-limit"

export const runtime = "nodejs"
export const maxDuration = 25

type ConciergeRequestBody = {
  messages?: Array<{
    role?: unknown
    content?: unknown
  }>
  collectedFields?: Partial<Record<keyof ConciergeCollectedFields, unknown>>
}

const VALID_ROLES: ConciergeRole[] = ["user", "assistant"]
const DEFAULT_FIELDS: ConciergeCollectedFields = {
  name: "",
  company: "",
  website: "",
  role: "",
  email: "",
  pain: "",
  operatingScope: "",
  currentSetup: "",
  desiredSystem: "",
  suggestedPlan: "Not enough detail",
}

export async function POST(request: Request) {
  try {
    const limited = rateLimit(request, { name: "ai-concierge", limit: 24, windowMs: 10 * 60 * 1000 })
    if (limited) return limited

    const body = await readJsonBody<ConciergeRequestBody>(request, 28_000)
    const messages = normalizeMessages(body.messages)
    const collectedFields = normalizeCollectedFields(body.collectedFields)

    if (!messages.length || messages[messages.length - 1].role !== "user") {
      return NextResponse.json({ error: "A visitor message is required." }, { status: 400 })
    }

    const reply = await buildFinnorConciergeReply(messages, collectedFields)
    return NextResponse.json(reply)
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }

    console.error("AI Concierge error:", error)
    return NextResponse.json({ error: "The concierge could not respond right now." }, { status: 500 })
  }
}

function normalizeCollectedFields(
  fields: ConciergeRequestBody["collectedFields"]
): ConciergeCollectedFields {
  if (!fields || typeof fields !== "object") return DEFAULT_FIELDS

  return {
    name: cleanString(fields.name, 120),
    company: cleanString(fields.company, 160),
    website: cleanString(fields.website, 220),
    role: cleanString(fields.role, 120),
    email: cleanString(fields.email, 180),
    pain: cleanString(fields.pain, 220),
    operatingScope: cleanString(fields.operatingScope, 80),
    currentSetup: cleanString(fields.currentSetup, 220),
    desiredSystem: cleanString(fields.desiredSystem, 160),
    suggestedPlan: normalizePlan(fields.suggestedPlan),
  }
}

function normalizePlan(value: unknown): ConciergeCollectedFields["suggestedPlan"] {
  const plan = cleanString(value, 40).toLowerCase()
  if (plan.includes("chain") || plan.includes("certified")) return "Certified PE chain"
  if (plan.includes("multi") || plan.includes("fund")) return "Multi-fund deployment"
  if (plan.includes("firm") || plan.includes("deployment")) return "Firm deployment"
  return "Not enough detail"
}

function normalizeMessages(messages: ConciergeRequestBody["messages"]): ConciergeMessage[] {
  if (!Array.isArray(messages)) return []

  return messages
    .map((message) => {
      const role = typeof message.role === "string" ? message.role : ""
      const content = cleanString(message.content, 900)

      if (!VALID_ROLES.includes(role as ConciergeRole) || !content) return null

      return {
        role: role as ConciergeRole,
        content,
      }
    })
    .filter((message): message is ConciergeMessage => Boolean(message))
    .slice(-12)
}
