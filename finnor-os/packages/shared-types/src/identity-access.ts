export type IdentityPrincipalType = "employee" | "team" | "location" | "tenant";

export interface IdentityPrincipalRef {
  type: IdentityPrincipalType;
  id: string;
}

export type CommunicationChannel = "email" | "sms" | "voice" | "chat" | "calendar";
export type GovernedAccessStatus = "active" | "disabled" | "suspended";
export type ConnectionStatus = "disconnected" | "connecting" | "active" | "degraded" | "expired" | "reauth_required" | "revoked" | "disabled" | "misconfigured" | "provider_unavailable";
export type AuthMethod = "managed_secret" | "oauth2" | "browser_profile" | "workload_identity";

/** Safe, planner-visible metadata. Credential providers, references, versions, and
 * resolved secret values are intentionally absent from every type in this file. */
export interface AvailableCommunicationIdentity {
  id: string;
  key: string;
  provider: string;
  channel: CommunicationChannel;
  address: string | null;
  providerIdentityRef: string | null;
  status: GovernedAccessStatus;
  capabilities: string[];
  principalRef: IdentityPrincipalRef;
  purpose: string;
  priority: number;
}

export interface AvailableApplicationAccount {
  id: string;
  key: string;
  application: string;
  provider: string;
  displayName: string;
  providerAccountRef: string | null;
  status: GovernedAccessStatus;
  capabilities: string[];
}

export interface AvailableAuthProfile {
  /** The only application-access handle a planner or later computer task receives. */
  authProfileRef: string;
  applicationAccountId: string;
  principalRef: IdentityPrincipalRef;
  purpose: string;
  priority: number;
  status: GovernedAccessStatus;
  authMethod: AuthMethod;
  connectionStatus: ConnectionStatus;
  requiredScopes: string[];
  grantedScopes: string[];
  capabilities: string[];
  restrictions: Record<string, unknown>;
}

export interface OperatingIdentityAccess {
  communicationIdentities: AvailableCommunicationIdentity[];
  applicationAccounts: AvailableApplicationAccount[];
  authProfiles: AvailableAuthProfile[];
}
