-- Frozen S5 portfolio commitments. Ordinary storage is outside Ring-0 and does
-- not establish protected history, business truth, execution or settlement.
CREATE TABLE finnor_os.s5_resources (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id), resource_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), content_digest text NOT NULL CHECK(content_digest ~ '^[0-9a-f]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,resource_id,revision), UNIQUE(tenant_id,content_digest)
);
CREATE TABLE finnor_os.s5_resource_heads (
 tenant_id uuid NOT NULL, resource_id text NOT NULL, revision integer NOT NULL,
 PRIMARY KEY(tenant_id,resource_id), FOREIGN KEY(tenant_id,resource_id,revision) REFERENCES finnor_os.s5_resources(tenant_id,resource_id,revision)
);
CREATE TABLE finnor_os.s5_proposals (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id), principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 content_digest text NOT NULL CHECK(content_digest ~ '^[0-9a-f]{64}$'),
 problem jsonb NOT NULL, certificate jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(octet_length(problem::text)+octet_length(certificate::text)<=8388608), PRIMARY KEY(tenant_id,content_digest)
);
CREATE TABLE finnor_os.s5_requests (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id), principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 allocation_digest text, refusal jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,idempotency_key), FOREIGN KEY(tenant_id,allocation_digest) REFERENCES finnor_os.s5_proposals(tenant_id,content_digest)
);
CREATE TABLE finnor_os.s5_reservation_origins (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 reservation_id text NOT NULL, allocation_digest text NOT NULL, body jsonb NOT NULL,
 PRIMARY KEY(tenant_id,reservation_id), UNIQUE(tenant_id,allocation_digest),
 FOREIGN KEY(tenant_id,allocation_digest) REFERENCES finnor_os.s5_proposals(tenant_id,content_digest), CHECK(octet_length(body::text)<=8388608)
);
CREATE TABLE finnor_os.s5_reservations (
 tenant_id uuid NOT NULL, reservation_id text NOT NULL, allocation_digest text NOT NULL, revision integer NOT NULL CHECK(revision>0),
 status text NOT NULL CHECK(status IN ('RESERVED','CONSUMPTION_PENDING','UNKNOWN_OUTCOME','PARTIALLY_RECONCILED','SETTLED_RETAINED','RELEASED')),
 envelopes jsonb NOT NULL, revocation_reason text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,reservation_id), UNIQUE(tenant_id,allocation_digest),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES finnor_os.s5_reservation_origins(tenant_id,reservation_id),
 FOREIGN KEY(tenant_id,allocation_digest) REFERENCES finnor_os.s5_proposals(tenant_id,content_digest)
);
CREATE INDEX s5_reservations_live_idx ON finnor_os.s5_reservations(tenant_id,status) WHERE status<>'RELEASED';
CREATE TABLE finnor_os.s5_consumptions (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES finnor_os.users(id), consumption_id text NOT NULL, reservation_id text NOT NULL,
 policy_id text NOT NULL, node_id text NOT NULL, idempotency_key text NOT NULL, request_digest text NOT NULL, body jsonb NOT NULL,
 PRIMARY KEY(tenant_id,consumption_id), UNIQUE(tenant_id,reservation_id,policy_id,node_id), UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES finnor_os.s5_reservation_origins(tenant_id,reservation_id), CHECK(octet_length(body::text)<=8388608)
);
CREATE TABLE finnor_os.s5_consumption_states (
 tenant_id uuid NOT NULL, consumption_id text NOT NULL, status text NOT NULL CHECK(status IN ('INTENDED_PENDING_S6','UNKNOWN_OUTCOME','RECONCILED')),
 effect_ref jsonb, revision integer NOT NULL CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,consumption_id), FOREIGN KEY(tenant_id,consumption_id) REFERENCES finnor_os.s5_consumptions(tenant_id,consumption_id)
);
CREATE UNIQUE INDEX s5_consumption_effect_idx ON finnor_os.s5_consumption_states(tenant_id,(effect_ref->>'id')) WHERE effect_ref IS NOT NULL;
CREATE TABLE finnor_os.s5_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 subject_id text NOT NULL, revision integer NOT NULL, operation text NOT NULL, body jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(tenant_id,subject_id,revision,operation)
);
CREATE TABLE finnor_os.s5_experience (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id), principal_id uuid NOT NULL REFERENCES finnor_os.users(id), event_id text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,event_id)
);
CREATE FUNCTION finnor_os.s5_immutable_record() RETURNS trigger LANGUAGE plpgsql SET search_path=finnor_os,pg_temp AS $$
BEGIN RAISE EXCEPTION 'S5 original revisions/history are append-only'; END $$;
CREATE FUNCTION finnor_os.s5_projection_history() RETURNS trigger LANGUAGE plpgsql SET search_path=finnor_os,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'S5 commitments cannot disappear'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.revision<>OLD.revision+1) THEN RAISE EXCEPTION 'S5 projection revision must append consecutively'; END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='s5_reservations' THEN
  IF (to_jsonb(NEW)->'reservation_id') IS DISTINCT FROM (to_jsonb(OLD)->'reservation_id')
   OR (to_jsonb(NEW)->'allocation_digest') IS DISTINCT FROM (to_jsonb(OLD)->'allocation_digest')
   OR (to_jsonb(NEW)->'envelopes') IS DISTINCT FROM (to_jsonb(OLD)->'envelopes')
  THEN RAISE EXCEPTION 'S5 committed identity and accountable envelope are immutable'; END IF;
  IF NEW.status<>OLD.status AND NOT (
   OLD.status='RESERVED' AND NEW.status IN ('CONSUMPTION_PENDING','RELEASED')
   OR OLD.status='CONSUMPTION_PENDING' AND NEW.status IN ('UNKNOWN_OUTCOME','PARTIALLY_RECONCILED','SETTLED_RETAINED')
   OR OLD.status='UNKNOWN_OUTCOME' AND NEW.status IN ('PARTIALLY_RECONCILED','SETTLED_RETAINED')
   OR OLD.status='PARTIALLY_RECONCILED' AND NEW.status IN ('UNKNOWN_OUTCOME','SETTLED_RETAINED')
   OR OLD.status='SETTLED_RETAINED' AND NEW.status='RELEASED'
  ) THEN RAISE EXCEPTION 'S5 reservation responsibility cannot regress'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='s5_consumption_states' THEN
  IF (to_jsonb(NEW)->'consumption_id') IS DISTINCT FROM (to_jsonb(OLD)->'consumption_id')
   OR (to_jsonb(OLD)->'effect_ref')<>'null'::jsonb AND (to_jsonb(NEW)->'effect_ref') IS DISTINCT FROM (to_jsonb(OLD)->'effect_ref')
  THEN RAISE EXCEPTION 'S5 consumption identity or recorded effect cannot change'; END IF;
  IF NEW.status<>OLD.status AND NOT (
   OLD.status='INTENDED_PENDING_S6' AND NEW.status IN ('UNKNOWN_OUTCOME','RECONCILED')
   OR OLD.status='UNKNOWN_OUTCOME' AND NEW.status='RECONCILED'
  ) THEN RAISE EXCEPTION 'S5 consumption responsibility cannot regress'; END IF;
 END IF;
 INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body)
 VALUES(NEW.tenant_id,CASE WHEN TG_TABLE_NAME='s5_reservations' THEN to_jsonb(NEW)->>'reservation_id' ELSE to_jsonb(NEW)->>'consumption_id' END,NEW.revision,TG_TABLE_NAME,to_jsonb(NEW));
 RETURN NEW;
END $$;
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['s5_resources','s5_resource_heads','s5_proposals','s5_requests','s5_reservation_origins','s5_reservations','s5_consumptions','s5_consumption_states','s5_history','s5_experience'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY s5_tenant_access ON finnor_os.%I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',table_name);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN EXECUTE format('GRANT SELECT,INSERT,UPDATE ON finnor_os.%I TO finnor_app',table_name); END IF;
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['s5_resources','s5_proposals','s5_reservation_origins','s5_consumptions','s5_history','s5_experience'] LOOP
  EXECUTE format('CREATE TRIGGER s5_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.s5_immutable_record()',table_name);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['s5_reservations','s5_consumption_states'] LOOP
  EXECUTE format('CREATE TRIGGER s5_history_append BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.s5_projection_history()',table_name);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN GRANT USAGE,SELECT ON SEQUENCE finnor_os.s5_history_id_seq TO finnor_app; END IF;
END $$;
