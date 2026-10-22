-- Additive recipient privacy at actual S5/S6 storage, not an alternate ledger.
-- Serial production ordinal/integration remains unallocated.
CREATE FUNCTION finnor_os.y4_contains_release(p_body jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_path_exists(p_body,'strict $.** ? (@.owner == "Y4_CONFIDENTIAL_RELEASE")'),false)
$$;
CREATE FUNCTION finnor_os.y4_s5_private(p_tenant uuid,p_digest text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p_tenant=finnor_os.request_tenant_id() AND EXISTS(SELECT 1 FROM finnor_os.s5_proposals p WHERE p.tenant_id=p_tenant
  AND p.content_digest=p_digest AND finnor_os.y4_contains_release(p.problem))
$$;
CREATE FUNCTION finnor_os.y4_s5_visible(p_tenant uuid,p_digest text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p_tenant=finnor_os.request_tenant_id() AND
  (NOT finnor_os.y4_s5_private(p_tenant,p_digest) OR EXISTS(
   SELECT 1 FROM finnor_os.s5_proposals p WHERE p.tenant_id=p_tenant
    AND p.content_digest=p_digest
    AND p.principal_id=nullif(current_setting('app.user_id',true),'')::uuid))
$$;
CREATE FUNCTION finnor_os.y4_s5_subject_visible(p_tenant uuid,p_subject text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p_tenant=finnor_os.request_tenant_id() AND NOT EXISTS(
  SELECT 1 FROM finnor_os.s5_reservation_origins o
   LEFT JOIN finnor_os.s5_consumptions co USING(tenant_id,reservation_id)
   WHERE o.tenant_id=p_tenant AND (o.reservation_id=p_subject OR co.consumption_id=p_subject)
    AND NOT finnor_os.y4_s5_visible(o.tenant_id,o.allocation_digest))
  AND NOT EXISTS(SELECT 1 FROM finnor_os.s5_proposals p WHERE p.tenant_id=p_tenant
   AND (p.content_digest=p_subject OR p.certificate->'ref'->>'id'=p_subject
    OR p.problem->'ref'->>'id'=p_subject OR p.certificate->'compute'->>'id'=p_subject)
   AND NOT finnor_os.y4_s5_visible(p.tenant_id,p.content_digest))
  AND NOT EXISTS(SELECT 1 FROM finnor_os.s6_obligation_origins o WHERE o.tenant_id=p_tenant
   AND (o.obligation_id=p_subject OR o.effect_id::text=p_subject OR o.domain_action_id::text=p_subject)
   AND NOT finnor_os.y4_s5_visible(p_tenant,o.body->'allocationRef'->>'contentDigest'))
$$;
CREATE FUNCTION finnor_os.y4_allocation_context_complete()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();
 u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
 IF t IS NULL OR u IS NULL OR NOT EXISTS(SELECT 1 FROM finnor_os.users
  WHERE tenant_id=t AND id=u AND status='active' AND role='owner') THEN RETURN false; END IF;
 -- Refuse an incomplete aggregate. Hidden reservations are never treated as zero.
 RETURN NOT EXISTS(SELECT 1 FROM finnor_os.s5_reservations s
  JOIN finnor_os.s5_proposals p ON p.tenant_id=s.tenant_id AND p.content_digest=s.allocation_digest
  WHERE s.tenant_id=t AND s.status<>'RELEASED'
   AND p.principal_id<>u AND finnor_os.y4_contains_release(p.problem));
END $$;
CREATE FUNCTION finnor_os.y4_s5_experience_visible(p_tenant uuid,p_principal uuid,p_body jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p_tenant=finnor_os.request_tenant_id() AND
  (p_principal=nullif(current_setting('app.user_id',true),'')::uuid OR (
   NOT finnor_os.y4_contains_release(p_body)
   AND finnor_os.y4_s5_subject_visible(p_tenant,p_body->>'revisionRef')
   AND NOT EXISTS(SELECT 1 FROM finnor_os.s5_experience e
    WHERE e.tenant_id=p_tenant AND e.body->>'revisionRef'=p_body->>'revisionRef'
     AND finnor_os.y4_contains_release(e.body))))
$$;
CREATE FUNCTION finnor_os.y4_s6_effect_visible(p_tenant uuid,p_effect uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p_tenant=finnor_os.request_tenant_id() AND NOT EXISTS(
  SELECT 1 FROM finnor_os.s6_obligation_origins o WHERE o.tenant_id=p_tenant
   AND o.effect_id=p_effect AND NOT finnor_os.y4_s5_visible(p_tenant,o.body->'allocationRef'->>'contentDigest'))
$$;
CREATE FUNCTION finnor_os.y4_delivery_visible(p_tenant uuid,p_principal uuid,p_owner text,p_kind text,p_identity text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p_tenant=finnor_os.request_tenant_id() AND
  (p_principal=nullif(current_setting('app.user_id',true),'')::uuid OR NOT EXISTS(
   SELECT 1 FROM finnor_os.s6_owner_delivery_origins o WHERE o.tenant_id=p_tenant
    AND o.principal_id=p_principal AND o.semantic_owner=p_owner AND o.kind=p_kind AND o.identity=p_identity
    AND (finnor_os.y4_contains_release(o.envelope)
     OR NOT finnor_os.y4_s5_subject_visible(p_tenant,p_identity)
     OR p_owner='S5' AND p_kind='EVENT' AND NOT finnor_os.y4_s5_experience_visible(p_tenant,p_principal,o.envelope->'payload'->'event')
     OR NOT finnor_os.y4_s5_visible(p_tenant,COALESCE(
      o.envelope#>>'{payload,reference,content,allocationRef,contentDigest}',
      o.envelope#>>'{payload,event,detail,allocationRef,contentDigest}')))))
$$;
CREATE FUNCTION finnor_os.y4_control_context_complete()
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();
 u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
 IF t IS NULL OR u IS NULL OR NOT EXISTS(SELECT 1 FROM finnor_os.users
  WHERE tenant_id=t AND id=u AND status='active' AND role='owner') THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM finnor_os.business_effects e
  WHERE e.tenant_id=t AND e.status NOT IN('verified','cancelled','compensated')
   AND NOT finnor_os.y4_s6_effect_visible(t,e.id));
END $$;
-- Raw ordinary-role writes preserve the same original principal boundary as
-- the authenticated owners. Tenant membership is not another party's consent.
CREATE FUNCTION finnor_os.y4_write_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();
 u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 q finnor_os.y4_computations;
BEGIN
 -- A database administrator already controls tables/triggers; no ordinary
 -- application or worker role has this privilege.
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RETURN NEW; END IF;
 IF t IS NULL OR u IS NULL OR NEW.tenant_id IS DISTINCT FROM t
  OR NOT EXISTS(SELECT 1 FROM finnor_os.users WHERE tenant_id=t AND id=u AND status='active')
  THEN RAISE EXCEPTION 'Y4_ORIGINAL_WRITE_PRINCIPAL_REQUIRED' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='y4_computations' THEN
  IF TG_OP='INSERT' AND NEW.principal_id=u THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.principal_id=u THEN RETURN NEW; END IF;
   -- A participant's immutable audit insertion charges the parent's original
   -- retained-byte budget. This nested trigger can change no other field.
   IF pg_trigger_depth()>1 AND to_jsonb(NEW)-'data_bytes' IS NOT DISTINCT FROM to_jsonb(OLD)-'data_bytes'
    THEN RETURN NEW; END IF;
   -- Only the completed original commitment barrier may advance a computation
   -- for a noninitiating participant, never its budgets, session or result.
   IF OLD.status='AWAITING_PARTICIPANTS' AND NEW.status='READY'
    AND to_jsonb(NEW)-'status' IS NOT DISTINCT FROM to_jsonb(OLD)-'status'
    AND EXISTS(SELECT 1 FROM finnor_os.y4_consents c WHERE c.tenant_id=t AND c.computation_id=OLD.id AND c.principal_id=u)
    AND jsonb_array_length(OLD.request->'function'->'participants')=
      (SELECT count(*) FROM finnor_os.y4_commitments c WHERE c.tenant_id=t AND c.computation_id=OLD.id)
    THEN RETURN NEW; END IF;
  END IF;
 ELSE
  SELECT * INTO q FROM finnor_os.y4_computations WHERE tenant_id=t AND id=NEW.computation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Y4_ORIGINAL_WRITE_PRINCIPAL_REQUIRED' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='y4_consents' THEN
   IF NEW.principal_id=u AND NEW.body->>'participantId'=NEW.participant_id
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.request->'function'->'inputs') p WHERE p->>'participantId'=NEW.participant_id)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.request->'function'->'inputs') p
     WHERE p->>'participantId'=NEW.participant_id AND NOT EXISTS(
      SELECT 1 FROM finnor_os.y4_source_handles h
      JOIN jsonb_array_elements(q.request->'function'->'participants') party ON party->>'id'=NEW.participant_id
      WHERE h.tenant_id=t AND h.principal_id=u AND h.id::text=p->'grantRef'->>'id'
       AND h.public_digest=p->'grantRef'->>'contentDigest'
       AND h.public_body->>'institutionId'=party->>'institutionId'))
    THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME IN('y4_revocations','y4_commitments','y4_releases') THEN
   IF NEW.principal_id=u AND EXISTS(SELECT 1 FROM finnor_os.y4_consents c
    WHERE c.tenant_id=t AND c.computation_id=q.id AND c.participant_id=NEW.participant_id AND c.principal_id=u)
    THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='y4_disclosures' THEN
   IF q.principal_id=u AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(q.request->'function'->'inputs') p
    JOIN jsonb_array_elements(q.request->'function'->'participants') party ON party->>'id'=p->>'participantId'
    JOIN finnor_os.y4_consents c ON c.tenant_id=t AND c.computation_id=q.id AND c.participant_id=party->>'id'
    WHERE party->>'institutionId'=NEW.institution_id::text AND p->'sourceRef'->>'owner'='Y4_SOURCE_VERSION_IDENTITY'
     AND encode(sha256(convert_to(format('{"id":%s,"owner":"Y4_SOURCE_VERSION_IDENTITY"}',
       to_json(p->'sourceRef'->>'id')),'UTF8')),'hex')=NEW.source_key)
    THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='y4_events' THEN
   IF NEW.actor_id=u AND (q.principal_id=u OR (
    NEW.kind IN('PARTICIPANT_CONSENT','INPUT_COMMITMENT_ACCEPTED','CONSENT_REVOKED','RECIPIENT_RELEASE_IMPORTED',
     'NATIVE_UNDERWRITING_CONSUMED','NATIVE_S4_S5_S6_PREPARED')
    AND EXISTS(SELECT 1 FROM finnor_os.y4_consents c WHERE c.tenant_id=t AND c.computation_id=q.id
     AND c.principal_id=u AND (NEW.body->>'participantId' IS NULL OR c.participant_id=NEW.body->>'participantId'))))
    THEN RETURN NEW; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'Y4_ORIGINAL_WRITE_PRINCIPAL_REQUIRED' USING ERRCODE='42501';
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['y4_computations','y4_consents','y4_revocations','y4_disclosures','y4_commitments','y4_releases','y4_events'] LOOP
  EXECUTE format('CREATE TRIGGER y4_principal_write BEFORE INSERT OR UPDATE ON finnor_os.%I
   FOR EACH ROW EXECUTE FUNCTION finnor_os.y4_write_identity()',t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION finnor_os.y4_write_identity() FROM PUBLIC;
CREATE POLICY y4_s5_proposal_privacy ON finnor_os.s5_proposals AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_s5_visible(tenant_id,content_digest));
CREATE POLICY y4_s5_request_privacy ON finnor_os.s5_requests AS RESTRICTIVE FOR SELECT
 USING(principal_id=nullif(current_setting('app.user_id',true),'')::uuid
  OR NOT finnor_os.y4_s5_private(tenant_id,allocation_digest));
CREATE POLICY y4_s5_origin_privacy ON finnor_os.s5_reservation_origins AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_s5_visible(tenant_id,allocation_digest));
CREATE POLICY y4_s5_reservation_privacy ON finnor_os.s5_reservations AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_s5_visible(tenant_id,allocation_digest));
CREATE POLICY y4_s5_consumption_privacy ON finnor_os.s5_consumptions AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_s5_subject_visible(tenant_id,reservation_id));
CREATE POLICY y4_s5_state_privacy ON finnor_os.s5_consumption_states AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_s5_subject_visible(tenant_id,consumption_id));
CREATE POLICY y4_s5_history_privacy ON finnor_os.s5_history AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_s5_subject_visible(tenant_id,subject_id));
CREATE POLICY y4_s5_experience_privacy ON finnor_os.s5_experience AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_s5_experience_visible(tenant_id,principal_id,body));
CREATE POLICY y4_s6_origin_privacy ON finnor_os.s6_obligation_origins AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_s5_visible(tenant_id,body->'allocationRef'->>'contentDigest'));
CREATE POLICY y4_s6_effect_privacy ON finnor_os.business_effects AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_s6_effect_visible(tenant_id,id));
CREATE POLICY y4_s6_action_privacy ON finnor_os.domain_actions AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_s6_effect_visible(tenant_id,business_effect_id));
CREATE POLICY y4_delivery_origin_privacy ON finnor_os.s6_owner_delivery_origins AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_delivery_visible(tenant_id,principal_id,semantic_owner,kind,identity));
CREATE POLICY y4_delivery_state_privacy ON finnor_os.s6_owner_delivery_states AS RESTRICTIVE FOR SELECT
 USING(finnor_os.y4_delivery_visible(tenant_id,principal_id,semantic_owner,kind,identity));
DO $$ DECLARE f text; BEGIN
 FOREACH f IN ARRAY ARRAY['y4_contains_release(jsonb)','y4_s5_private(uuid,text)',
 'y4_s5_visible(uuid,text)','y4_s5_subject_visible(uuid,text)',
 'y4_allocation_context_complete()','y4_s5_experience_visible(uuid,uuid,jsonb)',
 'y4_s6_effect_visible(uuid,uuid)','y4_delivery_visible(uuid,uuid,text,text,text)',
 'y4_control_context_complete()'] LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION finnor_os.'||f||' FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION finnor_os.'||f||' TO finnor_app,finnor_worker';
 END LOOP;
END $$;
