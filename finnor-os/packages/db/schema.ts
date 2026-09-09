// Finnor OS core schema (§7). Every tenant-scoped table carries tenant_id and gets RLS
// (see migrations/0000_init.sql — RLS lives in SQL, enforced at the database layer).

import {
  pgSchema,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  numeric,
  vector,
  index,
  unique,
  uniqueIndex,
  real,
  date,
  primaryKey,
  foreignKey,
  check,
  bigint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { money, provenanceColumns, archivable, bytea } from "./columns";

// Everything Finnor owns lives in its own Postgres schema — this is what lets it
// share a database (e.g. an existing Supabase project's `public` schema already
// running a different app) with zero collision risk on table names.
export const finnorOsSchema = pgSchema("finnor_os");
const pgTable = finnorOsSchema.table;

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stable provisioning identity. Names are presentation data and may change;
    // clientKey is the durable boundary used to converge repeat manifests.
    clientKey: text("client_key").notNull().default(sql`'legacy-' || gen_random_uuid()::text`).unique(),
    name: text("name").notNull(),
    ownerPhone: text("owner_phone"),
    // IANA zone (e.g. "America/Chicago"). Drives voice-scheduling/business-hours logic;
    // defaults to the current target market's most common zone, never guessed per-request.
    timezone: text("timezone").notNull().default("America/Chicago"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("tenants_id_client_key_key").on(t.id, t.clientKey)],
);

// §3.2/§3.3: one row per tenant of real, DB-backed flags. is_dealer_zero is what
// other code checks for the "labeled dealer-zero everywhere" rule instead of matching
// on tenant name; simulator_enabled is §3.3's gate (ON only for Dealer Zero).
export const tenantSettings = pgTable("tenant_settings", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  isDealerZero: boolean("is_dealer_zero").notNull().default(false),
  simulatorEnabled: boolean("simulator_enabled").notNull().default(false),
  trainingMode: boolean("training_mode").notNull().default(false),
  // Tenant Experience Manifest V2. This deliberately stays on the existing
  // tenant settings aggregate rather than creating a second configuration source
  // or mixing company vocabulary into per-user preferences. Runtime authority,
  // integrations, and credentials remain in their existing governed contracts.
  workspaceConfig: jsonb("workspace_config").notNull().default({
    version: 3,
    enabledSurfaces: ["home", "work", "deals", "agents"],
    terminology: { home: "Home", work: "Work", deals: "Deals", agents: "Agents" },
    vocabulary: { deal: "deal", portfolioCompany: "portfolio company", dealParty: "deal party", workstream: "workstream", request: "request", deliverable: "deliverable", finding: "finding", risk: "risk", closingCondition: "closing condition", closingItem: "closing item", task: "task", work: "work" },
    voiceEnabled: true,
    navigationPriority: ["home", "deals", "work", "agents"],
    brand: { accent: "cyan", surfaceTone: "ink", radius: "precise", density: "balanced", typography: "system", motion: "restrained", mark: "F", logoAssetKey: "finnor" },
    visibility: { policy: true, authority: true },
    roles: {
      owner: { startView: "command", visibleSurfaces: ["home", "work", "deals", "agents"], ready: { primaryFocus: "deal_execution", heroMetric: "closing_readiness", pulseMetrics: ["open_deals", "open_requests", "critical_deal_risks", "pending_approvals"], attentionCategories: ["deal", "closing", "risk", "approval", "work"], quickActions: [{ key: "review_closing_readiness" }, { key: "review_open_requests" }, { key: "review_pending_approvals" }, { key: "inspect_blocked_work" }], primaryProjection: "deal" } },
    },
    scenes: { ready: { detail: "balanced", emphasis: "evidence" }, listening: { detail: "balanced", emphasis: "evidence" }, plan: { detail: "balanced", emphasis: "evidence" }, approval: { detail: "balanced", emphasis: "evidence" }, working: { detail: "balanced", emphasis: "evidence" }, outcome: { detail: "balanced", emphasis: "evidence" }, recovery: { detail: "balanced", emphasis: "evidence" } },
    extensions: {},
  }),
  // Phase 2 tenant-safe routing/delegation policy. Provider credentials and raw
  // endpoints never belong here; the migration enforces a secret-shaped-key ban.
  universalActionConfig: jsonb("universal_action_config").notNull().default({
    communication: { allowedChannels: ["internal", "email", "sms", "voice"], allowChannelFallback: false, maxGroupRecipients: 50 },
    acknowledgements: { defaultDeadlineMinutes: 240 },
    delegations: { defaultAckDeadlineMinutes: 240, defaultCompletionHours: 24 },
    scheduling: { externalCalendarMode: "internal_only" },
    documentSharing: { allowExternal: false },
  }),
  // Phase 3 execution budgets and provider choice. Application origins live on the
  // governed account/profile rows, not in planner payloads or provider credentials.
  computerConfig: jsonb("computer_config").notNull().default({
    enabled: false,
    provider: "steel",
    maxSteps: 30,
    timeoutMs: 300000,
    maxProviderCredits: 10,
    maxScreenshots: 10,
    maxArtifacts: 20,
    maxDownloadBytes: 10485760,
    maxUploadBytes: 0,
    maxOutputBytes: 131072,
  }),
  connectionRequirements: jsonb("connection_requirements").notNull().default([]),
  connectionPolicy: jsonb("connection_policy").notNull().default({
    failClosedStatuses: ["disconnected", "connecting", "expired", "reauth_required", "revoked", "disabled", "misconfigured", "provider_unavailable"],
    healthCheckMinutes: 15,
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Core ↔ vertical runtime boundary.  Core owns identity/resolution and the
// canonical truth catalogue; individual vertical packages own their rows and
// mutation semantics.  `vertical_key = null` in the truth registry means a Core
// entity is available to every active vertical, including `none`.
export const verticalDefinitions = pgTable("vertical_definitions", {
  key: text("key").primaryKey(),
  displayName: text("display_name").notNull(),
  implementationOwner: text("implementation_owner").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantVerticalAssignments = pgTable("tenant_vertical_assignments", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  verticalKey: text("vertical_key").notNull().references(() => verticalDefinitions.key),
  version: integer("version").notNull().default(1),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  sourceSystem: text("source_system").notNull().default("finnor"),
  sourceRef: text("source_ref"),
  createdBy: text("created_by").notNull().default("system:legacy-water-default"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const canonicalTruthRegistry = pgTable("canonical_truth_registry", {
  entityType: text("entity_type").primaryKey(),
  verticalKey: text("vertical_key").references(() => verticalDefinitions.key),
  sourceSchema: text("source_schema").notNull().default("finnor_os"),
  sourceTable: text("source_table").notNull(),
  idColumn: text("id_column").notNull().default("id"),
  tenantColumn: text("tenant_column").notNull().default("tenant_id"),
  writableOwner: text("writable_owner").notNull(),
  mutationBoundary: text("mutation_boundary").notNull(),
  workAttachable: boolean("work_attachable").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Manifest-owned business locations. This is intentionally not a second workspace
// configuration source and not an alias for inventory warehouses: it only provides
// stable client/location identities for onboarding and later import mapping.
export const tenantLocations = pgTable(
  "tenant_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    locationKey: text("location_key").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    timezone: text("timezone"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("tenant_locations_tenant_key_unique").on(t.tenantId, t.locationKey),
    unique("tenant_locations_tenant_id_id_key").on(t.tenantId, t.id),
  ],
);

// Phase 0 Company World: teams and departments are canonical graph nodes, not
// role/authority substitutes. Their stable key is manifest-owned and therefore
// safe for convergent provisioning.
export const orgUnits = pgTable(
  "org_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    unitKey: text("unit_key").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["team", "department"] }).notNull().default("team"),
    description: text("description"),
    locationId: uuid("location_id"),
    managedBy: text("managed_by"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("org_units_unit_key_format_check", sql`${t.unitKey} = lower(${t.unitKey}) AND ${t.unitKey} ~ '^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$'`),
    check("org_units_kind_check", sql`${t.kind} IN ('team', 'department')`),
    unique("org_units_tenant_key_unique").on(t.tenantId, t.unitKey),
    unique("org_units_tenant_id_id_key").on(t.tenantId, t.id),
    index("org_units_tenant_active_key_idx").on(t.tenantId, t.active, t.unitKey),
    index("org_units_tenant_name_idx").on(t.tenantId, t.name),
    index("org_units_tenant_location_idx").on(t.tenantId, t.locationId).where(sql`${t.locationId} IS NOT NULL`),
    index("org_units_tenant_managed_by_idx").on(t.tenantId, t.managedBy).where(sql`${t.managedBy} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.locationId],
      foreignColumns: [tenantLocations.tenantId, tenantLocations.id],
      name: "org_units_location_tenant_fkey",
    }),
    foreignKey({
      columns: [t.tenantId, t.managedBy],
      foreignColumns: [tenants.id, tenants.clientKey],
      name: "org_units_managed_by_tenant_fkey",
    }),
  ],
);

// Stable company configuration is deliberately separate from live operating
// state and from semantic memory.  These are operator-authored facts used to
// resolve "us/our/company" before planning or research; an absent value remains
// null and therefore produces a clarification instead of a runtime guess.
export const tenantOperatingProfiles = pgTable("tenant_operating_profiles", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  industry: text("industry"),
  niche: text("niche"),
  description: text("description"),
  primaryGeographies: jsonb("primary_geographies").notNull().default([]),
  foundedYear: integer("founded_year"),
  idealCustomerProfile: jsonb("ideal_customer_profile").notNull().default({}),
  businessFacts: jsonb("business_facts").notNull().default({}),
  comparisonDefaults: jsonb("comparison_defaults").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    email: text("email").notNull().unique(),
    role: text("role", { enum: ["owner", "dispatcher", "technician"] }).notNull(),
    displayName: text("display_name"),
    phoneNumber: text("phone_number"),
    status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
    // D5.T1: the authenticated technician's durable link to their operational record.
    // Nullable for owners/dispatchers and for existing invitations that have not yet
    // been paired with a technician record.
    technicianId: uuid("technician_id").references(() => technicians.id),
    // Canonical operating-location reference. Teams may also carry a location, but
    // this direct link answers the employee's primary location without inventing a
    // second employee/location directory.
    primaryLocationId: uuid("primary_location_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("users_tenant_id_id_key").on(t.tenantId, t.id),
    index("users_tenant_display_name_idx").on(t.tenantId, t.displayName),
    index("users_tenant_primary_location_idx").on(t.tenantId, t.primaryLocationId).where(sql`${t.primaryLocationId} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.primaryLocationId],
      foreignColumns: [tenantLocations.tenantId, tenantLocations.id],
      name: "users_primary_location_tenant_fkey",
    }),
  ],
);

export const orgUnitMemberships = pgTable(
  "org_unit_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    orgUnitId: uuid("org_unit_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    membershipRole: text("membership_role"),
    isPrimary: boolean("is_primary").notNull().default(false),
    managedBy: text("managed_by"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("org_unit_memberships_identity_unique").on(t.tenantId, t.orgUnitId, t.employeeId),
    unique("org_unit_memberships_tenant_id_id_key").on(t.tenantId, t.id),
    index("org_unit_memberships_tenant_unit_active_idx").on(t.tenantId, t.orgUnitId, t.active, t.employeeId),
    index("org_unit_memberships_tenant_employee_active_idx").on(t.tenantId, t.employeeId, t.active, t.orgUnitId),
    index("org_unit_memberships_tenant_managed_by_idx").on(t.tenantId, t.managedBy).where(sql`${t.managedBy} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.orgUnitId],
      foreignColumns: [orgUnits.tenantId, orgUnits.id],
      name: "org_unit_memberships_org_unit_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [users.tenantId, users.id],
      name: "org_unit_memberships_employee_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.managedBy],
      foreignColumns: [tenants.id, tenants.clientKey],
      name: "org_unit_memberships_managed_by_tenant_fkey",
    }),
  ],
);

// `manager` means subject_employee reports to related_employee. `backup` and
// `assistant` use the same subject -> related direction; the inverse manager/report
// edge is derived on the existing Company Graph surface.
export const employeeRelationships = pgTable(
  "employee_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    subjectEmployeeId: uuid("subject_employee_id").notNull(),
    relatedEmployeeId: uuid("related_employee_id").notNull(),
    relationshipType: text("relationship_type", { enum: ["manager", "backup", "assistant"] }).notNull(),
    managedBy: text("managed_by"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("employee_relationships_relationship_type_check", sql`${t.relationshipType} IN ('manager', 'backup', 'assistant')`),
    check("employee_relationships_not_self_check", sql`${t.subjectEmployeeId} <> ${t.relatedEmployeeId}`),
    unique("employee_relationships_identity_unique").on(t.tenantId, t.subjectEmployeeId, t.relationshipType, t.relatedEmployeeId),
    unique("employee_relationships_tenant_id_id_key").on(t.tenantId, t.id),
    index("employee_relationships_tenant_employee_type_idx").on(t.tenantId, t.subjectEmployeeId, t.relationshipType, t.active),
    index("employee_relationships_tenant_related_type_idx").on(t.tenantId, t.relatedEmployeeId, t.relationshipType, t.active),
    index("employee_relationships_tenant_managed_by_idx").on(t.tenantId, t.managedBy).where(sql`${t.managedBy} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.subjectEmployeeId],
      foreignColumns: [users.tenantId, users.id],
      name: "employee_relationships_subject_employee_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.relatedEmployeeId],
      foreignColumns: [users.tenantId, users.id],
      name: "employee_relationships_related_employee_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.managedBy],
      foreignColumns: [tenants.id, tenants.clientKey],
      name: "employee_relationships_managed_by_tenant_fkey",
    }),
  ],
);

export const externalOrganizations = pgTable(
  "external_organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    organizationKey: text("organization_key").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["supplier", "vendor", "distributor", "partner", "contractor", "agency", "other"] }).notNull().default("other"),
    businessEmail: text("business_email"),
    businessPhone: text("business_phone"),
    managedBy: text("managed_by"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("external_organizations_key_format_check", sql`${t.organizationKey} = lower(${t.organizationKey}) AND ${t.organizationKey} ~ '^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$'`),
    check("external_organizations_kind_check", sql`${t.kind} IN ('supplier', 'vendor', 'distributor', 'partner', 'contractor', 'agency', 'other')`),
    unique("external_organizations_tenant_key_unique").on(t.tenantId, t.organizationKey),
    unique("external_organizations_tenant_id_id_key").on(t.tenantId, t.id),
    index("external_organizations_tenant_active_name_idx").on(t.tenantId, t.active, t.name, t.id),
    index("external_organizations_tenant_type_active_idx").on(t.tenantId, t.kind, t.active, t.id),
    index("external_organizations_tenant_email_idx").on(t.tenantId, sql`lower(${t.businessEmail})`, t.id).where(sql`${t.businessEmail} IS NOT NULL`),
    index("external_organizations_tenant_phone_idx").on(t.tenantId, t.businessPhone, t.id).where(sql`${t.businessPhone} IS NOT NULL`),
    index("external_organizations_tenant_managed_by_idx").on(t.tenantId, t.managedBy).where(sql`${t.managedBy} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.managedBy],
      foreignColumns: [tenants.id, tenants.clientKey],
      name: "external_organizations_managed_by_tenant_fkey",
    }),
  ],
);

export const externalContacts = pgTable(
  "external_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    contactKey: text("contact_key").notNull(),
    externalOrganizationId: uuid("external_organization_id"),
    name: text("name").notNull(),
    title: text("title"),
    businessEmail: text("business_email"),
    businessPhone: text("business_phone"),
    managedBy: text("managed_by"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("external_contacts_key_format_check", sql`${t.contactKey} = lower(${t.contactKey}) AND ${t.contactKey} ~ '^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$'`),
    unique("external_contacts_tenant_key_unique").on(t.tenantId, t.contactKey),
    unique("external_contacts_tenant_id_id_key").on(t.tenantId, t.id),
    index("external_contacts_tenant_active_name_idx").on(t.tenantId, t.active, t.name, t.id),
    index("external_contacts_tenant_organization_idx").on(t.tenantId, t.externalOrganizationId, t.active, t.id).where(sql`${t.externalOrganizationId} IS NOT NULL`),
    index("external_contacts_tenant_email_idx").on(t.tenantId, sql`lower(${t.businessEmail})`, t.id).where(sql`${t.businessEmail} IS NOT NULL`),
    index("external_contacts_tenant_phone_idx").on(t.tenantId, t.businessPhone, t.id).where(sql`${t.businessPhone} IS NOT NULL`),
    index("external_contacts_tenant_managed_by_idx").on(t.tenantId, t.managedBy).where(sql`${t.managedBy} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.externalOrganizationId],
      foreignColumns: [externalOrganizations.tenantId, externalOrganizations.id],
      name: "external_contacts_organization_tenant_fkey",
    }),
    foreignKey({
      columns: [t.tenantId, t.managedBy],
      foreignColumns: [tenants.id, tenants.clientKey],
      name: "external_contacts_managed_by_tenant_fkey",
    }),
  ],
);

export const partyAliases = pgTable(
  "party_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    aliasKey: text("alias_key").notNull(),
    partyType: text("party_type", { enum: ["employee", "team", "location", "household", "contact", "external_organization", "external_contact"] }).notNull(),
    partyId: uuid("party_id").notNull(),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    managedBy: text("managed_by"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("party_aliases_party_type_check", sql`${t.partyType} IN ('employee', 'team', 'location', 'household', 'contact', 'external_organization', 'external_contact')`),
    check("party_aliases_alias_nonempty_check", sql`btrim(${t.alias}) <> ''`),
    check("party_aliases_normalized_nonempty_check", sql`${t.normalizedAlias} <> ''`),
    check("party_aliases_alias_key_format_check", sql`${t.aliasKey} = lower(${t.aliasKey}) AND ${t.aliasKey} ~ '^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$'`),
    unique("party_aliases_tenant_key_unique").on(t.tenantId, t.aliasKey),
    unique("party_aliases_tenant_id_id_key").on(t.tenantId, t.id),
    unique("party_aliases_identity_unique").on(t.tenantId, t.partyType, t.partyId, t.normalizedAlias),
    index("party_aliases_tenant_normalized_active_idx").on(t.tenantId, t.normalizedAlias, t.active, t.partyType, t.partyId),
    index("party_aliases_tenant_party_active_idx").on(t.tenantId, t.partyType, t.partyId, t.active),
    index("party_aliases_tenant_managed_by_idx").on(t.tenantId, t.managedBy).where(sql`${t.managedBy} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.managedBy],
      foreignColumns: [tenants.id, tenants.clientKey],
      name: "party_aliases_managed_by_tenant_fkey",
    }),
  ],
);

// Phase 1 Identity + Access Binding Fabric. These rows describe governed handles
// and secret references only; resolved passwords/tokens/cookies never enter Postgres.
export const communicationIdentities = pgTable(
  "communication_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    identityKey: text("identity_key").notNull(),
    provider: text("provider").notNull(),
    channel: text("channel", { enum: ["email", "sms", "voice", "chat", "calendar"] }).notNull(),
    address: text("address"),
    providerIdentityRef: text("provider_identity_ref"),
    status: text("status", { enum: ["active", "disabled", "suspended"] }).notNull().default("active"),
    capabilities: jsonb("capabilities").notNull().default([]),
    credentialProvider: text("credential_provider", { enum: ["aws-secrets-manager", "aws-iam-federated", "legacy-env"] }),
    credentialRef: text("credential_ref"),
    credentialVersion: text("credential_version"),
    // Phase 5 may bind a communication address to the same governed auth profile
    // used by an application account (for example a Gmail OAuth connection).
    authProfileId: uuid("auth_profile_id"),
    managedBy: text("managed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("communication_identities_key_format_check", sql`${t.identityKey} = lower(${t.identityKey}) AND ${t.identityKey} ~ '^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$'`),
    check("communication_identities_provider_format_check", sql`${t.provider} = lower(${t.provider}) AND ${t.provider} ~ '^[a-z0-9][a-z0-9_-]{0,62}$'`),
    check("communication_identities_channel_check", sql`${t.channel} IN ('email','sms','voice','chat','calendar')`),
    check("communication_identities_status_check", sql`${t.status} IN ('active','disabled','suspended')`),
    check("communication_identities_endpoint_check", sql`coalesce(btrim(${t.address}), '') <> '' OR coalesce(btrim(${t.providerIdentityRef}), '') <> ''`),
    check("communication_identities_capabilities_array_check", sql`jsonb_typeof(${t.capabilities}) = 'array'`),
    unique("communication_identities_tenant_key_unique").on(t.tenantId, t.identityKey),
    unique("communication_identities_tenant_id_id_key").on(t.tenantId, t.id),
    index("communication_identities_tenant_channel_status_idx").on(t.tenantId, t.channel, t.status, t.provider),
    index("communication_identities_tenant_managed_by_idx").on(t.tenantId, t.managedBy).where(sql`${t.managedBy} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.managedBy],
      foreignColumns: [tenants.id, tenants.clientKey],
      name: "communication_identities_managed_by_tenant_fkey",
    }),
  ],
);

