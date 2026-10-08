-- Track-C forward candidate after the inspected 0162 P5 registry.
-- The complete filename, not an exclusive global numeric slot, is its identity.
-- Ordinary source-bound continuation metadata, not a new Work/effect authority.
CREATE TABLE finnor_os.p7_intake_intents(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,prior_request_id uuid NOT NULL,
 event_key text NOT NULL CHECK(event_key ~ '^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,event_key),
 FOREIGN KEY(tenant_id,principal_id,prior_request_id) REFERENCES finnor_os.p1_requests(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.p7_continuations(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 prior_request_id uuid NOT NULL,prior_head_id uuid NOT NULL REFERENCES finnor_os.p1_programs(id),
 episode_id uuid NOT NULL REFERENCES finnor_os.p1_episodes(id),
 event_key text NOT NULL CHECK(event_key ~ '^[a-f0-9]{64}$'),
 event_body jsonb NOT NULL CHECK(octet_length(event_body::text)<=262144),
 event_digest text NOT NULL CHECK(event_digest ~ '^[a-f0-9]{64}$'),
 source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 affected_nodes text[] NOT NULL CHECK(cardinality(affected_nodes)<=256),
 kept_nodes text[] NOT NULL CHECK(cardinality(kept_nodes)<=256),
 state text NOT NULL DEFAULT 'ACCEPTED' CHECK(state IN('ACCEPTED','PREPARED','PUBLISHED','SUPERSEDED','FAILED')),
 next_request_id uuid REFERENCES finnor_os.p1_requests(id),polls integer NOT NULL DEFAULT 0 CHECK(polls BETWEEN 0 AND 60),
 reason text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,event_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id,prior_request_id) REFERENCES finnor_os.p1_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.p7_manifests(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,work_id uuid NOT NULL,
 continuation_id uuid NOT NULL UNIQUE,body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),patch jsonb NOT NULL CHECK(octet_length(patch::text)<=8388608),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,continuation_id) REFERENCES finnor_os.p7_continuations(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.p7_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,
 continuation_id uuid NOT NULL,kind text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,continuation_id) REFERENCES finnor_os.p7_continuations(tenant_id,principal_id,id)
);
CREATE FUNCTION finnor_os.p7_guard_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' OR TG_TABLE_NAME<>'p7_continuations' THEN
  RAISE EXCEPTION 'P7 continuation history and manifestations are append-only';
 END IF;
 IF ROW(OLD.id,OLD.tenant_id,OLD.principal_id,OLD.work_id,OLD.prior_request_id,OLD.prior_head_id,OLD.episode_id,
        OLD.event_key,OLD.event_body,OLD.event_digest,OLD.source_digest,OLD.affected_nodes,OLD.kept_nodes,OLD.created_at)
  IS DISTINCT FROM
    ROW(NEW.id,NEW.tenant_id,NEW.principal_id,NEW.work_id,NEW.prior_request_id,NEW.prior_head_id,NEW.episode_id,
        NEW.event_key,NEW.event_body,NEW.event_digest,NEW.source_digest,NEW.affected_nodes,NEW.kept_nodes,NEW.created_at)
 THEN RAISE EXCEPTION 'P7 accepted revision and closure are immutable'; END IF;
 IF OLD.state IN('PUBLISHED','SUPERSEDED','FAILED') AND NEW IS DISTINCT FROM OLD
 THEN RAISE EXCEPTION 'P7 terminal history cannot be rewritten'; END IF;
 IF OLD.next_request_id IS NOT NULL AND NEW.next_request_id IS DISTINCT FROM OLD.next_request_id
 THEN RAISE EXCEPTION 'P7 producer handoff identity cannot change'; END IF;
 IF NEW.polls<OLD.polls OR (OLD.state='PREPARED' AND NEW.state='ACCEPTED')
 THEN RAISE EXCEPTION 'P7 durable frontier cannot regress'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['p7_intake_intents','p7_continuations','p7_manifests','p7_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY p7_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  EXECUTE format('CREATE TRIGGER p7_guard_record BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p7_guard_record()',t);
 END LOOP;
 GRANT UPDATE(state,next_request_id,polls,reason) ON finnor_os.p7_continuations TO finnor_app;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_programme_continuation_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'P7 bounded ordinary analytical continuation under the original P1 episode. No protected admission or effect/resource authority.');
