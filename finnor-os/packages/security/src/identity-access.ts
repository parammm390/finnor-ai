import {
  applicationAccounts,
  authProfiles,
  communicationIdentities,
  communicationIdentityBindings,
  orgUnitMemberships,
  orgUnits,
  users,
  withTenant,
} from "@finnor/db";
import { canExerciseAuthority, evaluateAuthority } from "@finnor/authority";
import type {
  AvailableApplicationAccount,
  AvailableAuthProfile,
  AvailableCommunicationIdentity,
  CommunicationChannel,
  IdentityPrincipalRef,
  OperatingIdentityAccess,
  Role,
} from "@finnor/shared-types";
import { and, eq } from "drizzle-orm";
import {
  resolveCredentialReferenceContext,
  resolveTenantBoundSecretBundle,
  resolveTenantCredentialContext,
  TenantCredentialError,
  type TenantCredentialContext,
  type TenantCredentialProvider,
} from "./tenant-credentials";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_PROVIDERS = new Set<TenantCredentialProvider>([
  "quickbooks", "vapi", "stripe", "docusign", "ghl", "gmail", "resend", "meta_ads", "google_ads",
]);

export type IdentityAccessErrorCode =
  | "invalid_actor"
  | "actor_inactive"
  | "identity_not_found"
  | "auth_profile_not_found"
  | "identity_inactive"
  | "auth_profile_inactive"
  | "no_valid_identity"
  | "no_valid_auth_profile"
  | "ambiguous_identity"
  | "ambiguous_auth_profile"
  | "authority_denied";

export class IdentityAccessError extends Error {
  constructor(readonly code: IdentityAccessErrorCode, message: string) {
    super(message);
    this.name = "IdentityAccessError";
  }
}

export interface CredentialSubject {
  channel?: CommunicationChannel;
  communicationIdentityId?: string;
  authProfileRef?: string;
  application?: string;
}

export interface GovernedCredentialContext<P extends TenantCredentialProvider = TenantCredentialProvider>
  extends TenantCredentialContext<P> {
  readonly access: Readonly<{
    kind: "communication_identity" | "auth_profile" | "legacy_tenant_integration";
    purpose: string;
    principalRef: IdentityPrincipalRef;
    authorityDecisionId: string;
    communicationIdentityId?: string;
    authProfileRef?: string;
    applicationAccountId?: string;
  }>;
}

interface ActorScope {
  actorId: string;
  employeeId: string | null;
  role: Role;
  teamIds: Set<string>;
  locationIds: Set<string>;
  system: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function tenantCredentialProvider(value: string): value is TenantCredentialProvider {
  return CREDENTIAL_PROVIDERS.has(value as TenantCredentialProvider);
}

async function loadActorScope(tenantId: string, actorId: string): Promise<ActorScope> {
  if (actorId.startsWith("system:")) {
    return { actorId, employeeId: null, role: "owner", teamIds: new Set(), locationIds: new Set(), system: true };
  }
  if (!UUID.test(actorId)) throw new IdentityAccessError("invalid_actor", "A canonical employee identity is required for governed access");
  const loaded = await withTenant(tenantId, async (db) => {
    const [employee] = await db.select({
      id: users.id,
      role: users.role,
      status: users.status,
      primaryLocationId: users.primaryLocationId,
    }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, actorId))).limit(1);
    const memberships = !employee ? [] : await db.select({
      teamId: orgUnitMemberships.orgUnitId,
      locationId: orgUnits.locationId,
    }).from(orgUnitMemberships).innerJoin(orgUnits, and(
      eq(orgUnits.tenantId, tenantId),
      eq(orgUnits.id, orgUnitMemberships.orgUnitId),
      eq(orgUnits.active, true),
    )).where(and(
      eq(orgUnitMemberships.tenantId, tenantId),
      eq(orgUnitMemberships.employeeId, actorId),
      eq(orgUnitMemberships.active, true),
    ));
    return { employee, memberships };
  }, actorId);
  if (!loaded.employee) throw new IdentityAccessError("invalid_actor", "The canonical employee does not belong to this tenant");
  if (loaded.employee.status !== "active") throw new IdentityAccessError("actor_inactive", "The canonical employee is not active");
  if (loaded.employee.role !== "owner") throw new IdentityAccessError("actor_inactive", "The employee role is retired from the active runtime");
  return {
    actorId,
    employeeId: actorId,
    role: "owner",
    teamIds: new Set(loaded.memberships.map((row) => row.teamId)),
    locationIds: new Set([
      ...(loaded.employee.primaryLocationId ? [loaded.employee.primaryLocationId] : []),
      ...loaded.memberships.flatMap((row) => row.locationId ? [row.locationId] : []),
    ]),
    system: false,
  };
}

function relation(principal: IdentityPrincipalRef, tenantId: string, actor: ActorScope): { rank: number; crossPrincipal: boolean } {
  if (principal.type === "employee" && principal.id === actor.employeeId) return { rank: 0, crossPrincipal: false };
  if (principal.type === "team" && actor.teamIds.has(principal.id)) return { rank: 1, crossPrincipal: false };
  if (principal.type === "location" && actor.locationIds.has(principal.id)) return { rank: 2, crossPrincipal: false };
  if (principal.type === "tenant" && principal.id === tenantId) return { rank: 3, crossPrincipal: false };
  return { rank: 4, crossPrincipal: true };
}

