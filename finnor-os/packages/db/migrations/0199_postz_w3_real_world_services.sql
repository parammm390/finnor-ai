-- W3 coordination metadata only. S1 retains evidence, S4 Work, S5 resources,
-- S6 effects and S7 accounts. No provider/grant/resource/financial ledger here.
CREATE TABLE finnor_os.w3_service_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL, company_id uuid NOT NULL, work_id uuid NOT NULL,
 work_input_id uuid NOT NULL, business_assignment_id text NOT NULL,
 idempotency_key text NOT NULL, request_digest text NOT NULL,
 outcome_ref jsonb NOT NULL, provider_refs jsonb NOT NULL, mandate_ref jsonb NOT NULL,
 parent_policy jsonb NOT NULL, parent_allocation jsonb NOT NULL,
 budget_obligation_ref jsonb NOT NULL, s7_estimand_id text,
 identity jsonb NOT NULL, rights_revision bigint NOT NULL,
 original_deadline timestamptz NOT NULL, compile_deadline timestamptz NOT NULL,
 generation integer NOT NULL DEFAULT 1, wake_revision bigint NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN
  ('QUEUED','RUNNING','CHECKED','PARTIAL','INVALIDATED','CANCELLED','UNKNOWN','FAILED')),
 claim_token uuid, claim_fence bigint, artifact_id uuid, failure text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,principal_id,idempotency_key),
 UNIQUE(tenant_id,principal_id,work_id,business_assignment_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 CHECK(generation>=1 AND wake_revision>=1 AND compile_deadline<=original_deadline),
 CHECK(length(idempotency_key) BETWEEN 1 AND 160 AND length(business_assignment_id) BETWEEN 1 AND 160),
 CHECK(request_digest ~ '^[a-f0-9]{64}$' AND jsonb_typeof(provider_refs)='array'
   AND jsonb_array_length(provider_refs)<=128)
);
CREATE TABLE finnor_os.w3_service_artifacts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL, request_id uuid NOT NULL, generation integer NOT NULL,
 body jsonb NOT NULL, body_digest text NOT NULL, check_result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_id,generation),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w3_service_requests(tenant_id,id),
 CHECK(body_digest ~ '^[a-f0-9]{64}$' AND octet_length(body::text)<=8388608
   AND octet_length(check_result::text)<=262144)
);
CREATE TABLE finnor_os.w3_participant_protocols (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL, request_id uuid NOT NULL, participant_id uuid NOT NULL,
 instance_id text NOT NULL, provider_id uuid NOT NULL, terms_digest text NOT NULL,
 role text NOT NULL CHECK(role IN('PROVIDER','RECIPIENT','INSPECTOR','PROFESSIONAL','ACCEPTANCE_OWNER')),
 criterion_ids jsonb NOT NULL, permitted_kinds jsonb NOT NULL, purpose text NOT NULL,
 operational_disclosure jsonb NOT NULL, qualification_refs jsonb NOT NULL,
 incentive_ref jsonb, expires_at timestamptz NOT NULL,
 consent_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w3_service_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,participant_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(terms_digest ~ '^[a-f0-9]{64}$' AND jsonb_typeof(criterion_ids)='array')
);
CREATE TABLE finnor_os.w3_observation_links (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, request_id uuid NOT NULL,
 protocol_id uuid NOT NULL, source_id uuid NOT NULL, version_id uuid NOT NULL,
 content_digest text NOT NULL, author_id uuid NOT NULL, idempotency_key text NOT NULL,
 body_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id,source_id),
 UNIQUE(tenant_id,protocol_id,idempotency_key),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w3_service_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,protocol_id) REFERENCES finnor_os.w3_participant_protocols(tenant_id,id),
 FOREIGN KEY(source_id) REFERENCES finnor_os.evidence_sources(id),
 FOREIGN KEY(version_id) REFERENCES finnor_os.evidence_source_versions(id),
 FOREIGN KEY(tenant_id,author_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE INDEX w3_service_work ON finnor_os.w3_service_requests(tenant_id,principal_id,work_id);
CREATE INDEX w3_participant_inbox ON finnor_os.w3_participant_protocols(tenant_id,participant_id,expires_at);
CREATE FUNCTION finnor_os.w3_request_original_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$ BEGIN
 IF TG_OP='DELETE' OR
  (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.company_id,NEW.work_id,NEW.work_input_id,
   NEW.business_assignment_id,NEW.outcome_ref,NEW.mandate_ref,NEW.parent_policy,NEW.parent_allocation,
   NEW.budget_obligation_ref,NEW.original_deadline,NEW.compile_deadline,NEW.identity,NEW.request_digest)
  IS DISTINCT FROM
  (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.company_id,OLD.work_id,OLD.work_input_id,
   OLD.business_assignment_id,OLD.outcome_ref,OLD.mandate_ref,OLD.parent_policy,OLD.parent_allocation,
   OLD.budget_obligation_ref,OLD.original_deadline,OLD.compile_deadline,OLD.identity,OLD.request_digest)
  OR NEW.generation<OLD.generation OR NEW.wake_revision<OLD.wake_revision
 THEN RAISE EXCEPTION 'W3 original Work/resources/deadline cannot be replaced'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w3_original_guard BEFORE UPDATE OR DELETE ON finnor_os.w3_service_requests
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w3_request_original_guard();
CREATE TRIGGER w3_artifacts_immutable BEFORE UPDATE OR DELETE ON finnor_os.w3_service_artifacts
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable();
CREATE TRIGGER w3_observations_immutable BEFORE UPDATE OR DELETE ON finnor_os.w3_observation_links
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['w3_service_requests','w3_service_artifacts','w3_participant_protocols','w3_observation_links'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY %I ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',tab||'_owner',tab);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
   EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',tab);
   IF tab IN('w3_service_requests','w3_participant_protocols') THEN
    EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_app',tab);
   END IF;
  END IF;
 END LOOP;
END $$;
-- Only authenticated invited participants can see their own narrow protocol or
-- immutable self-authored report link. No participant gains the owner's Work.
CREATE POLICY w3_protocol_participant ON finnor_os.w3_participant_protocols FOR SELECT
 USING(tenant_id=finnor_os.request_tenant_id() AND participant_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w3_self_report ON finnor_os.w3_observation_links FOR SELECT
 USING(tenant_id=finnor_os.request_tenant_id() AND author_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w3_participant_report_insert ON finnor_os.w3_observation_links FOR INSERT
 WITH CHECK(tenant_id=finnor_os.request_tenant_id()
  AND author_id=nullif(current_setting('app.user_id',true),'')::uuid
  AND EXISTS(SELECT 1 FROM finnor_os.w3_participant_protocols p
   WHERE p.tenant_id=w3_observation_links.tenant_id AND p.id=protocol_id
    AND p.request_id=w3_observation_links.request_id AND p.principal_id=w3_observation_links.principal_id
    AND p.participant_id=w3_observation_links.author_id
    AND p.consent_at IS NOT NULL AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()));
CREATE FUNCTION finnor_os.w3_participant_consent(p_protocol uuid,p_revoke boolean) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 p record; q record; recompile boolean;
 BEGIN
  PERFORM 1 FROM finnor_os.users WHERE tenant_id=t AND id=u AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'W3 participant unavailable'; END IF;
  UPDATE finnor_os.w3_participant_protocols SET
   consent_at=CASE WHEN p_revoke THEN consent_at ELSE coalesce(consent_at,clock_timestamp()) END,
   revoked_at=CASE WHEN p_revoke THEN coalesce(revoked_at,clock_timestamp()) ELSE revoked_at END
   WHERE tenant_id=t AND id=p_protocol AND participant_id=u
    AND expires_at>clock_timestamp() AND (p_revoke OR revoked_at IS NULL) RETURNING * INTO p;
  IF NOT FOUND THEN RAISE EXCEPTION 'W3 protocol unavailable'; END IF;
  IF p_revoke THEN
   recompile:=p.role='PROVIDER' AND p.permitted_kinds ? 'PROVIDER_EVIDENCE';
   UPDATE finnor_os.w3_service_requests SET wake_revision=wake_revision+1,
    generation=generation+CASE WHEN recompile THEN 1 ELSE 0 END,
    status=CASE WHEN recompile THEN 'QUEUED' ELSE status END,updated_at=clock_timestamp()
    WHERE tenant_id=t AND id=p.request_id AND status NOT IN('CANCELLED','INVALIDATED','FAILED') RETURNING * INTO q;
   IF q.id IS NOT NULL THEN
    INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
     VALUES(t,CASE WHEN recompile THEN 'compile_real_world_service_v1' ELSE 'advance_real_world_service_v1' END,
      jsonb_build_object('tenantId',t,'principalId',q.principal_id,'requestId',q.id,
       'generation',q.generation,'wakeRevision',q.wake_revision),
      'w3:'||q.id::text||':'||q.generation::text||':'||q.wake_revision::text||':'||recompile::text,
      'interactive',1,CASE WHEN recompile THEN 'locally_idempotent' ELSE 'reconcilable' END)
     ON CONFLICT(idempotency_key) DO NOTHING;
   END IF;
  END IF;
 END $$;
REVOKE ALL ON FUNCTION finnor_os.w3_participant_consent(uuid,boolean) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT EXECUTE ON FUNCTION finnor_os.w3_participant_consent(uuid,boolean) TO finnor_app;
END IF; END $$;
INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('compile_real_world_service_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'Original Work physical-service construction and separately specified complete graph/evidence check; no new grant or effect.'),
 ('advance_real_world_service_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'Current checked W3 native-owner coordination and observation; original S5/S6 identities, no direct provider egress.');
CREATE TABLE finnor_os.w3_original_source_links (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, work_id uuid NOT NULL,
 source_id uuid NOT NULL, version_id uuid NOT NULL, content_digest text NOT NULL,
 author_id uuid NOT NULL, purpose text NOT NULL,
 evidence_class text NOT NULL CHECK(evidence_class IN('CONTROLLED','REPLAYED')),
 idempotency_key text NOT NULL, protocol_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,source_id,version_id),
 UNIQUE(tenant_id,author_id,work_id,idempotency_key),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,author_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(source_id) REFERENCES finnor_os.evidence_sources(id),
 FOREIGN KEY(version_id) REFERENCES finnor_os.evidence_source_versions(id)
);
ALTER TABLE finnor_os.w3_original_source_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.w3_original_source_links FORCE ROW LEVEL SECURITY;
CREATE POLICY w3_original_source_owner ON finnor_os.w3_original_source_links FOR SELECT
 USING(tenant_id=finnor_os.request_tenant_id() AND
  (principal_id=nullif(current_setting('app.user_id',true),'')::uuid
   OR author_id=nullif(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY w3_original_source_self_insert ON finnor_os.w3_original_source_links FOR INSERT
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND
  author_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE TRIGGER w3_original_sources_immutable BEFORE UPDATE OR DELETE ON finnor_os.w3_original_source_links
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable();
-- Privacy must survive generic S1 writes, not just this API's source writer.
-- Do not rely on a SECURITY DEFINER bypass of FORCE RLS to find hidden links.
CREATE FUNCTION finnor_os.w3_s1_source_privacy_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$ BEGIN
 IF OLD.metadata->>'w3Private'='true' AND
  (NEW.metadata->>'w3Private',NEW.metadata->>'w3PrincipalId',NEW.metadata->>'w3AuthorId',NEW.metadata->>'w3WorkId')
  IS DISTINCT FROM
  (OLD.metadata->>'w3Private',OLD.metadata->>'w3PrincipalId',OLD.metadata->>'w3AuthorId',OLD.metadata->>'w3WorkId')
 THEN RAISE EXCEPTION 'W3 original S1 privacy identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER w3_s1_source_privacy BEFORE UPDATE ON finnor_os.evidence_sources
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w3_s1_source_privacy_guard();
CREATE FUNCTION finnor_os.w3_s1_version_privacy_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
 DECLARE m jsonb;
 BEGIN
  IF TG_OP='UPDATE' AND OLD.snapshot->>'w3Private'='true' AND
   (NEW.tenant_id,NEW.source_id,NEW.snapshot->>'w3Private',NEW.snapshot->>'w3PrincipalId',NEW.snapshot->>'w3AuthorId',NEW.snapshot->>'w3WorkId')
   IS DISTINCT FROM
   (OLD.tenant_id,OLD.source_id,OLD.snapshot->>'w3Private',OLD.snapshot->>'w3PrincipalId',OLD.snapshot->>'w3AuthorId',OLD.snapshot->>'w3WorkId')
  THEN RAISE EXCEPTION 'W3 original version privacy identity is immutable'; END IF;
  SELECT metadata INTO m FROM finnor_os.evidence_sources WHERE id=NEW.source_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'S1 source not visible to version author'; END IF;
  IF m->>'w3Private'='true' AND
   (NEW.snapshot->>'w3Private',NEW.snapshot->>'w3PrincipalId',NEW.snapshot->>'w3AuthorId',NEW.snapshot->>'w3WorkId')
   IS DISTINCT FROM
   (m->>'w3Private',m->>'w3PrincipalId',m->>'w3AuthorId',m->>'w3WorkId')
  THEN RAISE EXCEPTION 'W3 version must retain original S1 privacy identity'; END IF;
  RETURN NEW;
 END $$;
CREATE TRIGGER w3_s1_version_privacy BEFORE INSERT OR UPDATE ON finnor_os.evidence_source_versions
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w3_s1_version_privacy_guard();
-- Existing generic tenant research must not leak a private participant report.
CREATE POLICY w3_private_source_select ON finnor_os.evidence_sources AS RESTRICTIVE FOR SELECT
 USING(metadata->>'w3Private' IS DISTINCT FROM 'true'
  OR tenant_id=finnor_os.request_tenant_id() AND
    (metadata->>'w3PrincipalId'=current_setting('app.user_id',true)
     OR metadata->>'w3AuthorId'=current_setting('app.user_id',true)));
CREATE POLICY w3_private_version_select ON finnor_os.evidence_source_versions AS RESTRICTIVE FOR SELECT
 USING(snapshot->>'w3Private' IS DISTINCT FROM 'true'
  OR snapshot->>'w3Private'='true' AND tenant_id=finnor_os.request_tenant_id() AND
    (snapshot->>'w3PrincipalId'=current_setting('app.user_id',true)
     OR snapshot->>'w3AuthorId'=current_setting('app.user_id',true)));
CREATE POLICY w3_private_chunk_select ON finnor_os.evidence_chunks AS RESTRICTIVE FOR SELECT
 USING(EXISTS(SELECT 1 FROM finnor_os.evidence_source_versions v WHERE v.id=version_id));
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT SELECT,INSERT ON finnor_os.w3_original_source_links TO finnor_app;
END IF; END $$;
CREATE FUNCTION finnor_os.w3_protocol_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
 BEGIN
  IF (to_jsonb(NEW)-'consent_at'-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'consent_at'-'revoked_at')
   OR OLD.consent_at IS NOT NULL AND NEW.consent_at IS DISTINCT FROM OLD.consent_at
   OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
   OR NEW.consent_at IS DISTINCT FROM OLD.consent_at
      AND NEW.participant_id IS DISTINCT FROM nullif(current_setting('app.user_id',true),'')::uuid
  THEN RAISE EXCEPTION 'W3 protocol and participant consent identity are immutable'; END IF;
  RETURN NEW;
 END $$;
CREATE TRIGGER w3_protocol_immutable BEFORE UPDATE ON finnor_os.w3_participant_protocols
 FOR EACH ROW EXECUTE FUNCTION finnor_os.w3_protocol_guard();
CREATE FUNCTION finnor_os.w3_wake_from_source(p_protocol uuid,p_source uuid,p_version uuid,p_digest text,p_provider boolean)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 p record; q record; new_ref jsonb;
 BEGIN
  SELECT * INTO p FROM finnor_os.w3_participant_protocols
   WHERE tenant_id=t AND id=p_protocol AND participant_id=u AND consent_at IS NOT NULL
    AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE;
  IF p IS NULL THEN RAISE EXCEPTION 'W3 current self-consented protocol required'; END IF;
  PERFORM 1 FROM finnor_os.w3_original_source_links s JOIN finnor_os.evidence_source_versions v
   ON v.tenant_id=s.tenant_id AND v.source_id=s.source_id AND v.id=s.version_id
   WHERE s.tenant_id=t AND s.author_id=u AND s.protocol_id=p.id AND s.source_id=p_source
    AND s.version_id=p_version AND s.content_digest=p_digest AND v.content_hash=p_digest;
  IF NOT FOUND THEN RAISE EXCEPTION 'W3 actual self-authored immutable S1 source required'; END IF;
  SELECT * INTO q FROM finnor_os.w3_service_requests
   WHERE tenant_id=t AND id=p.request_id FOR UPDATE;
  IF q IS NULL THEN RAISE EXCEPTION 'W3 original request unavailable'; END IF;
  IF p_provider THEN
   IF p.role<>'PROVIDER' OR NOT p.permitted_kinds ? 'PROVIDER_EVIDENCE'
    OR p.participant_id<>p.provider_id THEN RAISE EXCEPTION 'W3 provider identity mismatch'; END IF;
   new_ref:=jsonb_build_object('sourceId',p_source,'versionId',p_version,'contentDigest',p_digest);
   UPDATE finnor_os.w3_service_requests SET provider_refs=
    -- Provider self-authorship is the immutable link identity. General S1
    -- content need not be JSON; a planner may evaluate its cast before a join.
    (SELECT coalesce(jsonb_agg(refs.ref ORDER BY refs.ordinal),'[]'::jsonb)
     FROM jsonb_array_elements(provider_refs) WITH ORDINALITY AS refs(ref,ordinal)
     WHERE NOT EXISTS(SELECT 1 FROM finnor_os.w3_original_source_links s
      WHERE s.tenant_id=t AND s.principal_id=q.principal_id AND s.work_id=q.work_id AND s.author_id=u
       AND s.source_id=(refs.ref->>'sourceId')::uuid AND s.version_id=(refs.ref->>'versionId')::uuid
       AND s.content_digest=refs.ref->>'contentDigest'))||jsonb_build_array(new_ref),
    generation=generation+1,wake_revision=wake_revision+1,status='QUEUED',updated_at=clock_timestamp()
    WHERE tenant_id=t AND id=q.id AND status NOT IN('CANCELLED','INVALIDATED','FAILED')
    RETURNING * INTO q;
  ELSE
   UPDATE finnor_os.w3_service_requests SET wake_revision=wake_revision+1,updated_at=clock_timestamp()
    WHERE tenant_id=t AND id=q.id RETURNING * INTO q;
  END IF;
  IF q.id IS NOT NULL THEN
   INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
    VALUES(t,CASE WHEN p_provider THEN 'compile_real_world_service_v1' ELSE 'advance_real_world_service_v1' END,
     jsonb_build_object('tenantId',t,'principalId',q.principal_id,'requestId',q.id,
       'generation',q.generation,'wakeRevision',q.wake_revision),
     'w3:'||q.id::text||':'||q.generation::text||':'||q.wake_revision::text||':'||p_provider::text,
     'interactive',1,CASE WHEN p_provider THEN 'locally_idempotent' ELSE 'reconcilable' END)
    ON CONFLICT(idempotency_key) DO NOTHING;
  END IF;
 END $$;
REVOKE ALL ON FUNCTION finnor_os.w3_wake_from_source(uuid,uuid,uuid,text,boolean) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT EXECUTE ON FUNCTION finnor_os.w3_wake_from_source(uuid,uuid,uuid,text,boolean) TO finnor_app;
END IF; END $$;
