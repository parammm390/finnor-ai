import { z } from "zod";
import { PRIVATE_EQUITY_ACTION_SCHEMAS } from "../../../packages/domain-plugins/private-equity/schemas";

export const EmptyProductControlSchema = z.object({}).strict();
export const SubmitCorrectionSchema = z.object({ receiptId: z.string().uuid(), correctedFact: z.string().min(1).max(2_000) });
export const ResolveReconciliationSchema = z.object({
  expectedVersion: z.number().int().positive(),
  outcome: z.enum(["happened_as_intended", "definitely_did_not_happen", "happened_differently", "still_unknowable", "legally_compensatable"]),
  evidence: z.object({}).passthrough().refine((value) => Object.keys(value).length > 0, "resolution evidence is required"),
  reason: z.string().trim().min(1).max(4_000),
  provider: z.string().trim().min(1).max(160).optional(),
  integrationId: z.string().uuid().optional(),
  controlKey: z.string().trim().min(1).max(512).optional(),
});
export const InitiateCompensationSchema = z.object({ expectedVersion: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(4_000), controlKey: z.string().trim().min(1).max(512).optional() });
export const GoogleConnectionStartSchema = z.object({ authProfileRef: z.string().trim().min(1).max(160), redirectUri: z.string().url().max(2_048).optional() }).strict();
export const PushSubscriptionSchema = z.object({ endpoint: z.string().url().max(2_000), keys: z.object({ p256dh: z.string().min(1).max(1_024), auth: z.string().min(1).max(1_024) }) });
export const DeletePushSubscriptionSchema = z.object({ endpoint: z.string().url().max(2_000) });
const humanIntake = { idempotencyKey: z.string().uuid(), threadId: z.string().uuid().optional() };
export const HumanClosingActionSchema = z.discriminatedUnion("actionType", [
  z.object({ ...humanIntake, actionType: z.literal("waive_closing_condition"), payload: PRIVATE_EQUITY_ACTION_SCHEMAS.waive_closing_condition }).strict(),
  z.object({ ...humanIntake, actionType: z.literal("verify_closing_item"), payload: PRIVATE_EQUITY_ACTION_SCHEMAS.verify_closing_item }).strict(),
]);
