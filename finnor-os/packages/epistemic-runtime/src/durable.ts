/** Scope-5 durable projection. The source owners retain every raw value; this
 * module stores only versioned definitions, source references, semantic hashes,
 * redacted belief facts, causal edges and derived impact. */
import { CURRENT_MIGRATION_HEAD, withTenantTransaction } from "@finnor/db";
import { affectedNodes, compileUnderwritingModel, type UnderwritingModelIR } from "@finnor/underwriting";
import type { PoolClient } from "pg";
import { EPISTEMIC_HEURISTIC_VERSION, type ConfidenceLevel, type EvidenceRecord, type JsonValue, type Proposition,
  type PropositionDefinition, type PropositionDependency, type PropositionStatus, type SourceAuthority } from "./contracts";
import { evaluateBoundProposition, propositionSemanticFingerprint } from "./belief-update";
import { appendEvidenceAndRecompute } from "./belief-update";
import { canonicalJson, epistemicHash } from "./source-precedence";
import { createEpistemicState, unknownProposition } from "./state";
import type { EpistemicState } from "./contracts";

const GRAPH_SCHEMA_VERSION = 2;
const MATERIALITY_RULE_VERSION = "scope5-materiality-v1";
const MAX_GRAPH_PROPOSITIONS = 10_000;
const MAX_SOURCE_VERSIONS_PER_BINDING = 10_000;
const MAX_FRONTIER_PER_CALL = 64;

export interface DurableSourceBinding {
  propositionId: string;
  sourceKind: "canonical_entity" | "evidence_source";
  sourceType: string;
  sourceId: string;
  valuePath: string;
  selector?: DurableSourceSelector;
  evidenceKind: "CANONICAL_DB" | "DOCUMENT" | "PROVIDER_OBSERVATION";
  maxAgeMs?: number;
}

export type DurableSelectorExpression =
  | { op: "equals"; path: string; value: JsonValue }
  | { op: "in"; path: string; values: JsonValue[] }
  | { op: "not_null"; path: string }
  | { op: "all" | "any"; terms: DurableSelectorExpression[] }
  | { op: "not"; term: DurableSelectorExpression };

export type DurableSourceSelector =
  | { op: "path" }
  | { op: "constant"; value: JsonValue }
  | { op: "claim"; propositionId: string }
  | { op: "business_hash" }
  | { op: "boolean"; expression: DurableSelectorExpression; when?: DurableSelectorExpression; omitWhenFalse?: boolean };

export interface DurableGraphDefinition {
  tenantId: string;
  ruleVersion: string;
  heuristicVersion: typeof EPISTEMIC_HEURISTIC_VERSION;
  propositions: readonly PropositionDefinition[];
  dependencies: readonly PropositionDependency[];
  bindings: readonly DurableSourceBinding[];
}

interface ControlRow {
  graph_version_id: string;
  mode: "shadow" | "active" | "refreshing" | "disabled";
  kill_switch: boolean;
  graph_structure_epoch: string;
  staged_structure_epoch: string;
  baseline_started_at: Date | null;
  baseline_completed_at: Date | null;
  shadow_verified_at: Date | null;
  shadow_verified_change_order: string | null;
  processing_change_id: string | null;
}

interface ChangeRow {
  id: string;
  ingestion_order: string;
  graph_version_id: string;
  source_kind: string;
  source_version_id: string | null;
  source_type: string | null;
  source_entity_id: string | null;
  target_proposition_id: string | null;
  accepted_at: Date;
  accepted_at_exact: string;
  known_at: Date;
  status: string;
}

interface CurrentBelief {
  status: Proposition["status"];
  valueHash: string;
  sourceAuthority: Proposition["sourceAuthority"] | null;
  sourceTruthClass: string | null;
  observedAt: string | null;
  validAt: string | null;
  freshnessStatus: string;
  confidence: Proposition["confidence"];
  selectedEvidenceRefs: string[];
  contradictingEvidenceRefs: string[];
  conflictRefs: string[];
  dependencyRefs: string[];
  reasonCode: string;
  semanticHash: string;
}

function iso(value: Date | string | null | undefined, fallback?: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (fallback !== undefined) return fallback;
  throw new Error("Epistemic source has no valid timestamp");
}

function hash(value: unknown): string { return `sha256:${epistemicHash(value)}`; }

export function durableDeterministicValueHash(value: JsonValue): string {
  return hash({ kind: "DETERMINISTIC", value });
}

function pathValue(snapshot: unknown, path: string): { present: boolean; value?: JsonValue } {
  let cursor: unknown = snapshot;
  for (const key of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor) || !Object.hasOwn(cursor, key)) return { present: false };
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor === undefined ? { present: false } : { present: true, value: cursor as JsonValue };
}

function selectorExpressionValue(snapshot: unknown, expression: DurableSelectorExpression): boolean {
  if ("terms" in expression) return expression.op === "all"
    ? expression.terms.every((term) => selectorExpressionValue(snapshot,term))
    : expression.terms.some((term) => selectorExpressionValue(snapshot,term));
  if ("term" in expression) return !selectorExpressionValue(snapshot,expression.term);
  const selected = pathValue(snapshot,expression.path);
  if (expression.op === "not_null") return selected.present && selected.value !== null;
  if (!selected.present) return false;
  if (expression.op === "equals") return canonicalJson(selected.value) === canonicalJson(expression.value);
  return expression.values.some((value) => canonicalJson(selected.value) === canonicalJson(value));
}

function selectBoundValue(snapshot: unknown, binding: Pick<DurableSourceBinding,"valuePath"|"selector">): { present: boolean; value?: JsonValue } {
  const selector = binding.selector ?? { op:"path" as const };
  if (selector.op === "path") return pathValue(snapshot,binding.valuePath);
  if (selector.op === "constant") return { present:true,value:selector.value };
  if (selector.op === "business_hash") {
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return { present:false };
    // Only the canonical owner persists the source bytes. Epistemic belief gets
    // one deterministic identity for its business fields, including retirement.
    const metadata = new Set(["id","tenant_id","version","revision","source_system","external_id",
      "created_by","observed_at","created_at","updated_at","evidence_source_id","evidence_version_id",
      "supersedes_observation_id","supersedes_interest_id","supersedes_coverage_id"]);
    const business = Object.fromEntries(Object.entries(snapshot as Record<string,unknown>)
      .filter(([key]) => !metadata.has(key)));
    return { present:true,value:`sha256:${epistemicHash(business)}` };
  }
  if (selector.op === "claim") {
    const claims = pathValue(snapshot,binding.valuePath).value;
    if (!Array.isArray(claims)) return { present:false };
    const match = claims.find((claim) => claim !== null && typeof claim === "object" && !Array.isArray(claim)
      && (claim as Record<string,JsonValue>).propositionId === selector.propositionId) as Record<string,JsonValue> | undefined;
    return match && Object.hasOwn(match,"value") ? { present:true,value:match.value } : { present:false };
  }
  if (selector.when && !selectorExpressionValue(snapshot,selector.when)) return { present:false };
  const value = selectorExpressionValue(snapshot,selector.expression);
  return selector.omitWhenFalse && !value ? { present:false } : { present:true,value };
}

function validateSelectorExpression(expression: DurableSelectorExpression): void {
  if ("terms" in expression) {
    if (!expression.terms.length || expression.terms.length > 128) throw new Error("Durable selector expression must be bounded and non-empty");
    for (const term of expression.terms) validateSelectorExpression(term);
    return;
  }
  if ("term" in expression) { validateSelectorExpression(expression.term); return; }
  if (!/^[A-Za-z0-9_.-]{1,240}$/.test(expression.path)) throw new Error("Durable selector path is invalid");
  if (expression.op === "in" && (!expression.values.length || expression.values.length > 128)) throw new Error("Durable selector value set is invalid");
}

function derivationRefs(expression: NonNullable<PropositionDefinition["predicate"]["derivation"]>["expression"]): string[] {
  if (expression.op === "require") {
    if (!expression.expectedValueHashes.length || expression.expectedValueHashes.some((value) => !/^sha256:[0-9a-f]{64}$/.test(value))) {
      throw new Error("Derived proposition expected-value hashes are invalid");
    }
    return [expression.propositionId];
  }
  if (!expression.terms.length) throw new Error("Derived proposition expression is empty");
  return expression.terms.flatMap(derivationRefs);
}

function validateGraph(input: DurableGraphDefinition): string {
  if (!input.tenantId || input.ruleVersion !== MATERIALITY_RULE_VERSION || input.heuristicVersion !== EPISTEMIC_HEURISTIC_VERSION) {
    throw new Error("Scope-5 graph requires tenant and supported pinned rule/heuristic versions");
  }
  if (input.propositions.length < 1 || input.propositions.length > MAX_GRAPH_PROPOSITIONS) throw new Error("Scope-5 graph size exceeds bounded registration limit");
  const definitions = new Map(input.propositions.map((definition) => [definition.id, definition]));
  if (definitions.size !== input.propositions.length) throw new Error("Duplicate proposition identity");
  const parents = new Map<string, string[]>();
  for (const edge of input.dependencies) {
    if (!definitions.has(edge.propositionId) || !definitions.has(edge.dependsOnPropositionId)) throw new Error("Graph dependency references an unknown proposition");
    const rows = parents.get(edge.propositionId) ?? [];
    rows.push(edge.dependsOnPropositionId);
    parents.set(edge.propositionId, rows);
  }
  for (const definition of input.propositions) {
    if (canonicalJson([...(definition.dependencyRefs ?? [])].sort()) !== canonicalJson([...(parents.get(definition.id) ?? [])].sort())) {
      throw new Error(`Definition and typed dependency index disagree: ${definition.id}`);
    }
    if (definition.predicate.derivation) {
      const derived = [...new Set(derivationRefs(definition.predicate.derivation.expression))].sort();
      if (canonicalJson(derived) !== canonicalJson([...(definition.dependencyRefs ?? [])].sort())) {
        throw new Error(`Derived rule and dependency refs disagree: ${definition.id}`);
      }
    }
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Epistemic dependency cycle: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of parents.get(id) ?? []) visit(parent);
    visiting.delete(id); visited.add(id);
  };
  for (const id of [...definitions.keys()].sort()) visit(id);
  for (const binding of input.bindings) {
    if (!definitions.has(binding.propositionId)) throw new Error(`Unknown source binding proposition ${binding.propositionId}`);
    if ((binding.sourceKind === "canonical_entity") !== (binding.evidenceKind === "CANONICAL_DB")) throw new Error("Source kind and authority do not agree");
    if (!/^[A-Za-z0-9_.-]{1,240}$/.test(binding.valuePath)) throw new Error("Durable binding value path is invalid");
    if (binding.selector?.op === "boolean") {
      validateSelectorExpression(binding.selector.expression);
      if (binding.selector.when) validateSelectorExpression(binding.selector.when);
    }
  }
  return hash({ schemaVersion: GRAPH_SCHEMA_VERSION, ruleVersion: input.ruleVersion, heuristicVersion: input.heuristicVersion,
    propositions: [...input.propositions].sort((a,b) => a.id.localeCompare(b.id)),
    dependencies: [...input.dependencies].sort((a,b) => a.id.localeCompare(b.id)),
    bindings: [...input.bindings].sort((a,b) => canonicalJson(a).localeCompare(canonicalJson(b))) });
}

