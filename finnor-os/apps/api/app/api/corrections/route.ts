// §5.6 (JARVIS 95% MAESTRO PACK): correction loop. An operator marks a past AI
// answer wrong with the correction — receipt-linked so it has real provenance, not a
// free-floating claim. Falls back to owner-only (canApprove's own default when no
// role_permissions row exists for this action type). Active authority roles remain
// governed by the same policy editor as every other action.

import { withTenant, decisionReceipts, memoryCorrections } from "@finnor/db";
import { recordCorrection } from "@finnor/memory";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireContext, canApprove, errorResponse } from "../../../lib/auth";

const CORRECTION_ACTION_TYPE = "correct_memory";

const SubmitCorrectionSchema = z.object({
  receiptId: z.string().uuid(),
  correctedFact: z.string().min(1).max(2000),
});

function describeReceiptAnswer(actualResult: unknown): string {
  if (!actualResult || typeof actualResult !== "object") return "(no recorded answer)";
  const record = actualResult as Record<string, unknown>;
  const output = (record.output ?? record) as Record<string, unknown>;
  return String(output.answer ?? output.spokenSummary ?? JSON.stringify(output));
}

export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    if (!(await canApprove(ctx, CORRECTION_ACTION_TYPE))) {
      return Response.json({ error: `Your role (${ctx.role}) cannot submit corrections` }, { status: 403 });
    }
    const body = await req.json().catch(() => null);
    const parsed = SubmitCorrectionSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });

    const [receipt] = await withTenant(ctx.tenantId, (db) =>
      db.select().from(decisionReceipts).where(eq(decisionReceipts.id, parsed.data.receiptId)),
    );
    if (!receipt) return Response.json({ error: "Receipt not found" }, { status: 404 });

    const { id } = await recordCorrection({
      tenantId: ctx.tenantId,
      receiptId: receipt.id,
      question: receipt.objective,
      wrongAnswer: describeReceiptAnswer(receipt.actualResult),
      correctedFact: parsed.data.correctedFact,
      correctedBy: ctx.userId,
    });
    return Response.json({ id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  includeSuperseded: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    if (!(await canApprove(ctx, CORRECTION_ACTION_TYPE))) {
      return Response.json({ error: `Your role (${ctx.role}) cannot view corrections` }, { status: 403 });
    }
    const url = new URL(req.url);
    const parsed = ListQuerySchema.safeParse({
      limit: url.searchParams.get("limit") ?? undefined,
      includeSuperseded: url.searchParams.get("includeSuperseded") ?? undefined,
    });
    if (!parsed.success) return Response.json({ error: "Invalid query" }, { status: 400 });

    const rows = await withTenant(ctx.tenantId, (db) =>
      db
        .select()
        .from(memoryCorrections)
        .where(and(eq(memoryCorrections.tenantId, ctx.tenantId), ...(parsed.data.includeSuperseded ? [] : [isNull(memoryCorrections.supersededAt)])))
        .orderBy(desc(memoryCorrections.createdAt))
        .limit(parsed.data.limit),
    );
    return Response.json({ corrections: rows });
  } catch (err) {
    return errorResponse(err);
  }
}
