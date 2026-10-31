import { z } from "zod";
import { brokerOrigin, brokerPrivateFile, brokerRequest, brokerToken } from "../../../governed-execution/src/broker-io";
import type { ClosingCheck } from "@finnor/shared-types";
import type { PeMutationContext } from "../types";
import type { ClosingProgrammeRow } from "./contracts";
import { ClosingError } from "./contracts";
import { closingDigest } from "./compiler";
import { closingEvent } from "./store";
import { closingTx as tx } from "../owner-context";
import { withS5PortfolioTransaction } from "../allocation-store";
import { recordWorkforceClosingPaymentsTx } from "../workforce-compensation-closing";

/** The controller supplies identities only. Checker credentials and receipt
 * insertion authority are absent from the API and worker. */
export async function requestIndependentClosingCheck(tenantId: string, programmeId: string) {
  const origin = process.env.FINNOR_V3_CHECKER_ORIGIN, tokenPath = process.env.FINNOR_V3_CHECKER_CLIENT_TOKEN_FILE;
  if (!origin || !tokenPath) throw Error("INDEPENDENT_CLOSING_CHECKER_UNAVAILABLE");
  const base = brokerOrigin(origin, process.env.NODE_ENV === "production" ? "PROTECTED" : "DISPOSABLE_TEST_AUTHORITY");
  const token = brokerToken(await brokerPrivateFile(tokenPath));
  const response = await brokerRequest(new URL("/check", base), {
    method: "POST", token, body: { tenantId, programmeId }, deadlineAt: Date.now() + 15000,
  });
  if (response.status !== 200) throw Error("INDEPENDENT_CLOSING_CHECK_UNAVAILABLE");
  const result = z.object({
    id: z.string().uuid(), observationCutDigest: z.string().regex(/^[a-f0-9]{64}$/),
    checkerDigest: z.string().regex(/^[a-f0-9]{64}$/), check: z.unknown(),
  }).strict().parse(response.body);
  return { ...result, check: result.check as ClosingCheck };
}

export async function refreshIndependentClosingCheck(ctx: PeMutationContext, q: ClosingProgrammeRow): Promise<ClosingCheck> {
  const { reserveClosingReadBudget, finishClosingReadBudget, ClosingReadBudgetFenceError } = await import("../../../orchestration/src/objective-loop");
  let stepId: string;
  try {
    stepId = await reserveClosingReadBudget({ tenantId: q.tenant_id, workId: q.work_id,
      programmeId: q.id, inputId: q.work_input_id,
      responsibilityOnly: Boolean(q.stopped_at) || q.original_deadline_at.getTime() <= Date.now()
        || ["CLOSED", "REOPENED"].includes(q.status) });
  } catch (error) {
    const fenced=new ClosingError("CLOSING_ORIGINAL_NATIVE_READ_BUDGET_EXHAUSTED_OR_FENCED");
    if (error instanceof ClosingReadBudgetFenceError) {
      // Persist the exact locked decision cut, not a later counter snapshot.
      // Identical refused polls share one append-only diagnostic witness.
      let diagnosticPersisted=false;
      try{
        await closingEvent(ctx,q,"ORIGINAL_NATIVE_READ_FENCED",error.observation,undefined,
          "native-read-fence:"+q.generation+":"+closingDigest(error.observation));
        diagnosticPersisted=true;
      }catch{ /* Failure to retain a diagnostic cannot grant the refused read. */ }
      fenced.cause={observation:error.observation,diagnosticPersisted};
    }
    throw fenced;
  }
  try {
  const receipt = await requestIndependentClosingCheck(q.tenant_id, q.id);
  await tx(ctx, async c => {
    const row = (await c.query(
      "SELECT id FROM finnor_os.pe_closing_checks WHERE tenant_id=$1 AND id=$2 AND programme_id=$3 AND spec_digest=$4 AND observation_cut_digest=$5 AND checker_digest=$6 AND valid_until>clock_timestamp()",
      [q.tenant_id, receipt.id, q.id, q.spec_digest, receipt.observationCutDigest, receipt.checkerDigest],
    )).rows[0];
    if (!row) throw new ClosingError("CLOSING_INDEPENDENT_RECEIPT_NOT_CANONICALLY_BOUND");
    await c.query("UPDATE finnor_os.pe_closing_programmes SET last_check_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [q.tenant_id, q.id, receipt.id]);
  });
  q.last_check_id = receipt.id;
  if (q.spec.fundsFlows.some(flow => flow.workforceCompensation)) {
    await withS5PortfolioTransaction(ctx, async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`v3-material-cut:${q.tenant_id}`]);
      await recordWorkforceClosingPaymentsTx(ctx, c, q.id);
    });
  }
  await finishClosingReadBudget(q.tenant_id, stepId, { checkId: receipt.id, accepted: receipt.check.accepted,
    observationCutDigest: receipt.observationCutDigest, checkerDigest: receipt.checkerDigest });
  return receipt.check;
  } catch (error) {
    await finishClosingReadBudget(q.tenant_id, stepId, { independentCheckUnavailable: true,
      newMutationAuthorityGranted: false }, true);
    throw error;
  }
}