/** Staging a new version is a controlled, shadow-only transition. Existing
 * pending changes are drained before a graph switch; no old event is relabelled. */
export async function stageDurableEpistemicGraph(input: DurableGraphDefinition,
  options: { expectedStructureEpoch?: string } = {}): Promise<{ graphVersionId: string; graphHash: string }> {
  const graphHash = validateGraph(input);
  return withTenantTransaction(input.tenantId, { isolation: "serializable" }, async (_db, client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5141))", [input.tenantId]);
    const prior = (await client.query<ControlRow>(
      "SELECT * FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1 FOR UPDATE",[input.tenantId])).rows[0];
    const structureEpoch = prior?.graph_structure_epoch ?? "0";
    if (options.expectedStructureEpoch !== undefined && options.expectedStructureEpoch !== structureEpoch) {
      throw new Error("Canonical PE graph structure changed while the graph was being assembled; retry");
    }
    const pending = await client.query("SELECT 1 FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND status<>'processed' LIMIT 1", [input.tenantId]);
    if (pending.rowCount) throw new Error("Drain accepted epistemic changes before graph revision");
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM finnor_os.epistemic_graph_versions
       WHERE tenant_id=$1 AND graph_hash=$2 AND retired_at IS NULL
       ORDER BY created_at DESC,id DESC LIMIT 1`,[input.tenantId,graphHash]);
    let graphVersionId = existing.rows[0]?.id;
    if (!graphVersionId) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO finnor_os.epistemic_graph_versions(tenant_id,graph_hash,rule_version,heuristic_version)
         VALUES($1,$2,$3,$4) RETURNING id`, [input.tenantId, graphHash, input.ruleVersion, input.heuristicVersion]);
      graphVersionId = result.rows[0]!.id;
      for (const definition of [...input.propositions].sort((a,b) => a.id.localeCompare(b.id))) {
        await client.query(`INSERT INTO finnor_os.epistemic_propositions
          (tenant_id,graph_version_id,proposition_id,subject,predicate) VALUES($1,$2,$3,$4,$5)`,
          [input.tenantId, graphVersionId, definition.id, definition.subject, definition.predicate]);
      }
      for (const edge of [...input.dependencies].sort((a,b) => a.id.localeCompare(b.id))) {
        await client.query(`INSERT INTO finnor_os.epistemic_proposition_dependencies
          (tenant_id,graph_version_id,proposition_id,depends_on_proposition_id,kind) VALUES($1,$2,$3,$4,$5)`,
          [input.tenantId, graphVersionId, edge.propositionId, edge.dependsOnPropositionId, edge.kind]);
      }
      for (const binding of [...input.bindings].sort((a,b) => canonicalJson(a).localeCompare(canonicalJson(b)))) {
        await client.query(`INSERT INTO finnor_os.epistemic_source_bindings
          (tenant_id,graph_version_id,proposition_id,source_kind,source_type,source_id,value_path,selector,evidence_kind,max_age_ms)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [input.tenantId,graphVersionId,binding.propositionId,binding.sourceKind,binding.sourceType,binding.sourceId,
            binding.valuePath,binding.selector ?? { op:"path" },binding.evidenceKind,binding.maxAgeMs ?? null]);
      }
      await client.query("UPDATE finnor_os.epistemic_graph_versions SET frozen_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [input.tenantId,graphVersionId]);
    }
    if (prior?.graph_version_id !== graphVersionId) {
      if (prior?.mode === "active" && !prior.kill_switch
        && prior.graph_structure_epoch === prior.staged_structure_epoch) {
        throw new Error("Disable active epistemic impact before an unrelated graph revision");
      }
      if (prior) await client.query(
        "UPDATE finnor_os.epistemic_graph_versions SET retired_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND retired_at IS NULL",
        [input.tenantId,prior.graph_version_id]);
      await client.query(`INSERT INTO finnor_os.epistemic_runtime_controls
        (tenant_id,graph_version_id,mode,kill_switch,staged_structure_epoch,updated_at)
        VALUES($1,$2,'shadow',false,$3,clock_timestamp())
        ON CONFLICT(tenant_id) DO UPDATE SET graph_version_id=$2,
          mode=CASE WHEN finnor_os.epistemic_runtime_controls.mode IN ('active','refreshing')
            THEN 'refreshing' ELSE 'shadow' END,
          kill_switch=finnor_os.epistemic_runtime_controls.kill_switch,staged_structure_epoch=$3,
          baseline_started_at=NULL,baseline_completed_at=NULL,shadow_verified_at=NULL,shadow_verified_change_order=NULL,
          processing_change_id=NULL,updated_at=clock_timestamp()`,
        [input.tenantId,graphVersionId,structureEpoch]);
    } else if (prior && prior.graph_structure_epoch !== prior.staged_structure_epoch) {
      await client.query(`UPDATE finnor_os.epistemic_runtime_controls
        SET mode=CASE WHEN mode IN ('active','refreshing') THEN 'refreshing' ELSE 'shadow' END,
          staged_structure_epoch=graph_structure_epoch,shadow_verified_at=NULL,
          shadow_verified_change_order=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1`,[input.tenantId]);
    }
    return { graphVersionId: graphVersionId!, graphHash };
  });
}

interface BindingRow {
  source_kind: DurableSourceBinding["sourceKind"];
  source_type: string;
  source_id: string;
  value_path: string;
  selector: DurableSourceSelector;
  evidence_kind: DurableSourceBinding["evidenceKind"];
  max_age_ms: string | null;
}

async function boundEvidence(client: PoolClient, tenantId: string, graphId: string, propositionId: string,
  knownAt: string, throughOrder: number): Promise<EvidenceRecord[]> {
  const bindings = await client.query<BindingRow>(`SELECT source_kind,source_type,source_id,value_path,selector,evidence_kind,max_age_ms
    FROM finnor_os.epistemic_source_bindings WHERE tenant_id=$1 AND graph_version_id=$2 AND proposition_id=$3
    ORDER BY source_kind,source_type,source_id,value_path`, [tenantId,graphId,propositionId]);
  const output: EvidenceRecord[] = [];
  for (const binding of bindings.rows) {
    const canonical = binding.source_kind === "canonical_entity";
    const sourceOwner = canonical
      ? (await client.query<{ writable_owner: string }>(
        `SELECT writable_owner FROM finnor_os.canonical_truth_registry
         WHERE entity_type=$1 AND active`, [binding.source_type])).rows[0]?.writable_owner
      : "@finnor/evidence-corpus";
    if (!sourceOwner) throw new Error(`Canonical source type has no active owner: ${binding.source_type}`);
    const result = canonical
      ? await client.query<{ id: string; snapshot: unknown; recorded_at: Date; observed_at: Date | null; previous_version_id: string | null }>(
        `SELECT v.id,v.snapshot,v.recorded_at,v.observed_at,v.previous_version_id FROM finnor_os.canonical_entity_versions v
         WHERE v.tenant_id=$1 AND v.entity_type=$2 AND v.entity_id=$3 AND v.recorded_at<=$4
           AND NOT EXISTS (SELECT 1 FROM finnor_os.epistemic_changes c WHERE c.tenant_id=$1 AND c.graph_version_id=$5
             AND c.source_version_id=v.id AND c.ingestion_order>$6)
         ORDER BY v.entity_version LIMIT $7`, [tenantId,binding.source_type,binding.source_id,knownAt,graphId,throughOrder,MAX_SOURCE_VERSIONS_PER_BINDING+1])
      : await client.query<{ id: string; snapshot: unknown; retrieved_at: Date; as_of: Date; previous_version_id: string | null }>(
        `SELECT id,snapshot,retrieved_at,as_of,lag(id) OVER (ORDER BY version_number) AS previous_version_id
         FROM finnor_os.evidence_source_versions v WHERE source_id=$1 AND v.tenant_id=$2 AND scope='tenant'
           AND retrieved_at<=$3
           AND NOT EXISTS (SELECT 1 FROM finnor_os.epistemic_changes c WHERE c.tenant_id=$2 AND c.graph_version_id=$4
             AND c.source_version_id=v.id AND c.ingestion_order>$5)
         ORDER BY version_number LIMIT $6`,
        [binding.source_id,tenantId,knownAt,graphId,throughOrder,MAX_SOURCE_VERSIONS_PER_BINDING+1]);
    if (result.rows.length > MAX_SOURCE_VERSIONS_PER_BINDING) throw new Error("Bound evidence history exceeds limit; defer and compact through owner policy");
    for (const row of result.rows) {
      const snapshot = row.snapshot as Record<string, unknown>;
      const extracted = selectBoundValue(snapshot,{ valuePath:binding.value_path,selector:binding.selector });
      if (!extracted.present) continue;
      const versionId = row.id;
      const selectorKey = epistemicHash(binding.selector).slice(0,16);
      const evidenceId = `${canonical ? "canonical" : "source"}:${versionId}:${propositionId}:${binding.value_path}:${selectorKey}`;
      const previous = row.previous_version_id
        ? `${canonical ? "canonical" : "source"}:${row.previous_version_id}:${propositionId}:${binding.value_path}:${selectorKey}` : undefined;
      const recordedAt = canonical ? iso((row as { recorded_at: Date }).recorded_at) : iso((row as { retrieved_at: Date }).retrieved_at);
      const observedAt = canonical ? iso((row as { observed_at: Date | null }).observed_at,recordedAt) : iso((row as { as_of: Date }).as_of);
      const sourceFact = binding.selector.op === "business_hash";
      const validAt = canonical
        ? iso(snapshot.valid_from as string | undefined,iso(snapshot.period_start as string | undefined,recordedAt)) : observedAt;
      // A Digital Twin fact identifies its recorded business period. The fact
      // remains knowable after that period ends; its interval remains with the
      // canonical owner. Knowledge time still fences late corrections.
      const possibleValidTo = canonical
        ? sourceFact ? undefined : (snapshot.valid_to as string | undefined) ?? (snapshot.period_end as string | undefined)
        : undefined;
      const validTo = possibleValidTo && Number.isFinite(Date.parse(possibleValidTo))
        && Date.parse(possibleValidTo) > Date.parse(validAt) ? new Date(possibleValidTo).toISOString() : undefined;
      const maxAgeMs = binding.max_age_ms === null ? undefined : Number(binding.max_age_ms);
      output.push({
        id: evidenceId, propositionId, tenantId,
        source: {
          kind: binding.evidence_kind, owner: sourceOwner,
          ref: versionId,
          authority: canonical ? "CANONICAL_OWNER" : binding.evidence_kind === "PROVIDER_OBSERVATION" ? "GOVERNED_OBSERVATION" : "DURABLE_EVIDENCE",
          truthClass: canonical ? "CANONICAL" : binding.evidence_kind === "PROVIDER_OBSERVATION" ? "WORK" : "MEMORY",
          role: "answer_evidence",
        },
        observedAt, validAt, ...(validTo ? { validTo } : {}), ingestedAt: recordedAt, value: extracted.value!,
        confidence: canonical
          ? { level: "VERIFIED", basis: "DETERMINISTIC_SOURCE", heuristicVersion: EPISTEMIC_HEURISTIC_VERSION, reasonCodes: ["CANONICAL_TRUTH_SELECTED"] }
          : { level: "MEDIUM", basis: "SOURCE_ASSERTION", heuristicVersion: EPISTEMIC_HEURISTIC_VERSION, reasonCodes: ["SOURCE_VERSION_ASSERTION"] },
        freshness: { status: "FRESH", ...(maxAgeMs === undefined ? {} : { maxAgeMs }), reason: "Bound source policy" },
        sensitivity: canonical ? "FINANCIAL" : "TENANT_INTERNAL",
        provenance: { sourceRef: versionId, parentEvidenceRefs: [], dependencyRefs: [] },
        canonical, ...(previous ? { supersedesEvidenceRefs: [previous] } : {}), immutable: true,
      });
    }
  }
  return output;
}

interface Evaluation {
  belief: CurrentBelief;
  nextFreshnessAt: string | null;
}

async function evaluateStoredProposition(client: PoolClient, tenantId: string, graphId: string,
  propositionId: string, knownAt: string, throughOrder: number): Promise<Evaluation> {
  const definition = await client.query<{ subject: PropositionDefinition["subject"]; predicate: PropositionDefinition["predicate"] }>(
    `SELECT subject,predicate FROM finnor_os.epistemic_propositions
     WHERE tenant_id=$1 AND graph_version_id=$2 AND proposition_id=$3`, [tenantId,graphId,propositionId]);
  if (!definition.rows[0]) throw new Error(`Missing durable proposition definition ${propositionId}`);
  const deps = await client.query<{ depends_on_proposition_id: string; belief: CurrentBelief | null }>(
    `SELECT d.depends_on_proposition_id,c.belief FROM finnor_os.epistemic_proposition_dependencies d
     LEFT JOIN finnor_os.epistemic_current c ON c.tenant_id=d.tenant_id AND c.graph_version_id=d.graph_version_id
       AND c.proposition_id=d.depends_on_proposition_id
     WHERE d.tenant_id=$1 AND d.graph_version_id=$2 AND d.proposition_id=$3
     ORDER BY d.depends_on_proposition_id`, [tenantId,graphId,propositionId]);
  const dependencyRefs = [...new Set(deps.rows.map((row) => row.depends_on_proposition_id))];
  if (deps.rows.some((row) => row.belief === null)) throw new Error(`Unbaselined dependency for ${propositionId}`);
  const dependencyStates = new Map<string, Proposition>(deps.rows.map((row) => {
    const current = unknownProposition({ id: row.depends_on_proposition_id,
      subject: { kind: "system", type: "durable_dependency" }, predicate: { name: "dependency.status" } });
    return [row.depends_on_proposition_id, {
      ...current,status:row.belief!.status,valueHash:row.belief!.valueHash,
      sourceAuthority:row.belief!.sourceAuthority ?? undefined,
      observedAt:row.belief!.observedAt ?? undefined,validAt:row.belief!.validAt ?? undefined,
      confidence:row.belief!.confidence,evidenceRefs:[...row.belief!.selectedEvidenceRefs],
      dependencyRefs:[...row.belief!.dependencyRefs],
      freshness:{ status:row.belief!.freshnessStatus as Proposition["freshness"]["status"],reason:"Durable dependency projection" },
    }];
  }));
  const evidence = await boundEvidence(client,tenantId,graphId,propositionId,knownAt,throughOrder);
  const result = evaluateBoundProposition({
    definition: { id: propositionId, subject: definition.rows[0].subject,
      predicate: definition.rows[0].predicate, dependencyRefs },
    evidence, dependencies: dependencyStates, time: { validAt: knownAt, knownAt },
  });
  const proposition = result.proposition;
  const semanticHash = hash({ proposition: propositionSemanticFingerprint(proposition),
    conflicts: result.conflicts.map((conflict) => ({ refs: conflict.evidenceRefs,
      resolution: conflict.resolution, winners: conflict.winningEvidenceRefs, reason: conflict.reasonCode })) });
  const belief: CurrentBelief = {
    status: proposition.status, valueHash: hash(proposition.value),
    sourceAuthority: proposition.sourceAuthority ?? null,
    sourceTruthClass: proposition.source?.truthClass ?? null,
    observedAt: proposition.observedAt ?? null,
    validAt: proposition.validAt ?? null,
    freshnessStatus: proposition.freshness.status,
    confidence: proposition.confidence,
    selectedEvidenceRefs: [...proposition.evidenceRefs],
    contradictingEvidenceRefs: [...proposition.contradictingEvidenceRefs],
    conflictRefs: result.conflicts.map((conflict) => conflict.id).sort(),
    dependencyRefs, reasonCode: result.reasonCode, semanticHash,
  };
  let nextFreshnessAt: string | null = null;
  const selected = evidence.find((row) => row.id === proposition.evidenceRefs[0]);
  const maxAge = selected?.freshness.maxAgeMs;
  if (selected && maxAge !== undefined && proposition.freshness.status !== "EXPIRED") {
    const base = Date.parse(selected.observedAt);
    const deadline = base + maxAge * (proposition.freshness.status === "STALE" ? 3 : 1) + 1;
    if (Number.isFinite(deadline)) nextFreshnessAt = new Date(deadline).toISOString();
  }
  return { belief, nextFreshnessAt };
}

async function writeCurrent(client: PoolClient, tenantId: string, graphId: string, propositionId: string,
  evaluation: Evaluation, knownAt: string, changeId: string | null): Promise<void> {
  await client.query(`INSERT INTO finnor_os.epistemic_current
    (tenant_id,graph_version_id,proposition_id,belief,semantic_hash,known_at,next_freshness_at,updated_change_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(tenant_id,graph_version_id,proposition_id) DO UPDATE SET
      belief=EXCLUDED.belief,semantic_hash=EXCLUDED.semantic_hash,known_at=EXCLUDED.known_at,
      next_freshness_at=EXCLUDED.next_freshness_at,updated_change_id=EXCLUDED.updated_change_id`,
    [tenantId,graphId,propositionId,evaluation.belief,evaluation.belief.semanticHash,knownAt,evaluation.nextFreshnessAt,changeId]);
}

/** The first call pins a baseline clock under the same tenant lock used by source
 * capture. Subsequent calls fill at most `batchSize` indexed DAG nodes. No
 * pre-baseline transition or ChangeSet is fabricated. */
export async function baselineDurableEpistemicGraph(tenantId: string, batchSize = 64): Promise<{ complete: boolean; evaluated: number }> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64) throw new Error("Baseline batch must be 1..64");
  return withTenantTransaction(tenantId, {}, async (_db, client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5141))", [tenantId]);
    const controls = await client.query<ControlRow>("SELECT * FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
    const control = controls.rows[0];
    if (!control) throw new Error("Stage a frozen epistemic graph before baseline");
    if (control.baseline_completed_at) return { complete: true, evaluated: 0 };
    if (!control.baseline_started_at) await client.query(
      "UPDATE finnor_os.epistemic_runtime_controls SET baseline_started_at=clock_timestamp() WHERE tenant_id=$1",[tenantId]);
    const start = (await client.query<{ at: string }>(
      `SELECT to_char(baseline_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
       FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1`,[tenantId])).rows[0]!.at;
    let evaluated = 0;
    for (; evaluated < batchSize; evaluated += 1) {
      const next = await client.query<{ proposition_id: string }>(
        `SELECT p.proposition_id FROM finnor_os.epistemic_propositions p
         WHERE p.tenant_id=$1 AND p.graph_version_id=$2
           AND NOT EXISTS (SELECT 1 FROM finnor_os.epistemic_current c WHERE c.tenant_id=p.tenant_id
             AND c.graph_version_id=p.graph_version_id AND c.proposition_id=p.proposition_id)
           AND NOT EXISTS (SELECT 1 FROM finnor_os.epistemic_proposition_dependencies d
             WHERE d.tenant_id=p.tenant_id AND d.graph_version_id=p.graph_version_id
               AND d.proposition_id=p.proposition_id
               AND NOT EXISTS (SELECT 1 FROM finnor_os.epistemic_current parent
                 WHERE parent.tenant_id=d.tenant_id AND parent.graph_version_id=d.graph_version_id
                   AND parent.proposition_id=d.depends_on_proposition_id))
         ORDER BY p.proposition_id LIMIT 1`, [tenantId,control.graph_version_id]);
      if (!next.rows[0]) break;
      const evaluation = await evaluateStoredProposition(client,tenantId,control.graph_version_id,
        next.rows[0].proposition_id,start,0);
      await writeCurrent(client,tenantId,control.graph_version_id,next.rows[0].proposition_id,evaluation,start,null);
    }
    const missing = await client.query(`SELECT 1 FROM finnor_os.epistemic_propositions p WHERE p.tenant_id=$1 AND p.graph_version_id=$2
      AND NOT EXISTS (SELECT 1 FROM finnor_os.epistemic_current c WHERE c.tenant_id=p.tenant_id
        AND c.graph_version_id=p.graph_version_id AND c.proposition_id=p.proposition_id) LIMIT 1`,
      [tenantId,control.graph_version_id]);
    if (!missing.rowCount) {
      await client.query("UPDATE finnor_os.epistemic_runtime_controls SET baseline_completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1", [tenantId]);
      await client.query("UPDATE finnor_os.epistemic_graph_versions SET baseline_at=$3 WHERE tenant_id=$1 AND id=$2 AND baseline_at IS NULL", [tenantId,control.graph_version_id,start]);
      return { complete: true, evaluated };
    }
    if (evaluated === 0) throw new Error("Frozen epistemic graph has an unresolvable baseline frontier");
    return { complete: false, evaluated };
  });
}

export interface DurableChangeResult {
  complete: boolean;
  evaluated: number;
  changesetId?: string;
  reason?: "BASELINE_PENDING" | "EARLIER_CHANGE_PENDING" | "FRONTIER_REMAINS";
}

/** One queue delivery performs bounded, short transactions. Each frontier node,
 * its updated current belief and newly discovered dependents commit together.
 * During the partial frontier, operational readers fail closed. */
export async function processDurableEpistemicChange(tenantId: string, changeId: string,
  limit = MAX_FRONTIER_PER_CALL): Promise<DurableChangeResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FRONTIER_PER_CALL) throw new Error("Invalid epistemic frontier limit");
  let evaluated = 0;
  for (; evaluated < limit; evaluated += 1) {
    const step = await withTenantTransaction(tenantId, {}, async (_db, client): Promise<
      { kind: "evaluated" } | { kind: "complete"; changesetId: string } | { kind: "waiting"; reason: DurableChangeResult["reason"] }
    > => {
      const controls = await client.query<ControlRow>(
        "SELECT * FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
      const control = controls.rows[0];
      if (!control || !control.baseline_completed_at) return { kind: "waiting", reason: "BASELINE_PENDING" };
      const changes = await client.query<ChangeRow>(
        `SELECT c.*,to_char(c.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') accepted_at_exact
         FROM finnor_os.epistemic_changes c WHERE c.tenant_id=$1 AND c.id=$2 FOR UPDATE OF c`, [tenantId,changeId]);
      const change = changes.rows[0];
      if (!change) throw new Error("Unknown or cross-tenant epistemic change");
      const completed = await client.query<{ id: string }>(
        "SELECT id FROM finnor_os.epistemic_changesets WHERE tenant_id=$1 AND change_id=$2", [tenantId,changeId]);
      if (change.status === "processed") {
        if (!completed.rows[0]) throw new Error("Processed epistemic change lacks immutable ChangeSet");
        return { kind: "complete", changesetId: completed.rows[0].id };
      }
      const earliest = await client.query<{ id: string }>(
        `SELECT id FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND status<>'processed'
         ORDER BY ingestion_order LIMIT 1`, [tenantId]);
      if (earliest.rows[0]?.id !== changeId || (control.processing_change_id && control.processing_change_id !== changeId)) {
        return { kind: "waiting", reason: "EARLIER_CHANGE_PENDING" };
      }
      if (change.graph_version_id !== control.graph_version_id) throw new Error("Graph version changed with an accepted obligation pending");
      if (change.status === "pending") {
        await client.query("UPDATE finnor_os.epistemic_changes SET status='processing' WHERE tenant_id=$1 AND id=$2", [tenantId,changeId]);
        await client.query("UPDATE finnor_os.epistemic_runtime_controls SET processing_change_id=$2,updated_at=clock_timestamp() WHERE tenant_id=$1", [tenantId,changeId]);
      }
      if (change.source_kind === "freshness") {
        await client.query(`INSERT INTO finnor_os.epistemic_frontier(tenant_id,change_id,proposition_id)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId,changeId,change.target_proposition_id]);
      } else if (change.source_kind === "canonical_entity_version" || change.source_kind === "evidence_source_version") {
        await client.query(`INSERT INTO finnor_os.epistemic_frontier(tenant_id,change_id,proposition_id)
          SELECT $1,$2,b.proposition_id FROM finnor_os.epistemic_source_bindings b
          WHERE b.tenant_id=$1 AND b.graph_version_id=$3 AND b.source_kind=$4
            AND b.source_type=$5 AND b.source_id=$6 ON CONFLICT DO NOTHING`,
          [tenantId,changeId,change.graph_version_id,
            change.source_kind === "canonical_entity_version" ? "canonical_entity" : "evidence_source",
            change.source_type,change.source_entity_id]);
      } else {
        throw new Error(`Unsupported durable epistemic change kind ${change.source_kind}`);
      }
      const frontier = await client.query<{ proposition_id: string }>(
        `SELECT f.proposition_id FROM finnor_os.epistemic_frontier f
         WHERE f.tenant_id=$1 AND f.change_id=$2 AND f.status='pending'
           AND NOT EXISTS (SELECT 1 FROM finnor_os.epistemic_proposition_dependencies d
             JOIN finnor_os.epistemic_frontier parent ON parent.tenant_id=f.tenant_id
               AND parent.change_id=f.change_id AND parent.proposition_id=d.depends_on_proposition_id
               AND parent.status='pending'
             WHERE d.tenant_id=f.tenant_id AND d.graph_version_id=$3 AND d.proposition_id=f.proposition_id)
         ORDER BY f.proposition_id LIMIT 1 FOR UPDATE OF f`, [tenantId,changeId,change.graph_version_id]);
      const propositionId = frontier.rows[0]?.proposition_id;
      if (!propositionId) {
        const remaining = await client.query(`SELECT 1 FROM finnor_os.epistemic_frontier WHERE tenant_id=$1 AND change_id=$2 AND status='pending' LIMIT 1`, [tenantId,changeId]);
        if (remaining.rowCount) throw new Error("Epistemic frontier cannot make topological progress");
        const changesetId = await finalizeDurableChange(client,tenantId,change,control);
        return { kind: "complete", changesetId };
      }
      const before = await client.query<{ belief: CurrentBelief; semantic_hash: string }>(
        `SELECT belief,semantic_hash FROM finnor_os.epistemic_current
         WHERE tenant_id=$1 AND graph_version_id=$2 AND proposition_id=$3 FOR UPDATE`,
        [tenantId,change.graph_version_id,propositionId]);
      if (!before.rows[0]) throw new Error("Epistemic proposition missing after completed baseline");
      const knownAt = change.accepted_at_exact;
      const after = await evaluateStoredProposition(client,tenantId,change.graph_version_id,propositionId,
        knownAt,Number(change.ingestion_order));
      await writeCurrent(client,tenantId,change.graph_version_id,propositionId,after,knownAt,changeId);
      await client.query(`UPDATE finnor_os.epistemic_frontier
        SET status='evaluated',before_belief=$4,after_belief=$5,after_semantic_hash=$6,
          next_freshness_at=$7,evaluated_at=clock_timestamp()
        WHERE tenant_id=$1 AND change_id=$2 AND proposition_id=$3`,
        [tenantId,changeId,propositionId,before.rows[0].belief,after.belief,
          after.belief.semanticHash,after.nextFreshnessAt]);
      if (before.rows[0].semantic_hash !== after.belief.semanticHash) {
        const children = await client.query<{ proposition_id: string; kind: PropositionDependency["kind"] }>(
          `SELECT proposition_id,kind FROM finnor_os.epistemic_proposition_dependencies
           WHERE tenant_id=$1 AND graph_version_id=$2 AND depends_on_proposition_id=$3
           ORDER BY proposition_id,kind`, [tenantId,change.graph_version_id,propositionId]);
        for (const child of children.rows) {
          await client.query(`INSERT INTO finnor_os.epistemic_frontier
            (tenant_id,change_id,proposition_id,cause_proposition_id,cause_dependency_kind)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [tenantId,changeId,child.proposition_id,propositionId,child.kind]);
          await client.query(`INSERT INTO finnor_os.epistemic_frontier_causes
            (tenant_id,change_id,proposition_id,cause_proposition_id,dependency_kind)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [tenantId,changeId,child.proposition_id,propositionId,child.kind]);
        }
      }
      return { kind: "evaluated" };
    });
    if (step.kind === "complete") return { complete: true, evaluated, changesetId: step.changesetId };
    if (step.kind === "waiting") return { complete: false, evaluated, reason: step.reason };
  }
  return { complete: false, evaluated, reason: "FRONTIER_REMAINS" };
}

