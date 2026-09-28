-- Keep historical Water pack rows readable while allowing the canonical
-- Private Equity packs to bind durable Work. Application policy still decides
-- which pack IDs may start; this constraint guards stored identity only.
DO $outcome_pack_ids$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'outcome_pack_runs',
    'tenant_outcome_pack_settings',
    'outcome_pack_certifications',
    'autonomy_grants'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I DROP CONSTRAINT IF EXISTS %I', table_name, table_name || '_pack_id_check');
    EXECUTE format(
      'ALTER TABLE finnor_os.%I ADD CONSTRAINT %I CHECK (pack_id IN (%L,%L,%L,%L,%L,%L,%L,%L))',
      table_name,
      table_name || '_pack_id_check',
      'lead_to_verified_water_test_booking',
      'stuck_installation_service_resolution',
      'overdue_receivable_collection',
      'service_due_lifecycle',
      'deal_to_verified_closing_readiness',
      'deal_request_resolution',
      'critical_deal_dependency_resolution',
      'general_operator_objective'
    );
  END LOOP;
END $outcome_pack_ids$;
