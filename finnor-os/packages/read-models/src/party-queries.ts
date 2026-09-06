import {
  employeeRelationships,
  employeeRoleAssignments,
  employeeRoles,
  orgUnitMemberships,
  orgUnits,
  tasks,
  tenantLocations,
  users,
  withTenant,
  works,
} from "@finnor/db";
import type {
  OperatingCompanyDirectory,
  OperationalPartySummary,
  PartyCandidate,
  PartyContextRequest,
  PartyContextResult,
  PartyLookupRequest,
  PartyLookupResult,
  PartyRef,
  PartyRelationshipRow,
  PartyResolution,
  TeamRosterRequest,
  TeamRosterResult,
} from "@finnor/shared-types";
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { resolveParty } from "./party-resolver";

const MAX_ROWS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_TABLES = [
  "users", "org_units", "tenant_locations", "external_organizations",
  "external_contacts", "party_aliases", "employee_relationships",
  "org_unit_memberships", "works", "tasks", "employee_role_assignments",
  "employee_roles",
] as const;

export interface PartyReadExecutionContext {
  employeeId?: string;
  userId?: string;
  workId?: string;
  referencedPartyRefs?: PartyRef[];
  now?: Date;
  maxRows?: number;
}

type Resolution = "exact" | "unique" | "ambiguous" | "not_found" | "inactive";

function publicResolution(value: PartyResolution): Resolution {
  if (value.status === "resolved") return value.method === "explicit_ref" ? "exact" : "unique";
  return value.status;
}

function summary(candidate: PartyCandidate): OperationalPartySummary {
  return {
    ref: candidate.ref,
    displayName: candidate.displayName,
    status: candidate.status,
    description: candidate.description,
  };
}

function limitFor(request: { page?: { limit?: number } }, context: PartyReadExecutionContext): number {
  return Math.min(MAX_ROWS, Math.max(1, Math.floor(context.maxRows ?? request.page?.limit ?? 50)));
}

function base<I extends "party_lookup" | "party_context" | "team_roster">(
  intent: I,
  resolution: Resolution,
  count: number,
  limit: number,
  now: Date,
) {
  const source = { kind: "canonical_postgres" as const, tables: [...SOURCE_TABLES] };
  const page = { limit, returned: count, totalCount: count, totalCountExact: true, hasMore: false, nextCursor: null, truncated: false };
  return {
    kind: "operational_query_result" as const,
    status: resolution === "exact" || resolution === "unique" ? "ok" as const : resolution,
    data: {},
    version: 1 as const,
    intent,
    source,
    asOf: now.toISOString(),
    count,
    truncated: false,
    page,
    meta: { version: 1 as const, source, asOf: now.toISOString() },
  };
}

function resolverContext(context: PartyReadExecutionContext) {
  const requesterEmployeeId = context.employeeId ?? (context.userId && UUID.test(context.userId) ? context.userId : undefined);
  return { ...(requesterEmployeeId ? { requesterEmployeeId } : {}), ...(context.workId ? { workId: context.workId } : {}) };
}

