-- Ordinary exact source / R1 producer records under the original Work episode.
-- S5 remains the sole resource ledger. No admission, effect or settlement grant.
CREATE TABLE finnor_os.r1_models(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 work_input_id uuid NOT NULL,work_input_digest text NOT NULL,
 ref jsonb NOT NULL,model_bytes text NOT NULL CHECK(octet_length(model_bytes)<=2097152),
 model_digest text NOT NULL,source_digest text NOT NULL,mandate jsonb NOT NULL,belief_pins jsonb NOT NULL,dependencies jsonb NOT NULL,
 source_cut jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,source_digest),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);
CREATE TABLE finnor_os.r1_preparation_receipts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,model_id uuid NOT NULL,
 body jsonb NOT NULL,digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,model_id) REFERENCES finnor_os.r1_models(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.r1_runs(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,program_id uuid NOT NULL,
 model_id uuid NOT NULL,work_id uuid NOT NULL,work_input_id uuid NOT NULL,episode_id uuid NOT NULL,
 idempotency_key text NOT NULL,request jsonb NOT NULL,request_digest text NOT NULL,binding jsonb NOT NULL,
 generation integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'QUEUED'
 CHECK(status IN('QUEUED','RUNNING','COMPLETE','INCOMPLETE','INFEASIBLE','UNSUPPORTED','INVALIDATED','UNKNOWN','CANCELLED')),
 original_deadline_at timestamptz NOT NULL,decision_deadline_at timestamptz NOT NULL CHECK(decision_deadline_at<=original_deadline_at),
 math_steps_used integer NOT NULL DEFAULT 0 CHECK(math_steps_used BETWEEN 0 AND 4000000),
 claim_token uuid,claim_fence bigint,head_id uuid,predicate text,fallback text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,program_id) REFERENCES finnor_os.p1_requests(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,model_id) REFERENCES finnor_os.r1_models(tenant_id,principal_id,id),
 FOREIGN KEY(episode_id) REFERENCES finnor_os.p1_episodes(id)
);
CREATE TABLE finnor_os.r1_attempts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,run_id uuid NOT NULL,
 delivery_id uuid NOT NULL,stage text NOT NULL CHECK(stage IN('PRODUCE','CHECK','S4_EVALUATE','ORIGINAL_FALLBACK')),
 claim_fence bigint NOT NULL,status text NOT NULL CHECK(status IN('INTENT','SUBMITTED','RETURNED','UNKNOWN','FENCED')),
 child_pid integer,body jsonb NOT NULL,digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,delivery_id,stage),
 FOREIGN KEY(tenant_id,principal_id,run_id) REFERENCES finnor_os.r1_runs(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.r1_artifacts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,run_id uuid NOT NULL,
 generation integer NOT NULL,kind text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),
 digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,run_id,generation,kind,digest),
 FOREIGN KEY(tenant_id,principal_id,run_id) REFERENCES finnor_os.r1_runs(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.r1_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,run_id uuid NOT NULL,
 kind text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,run_id) REFERENCES finnor_os.r1_runs(tenant_id,principal_id,id)
);
CREATE INDEX r1_work_projection ON finnor_os.r1_runs(tenant_id,principal_id,work_id,created_at DESC);
CREATE INDEX r1_attempt_history ON finnor_os.r1_attempts(tenant_id,principal_id,run_id,created_at);
CREATE FUNCTION finnor_os.r1_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'R1 history is immutable; append a linked invalidation or new version'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['r1_models','r1_preparation_receipts','r1_runs','r1_attempts','r1_artifacts','r1_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY r1_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t NOT IN('r1_runs','r1_attempts') THEN
   EXECUTE format('CREATE TRIGGER r1_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.r1_immutable()',t);
  END IF;
 END LOOP;
 GRANT UPDATE(status,generation,math_steps_used,claim_token,claim_fence,head_id,predicate,fallback) ON finnor_os.r1_runs TO finnor_app;
 GRANT UPDATE(status,child_pid,body,digest) ON finnor_os.r1_attempts TO finnor_app;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_certified_state_reduction_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'R1 checked exact-table continuation reuse under the original Work/P1 episode and S5 grant; no effect or admission authority');
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_r1_dependency_continuation_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'P7 versioned R1 dependency invalidation; no new episode, grant, effect or responsibility release');
