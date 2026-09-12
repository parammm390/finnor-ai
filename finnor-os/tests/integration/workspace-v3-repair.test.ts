import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_CONFIG, WorkspaceConfigSchema } from "../../apps/api/lib/workspace-config";
import { migrate } from "../../packages/db/migrate";
import { repairWorkspaceV3Rows } from "../../scripts/release/workspace-v3-repair";

const sourceUrl = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: sourceUrl, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const available = await canConnect();

describe.skipIf(!available)("Workspace V3 persisted data repair", () => {
  const database = `finnor_p8_workspace_${randomUUID().replaceAll("-", "_")}`;
  const targetUrl = (() => { const url = new URL(sourceUrl); url.pathname = `/${database}`; return url.toString(); })();
  const legacyTenant = randomUUID();
  const currentTenant = randomUUID();
  let admin: pg.Client;

  beforeAll(async () => {
    const source = new pg.Client({ connectionString: sourceUrl });
    await source.connect();
    try { await source.query(`CREATE DATABASE ${database}`); } finally { await source.end(); }
    await migrate(targetUrl);
    admin = new pg.Client({ connectionString: targetUrl });
    await admin.connect();
    await admin.query(
      "INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'Legacy Workspace'),($3,$4,'Current Workspace')",
      [legacyTenant, `legacy-${randomUUID()}`, currentTenant, `current-${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_settings(tenant_id,workspace_config) VALUES ($1,$2::jsonb),($3,$4::jsonb)`,
      [legacyTenant, JSON.stringify({
        version: 2,
        enabledSurfaces: ["home", "work", "customers", "schedule", "money", "agents"],
        terminology: { home: "Firm HQ", work: "Execution", customers: "Homeowners" },
        vocabulary: { homeowner: "Homeowner", technician: "Technician", invoice: "Invoice" },
        voiceEnabled: false,
        navigationPriority: ["agents", "customers", "home"],
        brand: { accent: "teal", mark: "PE", logoAssetKey: "legacy-water" },
        roles: { dispatcher: {}, technician: {} },
        extensions: { dispatch: true },
      }), currentTenant, JSON.stringify(DEFAULT_WORKSPACE_CONFIG)],
    );
  }, 120_000);

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
    const source = new pg.Client({ connectionString: sourceUrl });
    await source.connect();
    try { await source.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await source.end(); }
  });

  it("rewrites every invalid row to V3 without retaining Water semantics", async () => {
    const report = await repairWorkspaceV3Rows(targetUrl);
    expect(report).toEqual({ totalRows: 2, alreadyV3: 1, repaired: 1, verifiedV3: 2 });

    const result = await admin.query<{ workspace_config: unknown }>(
      "SELECT workspace_config FROM finnor_os.tenant_settings WHERE tenant_id=$1",
      [legacyTenant],
    );
    const repaired = WorkspaceConfigSchema.parse(result.rows[0]?.workspace_config);
    expect(repaired).toMatchObject({
      version: 3,
      enabledSurfaces: ["home", "work", "deals", "agents"],
      terminology: { home: "Firm HQ", work: "Execution", deals: "Deals", agents: "Agents" },
      voiceEnabled: false,
      navigationPriority: ["agents", "home", "deals", "work"],
      brand: { accent: "teal", mark: "PE", logoAssetKey: "finnor" },
    });
    expect(JSON.stringify(repaired)).not.toMatch(/customer|homeowner|technician|dispatcher|schedule|money|dispatch/i);
  });
});
