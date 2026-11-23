/** Exact forward dependencies. Historical SQL bytes and the relative order of
 * unrelated migrations remain unchanged. Used by disk, bundle and discovery. */
export const migrationDependencies: Readonly<Record<string, readonly string[]>> = {
  "0204_postz_w2_specialist_publication_authority.sql": [
    "0000_init.sql", // users, jobs
    "0001_local_app_role.sql",
    "0006_security_controls.sql",
    "0084_phase0_company_world.sql",
    "0086_phase2_universal_action_delegation_fabric.sql",
    "0096_universal_business_effect_kernel.sql",
    "0105_private_equity_execution_graph.sql",
    "0109_atomic_water_runtime_retirement.sql",
    "0123_artifact_authority_defaults.sql",
    "0127_pe_actions_ic_runtime.sql",
    "0129_phase7_governed_workforce_learning.sql",
    "0135_source_compatibility_runtime_parity.sql",
    "0157_completion_p4_evidence_execution.sql",
    "0181_native_system_actor_scope.sql",
    "0150_portfolio_resource_clearing.sql",
    "0155_governed_resource_units.sql",
    "0173_v3_autonomous_transaction_closure.sql",
    "0173_x1_institution_s5_reservations.sql",
    "0176_v5_live_institutional_control.sql",
    "postx_y4_confidential_owner_consumption.sql",
    "postx_y4_runtime_recipient_recovery.sql",
    "0064_evidence_corpus_search.sql",
    "0065_durable_work_kernel.sql",
    "0069_employee_authority_runtime.sql",
    "0085_phase1_identity_access_fabric.sql", // legacy authority gate parents
    "0090_phase5_production_connection_reliability.sql", // original job lease
    "0137_scope2_durable_runtime.sql", // tenant + claim token/full fence
    "0171_runtime_database_role_isolation.sql",
    "postz_w2_accountable_workforce.sql",
    "postz_w2_compensation_payment_preparation.sql",
    "postz_w2_dynamic_workforce.sql",
    "postz_w2_execution_completion.sql",
    "postz_w2_participant_binding_expiry.sql",
    "postz_w2_protected_child.sql",
    "postz_w2_protected_child_history.sql",
    "postz_w2_z_participant_identity.sql",
    "postz_w2_zz_participant_legacy_authority.sql",
  ],
  "0205_postz_w5_organization_transformation_query_history.sql": [
    "0201_postz_w5_organization_transformation.sql",
    "0204_postz_w2_specialist_publication_authority.sql",
    "postx_y4_confidential_economic_computation.sql",
    "postz_w1_ordinary_economic_reads.sql",
  ],
};
export function orderMigrationNames(names: readonly string[]): string[] {
  if (new Set(names).size !== names.length) throw new Error("Duplicate migration filename");
  const ordered = [...names].sort();
  const visiting = new Set<string>(), visited = new Set<string>();
  function place(name: string) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error("Cyclic migration dependencies: " + name);
    visiting.add(name);
    const dependencies = migrationDependencies[name] ?? [];
    for (const dependency of dependencies) {
      if (!ordered.includes(dependency)) throw new Error(`Missing migration prerequisite ${dependency} for ${name}`);
      place(dependency);
    }
    if (dependencies.length) {
      ordered.splice(ordered.indexOf(name), 1);
      const after = Math.max(...dependencies.map(dependency => ordered.indexOf(dependency)));
      ordered.splice(after + 1, 0, name);
    }
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of [...ordered]) place(name);
  return ordered;
}
