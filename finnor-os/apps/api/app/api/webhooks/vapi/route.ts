import { createHash, randomUUID } from "node:crypto";
import { VapiWebhookSchema } from "@finnor/policy-schema";
import {
  adminDb,
  domainActions,
  getPool,
  ingestIntegrationEventTx,
  tenantPhoneNumbers,
  users,
  withTenant,
} from "@finnor/db";
import { ensureSecretsLoaded, resolveTenantCredentialContext } from "@finnor/security";
import {
  linkEmployeeConversationTurnToWork,
  persistEmployeeAssistantTurn,
  prepareEmployeeConversationTurn,
} from "@finnor/orchestration";
import { logWithTrace } from "@finnor/tools";
import { and, eq, inArray } from "drizzle-orm";
import { getOrchestrator } from "../../../../lib/orchestrator";
import { checkAndRecordReceipt } from "../../../../lib/webhook-replay";
import { verifyTimestampedHmacSignature } from "../../../../lib/verify-hmac-signature";

interface VapiCall {
  id?: string;
  phoneNumberId?: string;
  customer?: { number?: string };
  phoneNumber?: { number?: string };
  metadata?: Record<string, unknown>;
}

interface VapiToolCall {
  id: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

async function resolveTenant(call: VapiCall | undefined): Promise<string | null> {
  if (call?.phoneNumberId) {
    const rows = await adminDb().select({ tenantId: tenantPhoneNumbers.tenantId })
      .from(tenantPhoneNumbers)
      .where(eq(tenantPhoneNumbers.vapiPhoneNumberId, call.phoneNumberId))
      .limit(2);
    if (rows.length === 1) return rows[0]!.tenantId;
  }
  if (call?.phoneNumber?.number) {
    const rows = await adminDb().select({ tenantId: tenantPhoneNumbers.tenantId })
      .from(tenantPhoneNumbers)
      .where(eq(tenantPhoneNumbers.phoneNumber, call.phoneNumber.number))
      .limit(2);
    if (rows.length === 1) return rows[0]!.tenantId;
  }
  return null;
}

function verify(req: Request, rawBody: string, secret?: string): boolean {
  return verifyTimestampedHmacSignature(req, {
    header: "x-vapi-signature",
    secret,
    rawBody,
    allowUnsetSecret: process.env.NODE_ENV !== "production",
  });
}

async function activeEmployee(tenantId: string, phone: string | undefined) {
  if (!phone) return null;
  const [row] = await withTenant(tenantId, (db) => db.select({
    id: users.id,
    role: users.role,
    status: users.status,
  }).from(users).where(and(
    eq(users.tenantId, tenantId),
    eq(users.phoneNumber, phone),
    eq(users.status, "active"),
  )).limit(1));
  // Phase 5 has no active field-service roles. Historical users remain readable,
  // but only the generic project owner role can authenticate this Core transport.
  return row?.role === "owner" ? row : null;
}

function toolArguments(call: VapiToolCall): Record<string, unknown> {
  const value = call.function?.arguments ?? {};
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function handleTools(
  tenantId: string,
  call: VapiCall | undefined,
  message: Record<string, unknown>,
): Promise<Response> {
  const employee = await activeEmployee(tenantId, call?.customer?.number);
  const toolCalls = (message.toolCallList ?? message.toolCalls ?? []) as VapiToolCall[];
  const results: Array<{ toolCallId: string; result: string }> = [];
  if (!employee) {
    return Response.json({
      results: toolCalls.map((tool) => ({
        toolCallId: tool.id,
        result: "I cannot verify an active employee on this line, so no instruction or decision was accepted.",
      })),
    });
  }

  for (const tool of toolCalls) {
    const name = tool.function?.name ?? "";
    const args = toolArguments(tool);
    try {
      if (name === "finnor_instruct") {
        const instruction = String(args.instruction ?? args.query ?? "").trim();
        if (!instruction) {
          results.push({ toolCallId: tool.id, result: "Please repeat the instruction." });
          continue;
        }
        const instructionId = randomUUID();
        const sessionId = `vapi:${call?.id ?? instructionId}`;
        const ctx = {
          tenantId,
          userId: employee.id,
          employeeId: employee.id,
          role: "owner" as const,
          correlationId: sessionId,
        };
        const prepared = await prepareEmployeeConversationTurn({
          ctx,
          instruction,
          instructionId,
          idempotencyKey: `${sessionId}:tool:${tool.id}`,
          channel: "voice",
          transportSessionId: sessionId,
          originTransportKey: sessionId,
        });
        if (prepared.context.resolution.status === "clarification_required") {
          const spoken = prepared.context.resolution.clarificationQuestion ?? "Which active target do you mean?";
          await persistEmployeeAssistantTurn({
            tenantId,
            employeeId: employee.id,
            threadId: prepared.threadId,
            instructionId,
            channel: "voice",
            text: spoken,
            outcomeRefs: [],
          });
          results.push({ toolCallId: tool.id, result: spoken });
          continue;
        }
        const handled = await getOrchestrator().handleInstructionResult(instruction, ctx, {
          sessionId,
          channel: "voice",
          instructionId,
          idempotencyKey: `${sessionId}:tool:${tool.id}`,
          conversationContext: prepared.context,
        });
        if (handled.workId) {
          await linkEmployeeConversationTurnToWork({
            tenantId,
            employeeId: employee.id,
            threadId: prepared.threadId,
            userMessageId: prepared.userMessage.id,
            workId: handled.workId,
            ...(handled.workInputId ? { workInputId: handled.workInputId } : {}),
            ...(handled.objective ? { objectiveLoopId: handled.objective.objectiveLoopId } : {}),
          });
        }
        const spoken = handled.answer?.spokenSummary
          ?? (handled.objective
            ? "I accepted that as durable objective Work and will report only verified progress."
            : handled.actions.length
              ? handled.actions.map((action) => action.actionType.replaceAll("_", " ")).join(". ")
              : "No executable Core or Private Equity action matched that instruction.");
        await persistEmployeeAssistantTurn({
          tenantId,
          employeeId: employee.id,
          threadId: prepared.threadId,
          instructionId,
          channel: "voice",
          text: spoken,
          ...(handled.workId ? { workId: handled.workId } : {}),
          ...(handled.workInputId ? { workInputId: handled.workInputId } : {}),
          outcomeRefs: handled.actions.map((action) => ({
            kind: "domain_action",
            id: action.id,
            status: action.status,
          })),
        });
        results.push({ toolCallId: tool.id, result: spoken });
        continue;
      }

      if (name === "finnor_confirm") {
        const actionId = String(args.actionId ?? "");
        const decision = String(args.decision ?? "").toLowerCase();
        if (!/^[0-9a-f-]{36}$/i.test(actionId) || !["approve", "reject", "yes", "no"].includes(decision)) {
          results.push({ toolCallId: tool.id, result: "Name the exact action and say approve or reject." });
          continue;
        }
        const [action] = await withTenant(tenantId, (db) => db.select({ id: domainActions.id })
          .from(domainActions)
          .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, actionId)))
          .limit(1));
        if (!action) {
          results.push({ toolCallId: tool.id, result: "That action is not available in this project." });
          continue;
        }
        const resolved = await getOrchestrator().decide(
          actionId,
          tenantId,
          decision === "approve" || decision === "yes" ? "approve" : "reject",
          employee.id,
          { role: "owner", note: `voice:${call?.id ?? "unknown"}` },
        );
        results.push({ toolCallId: tool.id, result: `The action is now ${resolved.status.replaceAll("_", " ")}.` });
        continue;
      }
      results.push({ toolCallId: tool.id, result: `Unknown tool ${name}.` });
    } catch (error) {
      logWithTrace({ tenantId, traceId: call?.id }).error(
        { error: error instanceof Error ? error.message : String(error) },
        "Core Vapi tool failed",
      );
      results.push({ toolCallId: tool.id, result: "The request failed safely; no unverified effect was reported." });
    }
  }
  return Response.json({ results });
}

