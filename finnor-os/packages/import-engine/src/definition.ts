import { RetiredVerticalError, isRetiredWaterImportEntity } from "@finnor/shared-types";
import { z } from "zod";

export interface ImportEntityDefinition {
  entity: string;
  fields: readonly string[];
  relationships: readonly string[];
  requiredRelationships?: readonly string[];
}

const activeDefinitions = new Map<string, ImportEntityDefinition>();

/** Vertical packages may explicitly register an import contract. Phase 5 ships no
 * PE import pack; the generic engine therefore remains present with an empty active
 * entity registry. */
export function registerImportEntityDefinition(definition: ImportEntityDefinition): void {
  if (isRetiredWaterImportEntity(definition.entity)) throw new RetiredVerticalError("water");
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(definition.entity)) throw new Error("Import entity type is invalid");
  if (activeDefinitions.has(definition.entity)) throw new Error(`Import entity ${definition.entity} is already registered`);
  activeDefinitions.set(definition.entity, Object.freeze({ ...definition }));
}

export function activeImportEntityTypes(): string[] {
  return [...activeDefinitions.keys()].sort();
}

export function activeImportEntityDefinition(entity: string): ImportEntityDefinition | undefined {
  return activeDefinitions.get(entity);
}

export const ImportEntitySchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);

export const NormalizationSchema = z.enum([
  "trim", "lowercase", "uppercase", "title_case", "digits_only", "phone_e164", "empty_to_null",
]);

export const FieldMappingSchema = z.object({
  from: z.string().min(1).optional(),
  compose: z.object({ from: z.array(z.string().min(1)).min(1), separator: z.string().default(" ") }).optional(),
  literal: z.unknown().optional(),
  type: z.enum(["string", "number", "integer", "boolean", "date", "json"]).default("string"),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  normalize: z.array(NormalizationSchema).default([]),
  valueMap: z.record(z.unknown()).optional(),
}).superRefine((rule, ctx) => {
  const selectors = [rule.from !== undefined, rule.compose !== undefined, rule.literal !== undefined].filter(Boolean).length;
  if (selectors > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "field mapping may use only one of from, compose, or literal" });
});

export const ImportIdentityRuleSchema = z.object({
  fields: z.array(z.string().min(1)).min(1),
});

export const ImportRelationshipSchema = z.object({
  entity: ImportEntitySchema,
  sourceId: FieldMappingSchema,
  sourceSystem: z.string().trim().min(1).max(120).optional(),
  required: z.boolean().default(true),
});

const DeclarativeImportBodyObjectSchema = z.object({
  version: z.number().int().positive().default(1),
  entity: ImportEntitySchema,
  sourceSystem: z.string().trim().min(1).max(120),
  delimiter: z.string().length(1).default(","),
  fields: z.record(FieldMappingSchema),
  externalId: FieldMappingSchema.optional(),
  identity: z.array(ImportIdentityRuleSchema).default([]),
  relationships: z.record(ImportRelationshipSchema).default({}),
  updateMode: z.enum(["insert_only", "fill_missing", "source_owned"]).default("fill_missing"),
  batchSize: z.number().int().min(1).max(1000).default(100),
});

function validateDefinition(definition: z.infer<typeof DeclarativeImportBodyObjectSchema>, ctx: z.RefinementCtx): void {
  if (isRetiredWaterImportEntity(definition.entity)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entity"], message: "RETIRED_VERTICAL: Water import entities are historical and unavailable" });
    return;
  }
  const contract = activeDefinitions.get(definition.entity);
  if (!contract) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entity"], message: `Unsupported active import entity: ${definition.entity}` });
    return;
  }
  for (const field of Object.keys(definition.fields)) {
    if (!contract.fields.includes(field)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", field], message: `${field} is not a registered canonical field for ${definition.entity}` });
  }
  for (const [field, relationship] of Object.entries(definition.relationships)) {
    if (!contract.relationships.includes(field)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["relationships", field], message: `${field} is not a registered relationship for ${definition.entity}` });
    if (isRetiredWaterImportEntity(relationship.entity)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["relationships", field, "entity"], message: "RETIRED_VERTICAL: Water relationship entity is unavailable" });
    else if (!activeDefinitions.has(relationship.entity)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["relationships", field, "entity"], message: `Unsupported relationship entity: ${relationship.entity}` });
  }
  for (const required of contract.requiredRelationships ?? []) {
    if (!definition.relationships[required]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["relationships", required], message: `${definition.entity} requires a ${required} relationship` });
  }
  if (!definition.externalId && definition.identity.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity"], message: "externalId or at least one deterministic identity rule is required" });
  }
  for (const [index, rule] of definition.identity.entries()) {
    for (const field of rule.fields) {
      if (!definition.fields[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity", index, "fields"], message: `identity field ${field} is not mapped` });
      else if (definition.fields[field]!.type === "json") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity", index, "fields"], message: `identity field ${field} cannot use json conversion` });
    }
  }
}

export const DeclarativeImportBodySchema = DeclarativeImportBodyObjectSchema.superRefine(validateDefinition);
export const DeclarativeImportDefinitionSchema = DeclarativeImportBodyObjectSchema.extend({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/),
  format: z.enum(["csv", "json", "jsonl"]),
}).superRefine(validateDefinition);

export type FieldMapping = z.infer<typeof FieldMappingSchema>;
export type ImportEntity = z.infer<typeof ImportEntitySchema>;
export type DeclarativeImportBody = z.infer<typeof DeclarativeImportBodySchema>;
export type DeclarativeImportDefinition = z.infer<typeof DeclarativeImportDefinitionSchema>;

export function parseImportDefinition(value: unknown): DeclarativeImportDefinition {
  try {
    return DeclarativeImportDefinitionSchema.parse(value);
  } catch (error) {
    const entity = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).entity : null;
    if (typeof entity === "string" && isRetiredWaterImportEntity(entity)) throw new RetiredVerticalError("water");
    throw error;
  }
}
