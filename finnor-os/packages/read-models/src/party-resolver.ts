import {
  employeeRelationships,
  externalContacts,
  externalOrganizations,
  orgUnitMemberships,
  orgUnits,
  partyAliases,
  tenantLocations,
  users,
  withTenant,
  workEntityLinks,
  works,
} from "@finnor/db";
import {
  PARTY_TYPES,
  isRetiredWaterParty,
  type PartyCandidate,
  type PartyRef,
  type PartyResolution,
  type PartyResolutionMethod,
  type PartyResolverContext,
  type PartyResolverInput,
  type PartyType,
} from "@finnor/shared-types";
import { and, eq } from "drizzle-orm";

const PARTY_TYPE_SET = new Set<string>(PARTY_TYPES);
const DIRECTORY_CAP = 200;

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function key(ref: PartyRef): string {
  return `${ref.partyType}:${ref.partyId}`;
}

function unique(rows: PartyCandidate[]): PartyCandidate[] {
  return [...new Map(rows.map((row) => [key(row.ref), row])).values()]
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.ref.partyId.localeCompare(right.ref.partyId))
    .slice(0, DIRECTORY_CAP);
}

function finish(query: string | null, method: PartyResolutionMethod | null, candidates: PartyCandidate[]): PartyResolution {
  const rows = unique(candidates);
  if (rows.length === 0) return { status: "not_found", method, query, party: null, candidates: [] };
  if (rows.length > 1) return { status: "ambiguous", method, query, party: null, candidates: rows };
  const party = rows[0]!;
  if (party.status !== "active") return { status: "inactive", method, query, party, candidates: rows };
  return { status: "resolved", method, query, party, candidates: rows };
}

async function directory(tenantId: string): Promise<PartyCandidate[]> {
  return withTenant(tenantId, async (db) => {
    const [employeeRows, teamRows, locationRows, organizationRows, contactRows] = await Promise.all([
      db.select({ id: users.id, name: users.displayName, status: users.status, role: users.role })
        .from(users).where(eq(users.tenantId, tenantId)).limit(DIRECTORY_CAP),
      db.select({ id: orgUnits.id, name: orgUnits.name, active: orgUnits.active, description: orgUnits.description })
        .from(orgUnits).where(eq(orgUnits.tenantId, tenantId)).limit(DIRECTORY_CAP),
      db.select({ id: tenantLocations.id, name: tenantLocations.name, active: tenantLocations.active, address: tenantLocations.address })
        .from(tenantLocations).where(eq(tenantLocations.tenantId, tenantId)).limit(DIRECTORY_CAP),
      db.select({ id: externalOrganizations.id, name: externalOrganizations.name, active: externalOrganizations.active, kind: externalOrganizations.kind })
        .from(externalOrganizations).where(eq(externalOrganizations.tenantId, tenantId)).limit(DIRECTORY_CAP),
      db.select({ id: externalContacts.id, name: externalContacts.name, active: externalContacts.active, title: externalContacts.title })
        .from(externalContacts).where(eq(externalContacts.tenantId, tenantId)).limit(DIRECTORY_CAP),
    ]);
    return [
      ...employeeRows.map((row): PartyCandidate => ({
        ref: { partyType: "employee", partyId: row.id },
        displayName: row.name?.trim() || "Employee",
        status: row.status === "active" ? "active" : "suspended",
        description: row.role,
      })),
      ...teamRows.map((row): PartyCandidate => ({
        ref: { partyType: "team", partyId: row.id },
        displayName: row.name,
        status: row.active ? "active" : "inactive",
        description: row.description,
      })),
      ...locationRows.map((row): PartyCandidate => ({
        ref: { partyType: "location", partyId: row.id },
        displayName: row.name,
        status: row.active ? "active" : "inactive",
        description: row.address,
      })),
      ...organizationRows.map((row): PartyCandidate => ({
        ref: { partyType: "external_organization", partyId: row.id },
        displayName: row.name,
        status: row.active ? "active" : "inactive",
        description: row.kind,
      })),
      ...contactRows.map((row): PartyCandidate => ({
        ref: { partyType: "external_contact", partyId: row.id },
        displayName: row.name,
        status: row.active ? "active" : "inactive",
        description: row.title,
      })),
    ];
  });
}

async function relationshipCandidates(
  tenantId: string,
  query: string,
  context: PartyResolverContext,
  all: PartyCandidate[],
): Promise<PartyCandidate[]> {
  const normalized = normalize(query);
  const requester = context.requesterEmployeeId;
  if (requester && /^my (manager|backup|assistant|reports)$/.test(normalized)) {
    const relationship = normalized.slice(3);
    const ids = await withTenant(tenantId, async (db) => {
      if (relationship === "reports") {
        return (await db.select({ id: employeeRelationships.subjectEmployeeId }).from(employeeRelationships).where(and(
          eq(employeeRelationships.tenantId, tenantId),
          eq(employeeRelationships.relatedEmployeeId, requester),
          eq(employeeRelationships.relationshipType, "manager"),
          eq(employeeRelationships.active, true),
        ))).map((row) => row.id);
      }
      return (await db.select({ id: employeeRelationships.relatedEmployeeId }).from(employeeRelationships).where(and(
        eq(employeeRelationships.tenantId, tenantId),
        eq(employeeRelationships.subjectEmployeeId, requester),
        eq(employeeRelationships.relationshipType, relationship as "manager" | "backup" | "assistant"),
        eq(employeeRelationships.active, true),
      ))).map((row) => row.id);
    });
    return all.filter((row) => row.ref.partyType === "employee" && ids.includes(row.ref.partyId));
  }
  if (requester && normalized === "my team") {
    const ids = await withTenant(tenantId, async (db) =>
      (await db.select({ id: orgUnitMemberships.orgUnitId }).from(orgUnitMemberships).where(and(
        eq(orgUnitMemberships.tenantId, tenantId),
        eq(orgUnitMemberships.employeeId, requester),
        eq(orgUnitMemberships.active, true),
      ))).map((row) => row.id),
    );
    return all.filter((row) => row.ref.partyType === "team" && ids.includes(row.ref.partyId));
  }
  return [];
}

