import { z } from "zod";
import type { PeMutationContext } from "../../types";
import { InteractionFault } from "../../interaction-synthesis/contracts";
import { SubmitSchema, ProtocolId } from "../../interaction-synthesis/product-contracts";
import { submitCoalitionProtocol, readCoalitionProtocol } from "./store";
export const CoalitionOperationSchemas={
  "coalition-submit": SubmitSchema,
  "coalition-read": ProtocolId,
};
export const CoalitionOperations = Object.keys(CoalitionOperationSchemas);
export async function handleCoalitionOperation(ctx: PeMutationContext, operation: string, raw: unknown) {
  try {
    if (operation === "coalition-submit")
      return { status: 202, body: await submitCoalitionProtocol(ctx, SubmitSchema.parse(raw)) };
    if (operation === "coalition-read")
      return { status: 200, body: await readCoalitionProtocol(ctx, ProtocolId.parse(raw).protocolId) };
    return { status: 404, body: { code: "NOT_FOUND" } };
  } catch (error) {
    if (error instanceof z.ZodError) return { status: 400, body: { code: "Z2_STRICT_CONTRACT_REQUIRED" } };
    if (error instanceof InteractionFault) return { status: error.status, body: { code: error.code } };
    throw error;
  }
}
