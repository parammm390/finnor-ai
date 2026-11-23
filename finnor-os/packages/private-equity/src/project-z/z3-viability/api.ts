/** Z3 ViabilityStrategy company-brain operations.
 *
 * Owned leaf. The coordinator-owned route dispatch patch imports these exact
 * names; every fault is mapped to a typed, bounded response and no handler
 * invents a tenant, Work, reservation or admission identity. */
import { z } from "zod";
import type { PeMutationContext } from "../../types";
import { ReadSchema, RecoverSchema, SubmitSchema, Z3NativeFault, Z3_OPERATIONS } from "./contracts";
import { createViabilitySession, readViabilityPublic, requestViabilityRecovery } from "./store";

export const VIABILITY_OPERATIONS = Z3_OPERATIONS;
export const VIABILITY_OPERATION_SCHEMAS = {
  "viability-submit": SubmitSchema, "viability-read": ReadSchema, "viability-recover": RecoverSchema,
} as const;

export async function handleViabilityOperation(ctx: PeMutationContext, operation: string,
  body: unknown): Promise<{ status: number; body: unknown }> {
  try {
    if (operation === "viability-submit") {
      return { status: 202, body: await createViabilitySession(ctx, SubmitSchema.parse(body)) };
    }
    if (operation === "viability-read") {
      return { status: 200, body: await readViabilityPublic(ctx, ReadSchema.parse(body)) };
    }
    if (operation === "viability-recover") {
      return { status: 202, body: await requestViabilityRecovery(ctx, RecoverSchema.parse(body)) };
    }
    return { status: 404, body: { code: "NOT_FOUND" } };
  } catch (error) {
    if (error instanceof z.ZodError) return { status: 400, body: { code: "VIABILITY_SCHEMA_INVALID" } };
    if ((error as Error).message === "Evidence resource is unavailable in the authenticated scope"
      || (error as { code?: string }).code === "PE_ENTITY_NOT_FOUND") {
      return { status: 404, body: { code: "PE_ENTITY_NOT_FOUND",
        error: "Viability resource is unavailable in the authenticated scope" } };
    }
    const predicate = error instanceof Z3NativeFault && /^Z3_[A-Z0-9_]+$/.test(error.code)
      ? error.code : "VIABILITY_TRANSITION_NOT_CONFIRMED";
    return { status: 422, body: { code: "VIABILITY_PREDICATE_UNPASSED", predicate } };
  }
}