export const communicationIdentityBindings = pgTable(
  "communication_identity_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    communicationIdentityId: uuid("communication_identity_id").notNull(),
    principalType: text("principal_type", { enum: ["employee", "team", "location", "tenant"] }).notNull(),
    principalId: uuid("principal_id").notNull(),
    purpose: text("purpose").notNull().default("default"),
    priority: integer("priority").notNull().default(0),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    managedBy: text("managed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("communication_identity_bindings_principal_type_check", sql`${t.principalType} IN ('employee','team','location','tenant')`),
    check("communication_identity_bindings_purpose_check", sql`btrim(${t.purpose}) <> '' AND length(${t.purpose}) <= 120`),
    check("communication_identity_bindings_status_check", sql`${t.status} IN ('active','disabled')`),
    unique("communication_identity_bindings_identity_unique").on(t.tenantId, t.communicationIdentityId, t.principalType, t.principalId, t.purpose),
    unique("communication_identity_bindings_tenant_id_id_key").on(t.tenantId, t.id),
    index("communication_identity_bindings_principal_lookup_idx").on(t.tenantId, t.principalType, t.principalId, t.status, t.purpose, t.priority),
    index("communication_identity_bindings_identity_idx").on(t.tenantId, t.communicationIdentityId, t.status),
    index("communication_identity_bindings_managed_by_idx").on(t.tenantId, t.managedBy).where(sql`${t.managedBy} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.communicationIdentityId],
      foreignColumns: [communicationIdentities.tenantId, communicationIdentities.id],
      name: "communication_identity_bindings_identity_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.managedBy],
      foreignColumns: [tenants.id, tenants.clientKey],
      name: "communication_identity_bindings_managed_by_tenant_fkey",
    }),
  ],
);

export const applicationAccounts = pgTable(
  "application_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    accountKey: text("account_key").notNull(),
    application: text("application").notNull(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    providerAccountRef: text("provider_account_ref"),
    status: text("status", { enum: ["active", "disabled", "suspended"] }).notNull().default("active"),
    capabilities: jsonb("capabilities").notNull().default([]),
    metadata: jsonb("metadata").notNull().default({}),
    managedBy: text("managed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("application_accounts_key_format_check", sql`${t.accountKey} = lower(${t.accountKey}) AND ${t.accountKey} ~ '^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$'`),
    check("application_accounts_application_format_check", sql`${t.application} = lower(${t.application}) AND ${t.application} ~ '^[a-z0-9][a-z0-9_-]{0,62}$'`),
    check("application_accounts_provider_format_check", sql`${t.provider} = lower(${t.provider}) AND ${t.provider} ~ '^[a-z0-9][a-z0-9_-]{0,62}$'`),
    check("application_accounts_status_check", sql`${t.status} IN ('active','disabled','suspended')`),
    check("application_accounts_capabilities_array_check", sql`jsonb_typeof(${t.capabilities}) = 'array'`),
    check("application_accounts_metadata_object_check", sql`jsonb_typeof(${t.metadata}) = 'object'`),
    unique("application_accounts_tenant_key_unique").on(t.tenantId, t.accountKey),
    unique("application_accounts_tenant_id_id_key").on(t.tenantId, t.id),
    index("application_accounts_tenant_application_status_idx").on(t.tenantId, t.application, t.status, t.provider),
    index("application_accounts_tenant_managed_by_idx").on(t.tenantId, t.managedBy).where(sql`${t.managedBy} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.managedBy],
      foreignColumns: [tenants.id, tenants.clientKey],
      name: "application_accounts_managed_by_tenant_fkey",
    }),
  ],
);

