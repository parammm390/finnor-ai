ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT work_query_executions_intent_check;
ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK(intent IN(
 'work_list','attention_queue','agent_activity','workforce_status','company_context','party_lookup','party_context','team_roster',
 'pe_world_state','deal_context','deal_workstreams','open_requests','open_findings','open_deal_risks','critical_dependencies','closing_readiness',
 'harness_program_v1','economic_programme_v1','confidential_economic_computation_v1','acquisition_decision_v1','primary_diligence_v1'));
