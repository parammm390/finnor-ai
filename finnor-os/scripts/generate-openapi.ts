// OpenAPI is generated from the active Phase-5 boundary schemas only. Historical
// Water webhook payloads are intentionally opaque quarantine receipts and never
// regain an executable public schema here.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  SubmitInstructionSchema,
  StartObjectiveSchema,
  ControlObjectiveSchema,
  HandoffWorkSchema,
  StartOutcomePackSchema,
  ConfirmActionSchema,
  RejectActionSchema,
  EscalateActionSchema,
  UpsertPolicySchema,
  VapiWebhookSchema,
} from "@finnor/policy-schema";

const page = z.object({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(4096).optional() }).strict();
const range = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }).strict();
const localRange = z.object({
  startDate: z.string().regex(/^(?:today|tomorrow|\d{4}-\d{2}-\d{2})$/),
  endDate: z.string().regex(/^(?:today|tomorrow|\d{4}-\d{2}-\d{2})$/).optional(),
}).strict();
const partyRef = z.object({
  partyType: z.enum(["employee", "team", "location", "external_organization", "external_contact"]),
  partyId: z.string().uuid(),
}).strict();
const entityRef = z.object({
  entityType: z.enum(["work", "task", "user", "org_unit", "tenant_location", "external_organization", "external_contact", "document", "domain_action", "workflow_run", "workflow_step", "pe_fund", "pe_portfolio_company", "pe_deal", "pe_deal_party", "pe_workstream", "pe_request", "pe_deliverable", "pe_finding", "pe_deal_risk", "pe_closing_condition", "pe_closing_item", "pe_deal_dependency"]),
  entityId: z.string().uuid(),
}).strict();
const deal = { dealId: z.string().uuid(), page: page.optional() } as const;
const queryEnvelope = {
  workId: z.string().uuid().optional(),
  executionKey: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
} as const;

const OperationalQuerySchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("work_list"), ...queryEnvelope, section: z.enum(["all", "works", "tasks"]).optional(), openOnly: z.boolean().optional(), statuses: z.array(z.string().min(1).max(80)).max(20).optional(), recordId: z.string().uuid().optional(), page: page.optional() }).strict(),
  z.object({ intent: z.literal("agent_activity"), ...queryEnvelope, range: range.optional(), localDateRange: localRange.optional(), page: page.optional() }).strict(),
  z.object({ intent: z.literal("company_context"), ...queryEnvelope, anchor: z.union([entityRef, partyRef]).optional(), query: z.string().trim().min(1).max(300).optional() }).strict(),
  z.object({ intent: z.literal("party_lookup"), ...queryEnvelope, ref: partyRef.optional(), query: z.string().trim().min(1).max(300).optional(), page: page.optional() }).strict(),
  z.object({ intent: z.literal("party_context"), ...queryEnvelope, ref: partyRef.optional(), query: z.string().trim().min(1).max(300).optional(), page: page.optional() }).strict(),
  z.object({ intent: z.literal("team_roster"), ...queryEnvelope, teamRef: partyRef.optional(), query: z.string().trim().min(1).max(300).optional(), page: page.optional() }).strict(),
  z.object({ intent: z.literal("deal_context"), ...queryEnvelope, ...deal }).strict(),
  z.object({ intent: z.literal("deal_workstreams"), ...queryEnvelope, ...deal, states: z.array(z.string().min(1).max(80)).max(20).optional(), owner: partyRef.optional() }).strict(),
  z.object({ intent: z.literal("open_requests"), ...queryEnvelope, ...deal, workstreamId: z.string().uuid().optional(), requestedFrom: partyRef.optional(), dueState: z.enum(["any", "overdue", "not_overdue"]).optional() }).strict(),
  z.object({ intent: z.literal("open_findings"), ...queryEnvelope, ...deal, workstreamId: z.string().uuid().optional(), severities: z.array(z.enum(["low", "medium", "high", "critical"])).optional() }).strict(),
  z.object({ intent: z.literal("open_deal_risks"), ...queryEnvelope, ...deal, workstreamId: z.string().uuid().optional(), severities: z.array(z.enum(["low", "medium", "high", "critical"])).optional() }).strict(),
  z.object({ intent: z.literal("critical_dependencies"), ...queryEnvelope, ...deal, includeResolved: z.boolean().optional() }).strict(),
  z.object({ intent: z.literal("closing_readiness"), ...queryEnvelope, ...deal }).strict(),
]);

const s = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none" });
const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema: s(schema) } } });
const secured = [{ bearerAuth: [] }];
const paths = {
  "/api/instructions": { post: { security: secured, requestBody: json(SubmitInstructionSchema), responses: { "201": { description: "Work accepted" }, "400": { description: "Invalid or retired request" } } } },
  "/api/objectives": { post: { security: secured, requestBody: json(StartObjectiveSchema), responses: { "201": { description: "Objective accepted" } } } },
  "/api/objectives/{id}/control": { post: { security: secured, requestBody: json(ControlObjectiveSchema), responses: { "200": { description: "Control recorded" } } } },
  "/api/work/{id}/handoff": { post: { security: secured, requestBody: json(HandoffWorkSchema), responses: { "200": { description: "Handoff recorded" } } } },
  "/api/outcome-packs": { post: { security: secured, requestBody: json(StartOutcomePackSchema), responses: { "201": { description: "Outcome pack started" } } } },
  "/api/queries": { post: { security: secured, requestBody: json(OperationalQuerySchema), responses: { "201": { description: "Canonical query completed" }, "400": { description: "Invalid or retired query" } } } },
  "/api/actions/{id}/confirm": { post: { security: secured, requestBody: json(ConfirmActionSchema), responses: { "200": { description: "Approval recorded" } } } },
  "/api/actions/{id}/reject": { post: { security: secured, requestBody: json(RejectActionSchema), responses: { "200": { description: "Rejection recorded" } } } },
  "/api/actions/{id}/escalate": { post: { security: secured, requestBody: json(EscalateActionSchema), responses: { "200": { description: "Escalation recorded" } } } },
  "/api/policies/{tenantId}/{actionType}": { put: { security: secured, requestBody: json(UpsertPolicySchema), responses: { "200": { description: "Active policy saved" } } } },
  "/api/webhooks/vapi": { post: { requestBody: json(VapiWebhookSchema), responses: { "200": { description: "Employee voice event received" } } } },
  "/api/webhooks/ghl": { post: { responses: { "410": { description: "Authenticated historical payload quarantined; never executed" } } } },
  "/api/webhooks/marketing": { post: { responses: { "410": { description: "Authenticated historical payload quarantined; never executed" } } } },
  "/api/webhooks/payment": { post: { responses: { "410": { description: "Authenticated historical payload quarantined; never executed" } } } },
  "/api/webhooks/esign": { post: { responses: { "410": { description: "Authenticated historical payload quarantined; never executed" } } } },
} satisfies Record<string, unknown>;

const document = {
  openapi: "3.1.0",
  info: { title: "FINNOR Private Equity API", version: "5.0.0", description: "Private Equity is the only active product vertical. Historical Water payloads are receipt-only quarantine inputs." },
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
  paths,
};

// The tracked root contract is the release artifact consumed by tests and clients.
// Writing a second ignored copy allowed a stale Water-era schema to survive earlier
// generations, so there is deliberately one owner and one destination.
writeFileSync(new URL("../openapi.json", import.meta.url), `${JSON.stringify(document, null, 2)}\n`);
console.log(`Generated openapi.json with ${Object.keys(paths).length} active/quarantine paths.`);