export const authProfiles = pgTable(
  "auth_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    authProfileRef: text("auth_profile_ref").notNull(),
    principalType: text("principal_type", { enum: ["employee", "team", "location", "tenant"] }).notNull(),
    principalId: uuid("principal_id").notNull(),
    applicationAccountId: uuid("application_account_id").notNull(),
    purpose: text("purpose").notNull().default("default"),
    priority: integer("priority").notNull().default(0),
    scope: jsonb("scope").notNull().default({}),
    credentialProvider: text("credential_provider", { enum: ["aws-secrets-manager", "aws-iam-federated", "os-keychain", "legacy-env"] }),
    credentialRef: text("credential_ref"),
    credentialVersion: text("credential_version"),
    status: text("status", { enum: ["active", "disabled", "suspended"] }).notNull().default("active"),
    authMethod: text("auth_method", { enum: ["managed_secret", "oauth2", "browser_profile", "workload_identity"] }).notNull().default("managed_secret"),
    connectionRequired: boolean("connection_required").notNull().default(true),
    connectionStatus: text("connection_status", {
      enum: ["disconnected", "connecting", "active", "degraded", "expired", "reauth_required", "revoked", "disabled", "misconfigured", "provider_unavailable"],
    }).notNull().default("active"),
    requiredScopes: text("required_scopes").array().notNull().default([]),
    grantedScopes: text("granted_scopes").array().notNull().default([]),
    providerSubjectRef: text("provider_subject_ref"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    reauthRequiredAt: timestamp("reauth_required_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastConnectionErrorCode: text("last_connection_error_code"),
    connectionRevision: integer("connection_revision").notNull().default(1),
    capabilities: jsonb("capabilities").notNull().default([]),
    restrictions: jsonb("restrictions").notNull().default({}),
    managedBy: text("managed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("auth_profiles_ref_format_check", sql`${t.authProfileRef} = lower(${t.authProfileRef}) AND ${t.authProfileRef} ~ '^[a-z0-9][a-z0-9_-]{1,126}[a-z0-9]$'`),
    check("auth_profiles_principal_type_check", sql`${t.principalType} IN ('employee','team','location','tenant')`),
    check("auth_profiles_purpose_check", sql`btrim(${t.purpose}) <> '' AND length(${t.purpose}) <= 120`),
    check("auth_profiles_status_check", sql`${t.status} IN ('active','disabled','suspended')`),
    check("auth_profiles_scope_object_check", sql`jsonb_typeof(${t.scope}) = 'object'`),
    check("auth_profiles_capabilities_array_check", sql`jsonb_typeof(${t.capabilities}) = 'array'`),
    check("auth_profiles_restrictions_object_check", sql`jsonb_typeof(${t.restrictions}) = 'object'`),
    check("auth_profiles_auth_method_check", sql`${t.authMethod} IN ('managed_secret','oauth2','browser_profile','workload_identity')`),
    check("auth_profiles_connection_status_check", sql`${t.connectionStatus} IN ('disconnected','connecting','active','degraded','expired','reauth_required','revoked','disabled','misconfigured','provider_unavailable')`),
    check("auth_profiles_connection_revision_check", sql`${t.connectionRevision} >= 1`),
    unique("auth_profiles_tenant_ref_unique").on(t.tenantId, t.authProfileRef),
    unique("auth_profiles_tenant_id_id_key").on(t.tenantId, t.id),
    unique("auth_profiles_binding_unique").on(t.tenantId, t.applicationAccountId, t.principalType, t.principalId, t.purpose),
    index("auth_profiles_principal_lookup_idx").on(t.tenantId, t.principalType, t.principalId, t.status, t.purpose, t.priority),
    index("auth_profiles_account_status_idx").on(t.tenantId, t.applicationAccountId, t.status),
    index("auth_profiles_managed_by_idx").on(t.tenantId, t.managedBy).where(sql`${t.managedBy} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.applicationAccountId],
      foreignColumns: [applicationAccounts.tenantId, applicationAccounts.id],
      name: "auth_profiles_account_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.managedBy],
      foreignColumns: [tenants.id, tenants.clientKey],
      name: "auth_profiles_managed_by_tenant_fkey",
    }),
  ],
);

export const oauthConnectionRequests = pgTable(
  "oauth_connection_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    authProfileId: uuid("auth_profile_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    provider: text("provider").notNull(),
    stateHash: text("state_hash").notNull().unique(),
    pkceChallenge: text("pkce_challenge").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    requestedScopes: text("requested_scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.authProfileId],
      foreignColumns: [authProfiles.tenantId, authProfiles.id],
      name: "oauth_connection_requests_profile_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.actorId],
      foreignColumns: [users.tenantId, users.id],
      name: "oauth_connection_requests_actor_tenant_fkey",
    }),
    index("oauth_connection_requests_expiry_idx").on(t.expiresAt).where(sql`${t.consumedAt} IS NULL`),
    index("oauth_connection_requests_tenant_profile_idx").on(t.tenantId, t.authProfileId, t.createdAt),
  ],
);

/** Administrative application-consent state. This is configuration proof, not a
 * delegated runtime token or a second OAuth credential store. */
export const applicationConsentRequests = pgTable(
  "application_consent_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    authProfileId: uuid("auth_profile_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    provider: text("provider").notNull(),
    stateHash: text("state_hash").notNull().unique(),
    expectedDirectoryTenantId: text("expected_directory_tenant_id").notNull(),
    returnedDirectoryTenantId: text("returned_directory_tenant_id"),
    redirectUri: text("redirect_uri").notNull(),
    requestedPermissions: text("requested_permissions").array().notNull().default([]),
    status: text("status", { enum: ["requested", "returned", "verified", "failed", "expired"] }).notNull().default("requested"),
    permissionVerification: jsonb("permission_verification").notNull().default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.authProfileId],
      foreignColumns: [authProfiles.tenantId, authProfiles.id],
      name: "application_consent_requests_profile_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.actorId],
      foreignColumns: [users.tenantId, users.id],
      name: "application_consent_requests_actor_tenant_fkey",
    }),
    index("application_consent_requests_expiry_idx").on(t.expiresAt).where(sql`${t.consumedAt} IS NULL`),
    index("application_consent_requests_tenant_profile_idx").on(t.tenantId, t.authProfileId, t.createdAt),
  ],
);

export const connectionEvents = pgTable(
  "connection_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    authProfileId: uuid("auth_profile_id").notNull(),
    actorId: uuid("actor_id"),
    eventType: text("event_type", {
      enum: ["connect_started", "connect_failed", "consent_requested", "consent_returned", "connected", "refreshed", "verified", "permission_verified", "degraded", "reauth_required", "revoked", "disabled", "reconnected", "provider_unavailable"],
    }).notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    reasonCode: text("reason_code"),
    traceId: text("trace_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.authProfileId],
      foreignColumns: [authProfiles.tenantId, authProfiles.id],
      name: "connection_events_profile_tenant_fkey",
    }),
    foreignKey({
      columns: [t.tenantId, t.actorId],
      foreignColumns: [users.tenantId, users.id],
      name: "connection_events_actor_tenant_fkey",
    }),
    index("connection_events_tenant_profile_idx").on(t.tenantId, t.authProfileId, t.createdAt),
  ],
);

export const tenantRetentionPolicies = pgTable(
  "tenant_retention_policies",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    dataClass: text("data_class", {
      enum: ["messages", "job_payloads", "computer_artifact_content", "model_records"],
    }).notNull(),
    retentionDays: integer("retention_days").notNull(),
    legalHold: boolean("legal_hold").notNull().default(false),
    managedBy: text("managed_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.dataClass] }),
    check("tenant_retention_policies_days_check", sql`${t.retentionDays} BETWEEN 1 AND 3650`),
    foreignKey({
      columns: [t.tenantId, t.managedBy],
      foreignColumns: [tenants.id, tenants.clientKey],
      name: "tenant_retention_policies_managed_by_tenant_fkey",
    }),
  ],
);

export const tenantRateLimitPolicies = pgTable(
  "tenant_rate_limit_policies",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    provider: text("provider").notNull(),
    action: text("action").notNull(),
    perMinute: integer("per_minute").notNull(),
    managedBy: text("managed_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.provider, t.action] }),
    check("tenant_rate_limit_policies_per_minute_check", sql`${t.perMinute} BETWEEN 1 AND 1000000`),
    foreignKey({ columns: [t.tenantId, t.managedBy], foreignColumns: [tenants.id, tenants.clientKey], name: "tenant_rate_limit_policies_managed_by_tenant_fkey" }),
  ],
);

// Authenticated-person profile facts (for example title or an explicitly
// configured age/birth date) are not inferred from conversations.  Keeping them
// user-scoped prevents one employee's "me/my" binding from leaking to another.
export const userOperatingProfiles = pgTable(
  "user_operating_profiles",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    title: text("title"),
    profileFacts: jsonb("profile_facts").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_operating_profiles_tenant_idx").on(t.tenantId)],
);

// Upgrade 8: users remain the canonical employee identities. These additive tables
// extend the legacy single role into composable, tenant-scoped authority without
// introducing a second identity directory.
export const authorityStates = pgTable("authority_states", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  revision: integer("revision").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const employeeRoles = pgTable(
  "employee_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    legacyRole: text("legacy_role", { enum: ["owner", "dispatcher", "technician"] }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("employee_roles_tenant_key_idx").on(t.tenantId, t.key)],
);

export const approvalChains = pgTable(
  "approval_chains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("approval_chains_tenant_key_idx").on(t.tenantId, t.key)],
);

export const approvalChainSteps = pgTable(
  "approval_chain_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    approvalChainId: uuid("approval_chain_id").notNull().references(() => approvalChains.id),
    sequence: integer("sequence").notNull(),
    // `$action` is expanded to the pending action type at evaluation time. The
    // approver is selected from actual grants, never from a hard-coded role name.
    approverCapability: text("approver_capability").notNull().default("approve:$action"),
    minApprovals: integer("min_approvals").notNull().default(1),
  },
  (t) => [unique("approval_chain_steps_chain_sequence_idx").on(t.approvalChainId, t.sequence)],
);

export const employeeRoleAssignments = pgTable(
  "employee_role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    // Assignments are identity-owned configuration. Removing a test/dev identity
    // (production uses suspension) must not leave orphan authority rows.
    employeeId: uuid("employee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull().references(() => employeeRoles.id),
    // {kind:"tenant"}, {kind:"resources", resourceType, resourceIds}, or
    // {kind:"assigned"}. Runtime intersects this with the grant resource type.
    resourceScope: jsonb("resource_scope").notNull().default({ kind: "tenant" }),
    active: boolean("active").notNull().default(true),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("employee_role_assignments_employee_role_idx").on(t.employeeId, t.roleId), index("employee_role_assignments_tenant_employee_idx").on(t.tenantId, t.employeeId)],
);

export const roleAuthorityGrants = pgTable(
  "role_authority_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    roleId: uuid("role_id").notNull().references(() => employeeRoles.id),
    capability: text("capability").notNull(),
    resourceType: text("resource_type").notNull().default("*"),
    effect: text("effect", { enum: ["allow", "deny"] }).notNull().default("allow"),
    maxAmountUsd: numeric("max_amount_usd", { precision: 14, scale: 2 }),
    maxRisk: text("max_risk", { enum: ["low", "medium", "high"] }).notNull().default("high"),
    approvalRequired: boolean("approval_required").notNull().default(false),
    approvalChainId: uuid("approval_chain_id").references(() => approvalChains.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("role_authority_grants_role_capability_resource_idx").on(t.roleId, t.capability, t.resourceType), index("role_authority_grants_tenant_capability_idx").on(t.tenantId, t.capability)],
);

export const authorityDecisions = pgTable(
  "authority_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    employeeId: uuid("employee_id").references(() => users.id),
    authorityRevision: integer("authority_revision").notNull(),
    operation: text("operation", { enum: ["query", "action", "approval", "execution", "durable_operation"] }).notNull(),
    capability: text("capability").notNull(),
    resourceType: text("resource_type").notNull().default("*"),
    resourceId: uuid("resource_id"),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 2 }),
    risk: text("risk", { enum: ["low", "medium", "high"] }).notNull(),
    outcome: text("outcome", { enum: ["allowed", "denied", "approval_required"] }).notNull(),
    reasonCode: text("reason_code").notNull(),
    approvalChainId: uuid("approval_chain_id").references(() => approvalChains.id),
    evidence: jsonb("evidence").notNull().default({}),
    workId: uuid("work_id").references(() => works.id),
    domainActionId: uuid("domain_action_id"),
    operationId: uuid("operation_id"),
    businessEffectId: uuid("business_effect_id"),
    businessEffectHash: text("business_effect_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("authority_decisions_tenant_id_id_key").on(t.tenantId, t.id),
    index("authority_decisions_tenant_employee_idx").on(t.tenantId, t.employeeId, t.createdAt),
    index("authority_decisions_action_idx").on(t.domainActionId),
  ],
);

export const authorityApprovalRequests = pgTable(
  "authority_approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    domainActionId: uuid("domain_action_id").notNull(),
    requesterId: uuid("requester_id").references(() => users.id),
    authorityDecisionId: uuid("authority_decision_id").notNull().references(() => authorityDecisions.id),
    approvalChainId: uuid("approval_chain_id").notNull().references(() => approvalChains.id),
    businessEffectId: uuid("business_effect_id"),
    businessEffectHash: text("business_effect_hash"),
    status: text("status", { enum: ["pending", "approved", "rejected", "expired"] }).notNull().default("pending"),
    currentStep: integer("current_step").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [unique("authority_approval_requests_action_idx").on(t.domainActionId), index("authority_approval_requests_tenant_status_idx").on(t.tenantId, t.status)],
);

export const authorityApprovalRequestSteps = pgTable(
  "authority_approval_request_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    approvalRequestId: uuid("approval_request_id").notNull().references(() => authorityApprovalRequests.id),
    sequence: integer("sequence").notNull(),
    approverCapability: text("approver_capability").notNull(),
    minApprovals: integer("min_approvals").notNull().default(1),
    status: text("status", { enum: ["pending", "approved", "rejected", "skipped"] }).notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    authorityDecisionId: uuid("authority_decision_id").references(() => authorityDecisions.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [unique("authority_approval_request_steps_request_sequence_idx").on(t.approvalRequestId, t.sequence)],
);

// Upgrade 2: the durable envelope around every human instruction. Existing action,
// approval, workflow, and receipt tables remain the execution sources of truth; a
// Work row gives them one stable parent that exists before planning begins.
export const works = pgTable(
  "works",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    status: text("status", {
      enum: [
        "received", "understanding", "planning", "ready", "actionable",
        "awaiting_approval", "executing", "waiting", "blocked", "completed", "failed", "cancelled", "recovery",
      ],
    }).notNull().default("received"),
    sessionId: text("session_id"),
    initialChannel: text("initial_channel", { enum: ["voice", "text", "console"] }).notNull(),
    initialInstruction: text("initial_instruction").notNull(),
    executionModel: text("execution_model", { enum: ["query", "atomic_effect", "objective"] }),
    createdBy: uuid("created_by").references(() => users.id),
    currentOwnerId: uuid("current_owner_id").references(() => users.id),
    assignedTo: uuid("assigned_to").references(() => users.id),
    authorityContext: jsonb("authority_context").notNull().default({}),
    activeContext: jsonb("active_context").notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    finalOutcome: jsonb("final_outcome"),
    failure: jsonb("failure"),
    recovery: jsonb("recovery"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("works_tenant_id_id_key").on(t.tenantId, t.id),
    unique("works_tenant_idempotency_idx").on(t.tenantId, t.idempotencyKey),
    index("works_tenant_status_idx").on(t.tenantId, t.status),
    index("works_tenant_session_idx").on(t.tenantId, t.sessionId),
  ],
);

export const workInputs = pgTable(
  "work_inputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    instructionId: uuid("instruction_id").notNull(),
    channel: text("channel", { enum: ["voice", "text", "console"] }).notNull(),
    sessionId: text("session_id"),
    instructionText: text("instruction_text").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    idempotencyKey: text("idempotency_key"),
    contextSnapshot: jsonb("context_snapshot"),
    contextSnapshotHash: text("context_snapshot_hash"),
    contextCapturedAt: timestamp("context_captured_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("work_inputs_tenant_id_id_key").on(t.tenantId, t.id),
    unique("work_inputs_tenant_instruction_idx").on(t.tenantId, t.instructionId),
    unique("work_inputs_work_idempotency_idx").on(t.workId, t.idempotencyKey),
    index("work_inputs_work_created_idx").on(t.workId, t.createdAt),
  ],
);

export const workPlannerAttempts = pgTable(
  "work_planner_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    workInputId: uuid("work_input_id").references(() => workInputs.id),
    attempt: integer("attempt").notNull(),
    attemptKey: text("attempt_key").notNull(),
    status: text("status", { enum: ["planning", "succeeded", "failed", "timed_out"] }).notNull().default("planning"),
    plannerResult: jsonb("planner_result"),
    failure: jsonb("failure"),
    decisionContextSnapshot: jsonb("decision_context_snapshot"),
    decisionContextHash: text("decision_context_hash"),
    decisionContextCapturedAt: timestamp("decision_context_captured_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("work_planner_attempts_work_attempt_idx").on(t.workId, t.attempt),
    unique("work_planner_attempts_work_key_idx").on(t.workId, t.attemptKey),
    index("work_planner_attempts_tenant_work_idx").on(t.tenantId, t.workId),
  ],
);

export const workEvents = pgTable(
  "work_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    seq: integer("seq").notNull(),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status", {
      enum: [
        "received", "understanding", "planning", "ready", "actionable",
        "awaiting_approval", "executing", "waiting", "blocked", "completed", "failed", "cancelled", "recovery",
      ],
    }),
    toStatus: text("to_status", {
      enum: [
        "received", "understanding", "planning", "ready", "actionable",
        "awaiting_approval", "executing", "waiting", "blocked", "completed", "failed", "cancelled", "recovery",
      ],
    }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("work_events_work_seq_idx").on(t.workId, t.seq),
    index("work_events_tenant_work_idx").on(t.tenantId, t.workId),
  ],
);

// Upgrade 3: deterministic operational reads are durable Work children, but are
// not planner attempts. Only a bounded summary is persisted; the canonical result
// rows are always read afresh from the tenant tables and are never copied here.
export const workQueryExecutions = pgTable(
  "work_query_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    workInputId: uuid("work_input_id").references(() => workInputs.id),
    intent: text("intent", {
      enum: [
        "customer_lookup",
        "customer_cohort",
        "schedule_range",
        "money_summary",
        "work_list",
        "inventory_status",
        "agent_activity",
        "business_state",
        "company_context",
        "party_lookup",
        "party_context",
        "team_roster",
        "party_availability",
        "deal_context",
        "deal_workstreams",
        "open_requests",
        "open_findings",
        "open_deal_risks",
        "critical_dependencies",
        "closing_readiness",
        "pe_world_state",
      ],
    }).notNull(),
    request: jsonb("request").notNull().default({}),
    executionKey: text("execution_key").notNull(),
    status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull().default("running"),
    resultSummary: jsonb("result_summary"),
    rowCount: integer("row_count").notNull().default(0),
    durationMs: integer("duration_ms"),
    failure: jsonb("failure"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("work_query_executions_work_key_idx").on(t.workId, t.executionKey),
    index("work_query_executions_tenant_work_started_idx").on(t.tenantId, t.workId, t.startedAt),
    index("work_query_executions_tenant_status_started_idx").on(t.tenantId, t.status, t.startedAt),
    index("work_query_executions_tenant_input_idx").on(t.tenantId, t.workInputId),
  ],
);

// Upgrade 9: one governed controller per durable Work objective. Business effects
// remain in domain_actions/workflows/operations/receipts; this row only owns the
// recoverable loop cursor and explicit autonomy budgets.
export const workObjectiveLoops = pgTable(
  "work_objective_loops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    objective: text("objective").notNull(),
    state: text("state", { enum: ["continue", "awaiting_approval", "waiting", "blocked", "completed", "failed", "cancelled"] }).notNull().default("continue"),
    revision: integer("revision").notNull().default(1),
    stepCount: integer("step_count").notNull().default(0),
    actionCount: integer("action_count").notNull().default(0),
    queryCount: integer("query_count").notNull().default(0),
    plannerFailureCount: integer("planner_failure_count").notNull().default(0),
    consecutiveNoProgress: integer("consecutive_no_progress").notNull().default(0),
    maxSteps: integer("max_steps").notNull().default(12),
    maxActions: integer("max_actions").notNull().default(5),
    maxQueries: integer("max_queries").notNull().default(12),
    maxPlannerFailures: integer("max_planner_failures").notNull().default(3),
    maxConsecutiveNoProgress: integer("max_consecutive_no_progress").notNull().default(3),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull().default(sql`now() + interval '7 days'`),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    reason: text("reason"),
    nextStep: text("next_step"),
    lastObservation: jsonb("last_observation"),
    successCondition: jsonb("success_condition").notNull(),
    successVerification: jsonb("success_verification"),
    successVerifiedAt: timestamp("success_verified_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    initialChannel: text("initial_channel", { enum: ["voice", "text", "console"] }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("work_objective_loops_tenant_id_id_key").on(t.tenantId, t.id),
    unique("work_objective_loops_work_idx").on(t.workId),
    index("work_objective_loops_tenant_state_next_idx").on(t.tenantId, t.state, t.nextRunAt),
  ],
);

// Phase 6 conversation kernel. These are authenticated-employee conversations,
// deliberately separate from the provider/customer `conversations` and `messages`
// tables below. A browser/call session may be recorded as transport provenance,
// but it is never the durable conversation identity.
export const employeeConversationThreads = pgTable(
  "employee_conversation_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    ownerEmployeeId: uuid("owner_employee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    visibility: text("visibility", { enum: ["private"] }).notNull().default("private"),
    title: text("title"),
    summary: text("summary"),
    summaryThroughSequence: integer("summary_through_sequence").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    activeReferences: jsonb("active_references").notNull().default([]),
    unresolvedReferences: jsonb("unresolved_references").notNull().default([]),
    activeWorkId: uuid("active_work_id").references(() => works.id),
    activeObjectiveLoopId: uuid("active_objective_loop_id").references(() => workObjectiveLoops.id),
    outcomeRefs: jsonb("outcome_refs").notNull().default([]),
    originTransportKey: text("origin_transport_key"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("employee_conversation_threads_tenant_id_owner_key").on(t.tenantId, t.id, t.ownerEmployeeId),
    unique("employee_conversation_threads_transport_key").on(t.tenantId, t.ownerEmployeeId, t.originTransportKey),
    index("employee_conversation_threads_owner_activity_idx").on(t.tenantId, t.ownerEmployeeId, t.lastActivityAt),
    foreignKey({
      columns: [t.tenantId, t.ownerEmployeeId],
      foreignColumns: [users.tenantId, users.id],
      name: "employee_conversation_threads_owner_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.activeWorkId],
      foreignColumns: [works.tenantId, works.id],
      name: "employee_conversation_threads_work_tenant_fkey",
    }),
    foreignKey({
      columns: [t.tenantId, t.activeObjectiveLoopId],
      foreignColumns: [workObjectiveLoops.tenantId, workObjectiveLoops.id],
      name: "employee_conversation_threads_objective_tenant_fkey",
    }),
  ],
);

export const employeeConversationMessages = pgTable(
  "employee_conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    threadId: uuid("thread_id").notNull().references(() => employeeConversationThreads.id, { onDelete: "cascade" }),
    ownerEmployeeId: uuid("owner_employee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    channel: text("channel", { enum: ["voice", "text", "console"] }).notNull(),
    authorEmployeeId: uuid("author_employee_id").references(() => users.id),
    originalText: text("original_text").notNull(),
    instructionId: uuid("instruction_id"),
    workId: uuid("work_id").references(() => works.id),
    workInputId: uuid("work_input_id").references(() => workInputs.id),
    idempotencyKey: text("idempotency_key").notNull(),
    transportSessionId: text("transport_session_id"),
    transportProvenance: jsonb("transport_provenance").notNull().default({}),
    resolutionSnapshot: jsonb("resolution_snapshot"),
    resolutionProvenance: jsonb("resolution_provenance").notNull().default([]),
    companyTruthSnapshot: jsonb("company_truth_snapshot"),
    outcomeRefs: jsonb("outcome_refs").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("employee_conversation_messages_tenant_id_owner_key").on(t.tenantId, t.id, t.ownerEmployeeId),
    unique("employee_conversation_messages_thread_sequence_key").on(t.threadId, t.sequence),
    unique("employee_conversation_messages_thread_idempotency_key").on(t.threadId, t.idempotencyKey),
    index("employee_conversation_messages_owner_created_idx").on(t.tenantId, t.ownerEmployeeId, t.createdAt),
    index("employee_conversation_messages_thread_created_idx").on(t.threadId, t.createdAt),
    foreignKey({
      columns: [t.tenantId, t.threadId, t.ownerEmployeeId],
      foreignColumns: [employeeConversationThreads.tenantId, employeeConversationThreads.id, employeeConversationThreads.ownerEmployeeId],
      name: "employee_conversation_messages_thread_owner_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.authorEmployeeId],
      foreignColumns: [users.tenantId, users.id],
      name: "employee_conversation_messages_author_tenant_fkey",
    }),
    foreignKey({
      columns: [t.tenantId, t.workId],
      foreignColumns: [works.tenantId, works.id],
      name: "employee_conversation_messages_work_tenant_fkey",
    }),
    foreignKey({
      columns: [t.tenantId, t.workInputId],
      foreignColumns: [workInputs.tenantId, workInputs.id],
      name: "employee_conversation_messages_work_input_tenant_fkey",
    }),
  ],
);

// Only explicit human-authored facts are eligible for this table. Runtime code
// supersedes an active subject row instead of silently overwriting history.
export const employeePersonalMemories = pgTable(
  "employee_personal_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    ownerEmployeeId: uuid("owner_employee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sourceThreadId: uuid("source_thread_id").notNull().references(() => employeeConversationThreads.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").notNull().references(() => employeeConversationMessages.id, { onDelete: "cascade" }),
    memoryType: text("memory_type", { enum: ["preference", "proposition"] }).notNull(),
    subjectKey: text("subject_key").notNull(),
    proposition: text("proposition").notNull(),
    structuredValue: jsonb("structured_value").notNull().default({}),
    provenance: jsonb("provenance").notNull().default({}),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("employee_personal_memories_tenant_id_owner_key").on(t.tenantId, t.id, t.ownerEmployeeId),
    index("employee_personal_memories_owner_subject_idx").on(t.tenantId, t.ownerEmployeeId, t.subjectKey, t.validFrom),
    foreignKey({
      columns: [t.tenantId, t.ownerEmployeeId],
      foreignColumns: [users.tenantId, users.id],
      name: "employee_personal_memories_owner_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.sourceThreadId, t.ownerEmployeeId],
      foreignColumns: [employeeConversationThreads.tenantId, employeeConversationThreads.id, employeeConversationThreads.ownerEmployeeId],
      name: "employee_personal_memories_thread_owner_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.sourceMessageId, t.ownerEmployeeId],
      foreignColumns: [employeeConversationMessages.tenantId, employeeConversationMessages.id, employeeConversationMessages.ownerEmployeeId],
      name: "employee_personal_memories_message_owner_fkey",
    }).onDelete("cascade"),
  ],
);

// Records the one-way quarantine boundary for pre-Phase-6 tenant-wide Zep users.
// New runtime code never reads or copies these graph identities.
export const legacyZepGraphQuarantine = pgTable("legacy_zep_graph_quarantine", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  legacyUserId: text("legacy_user_id").notNull(),
  policy: text("policy", { enum: ["quarantined_no_query_no_copy"] }).notNull().default("quarantined_no_query_no_copy"),
  reason: text("reason").notNull(),
  quarantinedAt: timestamp("quarantined_at", { withTimezone: true }).notNull().defaultNow(),
});

// Upgrade 7: the only stored graph edge. Existing foreign keys remain the truth
// for every other relationship; Work needs this table because its business subject
// was previously discoverable only by recursively scanning arbitrary JSON fields.
export const workEntityLinks = pgTable(
  "work_entity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    relationship: text("relationship", { enum: ["about", "target", "result"] }).notNull().default("about"),
    source: text("source").notNull().default("runtime"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("work_entity_links_identity_idx").on(t.workId, t.entityType, t.entityId, t.relationship),
    index("work_entity_links_tenant_work_idx").on(t.tenantId, t.workId),
    index("work_entity_links_tenant_entity_idx").on(t.tenantId, t.entityType, t.entityId),
  ],
);

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  address: text("address").notNull(),
  contactInfo: jsonb("contact_info").notNull().default({}),
  waterProfile: jsonb("water_profile").notNull().default({}),
  // TCPA: bulk outreach filters on this — false means never contact promotionally.
  marketingConsent: boolean("marketing_consent").notNull().default(false),
  // D5.T1: explicitly stored coordinates for dispatch. Null is meaningful: the UI
  // must state that a household cannot be placed, never geocode silently in a map
  // render or invent a location.
  latitude: real("latitude"),
  longitude: real("longitude"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const equipment = pgTable("equipment", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().default(sql`finnor_os.request_tenant_id()`).references(() => tenants.id),
  householdId: uuid("household_id").notNull().references(() => households.id),
  type: text("type").notNull(),
  model: text("model"),
  installDate: timestamp("install_date", { withTimezone: true }),
  source: text("source", { enum: ["finnor", "competitor"] }).notNull().default("finnor"),
});

export const technicians = pgTable("technicians", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  contactInfo: jsonb("contact_info").notNull().default({}),
  availability: jsonb("availability").notNull().default({}),
});

export const serviceVisits = pgTable("service_visits", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().default(sql`finnor_os.request_tenant_id()`).references(() => tenants.id),
  householdId: uuid("household_id").notNull().references(() => households.id),
  technicianId: uuid("technician_id").references(() => technicians.id),
  type: text("type").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  notes: text("notes"),
});

export const maintenanceAgreements = pgTable("maintenance_agreements", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().default(sql`finnor_os.request_tenant_id()`).references(() => tenants.id),
  householdId: uuid("household_id").notNull().references(() => households.id),
  cadence: text("cadence").notNull(),
  terms: jsonb("terms").notNull().default({}),
  status: text("status", { enum: ["active", "renewal_window", "renewal_sent", "renewed", "lapsed"] })
    .notNull()
    .default("active"),
  renewalDate: timestamp("renewal_date", { withTimezone: true }),
  // §2.6: the AMC renewal sequence's "wait" state, ported from Temporal's durable
  // timer to a periodically-ticked scan (scheduled-reminder.ts) — null until that
  // reminder has actually been sent.
  firstReminderSentAt: timestamp("first_reminder_sent_at", { withTimezone: true }),
  secondReminderSentAt: timestamp("second_reminder_sent_at", { withTimezone: true }),
});

export const proposals = pgTable("proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().default(sql`finnor_os.request_tenant_id()`).references(() => tenants.id),
  householdId: uuid("household_id").notNull().references(() => households.id),
  content: jsonb("content").notNull().default({}),
  status: text("status").notNull().default("draft"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  // Nullable: proposals predating the quotes table have no quote to point to.
  quoteId: uuid("quote_id"),
});

export const communicationsLog = pgTable("communications_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().default(sql`finnor_os.request_tenant_id()`).references(() => tenants.id),
  householdId: uuid("household_id").notNull().references(() => households.id),
  channel: text("channel").notNull(),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  content: text("content").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
});

export const domainPolicies = pgTable(
  "domain_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    actionType: text("action_type").notNull(),
    policy: jsonb("policy").notNull().default({}),
    requiresConfirmation: boolean("requires_confirmation").notNull().default(true),
    confirmationTemplate: text("confirmation_template"),
    modelProvider: text("model_provider"),
    // §2.8: how long a gated action may sit "pending" before scan_approval_expiry
    // escalates it to needs_human_review. Null = the application-level default (24h)
    // applies — never a fabricated per-row guess.
    confirmationTimeoutHours: integer("confirmation_timeout_hours"),
    // §3.1: bumped whenever this row's policy/requiresConfirmation config changes —
    // what decision_receipts.policy_applied.version actually cites (previously always
    // null, migration 0023).
    version: integer("version").notNull().default(1),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    unique("domain_policies_tenant_id_id_key").on(t.tenantId, t.id),
    unique("domain_policies_tenant_action_unique_idx").on(t.tenantId, t.actionType),
  ],
);

export const domainPolicyRevisions = pgTable(
  "domain_policy_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    policyId: uuid("policy_id").notNull().references(() => domainPolicies.id),
    actionType: text("action_type").notNull(),
    version: integer("version").notNull(),
    policy: jsonb("policy").notNull().default({}),
    requiresConfirmation: boolean("requires_confirmation").notNull(),
    confirmationTemplate: text("confirmation_template"),
    modelProvider: text("model_provider"),
    confirmationTimeoutHours: integer("confirmation_timeout_hours"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("domain_policy_revisions_policy_version_idx").on(t.policyId, t.version),
    index("domain_policy_revisions_tenant_action_effective_idx").on(t.tenantId, t.actionType, t.effectiveFrom),
  ],
);

export const domainActions = pgTable(
  "domain_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    actionType: text("action_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    policyId: uuid("policy_id").references(() => domainPolicies.id),
    policyVersion: integer("policy_version"),
    status: text("status", {
      enum: [
        "draft",
        "pending",
        "approved",
        "rejected",
        "executing",
        "completed",
        "failed",
        "needs_human_review",
        "blocked_integration_unavailable",
      ],
    })
      .notNull()
      .default("draft"),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    executionStartedAt: timestamp("execution_started_at", { withTimezone: true }),
    // Phase 6 typed plan compiler (§6): populated once, right after the Planner's LLM
    // output is validated, before the row is ever gated or executed. Nullable — rows
    // created before this phase, and any row inserted by a path that bypasses the
    // compiler, simply have neither.
    groundedPayload: jsonb("grounded_payload"),
    compiledGraph: jsonb("compiled_graph"),
    // B2.T1: rows from a single planner turn share a plan id. Dependencies are
    // materialized from same-transaction sibling ids, never accepted from a client.
    planId: uuid("plan_id"),
    dependsOn: uuid("depends_on").array().notNull().default([]),
    // B2.T2: an explicitly labeled no-write prediction while the action is pending.
    predictedReceipt: jsonb("predicted_receipt"),
    predictionDiff: jsonb("prediction_diff"),
    repairedFromPlanId: uuid("repaired_from_plan_id"),
    // jarvis-v3 P3.T1 (migration 0062): the client-minted instruction id that produced
    // this action, when the caller supplied one — nullable (draftKnownAction and every
    // pre-P3 row have none).
    instructionId: uuid("instruction_id"),
    workId: uuid("work_id").references(() => works.id),
    plannerAttemptId: uuid("planner_attempt_id").references(() => workPlannerAttempts.id),
    initiatedBy: uuid("initiated_by").references(() => users.id),
    authorityDecisionId: uuid("authority_decision_id").references(() => authorityDecisions.id),
    authorityRevision: integer("authority_revision"),
    authorityContext: jsonb("authority_context").notNull().default({}),
    // The database migration carries the FK. The schema deliberately keeps this
    // as a UUID to avoid a circular module declaration: objective steps also point
    // back to their one typed action.
    objectiveStepId: uuid("objective_step_id"),
    // Phase 1 Universal Business Effect kernel. Nullable for deterministic reads and
    // historical actions; consequential execution resolves this tenant-consistent ref.
    businessEffectId: uuid("business_effect_id"),
  },
  (t) => [
    index("domain_actions_tenant_status_idx").on(t.tenantId, t.status),
    index("domain_actions_tenant_plan_idx").on(t.tenantId, t.planId),
    index("domain_actions_work_idx").on(t.workId),
    unique("domain_actions_objective_step_idx").on(t.objectiveStepId),
    unique("domain_actions_tenant_id_id_key").on(t.tenantId, t.id),
  ],
);

/** Immutable semantic intent compiled from a validated/grounded DomainAction before
 * authority, approval, or execution. Lifecycle/verification columns may advance;
 * the effect body and hashes are frozen by migration trigger. */
export const businessEffects = pgTable(
  "business_effects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    domainActionId: uuid("domain_action_id").references(() => domainActions.id),
    version: integer("version").notNull().default(1),
    semanticHash: text("semantic_hash").notNull(),
    scopeHash: text("scope_hash").notNull(),
    operationClass: text("operation_class", { enum: ["internal_draft", "internal_write", "operational_change", "financial_write", "external_side_effect", "external_spend", "batch_external", "durable_workflow"] }).notNull(),
    effect: jsonb("effect").notNull(),
    status: text("status", { enum: ["compiled", "authorized", "executing", "executed", "verified", "partially_verified", "unverified", "divergent", "reconciliation_required", "failed", "cancelled", "compensated"] }).notNull().default("compiled"),
    observedResult: jsonb("observed_result"),
    verification: jsonb("verification"),
    replacementForEffectId: uuid("replacement_for_effect_id"),
    compensationForEffectId: uuid("compensation_for_effect_id"),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    executionStartedAt: timestamp("execution_started_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("business_effects_action_unique").on(t.domainActionId),
    unique("business_effects_tenant_id_id_key").on(t.tenantId, t.id),
    index("business_effects_tenant_status_idx").on(t.tenantId, t.status, t.createdAt),
    index("business_effects_tenant_hash_idx").on(t.tenantId, t.semanticHash),
  ],
);

export const workObjectiveSteps = pgTable(
  "work_objective_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    objectiveLoopId: uuid("objective_loop_id").notNull().references(() => workObjectiveLoops.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    stepNumber: integer("step_number").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    phase: text("phase", { enum: ["inspecting", "deciding", "acting", "observing", "finished"] }).notNull().default("inspecting"),
    inspection: jsonb("inspection"),
    inspectionHash: text("inspection_hash"),
    decisionKind: text("decision_kind", { enum: ["query", "action", "wait", "complete", "block", "fail"] }),
    decision: jsonb("decision"),
    decisionReason: text("decision_reason"),
    authorityDecisionId: uuid("authority_decision_id").references(() => authorityDecisions.id),
    queryExecutionId: uuid("query_execution_id").references(() => workQueryExecutions.id),
    domainActionId: uuid("domain_action_id").references(() => domainActions.id),
    observation: jsonb("observation"),
    progressMade: boolean("progress_made"),
    iterationOutcome: text("iteration_outcome", { enum: ["continue", "awaiting_approval", "waiting", "blocked", "completed", "failed", "cancelled"] }),
    recoveryKind: text("recovery_kind", { enum: ["retry", "replan", "recover", "compensate", "escalate", "block"] }),
    successVerification: jsonb("success_verification"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    failure: jsonb("failure"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("work_objective_steps_loop_number_idx").on(t.objectiveLoopId, t.stepNumber),
    unique("work_objective_steps_loop_key_idx").on(t.objectiveLoopId, t.idempotencyKey),
    unique("work_objective_steps_action_idx").on(t.domainActionId),
    unique("work_objective_steps_query_idx").on(t.queryExecutionId),
    index("work_objective_steps_tenant_loop_idx").on(t.tenantId, t.objectiveLoopId, t.stepNumber),
    index("work_objective_steps_tenant_outcome_idx").on(t.tenantId, t.iterationOutcome, t.completedAt),
  ],
);

// Phase 5 Certified Outcome Packs. These rows bind the pack/autonomy contract to the
// existing Work + Objective controller; they do not own execution or authorization.
export const outcomePackRuns = pgTable(
  "outcome_pack_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    objectiveLoopId: uuid("objective_loop_id").notNull().references(() => workObjectiveLoops.id),
    packId: text("pack_id").notNull(),
    packVersion: integer("pack_version").notNull(),
    mode: text("mode", { enum: ["shadow", "approval", "autopilot"] }).notNull(),
    status: text("status", { enum: ["active", "paused", "blocked", "shadow_recorded", "completed", "failed", "cancelled"] }).notNull().default("active"),
    certificationFingerprint: text("certification_fingerprint").notNull(),
    objective: text("objective").notNull(),
    input: jsonb("input").notNull().default({}),
    subjectRefs: jsonb("subject_refs").notNull().default([]),
    successCondition: jsonb("success_condition").notNull(),
    blockedReason: text("blocked_reason"),
    finalVerification: jsonb("final_verification"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("outcome_pack_runs_work_idx").on(t.workId),
    unique("outcome_pack_runs_objective_idx").on(t.objectiveLoopId),
    index("outcome_pack_runs_tenant_pack_status_idx").on(t.tenantId, t.packId, t.status, t.createdAt),
  ],
);

export const tenantOutcomePackSettings = pgTable(
  "tenant_outcome_pack_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    packId: text("pack_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    defaultMode: text("default_mode", { enum: ["shadow", "approval", "autopilot"] }).notNull().default("approval"),
    reason: text("reason"),
    revision: integer("revision").notNull().default(1),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("tenant_outcome_pack_settings_tenant_pack_idx").on(t.tenantId, t.packId)],
);

export const outcomePackCertifications = pgTable(
  "outcome_pack_certifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    packId: text("pack_id").notNull(),
    packVersion: integer("pack_version").notNull(),
    level: text("level", { enum: ["deterministic", "chaos", "sandbox", "live_provider", "production"] }).notNull(),
    status: text("status", { enum: ["LOCAL_PASS", "SANDBOX_PASS", "LIVE_TEST_PASS", "BLOCKED_CONFIG", "NOT_CERTIFIED", "SUSPENDED"] }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    dependencyVersions: jsonb("dependency_versions").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    sampleSize: integer("sample_size").notNull().default(0),
    criticalViolations: integer("critical_violations").notNull().default(0),
    certifiedAt: timestamp("certified_at", { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspensionReason: text("suspension_reason"),
  },
  (t) => [
    unique("outcome_pack_certification_identity_idx").on(t.tenantId, t.packId, t.packVersion, t.level, t.fingerprint),
    index("outcome_pack_certification_current_idx").on(t.tenantId, t.packId, t.status, t.validUntil),
  ],
);

export const autonomyGrants = pgTable(
  "autonomy_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    packId: text("pack_id").notNull(),
    packVersion: integer("pack_version").notNull(),
    status: text("status", { enum: ["active", "suspended", "revoked", "expired"] }).notNull().default("active"),
    effectClasses: text("effect_classes").array().notNull(),
    resourceScope: jsonb("resource_scope").notNull(),
    principal: text("principal").notNull(),
    providerScope: jsonb("provider_scope").notNull().default([]),
    maxAmountUsd: numeric("max_amount_usd", { precision: 14, scale: 2 }),
    maxRisk: text("max_risk", { enum: ["low", "medium", "high"] }).notNull().default("low"),
    policyVersion: integer("policy_version"),
    authorityRevision: integer("authority_revision").notNull(),
    certificationFingerprint: text("certification_fingerprint").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reviewAfter: timestamp("review_after", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    revokedBy: uuid("revoked_by").references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("autonomy_grants_scope_idx").on(t.tenantId, t.packId, t.status, t.expiresAt)],
);

export const autonomyEvaluations = pgTable(
  "autonomy_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    outcomePackRunId: uuid("outcome_pack_run_id").notNull().references(() => outcomePackRuns.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    domainActionId: uuid("domain_action_id").references(() => domainActions.id),
    businessEffectId: uuid("business_effect_id").references(() => businessEffects.id),
    grantId: uuid("grant_id").references(() => autonomyGrants.id),
    mode: text("mode", { enum: ["shadow", "approval", "autopilot"] }).notNull(),
    outcome: text("outcome", { enum: ["shadow_only", "approval_required", "autopilot_allowed", "blocked"] }).notNull(),
    eligible: boolean("eligible").notNull(),
    reasonCodes: text("reason_codes").array().notNull(),
    authorityRevision: integer("authority_revision"),
    policyVersion: integer("policy_version"),
    certificationFingerprint: text("certification_fingerprint").notNull(),
    sourceHealthSnapshot: jsonb("source_health_snapshot").notNull().default([]),
    scopeSnapshot: jsonb("scope_snapshot").notNull().default({}),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("autonomy_evaluations_pack_time_idx").on(t.tenantId, t.outcomePackRunId, t.evaluatedAt),
    index("autonomy_evaluations_effect_idx").on(t.businessEffectId),
  ],
);

export const outcomeShadowProposals = pgTable(
  "outcome_shadow_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    outcomePackRunId: uuid("outcome_pack_run_id").notNull().references(() => outcomePackRuns.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
    businessEffectId: uuid("business_effect_id").notNull().references(() => businessEffects.id),
    semanticHash: text("semantic_hash").notNull(),
    hypotheticalEffect: jsonb("hypothetical_effect").notNull(),
    expectedOutcome: jsonb("expected_outcome"),
    comparisonStatus: text("comparison_status", { enum: ["pending", "matched", "modified", "divergent", "unsafe", "inconclusive"] }).notNull().default("pending"),
    observedOutcome: jsonb("observed_outcome"),
    comparison: jsonb("comparison"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    comparedAt: timestamp("compared_at", { withTimezone: true }),
  },
  (t) => [
    unique("outcome_shadow_proposals_action_idx").on(t.domainActionId),
    unique("outcome_shadow_proposals_effect_idx").on(t.businessEffectId),
    index("outcome_shadow_proposals_pack_status_idx").on(t.tenantId, t.outcomePackRunId, t.comparisonStatus),
  ],
);

export const workObjectivePlannerAttempts = pgTable(
  "work_objective_planner_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    objectiveLoopId: uuid("objective_loop_id").notNull().references(() => workObjectiveLoops.id),
    objectiveStepId: uuid("objective_step_id").notNull().references(() => workObjectiveSteps.id),
    attempt: integer("attempt").notNull(),
    status: text("status", { enum: ["planning", "succeeded", "failed", "timed_out"] }).notNull().default("planning"),
    provider: text("provider"),
    inspectionHash: text("inspection_hash").notNull(),
    decision: jsonb("decision"),
    failure: jsonb("failure"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("work_objective_attempts_step_attempt_idx").on(t.objectiveStepId, t.attempt),
    index("work_objective_attempts_tenant_loop_idx").on(t.tenantId, t.objectiveLoopId, t.startedAt),
  ],
);

export const planRepairs = pgTable(
  "plan_repairs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    failedDomainActionId: uuid("failed_domain_action_id").notNull().references(() => domainActions.id),
    workId: uuid("work_id").references(() => works.id),
    sourcePlanId: uuid("source_plan_id").notNull(),
    repairPlanId: uuid("repair_plan_id"),
    terminalReceipt: jsonb("terminal_receipt").notNull(),
    status: text("status", { enum: ["planning", "proposed", "no_remainder", "failed"] }).notNull().default("planning"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    proposedAt: timestamp("proposed_at", { withTimezone: true }),
  },
  (t) => [unique("plan_repairs_failed_action_idx").on(t.failedDomainActionId), index("plan_repairs_tenant_source_plan_idx").on(t.tenantId, t.sourcePlanId)],
);

// Episodic memory: append-only, never updated or deleted (§10, §19).
export const actionLog = pgTable(
  "action_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    step: text("step").notNull(),
    input: jsonb("input").notNull().default({}),
    output: jsonb("output").notNull().default({}),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("action_log_action_idx").on(t.domainActionId)],
);

export const embeddings = pgTable(
  "embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    // Phase 5 (§5.2 chunking spec): "no orphan chunks" — every chunk traces to the
    // real record it came from. NOT NULL enforced at the DB layer by migration 0027.
    sourceDocId: text("source_doc_id").notNull(),
    // Additive alongside the loose sourceDocId text field above — new ingestion can
    // point here once a real documents row exists; sourceDocId stays for back-compat.
    documentId: uuid("document_id"),
    documentVersionId: uuid("document_version_id"),
    chunk: text("chunk").notNull(),
    // Phase 5 (§5.1): Voyage AI voyage-3.5, 1024-dim (migration 0027 retypes the
    // column — this table had zero real writers before this phase, see that migration).
    embedding: vector("embedding", { dimensions: 1024 }),
    // Phase 5 (§5.2): chunk metadata the chunking spec requires — which real entities
    // this chunk mentions, and when the underlying event/fact occurred (not when it was
    // embedded) so hybrid retrieval can reason about recency and supersession.
    entityRefs: jsonb("entity_refs").notNull().default([]),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    // Exact-content identity and provenance belong on the memory row, not only
    // in the embedding cache.  Active rows are deduplicated by the migration's
    // partial unique index; corrected/replaced rows remain inspectable.
    contentHash: text("content_hash").notNull(),
    sourceKind: text("source_kind").notNull().default("semantic_history"),
    provenance: jsonb("provenance").notNull().default({}),
    supersedesId: uuid("supersedes_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    index("embeddings_tenant_idx").on(t.tenantId),
    index("embeddings_tenant_occurred_idx").on(t.tenantId, t.occurredAt),
    index("embeddings_tenant_active_idx").on(t.tenantId, t.sourceDocId, t.supersededAt),
  ],
);

// Evidence is deliberately separate from `business_events` and the existing
// semantic-memory table. `business_events` remains the immutable operational
// ledger; these rows are source-backed research material with versioned snapshots
// and retrieval metadata. Public rows use scope='public' and a null tenant_id so a
// safe cache can be reused without making tenant-owned rows globally visible.
export const evidenceSources = pgTable(
  "evidence_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope", { enum: ["tenant", "public"] }).notNull().default("tenant"),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    sourceKey: text("source_key").notNull(),
    sourceType: text("source_type").notNull(),
    canonicalUrl: text("canonical_url"),
    title: text("title").notNull(),
    publisher: text("publisher"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Uniqueness is scope-aware and nullable for public rows, so the migration uses
    // two partial unique indexes rather than Drizzle's nullable composite unique.
    index("evidence_sources_tenant_idx").on(t.tenantId, t.scope),
  ],
);

export const evidenceSourceVersions = pgTable(
  "evidence_source_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id").notNull().references(() => evidenceSources.id),
    scope: text("scope", { enum: ["tenant", "public"] }).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    versionNumber: integer("version_number").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    snapshot: jsonb("snapshot").notNull().default({}),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("evidence_source_versions_source_version_idx").on(t.sourceId, t.versionNumber),
    unique("evidence_source_versions_source_hash_idx").on(t.sourceId, t.contentHash),
    index("evidence_source_versions_scope_asof_idx").on(t.scope, t.tenantId, t.asOf),
  ],
);

export const evidenceChunks = pgTable(
  "evidence_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id").notNull().references(() => evidenceSources.id),
    versionId: uuid("version_id").notNull().references(() => evidenceSourceVersions.id),
    scope: text("scope", { enum: ["tenant", "public"] }).notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull(),
    entityRefs: jsonb("entity_refs").notNull().default([]),
    timeRefs: jsonb("time_refs").notNull().default([]),
    // The migration keeps a jsonb fallback for local Postgres without pgvector;
    // retrieval reads this column through raw SQL for both representations.
    embedding: vector("embedding", { dimensions: 1024 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("evidence_chunks_version_ordinal_idx").on(t.versionId, t.ordinal),
    index("evidence_chunks_scope_idx").on(t.scope, t.tenantId, t.versionId),
  ],
);

export const researchRuns = pgTable(
  "research_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    query: text("query").notNull(),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    searchConfig: jsonb("search_config").notNull().default({}),
    status: text("status", { enum: ["running", "completed", "failed"] }).notNull().default("running"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("research_runs_tenant_started_idx").on(t.tenantId, t.startedAt)],
);

export const researchRunHits = pgTable(
  "research_run_hits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    researchRunId: uuid("research_run_id").notNull().references(() => researchRuns.id),
    sourceId: uuid("source_id").notNull().references(() => evidenceSources.id),
    versionId: uuid("version_id").notNull().references(() => evidenceSourceVersions.id),
    chunkId: uuid("chunk_id").notNull().references(() => evidenceChunks.id),
    scope: text("scope", { enum: ["tenant", "public"] }).notNull(),
    rank: integer("rank").notNull(),
    fusedScore: real("fused_score").notNull(),
    lexicalScore: real("lexical_score"),
    vectorScore: real("vector_score"),
    excerpt: text("excerpt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("research_run_hits_run_chunk_idx").on(t.researchRunId, t.chunkId),
    index("research_run_hits_tenant_run_idx").on(t.tenantId, t.researchRunId, t.rank),
  ],
);

// Phase 5 (§5.1): content-hash cache so re-ingesting an unchanged chunk never pays for
// a second embedding call. Tenant-scoped (not global) — see migration 0028 for why a
// shared global cache would be a cross-tenant information leak.
export const embeddingCache = pgTable(
  "embedding_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    contentHash: text("content_hash").notNull(),
    model: text("model").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("embedding_cache_tenant_idx").on(t.tenantId),
    unique("embedding_cache_tenant_hash_model_idx").on(t.tenantId, t.contentHash, t.model),
  ],
);

// Phase 5 (§5.6 correction loop): an operator-supplied correction to a wrong AI answer,
// stored as a first-class fact that outranks semantic hits on the same topic thereafter.
// receiptId links back to the DecisionReceipt for the answer being corrected — real
// provenance, not a free-floating claim.
export const memoryCorrections = pgTable(
  "memory_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    receiptId: uuid("receipt_id").references(() => decisionReceipts.id),
    question: text("question").notNull(),
    wrongAnswer: text("wrong_answer").notNull(),
    correctedFact: text("corrected_fact").notNull(),
    correctedBy: text("corrected_by").notNull(),
    supersedesId: uuid("supersedes_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("memory_corrections_tenant_idx").on(t.tenantId),
    index("memory_corrections_active_idx").on(t.tenantId, t.supersededAt),
  ],
);

// RBAC permission matrix — which roles can approve which action_types, per tenant (§18).
export const rolePermissions = pgTable("role_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  role: text("role", { enum: ["owner", "dispatcher", "technician"] }).notNull(),
  actionType: text("action_type").notNull(),
  canApprove: boolean("can_approve").notNull().default(false),
});

// Postgres-backed job queue (§15–16). Not tenant-scoped: payloads carry tenant_id,
// workers re-establish tenant context per job.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status", { enum: ["queued", "running", "completed", "failed", "dead_letter", "quarantined"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lane: text("lane", { enum: ["interactive", "batch"] }).notNull().default("batch"),
    priority: integer("priority").notNull().default(0),
    // Idempotency: callers may supply a key; enqueue is a no-op if it already exists.
    idempotencyKey: text("idempotency_key").unique(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseHeartbeatAt: timestamp("lease_heartbeat_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_status_run_at_idx").on(t.status, t.runAt),
    index("jobs_expired_lease_idx").on(t.leaseExpiresAt).where(sql`${t.status} = 'running'`),
  ],
);

// Upgrade 6: the minimum durable business-operation envelope for work that cannot
// safely complete inside one approval request. Domain actions remain the authority
// boundary; an operation is the recoverable execution child authorized by that
// action. The first production use is customer win-back/bulk outreach.
export const businessOperations = pgTable(
  "business_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workId: uuid("work_id").references(() => works.id),
    domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
    businessEffectId: uuid("business_effect_id"),
    operationType: text("operation_type", { enum: ["customer_winback"] }).notNull(),
    status: text("status", {
      enum: ["awaiting_approval", "queued", "running", "completed", "completed_with_failures", "needs_human_review", "failed", "cancelled"],
    }).notNull().default("awaiting_approval"),
    configuration: jsonb("configuration").notNull().default({}),
    cohortDefinition: jsonb("cohort_definition").notNull().default({}),
    cohortFrozenAt: timestamp("cohort_frozen_at", { withTimezone: true }).notNull().defaultNow(),
    targetCount: integer("target_count").notNull().default(0),
    pendingCount: integer("pending_count").notNull().default(0),
    runningCount: integer("running_count").notNull().default(0),
    succeededCount: integer("succeeded_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    nextBatchSequence: integer("next_batch_sequence").notNull().default(0),
    approvedBy: text("approved_by"),
    authorityDecisionId: uuid("authority_decision_id").references(() => authorityDecisions.id),
    authorityRevision: integer("authority_revision"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    finalOutcome: jsonb("final_outcome"),
    failure: jsonb("failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("business_operations_action_idx").on(t.domainActionId),
    index("business_operations_tenant_work_idx").on(t.tenantId, t.workId),
    index("business_operations_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export const businessOperationTargets = pgTable(
  "business_operation_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    operationId: uuid("operation_id").notNull().references(() => businessOperations.id),
    targetType: text("target_type", { enum: ["household"] }).notNull().default("household"),
    targetId: uuid("target_id").notNull().references(() => households.id),
    ordinal: integer("ordinal").notNull(),
    status: text("status", { enum: ["pending", "running", "succeeded", "failed", "skipped", "retry"] }).notNull().default("pending"),
    frozenSnapshot: jsonb("frozen_snapshot").notNull().default({}),
    preparedPayload: jsonb("prepared_payload").notNull().default({}),
    idempotencyKey: text("idempotency_key").notNull(),
    jobKey: text("job_key"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    failureClass: text("failure_class", { enum: ["retryable", "policy", "configuration", "invalid_input", "human_review"] }),
    errorKind: text("error_kind", { enum: ["retryable", "terminal", "conflict", "auth", "validation", "provider_down", "needs_human", "config", "unknown_outcome"] }),
    lastError: text("last_error"),
    providerRef: text("provider_ref"),
    evidence: jsonb("evidence").notNull().default([]),
    result: jsonb("result"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("business_operation_targets_operation_target_idx").on(t.operationId, t.targetId),
    unique("business_operation_targets_idempotency_idx").on(t.idempotencyKey),
    index("business_operation_targets_operation_status_idx").on(t.operationId, t.status, t.nextAttemptAt),
    index("business_operation_targets_tenant_target_idx").on(t.tenantId, t.targetId),
  ],
);

export const businessOperationEvents = pgTable(
  "business_operation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    operationId: uuid("operation_id").notNull().references(() => businessOperations.id),
    targetId: uuid("target_id").references(() => businessOperationTargets.id),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("business_operation_events_operation_sequence_idx").on(t.operationId, t.sequence),
    index("business_operation_events_tenant_operation_idx").on(t.tenantId, t.operationId, t.sequence),
  ],
);

// Phase 4 (§4.4): durable per-provider circuit-breaker state — global per provider,
// not tenant-scoped, since a provider's own uptime doesn't vary by tenant. See
// migration 0026 for why this can't be in-memory (serverless invocations don't share
// process state).
export const providerCircuitState = pgTable("provider_circuit_state", {
  provider: text("provider").primaryKey(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  state: text("state", { enum: ["closed", "open"] }).notNull().default("closed"),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  probeLeaseOwner: text("probe_lease_owner"),
  probeLeaseExpiresAt: timestamp("probe_lease_expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A2.T4: dead-man-switch state — see migration 0035.
export const workerHeartbeat = pgTable("worker_heartbeat", {
  id: text("id").primaryKey(),
  lastBeatAt: timestamp("last_beat_at", { withTimezone: true }).notNull().defaultNow(),
  meta: jsonb("meta").notNull().default({}),
});

export const serviceReleaseHeartbeats = pgTable(
  "service_release_heartbeats",
  {
    service: text("service").notNull(),
    instanceId: text("instance_id").notNull(),
    releaseSha: text("release_sha").notNull(),
    buildId: text("build_id").notNull(),
    version: text("version").notNull(),
    releaseSource: text("release_source").notNull(),
    coreCertificationId: text("core_certification_id"),
    migrationHead: text("migration_head").notNull(),
    deploymentId: text("deployment_id"),
    capabilities: text("capabilities").array().notNull().default([]),
    environment: text("environment").notNull(),
    cutoverProtocol: integer("cutover_protocol").notNull().default(0),
    productEpoch: integer("product_epoch").notNull().default(0),
    lastBeatAt: timestamp("last_beat_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.service, t.instanceId] }),
    index("service_release_heartbeats_fresh_idx").on(t.service, t.lastBeatAt),
  ],
);

/** The single durable product-authority owner used by API, worker, orchestrator,
 * scheduler, source sync, and release certification. */
export const productRuntimeAuthority = pgTable("product_runtime_authority", {
  authorityKey: text("authority_key").primaryKey(),
  epoch: integer("epoch").notNull().default(5),
  state: text("state", { enum: ["preparing", "water_intake_frozen", "water_retired"] }).notNull().default("preparing"),
  activeProductVertical: text("active_product_vertical").notNull().default("private_equity"),
  minimumCutoverProtocol: integer("minimum_cutover_protocol").notNull().default(5),
  waterIntakeFrozenAt: timestamp("water_intake_frozen_at", { withTimezone: true }),
  waterRetiredAt: timestamp("water_retired_at", { withTimezone: true }),
  activatedBy: text("activated_by"),
  activationEvidence: jsonb("activation_evidence").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const waterTenantRetirementDispositions = pgTable("water_tenant_retirement_dispositions", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  classification: text("classification", { enum: ["SYNTHETIC_REFERENCE", "TEST", "STAGING", "REAL_PRODUCTION", "UNKNOWN"] }).notNull(),
  authorized: boolean("authorized").notNull().default(false),
  authorizationRef: text("authorization_ref"),
  obligations: jsonb("obligations").notNull().default([]),
  classifiedBy: text("classified_by").notNull(),
  classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiRateLimits = pgTable("api_rate_limits", {
  bucketKey: text("bucket_key").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(0),
});

export const webhookReceipts = pgTable("webhook_receipts", {
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const externalOperations = pgTable("external_operations", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
  operationKey: text("operation_key").notNull(),
  // The exact ToolRegistry integration selected for this attempt. Historical rows
  // remain null rather than being guessed from action type or current tenant config.
  provider: text("provider"),
  integrationId: uuid("integration_id"),
  businessEffectId: uuid("business_effect_id"),
  requestHash: text("request_hash").notNull(),
  status: text("status", { enum: ["running", "succeeded", "failed", "unknown"] }).notNull(),
  response: jsonb("response"),
  providerAcknowledgedAt: timestamp("provider_acknowledged_at", { withTimezone: true }),
  externalObservedAt: timestamp("external_observed_at", { withTimezone: true }),
  verificationStatus: text("verification_status", { enum: ["not_required", "awaiting_observation", "verified", "divergent", "unknown"] }).notNull().default("not_required"),
  observation: jsonb("observation"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Workflow engine state machines (§14): explicit state + transition history per subject.
export const workflowStates = pgTable("workflow_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  workflow: text("workflow").notNull(), // e.g. "lead_to_install", "amc_renewal"
  subjectType: text("subject_type").notNull(), // "household" | "maintenance_agreement"
  subjectId: uuid("subject_id").notNull(),
  state: text("state").notNull(),
  history: jsonb("history").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Sandbox outbox: real, observable record of every outbound comm while carriers are
// not yet connected. The console's Communications view reads this.
export const sandboxOutbox = pgTable("sandbox_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  channel: text("channel", { enum: ["sms", "call", "email"] }).notNull(),
  toNumber: text("to_number").notNull(),
  content: text("content").notNull(),
  simulated: boolean("simulated").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Native inventory ledger — Finnor is the system of record, no external SaaS.
export const inventoryItems = pgTable("inventory_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  quantity: integer("quantity").notNull().default(0),
  reorderThreshold: integer("reorder_threshold").notNull().default(0),
  unitCostUsd: money("unit_cost_usd"),
});

// Native accounting ledger.
export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  householdId: uuid("household_id").notNull().references(() => households.id),
  amountUsd: money("amount_usd").notNull(),
  status: text("status", { enum: ["draft", "sent", "paid", "overdue", "void"] }).notNull().default("draft"),
  memo: text("memo"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Proactive scan findings (§14 extension): a staging area for scans with no natural
// mutating action to draft into (low inventory, service-due) — the owner digest job
// reads undigested rows, speaks/logs them, marks them digested.
export const scanFindings = pgTable("scan_findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  scanType: text("scan_type").notNull(),
  summary: text("summary").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  digestedAt: timestamp("digested_at", { withTimezone: true }),
  // Phase 12 (loop closure): severity feeds risk tiering, draftedActionId links a
  // finding to the gated action it caused a config-gated scan to draft (null when the
  // scan only recorded a finding — no config, or the scan has no drafting path at all).
  severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull().default("info"),
  draftedActionId: uuid("drafted_action_id").references(() => domainActions.id),
});

// ---------------------------------------------------------------------------
// Canonical business data platform (Phase 1, docs/jarvis-90-execution-blueprint.md §1).
// Every table below: direct tenant_id RLS (see migrations/0008), archivable, and
// provenance columns where the entity can originate from an import. `households`
// remains the de facto customer/account entity (renaming it is out of scope — too
// much blast radius); these tables add the canonical layer around it instead of
// replacing it. Writes to these tables should go through @finnor/data-platform,
// not raw inserts from a plugin.
// ---------------------------------------------------------------------------

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  householdId: uuid("household_id").references(() => households.id),
  name: text("name").notNull(),
  // Structured names are additive: legacy callers can continue to use `name`, while
  // declarative imports no longer have to flatten materially different dealer fields.
  firstName: text("first_name"),
  lastName: text("last_name"),
  role: text("role"), // e.g. "primary", "spouse", "billing" — free text, not enforced
  ...archivable(),
  ...provenanceColumns(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contactMethods = pgTable(
  "contact_methods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    contactId: uuid("contact_id").notNull().references(() => contacts.id),
    methodType: text("method_type", { enum: ["phone", "email", "sms"] }).notNull(),
    value: text("value").notNull(),
    consent: boolean("consent").notNull().default(false),
    consentRecordedAt: timestamp("consent_recorded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("contact_methods_contact_value_idx").on(t.contactId, t.methodType, t.value)],
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    // Nullable at the schema level (a lead need not eagerly own a household), but the
    // crm plugin populates this immediately today — see packages/data-platform/src/leads.ts
    // for the documented dual-write compromise.
    householdId: uuid("household_id").references(() => households.id),
    contactMethodId: uuid("contact_method_id").references(() => contactMethods.id),
    name: text("name").notNull(),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    status: text("status", {
      enum: ["new", "contacted", "qualified", "disqualified", "converted"],
    })
      .notNull()
      .default("new"),
    disqualifyReason: text("disqualify_reason"),
    source: text("source"), // e.g. "voice", "web", "referral"
    notes: text("notes"),
    ...archivable(),
    ...provenanceColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("leads_tenant_source_external_idx").on(t.tenantId, t.sourceSystem, t.externalId)],
);

export const opportunities = pgTable("opportunities", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  leadId: uuid("lead_id").references(() => leads.id),
  householdId: uuid("household_id").references(() => households.id),
  pipelineStage: text("pipeline_stage", { enum: ["open", "quote_sent", "won", "lost"] })
    .notNull()
    .default("open"),
  expectedValueUsd: money("expected_value_usd"),
  wonAt: timestamp("won_at", { withTimezone: true }),
  lostAt: timestamp("lost_at", { withTimezone: true }),
  lostReason: text("lost_reason"),
  ...archivable(),
  ...provenanceColumns(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Generic task tracker — mirrors workflow_states' subjectType/subjectId polymorphic
// pattern so a task can hang off any entity (a lead, a work order, an invoice, ...).
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    title: text("title").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    assigneeType: text("assignee_type", { enum: ["user", "technician"] }),
    assigneeId: uuid("assignee_id"),
    // Canonical PartyRef assignment supports a team without overloading the legacy
    // user/technician columns. Employee assignments mirror into both contracts.
    assignedPartyType: text("assigned_party_type", { enum: ["employee", "team"] }),
    assignedPartyId: uuid("assigned_party_id"),
    workId: uuid("work_id").references(() => works.id),
    sourceDomainActionId: uuid("source_domain_action_id").references(() => domainActions.id),
    status: text("status", { enum: ["open", "done", "cancelled"] }).notNull().default("open"),
    priority: text("priority", { enum: ["low", "normal", "high"] }).notNull().default("normal"),
    ...archivable(),
    ...provenanceColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("tasks_source_domain_action_unique").on(t.sourceDomainActionId),
    index("tasks_tenant_work_status_idx").on(t.tenantId, t.workId, t.status),
    index("tasks_tenant_assigned_party_idx").on(t.tenantId, t.assignedPartyType, t.assignedPartyId, t.status),
    foreignKey({
      columns: [t.tenantId, t.workId],
      foreignColumns: [works.tenantId, works.id],
      name: "tasks_work_tenant_fkey",
    }),
    foreignKey({
      columns: [t.tenantId, t.sourceDomainActionId],
      foreignColumns: [domainActions.tenantId, domainActions.id],
      name: "tasks_source_action_tenant_fkey",
    }),
  ],
);

// Also polymorphic subject (a lead's water-test hold, a work order's install slot, ...).
export const appointments = pgTable("appointments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  technicianId: uuid("technician_id").references(() => technicians.id),
  status: text("status", {
    enum: ["hold", "confirmed", "completed", "canceled", "no_show"],
  })
    .notNull()
    .default("hold"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  durationMinutes: integer("duration_minutes"),
  holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
  notes: text("notes"),
  ...archivable(),
  ...provenanceColumns(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const technicianCapacity = pgTable("technician_capacity", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  technicianId: uuid("technician_id").notNull().references(() => technicians.id),
  dayOfWeek: integer("day_of_week"), // 0=Sunday..6=Saturday, nullable = every day
  startTime: text("start_time"), // "HH:MM", 24h
  endTime: text("end_time"),
  maxConcurrentJobs: integer("max_concurrent_jobs").notNull().default(1),
  serviceRadiusMiles: integer("service_radius_miles"),
  ...archivable(),
});

// B3.T2: these are configured operating inputs, never inferred from free-form
// technician contact/availability JSON. Null means slot recommendations must surface
// an honest "profile incomplete" state instead of a made-up travel/SLA score.
export const technicianDispatchProfiles = pgTable("technician_dispatch_profiles", {
  technicianId: uuid("technician_id").primaryKey().references(() => technicians.id),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  baseAddress: text("base_address"),
  workdayStart: text("workday_start"),
  workdayEnd: text("workday_end"),
  defaultSlaMinutes: integer("default_sla_minutes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const priceBookItems = pgTable(
  "price_book_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    sku: text("sku").notNull(),
    label: text("label").notNull(),
    priceUsd: money("price_usd").notNull(),
    unitOfMeasure: text("unit_of_measure").notNull().default("each"),
    ...archivable(),
    ...provenanceColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("price_book_items_tenant_sku_idx").on(t.tenantId, t.sku)],
);

export const quotes = pgTable("quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  householdId: uuid("household_id").references(() => households.id),
  leadId: uuid("lead_id").references(() => leads.id),
  opportunityId: uuid("opportunity_id").references(() => opportunities.id),
  status: text("status", { enum: ["draft", "sent", "accepted", "declined", "expired"] })
    .notNull()
    .default("draft"),
  totalUsd: money("total_usd"),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  ...archivable(),
  ...provenanceColumns(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const quoteLineItems = pgTable("quote_line_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  quoteId: uuid("quote_id").notNull().references(() => quotes.id),
  sku: text("sku"), // nullable — a custom line item (e.g. labor) need not map to a SKU
  label: text("label").notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitPriceUsd: money("unit_price_usd").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// New, distinct from service_visits (which stays as-is for recurring service calls) —
// install/repair jobs need deposit + stock-reservation fields service_visits has no room for.
export const workOrders = pgTable("work_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  householdId: uuid("household_id").notNull().references(() => households.id),
  quoteId: uuid("quote_id").references(() => quotes.id),
  type: text("type", { enum: ["install", "repair", "warranty", "other"] }).notNull(),
  status: text("status", {
    enum: ["draft", "scheduled", "in_progress", "completed", "canceled"],
  })
    .notNull()
    .default("draft"),
  technicianId: uuid("technician_id").references(() => technicians.id),
  depositAmountUsd: money("deposit_amount_usd"),
  stockReservation: jsonb("stock_reservation").notNull().default({}),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...archivable(),
  ...provenanceColumns(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Distinct from invoices.status — a real record of each payment event/method.
export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  amountUsd: money("amount_usd").notNull(),
  method: text("method", { enum: ["card", "ach", "check", "cash", "other"] })
    .notNull()
    .default("other"),
  status: text("status", { enum: ["pending", "succeeded", "failed", "refunded"] })
    .notNull()
    .default("succeeded"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  ...provenanceColumns(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Generalizes inventory_items (single-location-per-tenant, unchanged, stays the default)
// for multi-location stock + reorder tracking. Consolidation is future work.
export const warehouses = pgTable("warehouses", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  address: text("address"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const warehouseStock = pgTable(
  "warehouse_stock",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    warehouseId: uuid("warehouse_id").notNull().references(() => warehouses.id),
    sku: text("sku").notNull(),
    quantity: integer("quantity").notNull().default(0),
    unitOfMeasure: text("unit_of_measure").notNull().default("each"),
    reorderThreshold: integer("reorder_threshold").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("warehouse_stock_warehouse_sku_idx").on(t.warehouseId, t.sku)],
);

export const procurementOrders = pgTable("procurement_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  warehouseId: uuid("warehouse_id").notNull().references(() => warehouses.id),
  sku: text("sku").notNull(),
  quantityOrdered: integer("quantity_ordered").notNull(),
  status: text("status", { enum: ["draft", "ordered", "received", "canceled"] })
    .notNull()
    .default("draft"),
  expectedAt: timestamp("expected_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  ...provenanceColumns(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Persists what communications_log/sandbox_outbox never captured: a queryable,
// permanent record of calls/messages, replacing the old "transcript embedded once in
// jobs.payload, then discarded" pattern in webhooks/vapi/route.ts.
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  householdId: uuid("household_id").references(() => households.id),
  contactId: uuid("contact_id").references(() => contacts.id),
  channel: text("channel", { enum: ["voice", "sms", "email", "webchat"] }).notNull(),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  ...provenanceColumns(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    conversationId: uuid("conversation_id").references(() => conversations.id),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    fromNumber: text("from_number"),
    toNumber: text("to_number"),
    transcript: text("transcript"),
    recordingUrl: text("recording_url"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    raw: jsonb("raw").notNull().default({}),
    ...provenanceColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("calls_tenant_source_external_idx").on(t.tenantId, t.sourceSystem, t.externalId)],
);

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  conversationId: uuid("conversation_id").references(() => conversations.id),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  channel: text("channel").notNull(),
  content: text("content").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  ...provenanceColumns(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Canonical document entity; embeddings.documentId (added above) can point here.
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  householdId: uuid("household_id").references(() => households.id),
  kind: text("kind").notNull(), // e.g. "proposal_pdf", "invoice_pdf", "compliance_report"
  title: text("title").notNull(),
  storageRef: text("storage_ref"), // URL or storage key; no ingestion pipeline this phase
  ...archivable(),
  ...provenanceColumns(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Phase 4 (§4.2): real PDF bytes, Postgres-backed — separate from documents' metadata
// row, same convention as decision_receipts living apart from workflow_steps.
export const documentContents = pgTable("document_contents", {
  documentId: uuid("document_id").primaryKey().references(() => documents.id),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  contentType: text("content_type").notNull().default("application/pdf"),
  bytes: bytea("bytes").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Phase 4 (§4.5): the single join between a Finnor-internal entity and a real
// provider's object, once bindings flip from emulator to real. No provider ids
// scattered across domain tables.
export const externalRefs = pgTable(
  "external_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    entity: text("entity").notNull(),
    internalId: uuid("internal_id"),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    integrationId: uuid("integration_id"),
    externalObjectType: text("external_object_type").notNull().default("record"),
    mappingStatus: text("mapping_status", { enum: ["mapped", "unresolved", "ambiguous", "tombstoned"] }).notNull().default("mapped"),
    identityKey: text("identity_key"),
    candidateCanonicalIds: uuid("candidate_canonical_ids").array().notNull().default([]),
    sourceVersion: text("source_version"),
    sourceSequence: bigint("source_sequence", { mode: "bigint" }),
    observedState: jsonb("observed_state").notNull().default({}),
    observedHash: text("observed_hash"),
    canonicalHash: text("canonical_hash"),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    freshnessState: text("freshness_state", { enum: ["unknown", "fresh", "stale", "expired"] }).notNull().default("unknown"),
    syncStatus: text("sync_status", { enum: ["acknowledged", "observed", "materialized", "reconciled", "conflict", "source_missing", "failed"] }).notNull().default("observed"),
    conflictState: text("conflict_state", { enum: ["none", "canonical_newer", "external_newer", "divergent", "ambiguous", "manual_resolution_required"] }).notNull().default("none"),
    ownershipPolicy: jsonb("ownership_policy").notNull().default({}),
    provenance: jsonb("provenance").notNull().default({}),
    providerDeleted: boolean("provider_deleted").notNull().default(false),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    lastEffectId: uuid("last_effect_id"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("external_refs_tenant_id_id_key").on(t.tenantId, t.id),
    index("external_refs_external_id_idx").on(t.tenantId, t.provider, t.externalId),
    index("external_refs_truth_status_idx").on(t.tenantId, t.integrationId, t.mappingStatus, t.freshnessState, t.conflictState, t.lastObservedAt),
  ],
);

// Real queryable cross-entity timeline — distinct from action_log (requires a non-null
// domain_action_id, so it structurally can't represent an imported row or a data-quality
// resolution) and scan_findings (a transient "digest once" staging queue, not history).
export const businessEvents = pgTable(
  "business_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source"), // which system/action produced this event
  },
  (t) => [
    index("business_events_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("business_events_type_time_idx").on(t.tenantId, t.eventType, t.occurredAt),
  ],
);

// Phase 2 Live Business World: one opaque cursor scope and monotonically
// increasing sequence per tenant. Operational deltas are invalidation evidence,
// not copied business rows; canonical data remains in the domain tables above.
export const tenantOperationalDeltaCursors = pgTable(
  "tenant_operational_delta_cursors",
  {
    tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
    scope: uuid("scope").notNull().defaultRandom().unique(),
    lastSeq: bigint("last_seq", { mode: "bigint" }).notNull().default(0n),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const operationalDeltas = pgTable(
  "operational_deltas",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    changeType: text("change_type").notNull(),
    priority: text("priority", { enum: ["low", "normal", "high"] }).notNull().default("normal"),
    entityRefs: jsonb("entity_refs").notNull().default([]),
    workId: uuid("work_id").references(() => works.id, { onDelete: "set null" }),
    projectionTags: text("projection_tags").array().notNull().default([]),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.seq] }),
    index("operational_deltas_tenant_time_idx").on(t.tenantId, t.occurredAt),
    index("operational_deltas_tenant_work_idx").on(t.tenantId, t.workId, t.seq).where(sql`${t.workId} IS NOT NULL`),
  ],
);

// Its own table, not a scan_findings reuse — scan_findings is a one-way "digest once"
// contract; data-quality findings need an open/resolved lifecycle and re-surfacing.
export const dataQualityFindings = pgTable(
  "data_quality_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    findingType: text("finding_type", {
      // Phase 5 (§5.4): "contradiction" added — one entity's own data disagreeing
      // with itself (conflicting phones, duplicate equipment, overlapping
      // appointments), distinct from duplicate_candidate (two different entities
      // that might be the same record). Migration 0029.
      enum: ["duplicate_candidate", "missing_critical_field", "stale_data", "ambiguous_match", "contradiction"],
    }).notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    relatedEntityId: uuid("related_entity_id"),
    details: jsonb("details").notNull().default({}),
    severity: text("severity", { enum: ["low", "medium", "high"] }).notNull().default("medium"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("data_quality_findings_unresolved_idx").on(t.tenantId, t.resolvedAt)],
);

// Phase 3 client imports. Business rows are still written exclusively through
// @finnor/data-platform; these tables retain the source-to-canonical identity,
// per-row outcome, quarantine reason, and run report needed for safe replay.
export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    definitionKey: text("definition_key").notNull(),
    definitionVersion: integer("definition_version").notNull(),
    sourceSystem: text("source_system").notNull(),
    sourceName: text("source_name").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    definitionSha256: text("definition_sha256").notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    status: text("status", { enum: ["running", "completed", "completed_with_errors", "failed"] }).notNull().default("running"),
    totalRows: integer("total_rows").notNull().default(0),
    createdRows: integer("created_rows").notNull().default(0),
    updatedRows: integer("updated_rows").notNull().default(0),
    skippedRows: integer("skipped_rows").notNull().default(0),
    quarantinedRows: integer("quarantined_rows").notNull().default(0),
    report: jsonb("report").notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("import_runs_tenant_started_idx").on(t.tenantId, t.startedAt)],
);

export const importRows = pgTable(
  "import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    runId: uuid("run_id").notNull().references(() => importRuns.id),
    rowNumber: integer("row_number").notNull(),
    sourceId: text("source_id"),
    identityKey: text("identity_key"),
    status: text("status", { enum: ["planned", "created", "updated", "skipped", "quarantined"] }).notNull(),
    canonicalEntityType: text("canonical_entity_type"),
    canonicalEntityId: uuid("canonical_entity_id"),
    reasons: jsonb("reasons").notNull().default([]),
    normalizedData: jsonb("normalized_data").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("import_rows_run_row_idx").on(t.runId, t.rowNumber),
    index("import_rows_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export const importEntityRefs = pgTable(
  "import_entity_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    sourceSystem: text("source_system").notNull(),
    entityType: text("entity_type").notNull(),
    sourceId: text("source_id").notNull(),
    canonicalEntityId: uuid("canonical_entity_id").notNull(),
    identityKey: text("identity_key"),
    firstRunId: uuid("first_run_id").notNull().references(() => importRuns.id),
    lastRunId: uuid("last_run_id").notNull().references(() => importRuns.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("import_entity_refs_source_idx").on(t.tenantId, t.sourceSystem, t.entityType, t.sourceId),
    index("import_entity_refs_identity_idx").on(t.tenantId, t.sourceSystem, t.entityType, t.identityKey),
  ],
);

// Phase 4 client factory. The existing Postgres jobs queue dispatches/resumes these
// runs; these tables only retain onboarding state and immutable attempt evidence.
// They are admin-only because a run begins before a tenant exists and can span the
// global client identity boundary.
export const clientFactoryRuns = pgTable(
  "client_factory_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientKey: text("client_key").notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    manifestVersion: integer("manifest_version").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    manifestSnapshot: jsonb("manifest_snapshot").notNull(),
    status: text("status", { enum: ["pending", "running", "passed", "failed", "blocked_config", "cancelled"] }).notNull().default("pending"),
    currentStage: text("current_stage"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    dispatchVersion: integer("dispatch_version").notNull().default(0),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("client_factory_runs_tenant_idx").on(t.tenantId, t.createdAt)],
);

export const clientFactoryStages = pgTable(
  "client_factory_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => clientFactoryRuns.id),
    stageKey: text("stage_key").notNull(),
    ordinal: integer("ordinal").notNull(),
    status: text("status", { enum: ["pending", "running", "passed", "failed", "blocked_config", "cancelled"] }).notNull().default("pending"),
    inputSha256: text("input_sha256"),
    attempts: integer("attempts").notNull().default(0),
    evidence: jsonb("evidence").notNull().default({}),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("client_factory_stages_run_key_idx").on(t.runId, t.stageKey),
    unique("client_factory_stages_run_ordinal_idx").on(t.runId, t.ordinal),
  ],
);

export const clientFactoryStageAttempts = pgTable(
  "client_factory_stage_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => clientFactoryRuns.id),
    stageId: uuid("stage_id").notNull().references(() => clientFactoryStages.id),
    stageKey: text("stage_key").notNull(),
    attempt: integer("attempt").notNull(),
    inputSha256: text("input_sha256").notNull(),
    status: text("status", { enum: ["running", "passed", "failed", "blocked_config", "cancelled"] }).notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [unique("client_factory_stage_attempt_number_idx").on(t.stageId, t.attempt)],
);

// Phase 5 governance ledger. The SQL migration adds database triggers that reject
// UPDATE/DELETE; these Drizzle declarations exist for typed inspection only. Writes
// go through release:certify's content-addressed, insert-only persistence boundary.
export const coreCertifications = pgTable(
  "core_certifications",
  {
    certificationId: text("certification_id").primaryKey(),
    canonicalCoreSha: text("canonical_core_sha").notNull(),
    coreSourceTreeHash: text("core_source_tree_hash").notNull(),
    suiteHash: text("suite_hash").notNull(),
    status: text("status", { enum: ["PASS", "FAIL", "BLOCKED_CONFIG"] }).notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    artifact: jsonb("artifact").notNull(),
    certifiedAt: timestamp("certified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("core_certifications_reuse_idx").on(t.canonicalCoreSha, t.coreSourceTreeHash, t.suiteHash)],
);

export const clientCertifications = pgTable(
  "client_certifications",
  {
    certificationId: text("certification_id").primaryKey(),
    clientKey: text("client_key").notNull(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    canonicalCoreSha: text("canonical_core_sha").notNull(),
    coreCertificationId: text("core_certification_id").notNull().references(() => coreCertifications.certificationId),
    configurationHash: text("configuration_hash").notNull(),
    deploymentEvidenceHash: text("deployment_evidence_hash").notNull(),
    migrationVersion: text("migration_version").notNull(),
    schemaHash: text("schema_hash").notNull(),
    suiteHash: text("suite_hash").notNull(),
    status: text("status", { enum: ["PASS", "FAIL", "BLOCKED_CONFIG"] }).notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    artifact: jsonb("artifact").notNull(),
    certifiedAt: timestamp("certified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("client_certifications_current_idx").on(t.clientKey, t.tenantId, t.canonicalCoreSha, t.configurationHash, t.createdAt)],
);

export const clientReleases = pgTable(
  "client_releases",
  {
    releaseId: text("release_id").primaryKey(),
    releaseVersion: text("release_version").notNull().unique(),
    clientKey: text("client_key").notNull(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    canonicalCoreSha: text("canonical_core_sha").notNull(),
    coreCertificationId: text("core_certification_id").notNull().references(() => coreCertifications.certificationId),
    clientCertificationId: text("client_certification_id").notNull().references(() => clientCertifications.certificationId),
    manifestHash: text("manifest_hash").notNull(),
    configurationHash: text("configuration_hash").notNull(),
    deploymentEvidenceHash: text("deployment_evidence_hash").notNull(),
    migrationVersion: text("migration_version").notNull(),
    schemaHash: text("schema_hash").notNull(),
    status: text("status", { enum: ["PASS", "FAIL", "BLOCKED_CONFIG"] }).notNull(),
    predecessorReleaseId: text("predecessor_release_id"),
    rollbackTargetReleaseId: text("rollback_target_release_id"),
    artifact: jsonb("artifact").notNull(),
    certifiedAt: timestamp("certified_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("client_releases_cert_deployment_idx").on(t.clientCertificationId, t.deploymentEvidenceHash),
    index("client_releases_client_history_idx").on(t.clientKey, t.tenantId, t.releasedAt),
  ],
);

// Phase 6 lifecycle control plane. Certified configuration and promotion rows are
// append-only; activeClientReleases is the intentionally small mutable pointer.
export const clientReleaseConfigurations = pgTable(
  "client_release_configurations",
  {
    releaseId: text("release_id").primaryKey().references(() => clientReleases.releaseId),
    clientKey: text("client_key").notNull(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    manifestHash: text("manifest_hash").notNull(),
    configurationHash: text("configuration_hash").notNull(),
    manifestSnapshot: jsonb("manifest_snapshot").notNull(),
    certifiedState: jsonb("certified_state").notNull(),
    certifiedStateHash: text("certified_state_hash").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("client_release_configurations_client_idx").on(t.clientKey, t.tenantId, t.createdAt)],
);

export const clientLifecycleOperations = pgTable(
  "client_lifecycle_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientKey: text("client_key").notNull(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    operationType: text("operation_type", { enum: ["status", "diff", "dry_run", "apply", "certify", "promote", "drift", "rollback"] }).notNull(),
    status: text("status", { enum: ["running", "PASS", "FAIL", "BLOCKED_CONFIG", "NOOP"] }).notNull().default("running"),
    planId: text("plan_id"),
    desiredManifestHash: text("desired_manifest_hash"),
    fromReleaseId: text("from_release_id").references(() => clientReleases.releaseId),
    toReleaseId: text("to_release_id").references(() => clientReleases.releaseId),
    plan: jsonb("plan").notNull().default({}),
    evidence: jsonb("evidence").notNull().default({}),
    evidenceHash: text("evidence_hash"),
    provenance: jsonb("provenance").notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("client_lifecycle_operations_history_idx").on(t.clientKey, t.startedAt)],
);

export const clientReleasePromotions = pgTable(
  "client_release_promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientKey: text("client_key").notNull(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    releaseId: text("release_id").notNull().references(() => clientReleases.releaseId),
    previousReleaseId: text("previous_release_id").references(() => clientReleases.releaseId),
    operationId: uuid("operation_id").notNull().unique().references(() => clientLifecycleOperations.id),
    kind: text("kind", { enum: ["promotion", "rollback"] }).notNull(),
    evidence: jsonb("evidence").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("client_release_promotions_history_idx").on(t.clientKey, t.tenantId, t.promotedAt),
    index("client_release_promotions_release_fk_idx").on(t.releaseId),
  ],
);

export const activeClientReleases = pgTable("active_client_releases", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
  clientKey: text("client_key").notNull().unique(),
  releaseId: text("release_id").notNull().references(() => clientReleases.releaseId),
  promotionId: uuid("promotion_id").notNull().references(() => clientReleasePromotions.id),
  revision: integer("revision").notNull().default(1),
  promotedAt: timestamp("promoted_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Durable execution runtime (Phase 2, docs/jarvis-90-execution-blueprint.md §3).
// Command/step lifecycle mirrors domainActions' proven atomic
// UPDATE...WHERE status=<expected> concurrency boundary (see runAction()/decide() in
// packages/orchestration/src/index.ts). Step execution is driven through the existing
// Postgres job queue (apps/worker/src/queue.ts) — workflow_steps' own lease_expires_at
// is an additional, finer-grained atomic claim on top of the job-level lease, not a
// second queue system. workflowStates (the existing 2-workflow business-state tracker)
// is untouched — it answers "what business stage is this," while workflow_runs/
// workflow_steps is durable execution scaffolding (leases, attempts, evidence).
// ---------------------------------------------------------------------------

export const commands = pgTable(
  "commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    commandType: text("command_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    requestedBy: text("requested_by"),
    businessEffectId: uuid("business_effect_id"),
    /** Frozen authorization episode for the command. These are references and
     * hashes only; credentials/provider secrets never enter the durable intent. */
    authorizedEffectHash: text("authorized_effect_hash"),
    authorityDecisionId: uuid("authority_decision_id").references(() => authorityDecisions.id),
    authorityRevision: integer("authority_revision"),
    policyId: uuid("policy_id").references(() => domainPolicies.id),
    policyVersion: integer("policy_version"),
    executionClass: text("execution_class"),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
    // Created already-approved — approval happens upstream of this runtime.
    status: text("status", { enum: ["approved", "running", "completed", "failed", "cancelled"] })
      .notNull()
      .default("approved"),
    // §2.4: finishes the Phase-16(e) correlationId thread into the durable runtime —
    // forwarded from the originating DomainAction/TenantContext, so every receipt this
    // command's steps produce is greppable back to the request that caused it.
    correlationId: text("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("commands_tenant_idempotency_idx").on(t.tenantId, t.idempotencyKey)],
);

export const workflowRuns = pgTable("workflow_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  commandId: uuid("command_id").notNull().references(() => commands.id),
  workId: uuid("work_id").references(() => works.id),
  workflowType: text("workflow_type").notNull(),
  status: text("status", {
    enum: ["running", "completed", "failed", "compensating", "compensated", "paused", "cancelled", "escalated"],
  })
    .notNull()
    .default("running"),
  // §2.7: optimistic concurrency for run controls (pause/resume/cancel/retry/escalate)
  // — every status-changing UPDATE (here and in advanceWorkflow) increments this, and
  // callers condition their UPDATE on the version they last read so two concurrent
  // control calls can't both believe they made the transition.
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workflowRunId: uuid("workflow_run_id").notNull().references(() => workflowRuns.id),
    stepType: text("step_type").notNull(),
    sequence: integer("sequence").notNull(),
    status: text("status", {
      enum: ["pending", "leased", "waiting_observation", "completed", "failed", "compensating", "compensated"],
    })
      .notNull()
      .default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    // A terminal queue row consumes its immutable idempotency key. Explicit recovery
    // advances this value so the replacement delivery has a fresh key, while workers
    // reject late deliveries from older generations.
    dispatchGeneration: integer("dispatch_generation").notNull().default(0),
    evidence: jsonb("evidence").notNull().default({}),
    terminalReason: text("terminal_reason"),
    payload: jsonb("payload").notNull().default({}),
    // §2.4: denormalized copy of the parent command's correlationId — lets receipts.ts
    // read it straight off the step row with no join, same convention as tenantId.
    correlationId: text("correlation_id"),
    // §2.8 finding: the §2.5 runtime bridge's single-action steps originate from a
    // gated domain_action but had no way to link a receipt back to it — this is that
    // link, set only for steps the runtime bridge creates (workflow-kind commands
    // have no single originating domain_action, so it stays null for those).
    domainActionId: uuid("domain_action_id").references(() => domainActions.id),
    businessEffectId: uuid("business_effect_id"),
    /** Local delivery state is deliberately separate from the remote/business
     * effect state. `commit_started` is the point after which cancellation cannot
     * honestly claim that nothing happened. */
    executionState: text("execution_state", {
      enum: [
        "authorized",
        "claimed",
        "commit_started",
        "awaiting_observation",
        "reconciling",
        "verified",
        "failed_before_effect",
        "failed_after_possible_effect",
        "cancelled_before_effect",
        "cancellation_requested",
        "blocked",
      ],
    }).notNull().default("authorized"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    effectCommitAt: timestamp("effect_commit_at", { withTimezone: true }),
    cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("workflow_steps_run_sequence_idx").on(t.workflowRunId, t.sequence),
    check("workflow_steps_dispatch_generation_check", sql`${t.dispatchGeneration} >= 0`),
  ],
);

// Generalizes external_operations (packages/tools/src/idempotent-call.ts) from being
// keyed by domain_action_id to being keyed by workflow_step_id — same claim/reclaim
// logic, one level up in the new runtime.
export const integrationOperations = pgTable(
  "integration_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workflowStepId: uuid("workflow_step_id").notNull().references(() => workflowSteps.id),
    operationKey: text("operation_key").notNull(),
    capability: text("capability").notNull(),
    // Binding.name at the actual execution boundary (native/emulator/vendor).
    // This is presentation-safe provenance, never provider response material.
    provider: text("provider"),
    integrationId: uuid("integration_id"),
    businessEffectId: uuid("business_effect_id"),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: ["running", "succeeded", "failed", "unknown"] }).notNull(),
    response: jsonb("response"),
    providerAcknowledgedAt: timestamp("provider_acknowledged_at", { withTimezone: true }),
    externalObservedAt: timestamp("external_observed_at", { withTimezone: true }),
    verificationStatus: text("verification_status", { enum: ["not_required", "awaiting_observation", "verified", "divergent", "unknown"] }).notNull().default("not_required"),
    observation: jsonb("observation"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("integration_operations_step_key_idx").on(t.workflowStepId, t.operationKey)],
);

// Side effects queued in the same transaction as the state change that produced them.
export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  workflowStepId: uuid("workflow_step_id").references(() => workflowSteps.id),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status", { enum: ["pending", "delivering", "delivered", "unknown", "failed"] })
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  // Envelope major version (§2.2b) — a relayer that doesn't recognize the version
  // rejects the event into dead_letters rather than guessing at an unknown payload shape.
  envelopeVersion: integer("envelope_version").notNull().default(1),
  // §2.3: jittered backoff delay + last classified failure kind. next_attempt_at is
  // NULL for a never-yet-attempted row (immediately claimable).
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastErrorKind: text("last_error_kind"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});

// Inbound provider events, deduplicated by (provider, event_id) — unlike
// webhookReceipts (transport-level dedup only, insert-once, no status column), this
// additionally tracks whether the event was matched and applied to an open
// workflow_step, or needs a reconciliation_case.
export const inboxEvents = pgTable(
  "inbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    matchedStepId: uuid("matched_step_id").references(() => workflowSteps.id),
    status: text("status", { enum: ["received", "matched", "unmatched", "duplicate"] })
      .notNull()
      .default("received"),
    envelopeVersion: integer("envelope_version").notNull().default(1),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("inbox_events_provider_event_idx").on(t.tenantId, t.provider, t.eventId)],
);

// Opened automatically when an outbox event's delivery is unknown after retries
// exhaust, or an inbox event can't be matched to an open step.
export const reconciliationCases = pgTable("reconciliation_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  caseType: text("case_type", { enum: ["unknown_delivery", "unmatched_inbox_event", "external_drift", "mapping_ambiguous", "stale_source", "auth_failure", "unresolved_world_root", "coverage_gap", "provider_permission_drift", "delete_unverified"] }).notNull(),
  relatedOutboxEventId: uuid("related_outbox_event_id").references(() => outboxEvents.id),
  relatedInboxEventId: uuid("related_inbox_event_id").references(() => inboxEvents.id),
  relatedStepId: uuid("related_step_id").references(() => workflowSteps.id),
  businessEffectId: uuid("business_effect_id"),
  integrationId: uuid("integration_id"),
  sourceLinkId: uuid("source_link_id"),
  classification: text("classification"),
  authoritativeSide: text("authoritative_side", { enum: ["finnor", "external", "manual"] }),
  details: jsonb("details").notNull().default({}),
  resolution: jsonb("resolution"),
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// Opened when a step must be undone; records whether the compensation succeeded.
export const compensationCases = pgTable("compensation_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  workflowStepId: uuid("workflow_step_id").notNull().references(() => workflowSteps.id),
  businessEffectId: uuid("business_effect_id"),
  compensationEffectId: uuid("compensation_effect_id"),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["pending", "succeeded", "failed"] }).notNull().default("pending"),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// Phase 2 (JARVIS 95% MAESTRO PACK §2.2): one receipt per executed action — created at
// proposal time (before the step's external effect runs), finalized with
// actualResult/failure at completion. Answers "what did I intend, what evidence did I
// use, what policy allowed it, who approved it, what actually happened, how do we
// recover" in one row. `workflowStepId` is unique — a step has exactly one receipt,
// finalized in place, never a second row per retry (attempts already live on the step).
export const decisionReceipts = pgTable(
  "decision_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id),
    workflowStepId: uuid("workflow_step_id").references(() => workflowSteps.id),
    domainActionId: uuid("domain_action_id").references(() => domainActions.id),
    operationId: uuid("operation_id").references(() => businessOperations.id),
    workId: uuid("work_id").references(() => works.id),
    objective: text("objective").notNull(),
    evidence: jsonb("evidence").notNull().default([]),
    policyApplied: jsonb("policy_applied"),
    riskTier: text("risk_tier", { enum: ["low", "medium", "high"] }).notNull().default("medium"),
    proposedAction: jsonb("proposed_action").notNull().default({}),
    approval: jsonb("approval").notNull().default({ required: false }),
    expectedResult: jsonb("expected_result"),
    actualResult: jsonb("actual_result"),
    failure: jsonb("failure"),
    correlationId: text("correlation_id"),
    llmCostUsd: real("llm_cost_usd"),
    businessEffectId: uuid("business_effect_id"),
    intendedEffectHash: text("intended_effect_hash"),
    authorizedEffectHash: text("authorized_effect_hash"),
    executedEffectHash: text("executed_effect_hash"),
    verification: jsonb("verification"),
    recoveryEffectId: uuid("recovery_effect_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (t) => [
    unique("decision_receipts_step_idx").on(t.workflowStepId),
    index("decision_receipts_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("decision_receipts_domain_action_idx").on(t.domainActionId),
    unique("decision_receipts_operation_idx").on(t.operationId),
  ],
);

// B5: every model invocation is an auditable cost event. Token counts and cost are
// nullable because providers that do not return usage must never be represented as 0.
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    domainActionId: uuid("domain_action_id").references(() => domainActions.id),
    traceId: text("trace_id"),
    purpose: text("purpose").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: real("cost_usd"),
    status: text("status", { enum: ["completed", "deferred", "failed"] }).notNull(),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("llm_calls_tenant_created_idx").on(t.tenantId, t.createdAt), index("llm_calls_action_idx").on(t.domainActionId)],
);

// A missing row means no configured cap; that is distinct from a zero hard cap.
export const tenantLlmBudgets = pgTable(
  "tenant_llm_budgets",
  {
    tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id),
    dailyTokenBudget: integer("daily_token_budget").notNull(),
    softLimitPercent: integer("soft_limit_percent").notNull().default(80),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

// B4.T3: immutable-ish synthetic day captures plus candidate receipt comparisons.
// Tenant-scoped despite Dealer Zero currently being the only writer: a future training
// sandbox must never be able to read its source tenant's replay history.
export const dealerZeroReplayRecordings = pgTable(
  "dealer_zero_replay_recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    dateSeed: date("date_seed").notNull(),
    scenario: text("scenario").notNull(),
    eventStream: jsonb("event_stream").notNull(),
    receiptSnapshot: jsonb("receipt_snapshot").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("dealer_zero_replay_recordings_tenant_date_scenario_idx").on(t.tenantId, t.dateSeed, t.scenario)],
);
export const dealerZeroReplayReports = pgTable("dealer_zero_replay_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  recordingId: uuid("recording_id").notNull().references(() => dealerZeroReplayRecordings.id),
  candidateLabel: text("candidate_label").notNull(),
  candidateSnapshot: jsonb("candidate_snapshot").notNull(),
  diff: jsonb("diff").notNull(),
  passed: boolean("passed").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const dealerZeroShadowReports = pgTable("dealer_zero_shadow_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  observationStartedAt: timestamp("observation_started_at", { withTimezone: true }).notNull(),
  observationEndedAt: timestamp("observation_ended_at", { withTimezone: true }).notNull(),
  sourceLabel: text("source_label").notNull(),
  candidateLabel: text("candidate_label").notNull(),
  sourceSnapshot: jsonb("source_snapshot").notNull(),
  candidateSnapshot: jsonb("candidate_snapshot").notNull(),
  diff: jsonb("diff").notNull(),
  passed: boolean("passed").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Phase 2 (§2.3): terminal outbox/step failures land here instead of silently vanishing
// into a generic reconciliation_case — a queryable, replayable row an owner can act on.
// Distinct from jobs.status='dead_letter' (apps/worker/src/queue.ts), which is the
// generic job-queue's own retry-exhaustion marker for ANY job type; this table is
// specifically the durable-runtime's external-effect DLQ (outbox dispatch + workflow
// steps), matching the pack's §2.3 shape exactly so replay can reuse the idempotency key.
export const deadLetters = pgTable(
  "dead_letters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    relatedOutboxEventId: uuid("related_outbox_event_id").references(() => outboxEvents.id),
    relatedWorkflowStepId: uuid("related_workflow_step_id").references(() => workflowSteps.id),
    envelope: jsonb("envelope").notNull(),
    // A4.T1 (migration 0040): added needs_human/config to match shared-types' ErrorKind.
    errorKind: text("error_kind", {
      enum: ["retryable", "terminal", "conflict", "auth", "validation", "provider_down", "needs_human", "config", "unknown_outcome"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error").notNull(),
    replayable: boolean("replayable").notNull().default(true),
    status: text("status", { enum: ["open", "replayed", "discarded"] }).notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // A4.T3 (migration 0041): advisory only — never gates the owner-only replay/discard
    // routes in dlq.ts, just pre-computes a recommendation so an owner isn't reviewing a
    // DLQ row cold. Recomputed on every triage tick, so no history is lost by overwriting.
    suggestedDisposition: text("suggested_disposition", { enum: ["replay", "discard", "escalate"] }),
    suggestionReason: text("suggestion_reason"),
  },
  (t) => [index("dead_letters_tenant_status_idx").on(t.tenantId, t.status)],
);

// ---------------------------------------------------------------------------
// Voice OS (Phase 5, docs/jarvis-90-execution-blueprint.md §5). Replaces
// webhooks/vapi/route.ts's hardcoded owner identity and its "confirm the newest
// pending domain_actions tenant-wide" heuristic with real caller resolution and a
// confirmation bound to the specific action a session's own instruction drafted.
// ---------------------------------------------------------------------------

export const voiceIdentities = pgTable(
  "voice_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    phoneNumber: text("phone_number").notNull(),
    matchedHouseholdId: uuid("matched_household_id").references(() => households.id),
    matchedUserId: uuid("matched_user_id").references(() => users.id),
    role: text("role", { enum: ["owner", "dispatcher", "technician", "customer", "unknown"] })
      .notNull()
      .default("unknown"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("voice_identities_tenant_phone_idx").on(t.tenantId, t.phoneNumber)],
);

export const voiceSessions = pgTable("voice_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  callExternalId: text("call_external_id").notNull().unique(),
  voiceIdentityId: uuid("voice_identity_id").references(() => voiceIdentities.id),
  employeeId: uuid("employee_id").references(() => users.id),
  authorityContext: jsonb("authority_context").notNull().default({}),
  channel: text("channel").notNull().default("vapi"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  status: text("status", { enum: ["active", "ended"] }).notNull().default("active"),
});

export const voiceTurns = pgTable(
  "voice_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    voiceSessionId: uuid("voice_session_id").notNull().references(() => voiceSessions.id),
    sequence: integer("sequence").notNull(),
    role: text("role", { enum: ["caller", "assistant"] }).notNull(),
    transcriptText: text("transcript_text").notNull(),
    resolvedActionIds: jsonb("resolved_action_ids").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("voice_turns_session_sequence_idx").on(t.voiceSessionId, t.sequence)],
);

// The row finnor_confirm resolves against — binds a spoken yes/no to the exact
// domain_action this session's own finnor_instruct drafted, not "whatever is newest."
export const pendingConfirmations = pgTable("pending_confirmations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  voiceSessionId: uuid("voice_session_id").notNull().references(() => voiceSessions.id),
  domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
  promptText: text("prompt_text").notNull(),
  status: text("status", { enum: ["awaiting", "confirmed", "rejected", "expired"] })
    .notNull()
    .default("awaiting"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const handoffs = pgTable("handoffs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  voiceSessionId: uuid("voice_session_id").notNull().references(() => voiceSessions.id),
  reason: text("reason").notNull(),
  toRole: text("to_role"),
  toUserId: uuid("to_user_id").references(() => users.id),
  status: text("status", { enum: ["open", "acknowledged", "resolved"] }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// Resolves which tenant a Vapi call belongs to from the DIALED number. Not
// tenant-scoped, no RLS (same convention as `jobs`) — looked up during tenant
// *resolution*, before tenant_id is known. Uniques are GLOBAL: one dialed number
// resolves to exactly one tenant.
export const tenantPhoneNumbers = pgTable("tenant_phone_numbers", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  phoneNumber: text("phone_number").notNull().unique(),
  vapiPhoneNumberId: text("vapi_phone_number_id").unique(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Phase 8 (§8.3): the daily scorecard. One row per tenant per calendar day, computed
// from the same reliability() read-model every hourly alert scan already uses — never
// a second, divergent computation. Rates are nullable (never a fabricated 0 for an
// empty denominator, matching reliability()'s own convention); the two backlog gauges
// are NOT nullable since they're always a real count, even when 0.
export const readinessLog = pgTable(
  "readiness_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    logDate: date("log_date").notNull(),
    workflowSuccessRate: real("workflow_success_rate"),
    stepLatencyP95Ms: integer("step_latency_p95_ms"),
    retryRate: real("retry_rate"),
    humanInterventionRate: real("human_intervention_rate"),
    reconciliationBacklog: integer("reconciliation_backlog").notNull(),
    dlqDepth: integer("dlq_depth").notNull(),
    receiptCompleteness: real("receipt_completeness"),
    llmSpendUsd: real("llm_spend_usd"),
    llmCalls: integer("llm_calls"),
    incidentNotes: text("incident_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("readiness_log_tenant_date_idx").on(t.tenantId, t.logDate)],
);

// Phase 8 (§8.2): the failure-injection calendar's real log — every deliberate chaos
// injection run against production/Dealer Zero, with its own detection/recovery
// timestamps and receipt trail, not just a line in a doc.
export const failureInjections = pgTable(
  "failure_injections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    kind: text("kind", {
      enum: ["worker_kill", "webhook_replay", "provider_egress_block", "approval_expiry_pileup", "secrets_store_hiccup", "deploy_mid_workflow", "restore_drill", "secrets_boot", "pooling_load"],
    }).notNull(),
    injectedAt: timestamp("injected_at", { withTimezone: true }).notNull().defaultNow(),
    detectedAt: timestamp("detected_at", { withTimezone: true }),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),
    outcome: text("outcome", { enum: ["pass", "fail", "inconclusive"] }),
    detail: jsonb("detail").notNull().default({}),
    receiptIds: jsonb("receipt_ids").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("failure_injections_tenant_injected_idx").on(t.tenantId, t.injectedAt)],
);

// B1.T3: CQRS materialized cache for the 3 hottest read-models. See migration 0038's
// own comment for why only these 3 (of 12 total) get a cache row.
export const readModelProjections = pgTable(
  "read_model_projections",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    view: text("view", { enum: ["pipeline-health", "reliability", "activity-snapshot"] }).notNull(),
    data: jsonb("data").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.view] })],
);

// A3.T1: per-tenant override for which binding/mode serves each capability, on top of
// A1.T3's env-only resolveCapabilityBindings(). See migration 0039's own header for the
// binding-vs-mode distinction and the tenant-row -> env -> default resolution order.
export const tenantIntegrations = pgTable(
  "tenant_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    capability: text("capability", {
      enum: ["scheduling", "documents", "inventory", "crm", "communications", "esign", "accounting", "payments", "marketing", "private_equity_source"],
    }).notNull(),
    binding: text("binding").notNull(),
    mode: text("mode", { enum: ["real", "sandbox", "emulator"] }).notNull().default("emulator"),
    config: jsonb("config").notNull().default({}),
    // Phase 2 tenant credential isolation: these columns are references and
    // non-secret metadata only. Provider secret material is resolved at call time
    // by @finnor/security and never enters a normal application table.
    credentialProvider: text("credential_provider", { enum: ["aws-secrets-manager", "legacy-env"] }),
    credentialRef: text("credential_ref"),
    credentialVersion: text("credential_version"),
    credentialMetadata: jsonb("credential_metadata").notNull().default({}),
    applicationAccountId: uuid("application_account_id"),
    authProfileId: uuid("auth_profile_id"),
    sourcePolicy: jsonb("source_policy").notNull().default({}),
    freshnessPolicy: jsonb("freshness_policy").notNull().default({}),
    syncScopes: text("sync_scopes").array().notNull().default([]),
    outcomePacks: text("outcome_packs").array().notNull().default([]),
    health: text("health", { enum: ["ok", "degraded", "down", "unknown"] }).notNull().default("unknown"),
    syncStatus: text("sync_status", { enum: ["uninitialized", "initializing", "syncing", "synced", "degraded", "blocked"] }).notNull().default("uninitialized"),
    freshnessState: text("freshness_state", { enum: ["unknown", "fresh", "stale", "expired"] }).notNull().default("unknown"),
    webhookStatus: text("webhook_status", { enum: ["unknown", "healthy", "degraded", "disabled"] }).notNull().default("unknown"),
    reconciliationStatus: text("reconciliation_status", { enum: ["unknown", "healthy", "degraded", "blocked"] }).notNull().default("unknown"),
    syncInitializedAt: timestamp("sync_initialized_at", { withTimezone: true }),
    lastSyncStartedAt: timestamp("last_sync_started_at", { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    sourceLagMs: bigint("source_lag_ms", { mode: "number" }),
    unresolvedConflicts: integer("unresolved_conflicts").notNull().default(0),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("tenant_integrations_tenant_capability_idx").on(t.tenantId, t.capability),
    unique("tenant_integrations_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId, t.applicationAccountId], foreignColumns: [applicationAccounts.tenantId, applicationAccounts.id], name: "tenant_integrations_application_account_tenant_fkey" }),
    foreignKey({ columns: [t.tenantId, t.authProfileId], foreignColumns: [authProfiles.tenantId, authProfiles.id], name: "tenant_integrations_auth_profile_tenant_fkey" }),
  ],
);

export const integrationSyncCheckpoints = pgTable(
  "integration_sync_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    integrationId: uuid("integration_id").notNull(),
    sourceScopeId: uuid("source_scope_id"),
    sourceScope: text("source_scope").notNull(),
    cursor: jsonb("cursor").notNull().default({}),
    cursorVersion: integer("cursor_version").notNull().default(1),
    highWatermark: timestamp("high_watermark", { withTimezone: true }),
    status: text("status", { enum: ["idle", "running", "degraded", "blocked"] }).notNull().default("idle"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastPageAt: timestamp("last_page_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    errorCode: text("error_code"),
    recovery: jsonb("recovery").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("integration_sync_checkpoints_identity_unique").on(t.tenantId, t.integrationId, t.sourceScope),
    unique("integration_sync_checkpoints_tenant_id_id_key").on(t.tenantId, t.id),
    index("integration_sync_checkpoints_due_idx").on(t.tenantId, t.status, t.leaseExpiresAt, t.updatedAt),
    foreignKey({ columns: [t.tenantId, t.integrationId], foreignColumns: [tenantIntegrations.tenantId, tenantIntegrations.id], name: "integration_sync_checkpoints_integration_tenant_fkey" }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.integrationId, t.sourceScopeId],
      foreignColumns: [integrationSourceScopes.tenantId, integrationSourceScopes.integrationId, integrationSourceScopes.id],
      name: "integration_sync_checkpoints_scope_identity_fkey",
    }),
  ],
);

/** Exact provider information-space boundary. Freshness is current telemetry on
 * this row; historical completeness is owned by integrationSourceCoverageHistory. */
export const integrationSourceScopes = pgTable(
  "integration_source_scopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    integrationId: uuid("integration_id").notNull(),
    provider: text("provider").notNull(),
    sourceKind: text("source_kind", {
      enum: [
        "outlook_mail_folder",
        "outlook_calendar_view",
        "teams_channel",
        "teams_chat",
        "teams_user_chat_feed",
        "teams_transcript_organizer",
        "sharepoint_drive",
        "sharepoint_list",
      ],
    }).notNull(),
    providerScopeType: text("provider_scope_type").notNull(),
    providerResourceId: text("provider_resource_id").notNull(),
    providerParentId: text("provider_parent_id"),
    scopeKey: text("scope_key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    rootBindingType: text("root_binding_type", { enum: ["pe_strategy", "pe_opportunity", "pe_deal"] }),
    rootBindingId: uuid("root_binding_id"),
    syncStrategy: text("sync_strategy", { enum: ["delta", "bounded_enumeration", "exact_read"] }).notNull(),
    recoveryStrategy: text("recovery_strategy", {
      enum: ["EXACT_DELTA", "BOUNDED_RECONCILIATION", "BEST_EFFORT_NOTIFICATION_RECOVERY"],
    }).notNull(),
    permissionMode: text("permission_mode", { enum: ["SCOPED", "BROAD"] }).notNull().default("SCOPED"),
    requiredPermissions: text("required_permissions").array().notNull().default([]),
    effectivePermissions: text("effective_permissions").array().notNull().default([]),
    providerRestrictionMethod: text("provider_restriction_method"),
    permissionVerifiedAt: timestamp("permission_verified_at", { withTimezone: true }),
    coveragePolicy: jsonb("coverage_policy").notNull().default({}),
    freshnessPolicy: jsonb("freshness_policy").notNull().default({}),
    configuration: jsonb("configuration").notNull().default({}),
    freshnessState: text("freshness_state", { enum: ["unknown", "fresh", "stale", "expired"] }).notNull().default("unknown"),
    lastSyncStartedAt: timestamp("last_sync_started_at", { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    configuredBy: text("configured_by").notNull(),
    configuredAt: timestamp("configured_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("integration_source_scopes_tenant_id_id_key").on(t.tenantId, t.id),
    unique("integration_source_scopes_tenant_integration_id_key").on(t.tenantId, t.integrationId, t.id),
    unique("integration_source_scopes_identity_key").on(t.tenantId, t.integrationId, t.scopeKey),
    index("integration_source_scopes_integration_kind_idx").on(t.tenantId, t.integrationId, t.sourceKind, t.enabled),
    index("integration_source_scopes_root_idx").on(t.tenantId, t.rootBindingType, t.rootBindingId, t.enabled),
    foreignKey({
      columns: [t.tenantId, t.integrationId],
      foreignColumns: [tenantIntegrations.tenantId, tenantIntegrations.id],
      name: "integration_source_scopes_integration_tenant_fkey",
    }).onDelete("cascade"),
  ],
);

/** Append-only coverage facts. Query code derives an epoch's implicit end from the
 * next revision unless an exact bounded effectiveTo was known when it was recorded. */
export const integrationSourceCoverageHistory = pgTable(
  "integration_source_coverage_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    sourceScopeId: uuid("source_scope_id").notNull(),
    coverageRevision: integer("coverage_revision").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    coverageRegion: jsonb("coverage_region").notNull().default({}),
    state: text("state", {
      enum: ["INITIALIZING", "COMPLETE", "PARTIAL", "RECOVERING", "BLOCKED_AUTH", "BLOCKED_PERMISSION", "HISTORY_LIMITED", "NOT_CONFIGURED", "DISABLED"],
    }).notNull(),
    reason: text("reason"),
    checkpointId: uuid("checkpoint_id"),
    baselineStartedAt: timestamp("baseline_started_at", { withTimezone: true }),
    baselineCompletedAt: timestamp("baseline_completed_at", { withTimezone: true }),
    earliestProviderAt: timestamp("earliest_provider_at", { withTimezone: true }),
    latestProviderAt: timestamp("latest_provider_at", { withTimezone: true }),
    unresolvedObservations: integer("unresolved_observations").notNull().default(0),
    ambiguousObservations: integer("ambiguous_observations").notNull().default(0),
    sourceDescriptor: jsonb("source_descriptor").notNull().default({}),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    unique("integration_source_coverage_history_scope_revision_key").on(t.sourceScopeId, t.coverageRevision),
    index("integration_source_coverage_history_asof_idx").on(t.tenantId, t.sourceScopeId, t.effectiveFrom, t.recordedAt),
    foreignKey({
      columns: [t.tenantId, t.sourceScopeId],
      foreignColumns: [integrationSourceScopes.tenantId, integrationSourceScopes.id],
      name: "integration_source_coverage_history_scope_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.checkpointId],
      foreignColumns: [integrationSyncCheckpoints.tenantId, integrationSyncCheckpoints.id],
      name: "integration_source_coverage_history_checkpoint_tenant_fkey",
    }),
  ],
);

/** Mutable Graph control-plane state. Business/evidence truth never lives here. */
export const integrationSubscriptions = pgTable(
  "integration_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    integrationId: uuid("integration_id").notNull(),
    sourceScopeId: uuid("source_scope_id").notNull(),
    provider: text("provider").notNull(),
    providerSubscriptionId: text("provider_subscription_id"),
    resource: text("resource").notNull(),
    changeTypes: text("change_types").array().notNull().default([]),
    status: text("status", {
      enum: ["provisioning", "active", "renewing", "degraded", "reauthorization_required", "removed", "expired", "deleting", "disabled"],
    }).notNull().default("provisioning"),
    expirationAt: timestamp("expiration_at", { withTimezone: true }),
    renewAt: timestamp("renew_at", { withTimezone: true }),
    createdAtProvider: timestamp("created_at_provider", { withTimezone: true }),
    lastRenewedAt: timestamp("last_renewed_at", { withTimezone: true }),
    lastNotificationAt: timestamp("last_notification_at", { withTimezone: true }),
    lastLifecycleEventAt: timestamp("last_lifecycle_event_at", { withTimezone: true }),
    clientStateHash: text("client_state_hash").notNull(),
    failureCode: text("failure_code"),
    recoveryState: text("recovery_state").notNull().default("none"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("integration_subscriptions_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("integration_subscriptions_provider_id_key").on(t.provider, t.providerSubscriptionId).where(sql`${t.providerSubscriptionId} IS NOT NULL`),
    uniqueIndex("integration_subscriptions_current_scope_key").on(t.tenantId, t.sourceScopeId).where(sql`${t.status} IN ('provisioning','active','renewing','degraded','reauthorization_required','deleting')`),
    index("integration_subscriptions_due_idx").on(t.provider, t.status, t.renewAt, t.leaseExpiresAt),
    index("integration_subscriptions_scope_idx").on(t.tenantId, t.sourceScopeId, t.status),
    foreignKey({
      columns: [t.tenantId, t.integrationId],
      foreignColumns: [tenantIntegrations.tenantId, tenantIntegrations.id],
      name: "integration_subscriptions_integration_tenant_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.integrationId, t.sourceScopeId],
      foreignColumns: [integrationSourceScopes.tenantId, integrationSourceScopes.integrationId, integrationSourceScopes.id],
      name: "integration_subscriptions_scope_identity_fkey",
    }).onDelete("cascade"),
  ],
);

/** Durable, deterministic object/thread/root proof. Conflicts remain separate active
 * candidates only when they refer to different binding levels and are reconciled. */
export const providerObjectRootBindings = pgTable(
  "provider_object_root_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    integrationId: uuid("integration_id").notNull(),
    sourceScopeId: uuid("source_scope_id"),
    provider: text("provider").notNull(),
    resourceKind: text("resource_kind").notNull(),
    externalObjectType: text("external_object_type").notNull(),
    externalObjectId: text("external_object_id").notNull(),
    bindingLevel: text("binding_level", { enum: ["object", "document", "parent", "thread", "series", "meeting"] }).notNull(),
    worldRootType: text("world_root_type", { enum: ["pe_strategy", "pe_opportunity", "pe_deal"] }).notNull(),
    worldRootId: uuid("world_root_id").notNull(),
    bindingSource: text("binding_source", { enum: ["explicit", "source_scope", "core_document", "external_ref", "parent_inheritance", "conversation_inheritance", "meeting_inheritance"] }).notNull(),
    createdBy: text("created_by").notNull(),
    supersedesBindingId: uuid("supersedes_binding_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("provider_object_root_bindings_tenant_id_id_key").on(t.tenantId, t.id),
    unique("provider_object_root_bindings_supersedes_key").on(t.supersedesBindingId),
    uniqueIndex("provider_object_root_bindings_active_identity_key")
      .on(t.tenantId, t.integrationId, t.resourceKind, t.externalObjectType, t.externalObjectId, t.bindingLevel)
      .where(sql`${t.supersededAt} IS NULL`),
    index("provider_object_root_bindings_root_idx").on(t.tenantId, t.worldRootType, t.worldRootId, t.supersededAt),
    foreignKey({
      columns: [t.tenantId, t.integrationId],
      foreignColumns: [tenantIntegrations.tenantId, tenantIntegrations.id],
      name: "provider_object_root_bindings_integration_tenant_fkey",
    }),
    foreignKey({
      columns: [t.tenantId, t.integrationId, t.sourceScopeId],
      foreignColumns: [integrationSourceScopes.tenantId, integrationSourceScopes.integrationId, integrationSourceScopes.id],
      name: "provider_object_root_bindings_scope_identity_fkey",
    }),
  ],
);

// D6.T1: an authenticated person's cockpit preferences. This is intentionally a
// separate user-scoped row rather than tenant_settings: a dispatcher and an owner in
// the same tenant can choose different homes, density, and notification posture.
// `notificationPreferences` remains an extensible object because B8 owns the concrete
// provider/subscription fields; quiet hours are first-class so they are validated now.
export const userPrefs = pgTable(
  "user_prefs",
  {
    userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    homepage: text("homepage", { enum: ["bridge", "map", "my-day"] }),
    density: text("density", { enum: ["comfortable", "compact"] }).notNull().default("comfortable"),
    pinnedPanels: jsonb("pinned_panels").notNull().default([]),
    accent: text("accent"),
    soundEnabled: boolean("sound_enabled").notNull().default(false),
    notificationPreferences: jsonb("notification_preferences").notNull().default({}),
    quietHoursStart: text("quiet_hours_start"),
    quietHoursEnd: text("quiet_hours_end"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_prefs_tenant_idx").on(t.tenantId)],
);

// B8.T1: Web Push's endpoint + encryption keys are per device/browser, never a
// user preference blob. Keeping these rows separate makes revocation and 410 cleanup
// explicit and lets RLS protect the opaque endpoint from tenant peers.
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("push_subscriptions_user_endpoint_idx").on(t.userId, t.endpoint), index("push_subscriptions_tenant_user_idx").on(t.tenantId, t.userId)],
);

// A4.T6 (migration 0042): opt-in idempotency for POST /api/actions. `response` starts
// null at claim time — the row itself is the claim, so a second INSERT for the same
// (tenantId, idempotencyKey) conflicts and is rejected before the orchestrator runs
// twice — then gets filled in once the real planner run completes.
export const intakeIdempotency = pgTable(
  "intake_idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    idempotencyKey: text("idempotency_key").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [unique("intake_idempotency_tenant_key_idx").on(t.tenantId, t.idempotencyKey), index("intake_idempotency_tenant_idx").on(t.tenantId)],
);

// jarvis-v3 P3.T1 (migration 0062): the instruction lifecycle trace (plan v3 §7.1).
// `id` is the CLIENT-minted instructionId (kernel/instruction.ts mints it and sends it
// in POST /api/actions) — no defaultRandom(), the row is created the moment
// handleInstruction first sees one, before the first instruction_events row.
export const instructionSessions = pgTable(
  "instruction_sessions",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workId: uuid("work_id").references(() => works.id),
    sessionId: text("session_id"),
    userId: uuid("user_id").references(() => users.id),
    authorityContext: jsonb("authority_context").notNull().default({}),
    instructionText: text("instruction_text").notNull(),
    source: text("source", { enum: ["typed", "voice"] }).notNull().default("typed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("instruction_sessions_tenant_idx").on(t.tenantId)],
);

// Append-only (never updated or deleted, same convention as action_log). `seq` is
// strictly increasing per instructionId — the UNIQUE constraint is what makes
// emitInstructionEvent()'s INSERT...SELECT MAX(seq)+1 pattern safe against a
// duplicate rather than a silent race.
export const instructionEvents = pgTable(
  "instruction_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    instructionId: uuid("instruction_id").notNull().references(() => instructionSessions.id),
    seq: integer("seq").notNull(),
    // 15 values verbatim from the session's own binding list — see migration 0062's
    // own note on the "14 vs 15" discrepancy in how that list was described.
    phase: text("phase", {
      enum: [
        "received", "context_retrieved", "planning", "plan_ready", "clarification_required",
        "action_created", "action_gated", "dispatched", "executing", "step_progress",
        "verifying", "verified", "completed", "failed", "cancelled",
      ],
    }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("instruction_events_instruction_seq_idx").on(t.instructionId, t.seq), index("instruction_events_tenant_idx").on(t.tenantId)],
);

// Phase 2 Universal Action + Delegation Fabric. Delivery state is deliberately
// separate from acknowledgement and from delegation acceptance/completion.
export const communicationDeliveries = pgTable(
  "communication_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
    workId: uuid("work_id").references(() => works.id),
    recipientType: text("recipient_type").notNull(),
    recipientId: uuid("recipient_id").notNull(),
    channel: text("channel", { enum: ["internal", "email", "sms", "voice"] }).notNull(),
    route: text("route", { enum: ["native", "api", "browser", "computer", "manual"] }).notNull(),
    status: text("status", { enum: ["queued", "sent", "delivered", "failed", "unknown"] }).notNull().default("queued"),
    provider: text("provider"),
    communicationIdentityId: uuid("communication_identity_id"),
    providerMessageRef: text("provider_message_ref"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("communication_deliveries_semantic_unique").on(t.domainActionId, t.recipientType, t.recipientId, t.channel),
    index("communication_deliveries_tenant_status_idx").on(t.tenantId, t.status, t.updatedAt),
    index("communication_deliveries_tenant_recipient_idx").on(t.tenantId, t.recipientType, t.recipientId, t.createdAt),
    foreignKey({
      columns: [t.tenantId, t.communicationIdentityId],
      foreignColumns: [communicationIdentities.tenantId, communicationIdentities.id],
      name: "communication_deliveries_identity_tenant_fkey",
    }),
  ],
);

export const delegations = pgTable(
  "delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
    workId: uuid("work_id").references(() => works.id),
    taskId: uuid("task_id").references(() => tasks.id),
    objectiveLoopId: uuid("objective_loop_id").references(() => workObjectiveLoops.id),
    createdBy: uuid("created_by").references(() => users.id),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    objective: text("objective").notNull(),
    intent: jsonb("intent").notNull().default({}),
    status: text("status", {
      enum: ["created", "sent", "delivered", "acknowledged", "accepted", "completed", "declined", "overdue", "escalated", "cancelled", "failed_delivery"],
    }).notNull().default("created"),
    acknowledgementDeadline: timestamp("acknowledgement_deadline", { withTimezone: true }),
    completionDeadline: timestamp("completion_deadline", { withTimezone: true }),
    escalationTargetType: text("escalation_target_type"),
    escalationTargetId: uuid("escalation_target_id"),
    escalationRule: jsonb("escalation_rule").notNull().default({}),
    evidenceRefs: jsonb("evidence_refs").notNull().default([]),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("delegations_domain_action_unique").on(t.domainActionId),
    index("delegations_tenant_target_status_idx").on(t.tenantId, t.targetType, t.targetId, t.status),
    index("delegations_tenant_deadlines_idx").on(t.tenantId, t.status, t.acknowledgementDeadline, t.completionDeadline),
  ],
);

export const delegationEvents = pgTable(
  "delegation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    delegationId: uuid("delegation_id").notNull().references(() => delegations.id),
    seq: integer("seq").notNull(),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorId: uuid("actor_id").references(() => users.id),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("delegation_events_delegation_seq_unique").on(t.delegationId, t.seq),
    index("delegation_events_tenant_delegation_idx").on(t.tenantId, t.delegationId, t.createdAt),
  ],
);

export const acknowledgementRequests = pgTable(
  "acknowledgement_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
    delegationId: uuid("delegation_id").references(() => delegations.id),
    deliveryId: uuid("delivery_id").references(() => communicationDeliveries.id),
    workId: uuid("work_id").references(() => works.id),
    taskId: uuid("task_id").references(() => tasks.id),
    recipientType: text("recipient_type").notNull(),
    recipientId: uuid("recipient_id").notNull(),
    request: text("request").notNull(),
    status: text("status", { enum: ["requested", "delivered", "acknowledged", "declined", "expired", "cancelled"] }).notNull().default("requested"),
    deadline: timestamp("deadline", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    declinedAt: timestamp("declined_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("acknowledgement_requests_domain_action_unique").on(t.domainActionId),
    index("acknowledgement_requests_tenant_status_deadline_idx").on(t.tenantId, t.status, t.deadline),
  ],
);

export const internalEvents = pgTable(
  "internal_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    originDomainActionId: uuid("origin_domain_action_id").notNull().references(() => domainActions.id),
    lastDomainActionId: uuid("last_domain_action_id").notNull().references(() => domainActions.id),
    workId: uuid("work_id").references(() => works.id),
    locationId: uuid("location_id").references(() => tenantLocations.id),
    title: text("title").notNull(),
    purpose: text("purpose"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["scheduled", "rescheduled", "cancelled", "completed"] }).notNull().default("scheduled"),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("internal_events_origin_action_unique").on(t.originDomainActionId),
    index("internal_events_tenant_time_idx").on(t.tenantId, t.startsAt, t.endsAt),
  ],
);

export const internalEventParticipants = pgTable(
  "internal_event_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    internalEventId: uuid("internal_event_id").notNull().references(() => internalEvents.id, { onDelete: "cascade" }),
    partyType: text("party_type").notNull(),
    partyId: uuid("party_id").notNull(),
    responseStatus: text("response_status", { enum: ["pending", "accepted", "declined", "tentative"] }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("internal_event_participants_identity_unique").on(t.internalEventId, t.partyType, t.partyId)],
);

export const internalEventEvents = pgTable(
  "internal_event_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    internalEventId: uuid("internal_event_id").notNull().references(() => internalEvents.id),
    domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
    seq: integer("seq").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("internal_event_events_event_seq_unique").on(t.internalEventId, t.seq),
    unique("internal_event_events_domain_action_unique").on(t.domainActionId),
  ],
);

export const documentShares = pgTable(
  "document_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
    documentId: uuid("document_id").notNull().references(() => documents.id),
    recipientType: text("recipient_type").notNull(),
    recipientId: uuid("recipient_id").notNull(),
    accessLevel: text("access_level", { enum: ["view", "comment"] }).notNull().default("view"),
    route: text("route", { enum: ["native", "api", "browser", "computer", "manual"] }).notNull(),
    status: text("status", { enum: ["shared", "pending_manual", "failed", "revoked"] }).notNull(),
    providerShareRef: text("provider_share_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("document_shares_domain_action_unique").on(t.domainActionId),
    index("document_shares_tenant_document_idx").on(t.tenantId, t.documentId, t.createdAt),
  ],
);

export const universalActionEvents = pgTable(
  "universal_action_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
    seq: integer("seq").notNull(),
    actionType: text("action_type").notNull(),
    eventType: text("event_type").notNull(),
    route: text("route", { enum: ["native", "api", "browser", "computer", "manual"] }),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    actorId: uuid("actor_id"),
    communicationIdentityId: uuid("communication_identity_id"),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("universal_action_events_action_seq_unique").on(t.domainActionId, t.seq),
    index("universal_action_events_tenant_action_idx").on(t.tenantId, t.domainActionId, t.createdAt),
    foreignKey({
      columns: [t.tenantId, t.actorId],
      foreignColumns: [users.tenantId, users.id],
      name: "universal_action_events_actor_tenant_fkey",
    }),
    foreignKey({
      columns: [t.tenantId, t.communicationIdentityId],
      foreignColumns: [communicationIdentities.tenantId, communicationIdentities.id],
      name: "universal_action_events_identity_tenant_fkey",
    }),
  ],
);

// Phase 3: durable, provider-neutral computer execution. providerSessionRef is a
// credential-sensitive runtime handle: workers need it for crash cleanup, but no
// safe projection, planner context, activity event, or receipt may serialize it.
export const computerRuns = pgTable(
  "computer_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    domainActionId: uuid("domain_action_id").notNull().references(() => domainActions.id),
    businessEffectId: uuid("business_effect_id"),
    workId: uuid("work_id").references(() => works.id),
    objectiveLoopId: uuid("objective_loop_id").references(() => workObjectiveLoops.id),
    actorId: uuid("actor_id").notNull().references(() => users.id),
    applicationAccountId: uuid("application_account_id").notNull().references(() => applicationAccounts.id),
    authProfileId: uuid("auth_profile_id").notNull().references(() => authProfiles.id),
    authProfileRef: text("auth_profile_ref").notNull(),
    application: text("application").notNull(),
    provider: text("provider").notNull(),
    providerSessionRef: text("provider_session_ref"),
    status: text("status", { enum: ["queued", "authorizing", "provisioning", "authenticating", "running", "reconciling", "succeeded", "blocked", "failed", "timed_out", "cancelled"] }).notNull().default("queued"),
    mode: text("mode", { enum: ["READ_ONLY", "WRITE"] }).notNull(),
    task: text("task").notNull(),
    target: jsonb("target").notNull(),
    authorizedEffect: jsonb("authorized_effect"),
    allowedOrigins: jsonb("allowed_origins").notNull().default([]),
    authOrigins: jsonb("auth_origins").notNull().default([]),
    limits: jsonb("limits").notNull(),
    result: jsonb("result"),
    failureCode: text("failure_code"),
    blockReason: text("block_reason"),
    effectStatus: text("effect_status", { enum: ["none", "pending", "dispatching", "succeeded", "failed", "unknown"] }).notNull().default("none"),
    effectOperationKey: text("effect_operation_key"),
    cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    sessionReleasedAt: timestamp("session_released_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    cleanupAttemptedAt: timestamp("cleanup_attempted_at", { withTimezone: true }),
    cleanupFailureCode: text("cleanup_failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("computer_runs_domain_action_unique").on(t.domainActionId),
    unique("computer_runs_tenant_id_id_key").on(t.tenantId, t.id),
    index("computer_runs_tenant_status_created_idx").on(t.tenantId, t.status, t.createdAt),
    index("computer_runs_tenant_work_idx").on(t.tenantId, t.workId, t.createdAt),
    index("computer_runs_stale_active_idx").on(t.deadlineAt, t.lastHeartbeatAt).where(sql`${t.status} IN ('authorizing','provisioning','authenticating','running','reconciling')`),
  ],
);

export const computerSteps = pgTable(
  "computer_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    runId: uuid("run_id").notNull().references(() => computerRuns.id),
    seq: integer("seq").notNull(),
    phase: text("phase", { enum: ["queued", "authorizing", "provisioning", "authenticating", "running", "reconciling", "succeeded", "blocked", "failed", "timed_out", "cancelled"] }).notNull(),
    operation: text("operation").notNull(),
    status: text("status", { enum: ["started", "succeeded", "blocked", "failed"] }).notNull().default("started"),
    summary: text("summary").notNull(),
    pageUrl: text("page_url"),
    detail: jsonb("detail").notNull().default({}),
    effectCandidateHash: text("effect_candidate_hash"),
    authorityDecisionId: uuid("authority_decision_id").references(() => authorityDecisions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("computer_steps_run_seq_unique").on(t.runId, t.seq),
    unique("computer_steps_tenant_id_id_key").on(t.tenantId, t.id),
    index("computer_steps_tenant_run_created_idx").on(t.tenantId, t.runId, t.createdAt),
  ],
);

export const computerArtifacts = pgTable(
  "computer_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    runId: uuid("run_id").notNull().references(() => computerRuns.id),
    stepId: uuid("step_id").references(() => computerSteps.id),
    kind: text("kind", { enum: ["dom_snapshot", "screenshot", "download", "upload", "result_evidence"] }).notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storageRef: text("storage_ref"),
    content: bytea("content"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("computer_artifacts_tenant_run_created_idx").on(t.tenantId, t.runId, t.createdAt),
    unique("computer_artifacts_tenant_id_id_key").on(t.tenantId, t.id),
  ],
);

// Phase 4: one provider-neutral observation envelope. External text remains bounded
// untrusted evidence and is structurally ineligible to become an instruction.
export const integrationEvents = pgTable(
  "integration_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    source: text("source").notNull(),
    provider: text("provider"),
    sourceEventId: text("source_event_id").notNull(),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    partyType: text("party_type"),
    partyId: uuid("party_id"),
    resourceType: text("resource_type"),
    resourceId: uuid("resource_id"),
    workId: uuid("work_id").references(() => works.id),
    taskId: uuid("task_id").references(() => tasks.id),
    delegationId: uuid("delegation_id").references(() => delegations.id),
    acknowledgementRequestId: uuid("acknowledgement_request_id").references(() => acknowledgementRequests.id),
    computerRunId: uuid("computer_run_id").references(() => computerRuns.id),
    domainActionId: uuid("domain_action_id").references(() => domainActions.id),
    providerConversationId: text("provider_conversation_id"),
    providerMessageId: text("provider_message_id"),
    applicationRef: text("application_ref"),
    correlationId: text("correlation_id"),
    payload: jsonb("payload").notNull().default({}),
    evidenceRefs: jsonb("evidence_refs").notNull().default([]),
    trustClass: text("trust_class", { enum: ["untrusted_external", "trusted_runtime"] }).notNull().default("untrusted_external"),
    contentTreatment: text("content_treatment").notNull().default("untrusted_evidence"),
    instructionEligible: boolean("instruction_eligible").notNull().default(false),
    status: text("status", { enum: ["received", "matched", "unmatched", "ignored"] }).notNull().default("received"),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("integration_events_replay_unique").on(t.tenantId, t.source, t.sourceEventId),
    check("integration_events_party_pair_check", sql`(${t.partyType} IS NULL)=(${t.partyId} IS NULL)`),
    check("integration_events_resource_pair_check", sql`(${t.resourceType} IS NULL)=(${t.resourceId} IS NULL)`),
    index("integration_events_tenant_type_time_idx").on(t.tenantId, t.eventType, t.occurredAt),
    index("integration_events_tenant_work_time_idx").on(t.tenantId, t.workId, t.occurredAt).where(sql`${t.workId} IS NOT NULL`),
    index("integration_events_tenant_status_received_idx").on(t.tenantId, t.status, t.receivedAt),
  ],
);

// A wait is an exact, durable correlation contract owned by the Objective Loop step
// that paused. The timer engine may only time it out and wake that same loop.
export const workEventWaits = pgTable(
  "work_event_waits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    objectiveLoopId: uuid("objective_loop_id").notNull().references(() => workObjectiveLoops.id),
    objectiveStepId: uuid("objective_step_id").notNull().references(() => workObjectiveSteps.id),
    status: text("status", { enum: ["waiting", "satisfied", "timed_out", "cancelled"] }).notNull().default("waiting"),
    expectedEventType: text("expected_event_type").notNull(),
    subjectType: text("subject_type"),
    subjectId: uuid("subject_id"),
    resourceType: text("resource_type"),
    resourceId: uuid("resource_id"),
    delegationId: uuid("delegation_id").references(() => delegations.id),
    taskId: uuid("task_id").references(() => tasks.id),
    acknowledgementRequestId: uuid("acknowledgement_request_id").references(() => acknowledgementRequests.id),
    computerRunId: uuid("computer_run_id").references(() => computerRuns.id),
    domainActionId: uuid("domain_action_id").references(() => domainActions.id),
    provider: text("provider"),
    providerConversationId: text("provider_conversation_id"),
    providerMessageId: text("provider_message_id"),
    applicationRef: text("application_ref"),
    correlationId: text("correlation_id"),
    conditionSummary: text("condition_summary").notNull(),
    continuationPolicy: jsonb("continuation_policy").notNull().default({ mode: "reinspect_current_state", maxDecisions: 1 }),
    earliestAt: timestamp("earliest_at", { withTimezone: true }).notNull().defaultNow(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    matchedEventId: uuid("matched_event_id").references(() => integrationEvents.id),
    satisfiedAt: timestamp("satisfied_at", { withTimezone: true }),
    timedOutAt: timestamp("timed_out_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("work_event_waits_step_unique").on(t.objectiveStepId),
    unique("work_event_waits_tenant_id_id_key").on(t.tenantId, t.id),
    check("work_event_waits_subject_pair_check", sql`(${t.subjectType} IS NULL)=(${t.subjectId} IS NULL)`),
    check("work_event_waits_resource_pair_check", sql`(${t.resourceType} IS NULL)=(${t.resourceId} IS NULL)`),
    index("work_event_waits_tenant_match_idx").on(t.tenantId, t.status, t.expectedEventType, t.earliestAt),
    index("work_event_waits_tenant_deadline_idx").on(t.tenantId, t.status, t.deadlineAt).where(sql`${t.deadlineAt} IS NOT NULL`),
    index("work_event_waits_tenant_work_idx").on(t.tenantId, t.workId, t.createdAt),
  ],
);

// One row is the database-level semantic continuation claim. The associated job is
// inserted in the same transaction, closing both crash windows around enqueue.
export const workWakeClaims = pgTable(
  "work_wake_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    waitId: uuid("wait_id").notNull().references(() => workEventWaits.id),
    integrationEventId: uuid("integration_event_id").notNull().references(() => integrationEvents.id),
    objectiveLoopId: uuid("objective_loop_id").notNull().references(() => workObjectiveLoops.id),
    workId: uuid("work_id").notNull().references(() => works.id),
    cause: text("cause", { enum: ["event", "deadline"] }).notNull(),
    objectiveRevision: integer("objective_revision").notNull(),
    jobId: uuid("job_id").notNull().references(() => jobs.id),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    unique("work_wake_claims_wait_unique").on(t.waitId),
    unique("work_wake_claims_job_unique").on(t.jobId),
    unique("work_wake_claims_tenant_id_id_key").on(t.tenantId, t.id),
    index("work_wake_claims_tenant_loop_idx").on(t.tenantId, t.objectiveLoopId, t.claimedAt),
  ],
);

// P1 Private Equity World. SQL migrations own the full database checks and
// trigger boundaries; these declarations keep application/query types aligned
// with those canonical tables without creating a second persistence model.
export const peStrategies = pgTable(
  "pe_strategies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    description: text("description"),
    investmentCriteria: jsonb("investment_criteria").notNull().default({}),
    state: text("state", { enum: ["draft", "active", "retired"] }).notNull().default("draft"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id"),
    createdBy: text("created_by").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pe_strategies_tenant_id_id_key").on(t.tenantId, t.id),
    unique("pe_strategies_source_identity_key").on(t.tenantId, t.sourceSystem, t.externalId),
    index("pe_strategies_tenant_state_idx").on(t.tenantId, t.state, t.createdAt, t.id),
  ],
);

export const peOpportunities = pgTable(
  "pe_opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    strategyId: uuid("strategy_id").notNull().references(() => peStrategies.id),
    targetOrganizationId: uuid("target_organization_id").notNull().references(() => externalOrganizations.id),
    name: text("name").notNull(),
    summary: text("summary"),
    state: text("state", { enum: ["identified", "screening", "qualified", "promoted", "rejected"] }).notNull().default("identified"),
    screeningStartedAt: timestamp("screening_started_at", { withTimezone: true }),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    version: integer("version").notNull().default(1),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id"),
    createdBy: text("created_by").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pe_opportunities_tenant_id_id_key").on(t.tenantId, t.id),
    unique("pe_opportunities_source_identity_key").on(t.tenantId, t.sourceSystem, t.externalId),
    index("pe_opportunities_tenant_strategy_state_idx").on(t.tenantId, t.strategyId, t.state, t.createdAt, t.id),
  ],
);

export const peInvestmentCases = pgTable(
  "pe_investment_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    dealId: uuid("deal_id").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    state: text("state", { enum: ["draft", "active", "superseded", "archived"] }).notNull().default("draft"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id"),
    createdBy: text("created_by").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pe_investment_cases_tenant_deal_id_key").on(t.tenantId, t.dealId, t.id),
    unique("pe_investment_cases_source_identity_key").on(t.tenantId, t.sourceSystem, t.externalId),
    uniqueIndex("pe_investment_cases_one_active_idx").on(t.dealId).where(sql`${t.state}='active'`),
    index("pe_investment_cases_tenant_deal_state_idx").on(t.tenantId, t.dealId, t.state, t.createdAt, t.id),
  ],
);

export const peTheses = pgTable(
  "pe_theses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    dealId: uuid("deal_id").notNull(),
    investmentCaseId: uuid("investment_case_id").notNull().references(() => peInvestmentCases.id),
    thesisType: text("thesis_type").notNull(),
    title: text("title").notNull(),
    statement: text("statement").notNull(),
    state: text("state", { enum: ["draft", "active", "superseded", "retired"] }).notNull().default("draft"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id"),
    createdBy: text("created_by").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pe_theses_tenant_deal_id_key").on(t.tenantId, t.dealId, t.id),
    unique("pe_theses_source_identity_key").on(t.tenantId, t.sourceSystem, t.externalId),
    index("pe_theses_tenant_case_state_idx").on(t.tenantId, t.investmentCaseId, t.state, t.createdAt, t.id),
  ],
);

export const peAssumptions = pgTable(
  "pe_assumptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    dealId: uuid("deal_id").notNull(),
    investmentCaseId: uuid("investment_case_id").notNull().references(() => peInvestmentCases.id),
    assumptionKey: text("assumption_key").notNull(),
    statement: text("statement").notNull(),
    valueType: text("value_type", { enum: ["number", "currency", "percent", "boolean", "date", "text", "json"] }).notNull(),
    value: jsonb("value").notNull(),
    currencyCode: text("currency_code"),
    unit: text("unit"),
    materiality: text("materiality", { enum: ["low", "medium", "high", "critical"] }).notNull().default("medium"),
    state: text("state", { enum: ["active", "superseded", "invalidated"] }).notNull().default("active"),
    supersedesAssumptionId: uuid("supersedes_assumption_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason"),
    version: integer("version").notNull().default(1),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id"),
    createdBy: text("created_by").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pe_assumptions_tenant_deal_id_key").on(t.tenantId, t.dealId, t.id),
    unique("pe_assumptions_revision_once_key").on(t.supersedesAssumptionId),
    unique("pe_assumptions_source_identity_key").on(t.tenantId, t.sourceSystem, t.externalId),
    uniqueIndex("pe_assumptions_one_current_key_idx").on(t.investmentCaseId, t.assumptionKey).where(sql`${t.state}='active'`),
    index("pe_assumptions_tenant_case_state_idx").on(t.tenantId, t.investmentCaseId, t.state, t.createdAt, t.id),
  ],
);

export const peDecisions = pgTable(
  "pe_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    dealId: uuid("deal_id").notNull(),
    investmentCaseId: uuid("investment_case_id").notNull().references(() => peInvestmentCases.id),
    decisionType: text("decision_type").notNull(),
    title: text("title").notNull(),
    decision: text("decision").notNull(),
    rationale: text("rationale"),
    state: text("state", { enum: ["draft", "final", "superseded"] }).notNull().default("draft"),
    decidedByPartyType: text("decided_by_party_type"),
    decidedByPartyId: uuid("decided_by_party_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    supersedesDecisionId: uuid("supersedes_decision_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id"),
    createdBy: text("created_by").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pe_decisions_tenant_id_id_key").on(t.tenantId, t.id),
    unique("pe_decisions_tenant_deal_id_key").on(t.tenantId, t.dealId, t.id),
    unique("pe_decisions_supersession_once_key").on(t.supersedesDecisionId),
    unique("pe_decisions_source_identity_key").on(t.tenantId, t.sourceSystem, t.externalId),
    index("pe_decisions_tenant_case_state_idx").on(t.tenantId, t.investmentCaseId, t.state, t.createdAt, t.id),
  ],
);

export const peDecisionEffectLinks = pgTable(
  "pe_decision_effect_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    decisionId: uuid("decision_id").notNull().references(() => peDecisions.id),
    effectType: text("effect_type", { enum: ["work", "domain_action", "decision_receipt"] }).notNull(),
    effectId: uuid("effect_id").notNull(),
    relationship: text("relationship", { enum: ["implements", "records", "governs"] }).notNull().default("implements"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pe_decision_effect_links_identity_key").on(t.decisionId, t.effectType, t.effectId, t.relationship),
    index("pe_decision_effect_links_tenant_decision_idx").on(t.tenantId, t.decisionId, t.createdAt, t.id),
  ],
);

export const canonicalHistoryCoverage = pgTable("canonical_history_coverage", {
  entityType: text("entity_type").primaryKey(),
  sourceTable: text("source_table").notNull(),
  verticalKey: text("vertical_key").notNull(),
  coverageStartedAt: timestamp("coverage_started_at", { withTimezone: true }).notNull(),
  baselineCompletedAt: timestamp("baseline_completed_at", { withTimezone: true }).notNull(),
});

export const canonicalEntityVersions = pgTable(
  "canonical_entity_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    entityVersion: integer("entity_version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    sourceSystem: text("source_system"),
    externalId: text("external_id"),
    actor: text("actor"),
    origin: text("origin", { enum: ["mutation", "baseline"] }).notNull(),
    previousVersionId: uuid("previous_version_id"),
  },
  (t) => [
    unique("canonical_entity_versions_identity_key").on(t.tenantId, t.entityType, t.entityId, t.entityVersion),
    index("canonical_entity_versions_entity_recorded_idx").on(t.tenantId, t.entityType, t.entityId, t.recordedAt, t.entityVersion),
    index("canonical_entity_versions_tenant_recorded_idx").on(t.tenantId, t.recordedAt, t.id),
  ],
);

export const externalRefObservations = pgTable(
  "external_ref_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    integrationId: uuid("integration_id").notNull().references(() => tenantIntegrations.id),
    sourceScopeId: uuid("source_scope_id").references(() => integrationSourceScopes.id),
    sourceLinkId: uuid("source_link_id").references(() => externalRefs.id),
    provider: text("provider").notNull(),
    resourceKind: text("resource_kind"),
    externalObjectType: text("external_object_type").notNull(),
    externalId: text("external_id").notNull(),
    canonicalEntityType: text("canonical_entity_type"),
    canonicalEntityId: uuid("canonical_entity_id"),
    sourceVersion: text("source_version"),
    sourceSequence: bigint("source_sequence", { mode: "bigint" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    observationKey: text("observation_key"),
    observedHash: text("observed_hash").notNull(),
    observedState: jsonb("observed_state").notNull(),
    providerParentRefs: jsonb("provider_parent_refs").notNull().default([]),
    providerMetadata: jsonb("provider_metadata").notNull().default({}),
    ingestionMode: text("ingestion_mode", { enum: ["initial_backfill", "incremental", "recovery", "exact_read"] }),
    traceId: text("trace_id"),
    evidenceSourceId: uuid("evidence_source_id").references(() => evidenceSources.id),
    evidenceVersionId: uuid("evidence_version_id").references(() => evidenceSourceVersions.id),
    materializationStatus: text("materialization_status").notNull(),
    mappingStatus: text("mapping_status"),
    conflictState: text("conflict_state"),
    providerDeleted: boolean("provider_deleted").notNull().default(false),
    reason: text("reason"),
    businessEffectId: uuid("business_effect_id"),
    provenance: jsonb("provenance").notNull().default({}),
  },
  (t) => [
    index("external_ref_observations_external_time_idx").on(
      t.tenantId, t.integrationId, t.externalObjectType, t.externalId, t.receivedAt, t.id,
    ),
    index("external_ref_observations_canonical_time_idx").on(
      t.tenantId, t.canonicalEntityType, t.canonicalEntityId, t.receivedAt, t.id,
    ),
    uniqueIndex("external_ref_observations_observation_key")
      .on(t.tenantId, t.integrationId, t.observationKey)
      .where(sql`${t.observationKey} IS NOT NULL`),
    index("external_ref_observations_scope_retrieved_idx").on(
      t.tenantId, t.sourceScopeId, t.retrievedAt, t.id,
    ),
    index("external_ref_observations_parent_refs_gin_idx")
      .using("gin", t.providerParentRefs.op("jsonb_path_ops")),
  ],
);
