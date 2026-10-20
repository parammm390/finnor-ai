/** Registered creation semantics, never fulfillment/approval/settlement. An
 * opaque rule label cannot silently acquire one of these completion meanings. */
export const INSTITUTION_COMPLETION_CONTRACTS = {
  create_deal_request: { postconditionRef: "x1:pe-request-created:v1",
    observerRef: "x1:pe-request-creation-observer:v1", entityType: "pe_request",
    meaning: "Exact canonical Request created open within the original deadline" },
  open_workstream: { postconditionRef: "x1:pe-workstream-created:v1",
    observerRef: "x1:pe-workstream-creation-observer:v1", entityType: "pe_workstream",
    meaning: "Exact canonical Workstream created not_started within the original deadline" },
  record_finding: { postconditionRef: "x1:pe-finding-created:v1",
    observerRef: "x1:pe-finding-creation-observer:v1", entityType: "pe_finding",
    meaning: "Exact canonical Finding created open within the original deadline" },
} as const;
export function supportsInstitutionCompletion(operation: string, postconditionRef: string, observerRef: string) {
  const contract = INSTITUTION_COMPLETION_CONTRACTS[operation as keyof typeof INSTITUTION_COMPLETION_CONTRACTS];
  return Boolean(contract && contract.postconditionRef === postconditionRef && contract.observerRef === observerRef);
}
