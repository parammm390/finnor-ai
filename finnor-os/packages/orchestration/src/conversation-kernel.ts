import {
  appendEmployeeConversationMessage,
  appointments,
  contacts,
  createEmployeeConversationThread,
  employeeConversationThreads,
  externalContacts,
  externalOrganizations,
  households,
  invoices,
  leads,
  listEmployeePersonalMemories,
  loadEmployeeConversationThread,
  proposals,
  quotes,
  rememberExplicitEmployeeMemory,
  searchEmployeeConversationMessages,
  updateEmployeeConversationMessageContext,
  updateEmployeeConversationThreadContext,
  users,
  withTenant,
  works,
} from "@finnor/db";
import { listAvailableIdentityAccess } from "@finnor/security";
import { mirrorConversationMessageToZep, queryConsolidatedFacts } from "@finnor/memory";
import type {
  CanonicalEntityType,
  ConversationReference,
  ConversationReferenceResolution,
  ConversationResolutionProvenance,
  EmployeeConversationChannel,
  EmployeeConversationContext,
  EmployeeConversationMessage,
  EmployeePersonalMemory,
  TenantContext,
} from "@finnor/shared-types";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSEQUENTIAL = /\b(?:email|call|text|contact|message|send|move|reschedule|schedule|book|create|update|delete|remove|void|pay|charge|notify|continue|finish|repeat|do\s+that)\b/i;
const PERSON_PRONOUN = /\b(?:him|her|them|that customer|that contact|that lead|that person)\b/i;
const OBJECT_PRONOUN = /\bit\b/i;
const CONTINUATION = /\b(?:continue(?:\s+that)?|do\s+that\s+again|finish\s+what\s+we\s+started|repeat\s+that)\b/i;
const REFERENCE_NOUNS: Array<[RegExp, CanonicalEntityType]> = [
  [/\b(?:that|the|this)\s+invoice\b/i, "invoice"],
  [/\b(?:that|the|this)\s+(?:appointment|booking)\b/i, "appointment"],
  [/\b(?:that|the|this)\s+quote\b/i, "quote"],
  [/\b(?:that|the|this)\s+proposal\b/i, "proposal"],
  [/\b(?:that|the|this)\s+work\b/i, "work"],
];
const PARTY_TYPES = new Set<CanonicalEntityType>(["household", "contact", "lead", "external_contact", "user"]);

interface CatalogEntry {
  entityType: CanonicalEntityType;
  entityId: string;
  label: string;
  aliases: string[];
  status?: string;
  householdId?: string | null;
  organizationId?: string | null;
  organizationName?: string | null;
  leadId?: string | null;
}

type NamedExpressionCue = "party" | "appointment" | "invoice" | "quote" | "proposal" | "history";
interface NamedExpression {
  name: string;
  organization?: string;
  cue: NamedExpressionCue;
  index: number;
}

interface ReferenceGroup {
  expression: string;
  kind: string;
  candidates: ConversationReference[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}@._]+/gu, " ").trim().replace(/\s+/g, " ");
}

function refKey(ref: { entityType: string; entityId: string }): string {
  return `${ref.entityType}:${ref.entityId}`;
}

function source(
  stage: ConversationResolutionProvenance["stage"],
  sourceName: string,
  result: ConversationResolutionProvenance["result"],
  ref?: string,
  reason?: string,
): ConversationResolutionProvenance {
  return { stage, source: sourceName, result, ...(ref ? { ref } : {}), ...(reason ? { reason } : {}), asOf: new Date().toISOString() };
}

export async function resolveCanonicalHumanPrincipal(ctx: TenantContext): Promise<string> {
  const candidate = ctx.employeeId ?? (UUID.test(ctx.userId) ? ctx.userId : null);
  if (!candidate || ctx.userId.startsWith("system:")) throw new Error("canonical_human_principal_required");
  const valid = await withTenant(ctx.tenantId, async (db) => {
    const [row] = await db.select({ id: users.id }).from(users).where(and(
      eq(users.tenantId, ctx.tenantId),
      eq(users.id, candidate),
      eq(users.status, "active"),
    )).limit(1);
    return row?.id ?? null;
  }, candidate);
  if (!valid) throw new Error("canonical_human_principal_not_active");
  return valid;
}

