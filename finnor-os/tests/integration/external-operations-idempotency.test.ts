// external_operations ledger — ScopedToolRegistry must claim before calling out.
// A fresh ScopedToolRegistry is constructed per execute() call (see executor.ts /
// graph/nodes.ts), so "a retry" here means a second instance sharing the same
// domainActionId, exactly matching how a reflection retry or a resumed LangGraph
// thread actually invokes plugin.execute() again. The rule under test: a call that
// already SUCCEEDED is never re-run (true idempotency); an unresolved or potentially
// dispatched call is never blindly replayed. The
// composite PK (domain_action_id, operation_key) is what makes every claim atomic
// under real concurrency, not just app-level sequencing — tested against real
// Postgres, not mocked.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { z } from "zod";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import { withTenant, closePool, domainActions } from "@finnor/db";
import { ToolRegistry, ScopedToolRegistry, type ConsequentialDispatchRequest } from "@finnor/tools";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

async function makeAction(): Promise<string> {
  return withTenant(SEED_TENANT_ID, async (db) => {
    const [row] = await db.insert(domainActions).values({ tenantId: SEED_TENANT_ID, actionType: "test_idempotency", payload: {}, status: "executing" }).returning();
    return row!.id;
  });
}

describe.skipIf(!available)("ScopedToolRegistry — external_operations idempotency ledger", () => {
  const consequential = {
    effect: "consequential",
    retrySafety: "readback_required",
    idempotency: { mode: "readback" },
    verification: "readback",
  } as const;
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
  });
  afterAll(async () => {
    await closePool();
  });

  it("rechecks dispatch admission before each physical invocation and records a refused invocation without egress", async () => {
    const actionId = await makeAction();
    let admitted = true;
    let calls = 0;
    const base = new ToolRegistry();
    base.register({ name: "s6_dispatch_probe", description: "", integration: "test", inputSchema: z.object({ x: z.number() }).passthrough(), execution: consequential, async run() { calls += 1; return { accepted: true }; } });
    // This case owns callback placement and pre-egress persistence only. Actual
    // authority/current target conformance is owned by durable runtime scenarios.
    const context = {
      tenantId: SEED_TENANT_ID, domainActionId: actionId,
      beforeConsequentialDispatch: async () => { if (!admitted) throw Error("S6 dispatch authority revoked"); },
    };
    const first = await new ScopedToolRegistry(base, context).callIdempotent("s6_dispatch_probe", { x: 1 }, "member:first");
    expect(first.ok).toBe(true);
    admitted = false;
    const refused = await new ScopedToolRegistry(base, context).callIdempotent("s6_dispatch_probe", { x: 2 }, "member:second");
    expect(refused.ok).toBe(false);
    expect(refused.errorKind).toBe("auth");
    expect(calls).toBe(1);
    const client = new pg.Client({ connectionString: DB_URL }); await client.connect();
    try {
      const rows = (await client.query("SELECT request_may_have_left_at, outcome FROM finnor_os.provider_invocations WHERE tenant_id=$1 AND provider_operation_attempt_id IN (SELECT a.id FROM finnor_os.provider_operation_attempts a JOIN finnor_os.external_operations o ON o.tenant_id=a.tenant_id AND o.id=a.external_operation_id WHERE a.tenant_id=$1 AND o.domain_action_id=$2) ORDER BY started_at", [SEED_TENANT_ID, actionId])).rows;
      expect(rows).toHaveLength(2);
      expect(rows[0].request_may_have_left_at).not.toBeNull();
      expect(rows[1].request_may_have_left_at).toBeNull();
    } finally { await client.end(); }
  });

  it("a fresh instance replaying an already-SUCCEEDED call (simulating a retry) returns the cached result — run() never fires twice", async () => {
    let calls = 0;
    const base = new ToolRegistry();
    base.register({
      name: "spy_tool",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: consequential,
      async run(input) {
        calls++;
        return { echoed: input };
      },
    });
    const actionId = await makeAction();
    const attempt1 = new ScopedToolRegistry(base, { tenantId: SEED_TENANT_ID, domainActionId: actionId });
    const first = await attempt1.callIdempotent("spy_tool", { x: 1 }, "member:spy");
    expect(first.ok).toBe(true);

    // A fresh instance for the SAME action, same first call — exactly what a
    // reflection retry or resumed graph thread constructs.
    const attempt2 = new ScopedToolRegistry(base, { tenantId: SEED_TENANT_ID, domainActionId: actionId });
    const second = await attempt2.callIdempotent("spy_tool", { x: 1 }, "member:spy");
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it("preserves opaque provider IDs needed by a resumed multi-step effect while still redacting direct PII", async () => {
    let calls = 0;
    const contactId = randomUUID();
    const base = new ToolRegistry();
    base.register({
      name: "contact_upsert_replay",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: consequential,
      async run() {
        calls++;
        return { contactId, phone: "+15550109999", email: "private@example.test" };
      },
    });
    const actionId = await makeAction();
    const firstRegistry = new ScopedToolRegistry(base, { tenantId: SEED_TENANT_ID, domainActionId: actionId });
    await firstRegistry.callIdempotent("contact_upsert_replay", { phone: "+15550109999" }, "member:contact");

    const resumedRegistry = new ScopedToolRegistry(base, { tenantId: SEED_TENANT_ID, domainActionId: actionId });
    const resumed = await resumedRegistry.callIdempotent("contact_upsert_replay", { phone: "+15550109999" }, "member:contact");
    expect(calls).toBe(1);
    expect(resumed).toMatchObject({ ok: true, output: { contactId } });
    expect(resumed.output.phone).toBe("[REDACTED]");
    expect(resumed.output.email).toBe("[REDACTED]");
  });

  it("does not replay a failed call when the request may have left and no safe-repeat proof exists", async () => {
    let calls = 0;
    const base = new ToolRegistry();
    base.register({
      name: "flaky_tool",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: consequential,
      retryPolicy: { attempts: 1, baseDelayMs: 1, timeoutMs: 500 },
      async run() {
        calls++;
        if (calls === 1) throw new Error("first attempt fails");
        return { ok: true };
      },
    });
    const actionId = await makeAction();
    const attempt1 = new ScopedToolRegistry(base, { tenantId: SEED_TENANT_ID, domainActionId: actionId });
    const first = await attempt1.callIdempotent("flaky_tool", { x: 1 }, "member:flaky");
    expect(first.ok).toBe(false);
    expect(calls).toBe(1);
    expect(first.errorKind).toBe("unknown_outcome");

    const attempt2 = new ScopedToolRegistry(base, { tenantId: SEED_TENANT_ID, domainActionId: actionId });
    const second = await attempt2.callIdempotent("flaky_tool", { x: 1 }, "member:flaky");
    expect(calls).toBe(1);
    expect(second).toMatchObject({ ok: false, errorKind: "unknown_outcome" });
  });

  it.each(['retry_refusal','retry_expiry_at_dispatch'] as const)("preserves earlier delivery across provider-key expiry with %s", async (fault) => {
    const requests: unknown[]=[];
    const server=createServer(async (request,response)=>{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      requests.push({body:JSON.parse(Buffer.concat(chunks).toString()),key:request.headers['idempotency-key']});
      // Each accepted POST has a real independently observed consequence. Losing
      // its reply leaves the runtime ignorant of acceptance; no fixture receipt is
      // supplied to the native owner.
      response.destroy();
    });
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    const address=server.address();if(!address||typeof address==='string')throw Error('Local provider did not bind');
    const client=new pg.Client({connectionString:DB_URL});await client.connect();
    try{
      const actionId=await makeAction();let admitted=true,dispatchChecks=0;
      const base=new ToolRegistry();base.register({name:'history_retry_probe',description:'',integration:'test_history_retry',inputSchema:z.object({x:z.number()}).passthrough(),
        execution:{effect:'consequential',retrySafety:'provider_idempotent',verification:'readback',idempotency:{mode:'provider_key',scope:'disposable-history',ttlMs:fault==='retry_refusal'?60000:1000}},
        retryPolicy:{attempts:1,baseDelayMs:1,timeoutMs:500},
        async run(input,runtime){const r=await fetch(`http://127.0.0.1:${address.port}/effect`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':runtime!.providerIdempotencyKey!},body:JSON.stringify(input)});return await r.json();}});
      const context={tenantId:SEED_TENANT_ID,domainActionId:actionId,beforeConsequentialDispatch:async({runtime}:ConsequentialDispatchRequest)=>{
        dispatchChecks++;
        if(fault==='retry_refusal'&&!admitted)throw Error('Actual retry refused before adapter entry');
        if(fault==='retry_expiry_at_dispatch'&&dispatchChecks===2){
          const expiresAt=runtime.providerIdempotencyExpiresAt;
          if(!expiresAt)throw Error('Native retry window was not supplied');
          await new Promise(done=>setTimeout(done,Math.max(0,expiresAt.getTime()-Date.now()+30)));
        }
      }};
      const first=await new ScopedToolRegistry(base,context).callIdempotent('history_retry_probe',{x:7},'one-logical-member');
      admitted=false;
      const second=await new ScopedToolRegistry(base,context).callIdempotent('history_retry_probe',{x:7},'one-logical-member');
      const beforeExpiry=(await client.query('SELECT * FROM finnor_os.external_operations WHERE tenant_id=$1 AND domain_action_id=$2',[SEED_TENANT_ID,actionId])).rows;
      await client.query("UPDATE finnor_os.external_operations SET provider_idempotency_expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND domain_action_id=$2",[SEED_TENANT_ID,actionId]);
      admitted=true;
      const third=await new ScopedToolRegistry(base,context).callIdempotent('history_retry_probe',{x:7},'one-logical-member');
      const operations=(await client.query('SELECT * FROM finnor_os.external_operations WHERE tenant_id=$1 AND domain_action_id=$2',[SEED_TENANT_ID,actionId])).rows;
      const attempts=(await client.query('SELECT a.* FROM finnor_os.provider_operation_attempts a JOIN finnor_os.external_operations o ON o.tenant_id=a.tenant_id AND o.id=a.external_operation_id WHERE o.tenant_id=$1 AND o.domain_action_id=$2 ORDER BY a.ordinal',[SEED_TENANT_ID,actionId])).rows;
      const invocations=(await client.query('SELECT i.* FROM finnor_os.provider_invocations i JOIN finnor_os.provider_operation_attempts a ON a.tenant_id=i.tenant_id AND a.id=i.provider_operation_attempt_id JOIN finnor_os.external_operations o ON o.tenant_id=a.tenant_id AND o.id=a.external_operation_id WHERE o.tenant_id=$1 AND o.domain_action_id=$2 ORDER BY a.ordinal,i.ordinal',[SEED_TENANT_ID,actionId])).rows;
      if(process.env.FINNOR_S6_NATIVE_EVIDENCE_DIR){await mkdir(process.env.FINNOR_S6_NATIVE_EVIDENCE_DIR,{recursive:true});await writeFile(join(process.env.FINNOR_S6_NATIVE_EVIDENCE_DIR,'provider-history-'+fault+'.json'),JSON.stringify({inputs:{actionId,fault,body:{x:7},faults:['accept_then_drop_reply',fault,'expire_disposable_provider_key']},requests,dispatchChecks,first,second,beforeExpiry,third,operations,attempts,invocations,qualification:'Actual local HTTP and native PostgreSQL; not live provider TTL or protected admission'},null,2)+'\n');}
      expect(first.errorKind).toBe('unknown_outcome');expect(second.errorKind).toBe(fault==='retry_refusal'?'auth':'conflict');expect(third.errorKind).toBe('unknown_outcome');
      expect(requests).toHaveLength(1);expect(beforeExpiry[0].status).toBe('unknown');expect(operations[0].status).toBe('unknown');expect(attempts).toHaveLength(2);
      expect(invocations.map(i=>i.outcome)).toEqual(['unknown_outcome','definite_pre_dispatch_failure']);
      expect(invocations[0].request_may_have_left_at).not.toBeNull();expect(invocations[1].request_may_have_left_at).toBeNull();
    }finally{await client.end();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
  });

  it("a fresh instance replaying a SUCCEEDED call with DIFFERENT input errors instead of silently accepting drift", async () => {
    const base = new ToolRegistry();
    base.register({
      name: "spy_tool2",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: consequential,
      async run() {
        return {};
      },
    });
    const actionId = await makeAction();
    const attempt1 = new ScopedToolRegistry(base, { tenantId: SEED_TENANT_ID, domainActionId: actionId });
    await attempt1.callIdempotent("spy_tool2", { x: 1 }, "member:drift");

    const attempt2 = new ScopedToolRegistry(base, { tenantId: SEED_TENANT_ID, domainActionId: actionId });
    const conflict = await attempt2.callIdempotent("spy_tool2", { x: 2 }, "member:drift");
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toMatch(/Idempotency conflict/);
  });

  it("multiple calls to the SAME tool within ONE instance (a bulk-send loop) are each treated as distinct operations — never collapsed", async () => {
    let calls = 0;
    const base = new ToolRegistry();
    base.register({
      name: "bulk_send",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: consequential,
      async run(input) {
        calls++;
        return { sentTo: input.target };
      },
    });
    const actionId = await makeAction();
    const scoped = new ScopedToolRegistry(base, { tenantId: SEED_TENANT_ID, domainActionId: actionId });

    const r1 = await scoped.callIdempotent("bulk_send", { target: "a@example.com" }, "recipient:a@example.com");
    const r2 = await scoped.callIdempotent("bulk_send", { target: "b@example.com" }, "recipient:b@example.com");
    const r3 = await scoped.callIdempotent("bulk_send", { target: "c@example.com" }, "recipient:c@example.com");
    expect(calls).toBe(3); // every target actually sent — none silently skipped as a "duplicate"
    expect([r1, r2, r3].every((r) => r.ok)).toBe(true);
  });

  it("concurrent calls for the same key: only one real invocation, proving the composite PK enforces atomicity", async () => {
    let calls = 0;
    const base = new ToolRegistry();
    base.register({
      name: "spy_tool3",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: consequential,
      async run() {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
        return { done: true };
      },
    });
    const actionId = await makeAction();
    const scopedA = new ScopedToolRegistry(base, { tenantId: SEED_TENANT_ID, domainActionId: actionId });
    const scopedB = new ScopedToolRegistry(base, { tenantId: SEED_TENANT_ID, domainActionId: actionId });

    // Both instances' FIRST call lands on the same operationKey ("spy_tool3:0") —
    // simulates two concurrent execute() calls for the same action.
    const results = await Promise.all([
      scopedA.callIdempotent("spy_tool3", { x: 1 }, "member:concurrent"),
      scopedB.callIdempotent("spy_tool3", { x: 1 }, "member:concurrent"),
    ]);
    expect(calls).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("a tool registry without idempotency scoping (base ToolRegistry) is unaffected — opt-in via ScopedToolRegistry only", async () => {
    let calls = 0;
    const base = new ToolRegistry();
    base.register({
      name: "spy_tool4",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: {
        effect: "read_only",
        retrySafety: "repeatable",
        idempotency: { mode: "inherently_idempotent" },
        verification: "none",
      },
      async run() {
        calls++;
        return {};
      },
    });
    await base.call("spy_tool4", {});
    await base.call("spy_tool4", {});
    expect(calls).toBe(2); // no ledger involved at all — today's behavior, unchanged
  });
});
