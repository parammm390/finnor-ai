-- Scope-owned logical R4 SQL. The local candidate numeric slot is not reserved
-- against R1. Ordinary records, never protected science/activation or money.
CREATE TABLE finnor_os.r4_profiles (
 id uuid NOT NULL, tenant_id uuid NOT NULL, principal_id uuid NOT NULL, work_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), body jsonb NOT NULL, digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), UNIQUE(tenant_id,principal_id,work_id,revision),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 CHECK(octet_length(body::text)<=2097152)
);
CREATE TABLE finnor_os.r4_profile_heads (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, work_id uuid NOT NULL, profile_id uuid NOT NULL,
 revision integer NOT NULL, PRIMARY KEY(tenant_id,principal_id,work_id),
 FOREIGN KEY(tenant_id,principal_id,profile_id) REFERENCES finnor_os.r4_profiles(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.r4_episodes (
 id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 owner_episode text NOT NULL, policy_digest text NOT NULL, grant_digest text NOT NULL,
 deadline_at timestamptz NOT NULL, native_used integer NOT NULL DEFAULT 0,
 max_native integer NOT NULL CHECK(max_native BETWEEN 2 AND 64),
 owner_expansions_used integer NOT NULL DEFAULT 0,
 max_owner_expansions integer NOT NULL CHECK(max_owner_expansions>0),
 owner_call_pending boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), UNIQUE(tenant_id,principal_id,owner_episode),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(native_used BETWEEN 0 AND max_native),
 CHECK(owner_expansions_used BETWEEN 0 AND max_owner_expansions),
 CHECK(deadline_at<=created_at+interval '3600 seconds')
);
CREATE TABLE finnor_os.r4_runs (
 id uuid NOT NULL, tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 profile_id uuid NOT NULL, episode_id uuid NOT NULL, work_id uuid NOT NULL,
 request jsonb NOT NULL, request_digest text NOT NULL, idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','COMPLETE','INCOMPLETE','UNSUPPORTED','UNKNOWN','INVALIDATED','CANCELLED')),
 generation integer NOT NULL DEFAULT 1, head_id uuid, failure text,
 claim_token uuid, claim_fence bigint, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,profile_id) REFERENCES finnor_os.r4_profiles(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,episode_id) REFERENCES finnor_os.r4_episodes(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 CHECK(octet_length(request::text)<=65536)
);
CREATE TABLE finnor_os.r4_artifacts (
 id uuid NOT NULL, tenant_id uuid NOT NULL, principal_id uuid NOT NULL, run_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('INPUT','CANDIDATE','CHECK','PLAN','CONSUMER','FALLBACK')),
 body jsonb NOT NULL, digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,run_id) REFERENCES finnor_os.r4_runs(tenant_id,principal_id,id),
 CHECK(octet_length(body::text)<=67108864)
);
CREATE TABLE finnor_os.r4_dependencies (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, run_id uuid NOT NULL,
 key text NOT NULL, revision bigint NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,run_id,key),
 FOREIGN KEY(tenant_id,principal_id,run_id) REFERENCES finnor_os.r4_runs(tenant_id,principal_id,id)
);
CREATE INDEX r4_dependencies_closure ON finnor_os.r4_dependencies(tenant_id,key,run_id);
CREATE TABLE finnor_os.r4_attempts (
 id uuid NOT NULL, tenant_id uuid NOT NULL, principal_id uuid NOT NULL, run_id uuid NOT NULL,
 delivery_id uuid NOT NULL, claim_fence bigint NOT NULL, kind text NOT NULL CHECK(kind IN('PRODUCER','CHECKER')),
 status text NOT NULL CHECK(status IN('INTENT','SUBMITTED','COMPLETED','FAILED','UNKNOWN','TERMINATED')),
 body jsonb NOT NULL, digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), UNIQUE(tenant_id,principal_id,run_id,kind),
 FOREIGN KEY(tenant_id,principal_id,run_id) REFERENCES finnor_os.r4_runs(tenant_id,principal_id,id),
 FOREIGN KEY(delivery_id) REFERENCES finnor_os.job_delivery_attempts(id),
 CHECK(octet_length(body::text)<=262144)
);
CREATE TABLE finnor_os.r4_history (
 id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, principal_id uuid NOT NULL, run_id uuid NOT NULL,
 kind text NOT NULL, body jsonb NOT NULL, digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,run_id) REFERENCES finnor_os.r4_runs(tenant_id,principal_id,id),
 CHECK(octet_length(body::text)<=262144)
);
CREATE FUNCTION finnor_os.r4_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'R4 immutable history; append a linked record'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['r4_profiles','r4_profile_heads','r4_episodes','r4_runs','r4_artifacts','r4_dependencies','r4_attempts','r4_history'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY r4_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t IN('r4_profiles','r4_artifacts','r4_dependencies','r4_history') THEN
   EXECUTE format('CREATE TRIGGER r4_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.r4_immutable()',t);
  ELSE EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',t); END IF;
 END LOOP;
END $$;
CREATE FUNCTION finnor_os.r4_state_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'R4 state and incurred responsibility cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','generation','head_id','failure','claim_token','claim_fence','native_used','owner_expansions_used','owner_call_pending','body','digest','updated_at','profile_id','revision'])
   IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['status','generation','head_id','failure','claim_token','claim_fence','native_used','owner_expansions_used','owner_call_pending','body','digest','updated_at','profile_id','revision'])
 THEN RAISE EXCEPTION 'R4 original identity, episode deadline and grant are immutable'; END IF;
 IF TG_TABLE_NAME='r4_episodes' THEN
  IF NEW.native_used<OLD.native_used OR NEW.native_used>OLD.native_used+1
  THEN RAISE EXCEPTION 'R4 native usage is monotone one admitted child at a time'; END IF;
  IF NEW.owner_expansions_used<OLD.owner_expansions_used
  THEN RAISE EXCEPTION 'R4 owner expansions cannot be refunded'; END IF;
 END IF;
 IF TG_TABLE_NAME='r4_runs' THEN
  IF NEW.request IS DISTINCT FROM OLD.request OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
  THEN RAISE EXCEPTION 'R4 run preimage/generation cannot be rewritten'; END IF;
  IF OLD.status IN('CANCELLED','INVALIDATED') AND NEW.status IS DISTINCT FROM OLD.status
  THEN RAISE EXCEPTION 'R4 terminal validity cannot be revived'; END IF;
  IF OLD.status='COMPLETE' AND NEW.status NOT IN('COMPLETE','CANCELLED','INVALIDATED')
  THEN RAISE EXCEPTION 'R4 accepted artifact cannot be replaced by a retry'; END IF;
  IF NEW.head_id IS DISTINCT FROM OLD.head_id AND NEW.head_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM finnor_os.r4_episodes e
      WHERE e.tenant_id=NEW.tenant_id AND e.principal_id=NEW.principal_id
        AND e.id=NEW.episode_id AND e.deadline_at>clock_timestamp())
  THEN RAISE EXCEPTION 'R4_PUBLICATION_ORIGINAL_DEADLINE_EXHAUSTED'; END IF;
 END IF;
 IF TG_TABLE_NAME='r4_attempts' THEN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
    OR NEW.claim_fence IS DISTINCT FROM OLD.claim_fence OR NEW.run_id IS DISTINCT FROM OLD.run_id
  THEN RAISE EXCEPTION 'R4 accepted physical identity cannot be retried or relabeled'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['r4_profile_heads','r4_episodes','r4_runs','r4_attempts'] LOOP
  EXECUTE format('CREATE TRIGGER r4_state_guard BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.r4_state_guard()',t);
 END LOOP;
