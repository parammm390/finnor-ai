-- P2 is an ordinary, unadmitted consumer of actual P1/S4/S5 owners.
-- No new money, scientific belief, business selection or effect authority.
CREATE TABLE finnor_os.p2_requests(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,program_id uuid NOT NULL,
 idempotency_key text NOT NULL,request_digest text NOT NULL,request jsonb NOT NULL CHECK(octet_length(request::text)<=65536),
 binding jsonb NOT NULL CHECK(octet_length(binding::text)<=65536),context jsonb CHECK(octet_length(context::text)<=1048576),
 generation integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'ACCEPTED'
 CHECK(status IN('ACCEPTED','RUNNING','WAITING','STOPPED','FAILED','CANCELLED','INVALIDATED')),
 head_id uuid,revision integer NOT NULL DEFAULT 0,reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),UNIQUE(tenant_id,principal_id,program_id),
 FOREIGN KEY(tenant_id,principal_id,program_id) REFERENCES finnor_os.p1_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p2_plans(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,
 revision integer NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,principal_id,search_id,revision),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p2_units(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,generation integer NOT NULL,
 kind text NOT NULL CHECK(kind IN('EXECUTE_P1','VERIFY_P1','MODEL_REFINE')),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','UNKNOWN')),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),digest text NOT NULL,
 result jsonb CHECK(octet_length(result::text)<=1048576),result_digest text,
 claim_token uuid,claim_fence bigint,job_id uuid,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,search_id,digest)
);
CREATE INDEX p2_unit_frontier ON finnor_os.p2_units(tenant_id,principal_id,search_id,status,created_at,id);
CREATE TABLE finnor_os.p2_attempts(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,unit_id uuid NOT NULL,
 delivery_id uuid NOT NULL,claim_fence bigint NOT NULL,status text NOT NULL
 CHECK(status IN('INTENT','SUBMITTED','COMPLETED','FAILED','UNKNOWN','LATE')),
 endpoint_key text,body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,unit_id) REFERENCES finnor_os.p2_units(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id)
);
CREATE INDEX p2_attempt_unit ON finnor_os.p2_attempts(tenant_id,principal_id,unit_id,created_at,id);
CREATE TABLE finnor_os.p2_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,
 kind text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id)
);
CREATE INDEX p2_event_search ON finnor_os.p2_events(tenant_id,principal_id,search_id,created_at,id);
-- This debit is shared by every child/search using the SAME original S5 certificate.
CREATE TABLE finnor_os.p2_grant_usage(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,grant_digest text NOT NULL,resource_id text NOT NULL,
 spent integer NOT NULL DEFAULT 0 CHECK(spent>=0),PRIMARY KEY(tenant_id,principal_id,grant_digest,resource_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
-- Only aggregate endpoint counters; no tenant inputs, output or private traces.
-- These counters cross process AND tenant boundaries just like existing provider budgets.
CREATE TABLE finnor_os.p2_endpoint_windows(
 endpoint_key text PRIMARY KEY,config_digest text NOT NULL,minute_start bigint NOT NULL,day_start bigint NOT NULL,
 requests integer NOT NULL DEFAULT 0,input_tokens bigint NOT NULL DEFAULT 0,output_tokens bigint NOT NULL DEFAULT 0,
 daily_tokens bigint NOT NULL DEFAULT 0,active integer NOT NULL DEFAULT 0 CHECK(active>=0)
);
GRANT SELECT,INSERT,UPDATE ON finnor_os.p2_endpoint_windows TO finnor_app;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['p2_requests','p2_plans','p2_units','p2_attempts','p2_events','p2_grant_usage'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY p2_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t IN('p2_plans','p2_events') THEN
   EXECUTE format('CREATE TRIGGER p2_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable()',t);
  ELSE EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t); END IF;
 END LOOP;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_compute_search_unit_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'P2 fenced ordinary work unit charged to original P1 episode and S5 native compute envelope; unknown remote attempts reconciled before retry.');
