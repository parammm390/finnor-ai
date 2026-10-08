-- Candidate0156, final slot/bundle assignment belongs to the integration writer.
CREATE TABLE finnor_os.p3_artifacts (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id), work_id uuid NOT NULL REFERENCES finnor_os.works(id),
 category text NOT NULL CHECK(category IN ('INPUT','ATTEMPT','EVENT','RESULT','CHECKPOINT','COST','CLEANUP')),
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,category,content_digest)
);
CREATE TABLE finnor_os.p3_requests (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id), work_id uuid NOT NULL REFERENCES finnor_os.works(id),
 input_id uuid NOT NULL REFERENCES finnor_os.p3_artifacts(id), request jsonb NOT NULL,
 request_digest text NOT NULL, basis jsonb NOT NULL, idempotency_key text NOT NULL,
 generation integer NOT NULL DEFAULT 1, epoch integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'PREPARING' CHECK(status IN ('PREPARING','RUNNING','CHECKPOINTING','CHECKING','COMPLETE','CANCEL_REQUESTED','CANCELLED','INTERRUPTED','FAILED','INVALIDATED','QUARANTINED')),
 job_id uuid REFERENCES finnor_os.jobs(id), attempt_id uuid REFERENCES finnor_os.p3_artifacts(id),
 result_id uuid REFERENCES finnor_os.p3_artifacts(id), checkpoint_id uuid REFERENCES finnor_os.p3_artifacts(id),
 reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,idempotency_key)
);
CREATE INDEX p3_current_work_idx ON finnor_os.p3_requests(tenant_id,principal_id,work_id,created_at DESC,id);
CREATE INDEX p3_attempts_work_idx ON finnor_os.p3_artifacts(tenant_id,principal_id,work_id,category,recorded_at);
CREATE FUNCTION finnor_os.p3_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'P3 append-only artifact'; END $$;
CREATE TRIGGER p3_artifact_guard BEFORE UPDATE OR DELETE ON finnor_os.p3_artifacts FOR EACH ROW EXECUTE FUNCTION finnor_os.p3_immutable();
CREATE FUNCTION finnor_os.p3_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target finnor_os.p3_artifacts; delivery finnor_os.jobs; scope_ok boolean;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.work_id,NEW.input_id,NEW.request,NEW.request_digest,NEW.basis,NEW.idempotency_key,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.work_id,OLD.input_id,OLD.request,OLD.request_digest,OLD.basis,OLD.idempotency_key,OLD.created_at)
   THEN RAISE EXCEPTION 'P3 request identity is immutable'; END IF;
  IF NEW.epoch<OLD.epoch OR NEW.generation<OLD.generation THEN RAISE EXCEPTION 'P3 epoch cannot regress'; END IF;
  IF OLD.status<>NEW.status AND NOT(
    (OLD.status='PREPARING' AND NEW.status='RUNNING') OR
    (OLD.status='RUNNING' AND NEW.status IN ('CHECKPOINTING','CHECKING')) OR
    (OLD.status='CHECKPOINTING' AND NEW.status IN ('RUNNING','CHECKING')) OR
    (OLD.status='CHECKING' AND NEW.status='COMPLETE') OR
    (OLD.status='CANCEL_REQUESTED' AND NEW.status='CANCELLED') OR
    (OLD.status='INTERRUPTED' AND NEW.status='PREPARING' AND NEW.generation=OLD.generation+1) OR
    (OLD.status NOT IN ('COMPLETE','CANCELLED','FAILED','INVALIDATED','QUARANTINED') AND NEW.status IN ('CANCEL_REQUESTED','INTERRUPTED','FAILED','INVALIDATED','QUARANTINED')) OR
    (OLD.status='COMPLETE' AND NEW.status='INVALIDATED')
   ) THEN RAISE EXCEPTION 'P3 illegal transition'; END IF;
 END IF;
 SELECT EXISTS(SELECT 1 FROM finnor_os.works w JOIN finnor_os.users u ON u.tenant_id=w.tenant_id
   WHERE w.id=NEW.work_id AND w.tenant_id=NEW.tenant_id AND u.id=NEW.principal_id) INTO scope_ok;
 IF NOT scope_ok THEN RAISE EXCEPTION 'P3 scope binding'; END IF;
 SELECT * INTO target FROM finnor_os.p3_artifacts WHERE id=NEW.input_id;
 IF target.id IS NULL OR target.category<>'INPUT' OR target.tenant_id<>NEW.tenant_id OR target.principal_id<>NEW.principal_id OR target.work_id<>NEW.work_id THEN RAISE EXCEPTION 'P3 input binding'; END IF;
 IF NEW.result_id IS DISTINCT FROM OLD.result_id AND NEW.result_id IS NOT NULL THEN
  SELECT * INTO target FROM finnor_os.p3_artifacts WHERE id=NEW.result_id;
  IF target.id IS NULL OR target.category<>'RESULT' OR target.tenant_id<>NEW.tenant_id OR target.principal_id<>NEW.principal_id OR target.work_id<>NEW.work_id
   OR target.body->>'branchId'<>NEW.id::text OR (target.body->>'generation')::integer<>NEW.generation THEN RAISE EXCEPTION 'P3 result binding'; END IF;
  SELECT * INTO delivery FROM finnor_os.jobs WHERE id=NEW.job_id FOR SHARE;
  IF delivery.status<>'running' OR delivery.claim_token::text<>target.body->>'claimToken'
   OR delivery.claim_fence<>(target.body->>'claimFence')::bigint OR delivery.lease_expires_at<=clock_timestamp()
   THEN RAISE EXCEPTION 'P3 publication fence lost'; END IF;
  IF NEW.status<>'COMPLETE' THEN RAISE EXCEPTION 'P3 check before publication required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER p3_head_guard BEFORE INSERT OR UPDATE ON finnor_os.p3_requests FOR EACH ROW EXECUTE FUNCTION finnor_os.p3_head_guard();
ALTER TABLE finnor_os.p3_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.p3_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.p3_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.p3_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY p3_artifact_scope ON finnor_os.p3_artifacts USING
 (tenant_id::text=current_setting('app.tenant_id',true) AND principal_id::text=current_setting('app.user_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND principal_id::text=current_setting('app.user_id',true));
CREATE POLICY p3_request_scope ON finnor_os.p3_requests USING
 (tenant_id::text=current_setting('app.tenant_id',true) AND principal_id::text=current_setting('app.user_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND principal_id::text=current_setting('app.user_id',true));
GRANT SELECT,INSERT ON finnor_os.p3_artifacts TO finnor_app;
GRANT SELECT,INSERT,UPDATE ON finnor_os.p3_requests TO finnor_app;
INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_branch_fabric_v1','HEAVY',ARRAY['HEAVY'],'fixed','tenant','required',1,'P3 finite registered branch computation, isolated development domain; no funding/admission.');
INSERT INTO finnor_os.compute_resource_policies
 (resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:p3-branch',2,1,0,120,'P3 engineering bound,512MiB per isolated cell; not S5 funding.');
