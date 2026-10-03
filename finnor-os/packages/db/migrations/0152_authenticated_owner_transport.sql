-- Ordinary delivery persistence, outside Ring-0. Signatures authenticate origins;
-- RLS/session variables and an ACCEPTED projection cannot certify a ledger receipt.
CREATE TABLE finnor_os.s6_owner_delivery_origins (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 semantic_owner text NOT NULL CHECK(length(semantic_owner) BETWEEN 1 AND 128),
 kind text NOT NULL CHECK(kind IN ('REFERENCE','EVENT')),
 identity text NOT NULL CHECK(length(identity) BETWEEN 1 AND 4096),
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
 envelope jsonb NOT NULL CHECK(octet_length(envelope::text)<=8388608),
 signature text NOT NULL CHECK(length(signature) BETWEEN 1 AND 256),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,semantic_owner,kind,identity)
);
CREATE TABLE finnor_os.s6_owner_delivery_states (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, semantic_owner text NOT NULL,
 kind text NOT NULL, identity text NOT NULL,
 status text NOT NULL CHECK(status IN ('PENDING','CLAIMED','RETRY','ACCEPTED','REFUSED_ORIGIN','REQUIRES_OPERATOR')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 64),
 lease_token uuid, lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_error text CHECK(length(last_error)<=128),
 receipt jsonb CHECK(octet_length(receipt::text)<=8388608),
 request_digest text CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,semantic_owner,kind,identity),
 FOREIGN KEY(tenant_id,principal_id,semantic_owner,kind,identity)
  REFERENCES finnor_os.s6_owner_delivery_origins(tenant_id,principal_id,semantic_owner,kind,identity),
 CHECK((status='ACCEPTED')=(receipt IS NOT NULL AND request_digest IS NOT NULL)),
 CHECK(status<>'CLAIMED' OR lease_token IS NOT NULL AND lease_until IS NOT NULL)
);
CREATE INDEX s6_owner_delivery_recovery_idx ON finnor_os.s6_owner_delivery_states
 (tenant_id,principal_id,semantic_owner,next_attempt_at,lease_until)
 WHERE status IN ('PENDING','CLAIMED','RETRY');
CREATE TRIGGER s6_owner_delivery_origin_immutable BEFORE UPDATE OR DELETE
 ON finnor_os.s6_owner_delivery_origins FOR EACH ROW EXECUTE FUNCTION finnor_os.s6_immutable_origin();
CREATE FUNCTION finnor_os.s6_owner_delivery_state_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=finnor_os,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'S6 delivery responsibility cannot disappear'; END IF;
 IF (NEW.tenant_id,NEW.principal_id,NEW.semantic_owner,NEW.kind,NEW.identity)
  IS DISTINCT FROM (OLD.tenant_id,OLD.principal_id,OLD.semantic_owner,OLD.kind,OLD.identity)
 THEN RAISE EXCEPTION 'S6 delivery identity is immutable'; END IF;
 IF OLD.status='ACCEPTED' AND NEW IS DISTINCT FROM OLD
 THEN RAISE EXCEPTION 'S6 accepted delivery receipt is immutable'; END IF;
 IF NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
 THEN RAISE EXCEPTION 'S6 delivery claim accounting cannot regress'; END IF;
 IF NEW.status='CLAIMED' THEN
  IF OLD.status NOT IN ('PENDING','RETRY','CLAIMED') OR NEW.attempts<>OLD.attempts+1
    OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
    OR OLD.status='CLAIMED' AND OLD.lease_until>clock_timestamp()
  THEN RAISE EXCEPTION 'S6 current delivery owner cannot be displaced'; END IF;
 ELSE
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status<>'CLAIMED'
  THEN RAISE EXCEPTION 'S6 delivery result requires an owned claim'; END IF;
  IF OLD.status='CLAIMED' AND (NEW.lease_token IS DISTINCT FROM OLD.lease_token
    OR NEW.attempts<>OLD.attempts OR OLD.lease_until<=clock_timestamp())
  THEN RAISE EXCEPTION 'S6 stale delivery owner cannot persist a result'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER s6_owner_delivery_state_conservation BEFORE UPDATE OR DELETE
 ON finnor_os.s6_owner_delivery_states FOR EACH ROW EXECUTE FUNCTION finnor_os.s6_owner_delivery_state_guard();
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['s6_owner_delivery_origins','s6_owner_delivery_states'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY s6_owner_delivery_tenant ON finnor_os.%I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',table_name);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON finnor_os.%I TO finnor_app',table_name);
  END IF;
 END LOOP;
END $$;
