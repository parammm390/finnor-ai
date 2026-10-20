-- X5 stores operational learning artifacts, not rewards, grants or promotion truth.
CREATE TABLE finnor_os.x5_training_rights(
 tenant_id uuid NOT NULL,id uuid NOT NULL,application_id uuid NOT NULL,owner_id uuid NOT NULL,
 body jsonb NOT NULL,body_digest text NOT NULL CHECK(body_digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,application_id) REFERENCES finnor_os.x3_applications(tenant_id,id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE UNIQUE INDEX x5_consent_idempotency ON finnor_os.x5_training_rights(tenant_id,owner_id,(body->>'idempotencyKey'));
CREATE TABLE finnor_os.x5_rights_revocations(
 tenant_id uuid NOT NULL,consent_id uuid NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL,
 idempotency_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,consent_id),FOREIGN KEY(tenant_id,consent_id) REFERENCES finnor_os.x5_training_rights(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.x5_compilations(
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,root_type text NOT NULL,root_id uuid NOT NULL,
 work_id uuid NOT NULL,work_input_id uuid NOT NULL,work_input_digest text NOT NULL,
 request jsonb NOT NULL,request_digest text NOT NULL,environment jsonb NOT NULL,
 deadline_at timestamptz NOT NULL,max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 8),
 max_uses integer NOT NULL CHECK(max_uses BETWEEN 1 AND 256),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND max_attempts),
 use_count integer NOT NULL DEFAULT 0 CHECK(use_count BETWEEN 0 AND max_uses),
 data_bytes bigint NOT NULL DEFAULT 0 CHECK(data_bytes BETWEEN 0 AND 16777216),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','TRAINING','DEVELOPMENT_READY','FAILED','CANCELLED','INVALIDATED')),
 head_release_id uuid,idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,idempotency_key),UNIQUE(tenant_id,work_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);
CREATE TABLE finnor_os.x5_releases(
 tenant_id uuid NOT NULL,id uuid NOT NULL,compilation_id uuid NOT NULL,attempt integer NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=4194304),
 body_digest text NOT NULL CHECK(body_digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,compilation_id,attempt),
 FOREIGN KEY(tenant_id,compilation_id) REFERENCES finnor_os.x5_compilations(tenant_id,id)
);
ALTER TABLE finnor_os.x5_compilations ADD FOREIGN KEY(tenant_id,head_release_id) REFERENCES finnor_os.x5_releases(tenant_id,id);
CREATE TABLE finnor_os.x5_uses(
 tenant_id uuid NOT NULL,id uuid NOT NULL,compilation_id uuid NOT NULL,release_id uuid NOT NULL,principal_id uuid NOT NULL,
 request jsonb NOT NULL,request_digest text NOT NULL,idempotency_key text NOT NULL,
 checkpoint_digest text NOT NULL,policy_digest text NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','WAIT','DONE','FAILED','CANCELLED')),
 result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,compilation_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,compilation_id) REFERENCES finnor_os.x5_compilations(tenant_id,id),
 FOREIGN KEY(tenant_id,release_id) REFERENCES finnor_os.x5_releases(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.x5_evaluations(
 tenant_id uuid NOT NULL,id uuid NOT NULL,compilation_id uuid NOT NULL,release_id uuid NOT NULL,evaluator_id uuid NOT NULL,
 request jsonb NOT NULL,request_digest text NOT NULL,idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','COMPLETE','FAILED')),
 result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,compilation_id,evaluator_id,idempotency_key),
 FOREIGN KEY(tenant_id,compilation_id) REFERENCES finnor_os.x5_compilations(tenant_id,id),
 FOREIGN KEY(tenant_id,release_id) REFERENCES finnor_os.x5_releases(tenant_id,id),
 FOREIGN KEY(tenant_id,evaluator_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.x5_events(
 id bigserial PRIMARY KEY,tenant_id uuid NOT NULL,compilation_id uuid NOT NULL,actor_id uuid NOT NULL,
 kind text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 idempotency_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,compilation_id,idempotency_key),
 FOREIGN KEY(tenant_id,compilation_id) REFERENCES finnor_os.x5_compilations(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE INDEX x5_work_idx ON finnor_os.x5_compilations(tenant_id,work_id,created_at,id);
CREATE INDEX x5_events_idx ON finnor_os.x5_events(tenant_id,compilation_id,id);
CREATE INDEX x5_uses_idx ON finnor_os.x5_uses(tenant_id,compilation_id,id);
CREATE FUNCTION finnor_os.x5_original_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['attempt_count','use_count','data_bytes','generation','status','head_release_id']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['attempt_count','use_count','data_bytes','generation','status','head_release_id']
 OR NEW.attempt_count<OLD.attempt_count OR NEW.use_count<OLD.use_count OR NEW.data_bytes<OLD.data_bytes OR NEW.generation<OLD.generation
 THEN RAISE EXCEPTION 'X5 original allocation/inputs cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION finnor_os.x5_progress_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['status','result'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','result']
 OR OLD.status IN('DONE','WAIT','FAILED','CANCELLED','COMPLETE')
 THEN RAISE EXCEPTION 'X5 invocation identity/outcome cannot change'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER x5_allocation BEFORE UPDATE ON finnor_os.x5_compilations FOR EACH ROW EXECUTE FUNCTION finnor_os.x5_original_allocation();
CREATE TRIGGER x5_use_identity BEFORE UPDATE ON finnor_os.x5_uses FOR EACH ROW EXECUTE FUNCTION finnor_os.x5_progress_only();
CREATE TRIGGER x5_evaluation_identity BEFORE UPDATE ON finnor_os.x5_evaluations FOR EACH ROW EXECUTE FUNCTION finnor_os.x5_progress_only();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['x5_training_rights','x5_rights_revocations','x5_compilations','x5_releases','x5_uses','x5_evaluations','x5_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY x5_tenant ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id())',t);
  EXECUTE format('REVOKE ALL ON finnor_os.%I FROM finnor_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t IN('x5_compilations','x5_uses','x5_evaluations') THEN
   EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t);
  ELSE
   EXECUTE format('CREATE TRIGGER x5_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.m3_immutable()',t);
  END IF;
 END LOOP;
END $$;
CREATE FUNCTION finnor_os.x5_retained_storage() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE allocation_id uuid; delta bigint;
BEGIN
 IF TG_TABLE_NAME='x5_compilations' THEN allocation_id:=NEW.id; ELSE allocation_id:=NEW.compilation_id; END IF;
 delta:=octet_length(to_jsonb(NEW)::text);
 IF TG_OP='UPDATE' THEN delta:=greatest(0,delta-octet_length(to_jsonb(OLD)::text)); END IF;
 IF delta>0 THEN UPDATE finnor_os.x5_compilations SET data_bytes=data_bytes+delta WHERE tenant_id=NEW.tenant_id AND id=allocation_id; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER x5_storage AFTER INSERT ON finnor_os.x5_compilations FOR EACH ROW EXECUTE FUNCTION finnor_os.x5_retained_storage();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['x5_releases','x5_uses','x5_evaluations','x5_events'] LOOP
  EXECUTE format('CREATE TRIGGER x5_storage AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.x5_retained_storage()',t);
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE finnor_os.x5_events_id_seq TO finnor_app;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('compile_learned_policy_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'X5 bounded physical training, native guarded use and independent outcome evaluation under original parent resources; no protected authority.');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:x5-learning',1,1,0,90,'X5 serial CPU training/inference/evaluation, original immutable deadline and physical claim fences');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:x5-client',2,2,0,30,'X5 bounded authenticated request concurrency, no resource authority expansion');
