import type { PoolClient } from "pg";
import type { BilateralGrant, PrimaryCostReceipt } from "@finnor/shared-types";
import type { PeMutationContext } from "../types";
import { reservePrimaryCharge } from "../allocation-store";
import { priceCeiling as ceiling } from "../exact-price";
import { canonical, event, tx, type Programme } from "./store";

export const cpuCost = (g: BilateralGrant, micros: bigint) =>
  ceiling(g.pricebook.cpuMicroUsdPerSecond.numerator, (BigInt(g.pricebook.cpuMicroUsdPerSecond.denominator) * 1000000n).toString(), micros);
export const storageCost = (g: BilateralGrant, bytes: number) =>
  ceiling(g.pricebook.storageMicroUsdPerByte.numerator, g.pricebook.storageMicroUsdPerByte.denominator, BigInt(bytes));
export async function reserve(ctx: PeMutationContext, p: Programme, g: BilateralGrant, key: string,
  kind: PrimaryCostReceipt["kind"], microUsd: string, cpuMicros = "0", c?: PoolClient) {
  const run = (client: PoolClient) => reservePrimaryCharge(ctx, client, {
    grant: g, programmeId: p.id, programmeOwner: "V1", requestId: null, chargeKey: key, kind, microUsd, cpuMicros,
  });
  return c ? run(c) : tx(ctx, run);
}
/** Settlement records actual debits even after revocation. It does not obtain a
 * new reservation or make previously possible provider charges disappear. */
export async function settle(ctx: PeMutationContext, p: Programme, g: BilateralGrant, input: {
  key: string; kind: PrimaryCostReceipt["kind"]; microUsd: string; reservedMicroUsd: string;
  cpuMicros?: string | null; wallMs?: number; peakMemoryBytes?: string | null; bytes?: number;
  status?: PrimaryCostReceipt["status"]; reasons?: string[];
}, c?: PoolClient) {
  const receipt: PrimaryCostReceipt = {
    id: input.key, owner: input.kind === "NATIVE" ? "P4" : input.kind === "ORCHESTRATION" ? "P2" : "S6",
    requestId: null, kind: input.kind, microUsd: input.microUsd, reservedMicroUsd: input.reservedMicroUsd,
    possibleAdditionalMicroUsd: "0", cpuMicros: input.cpuMicros ?? null, wallMs: input.wallMs ?? 0,
    peakMemoryBytes: input.peakMemoryBytes ?? null, bytes: input.bytes ?? 0, humanSeconds: 0,
    pricebookRef: g.pricebook.ref, status: input.status ?? "RECONCILED", reasons: input.reasons ?? [],
  };
  const run = async (client: PoolClient) => {
    const result = await client.query(`UPDATE finnor_os.s5_programme_charges SET actual_micro_usd=$4,
      actual_cpu_micros=$5,bytes=$6,receipt=$7::jsonb,reconciled_at=CASE WHEN $8 THEN clock_timestamp() ELSE NULL END
      WHERE tenant_id=$1 AND reservation_id=$2 AND charge_key=$3 AND programme_owner='V1' RETURNING charge_key`,
    [ctx.auth.tenantId, g.reservationRef.id, input.key, input.microUsd, input.cpuMicros ?? null,
      input.bytes ?? 0, canonical(receipt), receipt.status === "RECONCILED"]);
    if (!result.rowCount) throw Error("BILATERAL_ORIGINAL_CHARGE_NOT_FOUND");
    await event(ctx, p, receipt.owner, "COST_OBSERVED", { receipt }, client);
    return receipt;
  };
  return c ? run(c) : tx(ctx, run);
}
export async function remainingGrant(ctx: PeMutationContext, g: BilateralGrant) {
  return tx(ctx, async c => {
    const row = (await c.query(`SELECT COALESCE(sum(CASE WHEN reconciled_at IS NOT NULL AND receipt->>'status'='RECONCILED'
      THEN actual_micro_usd+possible_additional_micro_usd ELSE GREATEST(reserved_micro_usd,COALESCE(actual_micro_usd,0)+possible_additional_micro_usd) END),0)::text usd
      FROM finnor_os.s5_programme_charges WHERE tenant_id=$1 AND reservation_id=$2 AND grant_id=$3`,
    [ctx.auth.tenantId, g.reservationRef.id, g.grantId])).rows[0];
    const n = (await c.query(`SELECT count(*)::int n FROM finnor_os.s6_contact_intents i
      JOIN finnor_os.v1_programmes p ON p.tenant_id=i.tenant_id AND p.id=i.programme_id
      WHERE i.tenant_id=$1 AND p.intake->'budgetGrantRef'->>'id'=$2 AND i.status<>'CANCELLED_BEFORE_DISPATCH'`,
    [ctx.auth.tenantId, g.grantId])).rows[0].n as number;
    return { remainingMicroUsd: (BigInt(g.maximumMicroUsd) > BigInt(row.usd) ? BigInt(g.maximumMicroUsd) - BigInt(row.usd) : 0n).toString(),
      remainingContacts: Math.max(0, g.maximumContacts - n) };
  }, true);
}
export async function chargeRead(ctx: PeMutationContext, p: Programme, g: BilateralGrant, price: string, storageMaximum = 262144) {
  const key = "v1-read:" + p.id + ":" + crypto.randomUUID(), held = (BigInt(price) + BigInt(storageCost(g, storageMaximum))).toString();
  await reserve(ctx, p, g, key, "ACQUISITION", held);
  return { key, held, settle: (bytes: number, c?: PoolClient) => settle(ctx, p, g, {
    key, kind: "ACQUISITION", microUsd: (BigInt(price) + BigInt(storageCost(g, bytes))).toString(),
    reservedMicroUsd: held, bytes,
    reasons: ["REGISTERED_DEVELOPMENT_READ_TARIFF_NOT_INDEPENDENT_PROVIDER_INVOICE"],
  }, c) };
}
