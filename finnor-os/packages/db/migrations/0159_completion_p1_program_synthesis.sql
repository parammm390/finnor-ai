-- P1 ordinary implementation records beneath canonical Work/PlanRevision.
-- Episode counters are operational bounds, never S5 funding or reservations.
CREATE TABLE finnor_os.p1_episodes(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 max_steps integer NOT NULL CHECK(max_steps BETWEEN 8 AND 4096),max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 8),
 max_candidates integer NOT NULL CHECK(max_candidates BETWEEN 2 AND 8),candidates_used integer NOT NULL DEFAULT 0 CHECK(candidates_used BETWEEN 0 AND max_candidates),
 max_depth integer NOT NULL CHECK(max_depth BETWEEN 1 AND 12),
 steps_used integer NOT NULL DEFAULT 0,attempts_used integer NOT NULL DEFAULT 0,deadline_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,principal_id,work_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.p1_requests(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,work_input_id uuid NOT NULL,work_input_digest text NOT NULL,
 episode_id uuid NOT NULL REFERENCES finnor_os.p1_episodes(id),plan_revision_id uuid NOT NULL,idempotency_key text NOT NULL,request_digest text NOT NULL,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=65536),proposed jsonb NOT NULL CHECK(octet_length(proposed::text)<=1048576),
 generation integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','WAITING_EVIDENCE','WAITING','TESTED','PARTIAL','FAILED','INVALIDATED','CANCELLED')),
 evidence_query_id uuid,head_id uuid,claim_token uuid,claim_fence bigint,poll_count integer NOT NULL DEFAULT 0,failure text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,idempotency_key),UNIQUE(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),FOREIGN KEY(tenant_id,plan_revision_id) REFERENCES finnor_os.work_plan_revisions(tenant_id,id)
);
CREATE TABLE finnor_os.p1_programs(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,generation integer NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,request_id,generation,digest),FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.p1_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p1_modules(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,digest text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,digest),FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.p1_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,
 generation integer NOT NULL,kind text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.p1_requests(tenant_id,principal_id,id)
);
CREATE INDEX p1_event_request_idx ON finnor_os.p1_events(tenant_id,principal_id,request_id,created_at,id);
CREATE TABLE finnor_os.p1_node_results(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,request_id uuid NOT NULL,generation integer NOT NULL,node_id text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,request_id,generation,node_id),FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.p1_requests(tenant_id,principal_id,id)
);
CREATE FUNCTION finnor_os.p1_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'P1 implementation evidence is immutable; append an exact linked revision'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['p1_episodes','p1_requests','p1_programs','p1_modules','p1_events','p1_node_results'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY p1_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t NOT IN('p1_episodes','p1_requests') THEN EXECUTE format('CREATE TRIGGER p1_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable()',t); END IF;
 END LOOP;
 GRANT UPDATE ON finnor_os.p1_requests TO finnor_app;
 GRANT UPDATE(steps_used,attempts_used,candidates_used) ON finnor_os.p1_episodes TO finnor_app;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_harness_program_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'P1 bounded ordinary implementation linked to canonical WorkPlanRevision; no protected admission or effect authority.');

-- Preserve the active native query catalogue, add one exact P1 reader.
ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT work_query_executions_intent_check;
ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK(intent IN(
 'work_list','attention_queue','agent_activity','workforce_status','company_context','party_lookup','party_context','team_roster',
 'pe_world_state','deal_context','deal_workstreams','open_requests','open_findings','open_deal_risks','critical_dependencies','closing_readiness','harness_program_v1'));