export function extractNamedExpressions(instruction: string): NamedExpression[] {
  const found: NamedExpression[] = [];
  const add = (name: string | undefined, organization: string | undefined, cue: NamedExpressionCue, index: number) => {
    const clean = name?.replace(/\s+/g, " ").trim().replace(/[.,!?]+$/, "").replace(/^the\s+/i, "");
    if (!clean || clean.length < 2) return;
    if (/^(?:the|this|that|my|our|him|her|them|it)$/i.test(clean)) return;
    if (/^(?:email|call|text|contact|message|notify|move|moving|reschedule|schedule|book|send|when|while|before|after|with|from|the)\b/i.test(clean)) return;
    const cleanOrganization = organization?.trim().replace(/[.,!?]+$/, "");
    const existing = found.find((item) => normalized(item.name) === normalized(clean) && normalized(item.organization ?? "") === normalized(cleanOrganization ?? ""));
    if (existing) {
      // A target-specific cue is more informative than the generic party cue,
      // while the earliest mention remains the stable ordering key.
      if (existing.cue === "party" && cue !== "party") existing.cue = cue;
      existing.index = Math.min(existing.index, index);
      return;
    }
    found.push({ name: clean, cue, index, ...(cleanOrganization ? { organization: cleanOrganization } : {}) });
  };
  const name = "([\\p{L}][\\p{L}'-]+(?:\\s+[\\p{L}][\\p{L}'-]+){0,2}?)";
  const boundary = "(?=\\s+(?:the|an?|this|that|from|we|to|on|about|regarding|and|use|then|during|when|while|before|after)\\b|[,.!?]|$)";
  const organizationBoundary = "(?=[,.!?]|\\s+(?:the|an?|this|that|we|to|and|use|then|during|when|while|before|after)\\b|$)";
  // Keep introductory prose ("I spoke with ...", "we discussed ...") out of
  // the captured party name, and retain the organization as a disambiguator.
  for (const match of instruction.matchAll(new RegExp(`\\b(?:spoke\\s+with|talked\\s+(?:to|with)|met\\s+with|heard\\s+from)\\s+${name}\\s+from\\s+([\\p{L}][\\p{L}\\d&.' -]{1,80}?)${organizationBoundary}`, "giu"))) add(match[1], match[2], "party", match.index ?? 0);
  for (const match of instruction.matchAll(new RegExp(`\\bdiscussed\\s+${name}\\s+from\\s+([\\p{L}][\\p{L}\\d&.' -]{1,80}?)${organizationBoundary}`, "giu"))) add(match[1], match[2], "history", match.index ?? 0);
  for (const match of instruction.matchAll(new RegExp(`\\b(?:email|call|text|contact|message|notify)\\s+(?:the\\s+)?${name}\\s+from\\s+([\\p{L}][\\p{L}\\d&.' -]{1,80}?)${organizationBoundary}`, "giu"))) add(match[1], match[2], "party", match.index ?? 0);
  for (const match of instruction.matchAll(new RegExp(`\\b(?:email|call|text|contact|message|notify)\\s+(?:the\\s+)?${name}(?!\\s+from\\b)${boundary}`, "giu"))) add(match[1], undefined, "party", match.index ?? 0);
  for (const match of instruction.matchAll(/\b(?:move|moving|reschedule|schedule|book)\s+(?:the\s+)?([\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+){0,1}?)(?=\s+(?:appointment|booking|to|on|for)\b|[,.!?]|$)/giu)) add(match[1], undefined, "appointment", match.index ?? 0);
  for (const match of instruction.matchAll(/\b(?:the\s+)?([\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+)?)\s+(appointment|invoice|quote|proposal|account)\b/giu)) {
    const noun = match[2]?.toLocaleLowerCase();
    add(match[1], undefined, noun === "account" ? "party" : noun as NamedExpressionCue, match.index ?? 0);
  }
  for (const match of instruction.matchAll(new RegExp(`\\b(?:email|call|text|contact|message|notify)\\s+(?:the\\s+)?${name}\\s+(?:we\\s+discussed|we\\s+talked\\s+about)\\b`, "giu"))) add(match[1], undefined, "history", match.index ?? 0);
  return found.sort((left, right) => left.index - right.index).slice(0, 5);
}

function labelMatches(entry: CatalogEntry, expression: { name: string; organization?: string }): boolean {
  const needle = normalized(expression.name);
  const tokens = needle.split(" ");
  const aliases = [entry.label, ...entry.aliases].map(normalized);
  const nameMatch = aliases.some((alias) => alias === needle || alias.endsWith(` ${needle}`) || (tokens.length === 1 && alias.split(" ").includes(needle)));
  if (!nameMatch) return false;
  if (!expression.organization) return true;
  return normalized(entry.organizationName ?? "") === normalized(expression.organization)
    || normalized(entry.organizationName ?? "").includes(normalized(expression.organization));
}

interface CatalogLookupRef {
  entityType: CanonicalEntityType;
  entityId: string;
}

const CATALOG_ENTITY_TYPES = new Set<CanonicalEntityType>([
  "household",
  "contact",
  "lead",
  "user",
  "external_organization",
  "external_contact",
  "appointment",
  "invoice",
  "quote",
  "proposal",
]);

function catalogLookupRefs(values: unknown[]): CatalogLookupRef[] {
  const refs = values.flatMap((candidate) => {
    const value = object(candidate);
    const entityType = typeof value.entityType === "string" ? value.entityType as CanonicalEntityType : null;
    const entityId = typeof value.entityId === "string" ? value.entityId : null;
    return entityType && entityId && UUID.test(entityId) && CATALOG_ENTITY_TYPES.has(entityType)
      ? [{ entityType, entityId }]
      : [];
  });
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}

function resolutionSnapshotRefs(messages: EmployeeConversationMessage[]): CatalogLookupRef[] {
  return catalogLookupRefs(messages.flatMap((message) => {
    const snapshot = object(message.resolutionSnapshot);
    return Array.isArray(snapshot.resolvedReferences) ? snapshot.resolvedReferences : [];
  }));
}

function normalizedText(column: SQL): SQL {
  return sql`lower(regexp_replace(coalesce(${column}, ''), '[^[:alnum:]@._]+', ' ', 'g'))`;
}

function expressionPredicate(fields: SQL[], expressions: NamedExpression[]): SQL | undefined {
  const predicates = expressions.flatMap((expression) => {
    const needle = normalized(expression.name);
    if (!needle) return [];
    const oneToken = !needle.includes(" ");
    return fields.map((field) => sql`(
      ${field} = ${needle}
      OR ${field} LIKE ${`% ${needle}`}
      OR (${oneToken} AND (' ' || ${field} || ' ') LIKE ${`% ${needle} %`})
    )`);
  });
  return predicates.length > 0 ? or(...predicates) : undefined;
}

function idsFor(refs: CatalogLookupRef[], entityType: CanonicalEntityType): string[] {
  return refs.filter((ref) => ref.entityType === entityType).map((ref) => ref.entityId);
}