function purposeRank(bindingPurpose: string, requestedPurpose: string): number | null {
  if (bindingPurpose === requestedPurpose) return 0;
  if (bindingPurpose === "default") return 1;
  if (bindingPurpose === "*") return 2;
  return null;
}

async function authorize(params: {
  tenantId: string;
  actor: ActorScope;
  crossPrincipal: boolean;
  kind: "identity" | "account";
  resourceId: string;
}): Promise<string | null> {
  const decision = await evaluateAuthority({
    tenantId: params.tenantId,
    userId: params.actor.actorId,
    ...(params.actor.employeeId ? { employeeId: params.actor.employeeId } : {}),
    role: params.actor.role,
  }, {
    operation: "execution",
    capability: `${params.kind}:${params.crossPrincipal ? "act_as" : "use"}`,
    resource: { type: params.kind === "identity" ? "communication_identity" : "application_account", id: params.resourceId },
    risk: "medium",
  });
  return decision.outcome === "allowed" ? decision.id : null;
}

async function canUse(params: {
  tenantId: string;
  actor: ActorScope;
  crossPrincipal: boolean;
  kind: "identity" | "account";
  resourceId: string;
}): Promise<boolean> {
  return canExerciseAuthority({
    tenantId: params.tenantId,
    userId: params.actor.actorId,
    ...(params.actor.employeeId ? { employeeId: params.actor.employeeId } : {}),
    role: params.actor.role,
  }, {
    operation: "execution",
    capability: `${params.kind}:${params.crossPrincipal ? "act_as" : "use"}`,
    resource: { type: params.kind === "identity" ? "communication_identity" : "application_account", id: params.resourceId },
    risk: "medium",
  });
}

function withAccess<P extends TenantCredentialProvider>(
  credential: TenantCredentialContext<P>,
  access: GovernedCredentialContext<P>["access"],
): GovernedCredentialContext<P> {
  return Object.freeze({ ...credential, access: Object.freeze(access) });
}

type CommunicationCandidate = {
  bindingId: string;
  identityId: string;
  identityKey: string;
  provider: string;
  channel: CommunicationChannel;
  address: string | null;
  providerIdentityRef: string | null;
  identityStatus: "active" | "disabled" | "suspended";
  capabilities: unknown;
  credentialProvider: "aws-secrets-manager" | "legacy-env" | null;
  credentialRef: string | null;
  credentialVersion: string | null;
  authProfileId: string | null;
  linkedAuthProfileRef: string | null;
  linkedCredentialProvider: "aws-secrets-manager" | "os-keychain" | "legacy-env" | null;
  linkedCredentialRef: string | null;
  linkedCredentialVersion: string | null;
  linkedProfileStatus: "active" | "disabled" | "suspended" | null;
  linkedConnectionStatus: string | null;
  principalType: IdentityPrincipalRef["type"];
  principalId: string;
  purpose: string;
  priority: number;
  bindingStatus: "active" | "disabled";
};

async function communicationRows(tenantId: string): Promise<CommunicationCandidate[]> {
  return withTenant(tenantId, (db) => db.select({
    bindingId: communicationIdentityBindings.id,
    identityId: communicationIdentities.id,
    identityKey: communicationIdentities.identityKey,
    provider: communicationIdentities.provider,
    channel: communicationIdentities.channel,
    address: communicationIdentities.address,
    providerIdentityRef: communicationIdentities.providerIdentityRef,
    identityStatus: communicationIdentities.status,
    capabilities: communicationIdentities.capabilities,
    credentialProvider: communicationIdentities.credentialProvider,
    credentialRef: communicationIdentities.credentialRef,
    credentialVersion: communicationIdentities.credentialVersion,
    authProfileId: communicationIdentities.authProfileId,
    linkedAuthProfileRef: authProfiles.authProfileRef,
    linkedCredentialProvider: authProfiles.credentialProvider,
    linkedCredentialRef: authProfiles.credentialRef,
    linkedCredentialVersion: authProfiles.credentialVersion,
    linkedProfileStatus: authProfiles.status,
    linkedConnectionStatus: authProfiles.connectionStatus,
    principalType: communicationIdentityBindings.principalType,
    principalId: communicationIdentityBindings.principalId,
    purpose: communicationIdentityBindings.purpose,
    priority: communicationIdentityBindings.priority,
    bindingStatus: communicationIdentityBindings.status,
  }).from(communicationIdentityBindings).innerJoin(communicationIdentities, and(
    eq(communicationIdentities.tenantId, tenantId),
    eq(communicationIdentities.id, communicationIdentityBindings.communicationIdentityId),
  )).leftJoin(authProfiles, and(
    eq(authProfiles.tenantId, tenantId),
    eq(authProfiles.id, communicationIdentities.authProfileId),
  )).where(eq(communicationIdentityBindings.tenantId, tenantId))) as Promise<CommunicationCandidate[]>;
}

