import type { DomainEnginePlugin } from "../shared/plugin-interface";
import { queueComputerRun } from "@finnor/computer";
import type { ComputerTaskInput, DraftAction, DomainPolicy, ExecutionResult, ValidationResult } from "@finnor/shared-types";
import { z } from "zod";

const targetSchema = z.object({
  kind: z.string().trim().min(1).max(120),
  identifier: z.string().trim().min(1).max(500),
}).strict();

const scalarSchema = z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]);
const authorizedEffectSchema = z.object({
  operation: z.string().trim().min(1).max(200),
  target: targetSchema,
  changes: z.record(z.string().trim().min(1).max(120), scalarSchema),
}).strict();

export const ComputerTaskSchema = z.object({
  application: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/),
  authProfileRef: z.string().trim().min(3).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/),
  task: z.string().trim().min(3).max(4000),
  target: targetSchema,
  mode: z.enum(["READ_ONLY", "WRITE"]),
  successCriteria: z.array(z.string().trim().min(3).max(500)).min(1).max(12),
  authorizedEffect: authorizedEffectSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "READ_ONLY" && value.authorizedEffect) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["authorizedEffect"], message: "READ_ONLY tasks cannot authorize an external mutation" });
  }
  if (value.mode === "WRITE" && !value.authorizedEffect) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["authorizedEffect"], message: "WRITE tasks require one precise authorized effect" });
  }
  if (value.authorizedEffect && (value.authorizedEffect.target.kind !== value.target.kind || value.authorizedEffect.target.identifier !== value.target.identifier)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["authorizedEffect", "target"], message: "The authorized effect target must exactly match the task target" });
  }
});

export const computerTaskPlugin: DomainEnginePlugin = {
  name: "computer-task",
  actionTypes: ["computer_task"],
  payloadSchemas: { computer_task: ComputerTaskSchema },
  canHandle: (actionType) => actionType === "computer_task",
  validate(actionType, payload): ValidationResult {
    if (actionType !== "computer_task") return { valid: false, errors: [`unhandled action ${actionType}`] };
    const parsed = ComputerTaskSchema.safeParse(payload);
    return parsed.success ? { valid: true, errors: [] } : { valid: false, errors: parsed.error.issues.map((issue) => `payload.${issue.path.join(".")}: ${issue.message}`) };
  },
  draft(actionType, payload, policy: DomainPolicy): DraftAction {
    const task = ComputerTaskSchema.parse(payload);
    return {
      actionType,
      summary: task.mode === "WRITE"
        ? `Use ${task.application} as ${task.authProfileRef} to perform exactly: ${task.authorizedEffect!.operation} on ${task.target.kind} ${task.target.identifier}.`
        : `Use ${task.application} as ${task.authProfileRef} to inspect ${task.target.kind} ${task.target.identifier}: ${task.task}`,
      payload: task,
      // READ_ONLY follows policy. Every WRITE is approval-gated even if a tenant row
      // was accidentally configured otherwise.
      requiresConfirmation: task.mode === "WRITE" || policy.requiresConfirmation,
    };
  },
  simulate(_actionType, payload) {
    const task = ComputerTaskSchema.parse(payload);
    return {
      mode: "schema",
      summary: `A bounded ${task.mode} computer run would use the governed ${task.application}/${task.authProfileRef} binding. No session is created during simulation.`,
      predicted: { application: task.application, authProfileRef: task.authProfileRef, mode: task.mode, target: task.target, fieldChanges: [] },
    };
  },
  async execute(draft, tools): Promise<ExecutionResult> {
    try {
      const runtime = tools.runtimeContext();
      const { tenantId: envelopeTenant, ...semanticPayload } = draft.payload;
      if (envelopeTenant !== undefined && envelopeTenant !== runtime?.tenantId) {
        throw new Error("Computer task runtime tenant does not match the semantic envelope");
      }
      const input = ComputerTaskSchema.parse(semanticPayload) as ComputerTaskInput;
      const queued = await queueComputerRun(input, runtime);
      return {
        status: "success",
        output: { computerRunId: queued.run.id, computerRunStatus: queued.run.status, pendingComputerRun: true, duplicate: !queued.created },
        expected: { computerRunId: queued.run.id, terminalResultRequired: true },
      };
    } catch (error) {
      return { status: "failure", output: {}, error: error instanceof Error ? error.message : "Computer task could not be queued", errorKind: "validation" };
    }
  },
};

export default computerTaskPlugin;
