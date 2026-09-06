// GET /api/read-models/:view — Phase 6 cross-entity read-models (docs/jarvis-90-
// execution-blueprint.md §6), exposed directly so the dealer console (or any future
// dashboard) can query the same real, typed views workflow 6's daily digest already
// consumes — one query per named view, no LLM involved.

import { requireContext, errorResponse, AuthError } from "../../../../lib/auth";
import {
  reliability,
  readinessTrend,
  readinessSloScorecard,
  failureInjectionLog,
  workCases,
  workCasesPage,
} from "@finnor/read-models";
import { getProjection } from "@finnor/projections";

const VIEWS: Record<string, (tenantId: string, searchParams: URLSearchParams) => Promise<unknown>> = {
  // B1.T3: these 3 are served from the CQRS cache (self-healing on a cold miss), not
  // recomputed on every request — see packages/projections. windowDays on reliability
  // is ignored by the cached path (the cache is always the default 1-day window);
  // pass windowDays to opt into a live, uncached computation instead.
  "activity-snapshot": (tenantId) => getProjection(tenantId, "activity-snapshot"),
  "reliability": (tenantId, searchParams) => {
    const windowDays = Number(searchParams.get("windowDays") ?? 1);
    if (searchParams.has("windowDays") && Number.isFinite(windowDays) && windowDays > 0 && windowDays !== 1) {
      return reliability(tenantId, windowDays);
    }
    return getProjection(tenantId, "reliability");
  },
  // Backward-compatible registry entry; GET special-cases this view below to expose
  // its truthful bounded-page metadata alongside the unchanged data array.
  "work-cases": (tenantId) => workCases(tenantId),
  // Phase 8 (§8.3): the 30-day certification trend the cockpit's scorecard panel reads.
  "readiness": (tenantId, searchParams) => {
    const days = Number(searchParams.get("days") ?? 30);
    return readinessTrend(tenantId, Number.isFinite(days) && days > 0 ? days : 30);
  },
  "readiness-slo": (tenantId) => readinessSloScorecard(tenantId),
  // Phase 8 (§8.2): the failure-injection calendar's real log.
  "failure-injections": (tenantId) => failureInjectionLog(tenantId),
};

export async function GET(req: Request, { params }: { params: Promise<{ view: string }> }): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const { view } = await params;
    const fn = VIEWS[view];
    if (!fn) {
      return Response.json({ error: `Unknown read-model "${view}". Valid views: ${Object.keys(VIEWS).join(", ")}` }, { status: 404 });
    }
    const searchParams = new URL(req.url).searchParams;
    if (view === "work-cases") {
      const rawLimit = searchParams.get("limit");
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      const result = await workCasesPage(ctx.tenantId, { limit, cursor: searchParams.get("cursor") ?? undefined });
      return Response.json({ view, data: result.items, page: result.page });
    }
    const data = await fn(ctx.tenantId, searchParams);
    return Response.json({ view, data });
  } catch (err) {
    return errorResponse(err);
  }
}