async function loadCanonicalCatalog(
  tenantId: string,
  ownerEmployeeId: string,
  expressions: NamedExpression[],
  exactRefs: CatalogLookupRef[],
): Promise<CatalogEntry[]> {
  return withTenant(tenantId, async (db) => {
    // Drizzle shares a single pg client inside withTenant. Keep these request-scoped
    // queries ordered so pg never receives concurrent operations on that client.
    const householdIds = idsFor(exactRefs, "household");
    const householdMatch = expressionPredicate([
      normalizedText(sql`${households.contactInfo}->>'name'`),
      normalizedText(sql`${households.address}`),
    ], expressions);
    const householdWhere = or(
      householdIds.length > 0 ? inArray(households.id, householdIds) : undefined,
      householdMatch,
    );
    const householdRows = householdWhere ? await db
      .select({ id: households.id, contactInfo: households.contactInfo, address: households.address })
      .from(households)
      .where(and(eq(households.tenantId, tenantId), householdWhere)) : [];

    const contactIds = idsFor(exactRefs, "contact");
    const contactMatch = expressionPredicate([
      normalizedText(sql`${contacts.name}`),
      normalizedText(sql`${contacts.firstName}`),
      normalizedText(sql`${contacts.lastName}`),
    ], expressions);
    const contactWhere = or(
      contactIds.length > 0 ? inArray(contacts.id, contactIds) : undefined,
      contactMatch,
    );
    const contactRows = contactWhere ? await db
      .select({ id: contacts.id, householdId: contacts.householdId, name: contacts.name, firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), isNull(contacts.archivedAt), contactWhere)) : [];

    const leadIds = idsFor(exactRefs, "lead");
    const leadMatch = expressionPredicate([normalizedText(sql`${leads.name}`), normalizedText(sql`${leads.email}`)], expressions);
    const leadWhere = or(leadIds.length > 0 ? inArray(leads.id, leadIds) : undefined, leadMatch);
    const leadRows = leadWhere ? await db
      .select({ id: leads.id, householdId: leads.householdId, name: leads.name, email: leads.email })
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), isNull(leads.archivedAt), leadWhere)) : [];

    const userIds = idsFor(exactRefs, "user");
    const userMatch = expressionPredicate([normalizedText(sql`${users.displayName}`), normalizedText(sql`${users.email}`)], expressions);
    const userWhere = or(userIds.length > 0 ? inArray(users.id, userIds) : undefined, userMatch);
    const userRows = userWhere ? await db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.status, "active"), userWhere)) : [];

    const externalContactIds = idsFor(exactRefs, "external_contact");
    const externalMatch = expressionPredicate([normalizedText(sql`${externalContacts.name}`)], expressions);
    const externalWhere = or(
      externalContactIds.length > 0 ? inArray(externalContacts.id, externalContactIds) : undefined,
      externalMatch,
    );
    const externalRows = externalWhere ? await db
      .select({ id: externalContacts.id, name: externalContacts.name, organizationId: externalContacts.externalOrganizationId })
      .from(externalContacts)
      .where(and(eq(externalContacts.tenantId, tenantId), eq(externalContacts.active, true), externalWhere)) : [];

    const organizationIds = [...new Set([
      ...idsFor(exactRefs, "external_organization"),
      ...externalRows.flatMap((row) => row.organizationId ? [row.organizationId] : []),
    ])];
    const organizationMatch = expressionPredicate([normalizedText(sql`${externalOrganizations.name}`)], expressions);
    const organizationWhere = or(
      organizationIds.length > 0 ? inArray(externalOrganizations.id, organizationIds) : undefined,
      organizationMatch,
    );
    const organizationRows = organizationWhere ? await db
      .select({ id: externalOrganizations.id, name: externalOrganizations.name })
      .from(externalOrganizations)
      .where(and(eq(externalOrganizations.tenantId, tenantId), eq(externalOrganizations.active, true), organizationWhere)) : [];

    const relatedHouseholdIds = [...new Set([
      ...contactRows.flatMap((row) => row.householdId ? [row.householdId] : []),
      ...leadRows.flatMap((row) => row.householdId ? [row.householdId] : []),
    ])];
    const loadedHouseholdIds = new Set(householdRows.map((row) => row.id));
    const missingHouseholdIds = relatedHouseholdIds.filter((id) => !loadedHouseholdIds.has(id));
    if (missingHouseholdIds.length > 0) {
      householdRows.push(...await db
        .select({ id: households.id, contactInfo: households.contactInfo, address: households.address })
        .from(households)
        .where(and(eq(households.tenantId, tenantId), inArray(households.id, missingHouseholdIds))));
    }

    const catalog: CatalogEntry[] = [];
    const householdLabels = new Map<string, string>();
    for (const row of householdRows) {
      const info = object(row.contactInfo);
      const label = typeof info.name === "string" && info.name.trim() ? info.name.trim() : row.address;
      householdLabels.set(row.id, label);
      catalog.push({ entityType: "household", entityId: row.id, label, aliases: [row.address] });
    }
    for (const row of contactRows) {
      if (row.householdId) {
        catalog.push({ entityType: "household", entityId: row.householdId, label: row.name, aliases: [householdLabels.get(row.householdId) ?? "", row.firstName ?? "", row.lastName ?? ""], householdId: row.householdId });
      } else {
        catalog.push({ entityType: "contact", entityId: row.id, label: row.name, aliases: [row.firstName ?? "", row.lastName ?? ""] });
      }
      if (contactIds.includes(row.id) && row.householdId) catalog.push({ entityType: "contact", entityId: row.id, label: row.name, aliases: [row.firstName ?? "", row.lastName ?? ""], householdId: row.householdId });
    }
    for (const row of leadRows) {
      if (row.householdId) catalog.push({ entityType: "household", entityId: row.householdId, label: row.name, aliases: [householdLabels.get(row.householdId) ?? "", row.email ?? ""], householdId: row.householdId });
      else catalog.push({ entityType: "lead", entityId: row.id, label: row.name, aliases: [row.email ?? ""], householdId: row.householdId });
      if (leadIds.includes(row.id) && row.householdId) catalog.push({ entityType: "lead", entityId: row.id, label: row.name, aliases: [row.email ?? ""], householdId: row.householdId });
    }
    for (const row of userRows) catalog.push({ entityType: "user", entityId: row.id, label: row.displayName?.trim() || row.email, aliases: [row.email] });
    const orgNames = new Map(organizationRows.map((row) => [row.id, row.name]));
    for (const row of organizationRows) catalog.push({ entityType: "external_organization", entityId: row.id, label: row.name, aliases: [] });
    for (const row of externalRows) catalog.push({ entityType: "external_contact", entityId: row.id, label: row.name, aliases: [], organizationId: row.organizationId, organizationName: row.organizationId ? orgNames.get(row.organizationId) ?? null : null });

    const objectExpressions = new Set(expressions.filter((expression) => ["appointment", "invoice", "quote", "proposal"].includes(expression.cue)).map((expression) => expression.cue));
    const matchedParties = catalog.filter((entry) => PARTY_TYPES.has(entry.entityType) && expressions.some((expression) => labelMatches(entry, expression)));
    const matchedHouseholdIds = new Set(matchedParties.flatMap((entry) => entry.entityType === "household" ? [entry.entityId] : entry.householdId ? [entry.householdId] : []));
    const matchedLeadIds = new Set(matchedParties.filter((entry) => entry.entityType === "lead").map((entry) => entry.entityId));
    const matchedSubjectIds = new Set([
      ...matchedParties.map((entry) => entry.entityId),
      ...contactRows.filter((row) => expressions.some((expression) => labelMatches({ entityType: "contact", entityId: row.id, label: row.name, aliases: [row.firstName ?? "", row.lastName ?? ""] }, expression))).map((row) => row.id),
      ...leadRows.filter((row) => expressions.some((expression) => labelMatches({ entityType: "lead", entityId: row.id, label: row.name, aliases: [row.email ?? ""] }, expression))).map((row) => row.id),
    ]);

    const appointmentIds = idsFor(exactRefs, "appointment");
    const appointmentWhere = or(
      appointmentIds.length > 0 ? inArray(appointments.id, appointmentIds) : undefined,
      objectExpressions.has("appointment") && matchedSubjectIds.size > 0 ? inArray(appointments.subjectId, [...matchedSubjectIds]) : undefined,
    );
    const appointmentRows = appointmentWhere ? await db
      .select({ id: appointments.id, subjectType: appointments.subjectType, subjectId: appointments.subjectId, status: appointments.status, scheduledAt: appointments.scheduledAt })
      .from(appointments)
      .where(and(eq(appointments.tenantId, tenantId), inArray(appointments.status, ["hold", "confirmed"]), isNull(appointments.archivedAt), appointmentWhere)) : [];

    const invoiceIds = idsFor(exactRefs, "invoice");
    const invoiceWhere = or(
      invoiceIds.length > 0 ? inArray(invoices.id, invoiceIds) : undefined,
      objectExpressions.has("invoice") && matchedHouseholdIds.size > 0 ? inArray(invoices.householdId, [...matchedHouseholdIds]) : undefined,
    );
    const invoiceRows = invoiceWhere ? await db
      .select({ id: invoices.id, householdId: invoices.householdId, status: invoices.status, memo: invoices.memo })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), invoiceWhere)) : [];

    const quoteIds = idsFor(exactRefs, "quote");
    const quoteWhere = or(
      quoteIds.length > 0 ? inArray(quotes.id, quoteIds) : undefined,
      objectExpressions.has("quote") && matchedHouseholdIds.size > 0 ? inArray(quotes.householdId, [...matchedHouseholdIds]) : undefined,
      objectExpressions.has("quote") && matchedLeadIds.size > 0 ? inArray(quotes.leadId, [...matchedLeadIds]) : undefined,
    );
    const quoteRows = quoteWhere ? await db
      .select({ id: quotes.id, householdId: quotes.householdId, leadId: quotes.leadId, status: quotes.status })
      .from(quotes)
      .where(and(eq(quotes.tenantId, tenantId), isNull(quotes.archivedAt), quoteWhere)) : [];

    const proposalIds = idsFor(exactRefs, "proposal");
    const proposalWhere = or(
      proposalIds.length > 0 ? inArray(proposals.id, proposalIds) : undefined,
      objectExpressions.has("proposal") && matchedHouseholdIds.size > 0 ? inArray(proposals.householdId, [...matchedHouseholdIds]) : undefined,
    );
    const proposalRows = proposalWhere ? await db
      .select({ id: proposals.id, householdId: proposals.householdId, content: proposals.content, status: proposals.status })
      .from(proposals)
      .where(and(eq(proposals.tenantId, tenantId), proposalWhere)) : [];

    const objectHouseholdIds = [...new Set([
      ...invoiceRows.map((row) => row.householdId),
      ...quoteRows.flatMap((row) => row.householdId ? [row.householdId] : []),
      ...proposalRows.map((row) => row.householdId),
      ...appointmentRows.flatMap((row) => row.subjectType === "household" ? [row.subjectId] : []),
    ])].filter((id) => !householdLabels.has(id));
    if (objectHouseholdIds.length > 0) {
      const rows = await db
        .select({ id: households.id, contactInfo: households.contactInfo, address: households.address })
        .from(households)
        .where(and(eq(households.tenantId, tenantId), inArray(households.id, objectHouseholdIds)));
      for (const row of rows) {
        const info = object(row.contactInfo);
        const label = typeof info.name === "string" && info.name.trim() ? info.name.trim() : row.address;
        householdLabels.set(row.id, label);
        catalog.push({ entityType: "household", entityId: row.id, label, aliases: [row.address] });
      }
    }
    for (const row of appointmentRows) {
      const subject = catalog.find((item) => item.entityType === row.subjectType && item.entityId === row.subjectId);
      catalog.push({ entityType: "appointment", entityId: row.id, label: `${subject?.label ?? row.subjectType} appointment`, aliases: [row.scheduledAt.toISOString()], status: row.status, householdId: row.subjectType === "household" ? row.subjectId : subject?.householdId });
    }
    for (const row of invoiceRows) catalog.push({ entityType: "invoice", entityId: row.id, label: `${householdLabels.get(row.householdId) ?? "Customer"} invoice`, aliases: [row.memo ?? ""], status: row.status, householdId: row.householdId });
    for (const row of quoteRows) catalog.push({ entityType: "quote", entityId: row.id, label: `${row.householdId ? householdLabels.get(row.householdId) ?? "Customer" : "Lead"} quote`, aliases: [], status: row.status, householdId: row.householdId, leadId: row.leadId });
    for (const row of proposalRows) {
      const content = object(row.content);
      const title = typeof content.title === "string" && content.title.trim() ? content.title.trim() : "proposal";
      catalog.push({ entityType: "proposal", entityId: row.id, label: `${householdLabels.get(row.householdId) ?? "Customer"} ${title}`, aliases: [title], status: row.status, householdId: row.householdId });
    }
    return catalog;
  }, ownerEmployeeId);
}

