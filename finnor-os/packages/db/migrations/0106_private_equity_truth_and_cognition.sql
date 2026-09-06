-- Private Equity Phase 3: typed read receipts for the existing Operational Query
-- Plane. No canonical PE table, action fabric, connector, or autonomous worker is
-- introduced here; epistemic evidence remains in the existing evidence corpus.

ALTER TABLE finnor_os.work_query_executions
  DROP CONSTRAINT IF EXISTS work_query_executions_intent_check;
ALTER TABLE finnor_os.work_query_executions
  ADD CONSTRAINT work_query_executions_intent_check CHECK (intent IN (
    'customer_lookup','customer_cohort','schedule_range','money_summary','work_list',
    'inventory_status','agent_activity','business_state','company_context',
    'party_lookup','party_context','team_roster','party_availability',
    'deal_context','deal_workstreams','open_requests','open_findings','open_deal_risks',
    'critical_dependencies','closing_readiness'
  ));

CREATE INDEX IF NOT EXISTS external_refs_pe_observation_idx
  ON finnor_os.external_refs(tenant_id,entity,internal_id,last_observed_at DESC,id)
  WHERE entity LIKE 'pe\_%' ESCAPE '\';

COMMENT ON INDEX finnor_os.external_refs_pe_observation_idx IS
  'Provider-neutral PE observations. Rows are evidence/source state and never canonical PE lifecycle state.';
