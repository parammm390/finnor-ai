import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { migrate } from "../../packages/db/migrate";
import { closePool, receiveWork, tenants, users, withTenant, works } from "@finnor/db";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const API = join(process.cwd(), "apps/api/app/api");
const TENANT = randomUUID();
const OWNER = randomUUID();
const PEER = randomUUID();
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// Every route under these directories names a Work or an instruction in its path.
// A same-tenant employee with no relationship to it must get exactly the answer
// a missing id gets, and must change nothing.
const FAMILIES = { "works/[id]": "work", "instructions/[id]": "instruction" } as const;

// A write route must pass its body schema before its access check can run.
const BODIES: Record<string, unknown> = {
  "POST works/[id]/objective": { command: "interrupt" },
  "POST works/[id]/retry": { idempotencyKey: "foreign-employee-probe" },
  "POST works/[id]/handoff": { targetEmployeeId: PEER },
  "POST instructions/[id]/cancel": {},
};

type Handler = (req: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

function routes(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? routes(join(directory, entry.name))
    : entry.name === "route.ts" ? [join(directory, entry.name)] : []);
}

const families = Object.entries(FAMILIES).map(([family, kind]) => ({
  kind, routes: routes(join(API, family)).map(file => ({ file, path: relative(API, file).replace(/\/route\.ts$/, "") })),
}));

async function databaseAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

async function call(handler: Handler, method: string, path: string, id: string, employee: string) {
  const body = BODIES[`${method} ${path}`];
  if (method !== "GET" && body === undefined) throw new Error(`Add a valid ${method} body for ${path} to BODIES so its access check runs.`);
  const response = await handler(new Request(`http://localhost/api/${path.replace("[id]", id)}`, {
    method,
    headers: { "content-type": "application/json", "x-tenant-id": TENANT, "x-user-id": employee, "x-user-role": "owner" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  }), { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json().catch(() => null) as unknown };
}

async function workState(workId: string) {
  const [row] = await withTenant(TENANT, db => db.select().from(works).where(eq(works.id, workId)));
  const [counts] = await withTenant(TENANT, db => db.execute<{ events: number; inputs: number; actions: number; instructionEvents: number }>(sql`
    SELECT (SELECT count(*)::int FROM finnor_os.work_events WHERE work_id=${workId}) AS events,
           (SELECT count(*)::int FROM finnor_os.work_inputs WHERE work_id=${workId}) AS inputs,
           (SELECT count(*)::int FROM finnor_os.domain_actions WHERE work_id=${workId}) AS actions,
           (SELECT count(*)::int FROM finnor_os.instruction_events e JOIN finnor_os.work_inputs i ON i.instruction_id=e.instruction_id WHERE i.work_id=${workId}) AS "instructionEvents"`).then(result => result.rows));
  return { row, counts };
}

const available = await databaseAvailable();

describe.skipIf(!available)("a Work or instruction id is not access to it", () => {
  const owned = { workId: "", instructionId: randomUUID() };

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT, db => db.insert(tenants).values({ id: TENANT, name: "Employee Work visibility" }));
    await withTenant(TENANT, db => db.insert(users).values([
      { id: OWNER, tenantId: TENANT, role: "owner", email: `visibility-owner-${OWNER}@example.test` },
      { id: PEER, tenantId: TENANT, role: "owner", email: `visibility-peer-${PEER}@example.test` },
    ]));
    owned.workId = (await receiveWork({ tenantId: TENANT, instruction: "Private Work", instructionId: owned.instructionId, channel: "text", userId: OWNER })).workId;
  });

  afterAll(async () => { await closePool(); });

  it("discovers every route in both families", () => {
    expect(families.flatMap(family => family.routes.map(route => route.path)).sort()).toEqual(expect.arrayContaining([
      "instructions/[id]", "instructions/[id]/cancel", "instructions/[id]/events",
      "works/[id]", "works/[id]/execution", "works/[id]/handoff", "works/[id]/objective", "works/[id]/replay", "works/[id]/retry",
    ]));
  });

  for (const family of families) for (const route of family.routes) {
    it(`${route.path} answers a foreign employee exactly as it answers a missing id`, async () => {
      const module = await import(route.file) as Partial<Record<(typeof METHODS)[number], Handler>>;
      const handlers = METHODS.flatMap(method => module[method] ? [[method, module[method]!] as const] : []);
      expect(handlers.length).toBeGreaterThan(0);
      const id = family.kind === "work" ? owned.workId : owned.instructionId;
      for (const [method, handler] of handlers) {
        const before = await workState(owned.workId);
        const foreign = await call(handler, method, route.path, id, PEER);
        const missing = await call(handler, method, route.path, randomUUID(), PEER);
        expect({ method, ...foreign }, `${method} /api/${route.path} must not reveal that the id exists`).toEqual({ method, ...missing });
        expect(foreign.status, `${method} /api/${route.path}`).toBe(404);
        expect(await workState(owned.workId), `${method} /api/${route.path} changed another employee's Work`).toEqual(before);
        if (method === "GET") expect(await call(handler, method, route.path, id, OWNER), `${method} /api/${route.path} must still answer its owner`).not.toEqual(missing);
      }
    });
  }
});