async function finalizeDurableChange(client: PoolClient, tenantId: string, change: ChangeRow,
  control: ControlRow): Promise<string> {
  const graph = await client.query<{ rule_version: string; heuristic_version: string }>(
    "SELECT rule_version,heuristic_version FROM finnor_os.epistemic_graph_versions WHERE tenant_id=$1 AND id=$2",
    [tenantId,change.graph_version_id]);
  if (!graph.rows[0] || graph.rows[0].heuristic_version !== EPISTEMIC_HEURISTIC_VERSION) throw new Error("Unsupported durable graph rule/heuristic fence");
  const rows = await client.query<{ proposition_id: string; before_belief: CurrentBelief | null; after_belief: CurrentBelief;
    causes: Array<{ propositionId: string; kind: string }> }>(
    `SELECT f.proposition_id,f.before_belief,f.after_belief,
      coalesce((SELECT jsonb_agg(jsonb_build_object('propositionId',c.cause_proposition_id,'kind',c.dependency_kind)
        ORDER BY c.cause_proposition_id,c.dependency_kind) FROM finnor_os.epistemic_frontier_causes c
        WHERE c.tenant_id=f.tenant_id AND c.change_id=f.change_id AND c.proposition_id=f.proposition_id),'[]'::jsonb) causes
     FROM finnor_os.epistemic_frontier f WHERE f.tenant_id=$1 AND f.change_id=$2
     ORDER BY f.proposition_id`, [tenantId,change.id]);
  const deltas = rows.rows.filter((row) => row.before_belief?.semanticHash !== row.after_belief.semanticHash)
    .map((row) => ({ propositionId: row.proposition_id, before: row.before_belief,
      after: row.after_belief, causes: row.causes,
      reasonCode: row.after_belief.reasonCode }));
  const materiality = classifyDurableMateriality(deltas);
  const operational = control.mode === "active" && !control.kill_switch && Boolean(control.shadow_verified_at)
    && control.graph_structure_epoch === control.staged_structure_epoch;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO finnor_os.epistemic_changesets
      (tenant_id,change_id,graph_version_id,rule_version,heuristic_version,semantic_deltas,materiality,operational_enabled)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(tenant_id,change_id) DO NOTHING RETURNING id`,
    [tenantId,change.id,change.graph_version_id,graph.rows[0].rule_version,
      graph.rows[0].heuristic_version,JSON.stringify(deltas),materiality,operational]);
  const changesetId = inserted.rows[0]?.id ?? (await client.query<{ id: string }>(
    `SELECT id FROM finnor_os.epistemic_changesets WHERE tenant_id=$1 AND change_id=$2`,
    [tenantId,change.id])).rows[0]?.id;
  if (!changesetId) throw new Error("Failed to materialize immutable epistemic ChangeSet");
  await writeExactImpacts(client,tenantId,change,changesetId,deltas,graph.rows[0].rule_version);
  await client.query("UPDATE finnor_os.epistemic_changes SET status='processed',processed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [tenantId,change.id]);
  await client.query("UPDATE finnor_os.epistemic_runtime_controls SET processing_change_id=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND processing_change_id=$2", [tenantId,change.id]);
  return changesetId;
}

interface SemanticDelta { propositionId: string; before: CurrentBelief | null; after: CurrentBelief;
  causes: Array<{ propositionId: string; kind: string }>; reasonCode: string }

function classifyDurableMateriality(deltas: SemanticDelta[]): Record<string, unknown> {
  const byProposition = deltas.map((delta) => {
    const canonicalWinnerChanged = delta.before?.sourceTruthClass === "CANONICAL"
      && delta.after.sourceTruthClass === "CANONICAL" && delta.before.valueHash !== delta.after.valueHash;
    const unresolved = delta.before?.status === "KNOWN" && delta.after.status !== "KNOWN";
    const classification = canonicalWinnerChanged || unresolved ? "blocking"
      : delta.before?.status !== delta.after.status || delta.before?.valueHash !== delta.after.valueHash ? "review" : "informational";
    return { propositionId: delta.propositionId, classification,
      reasonCode: canonicalWinnerChanged ? "CANONICAL_VALUE_CHANGED" : unresolved ? "KNOWN_BECAME_UNRESOLVED"
        : classification === "review" ? "BELIEF_VALUE_OR_STATUS_CHANGED" : "PROVENANCE_OR_CONFLICT_CHANGED" };
  });
  return { ruleVersion: MATERIALITY_RULE_VERSION, byProposition };
}

async function writeExactImpacts(client: PoolClient, tenantId: string, change: ChangeRow,
  changesetId: string, deltas: SemanticDelta[], ruleVersion: string): Promise<void> {
  type ImpactKind = "pe_assumption" | "underwriting_model_input" | "underwriting_model_node" | "underwriting_run"
    | "pe_finding" | "pe_deal_risk" | "pe_ic_question" | "pe_ic_condition" | "pe_ic_decision" | "pe_decision" | "work_plan_node";
  type Materiality = "informational" | "review" | "blocking";
  const byId = new Map((classifyDurableMateriality(deltas).byProposition as Array<{
    propositionId: string; classification: Materiality }>).map((row) => [row.propositionId,row.classification]));
  let evidenceSourceId = change.source_kind === "evidence_source_version" ? change.source_entity_id : null;
  let evidenceVersionId = change.source_kind === "evidence_source_version" ? change.source_version_id : null;
  if (change.source_kind === "canonical_entity_version" && change.source_version_id) {
    const canonical = await client.query<{ evidence_source_id: string | null; evidence_version_id: string | null }>(
      `SELECT snapshot->>'evidence_source_id' evidence_source_id,
         snapshot->>'evidence_version_id' evidence_version_id
       FROM finnor_os.canonical_entity_versions
       WHERE tenant_id=$1 AND id=$2 AND entity_type=$3 AND entity_id=$4`,
      [tenantId,change.source_version_id,change.source_type,change.source_entity_id]);
    if (!canonical.rows[0]) throw new Error("Changed canonical source version is unavailable in its tenant");
    const sourceId = canonical.rows[0].evidence_source_id;
    const versionId = canonical.rows[0].evidence_version_id;
    if ((sourceId === null) !== (versionId === null)) throw new Error("Canonical evidence reference is incomplete");
    if (sourceId && versionId) {
      const exact = await client.query(
        `SELECT 1 FROM finnor_os.evidence_source_versions
         WHERE id=$1::uuid AND source_id=$2::uuid AND (tenant_id=$3 OR scope='public')`,
        [versionId,sourceId,tenantId]);
      if (!exact.rowCount) throw new Error("Canonical evidence reference crosses its source or tenant");
      evidenceSourceId = sourceId;
      evidenceVersionId = versionId;
    }
  }
  const add = async (propositionId: string, kind: ImpactKind, objectId: string, edgeKind: string,
    ownerTable: string, ownerId: string, materiality: Materiality,
    consequence: "none" | "review_required" | "rerun_required" | "replan_required" | "block_consequential",
    extra: Array<Record<string,string>> = []): Promise<void> => {
    const path = [
      { kind: "source_change", id: change.id, sourceVersionId: change.source_version_id ?? "clock" },
      ...(change.source_kind === "canonical_entity_version" && evidenceVersionId
        ? [{ kind:"canonical_evidence_reference",id:evidenceVersionId }] : []),
      { kind: "proposition", id: propositionId },
      ...extra,
      { kind: edgeKind, ownerTable, ownerId, objectKind: kind, objectId },
    ];
    await client.query(`INSERT INTO finnor_os.epistemic_impact_paths
      (tenant_id,changeset_id,proposition_id,object_kind,object_id,edge_kind,path,materiality,consequence,rule_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [tenantId,changesetId,propositionId,kind,objectId,edgeKind,JSON.stringify(path),materiality,consequence,ruleVersion]);
  };
  const bounded = async <T extends Record<string, unknown>>(sql: string, args: unknown[]): Promise<T[]> => {
    const rows = (await client.query<T>(sql,args)).rows;
    if (rows.length > 1000) throw new Error("Exact epistemic impact fanout exceeds bounded transaction; defer without certifying incomplete impact");
    return rows;
  };
  for (const delta of deltas) {
    const propositionId = delta.propositionId;
    const classification = byId.get(propositionId) ?? "informational";
    const subject = (await client.query<{ subject: { type: string; id?: string } }>(
      `SELECT subject FROM finnor_os.epistemic_propositions WHERE tenant_id=$1 AND graph_version_id=$2 AND proposition_id=$3`,
      [tenantId,change.graph_version_id,propositionId])).rows[0]?.subject;
    if (!subject) throw new Error("Changed proposition has no frozen definition");
    const subjectId = subject.id ?? "";
    const directKind: Record<string, ImpactKind> = {
      pe_assumption: "pe_assumption", pe_finding: "pe_finding", pe_deal_risk: "pe_deal_risk", pe_decision: "pe_decision",
    };
    if (directKind[subject.type] && subjectId) {
      const table = subject.type === "pe_assumption" ? "pe_assumptions" : subject.type === "pe_finding" ? "pe_findings"
        : subject.type === "pe_deal_risk" ? "pe_deal_risks" : "pe_decisions";
      const row = await client.query<{ id: string; materiality?: string }>(
        `SELECT id${table === "pe_assumptions" ? ",materiality" : ""} FROM finnor_os.${table} WHERE tenant_id=$1 AND id=$2`,
        [tenantId,subjectId]);
      if (row.rows[0]) {
        const fromOwner = row.rows[0].materiality;
        const severity: Materiality = fromOwner === "critical" || fromOwner === "high" ? "blocking" : classification;
        await add(propositionId,directKind[subject.type]!,subjectId,"claim_subject",table,subjectId,severity,
          severity === "blocking" ? "review_required" : severity === "review" ? "review_required" : "none");
      }
    }
    if (subject.type === "pe_finding" && subjectId) {
      const risks = await bounded<{ id: string; deal_risk_id: string }>(
        `SELECT id,deal_risk_id FROM finnor_os.pe_finding_risk_links WHERE tenant_id=$1 AND finding_id=$2 AND archived_at IS NULL ORDER BY id LIMIT 1001`,
        [tenantId,subjectId]);
      for (const risk of risks) await add(propositionId,"pe_deal_risk",risk.deal_risk_id,"finding_risk_link",
        "pe_finding_risk_links",risk.id,classification,classification === "informational" ? "none" : "review_required");
    }
    if (evidenceSourceId) {
      const links = await bounded<{ id: string; entity_type: string; entity_id: string }>(
        `SELECT id,entity_type,entity_id FROM finnor_os.pe_evidence_links
         WHERE tenant_id=$1 AND evidence_source_id=$2 AND archived_at IS NULL
           AND (evidence_version_id IS NULL OR evidence_version_id=$3)
         ORDER BY id LIMIT 1001`, [tenantId,evidenceSourceId,evidenceVersionId]);
      for (const link of links) {
        const kind = directKind[link.entity_type];
        if (kind) await add(propositionId,kind,link.entity_id,"pe_evidence_link","pe_evidence_links",link.id,
          classification,classification === "informational" ? "none" : "review_required");
      }
    }
    const inputRows = await bounded<{ id: string; model_version_id: string; input_node_id: string;
      model_definition: UnderwritingModelIR }>(
      `SELECT b.id,b.model_version_id,b.input_node_id,m.model_definition
       FROM finnor_os.underwriting_model_input_bindings b
       JOIN finnor_os.underwriting_model_versions m ON m.tenant_id=b.tenant_id AND m.id=b.model_version_id
       WHERE b.tenant_id=$1 AND (
         (b.source_kind='p1_assumption' AND b.assumption_id=$2::uuid)
         OR (b.source_kind='evidence_version' AND (
           ($5='canonical_entity_version' AND b.evidence_version_id=$4::uuid)
           OR ($5='evidence_source_version' AND b.evidence_version_id IN
             (SELECT id FROM finnor_os.evidence_source_versions WHERE source_id=$3::uuid AND (tenant_id=$1 OR scope='public'))))))
       ORDER BY b.id LIMIT 1001`,
      [tenantId,subject.type === "pe_assumption" && subjectId ? subjectId : null,
        evidenceSourceId,evidenceVersionId,change.source_kind]);
    const runIds = new Set<string>();
    for (const input of inputRows) {
      const nodeId = `${input.model_version_id}:${input.input_node_id}`;
      await add(propositionId,"underwriting_model_input",nodeId,"underwriting_input_binding",
        "underwriting_model_input_bindings",input.id,classification,
        classification === "informational" ? "none" : "rerun_required");
      const compiled = compileUnderwritingModel(input.model_definition);
      for (const affected of affectedNodes(compiled,[input.input_node_id])) {
        await add(propositionId,"underwriting_model_node",`${input.model_version_id}:${affected}`,"underwriting_model_edge",
          "underwriting_model_versions",input.model_version_id,classification,
          classification === "informational" ? "none" : "rerun_required",
          [{ kind: "underwriting_input_binding", id: input.id }, { kind: "model_node", id: input.input_node_id }]);
      }
      const runs = await bounded<{ id: string }>(
        `SELECT id FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND model_version_id=$2 ORDER BY id LIMIT 1001`,
        [tenantId,input.model_version_id]);
      for (const run of runs) {
        runIds.add(run.id);
        await add(propositionId,"underwriting_run",run.id,"underwriting_run_model_version",
          "underwriting_runs",run.id,classification,
          classification === "informational" ? "none" : "rerun_required",
          [{ kind: "underwriting_input_binding", id: input.id }]);
      }
    }
    const icLinks = await bounded<{ id: string; owner_kind: string; owner_id: string; ic_case_id: string }>(
      `SELECT id,owner_kind,owner_id,ic_case_id FROM finnor_os.pe_ic_source_links
       WHERE tenant_id=$1 AND (
         (source_kind='P1_WORLD' AND world_entity_type=$2 AND world_entity_id=$3::uuid)
         OR (source_kind='EVIDENCE_VERSION' AND evidence_version_id=$4::uuid)
         OR (source_kind='PE_RISK' AND pe_risk_id=$5::uuid)
         OR (source_kind='UNDERWRITING_RUN' AND underwriting_run_id=ANY($6::uuid[])))
       ORDER BY id LIMIT 1001`,
      [tenantId,subject.type,subjectId || null,evidenceVersionId,
        subject.type === "pe_deal_risk" ? subjectId : null,[...runIds]]);
    for (const link of icLinks) {
      if (link.owner_kind === "QUESTION") await add(propositionId,"pe_ic_question",link.owner_id,"ic_source_link",
        "pe_ic_source_links",link.id,classification,classification === "informational" ? "none" : "review_required");
      if (link.owner_kind === "CONDITION") await add(propositionId,"pe_ic_condition",link.owner_id,"ic_source_link",
        "pe_ic_source_links",link.id,classification,classification === "informational" ? "none" : "review_required");
      // Case membership alone does not prove that this source supported a
      // finalized vote. Follow only proposal recommendation identity or the
      // explicit decision-condition link recorded by the IC owner.
      const decisions = await bounded<{ id: string; decision_id: string; proposal_id: string }>(
        `SELECT dl.id,dl.decision_id,dl.decision_proposal_id proposal_id
         FROM finnor_os.pe_ic_decision_links dl
         JOIN finnor_os.pe_ic_decision_proposals proposal ON proposal.tenant_id=dl.tenant_id
           AND proposal.id=dl.decision_proposal_id
         WHERE dl.tenant_id=$1 AND dl.ic_case_id=$2 AND (
           ($3='RECOMMENDATION' AND proposal.recommendation_id=$4::uuid)
           OR ($3='CONDITION' AND EXISTS (
             SELECT 1 FROM finnor_os.pe_ic_decision_condition_links condition_link
             WHERE condition_link.tenant_id=dl.tenant_id AND condition_link.decision_link_id=dl.id
               AND condition_link.condition_id=$4::uuid)))
         ORDER BY dl.id LIMIT 1001`,
        [tenantId,link.ic_case_id,link.owner_kind,link.owner_id]);
      for (const decision of decisions) {
        await add(propositionId,"pe_ic_decision",decision.id,"ic_case_decision_link",
          "pe_ic_decision_links",decision.id,classification,"review_required",
          [{ kind:"ic_source_link",id:link.id },{ kind:"ic_decision_proposal",id:decision.proposal_id }]);
        await add(propositionId,"pe_decision",decision.decision_id,"ic_final_pe_decision",
          "pe_ic_decision_links",decision.id,classification,"review_required",
          [{ kind:"ic_source_link",id:link.id },{ kind:"ic_decision_proposal",id:decision.proposal_id }]);
      }
    }
    const pins = await bounded<{ plan_revision_id: string; plan_node_id: string; mandatory: boolean }>(
      `SELECT p.plan_revision_id,p.plan_node_id,p.mandatory FROM finnor_os.epistemic_plan_pins p
       JOIN finnor_os.work_plan_revisions r ON r.tenant_id=p.tenant_id AND r.id=p.plan_revision_id
       WHERE p.tenant_id=$1 AND p.graph_version_id=$2 AND p.proposition_id=$3 AND r.status='active'
       ORDER BY p.plan_revision_id,p.plan_node_id LIMIT 1001`, [tenantId,change.graph_version_id,propositionId]);
    for (const pin of pins) {
      const severity: Materiality = classification === "blocking" && pin.mandatory ? "blocking" : "review";
      await add(propositionId,"work_plan_node",`${pin.plan_revision_id}:${pin.plan_node_id}`,
        "work_plan_epistemic_pin","epistemic_plan_pins",pin.plan_revision_id,severity,
        severity === "blocking" ? "block_consequential" : "replan_required");
    }
  }
}