async function details(tenantId: string, ref: PartyRef): Promise<{
  teams: OperationalPartySummary[];
  locations: OperationalPartySummary[];
  relationships: PartyRelationshipRow[];
  currentWork: PartyContextResult["currentWork"];
  currentTasks: PartyContextResult["currentTasks"];
  authorityRoles: string[];
}> {
  const empty = { teams: [], locations: [], relationships: [], currentWork: [], currentTasks: [], authorityRoles: [] };
  if (ref.partyType !== "employee") return empty;
  return withTenant(tenantId, async (db) => {
    const memberships = await db.select({
      teamId: orgUnits.id,
      teamName: orgUnits.name,
      teamActive: orgUnits.active,
      locationId: tenantLocations.id,
      locationName: tenantLocations.name,
      locationActive: tenantLocations.active,
    }).from(orgUnitMemberships)
      .innerJoin(orgUnits, and(eq(orgUnits.tenantId, orgUnitMemberships.tenantId), eq(orgUnits.id, orgUnitMemberships.orgUnitId)))
      .leftJoin(tenantLocations, and(eq(tenantLocations.tenantId, orgUnits.tenantId), eq(tenantLocations.id, orgUnits.locationId)))
      .where(and(eq(orgUnitMemberships.tenantId, tenantId), eq(orgUnitMemberships.employeeId, ref.partyId), eq(orgUnitMemberships.active, true)))
      .limit(MAX_ROWS);
    const relationRows = await db.select({
      subject: employeeRelationships.subjectEmployeeId,
      related: employeeRelationships.relatedEmployeeId,
      relationship: employeeRelationships.relationshipType,
    }).from(employeeRelationships).where(and(
      eq(employeeRelationships.tenantId, tenantId),
      eq(employeeRelationships.active, true),
      or(eq(employeeRelationships.subjectEmployeeId, ref.partyId), eq(employeeRelationships.relatedEmployeeId, ref.partyId)),
    )).limit(MAX_ROWS);
    const relatedIds = [...new Set(relationRows.flatMap((row) => [row.subject, row.related]))];
    const names = relatedIds.length > 0
      ? await db.select({ id: users.id, name: users.displayName, status: users.status, role: users.role }).from(users)
        .where(and(eq(users.tenantId, tenantId), inArray(users.id, relatedIds))).limit(MAX_ROWS)
      : [];
    const nameById = new Map(names.map((row) => [row.id, row]));
    const relationships = relationRows.map((row): PartyRelationshipRow => ({
      relationship: row.relationship,
      from: { partyType: "employee", partyId: row.subject },
      to: { partyType: "employee", partyId: row.related },
      label: nameById.get(row.related)?.name ?? null,
      status: nameById.get(row.related)?.status ?? null,
    }));
    const workRows = await db.select({ id: works.id, status: works.status, instruction: works.initialInstruction, updatedAt: works.updatedAt })
      .from(works).where(and(eq(works.tenantId, tenantId), eq(works.assignedTo, ref.partyId)))
      .orderBy(desc(works.updatedAt)).limit(20);
    const taskRows = await db.select({
      id: tasks.id, title: tasks.title, status: tasks.status, dueAt: tasks.dueAt,
    }).from(tasks).where(and(
      eq(tasks.tenantId, tenantId),
      eq(tasks.assignedPartyType, "employee"),
      eq(tasks.assignedPartyId, ref.partyId),
      isNull(tasks.archivedAt),
    )).orderBy(asc(tasks.dueAt)).limit(50);
    const roleRows = await db.select({ key: employeeRoles.key }).from(employeeRoleAssignments)
      .innerJoin(employeeRoles, and(eq(employeeRoles.tenantId, employeeRoleAssignments.tenantId), eq(employeeRoles.id, employeeRoleAssignments.roleId)))
      .where(and(
        eq(employeeRoleAssignments.tenantId, tenantId),
        eq(employeeRoleAssignments.employeeId, ref.partyId),
        eq(employeeRoleAssignments.active, true),
        eq(employeeRoles.active, true),
        or(isNull(employeeRoleAssignments.expiresAt), gt(employeeRoleAssignments.expiresAt, new Date())),
      )).limit(MAX_ROWS);
    const teams = memberships.map((row): OperationalPartySummary => ({
      ref: { partyType: "team", partyId: row.teamId },
      displayName: row.teamName,
      status: row.teamActive ? "active" : "inactive",
      description: null,
    }));
    const locations = [...new Map(memberships.flatMap((row) => row.locationId && row.locationName ? [[row.locationId, {
      ref: { partyType: "location" as const, partyId: row.locationId },
      displayName: row.locationName,
      status: row.locationActive ? "active" as const : "inactive" as const,
      description: null,
    }]] : [])).values()];
    return {
      teams,
      locations,
      relationships,
      currentWork: workRows.map((row) => ({ ...row, updatedAt: row.updatedAt?.toISOString() ?? null })),
      currentTasks: taskRows.map((row) => ({ ...row, dueAt: row.dueAt?.toISOString() ?? null, authorityRole: null })),
      authorityRoles: roleRows.map((row) => row.key),
    };
  });
}

export async function partyLookup(
  tenantId: string,
  request: PartyLookupRequest,
  context: PartyReadExecutionContext = {},
): Promise<PartyLookupResult> {
  const resolution = await resolveParty(tenantId, { ...(request.ref ? { ref: request.ref } : {}), ...(request.query ? { query: request.query } : {}) }, resolverContext(context));
  const rows = resolution.candidates.slice(0, limitFor(request, context)).map(summary);
  const value = publicResolution(resolution);
  return { ...base("party_lookup", value, rows.length, limitFor(request, context), context.now ?? new Date()), resolution: value, rows, data: { rows } };
}

export async function partyContext(
  tenantId: string,
  request: PartyContextRequest,
  context: PartyReadExecutionContext = {},
): Promise<PartyContextResult> {
  const resolution = await resolveParty(tenantId, { ...(request.ref ? { ref: request.ref } : {}), ...(request.query ? { query: request.query } : {}) }, resolverContext(context));
  const value = publicResolution(resolution);
  const selected = resolution.party ? summary(resolution.party) : null;
  const candidates = resolution.candidates.slice(0, limitFor(request, context)).map(summary);
  const related = resolution.party ? await details(tenantId, resolution.party.ref) : await Promise.resolve({
    teams: [], locations: [], relationships: [], currentWork: [], currentTasks: [], authorityRoles: [],
  });
  return {
    ...base("party_context", value, selected ? 1 : candidates.length, limitFor(request, context), context.now ?? new Date()),
    resolution: value,
    party: selected,
    candidates,
    ...related,
    data: { party: selected, candidates, ...related },
  };
}

