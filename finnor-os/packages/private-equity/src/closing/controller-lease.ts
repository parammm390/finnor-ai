import type { PeMutationContext } from "../types";
import { tx as operationalTx } from "../owner-context";
import type { ClosingProgrammeRow } from "./contracts";

/** Operational liveness is excluded from the material cut. Its renewal must
 * not wait on the business writer whose long-running work it keeps fenced. */
export async function renewClosingControllerLease(
  ctx: PeMutationContext,
  programme: Pick<ClosingProgrammeRow, "tenant_id" | "id" | "generation">,
  token: string,
): Promise<boolean> {
  return operationalTx(ctx, async c => Boolean((await c.query(
    "UPDATE finnor_os.pe_closing_programmes SET controller_lease_until=clock_timestamp()+interval '90 seconds' WHERE tenant_id=$1 AND id=$2 AND controller_lease_token=$3 AND generation=$4 AND controller_lease_until>clock_timestamp() RETURNING id",
    [programme.tenant_id, programme.id, token, programme.generation],
  )).rowCount));
}
