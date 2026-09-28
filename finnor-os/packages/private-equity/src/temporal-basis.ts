import { withTenantTransaction } from "@finnor/db";
import type { PeWorldStateResult } from "@finnor/shared-types";
import { compareUnderwritingRuns, getUnderwritingRun } from "./underwriting-repository";
import { PeDomainError, type PeMutationContext } from "./types";

type Review = NonNullable<PeWorldStateResult["temporalReview"]>;
type Basis = NonNullable<Review["recommendationComparisons"][number]["current"]>;
type Version = { entity_type: string; entity_id: string; snapshot: Record<string, unknown>; hash_valid: boolean };
const MAX_CASES = 40;
const string = (value: unknown) => typeof value === "string" ? value : null;

/** Read historical selected IC bases from the existing append-only owner ledger.
 * A new Run or an adjacent evidence timestamp never implies a recommendation. */
export async function loadTemporalBasisComparison(
  ctx: PeMutationContext, dealIds: string[], sinceAt: string, untilAt: string,
): Promise<Pick<Review, "recommendationComparisons" | "modelComparisons" | "basisCoverage">> {
  if (!dealIds.length) return { recommendationComparisons: [], modelComparisons: [], basisCoverage: { status: "unavailable", truncated: false, reasons: ["No Deal identity was available in the selected temporal world"] } };
  const selected = await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true }, async (_db, client) => {
    const load = async (at: string) => {
      const rows = await client.query<Version>(
        `SELECT DISTINCT ON (entity_id) entity_type,entity_id::text,snapshot,
           snapshot_hash=encode(public.digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex') hash_valid
         FROM finnor_os.canonical_entity_versions
         WHERE tenant_id=$1 AND entity_type='pe_ic_case' AND recorded_at<=$2
           AND snapshot->>'deal_id'=ANY($3::text[])
         ORDER BY entity_id,recorded_at DESC,entity_version DESC LIMIT $4`,
        [ctx.auth.tenantId, at, dealIds, MAX_CASES + 1]);
      for (const row of rows.rows) if (!row.hash_valid) throw new PeDomainError("PE_HISTORY_HASH_MISMATCH", "IC temporal basis snapshot failed hash verification");
      return rows.rows;
    };
    const before = await load(sinceAt);
    const current = await load(untilAt);
    const ids = [...new Set([...before, ...current].flatMap((row) => string(row.snapshot.current_recommendation_id) ?? []))];
    const recommendations = ids.length ? await client.query<Version>(
      `SELECT DISTINCT ON (entity_id) entity_type,entity_id::text,snapshot,
         snapshot_hash=encode(public.digest(convert_to(snapshot::text,'UTF8'),'sha256'),'hex') hash_valid
       FROM finnor_os.canonical_entity_versions
       WHERE tenant_id=$1 AND entity_type='pe_ic_recommendation' AND entity_id=ANY($2::uuid[]) AND recorded_at<=$3
       ORDER BY entity_id,recorded_at DESC,entity_version DESC LIMIT $4`,
      [ctx.auth.tenantId, ids, untilAt, MAX_CASES * 2 + 1]) : { rows: [] as Version[] };
    for (const row of recommendations.rows) if (!row.hash_valid) throw new PeDomainError("PE_HISTORY_HASH_MISMATCH", "IC recommendation snapshot failed hash verification");
    const coverage = await client.query<{ entity_type: string; coverage_started_at: Date }>(
      "SELECT entity_type,coverage_started_at FROM finnor_os.canonical_history_coverage WHERE entity_type IN ('pe_ic_case','pe_ic_recommendation')");
    return { before, current, recommendations: recommendations.rows, coverage: coverage.rows };
  });
  const covered = ["pe_ic_case", "pe_ic_recommendation"].every((type) => selected.coverage.some((row) => row.entity_type === type && row.coverage_started_at.getTime() <= Date.parse(sinceAt)));
  const truncated = selected.before.length > MAX_CASES || selected.current.length > MAX_CASES;
  const reasons: string[] = covered ? [] : ["IC history does not cover the whole requested baseline; a missing prior recommendation is unknown"];
  if (truncated) reasons.push("IC case comparison exceeded the bounded case limit");
  const recommendations = new Map(selected.recommendations.map((row) => [row.entity_id, row.snapshot]));
  const basis = (row: Version | undefined): Basis | null => {
    const id = row && string(row.snapshot.current_recommendation_id);
    if (!id) return null;
    const value = recommendations.get(id);
    if (!value) { reasons.push(`Recommendation ${id} has no readable historical snapshot`); return null; }
    const outcome = string(value.outcome), runId = string(value.underwriting_run_id), memoId = string(value.memo_id);
    if (!outcome || !runId || !memoId) throw new PeDomainError("PE_INVALID_TEMPORAL_BASIS", "A selected recommendation lacks its canonical basis");
    return { id, outcome, underwritingRunId: runId, memoId, rationale: string(value.rationale) };
  };
  const before = new Map(selected.before.map((row) => [row.entity_id, row]));
  const current = new Map(selected.current.map((row) => [row.entity_id, row]));
  const recommendationComparisons: Review["recommendationComparisons"] = [];
  const modelComparisons: Review["modelComparisons"] = [];
  const pairs = new Set<string>();
  for (const caseId of [...new Set([...before.keys(), ...current.keys()])].sort().slice(0, MAX_CASES)) {
    const left = basis(before.get(caseId)), right = basis(current.get(caseId));
    const fieldsChanged = (["outcome", "underwritingRunId", "memoId", "rationale"] as const).filter((field) => left?.[field] !== right?.[field]);
    const assessment = !covered ? "unverified" : left && right ? left.outcome !== right.outcome ? "changed_outcome" : fieldsChanged.length ? "changed_basis" : "unchanged_record" : right ? "new_recommendation" : left ? "selection_removed" : "no_selected_recommendation";
    recommendationComparisons.push({ caseId, baseline: left, current: right, assessment, fieldsChanged, sourceRefs: [
      { table: "canonical_entity_versions", id: caseId, fieldPath: "current_recommendation_id" },
      ...[left, right].flatMap((item) => item ? [{ table: "pe_ic_recommendations", id: item.id }] : []),
    ] });
    if (left && right && left.underwritingRunId !== right.underwritingRunId) {
      const key = `${left.underwritingRunId}:${right.underwritingRunId}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      // Canonical repository reads verify both immutable input/result hashes.
      const [leftRun, rightRun, diff] = await Promise.all([
        getUnderwritingRun(ctx, left.underwritingRunId), getUnderwritingRun(ctx, right.underwritingRunId),
        compareUnderwritingRuns(ctx, left.underwritingRunId, right.underwritingRunId),
      ]);
      if (Date.parse(String(leftRun.computedAt)) > Date.parse(sinceAt) || Date.parse(String(rightRun.computedAt)) > Date.parse(untilAt)) throw new PeDomainError("PE_INVALID_TEMPORAL_BASIS", "Selected Run was computed after its historical cutoff");
      modelComparisons.push({ caseId, baselineRunId: left.underwritingRunId, currentRunId: right.underwritingRunId,
        changedInputs: diff.changedInputs as Record<string, unknown>, changedOutputs: diff.changedOutputs as Record<string, unknown>,
        sourceRefs: [{ table: "underwriting_runs", id: left.underwritingRunId }, { table: "underwriting_runs", id: right.underwritingRunId }] });
    }
  }
  return { recommendationComparisons, modelComparisons, basisCoverage: { status: covered && !truncated && !reasons.length ? "complete" : "partial", truncated, reasons: [...new Set(reasons)] } };
}
