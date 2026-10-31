-- An enrollment binds existing canonical identities. It never creates a user,
-- credential, employment relationship, contact message or authority grant.
-- A freshly checked replacement can depend on a newer source version without
-- rewriting the original attempt's pin or treating stale live work as current.
ALTER TABLE finnor_os.w2_dependencies DROP CONSTRAINT w2_dependencies_pkey;
ALTER TABLE finnor_os.w2_dependencies ADD PRIMARY KEY(tenant_id,program_id,source_kind,source_id,source_digest);
CREATE FUNCTION finnor_os.w2_dependency_pin_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'W2 original dependency pins cannot be forgotten'; END IF;
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM finnor_os.w2_dependencies d WHERE d.tenant_id=NEW.tenant_id AND d.program_id=NEW.program_id
    AND d.source_kind=NEW.source_kind AND d.source_id=NEW.source_id AND d.source_digest<>NEW.source_digest
    AND d.assignment_ids ?| ARRAY(SELECT jsonb_array_elements_text(NEW.assignment_ids)))
  THEN RAISE EXCEPTION 'W2 an assignment cannot adopt a different checked source pin'; END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.tenant_id,NEW.program_id,NEW.principal_id,NEW.source_kind,NEW.source_id,NEW.source_digest)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.program_id,OLD.principal_id,OLD.source_kind,OLD.source_id,OLD.source_digest)
 OR NOT NEW.assignment_ids @> OLD.assignment_ids
 THEN RAISE EXCEPTION 'W2 original checked dependency pins cannot be refreshed or forgotten'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w2_dependency_pin_fence BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.w2_dependencies
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w2_dependency_pin_fence();
CREATE TABLE finnor_os.w2_contact_bindings(
 tenant_id uuid NOT NULL,id uuid NOT NULL,principal_id uuid NOT NULL,
 contact_id uuid NOT NULL,recipient_principal_id uuid NOT NULL,purpose text NOT NULL,
 valid_until timestamptz NOT NULL,proposal_digest text NOT NULL CHECK(proposal_digest ~ '^[a-f0-9]{64}$'),
 idempotency_key text NOT NULL,status text NOT NULL CHECK(status IN('PROPOSED','CONFIRMED','REVOKED')),
 revision integer NOT NULL CHECK(revision>=0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,recipient_principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,contact_id) REFERENCES finnor_os.external_contacts(tenant_id,id)
);
CREATE UNIQUE INDEX w2_one_current_contact_binding ON finnor_os.w2_contact_bindings(tenant_id,contact_id)
 WHERE status IN('PROPOSED','CONFIRMED');
CREATE TABLE finnor_os.w2_contact_binding_events(
 tenant_id uuid NOT NULL,binding_id uuid NOT NULL,principal_id uuid NOT NULL,
 event_key text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,binding_id,event_key),
 FOREIGN KEY(tenant_id,binding_id) REFERENCES finnor_os.w2_contact_bindings(tenant_id,id)
);
ALTER TABLE finnor_os.w2_contact_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.w2_contact_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.w2_contact_binding_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.w2_contact_binding_events FORCE ROW LEVEL SECURITY;
CREATE POLICY w2_binding_participant ON finnor_os.w2_contact_bindings USING(
 tenant_id=finnor_os.request_tenant_id() AND nullif(current_setting('app.user_id',true),'')::uuid IN(principal_id,recipient_principal_id))
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND nullif(current_setting('app.user_id',true),'')::uuid IN(principal_id,recipient_principal_id));
CREATE POLICY w2_binding_event_participant ON finnor_os.w2_contact_binding_events USING(
 tenant_id=finnor_os.request_tenant_id() AND EXISTS(SELECT 1 FROM finnor_os.w2_contact_bindings b
 WHERE b.tenant_id=w2_contact_binding_events.tenant_id AND b.id=w2_contact_binding_events.binding_id))
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND EXISTS(SELECT 1 FROM finnor_os.w2_contact_bindings b
 WHERE b.tenant_id=w2_contact_binding_events.tenant_id AND b.id=w2_contact_binding_events.binding_id));
CREATE TRIGGER w2_binding_event_immutable BEFORE UPDATE OR DELETE ON finnor_os.w2_contact_binding_events
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w2_immutable();
CREATE FUNCTION finnor_os.w2_binding_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.tenant_id,NEW.id,NEW.principal_id,NEW.contact_id,NEW.recipient_principal_id,
 NEW.purpose,NEW.valid_until,NEW.proposal_digest,NEW.idempotency_key,NEW.created_at) IS DISTINCT FROM
 ROW(OLD.tenant_id,OLD.id,OLD.principal_id,OLD.contact_id,OLD.recipient_principal_id,
 OLD.purpose,OLD.valid_until,OLD.proposal_digest,OLD.idempotency_key,OLD.created_at)
 OR NEW.revision<>OLD.revision+1 OR OLD.status='REVOKED'
 OR NOT (NEW.status='REVOKED' OR OLD.status='PROPOSED' AND NEW.status='CONFIRMED')
 THEN RAISE EXCEPTION 'W2 enrollment identity, consent history and revision cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w2_binding_fence BEFORE UPDATE OR DELETE ON finnor_os.w2_contact_bindings
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w2_binding_fence();
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON finnor_os.w2_contact_bindings TO %I',role_name);
   EXECUTE format('GRANT SELECT,INSERT ON finnor_os.w2_contact_binding_events TO %I',role_name);
  END IF;
 END LOOP;
END $$;
-- A delegator of record may act on its own delegated child (cancel/close/
-- reassign/terms). This function still only establishes programme context:
-- the runtime independently rechecks the exact current delegator identity,
-- terms and canonical assign authority before any mutation, and a recipient
-- or checker gains no delegator rights from it. CREATE OR REPLACE retains the
-- existing restricted EXECUTE grants.
CREATE OR REPLACE FUNCTION finnor_os.w2_participant_access(p_program uuid,p_assignment text) RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p.principal_id FROM finnor_os.w2_programs p
 JOIN finnor_os.w2_assignment_heads h ON h.tenant_id=p.tenant_id AND h.program_id=p.id
 JOIN finnor_os.users u ON u.tenant_id=p.tenant_id
  AND u.id=nullif(current_setting('app.user_id',true),'')::uuid AND u.status='active'
 WHERE p.tenant_id=finnor_os.request_tenant_id() AND p.id=p_program
  AND (p_assignment IS NULL OR h.assignment_id=p_assignment)
  AND (h.recipient_principal_id=u.id OR h.checker_principal_id=u.id
   OR EXISTS(SELECT 1 FROM finnor_os.w2_assignment_heads hp
    WHERE hp.tenant_id=h.tenant_id AND hp.program_id=h.program_id
     AND hp.assignment_id=h.body->>'parentAssignmentId'
     AND hp.actor_id::text=h.body->>'delegatorActorId'
     AND hp.recipient_principal_id=u.id))
 LIMIT 1
$$;
