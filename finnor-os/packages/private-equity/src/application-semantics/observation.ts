import { z } from "zod";
import type {
  ApplicationField, ApplicationScalar, ApplicationScope, ApplicationSnapshot, ApplicationState,
  ApplicationTransitionEvidence, ExperimentRef, ScopedApplicationIdentity,
} from "@finnor/shared-types";
import {
  ApplicationFieldSchema, ApplicationScopeSchema, ApplicationStructuralWitnessSchema,
  ExactApplicationQuantitySchema, ScopedApplicationIdentitySchema, X2_LIMITS, boundedX2, x2Fault,
} from "./contracts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : x2Fault("X2_STRUCTURAL_OBSERVATION_OBJECT_REQUIRED");
const under = (path: string, ancestor: string) => path === ancestor || path.startsWith(`${ancestor}.`);
export const applicationPathCovered = (path: string, positive: readonly string[], negative: readonly string[]) =>
  !negative.some(prefix => under(path, prefix)) && positive.some(prefix => under(path, prefix));

function scalar(value: unknown, kind: ApplicationField["kind"], scope: ApplicationScope,
  target: ScopedApplicationIdentity): { available: boolean; value: ApplicationScalar | null } {
  if (value === null) return { available: true, value: null };
  if (kind === "text" || kind === "enum") return { available: typeof value === "string" && value.length <= X2_LIMITS.maxTextLength,
    value: typeof value === "string" ? value : null };
  if (kind === "boolean") return { available: typeof value === "boolean", value: typeof value === "boolean" ? value : null };
  if (kind === "quantity") {
    const parsed = ExactApplicationQuantitySchema.safeParse(value);
    return { available: parsed.success, value: parsed.success ? parsed.data : null };
  }
  const parsed = ScopedApplicationIdentitySchema.safeParse(value);
  return { available: parsed.success && parsed.data.application === scope.application
    && parsed.data.account === scope.account && parsed.data.entity === target.entity, value: parsed.success ? parsed.data : null };
}

/** Specified derived view. Never mutates or claims to rehash a retained original. */
export function projectApplicationSnapshot(input: unknown, declaration: unknown): {
  state: ApplicationState; unavailableFields: string[];
} {
  boundedX2(input, X2_LIMITS.maxModelBytes);
  const original = object(input);
  const fields = z.array(ApplicationFieldSchema).max(16).parse(declaration);
  if (new Set(fields.map(field => field.path)).size !== fields.length) x2Fault("X2_STRUCTURAL_DECLARATION_AMBIGUITY");
  const scope = ApplicationScopeSchema.parse(original.scope), target = ScopedApplicationIdentitySchema.parse(original.target);
  const state: ApplicationState = {}, unavailableFields: string[] = [];
  const witness = original.structuralWitness === undefined ? null : ApplicationStructuralWitnessSchema.parse(original.structuralWitness);
  const ownState = object(original.state), oldUnavailable = z.array(z.string()).max(16).parse(original.unavailableFields);
  for (const field of fields) {
    let available = false, value: ApplicationScalar | null = null;
    if (witness) {
      const covered = applicationPathCovered(field.path, witness.availablePaths, witness.unavailablePaths);
      if (covered && Object.hasOwn(witness.leaves, field.path) && witness.leaves[field.path] !== null
        && witness.leafKinds[field.path] === field.kind) {
        const checked = scalar(witness.leaves[field.path], field.kind, scope, target);
        available = checked.available; value = checked.value;
      } else if (covered && witness.nullPrefixes.some(prefix => under(field.path, prefix))) {
        available = true;
      } else if (covered && witness.publishedSchemaDigest
        && witness.optionalAbsentPaths.some(prefix => under(field.path, prefix))) {
        available = true;
      }
    } else if (Object.hasOwn(ownState, field.path) && !oldUnavailable.some(prefix => under(field.path, prefix))) {
      const checked = scalar(ownState[field.path], field.kind, scope, target);
      available = checked.available; value = checked.value;
    }
    if (available) state[field.path] = value;
    else unavailableFields.push(field.path);
  }
  return { state, unavailableFields };
}

export type ApplicationSnapshotView = Omit<ApplicationSnapshot, "schema"> & {
  schema: "finnor.x2.derived-snapshot-view.v1";
};
export type ApplicationTransitionView = Omit<ApplicationTransitionEvidence, "schema" | "ref" | "before" | "after"> & {
  schema: "finnor.x2.derived-transition-view.v1";
  originalEvidenceRef: ExperimentRef;
  before: ApplicationSnapshotView;
  after: ApplicationSnapshotView | null;
};
export function deriveApplicationTransition(original: ApplicationTransitionEvidence, fields: ApplicationField[]): ApplicationTransitionView {
  const snapshot = (value: ApplicationSnapshot): ApplicationSnapshotView => ({
    ...value, schema: "finnor.x2.derived-snapshot-view.v1", ...projectApplicationSnapshot(value, fields),
  });
  const { schema, ref, before, after, ...metadata } = original;
  void schema;
  return { ...metadata, schema: "finnor.x2.derived-transition-view.v1", originalEvidenceRef: ref,
    before: snapshot(before), after: after ? snapshot(after) : null };
}
