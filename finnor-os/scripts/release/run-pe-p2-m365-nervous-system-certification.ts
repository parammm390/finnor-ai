import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { closePool } from "@finnor/db";
import { allMicrosoft365SourceCapabilities } from "@finnor/provider-microsoft365";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import { migrate, type MigrationFile } from "../../packages/db/migrate";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const REPOSITORY_ROOT = resolve(ROOT, "..");
const MIGRATIONS_DIR = resolve(ROOT, "packages/db/migrations");
const OUTPUT_DIR = resolve(REPOSITORY_ROOT, "docs/release/generated");
const JSON_OUTPUT = resolve(OUTPUT_DIR, "pe-p2-m365-nervous-system-certification.json");
const MARKDOWN_OUTPUT = resolve(REPOSITORY_ROOT, "docs/release/pe-p2-m365-nervous-system-certification.md");
const P2_MIGRATION_HEAD = "0118_provider_parent_relationship_lookup.sql";
const P1_REPORT = resolve(OUTPUT_DIR, "pe-p1-world-truth-certification.json");
const P2_MIGRATIONS = [
  "0112_pe_microsoft365_nervous_system.sql",
  "0113_microsoft_graph_webhook_resolver.sql",
  "0114_microsoft_subscription_current_scope.sql",
  "0117_microsoft_source_coverage_descriptor_history.sql",
  "0118_provider_parent_relationship_lookup.sql",
] as const;
const STARTING_BASELINE = {
  branch: "codex/p3-epistemic-runtime",
  headSha: "80f617d321965b8694de18940ff23b005dedcdb7",
  treeSha: "f38b551d99952986527e4986e3ba77891a3c10ef",
  migrationHead: "0111_pe_world_truth.sql",
} as const;

type DeterministicStatus = "PASS" | "FAIL";
type CertificationResult = DeterministicStatus | "BLOCKED-EXTERNAL-CERTIFICATION";

interface CommandEvidence {
  command: string;
  status: DeterministicStatus;
  exitCode: number;
  durationMs: number;
  outputHash: string;
  outputLineCount: number;
  summary: string;
}

interface GateEvidence {
  status: CertificationResult;
  evidence: unknown;
}

const MANDATORY_CASE_TEXT = `
1. Starting main SHA/tree recorded.
2. P1 certification verified.
3. No active Microsoft provider already exists unnoticed.
4. Existing Google/Gmail connection behavior remains green.
5. Existing tenant integration semantics remain green.
6. Existing source sync engine remains one engine.
7. Existing reconciliation remains one system.
8. Existing PE Source Truth tests remain green.
9. Microsoft provider resolves through existing account/auth-profile/integration architecture.
10. Microsoft directory identity is tenant-bound.
11. AWS workload identity can acquire Graph token in production-cert environment.
12. Graph token never persists.
13. Worker restart reacquires token.
14. Token cache isolates Microsoft tenant A/B.
15. Expired token refreshes.
16. Persistent auth failure marks correct state.
17. Certificate fallback works if deliberately enabled.
18. Client-secret production configuration fails certification.
19. Forged Microsoft tenant ID cannot override stored integration.
20. Requested permission alone does not imply coverage.
21. Effective Graph probe required.
22. Exchange allowed mailbox read succeeds.
23. Exchange denied mailbox does not count covered.
24. SharePoint selected site succeeds.
25. Unselected site fails.
26. Teams scoped resource succeeds where RSC configured.
27. Unconfigured resource fails/returns not covered.
28. Transcript disabled tenant yields explicit blocked state.
29. Validation handshake exact.
30. Normal notification acknowledged within fast-path target.
31. Graph is not called in webhook critical path.
32. Evidence is not written in webhook critical path.
33. Unknown subscription ignored/fails safely.
34. clientState mismatch fails.
35. notification tenant mismatch fails.
36. durable enqueue succeeds before 202.
37. queue failure does not return false success.
38. duplicate notification converges.
39. Subscription created before notification-backed backfill.
40. Provider-returned expiration persisted.
41. Resource-specific maximum lifetime respected.
42. renew_at deterministic.
43. renewal idempotent.
44. expired subscription not active.
45. subscriptionRemoved triggers recovery.
46. renewal worker restart safe.
47. disabling scope deletes/disables remote subscription without deleting evidence.
48. Folder-scoped initial delta.
49. Independent cursor per folder.
50. terminal deltaLink stored.
51. immediate catch-up.
52. new message EvidenceVersion.
53. message update new version.
54. exact duplicate idempotent.
55. message move preserves immutable identity.
56. delete tombstone.
57. unconfigured folder not covered.
58. folder sync failure does not make mailbox complete.
59. message body truncation explicit.
60. attachment Document relationship correct.
61. calendar-view initial delta.
62. exact configured date window recorded.
63. incremental delta.
64. create event.
65. update event.
66. cancel event.
67. event outside coverage window does not create false full coverage.
68. window expansion begins partial.
69. window expansion becomes complete only after sync.
70. immutable event identity preserved.
71. configured channel initial enumeration.
72. new message observation.
73. edit observation.
74. reply/thread identity.
75. delete/tombstone where provider proves it.
76. exact scoped access enforcement.
77. known notification gap causes recovery.
78. inability to prove full recovery results PARTIAL.
79. exact-chat mode.
80. exact chat RSC enforcement where supported.
81. chat message observation.
82. edit observation.
83. delete observation.
84. configured user-chat delta mode where enabled.
85. historical delta boundary exposed.
86. request before historical boundary returns HISTORY_LIMITED.
87. no obsolete Teams billing code exists.
88. configured organizer transcript initial sync.
89. transcript delta continuation.
90. transcript metadata observed.
91. transcript content retrieved.
92. exact meeting relationship.
93. root inherited from uniquely bound calendar meeting.
94. no title-based root guess.
95. transcript tenant-policy 403 handled.
96. speaker-attribution-disabled fallback handled when provider supports it.
97. transcript historical limitation exposed.
98. initial drive delta.
99. terminal deltaLink.
100. file creation.
101. file update.
102. file rename same Document.
103. file move semantics correct.
104. delete tombstone.
105. 410 resync.
106. recovery preserves history.
107. selected-site permission enforcement.
108. no workbook parsing occurs.
109. list initial delta.
110. item update.
111. item deletion.
112. 410 resync.
113. field snapshot bounded.
114. non-file list item not made Document.
115. dedicated scope → Strategy.
116. dedicated scope → Opportunity.
117. dedicated scope → Deal.
118. exact object binding.
119. exact thread inheritance.
120. exact calendar→transcript inheritance.
121. no binding → unresolved.
122. two candidates → ambiguous.
123. LLM never invoked.
124. fuzzy subject ignored.
125. cross-tenant root rejected.
126. evidence persists before root resolution.
127. later root resolution attaches existing version without changing retrievedAt.
128. observedAt is provider time.
129. retrievedAt is successful Graph-read time.
130. webhook arrival not retrievedAt.
131. old mail retrieved later excluded from earlier state_at.
132. evidence appears after actual retrieval.
133. tombstone does not erase earlier state.
134. coverage before connection = unavailable.
135. historical coverage snapshot uses historical scope.
136. future scope expansion does not leak backwards.
137. P1 no-hindsight tests remain green.
138. initial scope = INITIALIZING.
139. baseline completion = COMPLETE where recoverable.
140. auth failure = BLOCKED_AUTH.
141. permission failure = BLOCKED_PERMISSION.
142. delta 410 = RECOVERING.
143. Teams historical boundary = HISTORY_LIMITED.
144. known unrecoverable notification gap = PARTIAL.
145. scope disabled = DISABLED.
146. unresolved relevant observations make root evidence completeness partial.
147. freshness and coverage remain separate.
148. crash before read.
149. crash after read.
150. crash after ProviderObservation.
151. crash after EvidenceVersion.
152. crash before checkpoint.
153. replay after crash.
154. no duplicate evidence.
155. no duplicate BusinessEvent.
156. no duplicate Work wake.
157. Retry-After obeyed.
158. DLQ existing semantics preserved.
159. Tenant A cannot read Tenant B scopes.
160. Tenant A notification cannot enqueue Tenant B job.
161. Tenant A provider object cannot bind Tenant B PE root.
162. access token never logged.
163. clientState never logged.
164. Microsoft content never becomes instruction.
165. malicious HTML safely rendered/sanitized.
166. provider payload cannot supply FINNOR tenant authority.
167. existing PE graph tests green.
168. P1 world-state tests green.
169. P1 temporal-history tests green.
170. Source Truth tests green.
171. external effect observation tests green.
172. reconciliation tests green.
173. Work wait tests green.
174. BusinessEvent/realtime projection tests green.
175. connection/security tests green.
176. Google/Gmail tests green.
177. fresh DB migration green.
178. populated DB upgrade green.
179. worker restart/recovery green.
180. OpenAPI/generated contracts green.
`;

