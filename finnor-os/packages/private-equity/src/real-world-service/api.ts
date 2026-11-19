import type { PeMutationContext } from "../types";
import { writeServiceSource, submitServiceOutcome, intakeServiceWork } from "./store";
import { inviteServiceParticipant, readParticipantInbox, setServiceConsent, submitServiceObservation } from "./participants";
import { readServiceWork, requestServiceAdvance, prepareNativeServiceObligation } from "./consumer";
import { z } from "zod";
export const SERVICE_OPERATIONS = ["intake", "prepare-native", "source", "submit", "read", "advance", "invite", "inbox", "consent", "report"] as const;
export async function realWorldServiceOperation(ctx: PeMutationContext, operation: string, input: unknown) {
  switch (operation) {
    case "intake": return intakeServiceWork(ctx, input);
    case "prepare-native": return prepareNativeServiceObligation(ctx, input);
    case "source": return writeServiceSource(ctx, input);
    case "submit": return submitServiceOutcome(ctx, input);
    case "read": return readServiceWork(ctx, input);
    case "advance": return requestServiceAdvance(ctx, input);
    case "invite": return inviteServiceParticipant(ctx, input);
    case "inbox": z.object({}).strict().parse(input); return readParticipantInbox(ctx);
    case "consent": return setServiceConsent(ctx, input);
    case "report": return submitServiceObservation(ctx, input);
    default: throw Error("W3_OPERATION_NOT_FOUND");
  }
}
