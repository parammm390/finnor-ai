import { z } from "zod";
import { enqueueJob } from "@finnor/db";
import { resolveCredentialContext } from "@finnor/security";
import { sendEmail } from "./email";
import { IntegrationError } from "./errors";
import { exaSearch } from "./exa";
import { firecrawlScrape } from "./firecrawl";
import { placeVapiCall } from "./vapi-rest";
import { ToolRegistry, type ToolRuntimeContext } from "./registry";

function actor(runtime: Readonly<ToolRuntimeContext> | undefined): string {
  return runtime?.actorId ?? "system:tool-runtime";
}

function purpose(runtime: Readonly<ToolRuntimeContext> | undefined, fallback: string): string {
  return runtime?.purpose?.trim() || fallback;
}

/**
 * Active Core tools only. Private Equity actions primarily mutate canonical
 * Postgres through their plug-in; generic communications and source retrieval use
 * these governed transports.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register({
    name: "web_search",
    description: "Real-time, read-only web search with citation metadata",
    integration: "exa",
    inputSchema: z.object({
      query: z.string().min(2).max(2_000),
      numResults: z.number().int().min(1).max(10).optional(),
    }).strict(),
    piiAllowlist: ["query", "numResults"],
    async run(input) {
      return {
        results: await exaSearch({
          query: String(input.query),
          numResults: input.numResults ? Number(input.numResults) : 5,
        }),
      };
    },
  });

  registry.register({
    name: "firecrawl_scrape",
    description: "Read-only source retrieval with URL and terms controls",
    integration: "firecrawl",
    inputSchema: z.object({
      url: z.string().url().max(2_048),
      maxChars: z.number().int().min(100).max(40_000).optional(),
      allowedDomains: z.array(z.string().min(1).max(253)).max(20).optional(),
      termsApproved: z.boolean().optional(),
      requireTermsApproval: z.boolean().optional(),
    }).strict(),
    piiAllowlist: ["url", "maxChars", "allowedDomains", "termsApproved", "requireTermsApproval"],
    async run(input) {
      return {
        result: await firecrawlScrape({
          url: String(input.url),
          maxChars: input.maxChars === undefined ? undefined : Number(input.maxChars),
          allowedDomains: Array.isArray(input.allowedDomains) ? input.allowedDomains.map(String) : undefined,
          termsApproved: input.termsApproved === true,
          requireTermsApproval: input.requireTermsApproval === true,
        }),
      };
    },
  });

  registry.register({
    name: "send_email",
    description: "Send email through an execution-resolved, governed identity",
    integration: "gmail",
    inputSchema: z.object({
      tenantId: z.string().uuid(),
      to: z.string().email(),
      subject: z.string().min(1).max(998),
      body: z.string().min(1).max(100_000),
    }).strict(),
    piiAllowlist: ["tenantId", "to", "subject", "body"],
    async run(input, runtime) {
      const tenantId = String(input.tenantId);
      const context = await resolveCredentialContext(
        tenantId,
        actor(runtime),
        "gmail",
        purpose(runtime, "send_email"),
        {
          channel: "email",
          ...(runtime?.communicationIdentityId
            ? { communicationIdentityId: runtime.communicationIdentityId }
            : {}),
        },
      );
      const result = await sendEmail({
        tenantId,
        to: String(input.to),
        subject: String(input.subject),
        body: String(input.body),
      }, context);
      return {
        sent: true,
        messageId: result.messageId,
        communicationIdentityId: context.access.communicationIdentityId,
      };
    },
  });

  registry.register({
    name: "send_sms_to_number",
    description: "Reserved Core SMS transport; unavailable until a non-retired provider adapter is configured",
    integration: "sms",
    inputSchema: z.object({
      tenantId: z.string().uuid(),
      phoneNumber: z.string().min(7).max(40),
      message: z.string().min(1).max(5_000),
    }).strict(),
    piiAllowlist: ["tenantId", "phoneNumber", "message"],
    async run() {
      throw new IntegrationError(
        "sms",
        "No active Core SMS provider adapter is configured",
        false,
        "config",
      );
    },
  });

  registry.register({
    name: "vapi_place_call",
    description: "Place one governed employee or business-party call through Vapi",
    integration: "vapi",
    inputSchema: z.object({
      tenantId: z.string().uuid(),
      phoneNumber: z.string().min(7).max(40),
      instructions: z.string().min(1).max(5_000),
      purpose: z.string().min(1).max(200).optional(),
      assistantId: z.string().min(1).max(500).optional(),
      domainActionId: z.string().uuid().optional(),
    }).strict(),
    piiAllowlist: ["tenantId", "phoneNumber", "instructions", "purpose", "assistantId", "domainActionId"],
    async run(input, runtime) {
      const tenantId = String(input.tenantId);
      const context = await resolveCredentialContext(
        tenantId,
        actor(runtime),
        "vapi",
        purpose(runtime, "vapi_place_call"),
        {
          channel: "voice",
          ...(runtime?.communicationIdentityId
            ? { communicationIdentityId: runtime.communicationIdentityId }
            : {}),
        },
      );
      const result = await placeVapiCall({
        tenantId,
        destinationNumber: String(input.phoneNumber),
        firstMessage: String(input.instructions),
        metadata: {
          direction: "outbound",
          purpose: String(input.purpose ?? "business_communication"),
          ...(input.domainActionId ? { domainActionId: String(input.domainActionId) } : {}),
        },
        assistantId: input.assistantId ? String(input.assistantId) : undefined,
      }, context);
      if (!result.ok) throw new IntegrationError(
        "vapi",
        result.error ?? "Vapi call failed",
        result.errorKind === "retryable",
        result.errorKind,
      );
      return {
        ...result.output,
        live: true,
        communicationIdentityId: context.access.communicationIdentityId,
      };
    },
  });

  registry.register({
    name: "send_finnor_notification",
    description: "Queue a Finnor-owned operational notification through the guarded Resend path",
    integration: "resend",
    inputSchema: z.object({
      tenantId: z.string().uuid(),
      to: z.string().email(),
      subject: z.string().min(1).max(998),
      html: z.string().min(1).max(100_000),
    }).strict(),
    piiAllowlist: ["tenantId", "to", "subject", "html"],
    async run(input) {
      await enqueueJob("send_resend_email", {
        tenantId: String(input.tenantId),
        to: String(input.to),
        subject: String(input.subject),
        html: String(input.html),
      });
      return { queued: true, delivery: "pending" };
    },
  });
}
