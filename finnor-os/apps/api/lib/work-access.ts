import { canReadEmployeeInstruction, canReadEmployeeWork } from "@finnor/db";
import type { TenantContext } from "@finnor/shared-types";
import { AuthError } from "./auth";

/** The employee whose Work relationships decide what this request may see. */
export function requestEmployee(ctx: TenantContext): string {
  return ctx.employeeId ?? ctx.userId;
}

/** Answers a foreign Work exactly like a missing one, before the route reads it. */
export async function requireVisibleWork(ctx: TenantContext, workId: string): Promise<void> {
  if (!(await canReadEmployeeWork(ctx.tenantId, workId, requestEmployee(ctx)))) throw new AuthError("Work not found", 404);
}

/** Answers a foreign instruction exactly like a missing one, before the route reads it. */
export async function requireVisibleInstruction(ctx: TenantContext, instructionId: string): Promise<void> {
  if (!(await canReadEmployeeInstruction(ctx.tenantId, instructionId, requestEmployee(ctx)))) throw new AuthError("Instruction not found", 404);
}
