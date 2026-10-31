-- A participant binding whose validity has passed reaches the canonical
-- EXPIRED responsibility state exactly once, by clock, through the runtime's
-- own sweep. EXPIRED is terminal like REVOKED: identity, consent history and
-- revision still cannot reset, prior events stay byte-equivalent, and expiry
-- itself releases no obligation and grants no authority.
ALTER TABLE finnor_os.w2_contact_bindings DROP CONSTRAINT w2_contact_bindings_status_check;
ALTER TABLE finnor_os.w2_contact_bindings ADD CONSTRAINT w2_contact_bindings_status_check
 CHECK(status IN('PROPOSED','CONFIRMED','REVOKED','EXPIRED'));
CREATE OR REPLACE FUNCTION finnor_os.w2_binding_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.tenant_id,NEW.id,NEW.principal_id,NEW.contact_id,NEW.recipient_principal_id,
 NEW.purpose,NEW.valid_until,NEW.proposal_digest,NEW.idempotency_key,NEW.created_at) IS DISTINCT FROM
 ROW(OLD.tenant_id,OLD.id,OLD.principal_id,OLD.contact_id,OLD.recipient_principal_id,
 OLD.purpose,OLD.valid_until,OLD.proposal_digest,OLD.idempotency_key,OLD.created_at)
 OR NEW.revision<>OLD.revision+1 OR OLD.status IN('REVOKED','EXPIRED')
 OR NOT (NEW.status='REVOKED' OR OLD.status='PROPOSED' AND NEW.status='CONFIRMED'
  OR NEW.status='EXPIRED' AND OLD.status IN('PROPOSED','CONFIRMED'))
 THEN RAISE EXCEPTION 'W2 enrollment identity, consent history and revision cannot reset'; END IF;
 RETURN NEW;
END $$;
-- The clock sweep cannot read another participant's private binding under row
-- security, and an ALL policy's own check cannot be widened by a permissive
-- UPDATE policy. The sweep therefore runs as the same security-definer
-- pattern as w2_participant_access: fenced to the request tenant and an
-- active principal, writing the exact durable expiry event from the row it
-- transitions, and returning only the count. No binding content becomes
-- visible to the sweeping principal, the transition fence still applies, and
-- the events stay append-only.
CREATE FUNCTION finnor_os.w2_expire_contact_bindings(p_tenant uuid,p_contact uuid,p_actor uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE r RECORD; n integer:=0;
BEGIN
 IF p_tenant IS DISTINCT FROM finnor_os.request_tenant_id()
 THEN RAISE EXCEPTION 'W2 expiry sweep tenant fence'; END IF;
 IF NOT EXISTS(SELECT 1 FROM finnor_os.users u WHERE u.tenant_id=p_tenant AND u.id=p_actor AND u.status='active')
 THEN RAISE EXCEPTION 'W2 expiry sweep active principal required'; END IF;
 FOR r IN UPDATE finnor_os.w2_contact_bindings SET status='EXPIRED',revision=revision+1
  WHERE tenant_id=p_tenant AND contact_id=p_contact AND status IN('PROPOSED','CONFIRMED')
  AND valid_until<=clock_timestamp() RETURNING id,proposal_digest,valid_until LOOP
  INSERT INTO finnor_os.w2_contact_binding_events(tenant_id,binding_id,principal_id,event_key,body)
  VALUES(p_tenant,r.id,p_actor,'expire',jsonb_build_object(
   'schema','finnor.workforce-contact-binding-expiry.v1','action','EXPIRE','bindingId',r.id,
   'proposalDigest',r.proposal_digest,'validUntil',r.valid_until,'sweptBy',p_actor,
   'at',clock_timestamp(),'clockExpiry',true,'fabricatedHumanRevocation',false,
   'obligationsReleased',false,'authorityGranted',false,'voluntaryConsentEstablished',false,'contactSent',false));
  n:=n+1;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION finnor_os.w2_expire_contact_bindings(uuid,uuid,uuid) FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION finnor_os.w2_expire_contact_bindings(uuid,uuid,uuid) TO %I',role_name);
  END IF;
 END LOOP;
END $$;
