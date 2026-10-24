-- Forward-only recipient review and indexed confidential experience custody.
CREATE OR REPLACE FUNCTION finnor_os.y4_write_identity() RETURNS trigger
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
   -- A release recipient may occupy only the two-second independent S8 check.
   -- The immutable release and original deadline/cumulative CPU cap remain required.
   IF NEW.cpu_reserved_seconds=OLD.cpu_reserved_seconds+2
    AND to_jsonb(NEW)-'cpu_reserved_seconds' IS NOT DISTINCT FROM to_jsonb(OLD)-'cpu_reserved_seconds'
    AND OLD.status='COMPUTED' AND OLD.deadline_at>clock_timestamp()
    AND EXISTS(SELECT 1 FROM finnor_os.y4_releases r WHERE r.tenant_id=t
     AND r.computation_id=OLD.id AND r.principal_id=u)
    AND NOT EXISTS(SELECT 1 FROM finnor_os.y4_revocations r WHERE r.tenant_id=t
     AND r.computation_id=OLD.id AND r.principal_id=u)
    THEN RETURN NEW; END IF;
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
   IF NEW.actor_id=u AND NEW.kind IN('S8_CONFIDENTIAL_PROPOSAL_REGISTERED','S8_CONFIDENTIAL_PROPOSED')
    AND EXISTS(SELECT 1 FROM finnor_os.y4_releases r WHERE r.tenant_id=t
     AND r.computation_id=q.id AND r.principal_id=u AND r.id::text=NEW.body->>'releaseId')
    THEN RETURN NEW; END IF;

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
ALTER TABLE finnor_os.s5_experience ADD COLUMN y4_has_confidential_release boolean
 GENERATED ALWAYS AS (finnor_os.y4_contains_release(body)) STORED;
CREATE INDEX y4_confidential_experience_revision ON finnor_os.s5_experience(tenant_id,(body->>'revisionRef'))
 WHERE y4_has_confidential_release;
ALTER TABLE finnor_os.s5_proposals ADD COLUMN y4_has_confidential_release boolean
 GENERATED ALWAYS AS (finnor_os.y4_contains_release(problem)) STORED;
CREATE INDEX y4_proposal_certificate_ref ON finnor_os.s5_proposals(tenant_id,(certificate->'ref'->>'id'));
CREATE INDEX y4_proposal_problem_ref ON finnor_os.s5_proposals(tenant_id,(problem->'ref'->>'id'));
CREATE INDEX y4_proposal_compute_ref ON finnor_os.s5_proposals(tenant_id,(certificate->'compute'->>'id'));

CREATE OR REPLACE FUNCTION finnor_os.y4_s5_private(p_tenant uuid,p_digest text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p_tenant=finnor_os.request_tenant_id() AND EXISTS(SELECT 1 FROM finnor_os.s5_proposals p WHERE p.tenant_id=p_tenant
  AND p.content_digest=p_digest AND p.y4_has_confidential_release)
$$;

CREATE OR REPLACE FUNCTION finnor_os.y4_allocation_context_complete()
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
   AND p.principal_id<>u AND p.y4_has_confidential_release);
END $$;

CREATE OR REPLACE FUNCTION finnor_os.y4_s5_experience_visible(p_tenant uuid,p_principal uuid,p_body jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p_tenant=finnor_os.request_tenant_id() AND
  (p_principal=nullif(current_setting('app.user_id',true),'')::uuid OR (
   NOT finnor_os.y4_contains_release(p_body)
   AND finnor_os.y4_s5_subject_visible(p_tenant,p_body->>'revisionRef')
   AND NOT EXISTS(SELECT 1 FROM finnor_os.s5_experience e
    WHERE e.tenant_id=p_tenant AND e.body->>'revisionRef'=p_body->>'revisionRef'
     AND e.y4_has_confidential_release)))
$$;
