-- Forward-only proposal. No lease, scratch or process is created by this DDL.
CREATE TABLE finnor_os.p3_resource_intents(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),work_id uuid NOT NULL REFERENCES finnor_os.works(id),
 branch_id uuid NOT NULL REFERENCES finnor_os.p3_requests(id),attempt_id uuid NOT NULL REFERENCES finnor_os.p3_artifacts(id),
 delivery_attempt_id uuid NOT NULL REFERENCES finnor_os.job_delivery_attempts(id),job_id uuid NOT NULL REFERENCES finnor_os.jobs(id),
 claim_token uuid NOT NULL,claim_fence bigint NOT NULL CHECK(claim_fence>0),
 kind text NOT NULL CHECK(kind IN('NATIVE_PERMIT','PUBLIC_PREPARATION','NATIVE_STATE','CHECKER_STATE')),
 path text,descriptor jsonb NOT NULL CHECK(octet_length(descriptor::text)<=8192),
 state text NOT NULL DEFAULT 'INTENT' CHECK(state IN('INTENT','CREATED','STARTED','RETAINED','CLEANUP_REQUIRED','CLEANED')),
 process_group integer CHECK(process_group>0),cleanup_observed boolean NOT NULL DEFAULT false,
 reason text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='NATIVE_PERMIT' AND path IS NULL) OR (kind<>'NATIVE_PERMIT' AND path IS NOT NULL)),
 CHECK((state='CLEANED')=cleanup_observed)
);
CREATE FUNCTION finnor_os.p3_resource_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE a finnor_os.p3_artifacts;j finnor_os.jobs;BEGIN
 IF TG_OP='INSERT' THEN
  SELECT * INTO a FROM finnor_os.p3_artifacts WHERE id=NEW.attempt_id;
  SELECT * INTO j FROM finnor_os.jobs WHERE id=NEW.job_id FOR SHARE;
  IF a.id IS NULL OR a.category<>'ATTEMPT' OR
    (a.tenant_id,a.principal_id,a.work_id) IS DISTINCT FROM (NEW.tenant_id,NEW.principal_id,NEW.work_id) OR
    a.body->>'branchId'<>NEW.branch_id::text OR a.body->>'deliveryAttemptId'<>NEW.delivery_attempt_id::text OR
    j.status<>'running' OR j.claim_token IS DISTINCT FROM NEW.claim_token OR j.claim_fence<>NEW.claim_fence OR
    j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'P3 durable resource acquisition fence unavailable';END IF;
 ELSIF (to_jsonb(NEW)-ARRAY['state','process_group','cleanup_observed','reason','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['state','process_group','cleanup_observed','reason','updated_at']) OR
       (OLD.process_group IS NOT NULL AND NEW.process_group IS DISTINCT FROM OLD.process_group) OR
       (OLD.state='CLEANED' AND NEW.state<>'CLEANED') THEN RAISE EXCEPTION 'P3 resource identity is immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER p3_resource_identity BEFORE INSERT OR UPDATE ON finnor_os.p3_resource_intents FOR EACH ROW EXECUTE FUNCTION finnor_os.p3_resource_guard();
CREATE TRIGGER p3_resource_no_delete BEFORE DELETE ON finnor_os.p3_resource_intents FOR EACH ROW EXECUTE FUNCTION finnor_os.p3_immutable();
ALTER TABLE finnor_os.p3_resource_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.p3_resource_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY p3_resource_private_scope ON finnor_os.p3_resource_intents
 USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON finnor_os.p3_resource_intents TO finnor_app;
CREATE INDEX p3_resources_reconcile_idx ON finnor_os.p3_resource_intents(tenant_id,principal_id,branch_id,created_at,id) WHERE state<>'CLEANED';
