-- X3 owns application data, not financial truth, role grants or an effect ledger.
-- Existing applied migrations and their identities are retained.
CREATE TABLE finnor_os.x3_applications(
 tenant_id uuid NOT NULL,id uuid NOT NULL,owner_id uuid NOT NULL,
 root_type text NOT NULL,root_id uuid NOT NULL,work_id uuid NOT NULL,
 idempotency_key text NOT NULL,request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','BUILDING','INSTALLING','INSTALLED','FAILED','CANCELLED')),
 head_release_id uuid,deadline_at timestamptz NOT NULL,
 max_builds integer NOT NULL CHECK(max_builds BETWEEN 1 AND 16),
 max_mutations integer NOT NULL CHECK(max_mutations BETWEEN 1 AND 10000),
 build_count integer NOT NULL DEFAULT 0 CHECK(build_count BETWEEN 0 AND max_builds),
 mutation_count integer NOT NULL DEFAULT 0 CHECK(mutation_count BETWEEN 0 AND max_mutations),
 release_count integer NOT NULL DEFAULT 0 CHECK(release_count BETWEEN 0 AND 8),
 data_bytes bigint NOT NULL DEFAULT 0 CHECK(data_bytes BETWEEN 0 AND 16777216),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,owner_id,idempotency_key),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.x3_builds(
 tenant_id uuid NOT NULL,id uuid NOT NULL,application_id uuid NOT NULL,generation integer NOT NULL,
 specification jsonb NOT NULL CHECK(octet_length(specification::text)<=524288),
 specification_digest text NOT NULL CHECK(specification_digest~'^[a-f0-9]{64}$'),
 base_release_id uuid,change_class text NOT NULL CHECK(change_class IN('INITIAL','BUSINESS_RULES_UNITS','IDENTITY_AUTHORIZATION_CONCURRENCY','DEPENDENCY_SCHEMA_DEPLOYMENT')),
 work_input_id uuid NOT NULL,work_input_digest text NOT NULL,
 environment jsonb NOT NULL,migration jsonb NOT NULL DEFAULT '[]'::jsonb,
 install_not_before timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','BUILDING','STAGED','INSTALLED','FAILED','INVALIDATED','CANCELLED')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 16),
 active_delivery_id uuid,active_claim_token uuid,active_claim_fence bigint,
 failure jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,application_id,generation),
 FOREIGN KEY(tenant_id,application_id) REFERENCES finnor_os.x3_applications(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);