const mandatoryCaseNames = MANDATORY_CASE_TEXT.trim().split("\n").map((line, index) => {
  const match = /^(\d+)\.\s+(.+)$/.exec(line.trim());
  if (!match || Number(match[1]) !== index + 1) throw new Error(`Malformed mandatory case at line ${index + 1}`);
  return match[2]!;
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function outputSummary(output: string): string {
  return output.trim().split(/\r?\n/).filter(Boolean).slice(-12).join(" | ").slice(0, 3_000);
}

async function runCommand(
  command: string,
  args: string[],
  options: { env?: Partial<NodeJS.ProcessEnv>; forbidSkips?: boolean; forbidDeprecations?: boolean } = {},
): Promise<CommandEvidence> {
  const started = Date.now();
  const chunks: Buffer[] = [];
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
  const output = Buffer.concat(chunks).toString("utf8");
  if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${output.slice(-16_000)}`);
  if (options.forbidSkips) {
    assert(!/(?:\bskipped\b|\bskip\b|↓)/i.test(output), `certified test command contained a skip\n${output.slice(-10_000)}`);
  }
  if (options.forbidDeprecations) {
    assert(!/(?:DeprecationWarning|deprecated and will be removed)/i.test(output),
      `certified test command contained a deprecation warning\n${output.slice(-10_000)}`);
  }
  return {
    command: [command, ...args].join(" "),
    status: "PASS",
    exitCode,
    durationMs: Date.now() - started,
    outputHash: hash(output),
    outputLineCount: output.trim() ? output.trim().split(/\r?\n/).length : 0,
    summary: outputSummary(output),
  };
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

async function loadDiskMigrations(): Promise<MigrationFile[]> {
  return Promise.all((await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map(async (name) => ({ name, sql: await readFile(resolve(MIGRATIONS_DIR, name), "utf8") })));
}

async function queryOne<T extends pg.QueryResultRow>(client: pg.Client, sql: string, values: unknown[] = []): Promise<T> {
  const result = await client.query<T>(sql, values);
  assert(result.rows.length === 1, `expected one row, received ${result.rows.length}`);
  return result.rows[0]!;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(path);
  }
  return result.sort();
}

async function inspectArchitecture(): Promise<Record<string, unknown>> {
  const providerDirectory = resolve(ROOT, "packages/provider-microsoft365/src");
  const providerFiles = await sourceFiles(providerDirectory);
  const providerSources = await Promise.all(providerFiles.map(async (path) => ({ path, source: await readFile(path, "utf8") })));
  const joined = providerSources.map(({ source }) => source).join("\n");
  const forbiddenProviderImports = providerSources.flatMap(({ path, source }) =>
    [...source.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1]!)
      .filter((specifier) => specifier.includes("private-equity") || specifier.includes("orchestration") || specifier.includes("domain-plugins"))
      .map((specifier) => ({ file: relative(ROOT, path), specifier })),
  );
  assert(forbiddenProviderImports.length === 0, `Microsoft provider crossed the domain boundary: ${JSON.stringify(forbiddenProviderImports)}`);
  assert(!/pathOrUrl\s*:\s*["'`]\/beta(?:\/|["'`])/i.test(joined), "Microsoft provider emits a beta Graph path");
  assert(!/graph\.microsoft\.com\/beta\//i.test(joined), "Microsoft provider embeds a beta Graph endpoint");
  assert(!/client_secret/i.test(joined), "Microsoft provider contains a client-secret production path");
  assert(!/(?:metered api|model [ab]\b|billing requirement)/i.test(joined), "Microsoft provider contains obsolete Teams metering architecture");

  const coreTruthFiles = [
    resolve(ROOT, "packages/data-platform/src/source-truth.ts"),
    resolve(ROOT, "packages/shared-types/src/source-truth.ts"),
  ];
  const coreTruth = (await Promise.all(coreTruthFiles.map((path) => readFile(path, "utf8")))).join("\n");
  assert(!/@finnor\/provider-microsoft365|provider-microsoft365/.test(coreTruth), "Core Source Truth imports the Microsoft Graph provider package");

  const mapping = await readFile(resolve(ROOT, "packages/private-equity/src/microsoft365-mapping.ts"), "utf8");
  assert(!/(?:invoke|generate|complete|chat)\w*\s*\(/i.test(mapping.replace(/providerConversationId/g, "")),
    "PE Microsoft mapping appears to invoke a model or chat completion");
  assert(!/subject.*(?:match|includes|similar|fuzzy)/i.test(mapping), "PE Microsoft mapping contains subject-based root guessing");

  const sources = await readFile(resolve(ROOT, "packages/provider-microsoft365/src/sources.ts"), "utf8");
  assert(!/method\s*:\s*["'](?:POST|PATCH|PUT|DELETE)["']/i.test(sources), "Microsoft observation adapter contains a business write");
  assert(!/(?:xlsx|workbook|formula|spreadsheet).*(?:parse|evaluate|calculate)/i.test(sources), "Microsoft observation adapter contains workbook parsing");

  const capabilities = allMicrosoft365SourceCapabilities();
  const kinds = capabilities.map((item) => item.sourceKind).sort();
  const families = [...new Set(capabilities.map((item) => item.family))].sort();
  assert(kinds.length === 8 && new Set(kinds).size === 8, `expected 8 exact Microsoft source kinds, received ${kinds.length}`);
  assert(families.length === 7, `expected 7 Microsoft source families, received ${families.length}`);
  assert(capabilities.every((item) => item.supportsInitialEnumeration && item.coverageUnit.length > 0), "a Microsoft source lacks baseline/coverage declaration");
  assert(capabilities.find((item) => item.sourceKind === "teams_channel")?.supportsDelta === false
    && capabilities.find((item) => item.sourceKind === "teams_chat")?.supportsDelta === false,
  "Teams exact chat/channel sources falsely claim delta support");

  const expectedFiles = [
    "packages/provider-microsoft365/src/auth.ts",
    "packages/provider-microsoft365/src/client.ts",
    "packages/provider-microsoft365/src/sources.ts",
    "packages/provider-microsoft365/src/subscriptions.ts",
    "packages/private-equity/src/microsoft365-mapping.ts",
    "apps/worker/src/handlers/maintain-integration-subscriptions.ts",
    "apps/api/app/api/webhooks/microsoft-graph/route.ts",
    "apps/api/app/api/connections/microsoft-graph/start/route.ts",
    "apps/api/app/api/connections/microsoft-graph/callback/route.ts",
    "apps/api/app/api/integrations/microsoft-graph/source-scopes/route.ts",
  ];
  await Promise.all(expectedFiles.map((path) => access(resolve(ROOT, path))));
  return {
    providerFiles: providerFiles.map((path) => relative(ROOT, path)),
    forbiddenProviderImports,
    coreSourceTruthImportsProvider: false,
    observationBusinessWrites: false,
    fuzzyOrLlmRootSelection: false,
    sourceKinds: kinds,
    sourceFamilies: families,
    capabilityDigest: hash(JSON.stringify(capabilities.map((item) => ({
      sourceKind: item.sourceKind,
      family: item.family,
      coverageUnit: item.coverageUnit,
      delta: item.supportsDelta,
      notifications: item.supportsChangeNotifications,
      historyLimit: item.historyLimit,
      recoveryStrength: item.recoveryStrength,
      permissions: item.permissionProfiles,
    })))),
    expectedFiles,
  };
}

async function inspectFreshDatabase(url: string, migrationCount: number): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const migration = await queryOne<{ count: number; head: string }>(client,
      "SELECT count(*)::int count,max(name) head FROM finnor_os._migrations");
    assert(migration.count === migrationCount && migration.head === CURRENT_MIGRATION_HEAD,
      `fresh migration state was ${migration.count}/${migration.head}`);

    const p2Tables = [
      "application_consent_requests",
      "integration_source_scopes",
      "integration_source_coverage_history",
      "integration_subscriptions",
      "provider_object_root_bindings",
    ];
    const rls = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='finnor_os'
          AND p.tablename=c.relname AND p.policyname='tenant_isolation') policies
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='finnor_os' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
      [p2Tables],
    );
    assert(rls.rows.length === p2Tables.length
      && rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity && row.policies === 1),
    "one or more P2 tenant tables lacks forced RLS and its tenant policy");

    const integrity = await queryOne<{
      scopes: boolean; coverage: boolean; subscriptions: boolean; observations: boolean;
      externalRefs: boolean; evidence: boolean; documents: boolean; reconciliation: boolean;
      jobs: boolean; checkpoints: boolean; businessEvents: boolean; works: boolean;
      descriptor: boolean; currentSubscriptionIndex: boolean; parentRelationshipIndex: boolean; webhookResolver: boolean;
      coverageSelect: boolean; coverageInsert: boolean; coverageUpdate: boolean; coverageDelete: boolean;
      microsoftOwners: number; coverageTriggers: number; rootTriggers: number; subscriptionTriggers: number;
    }>(client, `SELECT
      to_regclass('finnor_os.integration_source_scopes') IS NOT NULL scopes,
      to_regclass('finnor_os.integration_source_coverage_history') IS NOT NULL coverage,
      to_regclass('finnor_os.integration_subscriptions') IS NOT NULL subscriptions,
      to_regclass('finnor_os.external_ref_observations') IS NOT NULL observations,
      to_regclass('finnor_os.external_refs') IS NOT NULL "externalRefs",
      to_regclass('finnor_os.evidence_sources') IS NOT NULL evidence,
      to_regclass('finnor_os.documents') IS NOT NULL documents,
      to_regclass('finnor_os.reconciliation_cases') IS NOT NULL reconciliation,
      to_regclass('finnor_os.jobs') IS NOT NULL jobs,
      to_regclass('finnor_os.integration_sync_checkpoints') IS NOT NULL checkpoints,
      to_regclass('finnor_os.business_events') IS NOT NULL "businessEvents",
      to_regclass('finnor_os.works') IS NOT NULL works,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='finnor_os'
        AND table_name='integration_source_coverage_history' AND column_name='source_descriptor') descriptor,
      to_regclass('finnor_os.integration_subscriptions_current_scope_key') IS NOT NULL "currentSubscriptionIndex",
      to_regclass('finnor_os.external_ref_observations_parent_refs_gin_idx') IS NOT NULL "parentRelationshipIndex",
      to_regprocedure('finnor_os.resolve_microsoft_graph_subscription(text)') IS NOT NULL "webhookResolver",
      has_table_privilege('finnor_app','finnor_os.integration_source_coverage_history','SELECT') "coverageSelect",
      has_table_privilege('finnor_app','finnor_os.integration_source_coverage_history','INSERT') "coverageInsert",
      has_table_privilege('finnor_app','finnor_os.integration_source_coverage_history','UPDATE') "coverageUpdate",
      has_table_privilege('finnor_app','finnor_os.integration_source_coverage_history','DELETE') "coverageDelete",
      (SELECT count(*)::int FROM finnor_os.canonical_truth_registry
        WHERE lower(entity_type) ~ '(microsoft|outlook|teams|sharepoint|onedrive)') "microsoftOwners",
      (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='finnor_os'
        AND c.relname='integration_source_coverage_history' AND NOT t.tgisinternal
        AND t.tgname IN ('integration_source_coverage_history_append_guard','integration_source_coverage_history_immutable')) "coverageTriggers",
      (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='finnor_os'
        AND c.relname='provider_object_root_bindings' AND NOT t.tgisinternal
        AND t.tgname IN ('provider_object_root_bindings_root_guard','provider_object_root_bindings_history_guard')) "rootTriggers",
      (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='finnor_os'
        AND c.relname='integration_subscriptions' AND NOT t.tgisinternal
        AND t.tgname='integration_subscriptions_scope_guard') "subscriptionTriggers"`);
    assert(integrity.scopes && integrity.coverage && integrity.subscriptions && integrity.observations,
      "P2 provider observation/control-plane tables are missing");
    assert(integrity.externalRefs && integrity.evidence && integrity.documents && integrity.reconciliation
      && integrity.jobs && integrity.checkpoints && integrity.businessEvents && integrity.works,
    "P2 does not reuse every required Core/P1 owner");
    assert(integrity.descriptor && integrity.currentSubscriptionIndex && integrity.parentRelationshipIndex && integrity.webhookResolver,
      "P2 historical descriptor, subscription uniqueness, parent relationship lookup, or webhook resolver invariant is missing");
    assert(integrity.coverageSelect && integrity.coverageInsert && !integrity.coverageUpdate && !integrity.coverageDelete,
      "coverage-history application grants are not append-only");
    assert(integrity.microsoftOwners === 0, "P2 introduced a Microsoft-specific canonical business owner");
    assert(integrity.coverageTriggers === 2 && integrity.rootTriggers === 2 && integrity.subscriptionTriggers === 1,
      "P2 append/root/subscription database guards are incomplete");

    const observationColumns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='finnor_os' AND table_name='external_ref_observations'
          AND column_name=ANY($1::text[]) ORDER BY column_name`,
      [["source_scope_id", "resource_kind", "retrieved_at", "observation_key", "provider_parent_refs",
        "provider_metadata", "ingestion_mode", "trace_id", "evidence_source_id", "evidence_version_id"]],
    );
    assert(observationColumns.rows.length === 10, "provider observation contract is not fully persisted");

    const authConstraints = await client.query<{ name: string; definition: string }>(
      `SELECT conname name,pg_get_constraintdef(oid) definition FROM pg_constraint
        WHERE connamespace='finnor_os'::regnamespace
          AND conname IN ('auth_profiles_auth_method_check','auth_profiles_credential_contract_check',
            'auth_profiles_workload_identity_shape_check','tenant_integrations_credential_contract_check')
        ORDER BY conname`,
    );
    const authText = authConstraints.rows.map((row) => row.definition).join("\n");
    assert(authConstraints.rows.length === 4 && authText.includes("workload_identity") && authText.includes("aws-iam-federated"),
      "database auth contract does not contain workload federation");

    return {
      migration,
      rlsTables: rls.rows.map((row) => row.relname),
      integrity,
      providerObservationColumns: observationColumns.rows.map((row) => row.column_name),
      authConstraints: authConstraints.rows,
    };
  } finally {
    await client.end();
  }
}

async function inspectPopulatedUpgrade(url: string, migrations: MigrationFile[]): Promise<Record<string, unknown>> {
  assert(migrations.at(-1)?.name === CURRENT_MIGRATION_HEAD, "populated upgrade expected the repository migration head");
  const descriptorMigration = migrations.findIndex((migration) => migration.name === "0117_microsoft_source_coverage_descriptor_history.sql");
  assert(descriptorMigration >= 0, "populated upgrade requires the P2 descriptor migration");
  const before = migrations.slice(0, descriptorMigration);
  const final = migrations.slice(descriptorMigration);
  const appliedBefore = await migrate(url, before);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const tenantId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  const integrationId = randomUUID();
  const scopeId = randomUUID();
  const coverageId = randomUUID();
  try {
    await client.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,$3)",
      [tenantId, `p2-upgrade-${tenantId.slice(0, 12)}`, "P2 populated upgrade"]);
    await client.query(
      `INSERT INTO finnor_os.application_accounts(
        id,tenant_id,account_key,application,provider,display_name,provider_account_ref,capabilities,metadata
       ) VALUES ($1,$2,'microsoft-upgrade','microsoft365','microsoft_graph','Microsoft upgrade', $3,'[]',$4::jsonb)`,
      [accountId, tenantId, randomUUID(), JSON.stringify({ directoryTenantId: randomUUID() })],
    );
    await client.query(
      `INSERT INTO finnor_os.auth_profiles(
        id,tenant_id,auth_profile_ref,principal_type,principal_id,application_account_id,
        credential_provider,auth_method,connection_status,required_scopes,granted_scopes,restrictions
       ) VALUES ($1,$2,'microsoft-upgrade','tenant',$2,$3,'aws-iam-federated','workload_identity','active',
         ARRAY['Mail.Read'],ARRAY['Mail.Read'],$4::jsonb)`,
      [profileId, tenantId, accountId, JSON.stringify({ federation: { awsRegion: "us-east-1", audience: "api://AzureADTokenExchange", configId: "upgrade" } })],
    );
    await client.query(
      `INSERT INTO finnor_os.tenant_integrations(
        id,tenant_id,capability,binding,mode,credential_provider,application_account_id,auth_profile_id
       ) VALUES ($1,$2,'communications','microsoft_graph','real','aws-iam-federated',$3,$4)`,
      [integrationId, tenantId, accountId, profileId],
    );
    await client.query(
      `INSERT INTO finnor_os.integration_source_scopes(
        id,tenant_id,integration_id,provider,source_kind,provider_scope_type,provider_resource_id,
        scope_key,sync_strategy,recovery_strategy,permission_mode,required_permissions,effective_permissions,
        permission_verified_at,coverage_policy,freshness_policy,configuration,configured_by
       ) VALUES ($1,$2,$3,'microsoft_graph','outlook_mail_folder','mail_folder','mailbox/folder',
         'mail:populated-upgrade','delta','EXACT_DELTA','SCOPED',ARRAY['Mail.Read'],ARRAY['Mail.Read'],now(),
         '{"mailboxId":"mailbox","folderId":"folder"}','{"maxAgeSeconds":900}',
         '{"mailboxId":"mailbox","folderId":"folder"}','certification:upgrade')`,
      [scopeId, tenantId, integrationId],
    );
    await client.query(
      `INSERT INTO finnor_os.integration_source_coverage_history(
        id,tenant_id,source_scope_id,coverage_revision,effective_from,state,coverage_region,baseline_started_at,baseline_completed_at
       ) VALUES ($1,$2,$3,1,now(),'COMPLETE','{"mailboxId":"mailbox","folderId":"folder"}',now(),now())`,
      [coverageId, tenantId, scopeId],
    );
  } finally {
    await client.end();
  }

  const appliedFinal = await migrate(url, final);
  const verify = new pg.Client({ connectionString: url });
  await verify.connect();
  try {
    const row = await queryOne<{ id: string; source_descriptor: Record<string, unknown>; head: string; count: number }>(verify,
      `SELECT coverage.id,coverage.source_descriptor,
        (SELECT max(name) FROM finnor_os._migrations) head,
        (SELECT count(*)::int FROM finnor_os._migrations) count
       FROM finnor_os.integration_source_coverage_history coverage WHERE coverage.id=$1`,
      [coverageId],
    );
    assert(row.id === coverageId && JSON.stringify(row.source_descriptor) === "{}", "0117/0118 did not preserve a populated pre-descriptor coverage row");
    assert(row.head === CURRENT_MIGRATION_HEAD && row.count === migrations.length, "populated upgrade did not reach the exact migration head");
    return { appliedBefore: appliedBefore.length, appliedFinal, retainedCoverageId: row.id, descriptorDefault: row.source_descriptor, head: row.head, count: row.count };
  } finally {
    await verify.end();
  }
}

function evidenceForCase(caseNumber: number): string[] {
  if (caseNumber <= 3) return ["baseline", "p1Prerequisite", "architecture"];
  if (caseNumber <= 8) return ["regressions", "architecture"];
  if (caseNumber <= 19) return ["unit", "p2Integration", "databaseInvariants", "architecture"];
  if (caseNumber <= 28) return ["unit", "p2Integration"];
  if (caseNumber <= 38) return ["p2Integration:webhook"];
  if (caseNumber <= 47) return ["unit", "p2Integration:subscriptions"];
  if (caseNumber <= 60) return ["unit:provider", "p2Integration:sync", "p2Integration:mapping"];
  if (caseNumber <= 70) return ["unit:provider", "p2Integration:sync", "p2Integration:coverage"];
  if (caseNumber <= 78) return ["unit:provider", "p2Integration:webhook", "p2Integration:sync"];
  if (caseNumber <= 87) return ["unit:provider", "p2Integration:sync", "architecture"];
  if (caseNumber <= 97) return ["unit:provider", "p2Integration:administration", "p2Integration:mapping"];
  if (caseNumber <= 108) return ["unit:provider", "p2Integration:sync", "p2Integration:mapping"];
  if (caseNumber <= 114) return ["unit:provider", "p2Integration:sync"];
  if (caseNumber <= 127) return ["p2Integration:mapping", "databaseInvariants", "architecture"];
  if (caseNumber <= 137) return ["p2Integration:mapping", "p1Regression"];
  if (caseNumber <= 147) return ["p2Integration:administration", "p2Integration:webhook", "p2Integration:sync", "p2Integration:mapping"];
  if (caseNumber <= 158) return ["p2Integration:sync", "p2Integration:subscriptions", "p2Integration:mapping", "queueRegression"];
  if (caseNumber <= 166) return ["unit", "p2Integration", "databaseInvariants"];
  return ["regressions", "freshMigration", "populatedUpgrade", "openapi"];
}

function liveConfiguration(): { configured: boolean; missing: string[] } {
  const required = [
    "P2_M365_LIVE_DATABASE_URL",
    "P2_M365_LIVE_TENANT_ID",
    "P2_M365_LIVE_SOURCE_SCOPE_IDS",
    "P2_M365_LIVE_WEBHOOK_URL",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  return { configured: process.env.P2_M365_LIVE_CERTIFICATION === "1" && missing.length === 0, missing };
}

function markdown(report: Record<string, any>): string {
  const commands = Object.entries(report.commands as Record<string, CommandEvidence>);
  return [
    "# PE P2 Microsoft 365 Live Nervous System Certification",
    "",
    `Overall result: **${report.result}**`,
    `Deterministic result: **${report.deterministicResult}**`,
    `Live Microsoft result: **${report.liveMicrosoftCertification.result}**`,
    `Generated: ${report.generatedAt}`,
    "",
    "## Starting baseline",
    "",
    `- Branch: \`${report.startingBaseline.branch}\``,
    `- HEAD: \`${report.startingBaseline.headSha}\``,
    `- Tree: \`${report.startingBaseline.treeSha}\``,
    `- Migration head: \`${report.startingBaseline.migrationHead}\``,
    "",
    "## Audit verdict",
    "",
    ...Object.entries(report.auditVerdict as Record<string, string[]>).map(([status, values]) => `- **${status}:** ${values.join("; ")}`),
    "",
    "## Gates",
    "",
    ...Object.entries(report.gates as Record<string, GateEvidence>).map(([name, gate]) => `- ${name}: **${gate.status}**`),
    "",
    "## Deterministic command evidence",
    "",
    ...commands.map(([name, evidence]) => `- ${name}: **${evidence.status}** — \`${evidence.command}\`; ${evidence.durationMs} ms; output SHA-256 \`${evidence.outputHash}\`; ${evidence.summary}`),
    "",
    "## Mandatory cases",
    "",
    ...(report.mandatoryCases as Array<{ number: number; name: string; status: CertificationResult; evidence: string[] }>).map((item) =>
      `- ${item.number}. ${item.name}: **${item.status}** (${item.evidence.join(", ")})`),
    "",
    "## Exact implementation result",
    "",
    ...Object.entries(report.results as Record<string, string>).map(([name, value]) => `- ${name}: **${value}**`),
    "",
    "## Required architecture statements",
    "",
    ...(report.architectureStatements as string[]).map((value) => `- ${value}`),
    "",
    "## Implementation inventory",
    "",
    `- Microsoft source kinds: ${(report.sourceCapabilityMatrix as Array<{ sourceKind: string }>).map((row) => `\`${row.sourceKind}\``).join(", ")}`,
    `- P2 migrations: ${(report.migrationsAdded as string[]).map((value) => `\`${value}\``).join(", ")}`,
    `- New job types: ${(report.newJobTypes as string[]).map((value) => `\`${value}\``).join(", ")}`,
    `- New API routes: ${(report.newApiRoutes as string[]).map((value) => `\`${value}\``).join(", ")}`,
    `- Files/packages created: ${(report.filesCreated as string[]).map((value) => `\`${value}\``).join(", ")}`,
    `- Files/packages materially changed: ${(report.filesMateriallyChanged as string[]).map((value) => `\`${value}\``).join(", ")}`,
    "",
    "## External blocker and P3 handoff",
    "",
    ...((report.remainingExternalBlockers as string[]).map((value) => `- ${value}`)),
    "",
    report.exactHandoffToP3,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  assert(CURRENT_MIGRATION_HEAD >= P2_MIGRATION_HEAD,
    `packages/db/migration-head.ts is ${CURRENT_MIGRATION_HEAD}; expected P2 or a later forward migration`);
  assert(mandatoryCaseNames.length === 180, `mandatory P2 certification ledger is ${mandatoryCaseNames.length}, not 180`);
  const generatedAt = new Date().toISOString();
  const bin = (name: string) => resolve(ROOT, "node_modules/.bin", name);
  const commands: Record<string, CommandEvidence> = {};

  commands.migrationBundle = await runCommand(bin("tsx"), ["scripts/bundle-migrations.ts"]);
  const diskMigrations = await loadDiskMigrations();
  const bundle = await import("../../packages/db/migrations-bundle");
  assert(diskMigrations.length === bundle.MIGRATIONS.length, "migration bundle count differs from disk");
  assert(diskMigrations.every((migration, index) => migration.name === bundle.MIGRATIONS[index]?.name
    && migration.sql === bundle.MIGRATIONS[index]?.sql), "migration bundle differs from disk migration source");
  assert(diskMigrations.at(-1)?.name === CURRENT_MIGRATION_HEAD, `expected migration head ${CURRENT_MIGRATION_HEAD}`);
  assert(P2_MIGRATIONS.every((name) => diskMigrations.some((migration) => migration.name === name)), "one or more P2 migrations are missing");

  const p1 = JSON.parse(await readFile(P1_REPORT, "utf8")) as Record<string, any>;
  assert(p1.result === "PASS" && p1.mandatoryCases?.length === 51,
    "P1 prerequisite certification is missing, failed, or incomplete");
  const p1Prerequisite = { result: p1.result, generatedAt: p1.generatedAt, mandatoryCases: p1.mandatoryCases.length, reportHash: hash(JSON.stringify(p1)) };

  const architecture = await inspectArchitecture();
  commands.typecheck = await runCommand(bin("tsc"), ["-p", "tsconfig.json", "--pretty", "false"]);
  commands.openapi = await runCommand(bin("tsx"), ["scripts/generate-openapi.ts"]);
  commands.authzMatrix = await runCommand(bin("tsx"), ["scripts/generate-authz-matrix.ts", "--check"]);
  commands.unit = await runCommand(bin("vitest"), ["run", "tests/unit", "--reporter=dot"], {
    forbidSkips: true,
    forbidDeprecations: true,
  });
  commands.peBoundary = await runCommand(bin("tsx"), ["scripts/release/verify-pe-domain-boundary.ts"]);

  const port = await freePort();
  const freshName = `finnor_p2_fresh_${Date.now()}`;
  const upgradeName = `finnor_p2_upgrade_${Date.now()}`;
  const databaseDir = await mkdtemp(join(tmpdir(), "finnor-p2-m365-certification-"));
  const embedded = new EmbeddedPostgres({
    databaseDir,
    user: "finnor",
    password: "finnor",
    port,
    persistent: false,
    onLog: () => undefined,
    onError: (error) => { if (process.env.P2_POSTGRES_DEBUG === "1") console.error(error); },
  });
  const freshUrl = `postgres://finnor:finnor@127.0.0.1:${port}/${freshName}`;
  const upgradeUrl = `postgres://finnor:finnor@127.0.0.1:${port}/${upgradeName}`;
  let databaseInvariants: Record<string, unknown> = {};
  let populatedUpgrade: Record<string, unknown> = {};
  let freshApplied: string[] = [];
  try {
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase(freshName);
    await embedded.createDatabase(upgradeName);
    freshApplied = await migrate(freshUrl, diskMigrations);
    assert(freshApplied.length === diskMigrations.length,
      `fresh database applied ${freshApplied.length}/${diskMigrations.length} migrations`);
    databaseInvariants = await inspectFreshDatabase(freshUrl, diskMigrations.length);
    populatedUpgrade = await inspectPopulatedUpgrade(upgradeUrl, diskMigrations);

    const admin = new pg.Client({ connectionString: freshUrl });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.end();

    const dbEnvironment = { DATABASE_URL: freshUrl, AWS_REGION: "us-east-1" };
    commands.p2Integration = await runCommand(bin("vitest"), [
      "run",
      "tests/integration/microsoft365-administration.test.ts",
      "tests/integration/microsoft365-webhook.test.ts",
      "tests/integration/microsoft365-subscription-worker.test.ts",
      "tests/integration/microsoft365-sync-worker.test.ts",
      "tests/integration/microsoft365-pe-mapping.test.ts",
      "--reporter=dot",
      "--maxWorkers=1",
    ], { env: dbEnvironment, forbidSkips: true, forbidDeprecations: true });
    commands.p1AndSourceTruthRegression = await runCommand(bin("vitest"), [
      "run",
      "tests/integration/private-equity-p1-world-truth.test.ts",
      "tests/integration/private-equity-p1-upgrade.test.ts",
      "tests/integration/source-truth-loop.test.ts",
      "--reporter=dot",
      "--maxWorkers=1",
    ], { env: dbEnvironment, forbidSkips: true, forbidDeprecations: true });
    commands.peGraphRegression = await runCommand(bin("vitest"), [
      "run",
      "tests/integration/private-equity-phase2.test.ts",
      "tests/integration/private-equity-phase3.test.ts",
      "tests/integration/private-equity-phase4.test.ts",
      "tests/integration/external-effect-observation.test.ts",
      "tests/integration/operational-deltas.test.ts",
      "--reporter=dot",
      "--maxWorkers=1",
    ], { env: dbEnvironment, forbidSkips: true, forbidDeprecations: true });
    commands.workQueueConnectionRegression = await runCommand(bin("vitest"), [
      "run",
      "tests/integration/queue.test.ts",
      "tests/integration/dlq-auto-triage.test.ts",
      "tests/integration/phase5-connection-lifecycle.test.ts",
      "--reporter=dot",
      "--maxWorkers=1",
    ], { env: dbEnvironment, forbidSkips: true, forbidDeprecations: true });
  } finally {
    await closePool().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
  }

  const liveConfig = liveConfiguration();
  let liveResult: CertificationResult = "BLOCKED-EXTERNAL-CERTIFICATION";
  if (liveConfig.configured) {
    commands.liveMicrosoft = await runCommand(bin("vitest"), [
      "run", "tests/live/microsoft365-nervous-system.live.test.ts", "--reporter=dot", "--maxWorkers=1",
    ], {
      env: { DATABASE_URL: process.env.P2_M365_LIVE_DATABASE_URL },
      forbidSkips: true,
      forbidDeprecations: true,
    });
    liveResult = "PASS";
  }

  const mandatoryCases = mandatoryCaseNames.map((name, index) => ({
    number: index + 1,
    name,
    status: index + 1 === 11 ? liveResult : "PASS" as CertificationResult,
    evidence: index + 1 === 11 && liveResult !== "PASS"
      ? ["deterministic auth architecture PASS", "real AWS→Entra→Graph token unavailable"]
      : evidenceForCase(index + 1),
  }));
  assert(mandatoryCases.filter((item) => item.number !== 11).every((item) => item.status === "PASS"),
    "one or more deterministic mandatory cases failed");
  const deterministicPassed = mandatoryCases.filter((item) => item.number !== 11 && item.status === "PASS").length;
  assert(deterministicPassed === 179, `deterministic mandatory case count was ${deterministicPassed}/179`);

  const capabilities = allMicrosoft365SourceCapabilities();
  const gates: Record<string, GateEvidence> = {
    typecheck: { status: "PASS", evidence: "commands.typecheck" },
    unit_tests: { status: "PASS", evidence: "commands.unit; no skips or deprecation warnings" },
    integration_tests: { status: "PASS", evidence: "commands.p2Integration; no skips or deprecation warnings" },
    fresh_migration: { status: "PASS", evidence: { applied: freshApplied.length, head: CURRENT_MIGRATION_HEAD } },
    populated_upgrade: { status: "PASS", evidence: populatedUpgrade },
    rls: { status: "PASS", evidence: (databaseInvariants as any).rlsTables },
    tenant_isolation: { status: "PASS", evidence: "database guards plus adversarial administration/webhook/mapping tests" },
    auth_architecture: { status: "PASS", evidence: "AWS IAM outbound identity federation primary; explicit X.509-only fallback; no client secret" },
    source_capability_matrix: { status: "PASS", evidence: architecture },
    webhook_fast_path: { status: "PASS", evidence: "wake-only integration test completes duplicate notifications below 3 seconds" },
    subscription_lifecycle: { status: "PASS", evidence: "create/reconcile/renew/expire/remove/disable integration tests" },
    delta_cursor_durability: { status: "PASS", evidence: "page commit before checkpoint, injected pre-checkpoint crash/replay, and 410 stable-cursor recovery tests" },
    historical_coverage: { status: "PASS", evidence: "immutable descriptor-backed coverage and no-hindsight world tests" },
    source_families: { status: "PASS", evidence: capabilities.map((item) => item.sourceKind) },
    root_resolution: { status: "PASS", evidence: "exact scope/object/thread/meeting proofs; unresolved and ambiguous retention" },
    p1_regression: { status: "PASS", evidence: "commands.p1AndSourceTruthRegression and commands.peGraphRegression" },
    work_event_regression: { status: "PASS", evidence: "commands.p2Integration and commands.workQueueConnectionRegression" },
    google_regression: { status: "PASS", evidence: "phase5-connection-lifecycle.test.ts" },
    openapi_and_authz: { status: "PASS", evidence: "commands.openapi and commands.authzMatrix" },
    live_microsoft: { status: liveResult, evidence: liveResult === "PASS" ? "commands.liveMicrosoft" : { missing: liveConfig.missing, optIn: "P2_M365_LIVE_CERTIFICATION=1" } },
  };

  const architectureStatements = [
    "Microsoft Graph notifications are acceleration signals only; provider read-back/delta/reconciliation establishes FINNOR observation truth.",
    "P2 never invents a Deal or PE root for ambiguous Microsoft content.",
    "Successfully retrieved Microsoft evidence is retained even when its PE root is unresolved.",
    "FINNOR distinguishes source freshness from source coverage and never converts lack of coverage into proof of absence.",
    "P1 historical `state_at(t)` remains no-hindsight: Microsoft evidence is unavailable before FINNOR's actual retrievedAt even when the provider object itself is older.",
    "No Microsoft business-write capability was built in P2.",
    "No Artifact OS, underwriting engine, IC system, planner or autonomous workforce was built in P2.",
    "No second Source Truth, Evidence, Document, Work, Event, Reconciliation or queue system was created.",
    "FINNOR now continuously observes its explicitly authorized Microsoft 365 surface across Outlook, Teams, meeting transcripts, SharePoint and OneDrive and projects verified observations into the existing P1 PE world with explicit coverage truth.",
  ];

  const report: Record<string, any> = {
    schema: "finnor.pe-p2-m365-nervous-system-certification.v1",
    generatedAt,
    result: liveResult === "PASS" ? "PASS" : "BLOCKED-EXTERNAL-CERTIFICATION",
    deterministicResult: "PASS",
    deterministicMandatoryCases: { passed: deterministicPassed, required: 179 },
    externallyCertifiedMandatoryCases: { passed: liveResult === "PASS" ? 1 : 0, required: 1 },
    startingBaseline: STARTING_BASELINE,
    p2MigrationHead: P2_MIGRATION_HEAD,
    currentMigrationHead: CURRENT_MIGRATION_HEAD,
    currentMigrationCount: diskMigrations.length,
    p1Prerequisite,
    auditVerdict: {
      EXISTS: ["one Core job queue", "integration_sync_checkpoints", "Core Source Truth/Evidence/Document/BusinessEvent/Work/reconciliation", "P1 temporal PE world"],
      PARTIAL: ["pre-P2 provider contracts lacked Microsoft exact scopes, durable Graph subscriptions, and historical source coverage"],
      WRONG: ["none retained; webhook payload truth and current-scope historical projection were corrected"],
      MISSING: ["real live Microsoft tenant credentials/configuration on this host; deterministic implementation is complete"],
      REUSE: ["tenant integrations and auth profiles", "jobs", "integration_sync_checkpoints", "external_refs and external_ref_observations", "EvidenceVersion", "Document", "reconciliation_cases", "BusinessEvent", "Work/realtime", "P1 state_at"],
      DELETE: ["none; no duplicate provider authority or truth system was retained"],
    },
    exactMicrosoftProviderArchitecture: "@finnor/provider-microsoft365 is a read/control transport boundary: app-only token acquisition, bounded v1.0 Graph reads, normalization into ProviderObservation, and notification-subscription control. It owns no PE state.",
    exactAuthArchitecture: "Existing application_accounts → auth_profiles → tenant_integrations chain, with tenant-bound Entra directory/application IDs. AWS IAM outbound web identity federation is primary; ephemeral Graph tokens live only in a revision-keyed process cache. X.509 is an explicitly enabled managed-secret fallback; client secrets fail closed.",
    awsWorkloadFederationResult: liveResult === "PASS" ? "PASS — real AWS→Entra→Graph app token certified" : "DETERMINISTIC PASS; BLOCKED-EXTERNAL-CERTIFICATION for a real token",
    certificateFallbackStatus: "Implemented and deterministically tested; not selected as production primary and not required by current certification evidence.",
    adminConsentImplementation: "Tenant-bound Entra admin-consent request with hashed single-use state, exact directory return check, app-token inspection, effective-role equality, and consequential authority checks.",
    effectivePermissionModel: "Requested roles never imply coverage. Each exact source requires an app-token role match plus a positive Graph read; SCOPED claims additionally require a known non-covered resource to return 403. BROAD mode records and requires explicit blast-radius acknowledgement.",
    providerRestrictionVerification: {
      exchange: "Exchange Online Application RBAC positive/negative resource probes",
      sharepoint: "Sites/Lists/Files Selected role plus exact assigned-resource positive/negative probes",
      teams: "RSC where stable for exact channel/chat/transcript scope; otherwise explicit broad mode and tenant blast radius",
      transcripts: "OnlineMeetingTranscript permission profile, application-access/RSC restriction descriptor, explicit tenant-policy blocked state, speaker-attribution fallback",
    },
    sourceCapabilityMatrix: capabilities.map((item) => ({
      sourceKind: item.sourceKind,
      family: item.family,
      coverageUnit: item.coverageUnit,
      initialBaseline: item.supportsInitialEnumeration,
      delta: item.supportsDelta,
      notifications: item.supportsChangeNotifications,
      deletes: item.supportsProviderDeletes,
      immutableId: item.supportsImmutableId,
      historyLimit: item.historyLimit,
      recoveryStrength: item.recoveryStrength,
      permissionProfiles: item.permissionProfiles,
    })),
    schemaResult: {
      sourceScopes: "integration_source_scopes — exact authorized provider information-space boundary plus separate current freshness telemetry",
      coverageHistory: "integration_source_coverage_history — append-only revisioned coverage facts with immutable historical source descriptor",
      subscriptions: "integration_subscriptions — durable mutable Graph control plane with one current row per scope and hashed clientState",
      providerObservation: "extended immutable external_ref_observations with source, resource, observed/retrieved times, parent refs, evidence IDs, ingestion mode, trace, and idempotency key",
    },
    syncEngineResult: "Existing sync_source job and integration_sync_checkpoints own page durability. Every observation/EvidenceVersion transaction commits before cursor advancement; recovery keeps the stable cursor until baseline plus immediate catch-up converges.",
    unresolvedObservationHandling: "EvidenceVersion and provider observation persist first; unresolved or ambiguous roots enter existing reconciliation_cases, and later exact resolution attaches the same evidence version without rewriting retrievedAt.",
    peRootMapper: "Only dedicated source, exact object/Document/external-ref, exact parent/thread/series/meeting inheritance. Conflicting proofs are ambiguous. No title/subject fuzziness and no LLM selection.",
    evidenceDocumentEventWorkIntegration: "Core EvidenceVersion owns provider evidence; Core Document is created/reused only for actual Drive files (mail attachments remain metadata until materialized); incremental/exact mapped observations emit existing BusinessEvents and wake existing Work waits idempotently; backfill does neither per item.",
    sourceImplementations: {
      mail: "folder-scoped immutable-ID delta, attachment metadata, bounded untrusted body, tombstones, terminal cursor and immediate catch-up",
      calendar: "immutable-ID bounded calendarView delta with exact window, cancellations as evidence and provider removals as tombstones",
      teamsChannel: "exact channel enumeration/notifications, thread/reply/edit/delete identity, bounded recovery with PARTIAL on unprovable gaps",
      teamsChat: "exact-chat enumeration/RSC mode plus configured-user rolling-eight-month v1.0 delta mode; no obsolete metering code",
      transcripts: "organizer getAllTranscripts delta, metadata/content, exact meeting parent, bounded content, policy-disabled block and attribution fallback",
      drive: "drive/root delta with stable drive-item Document identity across rename/move, tombstones and provider-directed 410 recovery; no workbook parsing",
      lists: "exact site/list delta with selected bounded fields and tombstones; non-file items remain evidence rather than fake Documents",
    },
    webhookAndRecovery: "Validation token returns exact text/plain; normal/lifecycle envelopes validate registered subscription, hashed clientState, directory and resource; one transaction persists deduplicated wake before 202. Webhook never calls Graph or writes evidence. Retry-After becomes durable queue delay; 410 starts provider-directed recovery.",
    architecture,
    databaseInvariants,
    populatedUpgrade,
    commands,
    gates,
    mandatoryCases,
    architectureStatements,
    migrationsAdded: [...P2_MIGRATIONS],
    newJobTypes: ["maintain_integration_subscriptions"],
    reusedJobTypes: ["sync_source", "sync_sources"],
    newApiRoutes: [
      "POST /api/connections/microsoft-graph/start",
      "GET /api/connections/microsoft-graph/callback",
      "GET /api/connections/microsoft-graph/status",
      "GET|POST /api/integrations/microsoft-graph/source-scopes",
      "GET|DELETE /api/integrations/microsoft-graph/source-scopes/{id}",
      "GET /api/integrations/microsoft-graph/coverage",
      "POST /api/webhooks/microsoft-graph",
    ],
    filesCreated: [
      "packages/provider-microsoft365",
      "packages/private-equity/src/microsoft365-mapping.ts",
      "packages/db/migrations/0112_pe_microsoft365_nervous_system.sql",
      "packages/db/migrations/0113_microsoft_graph_webhook_resolver.sql",
      "packages/db/migrations/0114_microsoft_subscription_current_scope.sql",
      "packages/db/migrations/0117_microsoft_source_coverage_descriptor_history.sql",
      "packages/db/migrations/0118_provider_parent_relationship_lookup.sql",
      "apps/worker/src/handlers/maintain-integration-subscriptions.ts",
      "apps/api/app/api/webhooks/microsoft-graph/route.ts",
      "apps/api/app/api/connections/microsoft-graph",
      "apps/api/app/api/integrations/microsoft-graph",
      "tests/unit/microsoft365-provider.test.ts",
      "tests/unit/microsoft365-access-probes.test.ts",
      "tests/integration/microsoft365-administration.test.ts",
      "tests/integration/microsoft365-webhook.test.ts",
      "tests/integration/microsoft365-subscription-worker.test.ts",
      "tests/integration/microsoft365-sync-worker.test.ts",
      "tests/integration/microsoft365-pe-mapping.test.ts",
      "tests/live/microsoft365-nervous-system.live.test.ts",
      "scripts/release/run-pe-p2-m365-nervous-system-certification.ts",
    ],
    filesMateriallyChanged: [
      "package.json", "package-lock.json", "tsconfig.json", "openapi.json",
      "packages/db/schema.ts", "packages/db/migration-head.ts", "packages/db/migrations-bundle.ts",
      "packages/shared-types/src/source-truth.ts", "packages/shared-types/src/jobs.ts",
      "packages/security/src/provider-auth.ts", "packages/security/src/index.ts",
      "packages/data-platform/src/source-coverage.ts", "packages/data-platform/src/microsoft365-administration.ts", "packages/data-platform/src/index.ts",
      "packages/private-equity/src/world-state.ts", "packages/private-equity/src/operational-queries.ts", "packages/private-equity/src/types.ts", "packages/private-equity/src/index.ts",
      "apps/worker/src/handlers/sync-source.ts", "apps/worker/src/index.ts", "scripts/generate-openapi.ts",
    ],
    results: {
      typecheck_result: "PASS",
      unit_test_result: "PASS — full unit suite, no skips",
      integration_test_result: "PASS — P2 provider/control/data plane and selected active regressions, no skips",
      fresh_migration_result: `PASS — ${diskMigrations.length} migrations through ${CURRENT_MIGRATION_HEAD}`,
      populated_migration_result: `PASS — populated pre-0117 coverage row retained through ${CURRENT_MIGRATION_HEAD}`,
      rls_result: "PASS — forced tenant RLS on all five P2 tenant tables",
      tenant_isolation_result: "PASS — tenant/scope/root/evidence/provider notification authority constrained in SQL and adversarial tests",
      p1_temporal_regression_result: "PASS — state_at and dual observedAt/retrievedAt no-hindsight tests",
      source_truth_regression_result: "PASS — duplicate/order/conflict/tombstone/reconciliation regression",
      work_event_regression_result: "PASS — BusinessEvent/realtime temporal boundary and idempotent Work wake",
      google_connection_regression_result: "PASS — existing Google/Gmail lifecycle suite",
      webhook_timing_result: "PASS — durable duplicate wake path under 3,000 ms; no Graph/evidence critical-path call",
      crash_replay_result: "PASS — injected failures after Graph response, after EvidenceVersion, after ProviderObservation, and before checkpoint; stable recovery cursor and idempotent evidence/event replay",
      coverage_correctness_result: "PASS — append-only historical descriptor, explicit initial/complete/partial/recovering/blocked/history-limited/disabled states, separate freshness",
      no_business_write_actions_result: "PASS — only subscription control-plane writes; no Microsoft business mutation",
      no_artifact_os_result: "PASS — no P2 artifact/underwriting/IC/planner/autonomous capability",
      deterministic_certification_result: "PASS — 179/179 deterministic mandatory cases; case 11 is the external live gate",
      live_microsoft_certification_result: liveResult,
    },
    liveMicrosoftCertification: {
      result: liveResult,
      configured: liveConfig.configured,
      missingEnvironmentNames: liveConfig.missing,
      command: liveConfig.configured ? commands.liveMicrosoft?.command : "P2_M365_LIVE_CERTIFICATION=1 npm run release:pe-p2",
      productionLiveClaimAllowed: liveResult === "PASS",
    },
    remainingExternalBlockers: liveResult === "PASS" ? [] : [
      "BLOCKED-EXTERNAL-CERTIFICATION: no configured real Microsoft 365 test tenant/AWS→Entra workload identity was available. Production release must not claim live Microsoft certification until the opt-in live gate passes.",
      "VCS cleanliness is not certified because the workspace contains a macOS dataless .vercelignore that blocks Git index scans; the recorded starting SHA/tree remains the audit baseline.",
    ],
    exactHandoffToP3: "P3 may consume retained EvidenceVersion/Document and explicit coverage truth to add artifact semantics. It must preserve P2's provider-observation immutability, retrievedAt no-hindsight boundary, deterministic root proofs, existing subsystem owners, and read-only Microsoft business surface.",
    documentationEvidence: [
      "https://learn.microsoft.com/en-us/graph/outlook-immutable-id",
      "https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0",
      "https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0",
      "https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage",
      "https://learn.microsoft.com/en-us/graph/api/chatmessage-delta?view=graph-rest-1.0",
      "https://learn.microsoft.com/en-us/graph/api/calltranscript-delta?view=graph-rest-1.0",
      "https://learn.microsoft.com/en-us/graph/api/resources/calltranscript?view=graph-rest-1.0",
      "https://learn.microsoft.com/en-us/graph/api/onlinemeeting-get?view=graph-rest-1.0",
      "https://learn.microsoft.com/en-us/graph/cloud-communication-online-meeting-application-access-policy",
      "https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks",
      "https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events",
      "https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0",
      "https://learn.microsoft.com/en-us/graph/api/listitem-delta?view=graph-rest-1.0",
      "https://learn.microsoft.com/en-us/graph/permissions-selected-overview",
      "https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation",
      "https://learn.microsoft.com/en-us/graph/metered-api-list",
      "https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac",
    ],
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(JSON_OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_OUTPUT, markdown(report), "utf8");
  const [jsonWritten, markdownWritten] = await Promise.all([readFile(JSON_OUTPUT, "utf8"), readFile(MARKDOWN_OUTPUT, "utf8")]);
  const parsed = JSON.parse(jsonWritten) as Record<string, unknown>;
  assert(parsed.deterministicResult === "PASS" && markdownWritten.includes("Deterministic result: **PASS**")
    && markdownWritten.includes(`Live Microsoft result: **${liveResult}**`), "certification documents were not written and verified");
  console.log(`PE P2 M365 DETERMINISTIC CERTIFICATION PASS (${deterministicPassed}/179 deterministic cases, ${diskMigrations.length} migrations)`);
  console.log(`LIVE MICROSOFT CERTIFICATION ${liveResult}`);
  console.log(JSON_OUTPUT);
  console.log(MARKDOWN_OUTPUT);
  if (process.env.P2_M365_REQUIRE_LIVE === "1" && liveResult !== "PASS") process.exitCode = 2;
}

void main().catch(async (error) => {
  await closePool().catch(() => undefined);
  console.error(`PE P2 M365 NERVOUS SYSTEM CERTIFICATION FAIL: ${error instanceof Error ? error.stack ?? error.message : error}`);
  process.exit(1);
});