/** Indexed due rows, one immutable clock change and one Scope-3 job per deadline.
 * A repeated scan is idempotent; execution still lazily checks a due deadline. */
export async function scanDueEpistemicFreshness(tenantId: string, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Freshness scan limit must be 1..100");
  return withTenantTransaction(tenantId, {}, async (_db, client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5141))", [tenantId]);
    const controls = await client.query<ControlRow>("SELECT * FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
    const control = controls.rows[0];
    if (!control?.baseline_completed_at) return 0;
    const due = await client.query<{ proposition_id: string; next_freshness_at: Date }>(
      `SELECT proposition_id,next_freshness_at FROM finnor_os.epistemic_current
       WHERE tenant_id=$1 AND graph_version_id=$2 AND next_freshness_at<=clock_timestamp()
       ORDER BY next_freshness_at,proposition_id LIMIT $3`, [tenantId,control.graph_version_id,limit]);
    let inserted = 0;
    for (const row of due.rows) {
      const key = `freshness:${control.graph_version_id}:${row.proposition_id}:${iso(row.next_freshness_at)}`;
      const change = await client.query<{ id: string }>(
        `INSERT INTO finnor_os.epistemic_changes
          (tenant_id,graph_version_id,semantic_key,source_kind,source_owner,target_proposition_id,known_at,valid_at)
         VALUES($1,$2,$3,'freshness','@finnor/epistemic-runtime',$4,clock_timestamp(),clock_timestamp())
         ON CONFLICT(tenant_id,semantic_key) DO NOTHING RETURNING id`,
        [tenantId,control.graph_version_id,key,row.proposition_id]);
      if (!change.rows[0]) continue;
      await client.query(`INSERT INTO finnor_os.jobs
        (tenant_id,type,payload,idempotency_key,protocol_version,lane,max_attempts)
        VALUES($1,'process_epistemic_change_v2',$2,$3,2,'batch',10)`,
        [tenantId,{ tenantId,changeId: change.rows[0].id,schemaVersion: 2 },`epistemic-change:${change.rows[0].id}`]);
      if (control.mode === "shadow") {
        await client.query(`UPDATE finnor_os.epistemic_runtime_controls
          SET shadow_verified_at=NULL,shadow_verified_change_order=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1`, [tenantId]);
      }
      inserted += 1;
    }
    return inserted;
  });
}

