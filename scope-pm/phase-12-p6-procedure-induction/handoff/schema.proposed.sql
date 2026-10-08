-- UNNUMBERED PROPOSAL for the serial Codex integrator. Not in the published
-- registry/bundle. Apply only to disposable validation databases until adopted.
-- Ordinary producer projections, not an S8 registry or ExperienceLedger.
BEGIN;
CREATE TABLE finnor_os.p6_inductions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 work_input_id uuid NOT NULL,work_input_digest text NOT NULL,idempotency_key text NOT NULL,
 request jsonb NOT NULL CHECK(octet_length(request::text)<=65536),request_digest text NOT NULL,
 cut jsonb NOT NULL CHECK(octet_length(cut::text)<=16777216),cut_digest text NOT NULL,
 source_digest text NOT NULL,schema_digest text NOT NULL,
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN('QUEUED','RUNNING','TESTED','FAILED','CANCELLED')),
 generation integer NOT NULL DEFAULT 1,claim_token uuid,claim_fence bigint,attempts_used integer NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 4),
 deadline_at timestamptz NOT NULL,capsule_ids uuid[] NOT NULL DEFAULT '{}',reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);
CREATE TABLE finnor_os.p6_capsules(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,induction_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=2097152),digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,induction_id,digest),
 FOREIGN KEY(tenant_id,principal_id,induction_id) REFERENCES finnor_os.p6_inductions(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p6_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,
 induction_id uuid NOT NULL,capsule_id uuid,kind text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),digest text NOT NULL,
 idempotency_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,induction_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,induction_id) REFERENCES finnor_os.p6_inductions(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,capsule_id) REFERENCES finnor_os.p6_capsules(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p6_invalidations(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,capsule_id uuid NOT NULL,
 ref jsonb NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,capsule_id),
 FOREIGN KEY(tenant_id,principal_id,capsule_id) REFERENCES finnor_os.p6_capsules(tenant_id,principal_id,id)
);
CREATE INDEX p6_event_history ON finnor_os.p6_events(tenant_id,principal_id,induction_id,created_at,id);
CREATE FUNCTION finnor_os.p6_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'P6 evidence is immutable; append a linked counterexample or new capsule'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['p6_inductions','p6_capsules','p6_events','p6_invalidations'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY p6_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t<>'p6_inductions' THEN
   EXECUTE format('CREATE TRIGGER p6_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p6_immutable()',t);
  END IF;
 END LOOP;
 GRANT UPDATE(state,generation,claim_token,claim_fence,attempts_used,capsule_ids,reason) ON finnor_os.p6_inductions TO finnor_app;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_procedure_induction_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'P6 bounded ordinary structural induction from complete declared native episodes; no protected custody/admission or economic credit');
COMMIT;
