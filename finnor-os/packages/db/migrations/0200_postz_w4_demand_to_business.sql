-- W4 programme custody only. Core external identities, S1 evidence, S5 resources,
-- S6 effects and S7 accounts remain the authoritative business owners.
CREATE TABLE finnor_os.w4_business_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL, company_id uuid NOT NULL, work_id uuid NOT NULL, work_input_id uuid NOT NULL,
 business_assignment_id text NOT NULL, idempotency_key text NOT NULL, request_digest text NOT NULL,
 outcome_ref jsonb NOT NULL, mandate_ref jsonb NOT NULL, parent_policy jsonb NOT NULL,
 parent_allocation jsonb NOT NULL, budget_obligation_ref jsonb NOT NULL, s7_estimand_id text,
 identity jsonb NOT NULL, rights_revision bigint NOT NULL,
 original_deadline timestamptz NOT NULL, compile_deadline timestamptz NOT NULL,
 generation integer NOT NULL DEFAULT 1, wake_revision bigint NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN
  ('QUEUED','RUNNING','CHECKED','PARTIAL','STALE','STOPPED','RECONCILING','UNKNOWN','FAILED')),
 claim_token uuid, claim_fence bigint, artifact_id uuid, failure text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,principal_id,idempotency_key),
 UNIQUE(tenant_id,principal_id,work_id,business_assignment_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,company_id) REFERENCES finnor_os.external_organizations(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 CHECK(generation>=1 AND wake_revision>=1 AND compile_deadline<=original_deadline),
 CHECK(request_digest ~ '^[a-f0-9]{64}$' AND length(idempotency_key) BETWEEN 1 AND 160
  AND length(business_assignment_id) BETWEEN 1 AND 160)
);
CREATE TABLE finnor_os.w4_business_artifacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 request_id uuid NOT NULL, generation integer NOT NULL, body jsonb NOT NULL, body_digest text NOT NULL,
 check_result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_id,generation),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w4_business_requests(tenant_id,id),
 CHECK(body_digest ~ '^[a-f0-9]{64}$' AND octet_length(body::text)<=4194304 AND octet_length(check_result::text)<=262144)
);
CREATE TABLE finnor_os.w4_participant_protocols (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, principal_id uuid NOT NULL,
 request_id uuid, work_id uuid NOT NULL, business_assignment_id text NOT NULL,
 participant_id uuid NOT NULL, buyer_id uuid, offer_id text, terms_digest text,
 role text NOT NULL CHECK(role IN('BUYER','OPERATOR','ACCOUNTANT','INDEPENDENT_OBSERVER')),
 permitted_kinds jsonb NOT NULL, purpose text NOT NULL, operational_disclosure jsonb NOT NULL,
 expires_at timestamptz NOT NULL, consent_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w4_business_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,participant_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,buyer_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(terms_digest IS NULL OR terms_digest ~ '^[a-f0-9]{64}$'),
 CHECK(jsonb_typeof(permitted_kinds)='array' AND jsonb_array_length(permitted_kinds) BETWEEN 1 AND 12),
 CHECK((role='BUYER' AND participant_id=buyer_id AND
   (request_id IS NOT NULL AND offer_id IS NOT NULL AND terms_digest IS NOT NULL OR permitted_kinds='["EVIDENCE"]'::jsonb))
  OR role<>'BUYER')
);
CREATE TABLE finnor_os.w4_original_source_links (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, work_id uuid NOT NULL,
 source_id uuid NOT NULL, version_id uuid NOT NULL, content_digest text NOT NULL,
 author_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN('MANDATE','OUTCOME','EVIDENCE','NATIVE','EVENT')),
 purpose text NOT NULL, protocol_id uuid, idempotency_key text NOT NULL,
 evidence_class text NOT NULL DEFAULT 'CONTROLLED' CHECK(evidence_class IN('CONTROLLED','REPLAYED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,source_id,version_id),
 UNIQUE(tenant_id,author_id,work_id,idempotency_key),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,author_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(source_id) REFERENCES finnor_os.evidence_sources(id),
 FOREIGN KEY(version_id) REFERENCES finnor_os.evidence_source_versions(id),
 FOREIGN KEY(tenant_id,protocol_id) REFERENCES finnor_os.w4_participant_protocols(tenant_id,id),
 CHECK(content_digest ~ '^[a-f0-9]{64}$')
);
CREATE TABLE finnor_os.w4_event_links (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, request_id uuid NOT NULL,
 protocol_id uuid NOT NULL, source_id uuid NOT NULL, version_id uuid NOT NULL, content_digest text NOT NULL,
 author_id uuid NOT NULL, idempotency_key text NOT NULL, body_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,request_id,source_id),
 UNIQUE(tenant_id,protocol_id,idempotency_key),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w4_business_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,protocol_id) REFERENCES finnor_os.w4_participant_protocols(tenant_id,id),
 FOREIGN KEY(tenant_id,source_id,version_id) REFERENCES finnor_os.w4_original_source_links(tenant_id,source_id,version_id),
 FOREIGN KEY(tenant_id,author_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE INDEX w4_business_work ON finnor_os.w4_business_requests(tenant_id,principal_id,work_id);
CREATE INDEX w4_participant_inbox ON finnor_os.w4_participant_protocols(tenant_id,participant_id,expires_at);
CREATE INDEX w4_sources_work_kind ON finnor_os.w4_original_source_links(tenant_id,work_id,kind);
CREATE FUNCTION finnor_os.w4_request_original_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['status','claim_token','claim_fence','artifact_id','failure','updated_at','wake_revision'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','claim_token','claim_fence','artifact_id','failure','updated_at','wake_revision'])
  OR NEW.wake_revision<OLD.wake_revision
 THEN RAISE EXCEPTION 'W4 original Work, customer obligations, resources and deadline are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w4_request_original BEFORE UPDATE OR DELETE ON finnor_os.w4_business_requests
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w4_request_original_guard();
CREATE FUNCTION finnor_os.w4_protocol_original_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['consent_at','revoked_at'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consent_at','revoked_at'])
  OR OLD.consent_at IS NOT NULL AND NEW.consent_at IS DISTINCT FROM OLD.consent_at
  OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
  OR NEW.participant_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
 THEN RAISE EXCEPTION 'W4 exact protocol and self-authored consent are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w4_protocol_original BEFORE UPDATE OR DELETE ON finnor_os.w4_participant_protocols
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w4_protocol_original_guard();
CREATE TRIGGER w4_artifacts_immutable BEFORE UPDATE OR DELETE ON finnor_os.w4_business_artifacts
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable();
CREATE TRIGGER w4_sources_immutable BEFORE UPDATE OR DELETE ON finnor_os.w4_original_source_links
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable();
CREATE TRIGGER w4_events_immutable BEFORE UPDATE OR DELETE ON finnor_os.w4_event_links
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['w4_business_requests','w4_business_artifacts','w4_participant_protocols','w4_original_source_links','w4_event_links'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY %I ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',tab||'_owner',tab);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
   EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',tab);
   IF tab IN('w4_business_requests','w4_participant_protocols') THEN
    EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',tab);
   END IF;
  END IF;
 END LOOP;
END $$;
CREATE POLICY w4_protocol_self ON finnor_os.w4_participant_protocols FOR SELECT
 USING(tenant_id=finnor_os.request_tenant_id() AND participant_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w4_source_self ON finnor_os.w4_original_source_links FOR SELECT
 USING(tenant_id=finnor_os.request_tenant_id() AND author_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w4_source_self_insert ON finnor_os.w4_original_source_links FOR INSERT
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND author_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w4_event_self ON finnor_os.w4_event_links FOR SELECT
 USING(tenant_id=finnor_os.request_tenant_id() AND author_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w4_event_self_insert ON finnor_os.w4_event_links FOR INSERT
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND author_id=nullif(current_setting('app.user_id',true),'')::uuid
  AND EXISTS(SELECT 1 FROM finnor_os.w4_participant_protocols p WHERE p.tenant_id=w4_event_links.tenant_id
   AND p.id=w4_event_links.protocol_id AND p.request_id=w4_event_links.request_id
   AND p.principal_id=w4_event_links.principal_id AND p.participant_id=w4_event_links.author_id
   AND p.consent_at IS NOT NULL AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()));
CREATE FUNCTION finnor_os.w4_s1_privacy_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$ BEGIN
 IF OLD.metadata->>'w4Private'='true' AND
  (NEW.metadata->>'w4Private',NEW.metadata->>'w4PrincipalId',NEW.metadata->>'w4AuthorId',NEW.metadata->>'w4WorkId')
  IS DISTINCT FROM
  (OLD.metadata->>'w4Private',OLD.metadata->>'w4PrincipalId',OLD.metadata->>'w4AuthorId',OLD.metadata->>'w4WorkId')
 THEN RAISE EXCEPTION 'W4 S1 source privacy identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w4_s1_privacy BEFORE UPDATE ON finnor_os.evidence_sources
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w4_s1_privacy_guard();
CREATE FUNCTION finnor_os.w4_s1_version_privacy_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$ DECLARE m jsonb; BEGIN
 IF TG_OP='UPDATE' AND OLD.snapshot->>'w4Private'='true' AND
  (NEW.tenant_id,NEW.source_id,NEW.snapshot->>'w4Private',NEW.snapshot->>'w4PrincipalId',NEW.snapshot->>'w4AuthorId',NEW.snapshot->>'w4WorkId')
  IS DISTINCT FROM
  (OLD.tenant_id,OLD.source_id,OLD.snapshot->>'w4Private',OLD.snapshot->>'w4PrincipalId',OLD.snapshot->>'w4AuthorId',OLD.snapshot->>'w4WorkId')
 THEN RAISE EXCEPTION 'W4 S1 version privacy identity is immutable'; END IF;
 SELECT metadata INTO m FROM finnor_os.evidence_sources WHERE id=NEW.source_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'W4 S1 source unavailable'; END IF;
 IF m->>'w4Private'='true' AND
  (NEW.snapshot->>'w4Private',NEW.snapshot->>'w4PrincipalId',NEW.snapshot->>'w4AuthorId',NEW.snapshot->>'w4WorkId')
  IS DISTINCT FROM
  (m->>'w4Private',m->>'w4PrincipalId',m->>'w4AuthorId',m->>'w4WorkId')
 THEN RAISE EXCEPTION 'W4 S1 version must retain original privacy identity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w4_s1_version_privacy BEFORE INSERT OR UPDATE ON finnor_os.evidence_source_versions
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w4_s1_version_privacy_guard();
CREATE POLICY w4_private_source_select ON finnor_os.evidence_sources AS RESTRICTIVE FOR SELECT
 USING(metadata->>'w4Private' IS DISTINCT FROM 'true' OR tenant_id=finnor_os.request_tenant_id()
  AND (metadata->>'w4PrincipalId'=current_setting('app.user_id',true)
    OR metadata->>'w4AuthorId'=current_setting('app.user_id',true)));
CREATE POLICY w4_private_version_select ON finnor_os.evidence_source_versions AS RESTRICTIVE FOR SELECT
 USING(snapshot->>'w4Private' IS DISTINCT FROM 'true' OR tenant_id=finnor_os.request_tenant_id()
  AND (snapshot->>'w4PrincipalId'=current_setting('app.user_id',true)
    OR snapshot->>'w4AuthorId'=current_setting('app.user_id',true)));
CREATE POLICY w4_private_chunk_select ON finnor_os.evidence_chunks AS RESTRICTIVE FOR SELECT
 USING(EXISTS(SELECT 1 FROM finnor_os.evidence_source_versions v WHERE v.id=version_id));
CREATE FUNCTION finnor_os.w4_participant_change(p_protocol uuid,p_revoke boolean,p_source uuid DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 p record; q record;
 BEGIN
  PERFORM 1 FROM finnor_os.users WHERE tenant_id=t AND id=u AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'W4 participant unavailable'; END IF;
  SELECT * INTO p FROM finnor_os.w4_participant_protocols WHERE tenant_id=t AND id=p_protocol
   AND participant_id=u AND expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND OR p.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'W4 exact current protocol unavailable'; END IF;
  IF p_source IS NULL THEN
   UPDATE finnor_os.w4_participant_protocols SET
    consent_at=CASE WHEN p_revoke THEN consent_at ELSE coalesce(consent_at,clock_timestamp()) END,
    revoked_at=CASE WHEN p_revoke THEN coalesce(revoked_at,clock_timestamp()) ELSE revoked_at END WHERE id=p.id AND tenant_id=t;
  ELSE
   IF p_revoke OR p.consent_at IS NULL THEN RAISE EXCEPTION 'W4 actual self-consent required'; END IF;
   PERFORM 1 FROM finnor_os.w4_event_links e JOIN finnor_os.w4_original_source_links l
    ON l.tenant_id=e.tenant_id AND l.source_id=e.source_id AND l.version_id=e.version_id
    WHERE e.tenant_id=t AND e.protocol_id=p.id AND e.source_id=p_source AND e.author_id=u
     AND e.request_id=p.request_id AND l.author_id=u AND l.protocol_id=p.id AND l.kind='EVENT';
   IF NOT FOUND THEN RAISE EXCEPTION 'W4 original authenticated event unavailable'; END IF;
  END IF;
  IF p.request_id IS NULL THEN RETURN; END IF;
  UPDATE finnor_os.w4_business_requests SET wake_revision=wake_revision+1,
   updated_at=clock_timestamp() WHERE tenant_id=t AND id=p.request_id RETURNING * INTO q;
  IF q.id IS NULL THEN RAISE EXCEPTION 'W4 original programme unavailable'; END IF;
  IF q.artifact_id IS NOT NULL THEN
   INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
    VALUES(t,'advance_market_operating_program_v1',
     jsonb_build_object('tenantId',t,'principalId',q.principal_id,'requestId',q.id,
       'generation',q.generation,'wakeRevision',q.wake_revision),
     'w4:'||q.id::text||':'||q.generation::text||':'||q.wake_revision::text||':false','interactive',1,'reconcilable')
    ON CONFLICT(idempotency_key) DO NOTHING;
  END IF;
 END $$;
REVOKE ALL ON FUNCTION finnor_os.w4_participant_change(uuid,boolean,uuid) FROM PUBLIC;
-- Lock only the current authenticated participant's exact protocol. A normal
-- locking SELECT also applies owner-only UPDATE RLS and cannot serve self reads.
CREATE FUNCTION finnor_os.w4_lock_self_protocol(p_protocol uuid,p_consent boolean DEFAULT true)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 BEGIN
  PERFORM 1 FROM finnor_os.users WHERE tenant_id=t AND id=u AND status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM finnor_os.w4_participant_protocols
   WHERE tenant_id=t AND id=p_protocol AND participant_id=u AND expires_at>clock_timestamp()
    AND (p_consent IS FALSE OR consent_at IS NOT NULL AND revoked_at IS NULL) FOR UPDATE;
  RETURN FOUND;
 END $$;
REVOKE ALL ON FUNCTION finnor_os.w4_lock_self_protocol(uuid,boolean) FROM PUBLIC;
-- Purpose-minimized original references, not owner credentials or a Work grant.
CREATE FUNCTION finnor_os.w4_participant_progress(p_protocol uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 p record; events jsonb; executions jsonb; evidence jsonb;
 BEGIN
  SELECT q.* INTO p FROM finnor_os.w4_participant_protocols q JOIN finnor_os.users a
   ON a.tenant_id=q.tenant_id AND a.id=q.participant_id AND a.status='active'
   WHERE q.tenant_id=t AND q.id=p_protocol AND q.participant_id=u AND q.consent_at IS NOT NULL
    AND q.revoked_at IS NULL AND q.expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'W4 current self-consenting protocol unavailable'; END IF;
  SELECT coalesce(jsonb_agg(x.body ORDER BY x.created_at,x.source_id),'[]'::jsonb) INTO events FROM (
   SELECT e.created_at,e.source_id,jsonb_build_object(
    'source',jsonb_build_object('sourceId',e.source_id,'versionId',e.version_id,'contentDigest',e.content_digest),
    'body',v.content::jsonb,'authorId',e.author_id,'role',q.role,'receivedAt',e.created_at,
    'evidenceClass',l.evidence_class) body
   FROM finnor_os.w4_event_links e JOIN finnor_os.w4_participant_protocols q
    ON q.tenant_id=e.tenant_id AND q.id=e.protocol_id AND q.participant_id=e.author_id
     AND q.request_id=e.request_id AND q.principal_id=e.principal_id
   JOIN finnor_os.w4_original_source_links l ON l.tenant_id=e.tenant_id AND l.source_id=e.source_id
    AND l.version_id=e.version_id AND l.content_digest=e.content_digest AND l.author_id=e.author_id
    AND l.protocol_id=q.id AND l.kind='EVENT' AND l.work_id=p.work_id
   JOIN finnor_os.evidence_source_versions v ON v.tenant_id=l.tenant_id AND v.source_id=l.source_id AND v.id=l.version_id
   WHERE e.tenant_id=t AND e.principal_id=p.principal_id AND e.request_id=p.request_id AND q.purpose=p.purpose
    AND q.consent_at<=e.created_at AND (q.revoked_at IS NULL OR q.revoked_at>e.created_at)
    AND q.expires_at>e.created_at AND q.permitted_kinds ? (v.content::jsonb->>'kind')
    AND v.content_hash=e.content_digest AND e.body_digest=e.content_digest
    AND encode(sha256(convert_to(v.content,'UTF8')),'hex')=v.content_hash
    AND v.content::jsonb->'scope'=p.operational_disclosure->'scope'
    AND (
     p.role='INDEPENDENT_OBSERVER' AND v.content::jsonb->>'kind' IN('TEST_CLOSED','MARKET_CHANGE')
     OR p.role='ACCOUNTANT' AND p.permitted_kinds ? 'COST' AND v.content::jsonb->>'kind'='COST'
     OR v.content::jsonb->>'buyerId'=p.buyer_id::text AND v.content::jsonb->>'offerId'=p.offer_id
      AND v.content::jsonb->>'termsDigest'=p.terms_digest
      AND (p.role IN('BUYER','ACCOUNTANT') OR p.role='OPERATOR'
       AND v.content::jsonb->>'kind' IN('RESPONSE','DELIVERY','DELIVERY_ACCEPTANCE','SUPPORT'))
    )
   ORDER BY e.created_at,e.source_id LIMIT 129
  ) x;
  SELECT coalesce(jsonb_agg(x.body ORDER BY x.created_at,x.source_id),'[]'::jsonb) INTO executions FROM (
   SELECT l.created_at,l.source_id,jsonb_build_object(
    'source',jsonb_build_object('sourceId',l.source_id,'versionId',l.version_id,'contentDigest',l.content_digest),
    'operation',v.content::jsonb->'operation','quantity',v.content::jsonb->'quantity',
    'amount',v.content::jsonb->'amount','obligationRef',v.content::jsonb->'obligationRef') body
   FROM finnor_os.w4_original_source_links l JOIN finnor_os.evidence_source_versions v
    ON v.tenant_id=l.tenant_id AND v.source_id=l.source_id AND v.id=l.version_id
   WHERE l.tenant_id=t AND l.principal_id=p.principal_id AND l.author_id=p.principal_id
    AND l.work_id=p.work_id AND l.kind='NATIVE' AND l.purpose=p.purpose
    AND v.content_hash=l.content_digest AND encode(sha256(convert_to(v.content,'UTF8')),'hex')=v.content_hash
    AND v.content::jsonb->'scope'=p.operational_disclosure->'scope'
    AND v.content::jsonb->>'buyerId'=p.buyer_id::text AND v.content::jsonb->>'offerId'=p.offer_id
    AND v.content::jsonb->>'termsDigest'=p.terms_digest
    AND (p.role='BUYER' OR p.role='OPERATOR' AND v.content::jsonb->>'operation'='DELIVER'
     OR p.role='ACCOUNTANT' AND v.content::jsonb->>'operation' IN('COLLECT','REFUND'))
   ORDER BY l.created_at,l.source_id LIMIT 65
  ) x;
  SELECT coalesce(jsonb_agg(x.body ORDER BY x.created_at,x.source_id),'[]'::jsonb) INTO evidence FROM (
   SELECT l.created_at,l.source_id,jsonb_build_object(
    'source',jsonb_build_object('sourceId',l.source_id,'versionId',l.version_id,'contentDigest',l.content_digest),
    'kind',v.content::jsonb->'kind','subjectId',v.content::jsonb->'subjectId',
    'validFrom',v.content::jsonb->'validFrom','validUntil',v.content::jsonb->'validUntil',
    'data',jsonb_build_object('buyerId',v.content::jsonb#>'{data,buyerId}',
     'offerId',v.content::jsonb#>'{data,offerId}','termsDigest',v.content::jsonb#>'{data,termsDigest}',
     'amount',v.content::jsonb#>'{data,amount}','category',v.content::jsonb#>'{data,category}')) body
   FROM finnor_os.w4_original_source_links l JOIN finnor_os.evidence_source_versions v
    ON v.tenant_id=l.tenant_id AND v.source_id=l.source_id AND v.id=l.version_id
   WHERE l.tenant_id=t AND l.principal_id=p.principal_id AND l.author_id=u AND l.work_id=p.work_id
    AND l.kind='EVIDENCE' AND l.purpose=p.purpose AND v.content_hash=l.content_digest
    AND encode(sha256(convert_to(v.content,'UTF8')),'hex')=v.content_hash
    AND v.content::jsonb->'scope'=p.operational_disclosure->'scope'
    AND (p.operational_disclosure->'evidenceKinds' ? (v.content::jsonb->>'kind')
     OR p.role='ACCOUNTANT' AND v.content::jsonb->>'kind' IN('INVOICE','ACCOUNTING'))
    AND (v.content::jsonb->>'kind' NOT IN('INVOICE','ACCOUNTING') OR p.role='ACCOUNTANT' AND (
     v.content::jsonb#>>'{data,buyerId}'=p.buyer_id::text
      AND v.content::jsonb#>>'{data,offerId}'=p.offer_id AND v.content::jsonb#>>'{data,termsDigest}'=p.terms_digest
     OR v.content::jsonb->>'kind'='ACCOUNTING' AND v.content::jsonb#>>'{data,kind}'='COST'
      AND p.permitted_kinds ? 'COST'))
   ORDER BY l.created_at,l.source_id LIMIT 65
  ) x;
  RETURN jsonb_build_object('protocolId',p.id,'participantId',u,'scope',p.operational_disclosure->'scope',
   'expiresAt',p.expires_at,'events',events,'executions',executions,'evidence',evidence);
 END $$;
REVOKE ALL ON FUNCTION finnor_os.w4_participant_progress(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT EXECUTE ON FUNCTION finnor_os.w4_participant_change(uuid,boolean,uuid) TO finnor_app;
 GRANT EXECUTE ON FUNCTION finnor_os.w4_lock_self_protocol(uuid,boolean) TO finnor_app;
 GRANT EXECUTE ON FUNCTION finnor_os.w4_participant_progress(uuid) TO finnor_app;
END IF; END $$;
INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES
 ('compile_market_operating_program_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
  'W4 original Work bounded commercial programme construction and independent checking; no market truth or authority grant.'),
 ('advance_market_operating_program_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
  'W4 exact original S5/S6 coordination, independently authored customer/accounting observations and retained commitments.');