/** A bounded backstop for lost physical deliveries or terminal queue attempts.
 * The logical change and ChangeSet identities never change. */
export async function recoverAcceptedEpistemicChanges(tenantId: string, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Recovery limit must be 1..100");
  return withTenantTransaction(tenantId, {}, async (_db, client) => {
    const rows = await client.query<{ id: string; deliveries: string }>(
      `SELECT c.id,(SELECT count(*)::text FROM finnor_os.jobs j
        WHERE j.tenant_id=c.tenant_id AND j.type='process_epistemic_change_v2'
          AND j.payload->>'changeId'=c.id::text) deliveries
       FROM finnor_os.epistemic_changes c WHERE c.tenant_id=$1 AND c.status<>'processed'
         AND NOT EXISTS (SELECT 1 FROM finnor_os.jobs j WHERE j.tenant_id=c.tenant_id
           AND j.type='process_epistemic_change_v2' AND j.payload->>'changeId'=c.id::text
           AND j.status IN ('queued','running'))
       ORDER BY c.ingestion_order LIMIT $2 FOR UPDATE OF c SKIP LOCKED`, [tenantId,limit]);
    let inserted = 0;
    for (const row of rows.rows) {
      const delivery = Number(row.deliveries);
      await client.query(`INSERT INTO finnor_os.jobs
        (tenant_id,type,payload,idempotency_key,protocol_version,lane,max_attempts)
        VALUES($1,'process_epistemic_change_v2',$2,$3,2,'batch',10)
        ON CONFLICT(idempotency_key) DO NOTHING`,
        [tenantId,{ tenantId,changeId: row.id,schemaVersion: 2 },`epistemic-change:${row.id}:recovery:${delivery}`]);
      inserted += 1;
    }
    return inserted;
  });
}