END $$;
-- An existing canonical revision change is P7 input. Invalidation fences the
-- exact dependent claims immediately, preserving costs and physical attempts.
CREATE FUNCTION finnor_os.r4_dependency_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE r record; BEGIN
 FOR r IN UPDATE finnor_os.r4_runs q SET status='INVALIDATED',generation=generation+1,
   failure='R4_DEPENDENCY_REVISED',updated_at=clock_timestamp()
  WHERE q.tenant_id=NEW.tenant_id AND q.status IN('QUEUED','RUNNING','COMPLETE','INCOMPLETE','UNKNOWN','UNSUPPORTED')
   AND EXISTS(SELECT 1 FROM finnor_os.r4_dependencies d WHERE d.tenant_id=q.tenant_id AND d.principal_id=q.principal_id
     AND d.run_id=q.id AND d.key=NEW.key AND d.revision<>NEW.revision)
  RETURNING q.*
 LOOP
  INSERT INTO finnor_os.r4_history(tenant_id,principal_id,run_id,kind,body,digest)
   VALUES(r.tenant_id,r.principal_id,r.id,'P7_INVALIDATED',jsonb_build_object('key',NEW.key,'revision',NEW.revision,
     'originalEpisode',r.episode_id,'costsRetained',true,'physicalRetryGranted',false),'SQL_TRIGGER_REVISION');
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.r4_dependency_change() FROM PUBLIC;
CREATE TRIGGER r4_dependency_change AFTER INSERT OR UPDATE ON finnor_os.p4_source_revisions
 FOR EACH ROW EXECUTE FUNCTION finnor_os.r4_dependency_change();
-- These real owner registries are not covered by the earlier generic source
-- trigger. Touch only the R4-specific dependency namespace.
CREATE FUNCTION finnor_os.r4_owner_revision_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE j jsonb; t uuid; k text; BEGIN
 j:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;t:=(j->>'tenant_id')::uuid;
 IF TG_TABLE_NAME='r4_profile_heads' THEN k:='r4:profile:'||(j->>'work_id')||':'||(j->>'principal_id');
 ELSIF TG_TABLE_NAME='s5_resource_heads' THEN k:='r4:s5-resource:'||(j->>'resource_id');
 ELSIF TG_TABLE_NAME='s5_reservations' THEN k:='r4:s5-grant:'||(j->>'allocation_digest');
 ELSIF TG_TABLE_NAME='works' THEN k:='r4:work:'||(j->>'id');
 ELSE
  IF j->>'revision_of' IS NOT NULL THEN
   PERFORM finnor_os.p4_touch_source(t,'r4:s7:'||(j->>'revision_of'));
  END IF;
  IF j->>'kind' IN('CORRECTION','INVALIDATION') AND j->>'estimand_id' IS NOT NULL THEN
   PERFORM finnor_os.p4_touch_source(t,'r4:s7:'||(j->>'estimand_id'));
  END IF;
  k:='r4:s7:'||(j->>'record_id');
 END IF;
 PERFORM finnor_os.p4_touch_source(t,k);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.r4_owner_revision_change() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['r4_profile_heads','s5_resource_heads','s5_reservations','works','s7_economic_records'] LOOP
  EXECUTE format('CREATE TRIGGER r4_owner_revision_change AFTER INSERT OR UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.r4_owner_revision_change()',t);
 END LOOP;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_identification_plan_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'Bounded ordinary R4 search/check under one original S4/S5 episode; no acquisition authority.');
-- Operator/fixture must configure native:r4 capacity. This migration does not
-- invent funded throughput, an aggregate-container memory proof, or a grant.
