import { z } from "zod";
import { CapabilityJsonTransport, CapabilityProviderError } from "./capabilities/provider-json";

const identifier = z.string().min(1).max(1024).refine(value => !/[\u0000-\u001f]/.test(value));
// Only explicit completion is publishable. New provider queue/progress labels
// remain bounded pending observations under the original accepted deadline.
const state = z.object({ status: z.string().min(1).max(64), result: z.unknown().optional() }).passthrough();

const chatCitation = z.object({ doc_id: identifier.optional(), document_id: identifier.optional(), page: z.number().int().positive().max(100_000).optional(),
  page_index: z.number().int().positive().max(100_000).optional(), block_id: identifier.optional(), node_id: identifier.optional(),
  document: identifier.optional(), filename: identifier.optional() }).passthrough();
/** Current documented document/tree and scoped chat protocol. Shared transport
 * retains absolute deadlines and ambiguous-write semantics. */
export class PageIndexClient {
  private readonly transport: CapabilityJsonTransport;
  constructor(config: { apiKey: string; baseUrl?: string }) {
    if (!config.apiKey.trim()) throw new CapabilityProviderError("pageindex", "API_KEY_REQUIRED", "BEFORE_DISPATCH");
    this.transport = new CapabilityJsonTransport("pageindex", config.baseUrl ?? "https://api.pageindex.ai", { api_key: config.apiKey });
  }
  private async acknowledge<T>(schema: z.ZodType<T>, pending: Promise<unknown>): Promise<T> {
    const parsed = schema.safeParse(await pending);
    if (!parsed.success) throw new CapabilityProviderError("pageindex", "ACKNOWLEDGEMENT_INVALID", "UNKNOWN");
    return parsed.data;
  }
  async submitDocument(bytes: Buffer, deadlineAt: number) {
    if (bytes.length > 10_485_760 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new CapabilityProviderError("pageindex", "PDF_REQUIRED_WITHIN_SIZE_LIMIT", "BEFORE_DISPATCH");
    const form = new FormData(); form.set("file", new Blob([Uint8Array.from(bytes)], { type: "application/pdf" }), "source.pdf");
    // Source/run identity stays in the durable FINNOR receipt. Custom provider
    // metadata requires a separately declared workspace schema on PageIndex.
    return this.acknowledge(z.object({ doc_id: identifier }).passthrough(), this.transport.request({ method: "POST", path: "/doc/", form, deadlineAt }));
  }
  async tree(id: string, deadlineAt: number) {
    return state.parse(await this.transport.request({ method: "GET", path: `/doc/${encodeURIComponent(identifier.parse(id))}/?type=tree&summary=true`, deadlineAt }));
  }
  async chat(id: string, question: string, deadlineAt: number) {
    return this.acknowledge(z.object({ id: identifier, choices: z.array(z.object({ message: z.object({ role: z.literal("assistant"), content: z.string().max(2_000_000) }).passthrough(),
      finish_reason: z.enum(["stop", "end_turn"]) }).passthrough()).min(1).max(4), citations: z.array(chatCitation).max(10_000).optional() }).passthrough(),
      this.transport.request({ method: "POST", path: "/chat/completions", body: { doc_id: identifier.parse(id), messages: [{ role: "user", content: question }], stream: false, temperature: 0, enable_citations: true }, deadlineAt, maxRequestMs: 120_000 }));
  }
}