function dedupeCatalog(entries: CatalogEntry[]): CatalogEntry[] {
  const map = new Map<string, CatalogEntry>();
  for (const entry of entries) if (!map.has(refKey(entry))) map.set(refKey(entry), entry);
  return [...map.values()];
}

function conversationRef(entry: CatalogEntry, sourceKind: ConversationReference["source"], messageId?: string, sequence?: number): ConversationReference {
  return {
    entityType: entry.entityType,
    entityId: entry.entityId,
    label: entry.label,
    source: sourceKind,
    ...(messageId ? { sourceMessageId: messageId } : {}),
    ...(sequence ? { mentionedAtSequence: sequence } : {}),
    currentTruthAsOf: new Date().toISOString(),
  };
}

function referencesFromMessage(message: EmployeeConversationMessage, catalog: Map<string, CatalogEntry>): ConversationReference[] {
  const snapshot = object(message.resolutionSnapshot);
  const rows = Array.isArray(snapshot.resolvedReferences) ? snapshot.resolvedReferences : [];
  return rows.flatMap((candidate) => {
    const value = object(candidate);
    const key = `${String(value.entityType)}:${String(value.entityId)}`;
    const current = catalog.get(key);
    return current ? [conversationRef(current, "history_search", message.id, message.sequence)] : [];
  });
}