export interface DurablePinRequirement {
  propositionId: string;
  expectedValues: readonly JsonValue[];
  mandatory: boolean;
  acceptableStatuses: readonly PropositionStatus[];
  minimumAuthority: readonly SourceAuthority[];
  minimumConfidence: ConfidenceLevel;
}

export interface DurablePinResult {
  mode: "unconfigured" | "disabled" | "shadow" | "active" | "refreshing";
  operational: boolean;
  allowed: boolean;
  graphVersionId?: string;
  pinned: Array<{ propositionId: string; semanticHash: string }>;
  reasonCodes: string[];
}

export async function compareEpistemicAssessmentToOutcome(input: {
  tenantId: string;
  assessmentId: string;
  outcomeId: string;
  valuePath: string;
  comparisonRuleVersion?: "exact-json-path-v1";
}): Promise<{ comparison: "SUPPORTED" | "CONTRADICTED" | "INCONCLUSIVE"; comparisonRuleVersion: string; idempotent: boolean }> {
  if (!/^[A-Za-z0-9_.-]{1,240}$/.test(input.valuePath)) throw new Error("Calibration outcome path is invalid");
  const ruleVersion = input.comparisonRuleVersion ?? "exact-json-path-v1";
  return withTenantTransaction(input.tenantId, { isolation:"serializable" }, async (_db,client) => {
    const assessment = (await client.query<{ decision_id: string; assessed_at: Date; belief_value_hash: string }>(
      `SELECT decision_id,assessed_at,belief_value_hash FROM finnor_os.epistemic_calibration_assessments
       WHERE tenant_id=$1 AND id=$2 FOR SHARE`,[input.tenantId,input.assessmentId])).rows[0];
    const outcome = (await client.query<{ decision_id: string | null; observed_value: unknown; observed_at: Date;
      valid_from: Date; created_at: Date }>(
      `SELECT decision_id,observed_value,observed_at,valid_from,created_at FROM finnor_os.pe_outcomes
       WHERE tenant_id=$1 AND id=$2 FOR SHARE`,[input.tenantId,input.outcomeId])).rows[0];
    if (!assessment || !outcome) throw new Error("Calibration assessment or outcome is missing/cross-tenant");
    const selected = pathValue(outcome.observed_value,input.valuePath);
    const decisionConsistent = outcome.decision_id === assessment.decision_id;
    const temporalOrder = outcome.created_at.getTime() >= assessment.assessed_at.getTime()
      && outcome.observed_at.getTime() >= assessment.assessed_at.getTime()
      && outcome.valid_from.getTime() >= assessment.assessed_at.getTime();
    const observedValueHash = selected.present ? durableDeterministicValueHash(selected.value!) : null;
    const comparison = !decisionConsistent || !temporalOrder || !observedValueHash
      ? "INCONCLUSIVE" as const
      : observedValueHash === assessment.belief_value_hash ? "SUPPORTED" as const : "CONTRADICTED" as const;
    const facts = { valuePath:input.valuePath,assessmentValueHash:assessment.belief_value_hash,
      observedValueHash,decisionConsistent,temporalOrder,
      reasonCode:!decisionConsistent ? "OUTCOME_DECISION_MISMATCH" : !temporalOrder ? "OUTCOME_NOT_LATER"
        : !observedValueHash ? "OUTCOME_PATH_UNAVAILABLE" : comparison === "SUPPORTED" ? "EXACT_VALUE_SUPPORTED" : "EXACT_VALUE_CONTRADICTED" };
    const inserted = await client.query<{ comparison: "SUPPORTED"|"CONTRADICTED"|"INCONCLUSIVE"; comparison_rule_version: string }>(
      `INSERT INTO finnor_os.epistemic_calibration_outcomes
        (tenant_id,assessment_id,outcome_id,comparison,comparison_rule_version,comparison_facts)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,assessment_id,outcome_id) DO NOTHING
       RETURNING comparison,comparison_rule_version`,
      [input.tenantId,input.assessmentId,input.outcomeId,comparison,ruleVersion,facts]);
    if (inserted.rows[0]) return { comparison:inserted.rows[0].comparison,
      comparisonRuleVersion:inserted.rows[0].comparison_rule_version,idempotent:false };
    const existing = (await client.query<{ comparison: "SUPPORTED"|"CONTRADICTED"|"INCONCLUSIVE";
      comparison_rule_version: string; comparison_facts: Record<string,unknown> }>(
      `SELECT comparison,comparison_rule_version,comparison_facts FROM finnor_os.epistemic_calibration_outcomes
       WHERE tenant_id=$1 AND assessment_id=$2 AND outcome_id=$3`,
      [input.tenantId,input.assessmentId,input.outcomeId])).rows[0];
    if (!existing || existing.comparison_rule_version !== ruleVersion || canonicalJson(existing.comparison_facts) !== canonicalJson(facts)) {
      throw new Error("Immutable calibration comparison identity conflicts with requested rule");
    }
    return { comparison:existing.comparison,comparisonRuleVersion:existing.comparison_rule_version,idempotent:true };
  });
}

const CONFIDENCE_ORDER: Record<ConfidenceLevel, number> = {
  VERIFIED: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNSUPPORTED: 4,
};