function communicationMetadata(provider: TenantCredentialProvider, row: CommunicationCandidate): Record<string, unknown> {
  const providerRef = row.providerIdentityRef && !row.providerIdentityRef.startsWith("integration:")
    ? row.providerIdentityRef
    : undefined;
  if (provider === "gmail") return row.address ? { user: row.address } : {};
  if (provider === "resend") return row.address ? { fromAddress: row.address } : {};
  if (provider === "vapi") return providerRef ? { phoneNumberId: providerRef } : {};
  if (provider === "ghl") return providerRef ? { locationId: providerRef } : {};
  return {};
}

async function communicationCredentialAvailable(tenantId: string, row: CommunicationCandidate): Promise<boolean> {
  if (!tenantCredentialProvider(row.provider)) return false;
  if (row.authProfileId && row.linkedCredentialProvider === "os-keychain") return false;
  try {
    await resolveCredentialReferenceContext(tenantId, row.provider, {
      credentialProvider: row.authProfileId ? row.linkedCredentialProvider as "aws-secrets-manager" | "legacy-env" | null : row.credentialProvider,
      credentialRef: row.authProfileId ? row.linkedCredentialRef : row.credentialRef,
      credentialVersion: row.authProfileId ? row.linkedCredentialVersion : row.credentialVersion,
      publicMetadata: communicationMetadata(row.provider, row),
      integration: { id: row.identityId, capability: "communications", binding: row.provider },
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveCommunication<P extends TenantCredentialProvider>(params: {
  tenantId: string;
  actor: ActorScope;
  provider: P;
  purpose: string;
  channel: CommunicationChannel;
  explicitId?: string;
}): Promise<GovernedCredentialContext<P>> {
  const all = await communicationRows(params.tenantId);
  if (params.explicitId && !all.some((row) => row.identityId === params.explicitId)) {
    throw new IdentityAccessError("identity_not_found", "The requested communication identity is unavailable in this tenant");
  }
  if (params.explicitId && all.some((row) => row.identityId === params.explicitId && row.identityStatus !== "active")) {
    throw new IdentityAccessError("identity_inactive", "The requested communication identity is not active");
  }

  const candidates = all.flatMap((row) => {
    if (params.explicitId && row.identityId !== params.explicitId) return [];
    if (row.identityStatus !== "active" || row.bindingStatus !== "active") return [];
    if (row.authProfileId && (row.linkedProfileStatus !== "active" || row.linkedCredentialProvider === "os-keychain" || !["active", "degraded"].includes(row.linkedConnectionStatus ?? ""))) return [];
    if (row.provider !== params.provider || row.channel !== params.channel) return [];
    const purpose = purposeRank(row.purpose, params.purpose);
    if (purpose === null) return [];
    const principalRef: IdentityPrincipalRef = { type: row.principalType, id: row.principalId };
    const related = relation(principalRef, params.tenantId, params.actor);
    if (!params.explicitId && related.crossPrincipal) return [];
    return [{ row, principalRef, related, score: [related.rank, purpose, -row.priority] as const }];
  }).sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || a.score[2] - b.score[2] || a.row.identityKey.localeCompare(b.row.identityKey));

  for (let cursor = 0; cursor < candidates.length;) {
    const score = candidates[cursor]!.score;
    const group = candidates.filter((candidate) => candidate.score[0] === score[0] && candidate.score[1] === score[1] && candidate.score[2] === score[2]);
    const allowed: Array<{ candidate: typeof group[number]; decisionId: string }> = [];
    for (const candidate of group) {
      const decisionId = await authorize({
        tenantId: params.tenantId,
        actor: params.actor,
        crossPrincipal: candidate.related.crossPrincipal,
        kind: "identity",
        resourceId: candidate.row.identityId,
      });
      if (decisionId) allowed.push({ candidate, decisionId });
    }
    const identities = new Set(allowed.map(({ candidate }) => candidate.row.identityId));
    if (identities.size > 1) throw new IdentityAccessError("ambiguous_identity", "Multiple equally preferred communication identities are permitted; configure a unique priority");
    if (allowed.length > 0) {
      const selected = allowed.sort((a, b) => a.candidate.row.bindingId.localeCompare(b.candidate.row.bindingId))[0]!;
      const row = selected.candidate.row;
      const credential = await resolveCredentialReferenceContext(params.tenantId, params.provider, {
        credentialProvider: row.authProfileId ? row.linkedCredentialProvider as "aws-secrets-manager" | "legacy-env" | null : row.credentialProvider,
        credentialRef: row.authProfileId ? row.linkedCredentialRef : row.credentialRef,
        credentialVersion: row.authProfileId ? row.linkedCredentialVersion : row.credentialVersion,
        publicMetadata: communicationMetadata(params.provider, row),
        integration: { id: row.identityId, capability: "communications", binding: row.provider },
      });
      return withAccess(credential, {
        kind: "communication_identity",
        purpose: params.purpose,
        principalRef: selected.candidate.principalRef,
        authorityDecisionId: selected.decisionId,
        communicationIdentityId: row.identityId,
        ...(row.linkedAuthProfileRef ? { authProfileRef: row.linkedAuthProfileRef } : {}),
      });
    }
    cursor += group.length;
  }

  if (params.explicitId) throw new IdentityAccessError("authority_denied", "The actor is not authorized to use the requested communication identity");

  // Once a provider/channel has canonical rows, that configuration is authoritative.
  // In particular, a disabled sender or another employee's sender must never fall
  // through to the old tenant-wide integration and become an accidental shared one.
  if (all.some((row) => row.provider === params.provider && row.channel === params.channel)) {
    throw new IdentityAccessError("no_valid_identity", "No permitted communication identity is configured for this channel and purpose");
  }

  // Backward compatibility is intentionally narrow: an explicit tenant integration
  // row may operate as a shared-company identity while old manifests converge. A
  // process-wide env credential with no tenant row is never accepted here.
  try {
    const credential = await resolveTenantCredentialContext(params.tenantId, params.provider);
    if (!credential.integration.id) throw new IdentityAccessError("no_valid_identity", "No governed communication identity is configured");
    const authorityDecisionId = await authorize({
      tenantId: params.tenantId,
      actor: params.actor,
      crossPrincipal: false,
      kind: "identity",
      resourceId: credential.integration.id,
    });
    if (!authorityDecisionId) throw new IdentityAccessError("authority_denied", "The actor is not authorized to use the configured shared communication integration");
    return withAccess(credential, {
      kind: "legacy_tenant_integration",
      purpose: params.purpose,
      principalRef: { type: "tenant", id: params.tenantId },
      authorityDecisionId,
      communicationIdentityId: credential.integration.id,
    });
  } catch (error) {
    if (error instanceof IdentityAccessError) throw error;
    if (error instanceof TenantCredentialError) throw new IdentityAccessError("no_valid_identity", "No governed communication identity is configured for this channel and purpose");
    throw error;
  }
}

type AuthCandidate = {
  profileId: string;
  authProfileRef: string;
  principalType: IdentityPrincipalRef["type"];
  principalId: string;
  accountId: string;
  accountKey: string;
  application: string;
  provider: string;
  displayName: string;
  providerAccountRef: string | null;
  accountStatus: "active" | "disabled" | "suspended";
  accountCapabilities: unknown;
  accountMetadata: unknown;
  purpose: string;
  priority: number;
  scope: unknown;
  credentialProvider: "aws-secrets-manager" | "aws-iam-federated" | "os-keychain" | "legacy-env" | null;
  credentialRef: string | null;
  credentialVersion: string | null;
  profileStatus: "active" | "disabled" | "suspended";
  authMethod: "managed_secret" | "oauth2" | "browser_profile" | "workload_identity";
  connectionStatus: string;
  requiredScopes: unknown;
  grantedScopes: unknown;
  profileCapabilities: unknown;
  restrictions: unknown;
};

async function authRows(tenantId: string): Promise<AuthCandidate[]> {
  return withTenant(tenantId, (db) => db.select({
    profileId: authProfiles.id,
    authProfileRef: authProfiles.authProfileRef,
    principalType: authProfiles.principalType,
    principalId: authProfiles.principalId,
    accountId: applicationAccounts.id,
    accountKey: applicationAccounts.accountKey,
    application: applicationAccounts.application,
    provider: applicationAccounts.provider,
    displayName: applicationAccounts.displayName,
    providerAccountRef: applicationAccounts.providerAccountRef,
    accountStatus: applicationAccounts.status,
    accountCapabilities: applicationAccounts.capabilities,
    accountMetadata: applicationAccounts.metadata,
    purpose: authProfiles.purpose,
    priority: authProfiles.priority,
    scope: authProfiles.scope,
    credentialProvider: authProfiles.credentialProvider,
    credentialRef: authProfiles.credentialRef,
    credentialVersion: authProfiles.credentialVersion,
    profileStatus: authProfiles.status,
    authMethod: authProfiles.authMethod,
    connectionStatus: authProfiles.connectionStatus,
    requiredScopes: authProfiles.requiredScopes,
    grantedScopes: authProfiles.grantedScopes,
    profileCapabilities: authProfiles.capabilities,
    restrictions: authProfiles.restrictions,
  }).from(authProfiles).innerJoin(applicationAccounts, and(
    eq(applicationAccounts.tenantId, tenantId),
    eq(applicationAccounts.id, authProfiles.applicationAccountId),
  )).where(eq(authProfiles.tenantId, tenantId))) as Promise<AuthCandidate[]>;
}

function restrictionsAllow(row: AuthCandidate, actorId: string, purpose: string): boolean {
  const restrictions = object(row.restrictions);
  const denied = strings(restrictions.deniedPurposes);
  if (denied.includes(purpose) || denied.includes("*")) return false;
  const allowedPurposes = strings(restrictions.allowedPurposes);
  if (allowedPurposes.length > 0 && !allowedPurposes.includes(purpose) && !allowedPurposes.includes("*")) return false;
  const allowedActors = strings(restrictions.allowedActorIds);
  return allowedActors.length === 0 || allowedActors.includes(actorId);
}

function accountMetadata(provider: TenantCredentialProvider, row: AuthCandidate): Record<string, unknown> {
  const metadata = object(row.accountMetadata);
  if (!row.providerAccountRef) return metadata;
  const key = provider === "quickbooks" ? "realmId"
    : provider === "docusign" ? "accountId"
      : provider === "meta_ads" ? "accountId"
        : provider === "google_ads" ? "customerId"
          : provider === "ghl" ? "locationId"
            : "providerAccountRef";
  return { ...metadata, [key]: row.providerAccountRef };
}

async function authProfileCredentialAvailable(tenantId: string, row: AuthCandidate): Promise<boolean> {
  try {
    if (row.credentialProvider === "aws-iam-federated") {
      const scope = object(row.scope);
      const account = object(row.accountMetadata);
      return row.authMethod === "workload_identity"
        && row.credentialRef === null
        && row.credentialVersion === null
        && typeof scope.awsRegion === "string"
        && typeof scope.federationAudience === "string"
        && typeof scope.federationConfigId === "string"
        && ["ES384", "RS256"].includes(String(scope.signingAlgorithm))
        && typeof account.directoryTenantId === "string"
        && typeof account.applicationClientId === "string";
    }
    if (row.authMethod === "browser_profile" || row.credentialProvider === "os-keychain") {
      const bundle = await resolveTenantBoundSecretBundle(tenantId, {
        credentialProvider: row.credentialProvider,
        credentialRef: row.credentialRef,
        credentialVersion: row.credentialVersion,
      });
      return Boolean(
        (typeof (bundle.steelProfileId ?? bundle.profileId) === "string" && String(bundle.steelProfileId ?? bundle.profileId).trim())
        || (typeof (bundle.steelNamespace ?? bundle.namespace) === "string" && String(bundle.steelNamespace ?? bundle.namespace).trim()),
      );
    }
    if (!tenantCredentialProvider(row.provider)) return false;
    await resolveCredentialReferenceContext(tenantId, row.provider, {
      credentialProvider: row.credentialProvider as "aws-secrets-manager" | "legacy-env" | null,
      credentialRef: row.credentialRef,
      credentialVersion: row.credentialVersion,
      publicMetadata: accountMetadata(row.provider, row),
      integration: { id: row.profileId, capability: row.application, binding: row.provider },
    });
    return true;
  } catch {
    return false;
  }
}

interface SelectedAuthProfile {
  row: AuthCandidate;
  principalRef: IdentityPrincipalRef;
  decisionId: string;
}

async function selectApplicationAccess(params: {
  tenantId: string;
  actor: ActorScope;
  provider?: string;
  application: string;
  purpose: string;
  authProfileRef?: string;
  connectionSetup?: boolean;
}): Promise<SelectedAuthProfile | null> {
  const all = await authRows(params.tenantId);
  if (params.authProfileRef && !all.some((row) => row.authProfileRef === params.authProfileRef)) {
    throw new IdentityAccessError("auth_profile_not_found", "The requested authProfileRef is unavailable in this tenant");
  }
  if (params.authProfileRef && all.some((row) => row.authProfileRef === params.authProfileRef && (row.profileStatus !== "active" || row.accountStatus !== "active" || (!params.connectionSetup && !["active", "degraded"].includes(row.connectionStatus)) || (params.connectionSetup && row.connectionStatus === "disabled")))) {
    throw new IdentityAccessError("auth_profile_inactive", "The requested auth profile or application account is not active");
  }
  const candidates = all.flatMap((row) => {
    if (params.authProfileRef && row.authProfileRef !== params.authProfileRef) return [];
    if (row.profileStatus !== "active" || row.accountStatus !== "active") return [];
    if (params.connectionSetup ? row.connectionStatus === "disabled" : !["active", "degraded"].includes(row.connectionStatus)) return [];
    if ((params.provider && row.provider !== params.provider) || row.application !== params.application) return [];
    if (!restrictionsAllow(row, params.actor.actorId, params.purpose)) return [];
    const purpose = params.connectionSetup ? 0 : purposeRank(row.purpose, params.purpose);
    if (purpose === null) return [];
    const principalRef: IdentityPrincipalRef = { type: row.principalType, id: row.principalId };
    const related = relation(principalRef, params.tenantId, params.actor);
    if (!params.authProfileRef && related.crossPrincipal) return [];
    return [{ row, principalRef, related, score: [related.rank, purpose, -row.priority] as const }];
  }).sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || a.score[2] - b.score[2] || a.row.authProfileRef.localeCompare(b.row.authProfileRef));

  for (let cursor = 0; cursor < candidates.length;) {
    const score = candidates[cursor]!.score;
    const group = candidates.filter((candidate) => candidate.score[0] === score[0] && candidate.score[1] === score[1] && candidate.score[2] === score[2]);
    const allowed: Array<{ candidate: typeof group[number]; decisionId: string }> = [];
    for (const candidate of group) {
      const decisionId = await authorize({
        tenantId: params.tenantId,
        actor: params.actor,
        crossPrincipal: candidate.related.crossPrincipal,
        kind: "account",
        resourceId: candidate.row.accountId,
      });
      if (decisionId) allowed.push({ candidate, decisionId });
    }
    const profiles = new Set(allowed.map(({ candidate }) => candidate.row.authProfileRef));
    if (profiles.size > 1) throw new IdentityAccessError("ambiguous_auth_profile", "Multiple equally preferred auth profiles are permitted; configure a unique purpose or priority");
    if (allowed.length > 0) {
      const selected = allowed.sort((a, b) => a.candidate.row.profileId.localeCompare(b.candidate.row.profileId))[0]!;
      return { row: selected.candidate.row, principalRef: selected.candidate.principalRef, decisionId: selected.decisionId };
    }
    cursor += group.length;
  }
  if (params.authProfileRef) throw new IdentityAccessError("authority_denied", "The actor is not authorized to use the requested authProfileRef");

  if (all.some((row) => (!params.provider || row.provider === params.provider) && row.application === params.application)) {
    throw new IdentityAccessError("no_valid_auth_profile", "No permitted application account/auth profile is configured for this purpose");
  }
  return null;
}

async function resolveApplication<P extends TenantCredentialProvider>(params: {
  tenantId: string;
  actor: ActorScope;
  provider: P;
  application: string;
  purpose: string;
  authProfileRef?: string;
}): Promise<GovernedCredentialContext<P>> {
  const selected = await selectApplicationAccess(params);
  if (selected) {
    const row = selected.row;
    if (row.credentialProvider === "aws-iam-federated" || row.authMethod === "workload_identity") {
      throw new IdentityAccessError("no_valid_auth_profile", "Secretless provider auth must use its tenant-bound provider auth resolver");
    }
    if (row.credentialProvider === "os-keychain") {
      throw new IdentityAccessError("no_valid_auth_profile", "OS Keychain auth profiles are restricted to governed computer execution");
    }
    const credential = await resolveCredentialReferenceContext(params.tenantId, params.provider, {
      credentialProvider: row.credentialProvider,
      credentialRef: row.credentialRef,
      credentialVersion: row.credentialVersion,
      publicMetadata: accountMetadata(params.provider, row),
      integration: { id: row.profileId, capability: row.application, binding: row.provider },
    });
    return withAccess(credential, {
      kind: "auth_profile",
      purpose: params.purpose,
      principalRef: selected.principalRef,
      authorityDecisionId: selected.decisionId,
      authProfileRef: row.authProfileRef,
      applicationAccountId: row.accountId,
    });
  }

  try {
    const credential = await resolveTenantCredentialContext(params.tenantId, params.provider);
    if (!credential.integration.id) throw new IdentityAccessError("no_valid_auth_profile", "No governed auth profile is configured");
    const authorityDecisionId = await authorize({
      tenantId: params.tenantId,
      actor: params.actor,
      crossPrincipal: false,
      kind: "account",
      resourceId: credential.integration.id,
    });
    if (!authorityDecisionId) throw new IdentityAccessError("authority_denied", "The actor is not authorized to use the configured shared application integration");
    return withAccess(credential, {
      kind: "legacy_tenant_integration",
      purpose: params.purpose,
      principalRef: { type: "tenant", id: params.tenantId },
      authorityDecisionId,
      authProfileRef: `legacy-${credential.integration.id}`,
      applicationAccountId: credential.integration.id,
    });
  } catch (error) {
    if (error instanceof IdentityAccessError) throw error;
    if (error instanceof TenantCredentialError) throw new IdentityAccessError("no_valid_auth_profile", "No governed application account/auth profile is configured for this purpose");
    throw error;
  }
}

/** Deterministic runtime boundary requested by Phase 1:
 * actor -> intended principal/account -> Employee Authority -> binding/profile ->
 * credential reference -> typed secret context. The subject contains safe handles
 * only; callers can never supply a credential reference. */
export async function resolveCredentialContext<P extends TenantCredentialProvider>(
  tenantId: string,
  actorId: string,
  providerOrApplication: P,
  purpose: string,
  subject: CredentialSubject,
): Promise<GovernedCredentialContext<P>> {
  const actor = await loadActorScope(tenantId, actorId);
  if (subject.channel) {
    return resolveCommunication({
      tenantId,
      actor,
      provider: providerOrApplication,
      purpose,
      channel: subject.channel,
      ...(subject.communicationIdentityId ? { explicitId: subject.communicationIdentityId } : {}),
    });
  }
  return resolveApplication({
    tenantId,
    actor,
    provider: providerOrApplication,
    application: subject.application ?? providerOrApplication,
    purpose,
    ...(subject.authProfileRef ? { authProfileRef: subject.authProfileRef } : {}),
  });
}

export interface ResolvedAuthProfileAccess {
  authProfileRef: string;
  applicationAccount: AvailableApplicationAccount;
  principalRef: IdentityPrincipalRef;
  purpose: string;
  status: "active";
  capabilities: string[];
  restrictions: Record<string, unknown>;
  authorityDecisionId: string;
}

/** Select a governed application profile even when the application adapter will be
 * implemented in a later phase (for example a supplier portal). This projection is
 * safe for planning: it proves the selected authProfileRef and account metadata but
 * deliberately cannot expose the profile's credential provider/ref/version. */
export async function resolveAuthProfileRef(
  tenantId: string,
  actorId: string,
  application: string,
  purpose: string,
  authProfileRef?: string,
): Promise<ResolvedAuthProfileAccess> {
  const actor = await loadActorScope(tenantId, actorId);
  const selected = await selectApplicationAccess({
    tenantId,
    actor,
    application,
    purpose,
    ...(authProfileRef ? { authProfileRef } : {}),
  });
  if (!selected) throw new IdentityAccessError("no_valid_auth_profile", "No governed auth profile is configured for this application and purpose");
  const row = selected.row;
  return {
    authProfileRef: row.authProfileRef,
    applicationAccount: {
      id: row.accountId,
      key: row.accountKey,
      application: row.application,
      provider: row.provider,
      displayName: row.displayName,
      providerAccountRef: row.providerAccountRef,
      status: "active",
      capabilities: strings(row.accountCapabilities),
    },
    principalRef: selected.principalRef,
    purpose,
    status: "active",
    capabilities: strings(row.profileCapabilities),
    restrictions: object(row.restrictions),
    authorityDecisionId: selected.decisionId,
  };
}

/** Authorize connection administration against the same canonical employee/account
 * graph without pretending a disconnected profile is already runtime-usable. */
export async function authorizeAuthProfileConnection(
  tenantId: string,
  actorId: string,
  application: string,
  authProfileRef: string,
): Promise<ResolvedAuthProfileAccess> {
  const actor = await loadActorScope(tenantId, actorId);
  const selected = await selectApplicationAccess({
    tenantId,
    actor,
    application,
    purpose: "connection_admin",
    authProfileRef,
    connectionSetup: true,
  });
  if (!selected) throw new IdentityAccessError("authority_denied", "The actor is not authorized to administer this auth profile");
  const row = selected.row;
  return {
    authProfileRef: row.authProfileRef,
    applicationAccount: {
      id: row.accountId,
      key: row.accountKey,
      application: row.application,
      provider: row.provider,
      displayName: row.displayName,
      providerAccountRef: row.providerAccountRef,
      status: "active",
      capabilities: strings(row.accountCapabilities),
    },
    principalRef: selected.principalRef,
    purpose: "connection_admin",
    status: "active",
    capabilities: strings(row.profileCapabilities),
    restrictions: object(row.restrictions),
    authorityDecisionId: selected.decisionId,
  };
}

/** Authorize a consequential integration-configuration mutation before an
 * application account exists (or when the mutation addresses the tenant-wide
 * integration surface rather than one credential profile). The decision is
 * durable in Employee Authority and is returned for the caller's audit record. */
export async function authorizeIntegrationAdministration(
  tenantId: string,
  actorId: string,
  integrationId?: string,
): Promise<{ authorityDecisionId: string; authorityRevision: number }> {
  const actor = await loadActorScope(tenantId, actorId);
  const decision = await evaluateAuthority({
    tenantId,
    userId: actor.actorId,
    ...(actor.employeeId ? { employeeId: actor.employeeId } : {}),
    role: actor.role,
  }, {
    operation: "execution",
    capability: "action:manage_integrations",
    resource: integrationId
      ? { type: "tenant_integration", id: integrationId }
      : { type: "tenant", id: tenantId },
    risk: "high",
  });
  if (decision.outcome !== "allowed") {
    throw new IdentityAccessError("authority_denied", "The actor is not authorized to change integration coverage");
  }
  return { authorityDecisionId: decision.id, authorityRevision: decision.authorityRevision };
}

export interface ResolvedComputerAuthProfile {
  profileId: string;
  authProfileRef: string;
  applicationAccountId: string;
  application: string;
  principalRef: IdentityPrincipalRef;
  purpose: string;
  capabilities: string[];
  restrictions: Record<string, unknown>;
  accountMetadata: Record<string, unknown>;
  authorityDecisionId: string;
  /** Credential-sensitive Steel restoration handles. Runtime memory only. */
  steelSessionAuth: Readonly<{ profileId?: string; namespace?: string }>;
}

/** Resolves actor -> application account -> auth profile -> authority -> tenant-bound
 * managed secret for a computer run. Only Steel restoration handles survive the
 * narrowing step; passwords, cookies, tokens, and arbitrary secret fields never
 * cross this boundary or reach planner-visible projections. */
export async function resolveComputerAuthProfile(
  tenantId: string,
  actorId: string,
  application: string,
  purpose: string,
  authProfileRef: string,
): Promise<ResolvedComputerAuthProfile> {
  const actor = await loadActorScope(tenantId, actorId);
  const selected = await selectApplicationAccess({ tenantId, actor, application, purpose, authProfileRef });
  if (!selected) throw new IdentityAccessError("no_valid_auth_profile", "No governed auth profile is configured for this application and purpose");
  const row = selected.row;
  if (row.credentialProvider === "aws-iam-federated" || row.authMethod === "workload_identity") {
    throw new IdentityAccessError("no_valid_auth_profile", "A workload-identity profile cannot be used for governed browser execution");
  }
  const bundle = await resolveTenantBoundSecretBundle(tenantId, {
    credentialProvider: row.credentialProvider,
    credentialRef: row.credentialRef,
    credentialVersion: row.credentialVersion,
  });
  const profileId = bundle.steelProfileId ?? bundle.profileId;
  const namespace = bundle.steelNamespace ?? bundle.namespace;
  if (!profileId && !namespace) {
    throw new IdentityAccessError("no_valid_auth_profile", "The governed auth profile does not contain a Steel profile or credential namespace");
  }
  return Object.freeze({
    profileId: row.profileId,
    authProfileRef: row.authProfileRef,
    applicationAccountId: row.accountId,
    application: row.application,
    principalRef: selected.principalRef,
    purpose,
    capabilities: strings(row.profileCapabilities),
    restrictions: object(row.restrictions),
    accountMetadata: object(row.accountMetadata),
    authorityDecisionId: selected.decisionId,
    steelSessionAuth: Object.freeze({
      ...(typeof profileId === "string" && profileId.trim() ? { profileId: profileId.trim() } : {}),
      ...(typeof namespace === "string" && namespace.trim() ? { namespace: namespace.trim() } : {}),
    }),
  });
}

/** Bounded, secret-free Operating Context projection. It lists only the actor's own,
 * active-team, active-location, or tenant/shared bindings. Cross-principal act-as
 * profiles remain execution-only and are revealed only when explicitly authorized. */
export async function listAvailableIdentityAccess(tenantId: string, actorId: string): Promise<OperatingIdentityAccess> {
  const actor = await loadActorScope(tenantId, actorId);
  const [communications, profiles] = await Promise.all([communicationRows(tenantId), authRows(tenantId)]);
  const communicationIdentitiesSafe: AvailableCommunicationIdentity[] = [];
  for (const row of communications) {
    if (row.bindingStatus !== "active" || row.identityStatus !== "active") continue;
    if (row.authProfileId && (row.linkedProfileStatus !== "active" || !["active", "degraded"].includes(row.linkedConnectionStatus ?? ""))) continue;
    const principalRef: IdentityPrincipalRef = { type: row.principalType, id: row.principalId };
    const related = relation(principalRef, tenantId, actor);
    if (related.crossPrincipal) continue;
    if (!await communicationCredentialAvailable(tenantId, row)) continue;
    if (!await canUse({ tenantId, actor, crossPrincipal: false, kind: "identity", resourceId: row.identityId })) continue;
    communicationIdentitiesSafe.push({
      id: row.identityId,
      key: row.identityKey,
      provider: row.provider,
      channel: row.channel,
      address: row.address,
      providerIdentityRef: row.providerIdentityRef,
      status: row.identityStatus,
      capabilities: strings(row.capabilities),
      principalRef,
      purpose: row.purpose,
      priority: row.priority,
    });
  }
  const accountMap = new Map<string, AvailableApplicationAccount>();
  const authProfilesSafe: AvailableAuthProfile[] = [];
  for (const row of profiles) {
    const principalRef: IdentityPrincipalRef = { type: row.principalType, id: row.principalId };
    const related = relation(principalRef, tenantId, actor);
    if (related.crossPrincipal) continue;
    if (row.accountStatus !== "active" || row.profileStatus !== "active" || !["active", "degraded"].includes(row.connectionStatus)) continue;
    if (!restrictionsAllow(row, actor.actorId, row.purpose)) continue;
    if (!await authProfileCredentialAvailable(tenantId, row)) continue;
    if (!await canUse({ tenantId, actor, crossPrincipal: false, kind: "account", resourceId: row.accountId })) continue;
    accountMap.set(row.accountId, {
      id: row.accountId,
      key: row.accountKey,
      application: row.application,
      provider: row.provider,
      displayName: row.displayName,
      providerAccountRef: row.providerAccountRef,
      status: row.accountStatus,
      capabilities: strings(row.accountCapabilities),
    });
    authProfilesSafe.push({
      authProfileRef: row.authProfileRef,
      applicationAccountId: row.accountId,
      principalRef,
      purpose: row.purpose,
      priority: row.priority,
      status: row.profileStatus,
      authMethod: row.authMethod,
      connectionStatus: row.connectionStatus as AvailableAuthProfile["connectionStatus"],
      requiredScopes: strings(row.requiredScopes),
      grantedScopes: strings(row.grantedScopes),
      capabilities: strings(row.profileCapabilities),
      restrictions: object(row.restrictions),
    });
  }
  return {
    communicationIdentities: communicationIdentitiesSafe.sort((a, b) => a.channel.localeCompare(b.channel) || a.principalRef.type.localeCompare(b.principalRef.type) || b.priority - a.priority || a.key.localeCompare(b.key)),
    applicationAccounts: [...accountMap.values()].sort((a, b) => a.application.localeCompare(b.application) || a.key.localeCompare(b.key)),
    authProfiles: authProfilesSafe.sort((a, b) => a.purpose.localeCompare(b.purpose) || b.priority - a.priority || a.authProfileRef.localeCompare(b.authProfileRef)),
  };
}