CREATE TABLE finnor_os.x3_releases(
 tenant_id uuid NOT NULL,id uuid NOT NULL,application_id uuid NOT NULL,build_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=16777216),
 body_digest text NOT NULL CHECK(body_digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,build_id),
 FOREIGN KEY(tenant_id,application_id) REFERENCES finnor_os.x3_applications(tenant_id,id),
 FOREIGN KEY(tenant_id,build_id) REFERENCES finnor_os.x3_builds(tenant_id,id)
);
ALTER TABLE finnor_os.x3_applications ADD FOREIGN KEY(tenant_id,head_release_id) REFERENCES finnor_os.x3_releases(tenant_id,id);
CREATE TABLE finnor_os.x3_records(
 tenant_id uuid NOT NULL,id uuid NOT NULL,application_id uuid NOT NULL,entity_id text NOT NULL,
 author_id uuid NOT NULL,origin_release_id uuid NOT NULL,release_id uuid NOT NULL,schema_release_id uuid NOT NULL,
 content_revision integer NOT NULL DEFAULT 1 CHECK(content_revision>0),
 concurrency_revision integer NOT NULL DEFAULT 1 CHECK(concurrency_revision>0),
 state text NOT NULL,values jsonb NOT NULL CHECK(octet_length(values::text)<=262144),
 content_digest text NOT NULL CHECK(content_digest~'^[a-f0-9]{64}$'),
 approvals jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_array_length(approvals)<=256),
 prepared_intent jsonb,pending_effect_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,application_id) REFERENCES finnor_os.x3_applications(tenant_id,id),
 FOREIGN KEY(tenant_id,author_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,origin_release_id) REFERENCES finnor_os.x3_releases(tenant_id,id),
 FOREIGN KEY(tenant_id,schema_release_id) REFERENCES finnor_os.x3_releases(tenant_id,id),
 FOREIGN KEY(tenant_id,release_id) REFERENCES finnor_os.x3_releases(tenant_id,id)
);
CREATE TABLE finnor_os.x3_events(
 id bigserial PRIMARY KEY,tenant_id uuid NOT NULL,application_id uuid NOT NULL,
 record_id uuid,build_id uuid,actor_id uuid NOT NULL,kind text NOT NULL,
 idempotency_key text NOT NULL,request_digest text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,application_id,actor_id,idempotency_key),
 FOREIGN KEY(tenant_id,application_id) REFERENCES finnor_os.x3_applications(tenant_id,id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES finnor_os.x3_records(tenant_id,id),
 FOREIGN KEY(tenant_id,build_id) REFERENCES finnor_os.x3_builds(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.x3_spec_fragments(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,upload_id uuid NOT NULL,part integer NOT NULL CHECK(part BETWEEN 0 AND 7),
 total_parts integer NOT NULL CHECK(total_parts BETWEEN 1 AND 8),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 bytes text NOT NULL CHECK(octet_length(bytes)<=49152),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,upload_id,part),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE INDEX x3_application_work_idx ON finnor_os.x3_applications(tenant_id,work_id,created_at,id);
CREATE INDEX x3_records_application_idx ON finnor_os.x3_records(tenant_id,application_id,id);
CREATE INDEX x3_events_application_idx ON finnor_os.x3_events(tenant_id,application_id,id);
CREATE FUNCTION finnor_os.x3_original_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['generation','status','head_release_id','build_count','mutation_count','release_count','data_bytes','updated_at']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['generation','status','head_release_id','build_count','mutation_count','release_count','data_bytes','updated_at']
  OR NEW.generation<OLD.generation OR NEW.build_count<OLD.build_count OR NEW.mutation_count<OLD.mutation_count
  OR NEW.release_count<OLD.release_count OR NEW.data_bytes<OLD.data_bytes
 THEN RAISE EXCEPTION 'X3 original allocation and consumed resources cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION finnor_os.x3_build_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['status','attempt_count','active_delivery_id','active_claim_token','active_claim_fence','failure','updated_at']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','attempt_count','active_delivery_id','active_claim_token','active_claim_fence','failure','updated_at']
  OR NEW.attempt_count<OLD.attempt_count THEN RAISE EXCEPTION 'X3 accepted build inputs are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION finnor_os.x3_record_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.application_id<>OLD.application_id OR NEW.entity_id<>OLD.entity_id
  OR NEW.author_id<>OLD.author_id OR NEW.origin_release_id<>OLD.origin_release_id
  OR NEW.content_revision<OLD.content_revision OR NEW.concurrency_revision<=OLD.concurrency_revision
 THEN RAISE EXCEPTION 'X3 record identity/history cannot reset'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['x3_applications','x3_builds','x3_releases','x3_records','x3_events','x3_spec_fragments'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY x3_tenant ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id())',t);
  EXECUTE format('REVOKE ALL ON finnor_os.%I FROM finnor_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t IN('x3_applications','x3_builds','x3_records') THEN
   EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t);
  ELSIF t='x3_spec_fragments' THEN
   -- Transport is released only after accepted immutable inputs have been
   -- copied, or after an abandoned upload's bounded lifetime.
   EXECUTE format('GRANT DELETE ON finnor_os.%I TO finnor_app',t);
   EXECUTE format('CREATE TRIGGER x3_immutable BEFORE UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.m3_immutable()',t);
  ELSE EXECUTE format('CREATE TRIGGER x3_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.m3_immutable()',t);
  END IF;
 END LOOP;
END $$;
CREATE TRIGGER x3_allocation_immutable BEFORE UPDATE ON finnor_os.x3_applications FOR EACH ROW EXECUTE FUNCTION finnor_os.x3_original_allocation();
CREATE TRIGGER x3_build_immutable BEFORE UPDATE ON finnor_os.x3_builds FOR EACH ROW EXECUTE FUNCTION finnor_os.x3_build_update();
CREATE TRIGGER x3_record_identity BEFORE UPDATE ON finnor_os.x3_records FOR EACH ROW EXECUTE FUNCTION finnor_os.x3_record_update();
-- Conservative UTF-8 JSON storage ledger: all owned durable payloads, not just
-- events. Growth is cumulative; shrink, rollback and retries never refund it.
-- This is not a measurement of PostgreSQL's physical disk or aggregate RAM.
CREATE FUNCTION finnor_os.x3_retained_storage() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE allocation_id uuid; delta bigint;
BEGIN
 IF TG_TABLE_NAME='x3_applications' THEN allocation_id:=NEW.id; ELSE allocation_id:=NEW.application_id; END IF;
 delta:=octet_length(to_jsonb(NEW)::text);
 IF TG_OP='UPDATE' THEN delta:=greatest(0,delta-octet_length(to_jsonb(OLD)::text)); END IF;
 IF delta>0 THEN
  UPDATE finnor_os.x3_applications SET data_bytes=data_bytes+delta WHERE tenant_id=NEW.tenant_id AND id=allocation_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER x3_storage AFTER INSERT ON finnor_os.x3_applications FOR EACH ROW EXECUTE FUNCTION finnor_os.x3_retained_storage();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['x3_builds','x3_releases','x3_records','x3_events'] LOOP
  EXECUTE format('CREATE TRIGGER x3_storage AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.x3_retained_storage()',t);
 END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE finnor_os.x3_events_id_seq TO finnor_app;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('build_enterprise_application_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'X3 bounded data-only compilation and transactional development installation under the original allocation; no guest code or protected authority.');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:x3-build',1,1,0,90,'X3 serial bounded compilation; source runtime and original deadline remain independently fenced');
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:x3-client',16,16,0,45,'X3 bounded authenticated client operations; no guest processes or authority grants');