function extractExplicitPreference(instruction: string): { subjectKey: string; proposition: string; structuredValue: Record<string, unknown> } | null {
  const directEmail = instruction.match(/\buse\s+([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})\s+(?:from\s+now\s+on|going\s+forward)\b/i);
  if (directEmail?.[1]) return {
    subjectKey: "communication.sender.email:outbound_sales",
    proposition: instruction.trim(),
    structuredValue: { channel: "email", purpose: "sales", selector: directEmail[1].toLowerCase(), explicit: true },
  };
  const namedEmail = instruction.match(/\buse\s+my\s+([\w.-]+)\s+email\s+(?:when|for)\s+([^.!?]+)/i);
  if (namedEmail?.[1] && namedEmail[2]) return {
    subjectKey: "communication.sender.email:outbound_sales",
    proposition: instruction.trim(),
    structuredValue: { channel: "email", purpose: "sales", selector: namedEmail[1].toLowerCase(), condition: namedEmail[2].trim(), explicit: true },
  };
  const remember = instruction.match(/\b(?:remember\s+that\s+)?i\s+(?:prefer|want)\s+([^.!?]+)/i);
  if (remember?.[1]) return {
    subjectKey: `preference:${normalized(remember[1]).slice(0, 120)}`,
    proposition: instruction.trim(),
    structuredValue: { preference: remember[1].trim(), explicit: true },
  };
  return null;
}

async function resolveSenderPreference(params: {
  tenantId: string;
  employeeId: string;
  instruction: string;
  personalMemories: EmployeePersonalMemory[];
  provenance: ConversationResolutionProvenance[];
}): Promise<{ communicationIdentityId: string; channel: "email"; purpose: string } | null | "ambiguous" | "unavailable"> {
  if (!CONSEQUENTIAL.test(params.instruction) || !/\bemail\b/i.test(params.instruction)) return null;
  const preference = params.personalMemories.find((memory) => memory.subjectKey === "communication.sender.email:outbound_sales" && !memory.supersededAt);
  if (!preference) return null;
  const selector = typeof preference.structuredValue.selector === "string" ? normalized(preference.structuredValue.selector) : "";
  const purpose = typeof preference.structuredValue.purpose === "string" ? preference.structuredValue.purpose : "sales";
  const access = await listAvailableIdentityAccess(params.tenantId, params.employeeId);
  const matches = access.communicationIdentities.filter((identity) => {
    if (identity.channel !== "email" || identity.status !== "active") return false;
    const haystack = normalized([identity.key, identity.address ?? "", identity.purpose].join(" "));
    return selector ? haystack.includes(selector) : identity.purpose === purpose;
  });
  if (matches.length === 1) {
    params.provenance.push(source("sender_identity", "current_identity_access", "selected", matches[0]!.id, "remembered selector revalidated against current access"));
    return { communicationIdentityId: matches[0]!.id, channel: "email", purpose };
  }
  params.provenance.push(source("sender_identity", "current_identity_access", matches.length ? "rejected" : "unavailable", undefined, matches.length ? "multiple current identities match remembered selector" : "remembered identity is no longer currently available"));
  return matches.length ? "ambiguous" : "unavailable";
}

function clarification(kind: string, candidates: ConversationReference[]): string {
  if (candidates.length === 0) return `Which ${kind} do you mean? I could not verify a current target.`;
  const labels = [...new Set(candidates.map((candidate) => candidate.label))].slice(0, 5);
  return `Which ${kind} do you mean: ${labels.join(", ")}?`;
}

export interface PreparedEmployeeConversationTurn {
  threadId: string;
  employeeId: string;
  userMessage: EmployeeConversationMessage;
  duplicate: boolean;
  context: EmployeeConversationContext;
}

