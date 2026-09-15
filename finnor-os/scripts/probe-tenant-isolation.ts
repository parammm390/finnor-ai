/*
 * Scheduled/manual tenant-isolation probe for the active Private Equity product.
 *
 * This is deliberately black-box: it authenticates as two real principals and
 * proves that a canonical root visible to tenant A cannot be resolved by tenant B.
 * No client-supplied tenant id is ever used as authority.
 */

type PeRoot = {
  entityType: "pe_strategy" | "pe_opportunity" | "pe_deal";
  entityId: string;
};

type RootResult = {
  rootRefs?: PeRoot[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/$/, "");
}

const stagingUrl = required("STAGING_API_URL");
const productionUrl = required("PRODUCTION_API_URL");
const tenantAJwt = required("TENANT_A_PROBE_JWT");
const tenantBJwt = required("TENANT_B_PROBE_JWT");
const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || null;

function headers(jwt: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${jwt}`,
    ...(json ? { "content-type": "application/json" } : {}),
    ...(vercelBypass ? {
      "x-vercel-protection-bypass": vercelBypass,
      "x-vercel-set-bypass-cookie": "true",
    } : {}),
  };
}

async function request(
  baseUrl: string,
  jwt: string,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const method = init.method ?? "GET";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(jwt, method !== "GET"),
    cache: "no-store",
    ...(method !== "GET" ? { body: JSON.stringify(init.body ?? {}) } : {}),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.trim()) {
    try { body = JSON.parse(text); }
    catch { body = text.slice(0, 1_000); }
  }
  return { status: response.status, body };
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rootResults(value: unknown): RootResult[] {
  const results = bodyRecord(value).results;
  return Array.isArray(results)
    ? results.filter((entry): entry is RootResult => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function rootsFrom(value: unknown): PeRoot[] {
  const roots = rootResults(value).flatMap((entry) => Array.isArray(entry.rootRefs) ? entry.rootRefs : []);
  const unique = new Map<string, PeRoot>();
  for (const root of roots) {
    if (!root || !["pe_strategy", "pe_opportunity", "pe_deal"].includes(root.entityType) || !UUID.test(root.entityId)) continue;
    unique.set(`${root.entityType}:${root.entityId}`, root);
  }
  return [...unique.values()];
}

function rootKey(root: PeRoot): string {
  return `${root.entityType}:${root.entityId}`;
}

async function assertAuthenticated(baseUrl: string, jwt: string, principal: string): Promise<void> {
  const result = await request(baseUrl, jwt, "/api/me");
  if (result.status !== 200) {
    throw new Error(`${principal} authentication probe failed with HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  }
}

async function rootsFor(baseUrl: string, jwt: string): Promise<{ status: number; body: unknown; roots: PeRoot[] }> {
  const result = await request(baseUrl, jwt, "/api/company-brain/roots", {
    method: "POST",
    body: { query: "", limit: 50 },
  });
  return { ...result, roots: result.status === 200 ? rootsFrom(result.body) : [] };
}

async function assertRootHidden(
  label: string,
  baseUrl: string,
  foreignJwt: string,
  root: PeRoot,
): Promise<void> {
  const result = await request(baseUrl, foreignJwt, "/api/company-brain/projection", {
    method: "POST",
    body: { root },
  });
  // 404/422 are both valid fail-closed outcomes: the foreign tenant either cannot
  // resolve the canonical object or does not have the PE vertical active. 401/403
  // are NOT accepted here because both principals were already required to pass /me;
  // seeing one now would make the isolation proof ambiguous rather than green.
  if (result.status === 200) {
    throw new Error(`${label}: CROSS-TENANT LEAK — foreign principal resolved ${rootKey(root)}`);
  }
  if (![404, 422].includes(result.status)) {
    throw new Error(`${label}: foreign projection returned unexpected HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  }
}

async function probeEnvironment(label: string, baseUrl: string): Promise<Record<string, unknown>> {
  await Promise.all([
    assertAuthenticated(baseUrl, tenantAJwt, `${label} tenant A`),
    assertAuthenticated(baseUrl, tenantBJwt, `${label} tenant B`),
  ]);

  const [a, b] = await Promise.all([
    rootsFor(baseUrl, tenantAJwt),
    rootsFor(baseUrl, tenantBJwt),
  ]);

  if (a.status !== 200) {
    throw new Error(`${label}: tenant A root discovery failed with HTTP ${a.status}: ${JSON.stringify(a.body)}`);
  }
  if (a.roots.length === 0) {
    throw new Error(`${label}: tenant A has no canonical PE root; isolation cannot be certified from an empty fixture`);
  }

  // A root must never appear in B's own discovery result when B is PE-enabled.
  if (b.status === 200) {
    const bKeys = new Set(b.roots.map(rootKey));
    const overlap = a.roots.map(rootKey).filter((key) => bKeys.has(key));
    if (overlap.length) throw new Error(`${label}: CROSS-TENANT LEAK — root discovery overlaps: ${overlap.join(", ")}`);
  } else if (b.status !== 422) {
    throw new Error(`${label}: tenant B root discovery returned unexpected HTTP ${b.status}: ${JSON.stringify(b.body)}`);
  }

  const aRoot = a.roots.find((root) => root.entityType === "pe_deal") ?? a.roots[0]!;
  await assertRootHidden(label, baseUrl, tenantBJwt, aRoot);

  // If B has its own PE root, prove the boundary in the opposite direction too.
  if (b.status === 200 && b.roots.length) {
    const bRoot = b.roots.find((root) => root.entityType === "pe_deal") ?? b.roots[0]!;
    await assertRootHidden(label, baseUrl, tenantAJwt, bRoot);
  }

  return {
    environment: label,
    tenantARoots: a.roots.length,
    tenantBRootStatus: b.status,
    tenantBRoots: b.roots.length,
    sampledTenantARoot: rootKey(aRoot),
    bidirectional: b.status === 200 && b.roots.length > 0,
  };
}

async function main(): Promise<void> {
  const results = [];
  for (const [label, baseUrl] of [["staging", stagingUrl], ["production", productionUrl]] as const) {
    results.push(await probeEnvironment(label, baseUrl));
  }
  console.log(JSON.stringify({ ok: true, invariant: "authenticated tenant A canonical roots are invisible to tenant B", results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
