import { sql } from "drizzle-orm";
import { canonicalTruthRegistry, resolveTenantVertical, withTenant } from "@finnor/db";
import { OperatingInteractionContextSchema } from "@finnor/policy-schema";
import { PE_WORLD_ROOT_TYPES, isRetiredWaterCanonicalEntity, type CanonicalEntityRef, type OperatingInteractionContext, type PeWorldRootRef, type TenantContext } from "@finnor/shared-types";
import { validatePrivateEquityWorldContext } from "@finnor/private-equity/src/world-state";
import { PE_ENTITY_TYPES, PeDomainError } from "@finnor/private-equity/src/types";
import { eq, isNull, or } from "drizzle-orm";
import { interpretOperationalQuery, type OperationalQueryDecision } from "./fast-read-lane";

export class OperatingInteractionContextError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 = 400,
    public readonly code = "invalid_operating_interaction_context",
  ) {
    super(message);
    this.name = "OperatingInteractionContextError";
  }
}

function key(ref: CanonicalEntityRef<string>): string {
  return `${ref.entityType}:${ref.entityId}`;
}

function unique(refs: CanonicalEntityRef<string>[]): CanonicalEntityRef<string>[] {
  return [...new Map(refs.map((ref) => [key(ref), ref])).values()];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeLegacyContext(value: unknown, channel: "voice" | "text" | "console"): unknown {
  const legacy = object(value);
  if (legacy.version === 1 || Object.keys(legacy).length === 0) return value;
  const entityRefs = Array.isArray(legacy.entityRefs) ? legacy.entityRefs : [];
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    source: channel,
    selectedEntities: entityRefs,
    excludedEntities: [],
    surface: { id: "home", route: "/centropy", spatialState: "canvas" },
    filters: [],
  };
}

/**
 * Resolve browser-provided operating context inside the authenticated tenant.
 * This runs after the initial Work/Input intake claim but before the resolved
 * context is persisted on Work or reaches a planner prompt. An invalid or
 * cross-tenant reference therefore leaves a recoverable Work without becoming
 * canonical context.
 */
