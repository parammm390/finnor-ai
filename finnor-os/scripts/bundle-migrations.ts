// Regenerates packages/db/migrations-bundle.ts from the SQL files — run after adding
// a migration. The bundle exists because serverless functions can't read the SQL
// directory from disk; importing the bundle traces it into the deployment.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "packages/db/migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const migrationHead = files.at(-1);
if (!migrationHead) throw new Error("Migration source population is empty");
// Complete filenames are persisted migration identities. Preserve only the
// explicitly reconciled historical and X1/X2 peer overlaps below. This does not
// allocate another migration at any of these ordinals.
const historicalPairs = new Map([
  ["0195",new Set(["0195_postx_y1_economic_action_theory.sql","0195_private_input_responses.sql"])],
  ["0131",new Set(["0131_egress_bounded_read_indexes.sql","0131_private_equity_release_baseline.sql"])],
  ["0141",new Set(["0141_private_equity_outcome_pack_ids.sql","0141_restricted_digest_projection_access.sql"])],
  ["0172",new Set(["0172_v2_primary_diligence.sql","0172_x1_institution_source_authority.sql"])],
  ["0173",new Set(["0173_v2_primary_privacy.sql","0173_v3_autonomous_transaction_closure.sql","0173_x1_institution_s5_reservations.sql"])],
  ["0174",new Set(["0174_v2_primary_profile_custody.sql","0174_x1_native_continuation.sql"])],
  ["0175",new Set(["0175_v4_autonomous_capital_formation.sql","0175_x1_work_compiler.sql"])],
  ["0176",new Set(["0176_v5_live_institutional_control.sql","0176_x1_automatic_owner_updates.sql"])],
  ["0177",new Set(["0177_v1_bilateral_opportunities.sql","0177_x1_action_origin_preservation.sql"])],
  ["0178",new Set(["0178_closing_evidence_custody_composition.sql","0178_x1_native_programme_capacity.sql"])],
  ["0179",new Set(["0179_closing_primary_profile_custody.sql","0179_x1_request_evidence_owner_compatibility.sql"])],
  ["0180",new Set(["0180_investment_case_signed_loi_transition.sql","0180_x1_work_scoped_canonical_owners.sql"])],
  ["0181",new Set(["0181_native_system_actor_scope.sql","0181_x1_authenticated_work_inputs.sql"])],
  ["0182",new Set(["0182_r1_certified_state_reduction.sql","0182_x1_core_source_parameter_binding.sql"])],
  ["0183",new Set(["0183_r2_robust_programme_search.sql","0183_x1_source_authority_role_isolation.sql"])],
  ["0184",new Set(["0184_identification_plan_compiler.sql","0184_x1_scoped_source_authority_locks.sql"])],
  ["0185",new Set(["0185_coalition_programme_search.sql","0185_x1_original_s5_authority_currentness.sql"])],
  ["0186",new Set(["0186_r7_policy_atlas.sql","0186_x1_source_subject_scope.sql"])],
  ["0187",new Set(["0187_r3_incentive_rule_synthesis.sql","0187_x1_responsible_principal_currentness.sql"])],
  ["0188",new Set(["0188_observation_source_version_binding.sql","0188_x1_source_namespace_binding.sql"])],
  ["0189",new Set(["0189_x3_enterprise_applications.sql","0189_x1_physical_cost_allocation.sql"])],
  ["0190",new Set(["0190_x5_experience_policy.sql","0190_x1_final_compiler_head_fence.sql"])],
  ["0191",new Set(["0191_x4_system_identification.sql","0191_frontier5_x2_application_semantics.sql"])],
]);
const ids = new Map<string,string>();
for (const name of files) {
  // Preserve only these exact separately owned migration identities.
  if (new Set(["postx_y4_confidential_economic_computation.sql", "postx_y4_confidential_owner_consumption.sql", "postx_y4_runtime_migration_order.sql", "postx_y4_runtime_owner_integrity.sql", "postx_y4_runtime_recipient_recovery.sql", "postx_y5_capability_1_capability_provider_runs.sql", "postx_y5_capability_2_nango_readonly_sources.sql", "postx_y5_capability_3_capability_private_evidence.sql", "postx_y5_capability_4_capability_planner_activations.sql", "postx_y5_capability_5_capability_nango_lifecycle.sql", "postx_y6_conversation_memory.sql", "postz_w1_native_orchestration.sql", "postz_w1_objective_budget_guard.sql", "postz_w1_objective_query_custody.sql", "postz_w1_ordinary_economic_reads.sql", "postz_w1_source_link_binding.sql", "postz_w2_accountable_workforce.sql", "postz_w2_compensation_payment_preparation.sql", "postz_w2_dynamic_workforce.sql", "postz_w2_execution_completion.sql", "postz_w2_participant_binding_expiry.sql", "postz_w2_protected_child.sql", "postz_w2_protected_child_history.sql"]).has(name)) continue;
  const id = name.split("_")[0]!;
  if (!/^\d{4}[a-z]?$/.test(id)) throw new Error(`Invalid migration ID: ${name}`);
  const prior=ids.get(id),historical=historicalPairs.get(id);
  if (prior && !(historical?.has(prior)&&historical.has(name))) throw new Error(`Duplicate migration ID ${id}; serialize the integration before generating the bundle`);
  ids.set(id,name);
}
const entries = files.map((name) => {
  const sql = readFileSync(join(dir, name), "utf8");
  return `  { name: ${JSON.stringify(name)}, sql: ${JSON.stringify(sql)} },`;
});
const out = `// AUTO-GENERATED by scripts/bundle-migrations.ts — do not edit by hand.
import type { MigrationFile } from "./migrate";

export const MIGRATIONS: MigrationFile[] = [
${entries.join("\n")}
];
`;
writeFileSync(join(root, "packages/db/migrations-bundle.ts"), out);
writeFileSync(join(root, "packages/db/migration-head.ts"),
  `// AUTO-GENERATED by scripts/bundle-migrations.ts — do not edit by hand.\nexport const CURRENT_MIGRATION_HEAD = ${JSON.stringify(migrationHead)};\n`);
console.log(`bundled ${files.length} migrations`);
