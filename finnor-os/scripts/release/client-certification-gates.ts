import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import type pg from "pg";
import { parseImportDefinition, runDeclarativeImport } from "@finnor/import-engine";
import type { ClientManifest } from "../client-manifest";
import {
  CLIENT_GATE_KEYS,
  deploymentEvidenceProjection,
  gateResult,
  hashClientConfiguration,
  sha256,
  stableStringify,
  type CertificationGateResult,
  type CertificationStatus,
  type CredentialReferenceStatus,
} from "./certification-model";
import type { CoreDiffResult } from "./core-diff-guard";

export interface ClientJourneyEvidence {
  canonicalCoreSha: string;
  deploymentEvidenceHash: string;
  journeys: Array<{ journey: string; actionTypes: string[]; receiptIds: string[]; outcomeVerified: boolean }>;
}

export interface ClientGateMatrixResult {
  gates: CertificationGateResult[];
  tenantId: string;
  migrationVersion: string;
  schemaHash: string;
  integrations: CredentialReferenceStatus[];
}

interface IntegrationRow {
  capability: string;
  binding: string;
  mode: string;
  config: unknown;
  credential_provider: string | null;
  credential_ref: string | null;
  credential_version: string | null;
  health: CredentialReferenceStatus["health"];
  last_check_at: Date | null;
}

function combinedStatus(statuses: CertificationStatus[]): CertificationStatus {
  if (statuses.some((status) => status === "FAIL")) return "FAIL";
  if (statuses.some((status) => status === "BLOCKED_CONFIG")) return "BLOCKED_CONFIG";
  return "PASS";
}

function containsDesired(actual: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) return stableStringify(actual) === stableStringify(desired);
  if (desired && typeof desired === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(desired as Record<string, unknown>).every(([key, value]) =>
      containsDesired((actual as Record<string, unknown>)[key], value));
  }
  return Object.is(actual, desired);
}

function deploymentIdentity(value: unknown): { commitSha: string | null; deploymentId: string | null; coreCertificationId: string | null; traceable: boolean | null } {
  if (!value || typeof value !== "object") return { commitSha: null, deploymentId: null, coreCertificationId: null, traceable: null };
  const record = value as Record<string, unknown>;
  const nested = record.release && typeof record.release === "object" ? record.release as Record<string, unknown> : record;
  return {
    commitSha: typeof nested.commitSha === "string" ? nested.commitSha : null,
    deploymentId: typeof nested.deploymentId === "string" ? nested.deploymentId : null,
    coreCertificationId: typeof nested.coreCertificationId === "string" ? nested.coreCertificationId : null,
    traceable: typeof nested.traceable === "boolean" ? nested.traceable : null,
  };
}

async function databaseIdentity(pool: pg.Pool): Promise<{ migrationVersion: string; schemaHash: string; migrations: string[] }> {
  const migrations = await pool.query<{ name: string }>("SELECT name FROM finnor_os._migrations ORDER BY name");
  const columns = await pool.query<{
    table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null;
  }>(
    `SELECT table_name,column_name,data_type,is_nullable,column_default
     FROM information_schema.columns WHERE table_schema='finnor_os'
     ORDER BY table_name,ordinal_position`,
  );
  const constraints = await pool.query<{
    table_name: string; constraint_name: string; constraint_type: string; definition: string;
  }>(
    `SELECT c.relname table_name,con.conname constraint_name,con.contype constraint_type,
       pg_get_constraintdef(con.oid,true) definition
     FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='finnor_os'
     ORDER BY c.relname,con.conname`,
  );
  const policies = await pool.query<{
    table_name: string; policy_name: string; permissive: string; roles: string; command: string;
    using_expression: string | null; check_expression: string | null;
  }>(
    `SELECT tablename table_name,policyname policy_name,permissive,roles::text,cmd command,
       qual using_expression,with_check check_expression
     FROM pg_policies WHERE schemaname='finnor_os'
     ORDER BY tablename,policyname`,
  );
  const triggers = await pool.query<{ table_name: string; trigger_name: string; definition: string }>(
    `SELECT c.relname table_name,t.tgname trigger_name,pg_get_triggerdef(t.oid,true) definition
     FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='finnor_os' AND NOT t.tgisinternal
     ORDER BY c.relname,t.tgname`,
  );
  const names = migrations.rows.map((row) => row.name);
  return {
    migrationVersion: names.at(-1) ?? "none",
    schemaHash: sha256({ migrations: names, columns: columns.rows, constraints: constraints.rows, policies: policies.rows, triggers: triggers.rows }),
    migrations: names,
  };
}

