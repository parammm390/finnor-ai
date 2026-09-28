import { tenantOperatingProfiles, userOperatingProfiles, withTenant } from "@finnor/db";
import { eq } from "drizzle-orm";
import { OperatingProfileUpdateSchema } from "../../../lib/operating-profile";
import { errorResponse, requireContext } from "../../../lib/auth";

function companyResponse(row: typeof tenantOperatingProfiles.$inferSelect | undefined) {
  return {
    industry: row?.industry ?? null,
    niche: row?.niche ?? null,
    description: row?.description ?? null,
    primaryGeographies: Array.isArray(row?.primaryGeographies) ? row.primaryGeographies : [],
    foundedYear: row?.foundedYear ?? null,
    idealCustomerProfile: row?.idealCustomerProfile ?? {},
    businessFacts: row?.businessFacts ?? {},
    comparisonDefaults: row?.comparisonDefaults ?? {},
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

function employeeResponse(row: typeof userOperatingProfiles.$inferSelect | undefined) {
  return {
    title: row?.title ?? null,
    profileFacts: row?.profileFacts ?? {},
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const result = await withTenant(ctx.tenantId, async (db) => {
      const [company] = await db.select().from(tenantOperatingProfiles).where(eq(tenantOperatingProfiles.tenantId, ctx.tenantId)).limit(1);
      const [employee] = await db.select().from(userOperatingProfiles).where(eq(userOperatingProfiles.userId, ctx.userId)).limit(1);
      return { company, employee };
    }, ctx.userId);
    return Response.json({ company: companyResponse(result.company), employee: employeeResponse(result.employee), companyEditable: ctx.role === "owner" });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const parsed = OperatingProfileUpdateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") }, { status: 400 });
    if (parsed.data.company && ctx.role !== "owner") return Response.json({ error: "Only owners can edit the company operating profile" }, { status: 403 });
    const result = await withTenant(ctx.tenantId, async (db) => {
      let company: typeof tenantOperatingProfiles.$inferSelect | undefined;
      let employee: typeof userOperatingProfiles.$inferSelect | undefined;
      if (parsed.data.company) {
        [company] = await db.insert(tenantOperatingProfiles)
          .values({ tenantId: ctx.tenantId, ...parsed.data.company, updatedAt: new Date() })
          .onConflictDoUpdate({ target: tenantOperatingProfiles.tenantId, set: { ...parsed.data.company, updatedAt: new Date() } })
          .returning();
      } else {
        [company] = await db.select().from(tenantOperatingProfiles).where(eq(tenantOperatingProfiles.tenantId, ctx.tenantId)).limit(1);
      }
      if (parsed.data.employee) {
        [employee] = await db.insert(userOperatingProfiles)
          .values({ userId: ctx.userId, tenantId: ctx.tenantId, ...parsed.data.employee, updatedAt: new Date() })
          .onConflictDoUpdate({ target: userOperatingProfiles.userId, set: { ...parsed.data.employee, updatedAt: new Date() } })
          .returning();
      } else {
        [employee] = await db.select().from(userOperatingProfiles).where(eq(userOperatingProfiles.userId, ctx.userId)).limit(1);
      }
      return { company, employee };
    }, ctx.userId);
    return Response.json({ company: companyResponse(result.company), employee: employeeResponse(result.employee), companyEditable: ctx.role === "owner" });
  } catch (error) {
    return errorResponse(error);
  }
}