export async function POST(req: Request): Promise<Response> {
  await ensureSecretsLoaded();
  const rawBody = await req.text();
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Malformed webhook" }, { status: 400 });
  }
  const parsed = VapiWebhookSchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: "Malformed webhook" }, { status: 400 });
  const message = parsed.data.message as Record<string, unknown> & {
    type: string;
    transcript?: string;
    status?: string;
    call?: VapiCall;
    endedAt?: string;
  };
  const tenantId = await resolveTenant(message.call);
  if (!tenantId) {
    return Response.json({ error: "Unmapped Vapi line; no tenant Work was accepted" }, {
      status: 503,
      headers: { "retry-after": "60" },
    });
  }
  let secret: string | undefined;
  try {
    secret = (await resolveTenantCredentialContext(tenantId, "vapi")).credentials.webhookSecret;
  } catch {
    // Development emulators may be unsigned; production fails closed below.
  }
  if (!verify(req, rawBody, secret)) return Response.json({ error: "Bad signature" }, { status: 401 });

  const callId = message.call?.id;
  const toolIds = ((message.toolCallList ?? message.toolCalls ?? []) as VapiToolCall[])
    .map((tool) => tool.id).join(",");
  const eventId = callId
    ? `${callId}:${message.type}:${toolIds || message.status || "event"}`
    : `body:${createHash("sha256").update(rawBody).digest("hex")}`;
  if (await checkAndRecordReceipt("vapi_core", eventId, rawBody) === "duplicate") {
    return Response.json({ received: true, duplicate: true });
  }

  if (message.type === "tool-calls") return handleTools(tenantId, message.call, message);
  if (message.type === "status-update" && callId) {
    await getPool().query("SELECT pg_notify('jarvis_events', $1)", [
      JSON.stringify({
        tenantId,
        kind: "voice_status",
        id: callId,
        status: message.status ?? "unknown",
        ts: new Date().toISOString(),
      }),
    ]);
    return Response.json({ received: true });
  }
  if (message.type === "end-of-call-report") {
    const metadata = message.call?.metadata ?? {};
    const candidateWorkId = typeof metadata.workId === "string" ? metadata.workId : null;
    const workId = candidateWorkId
      ? (await withTenant(tenantId, (db) => db.select({ id: domainActions.workId })
          .from(domainActions)
          .where(and(eq(domainActions.tenantId, tenantId), inArray(domainActions.workId, [candidateWorkId])))
          .limit(1)))[0]?.id ?? null
      : null;
    const event = await withTenant(tenantId, (db) => ingestIntegrationEventTx(db, {
      tenantId,
      source: "vapi_core",
      provider: "vapi",
      sourceEventId: eventId,
      eventType: "voice.call_completed",
      occurredAt: message.endedAt ? new Date(message.endedAt) : new Date(),
      workId,
      providerConversationId: callId ?? null,
      correlationId: callId ? `vapi:${callId}` : null,
      payload: {
        transcriptExcerpt: (message.transcript ?? "").replace(/\s+/g, " ").trim().slice(0, 4_000),
        endedReason: typeof message.endedReason === "string" ? message.endedReason.slice(0, 200) : null,
      },
      evidenceRefs: [],
      trustClass: "untrusted_external",
    }));
    return Response.json({ received: true, duplicate: event.duplicate, observation: true });
  }
  return Response.json({ received: true });
}
