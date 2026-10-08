-- Branch-local additive P5 registry on exact P2. Not a reserved slot in the
-- future M3/M4/M2/P7 cumulative join. Historical migrations are unchanged.
CREATE TABLE finnor_os.p5_test_access(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 origin text NOT NULL CHECK(origin ~ '^http://127[.]0[.]0[.]1:[0-9]{1,5}$'),
 account text NOT NULL,document_path text NOT NULL CHECK(document_path ~ '^/[A-Za-z0-9_/-]+$'),
 ui_path text CHECK(ui_path IS NULL OR ui_path ~ '^/[A-Za-z0-9_/-]+$'),
 rights_ref text NOT NULL,valid_until timestamptz NOT NULL,permit_practice boolean NOT NULL DEFAULT false,
 revoked boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.p5_episodes(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 attempts_used integer NOT NULL DEFAULT 0 CHECK(attempts_used BETWEEN 0 AND 4),
 acquisition_count integer NOT NULL DEFAULT 0 CHECK(acquisition_count BETWEEN 0 AND 4),
 wire_attempts integer NOT NULL DEFAULT 0 CHECK(wire_attempts BETWEEN 0 AND 4),
 reads_used integer NOT NULL DEFAULT 0 CHECK(reads_used BETWEEN 0 AND 64),
 deadline_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,work_id),UNIQUE(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.p5_acquisitions(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,work_input_id uuid NOT NULL,
 work_input_digest text NOT NULL,episode_id uuid NOT NULL,access_id uuid NOT NULL,
 idempotency_key text NOT NULL,request_digest text NOT NULL,request jsonb NOT NULL CHECK(octet_length(request::text)<=65536),
 code_digest text NOT NULL,rights_revision integer NOT NULL,
 generation integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'QUEUED'
 CHECK(status IN('QUEUED','RUNNING','PROTOTYPE','PRACTICED','SUPPORTED_DISPOSABLE','UNKNOWN','DISCREPANCY','FAILED','CANCELLED','QUARANTINED')),
 head_id uuid,claim_token uuid,claim_fence bigint,reason text,source jsonb CHECK(source IS NULL OR octet_length(source::text)<=65536),
 source_digest text,generated jsonb CHECK(generated IS NULL OR octet_length(generated::text)<=32768),
 s8_candidate jsonb,s8_admission_ref jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id,episode_id) REFERENCES finnor_os.p5_episodes(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,access_id) REFERENCES finnor_os.p5_test_access(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p5_attempts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,acquisition_id uuid NOT NULL,
 operation_id text NOT NULL,binding_digest text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=4096),
 possible_egress boolean NOT NULL DEFAULT false,acknowledged boolean NOT NULL DEFAULT false,
 result jsonb CHECK(result IS NULL OR octet_length(result::text)<=131072),result_digest text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,acquisition_id,operation_id),
 FOREIGN KEY(tenant_id,principal_id,acquisition_id) REFERENCES finnor_os.p5_acquisitions(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p5_capabilities(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,acquisition_id uuid NOT NULL,
 generation integer NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,acquisition_id) REFERENCES finnor_os.p5_acquisitions(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p5_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,acquisition_id uuid NOT NULL,
 kind text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=131072),digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,acquisition_id) REFERENCES finnor_os.p5_acquisitions(tenant_id,principal_id,id)
);
CREATE INDEX p5_work_projection ON finnor_os.p5_acquisitions(tenant_id,principal_id,work_id,created_at DESC,id);
CREATE INDEX p5_event_history ON finnor_os.p5_events(tenant_id,principal_id,acquisition_id,created_at,id);
CREATE FUNCTION finnor_os.p5_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'P5 evidence is immutable; append an exact linked version'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['p5_test_access','p5_episodes','p5_acquisitions','p5_attempts','p5_capabilities','p5_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY p5_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  IF t='p5_test_access' THEN EXECUTE format('GRANT SELECT ON finnor_os.%I TO finnor_app',t);
  ELSE EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t); END IF;
  IF t IN('p5_capabilities','p5_events') THEN EXECUTE format('CREATE TRIGGER p5_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p5_immutable()',t); END IF;
 END LOOP;
 GRANT UPDATE ON finnor_os.p5_acquisitions TO finnor_app;
 GRANT UPDATE(attempts_used,acquisition_count,wire_attempts,reads_used) ON finnor_os.p5_episodes TO finnor_app;
 GRANT UPDATE(possible_egress,acknowledged,body,result,result_digest) ON finnor_os.p5_attempts TO finnor_app;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_interface_acquisition_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'P5 bounded disposable acquisition; possible egress quarantines for read-only recovery, never automatic replay');
