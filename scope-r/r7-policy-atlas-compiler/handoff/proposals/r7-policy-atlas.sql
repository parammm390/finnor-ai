-- Base-local order. A serial R integrator must renumber competing 0172 additions.
-- Ordinary exact proposals, not protected verification, funding or effects.
CREATE TABLE finnor_os.r7_episodes(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,episode_id text NOT NULL,
 deadline_at timestamptz NOT NULL,max_invocations integer NOT NULL CHECK(max_invocations=64),
 invocations integer NOT NULL DEFAULT 0 CHECK(invocations BETWEEN 0 AND 64),
 PRIMARY KEY(tenant_id,principal_id,episode_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.r7_families(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,content_digest text NOT NULL CHECK(content_digest~'^[a-f0-9]{64}$'),
 work_id uuid NOT NULL,root_type text NOT NULL,root_id uuid NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=33554432),
 PRIMARY KEY(tenant_id,principal_id,content_digest),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.r7_family_heads(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,root_type text NOT NULL,root_id uuid NOT NULL,
 content_digest text NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,work_id,root_type,root_id),
 FOREIGN KEY(tenant_id,principal_id,content_digest) REFERENCES finnor_os.r7_families
);
CREATE TABLE finnor_os.r7_parameters(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,content_digest text NOT NULL,family_digest text NOT NULL,revision integer NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8192),
 PRIMARY KEY(tenant_id,principal_id,content_digest),UNIQUE(tenant_id,principal_id,family_digest,revision),
 FOREIGN KEY(tenant_id,principal_id,family_digest) REFERENCES finnor_os.r7_families
);
CREATE TABLE finnor_os.r7_parameter_heads(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,family_digest text NOT NULL,content_digest text NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,family_digest),
 FOREIGN KEY(tenant_id,principal_id,content_digest) REFERENCES finnor_os.r7_parameters
);
CREATE TABLE finnor_os.r7_builds(
 id uuid NOT NULL,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,family_digest text NOT NULL,
 episode_id text NOT NULL,deadline_at timestamptz NOT NULL,idempotency_key text NOT NULL,request_digest text NOT NULL,
 request jsonb NOT NULL,input jsonb NOT NULL CHECK(octet_length(input::text)<=33554432),
 generation integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'QUEUED'
 CHECK(status IN('QUEUED','RUNNING','COMPLETE','INCOMPLETE','FAILED','INVALIDATED','CANCELLED')),
 result_digest text,active_claim_token uuid,active_claim_fence bigint,failure jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,family_digest) REFERENCES finnor_os.r7_families,
 FOREIGN KEY(tenant_id,principal_id,episode_id) REFERENCES finnor_os.r7_episodes
);
CREATE TABLE finnor_os.r7_atlases(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,content_digest text NOT NULL,build_id uuid NOT NULL,
 generation integer NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=33554432),
 PRIMARY KEY(tenant_id,principal_id,content_digest),UNIQUE(tenant_id,principal_id,build_id,generation),
 FOREIGN KEY(tenant_id,principal_id,build_id) REFERENCES finnor_os.r7_builds
);
CREATE TABLE finnor_os.r7_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,build_id uuid NOT NULL,
 attempt_id uuid NOT NULL,kind text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=33554432),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,build_id) REFERENCES finnor_os.r7_builds
);
CREATE TABLE finnor_os.r7_queries(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,content_digest text NOT NULL,build_id uuid NOT NULL,
 idempotency_key text NOT NULL,request_digest text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=33554432),
 PRIMARY KEY(tenant_id,principal_id,content_digest),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,build_id) REFERENCES finnor_os.r7_builds
);
CREATE INDEX r7_builds_work ON finnor_os.r7_builds(tenant_id,principal_id,work_id,created_at DESC,id DESC);
CREATE INDEX r7_events_build ON finnor_os.r7_events(tenant_id,principal_id,build_id,created_at,id);
CREATE FUNCTION finnor_os.r7_build_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-ARRAY['status','generation','result_digest','active_claim_token','active_claim_fence','failure','updated_at']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','generation','result_digest','active_claim_token','active_claim_fence','failure','updated_at']
 THEN RAISE EXCEPTION 'R7 original input and episode are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION finnor_os.r7_episode_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF to_jsonb(NEW)-'invocations' IS DISTINCT FROM to_jsonb(OLD)-'invocations' OR NEW.invocations<OLD.invocations
 THEN RAISE EXCEPTION 'R7 cannot reset its original grant or consumed work'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['r7_episodes','r7_families','r7_family_heads','r7_parameters','r7_parameter_heads','r7_builds','r7_atlases','r7_events','r7_queries'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY r7_principal ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON finnor_os.%I FROM finnor_app',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t NOT IN('r7_episodes','r7_builds','r7_family_heads','r7_parameter_heads') THEN
   EXECUTE format('CREATE TRIGGER r7_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.m3_immutable()',t);
  ELSE EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t); END IF;
 END LOOP;
 CREATE TRIGGER r7_build_immutable BEFORE UPDATE ON finnor_os.r7_builds FOR EACH ROW EXECUTE FUNCTION finnor_os.r7_build_update();
 CREATE TRIGGER r7_episode_immutable BEFORE UPDATE ON finnor_os.r7_episodes FOR EACH ROW EXECUTE FUNCTION finnor_os.r7_episode_update();
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_decision_atlas_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'Exact finite-family atlas, separate bounded checker; no effects or protected admission.');
-- Parameter changes are typed S4 owner revisions, not structural P7 mutations.
-- Structural, rights, source, Work, method and S6 changes reuse locked P4 keys.
