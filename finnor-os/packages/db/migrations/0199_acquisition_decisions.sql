CREATE TABLE finnor_os.acquisition_decisions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL, work_id uuid NOT NULL, work_input_id uuid NOT NULL,
 work_input_digest text NOT NULL, request_digest text NOT NULL,
 idempotency_key text NOT NULL, request jsonb NOT NULL CHECK(octet_length(request::text)<=131072),
 base_input_hash text NOT NULL, base_result_hash text NOT NULL,
 deadline_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','TESTED','PARTIAL','FAILED','INVALIDATED')),
 result jsonb CHECK(result IS NULL OR octet_length(result::text)<=2097152), result_digest text,
 active_job_id uuid, active_claim_token uuid, active_claim_fence bigint,
 failure text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 CHECK((result IS NULL)=(result_digest IS NULL))
);
ALTER TABLE finnor_os.acquisition_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.acquisition_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY acquisition_principal_isolation ON finnor_os.acquisition_decisions
 USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON finnor_os.acquisition_decisions TO finnor_app;
GRANT UPDATE(status,result,result_digest,active_job_id,active_claim_token,active_claim_fence,failure,updated_at)
 ON finnor_os.acquisition_decisions TO finnor_app;
CREATE FUNCTION finnor_os.guard_acquisition_decision_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.result IS NOT NULL AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.result_digest IS DISTINCT FROM OLD.result_digest) THEN
  RAISE EXCEPTION 'Acquisition decision results are immutable; submit a new mandate';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acquisition_result_immutable BEFORE UPDATE ON finnor_os.acquisition_decisions
 FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_acquisition_decision_result();
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('evaluate_acquisition_v1','HEAVY',ARRAY['HEAVY'],'fixed','tenant','required',1,
 'Read-only finite acquisition bid and financing comparison through canonical underwriting; original Work, source cut and deadline; no transaction authority.');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:acquisition',2,1,0,120,'Bounded financial-model execution admission; engineering concurrency, not financial funding or protected qualification'),
 ('native:p4',2,1,0,120,'Credential-free finite evidence reader; engineering concurrency, not financial funding or protected qualification')
 ON CONFLICT(resource_key) DO NOTHING;

ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT work_query_executions_intent_check;
ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK(intent IN(
 'work_list','attention_queue','agent_activity','workforce_status','company_context','party_lookup','party_context','team_roster',
 'pe_world_state','deal_context','deal_workstreams','open_requests','open_findings','open_deal_risks','critical_dependencies','closing_readiness','harness_program_v1','economic_programme_v1','confidential_economic_computation_v1','acquisition_decision_v1'));
