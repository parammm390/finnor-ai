import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, configureTenantVertical, readableEmployeeWorkIds, receiveWork, workAggregate } from "@finnor/db";
import {
  companyBrainHistory,
  companyBrainObject,
  companyBrainProvenance,
  createStrategy,
  createDeal,
  attachWorkToDealGraph,
  listCompanyBrainRoots,
  loadCompanyBrainProjection,
  loadSemanticActivity,
  resolvePeOperatingContext,
  traverseCompanyBrain,
  type PeMutationContext,
} from "@finnor/private-equity";
import { migrate } from "../../packages/db/migrate";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const available = await canConnect();

describe.skipIf(!available)("Company Brain tenant isolation", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const ownerA = randomUUID();
  const peerA = randomUUID();
  const ownerB = randomUUID();
  const uniqueB = `Foreign-${randomUUID()}`;
  const ctxA: PeMutationContext = { auth: { tenantId: tenantA, userId: ownerA, employeeId: ownerA, role: "owner" }, provenance: { sourceSystem: "test:brain", createdBy: ownerA } };
  const ctxPeer: PeMutationContext = { auth: { tenantId: tenantA, userId: peerA, employeeId: peerA, role: "owner" }, provenance: { sourceSystem: "test:brain", createdBy: peerA } };
  const ctxB: PeMutationContext = { auth: { tenantId: tenantB, userId: ownerB, employeeId: ownerB, role: "owner" }, provenance: { sourceSystem: "test:brain", createdBy: ownerB } };
  let admin: pg.Client;
  let strategyA = "";
  let strategyB = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    await migrate(databaseUrl);
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'Brain A'),($3,$4,'Brain B')`,
      [tenantA, `brain-a-${randomUUID()}`, tenantB, `brain-b-${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES
       ($1,$2,$3,'owner','active','Brain Owner A'),($4,$5,$6,'owner','active','Brain Owner B'),($7,$2,$8,'owner','active','Brain Peer A')`,
      [ownerA, tenantA, `brain-a-${randomUUID()}@test.invalid`, ownerB, tenantB, `brain-b-${randomUUID()}@test.invalid`, peerA, `brain-peer-${randomUUID()}@test.invalid`],
    );
    await closePool();
    await configureTenantVertical({ tenantId: tenantA, verticalKey: "private_equity", expectedVersion: 0, createdBy: ownerA, sourceSystem: "test:brain" });
    await configureTenantVertical({ tenantId: tenantB, verticalKey: "private_equity", expectedVersion: 0, createdBy: ownerB, sourceSystem: "test:brain" });
    strategyA = String((await createStrategy(ctxA, { name: "Tenant A strategy" })).row.id);
    strategyB = String((await createStrategy(ctxB, { name: uniqueB })).row.id);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await admin?.end();
  });

  it("fails closed for direct root reads and tenant-scoped search", async () => {
    await expect(loadCompanyBrainProjection(ctxA, { root: { entityType: "pe_strategy", entityId: strategyB } }))
      .rejects.toMatchObject({ code: "PE_ENTITY_NOT_FOUND" });
    expect(await listCompanyBrainRoots(ctxA, { query: uniqueB })).toEqual([]);
    await expect(loadSemanticActivity(ctxA, { root: { entityType: "pe_strategy", entityId: strategyB } }))
      .rejects.toMatchObject({ code: "PE_ENTITY_NOT_FOUND" });
  });

  it("filters another employee's linked Work, instructions and evidence before Company Brain projection", async () => {
    // Two active employees can both inspect the same Deal, but sharing a Deal
    // is not permission to inspect each other's private Work attached to it.
    const companyId = randomUUID();
    await admin.query(
      "INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES ($1,$2,$3,'Brain Privacy Target','other')",
      [companyId, tenantA, `brain-privacy-${randomUUID()}`],
    );
    const created = await createDeal(ctxA, {
      targetOrganizationId: companyId, name: "Brain privacy acquisition",
      dealLeadEmployeeId: ownerA, signedLoiAt: new Date("2026-10-01T00:00:00Z"),
      targetClosingAt: new Date("2026-12-01T00:00:00Z"),
    });
    const dealId = String(created.row.id);
    const ownerSecret = `owner-private-work-${randomUUID()}`;
    const peerSecret = `peer-private-work-${randomUUID()}`;
    const mine = await receiveWork({ tenantId: tenantA, userId: ownerA, channel: "text", instruction: ownerSecret });
    const theirs = await receiveWork({ tenantId: tenantA, userId: peerA, channel: "text", instruction: peerSecret });
    for (const workId of [mine.workId, theirs.workId]) {
      await attachWorkToDealGraph(ctxA, {
        dealId, workId, entities: [{ entityType: "pe_deal", entityId: dealId, relationship: "about" }],
      });
    }

    // One bounded SQL read, identical participant predicate to canReadEmployeeWork.
    expect(await readableEmployeeWorkIds(tenantA, [mine.workId, theirs.workId], ownerA)).toEqual([mine.workId]);
    expect(await readableEmployeeWorkIds(tenantA, [mine.workId, theirs.workId], peerA)).toEqual([theirs.workId]);
    expect(await readableEmployeeWorkIds(tenantA, [mine.workId, theirs.workId], randomUUID())).toEqual([]);

    const root = { entityType: "pe_deal" as const, entityId: dealId };
    const ownerGraph = await loadCompanyBrainProjection(ctxA, { root });
    const peerGraph = await loadCompanyBrainProjection(ctxPeer, { root });
    const hasWork = (graph: typeof ownerGraph, id: string) => graph.nodes.some(node => node.ref.type === "work" && node.ref.id === id);
    expect(hasWork(ownerGraph, mine.workId)).toBe(true);
    expect(hasWork(ownerGraph, theirs.workId)).toBe(false);
    expect(hasWork(peerGraph, theirs.workId)).toBe(true);
    expect(hasWork(peerGraph, mine.workId)).toBe(false);
    expect(JSON.stringify(ownerGraph)).not.toContain(peerSecret);
    expect(JSON.stringify(ownerGraph)).not.toContain(theirs.workId);
    expect(JSON.stringify(peerGraph)).not.toContain(ownerSecret);
    expect(JSON.stringify(peerGraph)).not.toContain(mine.workId);
    // Raw Work remains canonical and unchanged. This is a read visibility
    // boundary, not a destructive migration or projection rewrite.
    expect((await workAggregate(tenantA, mine.workId))?.work.initialInstruction).toBe(ownerSecret);
    expect((await workAggregate(tenantA, theirs.workId))?.work.initialInstruction).toBe(peerSecret);
  });

  it("cannot traverse, resolve provenance/history, or inspect a foreign ref", async () => {
    const projection = await loadCompanyBrainProjection(ctxA, { root: { entityType: "pe_strategy", entityId: strategyA } });
    const foreignRef = { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_strategy", id: strategyB } as const;
    expect(companyBrainObject(projection, foreignRef)).toBeNull();
    expect(() => traverseCompanyBrain(projection, foreignRef)).toThrow(/authenticated root projection/);
    expect(() => companyBrainProvenance(projection, foreignRef)).toThrow(/authenticated root projection/);
    await expect(companyBrainHistory(ctxA, { root: projection.root, ref: foreignRef })).rejects.toMatchObject({ code: "PE_ENTITY_NOT_FOUND" });
    expect(() => resolvePeOperatingContext(projection, { root: projection.root, selectedObject: foreignRef, workId: null })).toThrow(/not related/);
  });
});