async function importReplayGate(
  manifest: ClientManifest,
  tenantId: string,
  importKeys?: readonly string[],
  priorEvidenceHash?: string,
): Promise<CertificationGateResult> {
  const selected = importKeys ? new Set(importKeys) : null;
  const imports = selected ? manifest.imports.filter((item) => selected.has(item.key)) : manifest.imports;
  if (imports.length === 0) return gateResult("import_replay_safety", "PASS", {
    imports: [], replayed: 0, reusedImportKeys: selected ? manifest.imports.map((item) => item.key).sort() : [],
    priorEvidenceHash: priorEvidenceHash ?? null,
  });
  const reports: Array<Record<string, unknown>> = [];
  for (const item of imports) {
    if (!item.sourceRef) return gateResult("import_replay_safety", "BLOCKED_CONFIG", { importKey: item.key, missing: "sourceRef" });
    const path = item.sourceRef.startsWith("file://") ? fileURLToPath(item.sourceRef) : item.sourceRef;
    if (!isAbsolute(path)) return gateResult("import_replay_safety", "BLOCKED_CONFIG", { importKey: item.key, missing: "absolute sourceRef" });
    let content: string;
    try { content = await readFile(path, "utf8"); } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unavailable";
      return gateResult("import_replay_safety", "BLOCKED_CONFIG", { importKey: item.key, source: "unavailable", code });
    }
    const report = await runDeclarativeImport({
      tenantId,
      definition: parseImportDefinition({ key: item.key, format: item.source, ...item.definition }),
      source: { name: `certification:${item.key}`, content },
    });
    reports.push({
      key: item.key,
      sourceSha256: report.sourceSha256,
      definitionSha256: report.definitionSha256,
      total: report.total,
      created: report.created,
      updated: report.updated,
      skipped: report.skipped,
      quarantined: report.quarantined,
    });
  }
  const failed = reports.some((report) => Number(report.created) !== 0 || Number(report.updated) !== 0 || Number(report.quarantined) !== 0);
  return gateResult("import_replay_safety", failed ? "FAIL" : "PASS", {
    reports,
    replayedImportKeys: imports.map((item) => item.key).sort(),
    reusedImportKeys: selected ? manifest.imports.filter((item) => !selected.has(item.key)).map((item) => item.key).sort() : [],
    priorEvidenceHash: priorEvidenceHash ?? null,
    rule: "replay creates zero entities, updates zero entities, and quarantines zero rows",
  });
}

