import { z } from "zod";

const ClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24-hour time)");
export const UserPreferencesPatchSchema = z.object({
  homepage: z.enum(["bridge", "map", "my-day"]).nullable().optional(),
  density: z.enum(["comfortable", "compact"]).optional(),
  pinnedPanels: z.array(z.string().min(1).max(80)).max(30).optional(),
  accent: z.string().min(1).max(40).nullable().optional(),
  soundEnabled: z.boolean().optional(),
  notificationPreferences: z.record(z.string().max(80), z.boolean()).optional(),
  quietHoursStart: ClockSchema.nullable().optional(),
  quietHoursEnd: ClockSchema.nullable().optional(),
}).superRefine((value, ctx) => {
  const starts = value.quietHoursStart !== undefined;
  const ends = value.quietHoursEnd !== undefined;
  if (starts !== ends) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quietHoursStart and quietHoursEnd must be changed together" });
  if (starts && (value.quietHoursStart === null) !== (value.quietHoursEnd === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quiet hours must include both times or neither" });
  }
});