export async function prepareEmployeeConversationTurn(params: {
  ctx: TenantContext;
  threadId?: string;
  instruction: string;
  instructionId: string;
  idempotencyKey?: string;
  channel: EmployeeConversationChannel;
  transportSessionId?: string;
  originTransportKey?: string;
  activeContext?: { selectedEntities?: Array<{ entityType: CanonicalEntityType; entityId: string }>; focusedEntity?: { entityType: CanonicalEntityType; entityId: string } } | Record<string, unknown>;
}): Promise<PreparedEmployeeConversationTurn> {
  const employeeId = await resolveCanonicalHumanPrincipal(params.ctx);
  const threadSummary = params.threadId
    ? (await loadEmployeeConversationThread({ tenantId: params.ctx.tenantId, ownerEmployeeId: employeeId, threadId: params.threadId, messageLimit: 1 }))?.thread
    : await createEmployeeConversationThread({ tenantId: params.ctx.tenantId, ownerEmployeeId: employeeId, originTransportKey: params.originTransportKey });
  if (!threadSummary) throw new Error("conversation_thread_not_found");
  const appended = await appendEmployeeConversationMessage({
    tenantId: params.ctx.tenantId,
    ownerEmployeeId: employeeId,
    threadId: threadSummary.id,
    role: "user",
    channel: params.channel,
    originalText: params.instruction,
    instructionId: params.instructionId,
    idempotencyKey: `user:${params.idempotencyKey ?? params.instructionId}`,
    transportSessionId: params.transportSessionId,
    transportProvenance: { kind: params.channel === "voice" ? "voice_transport" : "browser_transport", canonical: false },
  });
  await mirrorConversationMessageToZep({
    tenantId: params.ctx.tenantId,
    employeeId,
    threadId: threadSummary.id,
    messageId: appended.message.id,
    role: "user",
    content: params.instruction,
    createdAt: appended.message.createdAt,
  });

  const explicitPreference = extractExplicitPreference(params.instruction);
  if (explicitPreference) {
    await rememberExplicitEmployeeMemory({
      tenantId: params.ctx.tenantId,
      ownerEmployeeId: employeeId,
      sourceThreadId: threadSummary.id,
      sourceMessageId: appended.message.id,
      role: "user",
      memoryType: "preference",
      ...explicitPreference,
      provenance: { extractor: "phase6_explicit_human_rule", originalMessageId: appended.message.id },
    });
  }

  // Resolve these in order. Local/CI pools can be restarted between requests and
  // production intentionally uses a single short-lived session per function.
  const loaded = await loadEmployeeConversationThread({ tenantId: params.ctx.tenantId, ownerEmployeeId: employeeId, threadId: threadSummary.id, messageLimit: 40 });
  const personalMemories = await listEmployeePersonalMemories({ tenantId: params.ctx.tenantId, ownerEmployeeId: employeeId, limit: 50 });
  if (!loaded) throw new Error("conversation_thread_not_found");
  const named = extractNamedExpressions(params.instruction);
  const exactContext = object(params.activeContext);
  let olderRelevantMessages: EmployeeConversationMessage[] = [];
  if (named.length > 0 && /\b(?:discussed|earlier|before|talked about)\b/i.test(params.instruction)) {
    const seen = new Set<string>();
    for (const expression of named) {
      const matches = await searchEmployeeConversationMessages({ tenantId: params.ctx.tenantId, ownerEmployeeId: employeeId, query: expression.name, limit: 20 });
      for (const message of matches) if (!seen.has(message.id)) {
        seen.add(message.id);
        olderRelevantMessages.push(message);
      }
    }
  }
  const rawExplicitRefs = [
    ...(Array.isArray(exactContext.selectedEntities) ? exactContext.selectedEntities : []),
    ...(exactContext.focusedEntity ? [exactContext.focusedEntity] : []),
  ];
  const exactRefs = catalogLookupRefs([
    ...rawExplicitRefs,
    ...loaded.thread.activeReferences,
    ...resolutionSnapshotRefs(olderRelevantMessages),
  ]);
  const catalog = await loadCanonicalCatalog(params.ctx.tenantId, employeeId, named, exactRefs);
  const catalogMap = new Map(dedupeCatalog(catalog).map((entry) => [refKey(entry), entry]));
  const provenance: ConversationResolutionProvenance[] = [];
  const explicitRefs = [
    ...rawExplicitRefs,
  ].flatMap((candidate) => {
    const value = object(candidate);
    const current = catalogMap.get(`${String(value.entityType)}:${String(value.entityId)}`);
    if (!current) return [];
    provenance.push(source("explicit", "operating_interaction_context", "selected", refKey(current)));
    return [conversationRef(current, "explicit_context")];
  });
  const activeRefs = loaded.thread.activeReferences.flatMap((candidate) => {
    const value = object(candidate);
    const current = catalogMap.get(`${String(value.entityType)}:${String(value.entityId)}`);
    if (!current) {
      provenance.push(source("company_twin", "active_thread_reference", "rejected", `${String(value.entityType)}:${String(value.entityId)}`, "no longer current"));
      return [];
    }
    return [conversationRef(current, "thread", typeof value.sourceMessageId === "string" ? value.sourceMessageId : undefined, typeof value.mentionedAtSequence === "number" ? value.mentionedAtSequence : undefined)];
  });
  const historyRefs = [...new Map(
    olderRelevantMessages
      .flatMap((message) => referencesFromMessage(message, catalogMap))
      .map((ref) => [refKey(ref), ref]),
  ).values()];

  const groups: ReferenceGroup[] = [];
  const addGroup = (expression: string, kind: string, refs: ConversationReference[]) => {
    const candidates = [...new Map(refs.map((candidate) => [refKey(candidate), candidate])).values()];
    groups.push({ expression, kind, candidates });
    for (const candidate of candidates) {
      const stage = candidate.source === "thread" ? "thread" : candidate.source === "history_search" ? "history" : candidate.source === "work" ? "work" : candidate.source === "explicit_context" ? "explicit" : "company_twin";
      provenance.push(source(stage, candidate.source, "candidate", refKey(candidate)));
    }
  };
  const partyMatchesFor = (expression: NamedExpression): ConversationReference[] => {
    const historyMatches = (expression.cue === "history" || /\b(?:discussed|earlier|before|talked about)\b/i.test(params.instruction))
      ? historyRefs.filter((ref) => {
        const entry = catalogMap.get(refKey(ref));
        return entry ? PARTY_TYPES.has(entry.entityType) && labelMatches(entry, expression) : false;
      })
      : [];
    if (historyMatches.length > 0) return historyMatches;
    return dedupeCatalog(catalog.filter((entry) => PARTY_TYPES.has(entry.entityType) && labelMatches(entry, expression))).map((entry) => conversationRef(entry, "company_twin"));
  };
  const householdIdsFor = (refs: ConversationReference[]): Set<string> => new Set(refs.flatMap((ref) => {
    const entry = catalogMap.get(refKey(ref));
    return entry?.entityType === "household" ? [entry.entityId] : entry?.householdId ? [entry.householdId] : [];
  }));
  const entityMatchesFor = (type: CanonicalEntityType, parties: ConversationReference[]): ConversationReference[] => {
    const householdIds = householdIdsFor(parties);
    const leadIds = new Set(parties.filter((party) => party.entityType === "lead").map((party) => party.entityId));
    return catalog.filter((entry) => entry.entityType === type && (
      (entry.householdId ? householdIds.has(entry.householdId) : false)
      || (entry.leadId ? leadIds.has(entry.leadId) : false)
    ) && (type !== "invoice" || entry.status !== "void")).map((entry) => conversationRef(entry, "company_twin"));
  };

  let targetKind = "target";
  if (explicitRefs.length > 0) {
    targetKind = "explicit target";
    addGroup("operating interaction context", targetKind, explicitRefs);
  } else {
    if (CONTINUATION.test(params.instruction)) {
      targetKind = "work item";
      const workIds = new Set(loaded.messages.flatMap((message) => message.workId ? [message.workId] : []));
      if (loaded.thread.activeWorkId) workIds.add(loaded.thread.activeWorkId);
      const workRows = workIds.size > 0 ? await withTenant(params.ctx.tenantId, async (db) => db
        .select({ id: works.id, instruction: works.initialInstruction, status: works.status })
        .from(works)
        .where(and(
          eq(works.tenantId, params.ctx.tenantId),
          inArray(works.id, [...workIds]),
          or(eq(works.createdBy, employeeId), eq(works.currentOwnerId, employeeId), eq(works.assignedTo, employeeId)),
        )), employeeId) : [];
      addGroup("continuation", targetKind, workRows.map((work) => ({ entityType: "work", entityId: work.id, label: work.instruction.slice(0, 120), source: "work", currentTruthAsOf: new Date().toISOString() })));
    }

    const namedPartyMatches = new Map<string, ConversationReference[]>();
    for (const expression of named) {
      const parties = partyMatchesFor(expression);
      if (expression.cue === "party" || expression.cue === "history") namedPartyMatches.set(normalized(expression.name), parties);
      const type = expression.cue === "appointment" || expression.cue === "invoice" || expression.cue === "quote" || expression.cue === "proposal" ? expression.cue : null;
      targetKind = type ?? expression.name;
      const directHistoryMatches = type ? historyRefs.filter((ref) => {
        const entry = catalogMap.get(refKey(ref));
        return entry?.entityType === type && labelMatches(entry, expression);
      }) : [];
      addGroup(expression.name, type ?? "person", type ? directHistoryMatches.length > 0 ? directHistoryMatches : entityMatchesFor(type, parties) : parties);
    }

    const nounType = REFERENCE_NOUNS.find(([pattern]) => pattern.test(params.instruction))?.[1];
    if (PERSON_PRONOUN.test(params.instruction)) {
      targetKind = "person";
      const sameTurnParties = [...namedPartyMatches.values()].flat();
      const partyRefs = sameTurnParties.length > 0
        ? sameTurnParties
        : (() => {
          const partyActive = activeRefs.filter((ref) => PARTY_TYPES.has(ref.entityType));
          const maxSequence = Math.max(0, ...partyActive.map((ref) => ref.mentionedAtSequence ?? 0));
          return partyActive.filter((ref) => (ref.mentionedAtSequence ?? 0) === maxSequence);
        })();
      addGroup("person pronoun", targetKind, partyRefs);
    }
    if (OBJECT_PRONOUN.test(params.instruction)) {
      targetKind = nounType?.replace("_", " ") ?? "object";
      const objectRefs = activeRefs.filter((ref) => !PARTY_TYPES.has(ref.entityType) && (!nounType || ref.entityType === nounType));
      const maxSequence = Math.max(0, ...objectRefs.map((ref) => ref.mentionedAtSequence ?? 0));
      addGroup("object pronoun", targetKind, objectRefs.filter((ref) => (ref.mentionedAtSequence ?? 0) === maxSequence));
    }
    if (nounType && named.length === 0 && !OBJECT_PRONOUN.test(params.instruction)) {
      targetKind = nounType.replace("_", " ");
      addGroup(`active ${targetKind}`, targetKind, activeRefs.filter((ref) => ref.entityType === nounType));
    }
  }

  const candidates = [...new Map(groups.flatMap((group) => group.candidates).map((candidate) => [refKey(candidate), candidate])).values()];
  const referenceRequired = groups.length > 0;
  const consequential = CONSEQUENTIAL.test(params.instruction);
  const selected = [...new Map(groups.filter((group) => group.candidates.length === 1).flatMap((group) => group.candidates).map((candidate) => [refKey(candidate), candidate])).values()];
  const sender = await resolveSenderPreference({ tenantId: params.ctx.tenantId, employeeId, instruction: params.instruction, personalMemories, provenance });
  const senderProblem = sender === "ambiguous" || sender === "unavailable";
  const unresolvedGroups = groups.filter((group) => group.candidates.length !== 1);
  const ambiguous = consequential && ((referenceRequired && unresolvedGroups.length > 0) || senderProblem);
  const unresolvedExpressions = ambiguous
    ? [...unresolvedGroups.map((group) => group.expression), ...(senderProblem ? ["remembered sender identity"] : [])]
    : [];
  const resolution: ConversationReferenceResolution = {
    status: ambiguous ? "clarification_required" : selected.length ? "resolved" : "none",
    originalInstruction: params.instruction,
    resolvedReferences: selected,
    candidates,
    unresolvedExpressions,
    clarificationQuestion: ambiguous
      ? senderProblem
        ? sender === "unavailable"
          ? "Your remembered email sender is no longer available. Which currently connected sender should I use?"
          : "More than one current email sender matches your preference. Which sender should I use?"
        : clarification(unresolvedGroups.flatMap((group) => group.candidates).length > 0 ? unresolvedGroups[0]!.kind : targetKind, unresolvedGroups.flatMap((group) => group.candidates))
      : null,
    consequential,
    senderIdentityRef: sender && sender !== "ambiguous" && sender !== "unavailable" ? sender : null,
    provenance,
  };
  const truthSnapshot = {
    asOf: new Date().toISOString(),
    source: "current_company_twin",
    references: [...candidates, ...selected].map((ref) => {
      const entry = catalogMap.get(refKey(ref));
      return { entityType: ref.entityType, entityId: ref.entityId, label: ref.label, status: entry?.status ?? null };
    }),
  };
  await updateEmployeeConversationMessageContext({
    tenantId: params.ctx.tenantId,
    ownerEmployeeId: employeeId,
    threadId: threadSummary.id,
    messageId: appended.message.id,
    resolutionSnapshot: resolution as unknown as Record<string, unknown>,
    resolutionProvenance: provenance as unknown as Array<Record<string, unknown>>,
    companyTruthSnapshot: truthSnapshot,
  });
  const existing = activeRefs.map((ref) => ({ ...ref }));
  const mergedRefs = [...selected.map((ref) => ({ ...ref, sourceMessageId: appended.message.id, mentionedAtSequence: appended.message.sequence })), ...existing]
    .filter((ref, index, all) => all.findIndex((other) => refKey(other) === refKey(ref)) === index)
    .slice(0, 100);
  const summaryCandidates = loaded.messages.filter((message) => message.sequence <= appended.message.sequence - 20).slice(-20);
  const shouldRollSummary = summaryCandidates.length > 0 && appended.message.sequence - loaded.thread.summaryThroughSequence >= 20;
  await updateEmployeeConversationThreadContext({
    tenantId: params.ctx.tenantId,
    ownerEmployeeId: employeeId,
    threadId: threadSummary.id,
    activeReferences: mergedRefs as unknown as Array<Record<string, unknown>>,
    unresolvedReferences: unresolvedExpressions.map((expression) => ({ expression, messageId: appended.message.id, sequence: appended.message.sequence })),
    ...(shouldRollSummary ? {
      summary: summaryCandidates.map((message) => `[${message.sequence} ${message.role}] ${message.originalText.slice(0, 500)}`).join("\n").slice(0, 65_536),
      summaryThroughSequence: summaryCandidates.at(-1)!.sequence,
    } : {}),
  });
  const zepHits = await queryConsolidatedFacts(params.ctx.tenantId, employeeId, params.instruction, 5);
  const refreshed = await loadEmployeeConversationThread({ tenantId: params.ctx.tenantId, ownerEmployeeId: employeeId, threadId: threadSummary.id, messageLimit: 30 });
  if (!refreshed) throw new Error("conversation_thread_not_found");
  return {
    threadId: threadSummary.id,
    employeeId,
    userMessage: { ...appended.message, resolutionSnapshot: resolution as unknown as Record<string, unknown>, resolutionProvenance: provenance as unknown as Array<Record<string, unknown>>, companyTruthSnapshot: truthSnapshot },
    duplicate: appended.duplicate,
    context: {
      version: 1,
      ownerEmployeeId: employeeId,
      thread: refreshed.thread,
      exactRecentMessages: refreshed.messages,
      summary: refreshed.thread.summary ? { text: refreshed.thread.summary, throughSequence: refreshed.thread.summaryThroughSequence } : null,
      olderRelevantMessages,
      personalMemories,
      zepFacts: zepHits.map((hit) => ({ fact: hit.chunk, source: "zep_employee_graph", ...(hit.occurredAt ? { createdAt: hit.occurredAt } : {}) })),
      resolution,
    },
  };
}

