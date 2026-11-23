/** Single literal original fixture shared by the retained recovery pairs (AD2).
 * Native preparation supplies real source rows and bindings; these are not answers. */
import { randomUUID } from "node:crypto";

export function originalRequest() {
  const input = (key: string) => ({ kind: "input", key });
  return { schema: "finnor.harness-request.v1", instruction: "Produce a source-cited analytical draft of equity after debt and all recorded liabilities, with leverage. No IC approval or external effect is requested.",
    root: { entityType: "external_organization", entityId: randomUUID() }, validAt: "2026-01-01T00:00:00.000Z",
    mode: "ordinary_disposable", idempotencyKey: randomUUID(), sources: ["EV", "debt", "EBITDA", "liability"].map(key => ({ key,
      source: { kind: "metric", subject: { entityType: "external_organization", entityId: randomUUID() }, metricKey: key,
        periodStart: "2025-01-01T00:00:00.000Z", periodEnd: "2025-12-31T00:00:00.000Z", unit: "currency", currencyCode: "USD",
        frequency: "annual", calendar: "OWNER_RECORDED", consolidation: "OWNER_SUBJECT_ONLY", instrument: "UNSPECIFIED", scale: "1", sign: "AS_RECORDED" } })),
    acceptance: { requiredSourceKeys: ["EV", "debt", "EBITDA", "liability"], targets: [
      { key: "netEquity", expression: { kind: "subtract", left: { kind: "subtract", left: input("EV"), right: input("debt") }, right: input("liability") }, unit: "currency", currencyCode: "USD" },
      { key: "leverage", expression: { kind: "ratio", left: input("debt"), right: input("EBITDA") }, unit: "multiple", currencyCode: null }],
    deliverable: { kind: "analytical_draft", title: "Original physical recovery analytical draft" } } };
}