async function workCandidates(
  tenantId: string,
  workId: string | undefined,
  all: PartyCandidate[],
): Promise<PartyCandidate[]> {
  if (!workId) return [];
  const refs = await withTenant(tenantId, async (db) => {
    const [work] = await db.select({ assignedTo: works.assignedTo }).from(works)
      .where(and(eq(works.tenantId, tenantId), eq(works.id, workId))).limit(1);
    const links = await db.select({ entityType: workEntityLinks.entityType, entityId: workEntityLinks.entityId })
      .from(workEntityLinks).where(and(eq(workEntityLinks.tenantId, tenantId), eq(workEntityLinks.workId, workId)));
    return [
      ...(work?.assignedTo ? [{ partyType: "employee" as const, partyId: work.assignedTo }] : []),
      ...links.flatMap((link): PartyRef[] => {
        if (link.entityType === "user") return [{ partyType: "employee", partyId: link.entityId }];
        if (link.entityType === "org_unit") return [{ partyType: "team", partyId: link.entityId }];
        if (link.entityType === "tenant_location") return [{ partyType: "location", partyId: link.entityId }];
        if (link.entityType === "external_organization") return [{ partyType: "external_organization", partyId: link.entityId }];
        if (link.entityType === "external_contact") return [{ partyType: "external_contact", partyId: link.entityId }];
        return [];
      }),
    ];
  });
  const wanted = new Set(refs.map(key));
  return all.filter((row) => wanted.has(key(row.ref)));
}

/** Resolve only active Core PartyRefs. A forged historical party type is refused
 * before any table is queried. */
export async function resolveParty(
  tenantId: string,
  input: PartyResolverInput,
  context: PartyResolverContext = {},
): Promise<PartyResolution> {
  if (!tenantId.trim()) throw new Error("tenantId is required from authenticated context");
  const unsupportedInputFields = Object.keys(input).filter((field) => !["ref", "query", "partyId"].includes(field));
  if (unsupportedInputFields.length) throw new Error(`Party resolver contains unsupported fields: ${unsupportedInputFields.join(", ")}`);
  if (input.ref) {
    const unsupportedRefFields = Object.keys(input.ref).filter((field) => !["partyType", "partyId"].includes(field));
    if (unsupportedRefFields.length) throw new Error(`PartyRef contains unsupported fields: ${unsupportedRefFields.join(", ")}`);
  }
  if (input.ref && (isRetiredWaterParty(input.ref.partyType) || !PARTY_TYPE_SET.has(input.ref.partyType))) {
    throw new Error("Party type is unavailable in the active runtime");
  }
  const all = await directory(tenantId);
  const query = input.query?.trim() || null;
  if (input.ref) return finish(query, "explicit_ref", all.filter((row) => key(row.ref) === key(input.ref!)));
  if (input.partyId) return finish(query, "explicit_ref", all.filter((row) => row.ref.partyId === input.partyId));
  if (!query) return { status: "not_found", method: null, query: null, party: null, candidates: [] };

  const relationship = await relationshipCandidates(tenantId, query, context, all);
  if (relationship.length > 0) return finish(query, "relationship", relationship);
  if (normalize(query) === "this work" || normalize(query) === "current work") {
    return finish(query, "work_context", await workCandidates(tenantId, context.workId, all));
  }

  const normalized = normalize(query);
  const aliases = await withTenant(tenantId, async (db) =>
    db.select({ partyType: partyAliases.partyType, partyId: partyAliases.partyId })
      .from(partyAliases).where(and(
        eq(partyAliases.tenantId, tenantId),
        eq(partyAliases.normalizedAlias, normalized),
        eq(partyAliases.active, true),
      )).limit(DIRECTORY_CAP),
  );
  const activeAliasRefs = new Set(aliases
    .filter((row) => PARTY_TYPE_SET.has(row.partyType) && !isRetiredWaterParty(row.partyType))
    .map((row) => `${row.partyType}:${row.partyId}`));
  if (activeAliasRefs.size > 0) return finish(query, "alias", all.filter((row) => activeAliasRefs.has(key(row.ref))));

  const exact = all.filter((row) => normalize(row.displayName) === normalized);
  if (exact.length > 0) return finish(query, "exact_name", exact);
  const fuzzy = all.filter((row) => {
    const name = normalize(row.displayName);
    return normalized.length >= 3 && (name.includes(normalized) || normalized.includes(name));
  });
  return finish(query, "fuzzy", fuzzy);
}

export function isActivePartyType(value: string): value is PartyType {
  return PARTY_TYPE_SET.has(value) && !isRetiredWaterParty(value);
}