export async function teamRoster(
  tenantId: string,
  request: TeamRosterRequest,
  context: PartyReadExecutionContext = {},
): Promise<TeamRosterResult> {
  const resolution = await resolveParty(tenantId, {
    ...(request.teamRef ? { ref: request.teamRef } : {}),
    ...(request.query ? { query: request.query } : {}),
  }, resolverContext(context));
  const value = publicResolution(resolution);
  const team = resolution.party?.ref.partyType === "team" ? summary(resolution.party) : null;
  const candidates = resolution.candidates.slice(0, limitFor(request, context)).map(summary);
  const members = team ? await withTenant(tenantId, async (db) => {
    const rows = await db.select({
      id: users.id, name: users.displayName, status: users.status, role: users.role, membershipRole: orgUnitMemberships.membershipRole,
    }).from(orgUnitMemberships)
      .innerJoin(users, and(eq(users.tenantId, orgUnitMemberships.tenantId), eq(users.id, orgUnitMemberships.employeeId)))
      .where(and(
        eq(orgUnitMemberships.tenantId, tenantId),
        eq(orgUnitMemberships.orgUnitId, team.ref.partyId),
        eq(orgUnitMemberships.active, true),
      )).orderBy(asc(users.displayName)).limit(limitFor(request, context));
    return rows.map((row): TeamRosterResult["members"][number] => ({
      ref: { partyType: "employee", partyId: row.id },
      displayName: row.name?.trim() || "Employee",
      status: row.status === "active" ? "active" : "suspended",
      description: row.role,
      membershipRole: row.membershipRole,
    }));
  }) : [];
  return {
    ...base("team_roster", value, members.length, limitFor(request, context), context.now ?? new Date()),
    resolution: value,
    team,
    candidates,
    members,
    data: { team, candidates, members },
  };
}

export async function executePartyOperationalQuery(
  tenantId: string,
  request: PartyLookupRequest | PartyContextRequest | TeamRosterRequest,
  context: PartyReadExecutionContext = {},
): Promise<PartyLookupResult | PartyContextResult | TeamRosterResult> {
  if (request.intent === "party_lookup") return partyLookup(tenantId, request, context);
  if (request.intent === "party_context") return partyContext(tenantId, request, context);
  return teamRoster(tenantId, request, context);
}

export async function loadOperatingDirectoryContext(
  tenantId: string,
  context: PartyReadExecutionContext = {},
): Promise<OperatingCompanyDirectory> {
  const employeeId = context.employeeId ?? (context.userId && UUID.test(context.userId) ? context.userId : undefined);
  const resolution = employeeId
    ? await resolveParty(tenantId, { ref: { partyType: "employee", partyId: employeeId } }, resolverContext(context))
    : { status: "not_found", method: null, query: null, party: null, candidates: [] } satisfies PartyResolution;
  const employee = resolution.party ? summary(resolution.party) : null;
  const related = employee ? await details(tenantId, employee.ref) : {
    teams: [], locations: [], relationships: [], currentWork: [], currentTasks: [], authorityRoles: [],
  };
  const relatedRefs = related.relationships.flatMap((row) => [row.from, row.to])
    .filter((ref, index, rows) => ref.partyId !== employee?.ref.partyId && rows.findIndex((candidate) => candidate.partyType === ref.partyType && candidate.partyId === ref.partyId) === index);
  const relatedPeople = await Promise.all(relatedRefs.map((ref) => resolveParty(tenantId, { ref }, resolverContext(context))));
  const byRelationship = (kind: string, inverse = false) => related.relationships
    .filter((row) => row.relationship === kind && (inverse ? row.to.partyId === employee?.ref.partyId : row.from.partyId === employee?.ref.partyId))
    .flatMap((row) => {
      const ref = inverse ? row.from : row.to;
      const candidate = relatedPeople.flatMap((item) => item.candidates).find((item) => item.ref.partyId === ref.partyId && item.ref.partyType === ref.partyType);
      return candidate ? [summary(candidate)] : [];
    });
  const referenced = await Promise.all((context.referencedPartyRefs ?? []).map((ref) => resolveParty(tenantId, { ref }, resolverContext(context))));
  return {
    employee,
    teams: related.teams,
    locations: related.locations,
    reporting: {
      manager: byRelationship("manager")[0] ?? null,
      reports: byRelationship("manager", true),
      backups: byRelationship("backup"),
      assistants: byRelationship("assistant"),
    },
    currentWork: related.currentWork,
    currentTasks: related.currentTasks,
    authorityRoles: related.authorityRoles,
    referencedParties: referenced.flatMap((item) => item.candidates).map(summary),
    sourceTables: [...SOURCE_TABLES],
  };
}
