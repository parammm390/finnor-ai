import type { PeMutationContext } from "../types";
import { growthOperationSchemas } from "./boundaries";
import { intakeGrowthWork, writeGrowthSource, submitGrowthOutcome } from "./store";
import { prepareNativeGrowthObligation, readGrowthWork, advanceGrowthProgram } from "./consumer";
import { inviteGrowthParticipant, growthParticipantInbox, growthParticipantProgress,
  setGrowthParticipantConsent, reportGrowthEvent } from "./participants";

export const GROWTH_OPERATIONS = ["intake", "prepare-native", "source", "submit", "read", "advance",
  "invite", "inbox", "protocol-progress", "consent", "report"] as const;
if (GROWTH_OPERATIONS.length !== Object.keys(growthOperationSchemas).length
  || GROWTH_OPERATIONS.some(operation => !Object.hasOwn(growthOperationSchemas, operation)))
  throw Error("W4_OPERATION_REGISTRY_SCHEMA_MISMATCH");

export async function demandToBusinessOperation(ctx: PeMutationContext, operation: string, input: unknown) {
  if (!(operation in growthOperationSchemas)) throw Error("W4_OPERATION_NOT_FOUND");
  switch (operation) {
    case "intake": return intakeGrowthWork(ctx, input);
    case "prepare-native": return prepareNativeGrowthObligation(ctx, input);
    case "source": return writeGrowthSource(ctx, input);
    case "submit": return submitGrowthOutcome(ctx, input);
    case "read": return readGrowthWork(ctx, input);
    case "advance": return advanceGrowthProgram(ctx, input);
    case "invite": return inviteGrowthParticipant(ctx, input);
    case "inbox": growthOperationSchemas.inbox.parse(input); return growthParticipantInbox(ctx);
    case "protocol-progress": return growthParticipantProgress(ctx, input);
    case "consent": return setGrowthParticipantConsent(ctx, input);
    case "report": return reportGrowthEvent(ctx, input);
    default: throw Error("W4_OPERATION_NOT_FOUND");
  }
}