export async function linkEmployeeConversationTurnToWork(params: {
  tenantId: string;
  employeeId: string;
  threadId: string;
  userMessageId: string;
  workId: string;
  workInputId?: string;
  objectiveLoopId?: string;
}): Promise<void> {
  await updateEmployeeConversationMessageContext({ tenantId: params.tenantId, ownerEmployeeId: params.employeeId, threadId: params.threadId, messageId: params.userMessageId, workId: params.workId, ...(params.workInputId ? { workInputId: params.workInputId } : {}) });
  await updateEmployeeConversationThreadContext({ tenantId: params.tenantId, ownerEmployeeId: params.employeeId, threadId: params.threadId, activeWorkId: params.workId, ...(params.objectiveLoopId ? { activeObjectiveLoopId: params.objectiveLoopId } : {}) });
}

export async function persistEmployeeAssistantTurn(params: {
  tenantId: string;
  employeeId: string;
  threadId: string;
  instructionId: string;
  channel: EmployeeConversationChannel;
  text: string;
  workId?: string;
  workInputId?: string;
  outcomeRefs: Array<Record<string, unknown>>;
}): Promise<EmployeeConversationMessage> {
  const appended = await appendEmployeeConversationMessage({
    tenantId: params.tenantId,
    ownerEmployeeId: params.employeeId,
    threadId: params.threadId,
    role: "assistant",
    channel: params.channel,
    originalText: params.text,
    instructionId: params.instructionId,
    workId: params.workId,
    workInputId: params.workInputId,
    idempotencyKey: `assistant:${params.instructionId}`,
    outcomeRefs: params.outcomeRefs,
    transportProvenance: { kind: "assistant_response", canonical: true },
  });
  await updateEmployeeConversationThreadContext({ tenantId: params.tenantId, ownerEmployeeId: params.employeeId, threadId: params.threadId, ...(params.workId ? { activeWorkId: params.workId } : {}), outcomeRefs: params.outcomeRefs });
  await mirrorConversationMessageToZep({ tenantId: params.tenantId, employeeId: params.employeeId, threadId: params.threadId, messageId: appended.message.id, role: "assistant", content: params.text, createdAt: appended.message.createdAt });
  return appended.message;
}