/** Freeze the exact durable semantic hashes used by one selected PlanNode. In
 * shadow mode mismatches are reported without changing operational behavior. In
 * active mode every mandatory requirement must resolve against the current
 * graph before an immutable pin is accepted. */
export async function pinCurrentEpistemicRequirements(input: {
  tenantId: string;
  planRevisionId?: string | null;
  planNodeId?: string | null;
  actionType: string;
  requirements: readonly DurablePinRequirement[];
}): Promise<DurablePinResult> {
  const ids = [...new Set(input.requirements.map((row) => row.propositionId))].sort();
  if (ids.length !== input.requirements.length) throw new Error("Duplicate epistemic pin requirement");
  return withTenantTransaction(input.tenantId, { isolation: "serializable" }, async (_db, client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5141))", [input.tenantId]);
    const control = (await client.query<ControlRow>(
      "SELECT * FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1 FOR SHARE", [input.tenantId])).rows[0];
    const empty = (mode: DurablePinResult["mode"], operational: boolean, reasonCodes: string[]): DurablePinResult => ({
      mode,operational,allowed: !operational,pinned: [],reasonCodes: [...new Set(reasonCodes)].sort(),
      ...(control ? { graphVersionId: control.graph_version_id } : {}),
    });
    if (!control) return empty("unconfigured",false,["EPISTEMIC_DURABLE_GRAPH_UNCONFIGURED"]);
    if (control.mode === "disabled" || control.kill_switch) return empty("disabled",false,["EPISTEMIC_OPERATIONAL_MODE_DISABLED"]);
    const operational = control.mode === "active" || control.mode === "refreshing";
    const mode: DurablePinResult["mode"] = control.mode;
    const reasons = new Set<string>();
    if (control.mode === "refreshing" || control.graph_structure_epoch !== control.staged_structure_epoch) {
      reasons.add("EPISTEMIC_GRAPH_REFRESH_REQUIRED");
    }
    if (!input.planRevisionId || !input.planNodeId) reasons.add("EPISTEMIC_PLAN_PIN_REQUIRED");
    if (!control.baseline_completed_at) reasons.add("EPISTEMIC_BASELINE_INCOMPLETE");
    if (control.processing_change_id) reasons.add("EPISTEMIC_CHANGE_PENDING");
    const pending = await client.query(
      "SELECT 1 FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND status<>'processed' LIMIT 1", [input.tenantId]);
    if (pending.rowCount) reasons.add("EPISTEMIC_CHANGE_PENDING");
    if (input.planRevisionId && input.planNodeId) {
      const plan = await client.query<{ status: string; node_exists: boolean }>(
        `SELECT r.status,EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r.plan_graph->'nodes','[]'::jsonb)) n
          WHERE n->>'id'=$3 AND n->>'kind'='action' AND n->>'actionType'=$4) node_exists
         FROM finnor_os.work_plan_revisions r WHERE r.tenant_id=$1 AND r.id=$2`,
        [input.tenantId,input.planRevisionId,input.planNodeId,input.actionType]);
      if (!plan.rows[0]?.node_exists) reasons.add("EPISTEMIC_PLAN_NODE_MISMATCH");
      if (plan.rows[0]?.status !== "active") reasons.add("EPISTEMIC_PLAN_REVISION_INACTIVE");
    }
    const current = ids.length === 0 ? { rows: [] as Array<{ proposition_id: string; semantic_hash: string;
      next_freshness_at: Date | null; belief: CurrentBelief }> }
      : await client.query<{ proposition_id: string; semantic_hash: string; next_freshness_at: Date | null; belief: CurrentBelief }>(
        `SELECT proposition_id,semantic_hash,next_freshness_at,belief FROM finnor_os.epistemic_current
         WHERE tenant_id=$1 AND graph_version_id=$2 AND proposition_id=ANY($3::text[]) ORDER BY proposition_id`,
        [input.tenantId,control.graph_version_id,ids]);
    const byId = new Map(current.rows.map((row) => [row.proposition_id,row]));
    for (const requirement of input.requirements) {
      const row = byId.get(requirement.propositionId);
      if (!row) { reasons.add("EPISTEMIC_PROPOSITION_UNAVAILABLE"); continue; }
      if (!requirement.acceptableStatuses.includes(row.belief.status)) reasons.add("MANDATORY_EPISTEMIC_UNRESOLVED");
      if (!requirement.expectedValues.map(durableDeterministicValueHash).includes(row.belief.valueHash)) {
        reasons.add("EPISTEMIC_EXPECTED_VALUE_MISMATCH");
      }
      if (!row.belief.sourceAuthority || !requirement.minimumAuthority.includes(row.belief.sourceAuthority)) {
        reasons.add("EPISTEMIC_AUTHORITY_INSUFFICIENT");
      }
      if (CONFIDENCE_ORDER[row.belief.confidence.level] > CONFIDENCE_ORDER[requirement.minimumConfidence]) {
        reasons.add("EPISTEMIC_CONFIDENCE_INSUFFICIENT");
      }
      if (row.next_freshness_at && row.next_freshness_at.getTime() <= Date.now()) reasons.add("EPISTEMIC_FRESHNESS_DUE");
    }
    if (reasons.size) return {
      mode,operational,allowed: !operational,graphVersionId: control.graph_version_id,pinned: [],reasonCodes: [...reasons].sort(),
    };
    for (const requirement of input.requirements) {
      const row = byId.get(requirement.propositionId)!;
      await client.query(`INSERT INTO finnor_os.epistemic_plan_pins
        (tenant_id,graph_version_id,plan_revision_id,plan_node_id,proposition_id,pinned_semantic_hash,mandatory)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [input.tenantId,control.graph_version_id,input.planRevisionId,input.planNodeId,
          requirement.propositionId,row.semantic_hash,requirement.mandatory]);
    }
    const pins = await client.query<{ graph_version_id: string; proposition_id: string; pinned_semantic_hash: string }>(
      `SELECT graph_version_id,proposition_id,pinned_semantic_hash FROM finnor_os.epistemic_plan_pins
       WHERE tenant_id=$1 AND plan_revision_id=$2 AND plan_node_id=$3 AND proposition_id=ANY($4::text[])
       ORDER BY proposition_id`,[input.tenantId,input.planRevisionId,input.planNodeId,ids]);
    if (pins.rows.length !== ids.length || pins.rows.some((pin) => pin.graph_version_id !== control.graph_version_id
      || byId.get(pin.proposition_id)?.semantic_hash !== pin.pinned_semantic_hash)) {
      const reasonCodes = ["EPISTEMIC_EXISTING_PIN_CONFLICT"];
      return { mode,operational,allowed: !operational,graphVersionId: control.graph_version_id,pinned: [],reasonCodes };
    }
    return { mode,operational,allowed:true,graphVersionId:control.graph_version_id,
      pinned:pins.rows.map((pin) => ({ propositionId:pin.proposition_id,semanticHash:pin.pinned_semantic_hash })),reasonCodes:[] };
  });
}

/** Read-only gate for exact pinned dependencies. A pending accepted change,
 * freshness deadline or unsupported graph fence blocks only nodes carrying
 * pins. The caller remains the existing Authority/execution owner. */
export async function revalidatePinnedEpistemicNode(input: {
  tenantId: string; planRevisionId: string; planNodeId: string;
}): Promise<{ allowed: boolean; reasonCodes: string[]; propositionIds: string[] }> {
  return withTenantTransaction(input.tenantId, { readOnly: true, isolation: "repeatable read" }, async (_db, client) => {
    const pins = await client.query<{ graph_version_id: string; proposition_id: string; pinned_semantic_hash: string;
      mandatory: boolean; status: string | null; current_hash: string | null; next_freshness_at: Date | null }>(
      `SELECT p.graph_version_id,p.proposition_id,p.pinned_semantic_hash,p.mandatory,
        c.belief->>'status' status,c.semantic_hash current_hash,c.next_freshness_at
       FROM finnor_os.epistemic_plan_pins p LEFT JOIN finnor_os.epistemic_current c
         ON c.tenant_id=p.tenant_id AND c.graph_version_id=p.graph_version_id AND c.proposition_id=p.proposition_id
       WHERE p.tenant_id=$1 AND p.plan_revision_id=$2 AND p.plan_node_id=$3
       ORDER BY p.proposition_id`, [input.tenantId,input.planRevisionId,input.planNodeId]);
    if (!pins.rows.length) return { allowed: true, reasonCodes: [], propositionIds: [] };
    const controls = await client.query<ControlRow>("SELECT * FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1", [input.tenantId]);
    const control = controls.rows[0];
    if (!control || (control.mode !== "active" && control.mode !== "refreshing") || control.kill_switch) {
      return { allowed: true, reasonCodes: ["EPISTEMIC_OPERATIONAL_MODE_DISABLED"], propositionIds: pins.rows.map((row) => row.proposition_id) };
    }
    const pending = await client.query("SELECT 1 FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND status<>'processed' LIMIT 1", [input.tenantId]);
    const reasons = new Set<string>();
    if (control.mode === "refreshing" || control.graph_structure_epoch !== control.staged_structure_epoch) {
      reasons.add("EPISTEMIC_GRAPH_REFRESH_REQUIRED");
    }
    if (pending.rowCount || control.processing_change_id) reasons.add("EPISTEMIC_CHANGE_PENDING");
    for (const pin of pins.rows) {
      if (pin.graph_version_id !== control.graph_version_id) reasons.add("EPISTEMIC_GRAPH_VERSION_STALE");
      if (pin.current_hash !== pin.pinned_semantic_hash) reasons.add("EPISTEMIC_PIN_STALE");
      if (pin.mandatory && pin.status !== "KNOWN") reasons.add("MANDATORY_EPISTEMIC_UNRESOLVED");
      if (pin.next_freshness_at && pin.next_freshness_at.getTime() <= Date.now()) reasons.add("EPISTEMIC_FRESHNESS_DUE");
    }
    return { allowed: reasons.size === 0, reasonCodes: [...reasons].sort(), propositionIds: pins.rows.map((row) => row.proposition_id) };
  });
}

/** Explicit graph identity is mandatory in replay. The typed result makes a
 * pre-baseline request distinguishable from a genuine UNKNOWN proposition. */
export async function replayDurableEpistemicGraph(input: {
  tenantId: string; graphVersionId: string; validAt: string; knownAt: string;
}): Promise<{ status: "AVAILABLE"; state: EpistemicState; ruleVersion: string; heuristicVersion: string }
  | { status: "UNAVAILABLE_BEFORE_BASELINE" | "UNAVAILABLE_AFTER_RETIREMENT" }> {
  return withTenantTransaction(input.tenantId, { readOnly: true, isolation: "repeatable read" }, async (_db, client) => {
    const graph = await client.query<{ rule_version: string; heuristic_version: string;
      before_baseline: boolean; after_retirement: boolean }>(
      `SELECT rule_version,heuristic_version,
         (baseline_at IS NULL OR baseline_at>$3::timestamptz) before_baseline,
         (retired_at IS NOT NULL AND retired_at<$3::timestamptz) after_retirement
       FROM finnor_os.epistemic_graph_versions WHERE tenant_id=$1 AND id=$2`,
      [input.tenantId,input.graphVersionId,input.knownAt]);
    if (!graph.rows[0]) throw new Error("Unknown or cross-tenant historical epistemic graph");
    if (graph.rows[0].before_baseline) {
      return { status: "UNAVAILABLE_BEFORE_BASELINE" };
    }
    if (graph.rows[0].after_retirement) {
      return { status: "UNAVAILABLE_AFTER_RETIREMENT" };
    }
    if (graph.rows[0].heuristic_version !== EPISTEMIC_HEURISTIC_VERSION) throw new Error("Historical heuristic implementation unavailable");
    const definitions = await client.query<{ proposition_id: string; subject: PropositionDefinition["subject"];
      predicate: PropositionDefinition["predicate"] }>(
      `SELECT proposition_id,subject,predicate FROM finnor_os.epistemic_propositions
       WHERE tenant_id=$1 AND graph_version_id=$2 ORDER BY proposition_id`, [input.tenantId,input.graphVersionId]);
    if (definitions.rows.length > MAX_GRAPH_PROPOSITIONS) throw new Error("Historical graph exceeds bounded replay limit");
    const edges = await client.query<{ proposition_id: string; depends_on_proposition_id: string }>(
      `SELECT proposition_id,depends_on_proposition_id FROM finnor_os.epistemic_proposition_dependencies
       WHERE tenant_id=$1 AND graph_version_id=$2 ORDER BY proposition_id,depends_on_proposition_id`,
      [input.tenantId,input.graphVersionId]);
    const byChild = new Map<string,string[]>();
    for (const edge of edges.rows) byChild.set(edge.proposition_id,[...(byChild.get(edge.proposition_id) ?? []),edge.depends_on_proposition_id]);
    const definitionsForOracle: PropositionDefinition[] = definitions.rows.map((row) => ({
      id: row.proposition_id,subject: row.subject,predicate: row.predicate,dependencyRefs: byChild.get(row.proposition_id) ?? [],
    }));
    const order = await client.query<{ order: string }>(
      `SELECT coalesce(max(ingestion_order),0)::text AS "order" FROM finnor_os.epistemic_changes
       WHERE tenant_id=$1 AND graph_version_id=$2 AND accepted_at<=$3`,
      [input.tenantId,input.graphVersionId,input.knownAt]);
    const evidence: EvidenceRecord[] = [];
    for (const definition of definitionsForOracle) {
      evidence.push(...await boundEvidence(client,input.tenantId,input.graphVersionId,definition.id,input.knownAt,Number(order.rows[0]?.order ?? 0)));
    }
    const initial = createEpistemicState({
      scope: { tenantId: input.tenantId,principalId: "system:causal-replay",decisionId: `graph:${input.graphVersionId}` },
      asOf: input.knownAt, propositions: definitionsForOracle,
    });
    const state = appendEvidenceAndRecompute(initial,evidence,input.knownAt,{ validAt: input.validAt,knownAt: input.knownAt });
    return { status: "AVAILABLE",state,ruleVersion: graph.rows[0].rule_version,
      heuristicVersion: graph.rows[0].heuristic_version };
  });
}

/** Full recomputation is the independent shadow gate. It compares all semantic
 * results and never accepts a partial sample as proof of activation readiness. */
export async function compareDurableShadowWithOracle(tenantId: string,
  options: { recordShadowCheckpoint?: boolean } = {}): Promise<{
  equivalent: boolean; checked: number; mismatches: string[]; graphVersionId: string;
}> {
  const snapshot = await withTenantTransaction(tenantId, { readOnly: true, isolation: "repeatable read" }, async (_db, client) => {
    const control = (await client.query<ControlRow>("SELECT * FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1",[tenantId])).rows[0];
    if (!control?.baseline_completed_at) throw new Error("Complete baseline before shadow comparison");
    const pending = await client.query("SELECT 1 FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND status<>'processed' LIMIT 1",[tenantId]);
    if (pending.rowCount || control.processing_change_id) throw new Error("Drain all accepted changes before shadow comparison");
    const due = await client.query(`SELECT 1 FROM finnor_os.epistemic_current WHERE tenant_id=$1 AND graph_version_id=$2
      AND next_freshness_at<=clock_timestamp() LIMIT 1`,[tenantId,control.graph_version_id]);
    if (due.rowCount) throw new Error("Process due freshness before shadow comparison");
    const current = await client.query<{ proposition_id: string; semantic_hash: string }>(
      `SELECT proposition_id,semantic_hash FROM finnor_os.epistemic_current
       WHERE tenant_id=$1 AND graph_version_id=$2 ORDER BY proposition_id`,[tenantId,control.graph_version_id]);
    const at = (await client.query<{ at: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0]!.at;
    const order = await client.query<{ order: string }>(
      `SELECT coalesce(max(ingestion_order),0)::text AS "order" FROM finnor_os.epistemic_changes
       WHERE tenant_id=$1 AND graph_version_id=$2`, [tenantId,control.graph_version_id]);
    return { graphVersionId: control.graph_version_id,current: current.rows,at,
      changeOrder: order.rows[0]?.order ?? "0" };
  });
  const replay = await replayDurableEpistemicGraph({ tenantId,graphVersionId:snapshot.graphVersionId,
    validAt:snapshot.at,knownAt:snapshot.at });
  if (replay.status !== "AVAILABLE") throw new Error("Shadow comparison lacks an honest baseline");
  const mismatches: string[] = [];
  for (const proposition of replay.state.propositions) {
    const conflicts = replay.state.conflicts.filter((entry) => entry.propositionId === proposition.id);
    const actual = hash({ proposition: propositionSemanticFingerprint(proposition),
      conflicts: conflicts.map((conflict) => ({ refs: conflict.evidenceRefs,
        resolution: conflict.resolution,winners: conflict.winningEvidenceRefs,reason: conflict.reasonCode })) });
    const stored = snapshot.current.find((row) => row.proposition_id === proposition.id)?.semantic_hash;
    if (stored !== actual) mismatches.push(proposition.id);
  }
  if (snapshot.current.length !== replay.state.propositions.length) mismatches.push("GRAPH_CARDINALITY_MISMATCH");
  if (mismatches.length === 0 && options.recordShadowCheckpoint !== false) {
    await withTenantTransaction(tenantId, {}, async (_db, client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5141))",[tenantId]);
      const control = (await client.query<ControlRow>("SELECT * FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1 FOR UPDATE",[tenantId])).rows[0];
      const pending = await client.query("SELECT 1 FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND status<>'processed' LIMIT 1",[tenantId]);
      const due = await client.query(`SELECT 1 FROM finnor_os.epistemic_current
        WHERE tenant_id=$1 AND graph_version_id=$2 AND next_freshness_at<=clock_timestamp() LIMIT 1`,
        [tenantId,snapshot.graphVersionId]);
      const order = await client.query<{ order: string }>(
        `SELECT coalesce(max(ingestion_order),0)::text AS "order" FROM finnor_os.epistemic_changes
         WHERE tenant_id=$1 AND graph_version_id=$2`,[tenantId,snapshot.graphVersionId]);
      if (!control || !["shadow","refreshing"].includes(control.mode) || control.graph_version_id !== snapshot.graphVersionId
        || control.graph_structure_epoch !== control.staged_structure_epoch
        || pending.rowCount || due.rowCount || (order.rows[0]?.order ?? "0") !== snapshot.changeOrder) {
        throw new Error("Shadow state moved during comparison; retry");
      }
      await client.query(`UPDATE finnor_os.epistemic_runtime_controls
        SET shadow_verified_at=clock_timestamp(),shadow_verified_change_order=$2,updated_at=clock_timestamp()
        WHERE tenant_id=$1`,[tenantId,snapshot.changeOrder]);
    });
  }
  return { equivalent: mismatches.length===0,checked: replay.state.propositions.length,mismatches,graphVersionId:snapshot.graphVersionId };
}

/** The kill switch is immediate and reversible. It never rewrites accepted
 * ChangeSets; active operational consequences cease at the next read boundary. */
export async function setEpistemicKillSwitch(tenantId: string, enabled: boolean): Promise<void> {
  await withTenantTransaction(tenantId, {}, async (_db, client) => {
    const result = await client.query("UPDATE finnor_os.epistemic_runtime_controls SET kill_switch=$2,updated_at=clock_timestamp() WHERE tenant_id=$1",[tenantId,enabled]);
    if (!result.rowCount) throw new Error("Tenant has no staged epistemic graph");
  });
}

export async function activateDurableEpistemicImpact(input: {
  tenantId: string; graphVersionId: string; releaseSha: string;
}): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(input.releaseSha)) throw new Error("Activation requires exact release commit SHA");
  await withTenantTransaction(input.tenantId, {}, async (_db, client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5141))",[input.tenantId]);
    const control = (await client.query<ControlRow>("SELECT * FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1 FOR UPDATE",[input.tenantId])).rows[0];
    if (!control || !["shadow","refreshing"].includes(control.mode)
      || control.graph_version_id !== input.graphVersionId || !control.baseline_completed_at
      || !control.shadow_verified_at || control.processing_change_id || control.kill_switch) {
      throw new Error("Epistemic activation requires staged graph, complete baseline, verified shadow, empty frontier and kill switch off");
    }
    const pending = await client.query("SELECT 1 FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND status<>'processed' LIMIT 1",[input.tenantId]);
    const due = await client.query(`SELECT 1 FROM finnor_os.epistemic_current WHERE tenant_id=$1 AND graph_version_id=$2
      AND next_freshness_at<=clock_timestamp() LIMIT 1`,[input.tenantId,input.graphVersionId]);
    const order = await client.query<{ order: string }>(
      `SELECT coalesce(max(ingestion_order),0)::text AS "order" FROM finnor_os.epistemic_changes
       WHERE tenant_id=$1 AND graph_version_id=$2`,[input.tenantId,input.graphVersionId]);
    if (pending.rowCount || due.rowCount || control.graph_structure_epoch !== control.staged_structure_epoch
      || control.shadow_verified_change_order !== (order.rows[0]?.order ?? "0")) {
      throw new Error("Epistemic activation requires drained changes, freshness, and an exact shadow checkpoint");
    }
    const worker = await client.query(`SELECT 1 FROM finnor_os.service_release_heartbeats
      WHERE service IN ('compute-background','worker') AND release_sha=$1 AND migration_head=$2
        AND capabilities @> ARRAY['epistemic-v2']::text[] AND last_beat_at>=clock_timestamp()-interval '2 minutes'
      LIMIT 1`,[input.releaseSha,CURRENT_MIGRATION_HEAD]);
    if (!worker.rowCount) throw new Error("No fresh protocol-2 epistemic worker for the exact release/migration head");
    await client.query(`UPDATE finnor_os.epistemic_runtime_controls SET mode='active',activated_at=clock_timestamp(),
      activated_release_sha=$2,updated_at=clock_timestamp() WHERE tenant_id=$1`,[input.tenantId,input.releaseSha]);
  });
}