async function receiptGates(
  pool: pg.Pool,
  tenantId: string,
  coreSha: string,
  deploymentEvidenceHash: string,
  journeyEvidence?: ClientJourneyEvidence,
): Promise<[CertificationGateResult, CertificationGateResult]> {
  if (!journeyEvidence) {
    const blocked = { missing: "tenant-specific water-treatment journey evidence" };
    return [gateResult("water_treatment_journeys", "BLOCKED_CONFIG", blocked), gateResult("evidence_receipts", "BLOCKED_CONFIG", blocked)];
  }
  if (journeyEvidence.canonicalCoreSha !== coreSha || journeyEvidence.deploymentEvidenceHash !== deploymentEvidenceHash) {
    const mismatch = {
      expectedCoreSha: coreSha,
      observedCoreSha: journeyEvidence.canonicalCoreSha,
      deploymentEvidenceMatches: journeyEvidence.deploymentEvidenceHash === deploymentEvidenceHash,
    };
    return [gateResult("water_treatment_journeys", "FAIL", mismatch), gateResult("evidence_receipts", "FAIL", mismatch)];
  }
  const requiredActions = ["schedule_water_test", "size_equipment_for_household", "generate_quote"];
  const claimedActions = new Set(journeyEvidence.journeys.flatMap((journey) => journey.actionTypes));
  const missingActions = requiredActions.filter((action) => !claimedActions.has(action));
  const receiptIds = [...new Set(journeyEvidence.journeys.flatMap((journey) => journey.receiptIds))];
  if (missingActions.length || receiptIds.length === 0) {
    const missing = { missingActions, receiptCount: receiptIds.length };
    return [gateResult("water_treatment_journeys", "BLOCKED_CONFIG", missing), gateResult("evidence_receipts", "BLOCKED_CONFIG", missing)];
  }
  const unverifiedJourneys = journeyEvidence.journeys.filter((journey) => journey.outcomeVerified !== true).map((journey) => journey.journey);
  if (unverifiedJourneys.length > 0) {
    const missingOutcomeEvidence = { unverifiedJourneys, rule: "every journey must bind to a verified requested outcome; identity/routing/UI evidence is insufficient" };
    return [gateResult("water_treatment_journeys", "BLOCKED_CONFIG", missingOutcomeEvidence), gateResult("evidence_receipts", "BLOCKED_CONFIG", missingOutcomeEvidence)];
  }
  const receipts = await pool.query<{
    id: string; action_type: string | null; finalized: boolean; failed: boolean;
    has_evidence: boolean; has_policy: boolean; has_outcome: boolean;
  }>(
    `SELECT r.id,coalesce(a.action_type,r.proposed_action->>'actionType') action_type,r.finalized_at IS NOT NULL finalized,r.failure IS NOT NULL failed,
       jsonb_array_length(CASE WHEN jsonb_typeof(r.evidence)='array' THEN r.evidence ELSE '[]'::jsonb END)>0 has_evidence,
       r.policy_applied IS NOT NULL has_policy,
       r.actual_result IS NOT NULL has_outcome
     FROM finnor_os.decision_receipts r
     LEFT JOIN finnor_os.domain_actions a ON a.id=r.domain_action_id
     WHERE r.tenant_id=$1 AND r.id=ANY($2::uuid[])`,
    [tenantId, receiptIds],
  );
  const found = new Set(receipts.rows.map((row) => row.id));
  const missingReceiptIds = receiptIds.filter((id) => !found.has(id));
  const incomplete = receipts.rows.filter((row) => !row.finalized || row.failed || !row.has_evidence || !row.has_policy || !row.has_outcome)
    .map((row) => ({ id: row.id, actionType: row.action_type, finalized: row.finalized, failed: row.failed, evidence: row.has_evidence, policy: row.has_policy, outcome: row.has_outcome }));
  const observedActions = new Set(receipts.rows.map((row) => row.action_type).filter(Boolean));
  const actionsWithoutReceipts = requiredActions.filter((action) => !observedActions.has(action));
  const status: CertificationStatus = missingReceiptIds.length || incomplete.length || actionsWithoutReceipts.length ? "FAIL" : "PASS";
  return [
    gateResult("water_treatment_journeys", status, { requiredActions, actionsWithoutReceipts, journeyCount: journeyEvidence.journeys.length }),
    gateResult("evidence_receipts", status, { receiptIds, missingReceiptIds, incomplete }),
  ];
}

