import { tasks, type Db } from "@finnor/db";
import { recordBusinessEvent } from "./events";

export interface CreateTaskParams {
  tenantId: string;
  subjectType: string;
  subjectId: string;
  title: string;
  dueAt?: Date;
  assigneeType?: "user";
  assigneeId?: string;
  priority?: "low" | "normal" | "high";
}

export async function createTask(db: Db, params: CreateTaskParams): Promise<{ taskId: string }> {
  const [task] = await db
    .insert(tasks)
    .values({
      tenantId: params.tenantId,
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      title: params.title,
      dueAt: params.dueAt ?? null,
      assigneeType: params.assigneeType ?? null,
      assigneeId: params.assigneeId ?? null,
      priority: params.priority ?? "normal",
    })
    .returning();
  await recordBusinessEvent(db, {
    tenantId: params.tenantId,
    entityType: "task",
    entityId: task!.id,
    eventType: "task_created",
  });
  return { taskId: task!.id };
}
