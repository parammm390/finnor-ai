import { z } from "zod";

const SAFE_PROFILE_KEY = /^(?!.*(?:password|secret|token|api.?key|credential|authorization))[A-Za-z][A-Za-z0-9_. -]{0,79}$/i;

function profileRecordAudit(value: unknown, depth = 0): { unsafe: boolean; tooDeep: boolean; fields: number } {
  if (depth > 8) return { unsafe: false, tooDeep: true, fields: 0 };
  if (Array.isArray(value)) {
    return value.reduce((result, item) => {
      const nested = profileRecordAudit(item, depth + 1);
      return { unsafe: result.unsafe || nested.unsafe, tooDeep: result.tooDeep || nested.tooDeep, fields: result.fields + nested.fields };
    }, { unsafe: false, tooDeep: false, fields: 0 });
  }
  if (!value || typeof value !== "object") return { unsafe: false, tooDeep: false, fields: 0 };
  return Object.entries(value as Record<string, unknown>).reduce<{ unsafe: boolean; tooDeep: boolean; fields: number }>((result, [key, nestedValue]) => {
    const nested = profileRecordAudit(nestedValue, depth + 1);
    return {
      unsafe: result.unsafe || !SAFE_PROFILE_KEY.test(key) || nested.unsafe,
      tooDeep: result.tooDeep || nested.tooDeep,
      fields: result.fields + 1 + nested.fields,
    };
  }, { unsafe: false, tooDeep: false, fields: 0 });
}

const BoundedRecord = z.record(z.unknown()).superRefine((value, ctx) => {
  const audit = profileRecordAudit(value);
  if (audit.fields > 200) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "profile record may contain at most 200 fields" });
  if (audit.unsafe) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "profile record contains an unsafe field name" });
  if (audit.tooDeep) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "profile record nesting is too deep" });
  if (JSON.stringify(value).length > 20_000) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "profile record is too large" });
});

const CompanyProfileSchema = z.object({
  industry: z.string().trim().min(1).max(160).nullable(),
  niche: z.string().trim().min(1).max(200).nullable(),
  description: z.string().trim().min(1).max(2_000).nullable(),
  primaryGeographies: z.array(z.string().trim().min(1).max(120)).max(20),
  foundedYear: z.number().int().min(1800).max(2200).nullable(),
  idealCustomerProfile: BoundedRecord,
  businessFacts: BoundedRecord,
  comparisonDefaults: z.object({
    scaleMetric: z.string().trim().min(1).max(100).optional(),
    performanceMetric: z.string().trim().min(1).max(120).optional(),
  }),
});

const EmployeeProfileSchema = z.object({
  title: z.string().trim().min(1).max(160).nullable(),
  profileFacts: BoundedRecord,
});

export const OperatingProfileUpdateSchema = z.object({
  company: CompanyProfileSchema.optional(),
  employee: EmployeeProfileSchema.optional(),
}).refine((value) => Boolean(value.company || value.employee), "company or employee profile is required");