export async function resolveOperatingInteractionContext(params: {
  tenantId: string;
  context: unknown;
  channel: "voice" | "text" | "console";
  workId?: string;
}): Promise<OperatingInteractionContext | undefined> {
  if (params.context === undefined || params.context === null) return undefined;
  const parsed = OperatingInteractionContextSchema.safeParse(normalizeLegacyContext(params.context, params.channel));
  if (!parsed.success) {
    throw new OperatingInteractionContextError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const context = parsed.data;
  if (context.activeWork && (!params.workId || context.activeWork.workId !== params.workId)) {
    throw new OperatingInteractionContextError("activeWork must match the explicit continuation Work");
  }

  const focusedKey = context.focusedEntity ? key(context.focusedEntity) : null;
  if (focusedKey && context.excludedEntities.some((ref) => key(ref) === focusedKey)) {
    throw new OperatingInteractionContextError("The focused entity cannot also be excluded");
  }

  const refs = unique([
    ...(context.businessRoot ? [context.businessRoot] : []),
    ...(context.focusedEntity ? [context.focusedEntity] : []),
    ...context.selectedEntities,
    ...context.excludedEntities,
    ...(context.activeWork ? [{ entityType: "work" as const, entityId: context.activeWork.workId }] : []),
  ]);

  if (refs.some((ref) => isRetiredWaterCanonicalEntity(ref.entityType))) {
    throw new OperatingInteractionContextError("An operating-context entity type is retired", 403, "operating_context_scope_denied");
  }

  const vertical = await resolveTenantVertical(params.tenantId);

  const resolved = await withTenant(params.tenantId, async (db) => {
    const entityTenants = new Map<string, string | null>();
    const registrations = await db.select({ entityType: canonicalTruthRegistry.entityType }).from(canonicalTruthRegistry).where(or(
      isNull(canonicalTruthRegistry.verticalKey),
      eq(canonicalTruthRegistry.verticalKey, vertical.verticalKey),
    ));
    if (refs.length > 0) {
      const values = sql.join(refs.map((ref) => sql`(${ref.entityType}::text, ${ref.entityId}::uuid)`), sql`, `);
      const result = await db.execute<{ entity_type: CanonicalEntityRef["entityType"]; entity_id: string; tenant_id: string | null }>(sql`
        WITH requested(entity_type, entity_id) AS (VALUES ${values})
        SELECT requested.entity_type,
               requested.entity_id::text entity_id,
               finnor_os.canonical_entity_tenant(requested.entity_type, requested.entity_id)::text tenant_id
        FROM requested
      `);
      for (const row of result.rows) entityTenants.set(`${row.entity_type}:${row.entity_id}`, row.tenant_id);
    }

    return { entityTenants, registered: new Set(registrations.map((row) => row.entityType)) };
  });

  for (const ref of refs) {
    if (!resolved.registered.has(ref.entityType) || resolved.entityTenants.get(key(ref)) !== params.tenantId) {
      throw new OperatingInteractionContextError("An operating-context reference is unavailable in this tenant", 403, "operating_context_scope_denied");
    }
  }

  return {
    version: 1,
    capturedAt: context.capturedAt,
    // The authenticated transport path owns source identity. A forged source can
    // change neither planner semantics nor auditing.
    source: params.channel,
    ...(context.activeWork ? { activeWork: context.activeWork } : {}),
    ...(context.businessRoot ? { businessRoot: context.businessRoot } : {}),
    ...(context.focusedEntity ? { focusedEntity: context.focusedEntity } : {}),
    selectedEntities: unique(context.selectedEntities),
    excludedEntities: unique(context.excludedEntities),
    surface: context.surface,
    filters: context.filters,
    ...(context.timeContext ? { timeContext: context.timeContext } : {}),
  };
}

/** Exact direct target set after explicit exclusions. Focus is the singular
 * target only when no additive selection exists. */
export function effectiveInteractionTargets(context: OperatingInteractionContext | undefined): CanonicalEntityRef<string>[] {
  if (!context) return [];
  const excluded = new Set(context.excludedEntities.map(key));
  const candidates = context.selectedEntities.length > 0
    ? context.selectedEntities
    : context.focusedEntity
      ? [context.focusedEntity]
      : [];
  return unique(candidates).filter((ref) => !excluded.has(key(ref)));
}

export function interactionBusinessRoot(context: OperatingInteractionContext | undefined): PeWorldRootRef | null {
  if (context?.businessRoot) return context.businessRoot;
  const roots = effectiveInteractionTargets(context).filter((ref): ref is PeWorldRootRef =>
    PE_WORLD_ROOT_TYPES.some(type => type === ref.entityType));
  if (roots.length > 1) throw new OperatingInteractionContextError("Select one enclosing PE business root for this objective");
  return roots[0] ?? null;
}

/** Canvas focus and selected PE records must belong to the enclosing owner cut.
 * Conversation-resolved recipients retain their tenant/party and action-authority
 * boundaries; the institutional graph does not own employee membership. */
export async function validateInteractionBusinessScope(
  ctx: TenantContext,
  context: OperatingInteractionContext | undefined,
): Promise<PeWorldRootRef | null> {
  const root = interactionBusinessRoot(context);
  if (!root || (await resolveTenantVertical(ctx.tenantId)).verticalKey !== "private_equity") return null;
  const subjects = effectiveInteractionTargets(context).filter(ref => PE_ENTITY_TYPES.some(type => type === ref.entityType));
  try {
    await validatePrivateEquityWorldContext({ auth: ctx }, root,
      unique([...subjects, ...(context?.focusedEntity ? [context.focusedEntity] : [])]));
  } catch (error) {
    if (!(error instanceof PeDomainError) || error.code !== "PE_ENTITY_NOT_FOUND") throw error;
    throw new OperatingInteractionContextError("The business root or selected subject is unavailable in the current scope", 403, "operating_context_scope_denied");
  }
  return root;
}

/** Global fast reads cannot silently discard an exact canvas target. Route the
 * instruction through the context-aware planner instead. */
export function interactionAwareOperationalDecision(
  decision: OperationalQueryDecision,
  context: OperatingInteractionContext | undefined,
  instruction?: string,
): OperationalQueryDecision {
  if (!context) return decision;
  const targets = effectiveInteractionTargets(context);
  const root = interactionBusinessRoot(context);
  if (!root && targets.length === 0) return decision;
  const exactDeal = targets.length === 1 && targets[0]?.entityType === "pe_deal" ? targets[0].entityId
    : root?.entityType === "pe_deal" ? root.entityId : undefined;
  const scoped = instruction ? interpretOperationalQuery(instruction, { businessRoot: root, dealId: exactDeal }) : decision;
  if (scoped.route === "fast_read" && "dealId" in scoped.request && scoped.request.dealId === exactDeal) {
    return scoped;
  }
  if (scoped.route === "fast_read" && scoped.request.intent === "pe_world_state"
      && scoped.request.root.entityType === root?.entityType && scoped.request.root.entityId === root.entityId) {
    return scoped;
  }
  if (decision.route === "fast_read" && decision.request.intent === "company_context") return decision;
  return decision.route === "fast_read" || scoped.route === "fast_read" ? { route: "planner", reason: "external_or_ambiguous" } : scoped;
}