export async function runClientCertificationGates(input: {
  manifest: ClientManifest;
  pool: pg.Pool;
  factoryRunId?: string;
  canonicalCoreSha: string;
  coreCertificationId: string;
  deploymentEvidence: unknown;
  coreDiff: CoreDiffResult;
  journeyEvidence?: ClientJourneyEvidence;
  providerHealthMaxAgeMinutes?: number;
  /** PASS gate evidence from the active release, reused only when the lifecycle plan proves its inputs unchanged. */
  reuseGates?: CertificationGateResult[];
  /** When import definitions changed, replay only those keys; unchanged keys retain prior PASS evidence. */
  invalidatedImportKeys?: string[];
  priorImportReplayGate?: CertificationGateResult;
}): Promise<ClientGateMatrixResult> {
  const { manifest, pool } = input;
  const configHashes = hashClientConfiguration(manifest);
  const dbIdentity = await databaseIdentity(pool);
  const gates = new Map<string, CertificationGateResult>();
  const reusableGates = new Map((input.reuseGates ?? [])
    .filter((gate) => gate.status === "PASS")
    .map((gate) => [gate.gate, gate]));
  gates.set("manifest_config_validity", gateResult("manifest_config_validity", "PASS", {
    manifestVersion: manifest.manifestVersion,
    manifestHash: configHashes.manifestHash,
    mappingHashes: configHashes.mappingHashes,
    importDefinitionHashes: configHashes.importDefinitionHashes,
  }));

  let tenantId = "";
  if (!input.factoryRunId) {
    gates.set("tenant_identity_convergence", gateResult("tenant_identity_convergence", "BLOCKED_CONFIG", { missing: "factoryRunId" }));
  } else {
    const factory = await pool.query<{
      tenant_id: string | null; client_key: string; manifest_sha256: string; status: string;
      tenant_name: string | null; tenant_timezone: string | null; tenant_owner_phone: string | null;
    }>(
      `SELECT r.tenant_id,r.client_key,r.manifest_sha256,r.status,
         t.name tenant_name,t.timezone tenant_timezone,t.owner_phone tenant_owner_phone
       FROM finnor_os.client_factory_runs r LEFT JOIN finnor_os.tenants t ON t.id=r.tenant_id
       WHERE r.id=$1`,
      [input.factoryRunId],
    );
    const row = factory.rows[0];
    tenantId = row?.tenant_id ?? "";
    const tenantFieldsMatch = Boolean(row && row.tenant_name === manifest.tenant.name
      && row.tenant_timezone === manifest.tenant.timezone
      && row.tenant_owner_phone === (manifest.tenant.ownerPhone ?? null));
    const converged = Boolean(row && row.status === "passed" && row.tenant_id && row.client_key === manifest.clientKey && row.manifest_sha256 === configHashes.manifestHash && tenantFieldsMatch);
    gates.set("tenant_identity_convergence", gateResult("tenant_identity_convergence", converged ? "PASS" : "FAIL", {
      factoryRunId: input.factoryRunId,
      factoryRunFound: Boolean(row),
      factoryStatus: row?.status ?? null,
      tenantId: row?.tenant_id ?? null,
      clientKeyMatches: row?.client_key === manifest.clientKey,
      manifestMatches: row?.manifest_sha256 === configHashes.manifestHash,
      tenantFieldsMatch,
    }));
  }

  if (!tenantId) {
    for (const key of CLIENT_GATE_KEYS.filter((key) => !gates.has(key) && key !== "core_diff_guard")) {
      gates.set(key, gateResult(key, "FAIL", { reason: "tenant identity did not converge" }));
    }
  } else {
    const users = await pool.query<{ email: string; tenant_id: string; role: string; status: string }>(
      "SELECT email,tenant_id,role,status FROM finnor_os.users WHERE lower(email)=ANY($1::text[])",
      [manifest.users.map((user) => user.email)],
    );
    const wrongTenant = users.rows.filter((user) => user.tenant_id !== tenantId).map((user) => user.email);
    const missingUsers = manifest.users.filter((expected) => !users.rows.some((actual) => actual.tenant_id === tenantId && actual.email === expected.email && actual.role === expected.role && actual.status === expected.status)).map((user) => user.email);
    gates.set("user_isolation", gateResult("user_isolation", wrongTenant.length || missingUsers.length ? "FAIL" : "PASS", { expectedUsers: manifest.users.length, wrongTenant, missingUsers }));

    const workspace = await pool.query<{ is_dealer_zero: boolean; simulator_enabled: boolean; training_mode: boolean; workspace_config: unknown }>(
      "SELECT is_dealer_zero,simulator_enabled,training_mode,workspace_config FROM finnor_os.tenant_settings WHERE tenant_id=$1",
      [tenantId],
    );
    const locations = await pool.query<{ location_key: string; name: string; address: string | null; timezone: string | null; active: boolean }>(
      "SELECT location_key,name,address,timezone,active FROM finnor_os.tenant_locations WHERE tenant_id=$1 ORDER BY location_key",
      [tenantId],
    );
    const policies = await pool.query<{ action_type: string; policy: unknown; requires_confirmation: boolean; confirmation_template: string | null; version: number }>(
      "SELECT action_type,policy,requires_confirmation,confirmation_template,version FROM finnor_os.domain_policies WHERE tenant_id=$1 ORDER BY action_type",
      [tenantId],
    );
    const workspaceRow = workspace.rows[0];
    const settingsMatch = Boolean(workspaceRow
      && workspaceRow.is_dealer_zero === manifest.tenant.settings.isDealerZero
      && workspaceRow.simulator_enabled === manifest.tenant.settings.simulatorEnabled
      && workspaceRow.training_mode === manifest.tenant.settings.trainingMode);
    const explicitWorkspaceMatches = !manifest.workspaceConfig || stableStringify(workspaceRow?.workspace_config) === stableStringify(manifest.workspaceConfig);
    const expectedLocations = manifest.locations.map((row) => ({ location_key: row.key, name: row.name, address: row.address ?? null, timezone: row.timezone ?? null, active: row.active })).sort((a, b) => a.location_key.localeCompare(b.location_key));
    const locationsMatch = expectedLocations.every((expected) => locations.rows.some((actual) => stableStringify(actual) === stableStringify(expected)))
      && locations.rows.filter((actual) => actual.active).every((actual) => expectedLocations.some((expected) => expected.location_key === actual.location_key && expected.active));
    const policyPlaceholders = policies.rows.filter((row) => stableStringify(row.policy).includes("PLACEHOLDER_NEEDS_REAL_VALUE")).map((row) => row.action_type);
    const policyDrift = Object.entries(manifest.policyOverrides).flatMap(([actionType, desired]) => {
      const actual = policies.rows.find((row) => row.action_type === actionType);
      if (!actual) return [actionType];
      const matches = (!desired.policy || containsDesired(actual.policy, desired.policy))
        && (desired.requiresConfirmation === undefined || actual.requires_confirmation === desired.requiresConfirmation)
        && (desired.confirmationTemplate === undefined || actual.confirmation_template === desired.confirmationTemplate);
      return matches ? [] : [actionType];
    });
    const workspaceStatus: CertificationStatus = !workspaceRow || !settingsMatch || !explicitWorkspaceMatches || !locationsMatch || policies.rows.length === 0 || policyDrift.length > 0
      ? "FAIL" : policyPlaceholders.length ? "BLOCKED_CONFIG" : "PASS";
    gates.set("workspace_policies", gateResult("workspace_policies", workspaceStatus, {
      settingsMatch, explicitWorkspaceMatches, locationsMatch, policyCount: policies.rows.length,
      workspaceStateHash: sha256(workspaceRow ?? null), policyStateHash: sha256(policies.rows), policyPlaceholders, policyDrift,
    }));

    const integrationRows = await pool.query<IntegrationRow>(
      `SELECT capability,binding,mode,config,credential_provider,credential_ref,credential_version,health,last_check_at
       FROM finnor_os.tenant_integrations WHERE tenant_id=$1 ORDER BY capability`,
      [tenantId],
    );
    const integrationByCapability = new Map(integrationRows.rows.map((row) => [row.capability, row]));
    const missingIntegrations = manifest.requiredCapabilities.filter((capability) => !integrationByCapability.has(capability));
    const integrationDrift = manifest.integrations.filter((expected) => {
      const actual = integrationByCapability.get(expected.capability);
      return !actual || actual.binding !== expected.binding || actual.mode !== expected.mode || stableStringify(actual.config) !== stableStringify(expected.config);
    }).map((row) => row.capability);
    const emulatedRequiredCapabilities = manifest.requiredCapabilities.filter((capability) => {
      const actual = integrationByCapability.get(capability);
      return actual?.mode === "emulator" || actual?.binding === "emulator";
    });
    const integrationStatus: CertificationStatus = missingIntegrations.length || integrationDrift.length
      ? "FAIL" : emulatedRequiredCapabilities.length ? "BLOCKED_CONFIG" : "PASS";
    gates.set("required_integrations_capabilities", gateResult("required_integrations_capabilities", integrationStatus, {
      missingIntegrations, integrationDrift, emulatedRequiredCapabilities,
      rule: "a required client capability cannot be certified by an emulator",
    }));

    const missingCredentialCapabilities = manifest.requiredCapabilities.filter((capability) => {
      const expected = manifest.integrations.find((row) => row.capability === capability);
      const actual = integrationByCapability.get(capability);
      return Boolean(expected && expected.mode !== "emulator" && expected.binding !== "native" && !actual?.credential_ref);
    });
    const credentialDrift = manifest.integrations.filter((expected) => {
      const actual = integrationByCapability.get(expected.capability);
      if (!actual) return false;
      const desiredRef = expected.credential?.ref.replaceAll("{tenantId}", tenantId) ?? null;
      return actual.credential_provider !== (expected.credential?.provider ?? null)
        || actual.credential_ref !== desiredRef
        || actual.credential_version !== (expected.credential?.version ?? null);
    }).map((row) => row.capability);
    const communicationCredentialRows = await pool.query<{
      identity_key: string; credential_provider: string | null; credential_ref: string | null; credential_version: string | null;
    }>("SELECT identity_key,credential_provider,credential_ref,credential_version FROM finnor_os.communication_identities WHERE tenant_id=$1", [tenantId]);
    const communicationCredentialByKey = new Map(communicationCredentialRows.rows.map((row) => [row.identity_key, row]));
    const communicationCredentialDrift = (manifest.communicationIdentities ?? []).flatMap((expected) => {
      const actual = communicationCredentialByKey.get(expected.key);
      const desiredRef = expected.credential?.ref.replaceAll("{tenantId}", tenantId) ?? null;
      return !actual
        || actual.credential_provider !== (expected.credential?.provider ?? null)
        || actual.credential_ref !== desiredRef
        || actual.credential_version !== (expected.credential?.version ?? null) ? [expected.key] : [];
    });
    const authProfileCredentialRows = await pool.query<{
      auth_profile_ref: string; credential_provider: string | null; credential_ref: string | null; credential_version: string | null;
    }>("SELECT auth_profile_ref,credential_provider,credential_ref,credential_version FROM finnor_os.auth_profiles WHERE tenant_id=$1", [tenantId]);
    const authProfileCredentialByRef = new Map(authProfileCredentialRows.rows.map((row) => [row.auth_profile_ref, row]));
    const authProfileCredentialDrift = (manifest.authProfiles ?? []).flatMap((expected) => {
      const actual = authProfileCredentialByRef.get(expected.ref);
      const desiredRef = expected.credential?.ref.replaceAll("{tenantId}", tenantId) ?? null;
      return !actual
        || actual.credential_provider !== (expected.credential?.provider ?? null)
        || actual.credential_ref !== desiredRef
        || actual.credential_version !== (expected.credential?.version ?? null) ? [expected.ref] : [];
    });
    const credentialGateStatus: CertificationStatus = credentialDrift.length || communicationCredentialDrift.length || authProfileCredentialDrift.length
      ? "FAIL" : missingCredentialCapabilities.length ? "BLOCKED_CONFIG" : "PASS";
    gates.set("credential_references", gateResult("credential_references", credentialGateStatus, {
      missingCredentialCapabilities,
      credentialDrift,
      communicationCredentialDrift,
      authProfileCredentialDrift,
      references: integrationRows.rows.map((row) => ({ capability: row.capability, provider: row.credential_provider, configured: Boolean(row.credential_ref), referenceHash: row.credential_ref ? sha256(row.credential_ref) : null, versionConfigured: Boolean(row.credential_version) })),
      identityReferences: communicationCredentialRows.rows.map((row) => ({ identityKey: row.identity_key, provider: row.credential_provider, configured: Boolean(row.credential_ref), referenceHash: row.credential_ref ? sha256(row.credential_ref) : null, versionConfigured: Boolean(row.credential_version) })),
      authProfileReferences: authProfileCredentialRows.rows.map((row) => ({ authProfileRef: row.auth_profile_ref, provider: row.credential_provider, configured: Boolean(row.credential_ref), referenceHash: row.credential_ref ? sha256(row.credential_ref) : null, versionConfigured: Boolean(row.credential_version) })),
    }));

    const relevantProviders = manifest.requiredCapabilities.flatMap((capability) => {
      const expected = manifest.integrations.find((row) => row.capability === capability);
      const actual = integrationByCapability.get(capability);
      return expected && actual && expected.mode !== "emulator" && expected.binding !== "native" ? [actual] : [];
    });
    const maxAgeMs = (input.providerHealthMaxAgeMinutes ?? 30) * 60_000;
    const unprobed = relevantProviders.filter((row) => !row.last_check_at || Date.now() - row.last_check_at.getTime() > maxAgeMs || row.health === "unknown").map((row) => row.capability);
    const unhealthy = relevantProviders.filter((row) => row.health === "down" || row.health === "degraded").map((row) => ({ capability: row.capability, health: row.health }));
    const providerStatus: CertificationStatus = unhealthy.length ? "FAIL" : unprobed.length ? "BLOCKED_CONFIG" : "PASS";
    gates.set("tenant_provider_health", gateResult("tenant_provider_health", providerStatus, {
      requiredExternalProviders: relevantProviders.map((row) => row.capability), unprobed, unhealthy,
      health: Object.fromEntries(relevantProviders.map((row) => [row.capability, row.health])),
    }));

    const reusableImportGate = reusableGates.get("import_replay_safety");
    gates.set("import_replay_safety", reusableImportGate
      ?? await importReplayGate(
        manifest,
        tenantId,
        input.priorImportReplayGate?.status === "PASS" ? input.invalidatedImportKeys : undefined,
        input.priorImportReplayGate?.status === "PASS" ? input.priorImportReplayGate.evidenceHash : undefined,
      ));

    const authority = await pool.query<{ authority_states: number; unassigned_users: number; active_grants: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.authority_states WHERE tenant_id=$1) authority_states,
        (SELECT count(*)::int FROM finnor_os.users u WHERE u.tenant_id=$1 AND u.status='active'
          AND NOT EXISTS (SELECT 1 FROM finnor_os.employee_role_assignments a WHERE a.tenant_id=$1 AND a.employee_id=u.id AND a.active)) unassigned_users,
        (SELECT count(*)::int FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND effect='allow') active_grants`,
      [tenantId],
    );
    const authorityRow = authority.rows[0]!;
    const gatedPolicies = policies.rows.filter((row) => row.requires_confirmation).length;
    const authorityMissing = authorityRow.authority_states !== 1 || authorityRow.unassigned_users > 0 || (gatedPolicies > 0 && authorityRow.active_grants === 0);
    gates.set("approval_authority_configuration", gateResult("approval_authority_configuration", authorityMissing ? "BLOCKED_CONFIG" : "PASS", { ...authorityRow, gatedPolicies }));

    const runtime = await pool.query<{ heartbeat_age_seconds: number | null; heartbeat_meta: Record<string, unknown> | null; dead_letters: number; stale_running: number }>(
      `SELECT
        (SELECT extract(epoch FROM (now()-last_beat_at))::int FROM finnor_os.worker_heartbeat WHERE id='worker') heartbeat_age_seconds,
        (SELECT meta FROM finnor_os.worker_heartbeat WHERE id='worker') heartbeat_meta,
        (SELECT count(*)::int FROM finnor_os.jobs WHERE status='dead_letter'
          AND coalesce(payload->>'tenantId',payload->>'tenant_id')=$1) dead_letters,
        (SELECT count(*)::int FROM finnor_os.jobs WHERE status='running' AND started_at < now()-interval '15 minutes'
          AND coalesce(payload->>'tenantId',payload->>'tenant_id')=$1) stale_running`,
      [tenantId],
    );
    const runtimeRow = runtime.rows[0]!;
    const workerSha = typeof runtimeRow.heartbeat_meta?.releaseSha === "string" ? runtimeRow.heartbeat_meta.releaseSha : null;
    const workerCoreCertificationId = typeof runtimeRow.heartbeat_meta?.coreCertificationId === "string" ? runtimeRow.heartbeat_meta.coreCertificationId : null;
    const workerDeploymentId = typeof runtimeRow.heartbeat_meta?.deploymentId === "string" ? runtimeRow.heartbeat_meta.deploymentId : null;
    const workerProvenanceMissing = !workerSha || !workerCoreCertificationId || !workerDeploymentId;
    const workerProvenanceMismatch = Boolean(workerSha && workerSha !== input.canonicalCoreSha)
      || Boolean(workerCoreCertificationId && workerCoreCertificationId !== input.coreCertificationId);
    const runtimeStatus: CertificationStatus = runtimeRow.heartbeat_age_seconds === null ? "BLOCKED_CONFIG"
      : runtimeRow.heartbeat_age_seconds >= 90 || runtimeRow.dead_letters > 0 || runtimeRow.stale_running > 0 || workerProvenanceMismatch ? "FAIL"
        : workerProvenanceMissing ? "BLOCKED_CONFIG" : "PASS";
    gates.set("worker_runtime_health", gateResult("worker_runtime_health", runtimeStatus, {
      heartbeatPresent: runtimeRow.heartbeat_age_seconds !== null,
      heartbeatFresh: runtimeRow.heartbeat_age_seconds !== null && runtimeRow.heartbeat_age_seconds < 90,
      deadLetters: runtimeRow.dead_letters,
      staleRunning: runtimeRow.stale_running,
      worker: { releaseSha: workerSha, coreCertificationId: workerCoreCertificationId, deploymentIdConfigured: Boolean(workerDeploymentId) },
      workerProvenanceMissing,
      workerProvenanceMismatch,
    }));

    const deploymentHash = sha256(deploymentEvidenceProjection(input.deploymentEvidence));
    const reusableJourneyGate = reusableGates.get("water_treatment_journeys");
    const reusableReceiptsGate = reusableGates.get("evidence_receipts");
    const [journeyGate, receiptsGate] = reusableJourneyGate && reusableReceiptsGate
      ? [reusableJourneyGate, reusableReceiptsGate]
      : await receiptGates(pool, tenantId, input.canonicalCoreSha, deploymentHash, input.journeyEvidence);
    gates.set(journeyGate.gate, journeyGate);
    gates.set(receiptsGate.gate, receiptsGate);
  }

  // Non-mutating certification gates may retain prior PASS evidence when the impact
  // plan proves their exact inputs unchanged. Final completeness/core/runtime gates
  // are always recomputed against the current production identity.
  for (const [key, prior] of reusableGates) {
    if (!["configuration_completeness", "core_diff_guard", "worker_runtime_health"].includes(key) && gates.has(key)) {
      gates.set(key, prior);
    }
  }

  gates.set("core_diff_guard", gateResult("core_diff_guard", input.coreDiff.clean ? "PASS" : "FAIL", {
    canonicalCoreSha: input.coreDiff.canonicalCoreSha,
    coreSourceTreeHash: input.coreDiff.coreSourceTreeHash,
    changedSharedCorePaths: input.coreDiff.changedSharedCorePaths,
    changedClientPathCount: input.coreDiff.changedClientPaths.length,
  }));

  const identity = deploymentIdentity(input.deploymentEvidence);
  const deploymentStatus: CertificationStatus = !identity.commitSha || !identity.deploymentId || !identity.coreCertificationId || identity.traceable !== true
    ? "BLOCKED_CONFIG" : identity.commitSha !== input.canonicalCoreSha || identity.coreCertificationId !== input.coreCertificationId ? "FAIL" : "PASS";
  const prerequisites = [
    "manifest_config_validity", "tenant_identity_convergence", "user_isolation", "workspace_policies",
    "credential_references", "tenant_provider_health", "import_replay_safety", "required_integrations_capabilities",
    "approval_authority_configuration", "worker_runtime_health", "water_treatment_journeys", "evidence_receipts", "core_diff_guard",
  ].map((key) => gates.get(key)?.status ?? "FAIL");
  const ownerConfigured = manifest.users.some((user) => user.role === "owner" && user.status === "active");
  const migrationCompatible = dbIdentity.migrations.includes("0082_phase5_certification_releases.sql")
    && dbIdentity.migrations.includes("0085_phase1_identity_access_fabric.sql")
    && dbIdentity.migrations.includes("0091_phase6_final_certification.sql");
  const completenessStatus = combinedStatus([
    deploymentStatus,
    ownerConfigured ? "PASS" : "BLOCKED_CONFIG",
    migrationCompatible ? "PASS" : "FAIL",
    ...prerequisites,
  ]);
  gates.set("configuration_completeness", gateResult("configuration_completeness", completenessStatus, {
    deployment: { commitSha: identity.commitSha, deploymentIdConfigured: Boolean(identity.deploymentId), coreCertificationId: identity.coreCertificationId, traceable: identity.traceable, status: deploymentStatus },
    ownerConfigured,
    migrationCompatible,
    migrationVersion: dbIdentity.migrationVersion,
    incompleteGates: [...gates.values()].filter((gate) => gate.status !== "PASS").map((gate) => ({ gate: gate.gate, status: gate.status })),
  }));

  const ordered = CLIENT_GATE_KEYS.map((key) => gates.get(key) ?? gateResult(key, "FAIL", { reason: "gate did not run" }));
  const deployedIntegrations = (await pool.query<IntegrationRow>(
    tenantId ? "SELECT capability,binding,mode,config,credential_provider,credential_ref,credential_version,health,last_check_at FROM finnor_os.tenant_integrations WHERE tenant_id=$1" : "SELECT capability,binding,mode,config,credential_provider,credential_ref,credential_version,health,last_check_at FROM finnor_os.tenant_integrations WHERE false",
    tenantId ? [tenantId] : [],
  )).rows;
  const deployedByCapability = new Map(deployedIntegrations.map((row) => [row.capability, row]));
  const integrations: CredentialReferenceStatus[] = manifest.integrations.map((expected) => {
    const actual = deployedByCapability.get(expected.capability);
    return {
      capability: expected.capability,
      binding: actual?.binding ?? expected.binding,
      mode: actual?.mode ?? expected.mode,
      configured: Boolean(actual?.credential_ref),
      provider: actual?.credential_provider ?? null,
      referenceHash: actual?.credential_ref ? sha256(actual.credential_ref) : null,
      versionConfigured: Boolean(actual?.credential_version),
      health: actual?.health ?? "unknown",
    };
  });
  return {
    gates: ordered,
    tenantId,
    migrationVersion: dbIdentity.migrationVersion,
    schemaHash: dbIdentity.schemaHash,
    integrations,
  };
}
