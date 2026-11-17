-- Additive to frozen 0201. This is a self-scoped reference-packet mailbox,
-- never a replacement approval, effect, resource or workforce authority ledger.
CREATE FUNCTION finnor_os.w5_participant_head(p_request uuid,p_role text)
 RETURNS TABLE(work_id uuid,owner_id uuid,phase text,revision integer,current_terms boolean,method_pins jsonb,
  pending_native boolean,terms_digest text,alternative_id text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();
 u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
 IF u IS NULL OR NOT EXISTS(
  SELECT 1 FROM finnor_os.w5_role_offers o JOIN finnor_os.w5_requests q
   ON q.tenant_id=o.tenant_id AND q.id=o.request_id AND q.principal_id=o.principal_id
  WHERE o.tenant_id=t AND o.request_id=p_request AND o.role_id=p_role AND o.participant_id=u
 ) THEN RETURN; END IF;
 -- Actor/profile/role writers invalidate this canonical state. Fence it before
 -- calculating currentness, not only in the caller's later authority check.
 PERFORM a.tenant_id FROM finnor_os.authority_states a WHERE a.tenant_id=t FOR SHARE OF a;
 -- Source version allocation takes the same source-row writer lock.
 PERFORM s.id FROM finnor_os.w5_dependency_pins p
  JOIN finnor_os.evidence_source_versions v ON v.tenant_id=p.tenant_id AND v.id::text=p.source_id
  JOIN finnor_os.evidence_sources s ON s.tenant_id=v.tenant_id AND s.id=v.source_id
  JOIN finnor_os.users issuer ON issuer.tenant_id=s.tenant_id AND issuer.id::text=s.metadata->>'authenticatedPrincipal'
  WHERE p.tenant_id=t AND p.request_id=p_request AND p.kind='S1' FOR SHARE OF s,v,issuer;
 PERFORM a.id FROM finnor_os.w5_dependency_pins p
  JOIN finnor_os.users a ON a.tenant_id=p.tenant_id AND a.id::text=p.source_id
  WHERE p.tenant_id=t AND p.request_id=p_request AND p.kind='ACTOR' FOR SHARE OF a;
 PERFORM h.resource_id FROM finnor_os.w5_dependency_pins p
  JOIN finnor_os.s5_resource_heads h ON h.tenant_id=p.tenant_id AND h.resource_id=p.source_id
  WHERE p.tenant_id=t AND p.request_id=p_request AND p.kind='S5_RESOURCE' FOR SHARE OF h;
 RETURN QUERY SELECT q.work_id,q.principal_id,q.status,q.revision,
  o.revoked_at IS NULL AND o.expires_at>clock_timestamp() AND q.original_deadline>clock_timestamp()
  AND q.status IN('AWAITING_ADOPTION','ADOPTED','TRIAL','ACTIVE','PARTIAL')
  AND q.program->>'selectedAlternativeId'=o.alternative_id
  AND o.terms->>'alternativeId'=o.alternative_id
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.program->'alternatives') alt,
    jsonb_array_elements(alt->'roles') r
   WHERE alt->>'id'=o.alternative_id AND r->>'id'=o.role_id AND r->>'principalId'=u::text
    AND r=o.terms->'role')
  AND w.created_by=q.principal_id AND i.created_by=q.principal_id
  AND w.status NOT IN('cancelled','failed')
  AND encode(sha256(convert_to(i.instruction_text,'UTF8')),'hex')=q.original_input_digest
  AND EXISTS(SELECT 1 FROM finnor_os.authority_states a
   WHERE a.tenant_id=t AND a.revision=q.rights_revision)
  AND (SELECT count(*) FROM finnor_os.w5_dependency_pins p
   WHERE p.tenant_id=t AND p.request_id=q.id AND p.kind='S1')>=2
  AND NOT EXISTS(
   SELECT 1 FROM finnor_os.w5_dependency_pins p
   LEFT JOIN finnor_os.evidence_source_versions v ON v.tenant_id=p.tenant_id AND v.id::text=p.source_id
   LEFT JOIN finnor_os.evidence_sources s ON s.tenant_id=v.tenant_id AND s.id=v.source_id
   LEFT JOIN finnor_os.users issuer ON issuer.tenant_id=s.tenant_id
    AND issuer.id::text=s.metadata->>'authenticatedPrincipal'
   WHERE p.tenant_id=t AND p.request_id=q.id AND p.kind='S1' AND(
    v.id IS NULL OR v.content_hash IS DISTINCT FROM p.digest
    OR encode(sha256(convert_to(v.content,'UTF8')),'hex') IS DISTINCT FROM p.digest
    OR v.scope<>'tenant' OR coalesce(s.metadata->>'revoked','false')='true'
    OR issuer.status IS DISTINCT FROM 'active'
    OR EXISTS(SELECT 1 FROM finnor_os.evidence_source_versions newer
     WHERE newer.tenant_id=v.tenant_id AND newer.source_id=v.source_id AND newer.version_number>v.version_number)
    OR (v.content::jsonb->>'schema'='finnor.organization-authenticated-source.v1' AND(
     (v.content::jsonb->>'observedAt')::timestamptz>clock_timestamp()
     OR (v.content::jsonb->>'validUntil')::timestamptz<=clock_timestamp()))))
  AND (SELECT count(*) FROM finnor_os.w5_dependency_pins p
   WHERE p.tenant_id=t AND p.request_id=q.id AND p.kind='ACTOR')=
   (SELECT count(DISTINCT r->>'principalId') FROM jsonb_array_elements(q.original->'organization'->'roles') r)
  AND NOT EXISTS(
   SELECT 1 FROM finnor_os.w5_dependency_pins p
   LEFT JOIN finnor_os.users a ON a.tenant_id=p.tenant_id AND a.id::text=p.source_id
   LEFT JOIN finnor_os.employee_actor_profiles profile ON profile.tenant_id=a.tenant_id AND profile.principal_id=a.id
   WHERE p.tenant_id=t AND p.request_id=q.id AND p.kind='ACTOR' AND(
    a.status IS DISTINCT FROM 'active' OR profile.actor_kind IS NULL OR
    encode(sha256(convert_to('{"actor_kind":'||to_jsonb(profile.actor_kind)::text||
     ',"id":'||to_jsonb(a.id::text)::text||',"status":'||to_jsonb(a.status)::text||
     ',"version":'||profile.version::text||'}','UTF8')),'hex') IS DISTINCT FROM p.digest))
  AND (SELECT count(*) FROM finnor_os.w5_dependency_pins p
   WHERE p.tenant_id=t AND p.request_id=q.id AND p.kind='S5_RESOURCE')=
   jsonb_array_length(q.budget->'resources')
  AND NOT EXISTS(
   SELECT 1 FROM finnor_os.w5_dependency_pins p
   LEFT JOIN finnor_os.s5_resource_heads h ON h.tenant_id=p.tenant_id AND h.resource_id=p.source_id
   LEFT JOIN finnor_os.s5_resources r ON r.tenant_id=h.tenant_id AND r.resource_id=h.resource_id AND r.revision=h.revision
   WHERE p.tenant_id=t AND p.request_id=q.id AND p.kind='S5_RESOURCE' AND(
    r.content_digest IS DISTINCT FROM p.digest OR coalesce(r.body->>'revoked','true')<>'false'
    OR (r.body->>'validUntil')::timestamptz<=clock_timestamp())),
  coalesce((SELECT jsonb_agg(jsonb_build_object('path',p.source_id,'digest',p.digest) ORDER BY p.source_id)
   FROM finnor_os.w5_dependency_pins p WHERE p.tenant_id=t AND p.request_id=q.id AND p.kind='METHOD'),'[]'::jsonb),
  EXISTS(SELECT 1 FROM finnor_os.jobs j WHERE j.tenant_id=t AND j.payload->>'requestId'=q.id::text
   AND j.type IN('compile_organization_transformation_v1','advance_organization_transformation_v1')
   AND j.status IN('queued','running')),o.terms_digest,o.alternative_id
 FROM finnor_os.w5_role_offers o JOIN finnor_os.w5_requests q
  ON q.tenant_id=o.tenant_id AND q.id=o.request_id AND q.principal_id=o.principal_id
 JOIN finnor_os.users recipient ON recipient.tenant_id=o.tenant_id AND recipient.id=o.participant_id AND recipient.status='active'
 JOIN finnor_os.users owner_actor ON owner_actor.tenant_id=q.tenant_id AND owner_actor.id=q.principal_id
  AND owner_actor.status='active' AND owner_actor.role='owner'
 JOIN finnor_os.works w ON w.tenant_id=q.tenant_id AND w.id=q.work_id
 JOIN finnor_os.work_inputs i ON i.tenant_id=q.tenant_id AND i.id=q.work_input_id AND i.work_id=q.work_id
 WHERE o.tenant_id=t AND o.request_id=p_request AND o.role_id=p_role AND o.participant_id=u
 FOR SHARE OF q,o,recipient,owner_actor,w,i;
END $$;
REVOKE ALL ON FUNCTION finnor_os.w5_participant_head(uuid,text) FROM PUBLIC;

CREATE TABLE finnor_os.w5_control_deliveries(
 tenant_id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,
 use_key text NOT NULL,process_id text NOT NULL,work_id uuid NOT NULL,
 control_id text NOT NULL,role_id text NOT NULL,recipient_id uuid NOT NULL,alternative_id text NOT NULL,
 terms_digest text NOT NULL,packet_ref jsonb NOT NULL,disclosure jsonb NOT NULL,disclosure_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id,use_key,control_id),
 FOREIGN KEY(tenant_id,request_id,use_key) REFERENCES finnor_os.w5_process_uses(tenant_id,request_id,use_key),
 FOREIGN KEY(tenant_id,request_id,role_id) REFERENCES finnor_os.w5_role_offers(tenant_id,request_id,role_id),
 FOREIGN KEY(tenant_id,recipient_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 CHECK(length(use_key) BETWEEN 1 AND 240 AND terms_digest ~ '^[a-f0-9]{64}$'
  AND disclosure_digest ~ '^[a-f0-9]{64}$' AND octet_length(disclosure::text)<=262144)
);
CREATE TABLE finnor_os.w5_control_reads(
 tenant_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,
 participant_id uuid NOT NULL,use_key text NOT NULL,control_id text NOT NULL,idempotency_key text NOT NULL,
 terms_digest text NOT NULL,packet_ref jsonb NOT NULL,disclosure_digest text NOT NULL,
 request_digest text NOT NULL,source_ref jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,request_id,participant_id,idempotency_key),
 UNIQUE(tenant_id,request_id,use_key,control_id,participant_id),
 FOREIGN KEY(tenant_id,request_id,use_key,control_id)
  REFERENCES finnor_os.w5_control_deliveries(tenant_id,request_id,use_key,control_id),
 FOREIGN KEY(tenant_id,participant_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(length(idempotency_key) BETWEEN 1 AND 160 AND request_digest ~ '^[a-f0-9]{64}$')
);
DO $$ DECLARE tab text;role_name text; BEGIN
 FOREACH tab IN ARRAY ARRAY['w5_control_deliveries','w5_control_reads'] LOOP
  EXECUTE format('CREATE TRIGGER w5_append_only BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.w5_immutable()',tab);
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY w5_owner_read ON finnor_os.%I FOR SELECT USING(
   tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',tab);
  FOREACH role_name IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO %I',tab,role_name);
   END IF;
  END LOOP;
 END LOOP;
 FOREACH role_name IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION finnor_os.w5_participant_head(uuid,text) TO %I',role_name);
  END IF;
 END LOOP;
END $$;
CREATE POLICY w5_owner_delivery_insert ON finnor_os.w5_control_deliveries FOR INSERT WITH CHECK(
 tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM finnor_os.w5_role_offers o WHERE o.tenant_id=w5_control_deliveries.tenant_id
  AND o.request_id=w5_control_deliveries.request_id AND o.role_id=w5_control_deliveries.role_id
  AND o.principal_id=w5_control_deliveries.principal_id AND o.participant_id=w5_control_deliveries.recipient_id
  AND o.alternative_id=w5_control_deliveries.alternative_id AND o.terms_digest=w5_control_deliveries.terms_digest
  AND o.revoked_at IS NULL AND o.expires_at>clock_timestamp()));
CREATE POLICY w5_recipient_delivery_read ON finnor_os.w5_control_deliveries FOR SELECT USING(
 tenant_id=finnor_os.request_tenant_id() AND recipient_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w5_self_control_read ON finnor_os.w5_control_reads FOR SELECT USING(
 tenant_id=finnor_os.request_tenant_id() AND participant_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w5_self_process_use_read ON finnor_os.w5_process_uses FOR SELECT USING(
 tenant_id=finnor_os.request_tenant_id() AND participant_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w5_native_process_use_insert ON finnor_os.w5_process_uses AS RESTRICTIVE FOR INSERT
 WITH CHECK(current_user='finnor_worker');
CREATE POLICY w5_self_control_read_insert ON finnor_os.w5_control_reads FOR INSERT WITH CHECK(
 tenant_id=finnor_os.request_tenant_id() AND participant_id=nullif(current_setting('app.user_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM finnor_os.w5_control_deliveries d
  JOIN finnor_os.w5_role_offers o ON o.tenant_id=d.tenant_id AND o.request_id=d.request_id AND o.role_id=d.role_id
  WHERE d.tenant_id=w5_control_reads.tenant_id AND d.request_id=w5_control_reads.request_id
   AND d.use_key=w5_control_reads.use_key AND d.control_id=w5_control_reads.control_id
   AND d.recipient_id=w5_control_reads.participant_id AND d.principal_id=w5_control_reads.principal_id
   AND d.packet_ref=w5_control_reads.packet_ref AND d.disclosure_digest=w5_control_reads.disclosure_digest
   AND d.terms_digest=w5_control_reads.terms_digest AND o.participant_id=d.recipient_id
   AND o.terms_digest=d.terms_digest AND o.revoked_at IS NULL AND o.expires_at>clock_timestamp()
   AND (SELECT a.decision FROM finnor_os.w5_adoption_decisions a WHERE a.tenant_id=o.tenant_id
    AND a.request_id=o.request_id AND a.role_id=o.role_id AND a.participant_id=o.participant_id
    ORDER BY a.created_at DESC,a.id DESC LIMIT 1)='ADOPT'
   AND EXISTS(SELECT 1 FROM finnor_os.w5_participant_head(d.request_id,d.role_id) h
    WHERE h.current_terms AND h.phase IN('TRIAL','ACTIVE'))));

-- Prospective task assignment is distinct from consent, source truth, S6
-- authorization, scientific admission and S7 monetary qualification.
CREATE TABLE finnor_os.w5_trials(
 tenant_id uuid NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,evaluator_id uuid NOT NULL,
 process_id text NOT NULL,idempotency_key text NOT NULL,request_digest text NOT NULL,
 trial_ref jsonb NOT NULL,body jsonb NOT NULL,body_digest text NOT NULL,registered_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id),UNIQUE(tenant_id,request_id,idempotency_key),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w5_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,evaluator_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(principal_id<>evaluator_id AND length(idempotency_key) BETWEEN 1 AND 160
  AND request_digest ~ '^[a-f0-9]{64}$' AND body_digest ~ '^[a-f0-9]{64}$'
  AND octet_length(body::text)<=2097152)
);
CREATE TABLE finnor_os.w5_trial_units(
 tenant_id uuid NOT NULL,trial_id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,evaluator_id uuid NOT NULL,
 original_performer_id uuid NOT NULL,transformed_performer_id uuid NOT NULL,
 unit_id uuid NOT NULL,work_id uuid NOT NULL,work_input_id uuid NOT NULL,work_input_digest text NOT NULL,
 body jsonb NOT NULL,registered_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,trial_id,unit_id),UNIQUE(tenant_id,work_id),UNIQUE(tenant_id,work_input_id),
 UNIQUE(tenant_id,trial_id,work_id,work_input_id),
 FOREIGN KEY(tenant_id,trial_id) REFERENCES finnor_os.w5_trials(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 CHECK(unit_id=work_input_id AND work_input_digest ~ '^[a-f0-9]{64}$' AND octet_length(body::text)<=8192)
);
CREATE TABLE finnor_os.w5_trial_assignments(
 tenant_id uuid NOT NULL,id uuid NOT NULL,trial_id uuid NOT NULL,request_id uuid NOT NULL,principal_id uuid NOT NULL,
 evaluator_id uuid NOT NULL,performer_id uuid NOT NULL,work_id uuid NOT NULL,work_input_id uuid NOT NULL,
 process_id text NOT NULL,arm text NOT NULL,assignment_ref jsonb NOT NULL,body jsonb NOT NULL,
 body_digest text NOT NULL,assigned_at timestamptz NOT NULL,job_id uuid NOT NULL,delivery_attempt_id uuid NOT NULL,
 claim_fence bigint NOT NULL,consumption_id text NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,work_id),UNIQUE(tenant_id,work_input_id),
 FOREIGN KEY(tenant_id,trial_id) REFERENCES finnor_os.w5_trials(tenant_id,id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w5_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 FOREIGN KEY(tenant_id,trial_id,work_id,work_input_id)
  REFERENCES finnor_os.w5_trial_units(tenant_id,trial_id,work_id,work_input_id),
 FOREIGN KEY(tenant_id,consumption_id) REFERENCES finnor_os.s5_consumptions(tenant_id,consumption_id),
 FOREIGN KEY(tenant_id,performer_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(claim_fence>0 AND arm IN('ORIGINAL','TRANSFORMED') AND body_digest ~ '^[a-f0-9]{64}$' AND octet_length(body::text)<=32768)
);
-- One original intent survives queued, failed, UNKNOWN and deleted jobs.
-- This is only a packet mailbox, never an effect or resource permission.
CREATE TABLE finnor_os.w5_trial_use_mailboxes(
 tenant_id uuid NOT NULL,assignment_id uuid NOT NULL,trial_id uuid NOT NULL,request_id uuid NOT NULL,
 principal_id uuid NOT NULL,evaluator_id uuid NOT NULL,performer_id uuid NOT NULL,
 work_id uuid NOT NULL,work_input_id uuid NOT NULL,process_id text NOT NULL,role_id text NOT NULL,
 idempotency_key text NOT NULL,intent_digest text NOT NULL,terms_digest text NOT NULL,
 packet_ref jsonb NOT NULL,job_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,assignment_id),UNIQUE(tenant_id,work_id),
 UNIQUE(tenant_id,request_id,performer_id,idempotency_key),
 FOREIGN KEY(tenant_id,assignment_id) REFERENCES finnor_os.w5_trial_assignments(tenant_id,id),
 FOREIGN KEY(tenant_id,trial_id) REFERENCES finnor_os.w5_trials(tenant_id,id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES finnor_os.w5_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id),
 CHECK(length(idempotency_key) BETWEEN 1 AND 160 AND intent_digest ~ '^[a-f0-9]{64}$'
  AND terms_digest ~ '^[a-f0-9]{64}$' AND octet_length(packet_ref::text)<=8192
  AND packet_ref ?& ARRAY['owner','id','version','contentDigest'] AND packet_ref->>'owner'='S1')
);
CREATE TABLE finnor_os.w5_trial_outcomes(
 tenant_id uuid NOT NULL,id uuid NOT NULL,trial_id uuid NOT NULL,assignment_id uuid NOT NULL,request_id uuid NOT NULL,
 principal_id uuid NOT NULL,evaluator_id uuid NOT NULL,work_id uuid NOT NULL,
 idempotency_key text NOT NULL,request_digest text NOT NULL,source_ref jsonb NOT NULL,
 body jsonb NOT NULL,body_digest text NOT NULL,observed_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,assignment_id),UNIQUE(tenant_id,request_id,evaluator_id,idempotency_key),
 FOREIGN KEY(tenant_id,trial_id) REFERENCES finnor_os.w5_trials(tenant_id,id),
 FOREIGN KEY(tenant_id,assignment_id) REFERENCES finnor_os.w5_trial_assignments(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 CHECK(length(idempotency_key) BETWEEN 1 AND 160 AND request_digest ~ '^[a-f0-9]{64}$'
  AND body_digest ~ '^[a-f0-9]{64}$' AND octet_length(body::text)<=65536)
);
DO $$ DECLARE tab text;role_name text; BEGIN
 FOREACH tab IN ARRAY ARRAY['w5_trials','w5_trial_units','w5_trial_assignments','w5_trial_use_mailboxes','w5_trial_outcomes'] LOOP
  EXECUTE format('CREATE TRIGGER w5_append_only BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.w5_immutable()',tab);
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY w5_trial_owner_or_evaluator_read ON finnor_os.%I FOR SELECT USING(
   tenant_id=finnor_os.request_tenant_id() AND nullif(current_setting(''app.user_id'',true),'''')::uuid IN(principal_id,evaluator_id))',tab);
  FOREACH role_name IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
    EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO %I',tab,role_name);
   END IF;
  END LOOP;
 END LOOP;
END $$;
CREATE POLICY w5_trial_original_owner_insert ON finnor_os.w5_trials FOR INSERT WITH CHECK(
 tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM finnor_os.w5_requests q WHERE q.tenant_id=w5_trials.tenant_id
  AND q.id=w5_trials.request_id AND q.principal_id=w5_trials.principal_id));
CREATE POLICY w5_trial_original_assignment_insert ON finnor_os.w5_trial_assignments FOR INSERT WITH CHECK(
 tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM finnor_os.w5_trials t WHERE t.tenant_id=w5_trial_assignments.tenant_id
  AND t.id=w5_trial_assignments.trial_id AND t.request_id=w5_trial_assignments.request_id
  AND t.principal_id=w5_trial_assignments.principal_id AND t.evaluator_id=w5_trial_assignments.evaluator_id));
CREATE POLICY w5_trial_native_entropy_insert ON finnor_os.w5_trial_assignments AS RESTRICTIVE FOR INSERT
 WITH CHECK(current_user='finnor_worker');
CREATE POLICY w5_trial_original_unit_insert ON finnor_os.w5_trial_units FOR INSERT WITH CHECK(
 tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM finnor_os.w5_trials t WHERE t.tenant_id=w5_trial_units.tenant_id
  AND t.id=w5_trial_units.trial_id AND t.request_id=w5_trial_units.request_id
  AND t.principal_id=w5_trial_units.principal_id AND t.evaluator_id=w5_trial_units.evaluator_id
  AND t.body->>'originalPrincipalId'=w5_trial_units.original_performer_id::text
  AND t.body->>'transformedPrincipalId'=w5_trial_units.transformed_performer_id::text)
 AND EXISTS(SELECT 1 FROM finnor_os.work_inputs i WHERE i.tenant_id=w5_trial_units.tenant_id
  AND i.id=w5_trial_units.work_input_id AND i.work_id=w5_trial_units.work_id));
CREATE POLICY w5_trial_potential_performer_unit_read ON finnor_os.w5_trial_units FOR SELECT USING(
 tenant_id=finnor_os.request_tenant_id()
 AND nullif(current_setting('app.user_id',true),'')::uuid IN(original_performer_id,transformed_performer_id));
CREATE POLICY w5_trial_self_assignment_read ON finnor_os.w5_trial_assignments FOR SELECT USING(
 tenant_id=finnor_os.request_tenant_id() AND performer_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w5_trial_self_mailbox_read ON finnor_os.w5_trial_use_mailboxes FOR SELECT USING(
 tenant_id=finnor_os.request_tenant_id() AND performer_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY w5_trial_exact_self_mailbox_insert ON finnor_os.w5_trial_use_mailboxes FOR INSERT WITH CHECK(
 tenant_id=finnor_os.request_tenant_id() AND performer_id=nullif(current_setting('app.user_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM finnor_os.w5_trial_assignments a
  JOIN finnor_os.evidence_source_versions v ON v.tenant_id=a.tenant_id
   AND v.id::text=w5_trial_use_mailboxes.packet_ref->>'id'
  JOIN finnor_os.evidence_sources s ON s.tenant_id=v.tenant_id AND s.id=v.source_id
  WHERE a.tenant_id=w5_trial_use_mailboxes.tenant_id AND a.id=w5_trial_use_mailboxes.assignment_id
   AND a.trial_id=w5_trial_use_mailboxes.trial_id AND a.request_id=w5_trial_use_mailboxes.request_id
   AND a.principal_id=w5_trial_use_mailboxes.principal_id AND a.evaluator_id=w5_trial_use_mailboxes.evaluator_id
   AND a.performer_id=w5_trial_use_mailboxes.performer_id AND a.arm='TRANSFORMED'
   AND a.work_id=w5_trial_use_mailboxes.work_id AND a.work_input_id=w5_trial_use_mailboxes.work_input_id
   AND a.process_id=w5_trial_use_mailboxes.process_id AND a.body->>'performerRoleId'=w5_trial_use_mailboxes.role_id
   AND v.scope='tenant' AND v.content_hash=w5_trial_use_mailboxes.packet_ref->>'contentDigest'
   AND v.version_number::text=w5_trial_use_mailboxes.packet_ref->>'version'
   AND s.source_type='organization_authenticated_record'
   AND s.metadata->>'authenticatedPrincipal'=a.performer_id::text AND s.metadata->>'workId'=a.work_id::text
   AND v.content::jsonb->>'schema'='finnor.organization-prepared-packet.v1'
   AND v.content::jsonb->>'requestId'=a.request_id::text AND v.content::jsonb->>'workId'=a.work_id::text
   AND v.content::jsonb->>'processId'=a.process_id AND v.content::jsonb->>'roleId'=w5_trial_use_mailboxes.role_id
   AND v.content::jsonb->>'authenticatedPrincipalId'=a.performer_id::text
   AND v.content::jsonb->>'exactTermsDigest'=w5_trial_use_mailboxes.terms_digest
   AND v.content::jsonb->>'idempotencyKey'=w5_trial_use_mailboxes.idempotency_key
   AND v.content::jsonb->'trialAssignmentRef'=a.assignment_ref));
CREATE POLICY w5_trial_independent_outcome_insert ON finnor_os.w5_trial_outcomes FOR INSERT WITH CHECK(
 tenant_id=finnor_os.request_tenant_id() AND evaluator_id=nullif(current_setting('app.user_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM finnor_os.w5_trial_assignments a WHERE a.tenant_id=w5_trial_outcomes.tenant_id
  AND a.id=w5_trial_outcomes.assignment_id AND a.trial_id=w5_trial_outcomes.trial_id
  AND a.request_id=w5_trial_outcomes.request_id AND a.principal_id=w5_trial_outcomes.principal_id
  AND a.evaluator_id=w5_trial_outcomes.evaluator_id AND a.work_id=w5_trial_outcomes.work_id));

-- Independent measurement needs all uses of its exact registered Work,
-- including cross-arm contamination, not access to private parent graphs.
CREATE FUNCTION finnor_os.w5_trial_evaluator_uses(p_assignment uuid)
 RETURNS TABLE(use_key text,request_id uuid,work_id uuid,process_id text,participant_id uuid,
  role_id text,source_ref jsonb,created_at timestamptz)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT u.use_key,u.request_id,u.work_id,u.process_id,u.participant_id,u.role_id,u.source_ref,u.created_at
 FROM finnor_os.w5_trial_assignments a JOIN finnor_os.users evaluator
  ON evaluator.tenant_id=a.tenant_id AND evaluator.id=a.evaluator_id AND evaluator.status='active'
 JOIN finnor_os.w5_process_uses u ON u.tenant_id=a.tenant_id AND u.work_id=a.work_id
 WHERE a.tenant_id=finnor_os.request_tenant_id() AND a.id=p_assignment
  AND a.evaluator_id=nullif(current_setting('app.user_id',true),'')::uuid
 ORDER BY u.created_at,u.use_key LIMIT 1025
$$;
REVOKE ALL ON FUNCTION finnor_os.w5_trial_evaluator_uses(uuid) FROM PUBLIC;

-- Pristine enrollment and entropy need all original Work uses, not only the
-- caller's RLS-visible programme or an extant source/job proxy. The caller
-- checks canonical Work authority before invoking this conflict-only port.
CREATE FUNCTION finnor_os.w5_trial_units_have_use(p_works uuid[])
 RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT CASE WHEN array_ndims(p_works) IS DISTINCT FROM 1
  OR cardinality(p_works) NOT BETWEEN 1 AND 512
 THEN true WHEN array_position(p_works,NULL) IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM finnor_os.users actor
   WHERE actor.tenant_id=finnor_os.request_tenant_id()
    AND actor.id=nullif(current_setting('app.user_id',true),'')::uuid AND actor.status='active')
 THEN true ELSE EXISTS(SELECT 1 FROM finnor_os.w5_process_uses u
  WHERE u.tenant_id=finnor_os.request_tenant_id() AND u.work_id=ANY(p_works)) END
$$;
REVOKE ALL ON FUNCTION finnor_os.w5_trial_units_have_use(uuid[]) FROM PUBLIC;

-- Absence under self RLS is not permission to reuse someone else's unit.
-- This predicate exposes no trial, assignment, actor or private graph.
CREATE FUNCTION finnor_os.w5_trial_unit_reserved(p_work uuid)
 RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT EXISTS(SELECT 1 FROM finnor_os.w5_trial_units unit
  WHERE unit.tenant_id=finnor_os.request_tenant_id() AND unit.work_id=p_work)
 AND EXISTS(SELECT 1 FROM finnor_os.users actor WHERE actor.tenant_id=finnor_os.request_tenant_id()
  AND actor.id=nullif(current_setting('app.user_id',true),'')::uuid AND actor.status='active')
$$;
REVOKE ALL ON FUNCTION finnor_os.w5_trial_unit_reserved(uuid) FROM PUBLIC;

CREATE INDEX w5_process_uses_original_work_idx ON finnor_os.w5_process_uses(tenant_id,work_id);
-- At most two uses are enough to reject duplication. The caller receives only
-- a conflict bit, not another programme's actor, key, packet or parent graph.
CREATE FUNCTION finnor_os.w5_trial_mailbox_conflict(p_assignment uuid)
 RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT coalesce((SELECT (SELECT count(*)>1 OR coalesce(bool_or(
   m.assignment_id IS NULL OR u.request_id IS DISTINCT FROM a.request_id
   OR u.use_key IS DISTINCT FROM (m.performer_id::text||':'||m.idempotency_key)
   OR u.process_id IS DISTINCT FROM a.process_id OR u.participant_id IS DISTINCT FROM a.performer_id
   OR u.role_id IS DISTINCT FROM m.role_id OR u.source_ref IS DISTINCT FROM m.packet_ref
   OR u.result->'trialAssignmentRef' IS DISTINCT FROM a.assignment_ref OR u.created_at<a.assigned_at),false)
  FROM LATERAL(SELECT use_row.* FROM finnor_os.w5_process_uses use_row
   WHERE use_row.tenant_id=a.tenant_id AND use_row.work_id=a.work_id LIMIT 2) u)
 FROM finnor_os.w5_trial_assignments a JOIN finnor_os.users actor
  ON actor.tenant_id=a.tenant_id AND actor.id=nullif(current_setting('app.user_id',true),'')::uuid
   AND actor.status='active' AND actor.id IN(a.principal_id,a.performer_id)
 LEFT JOIN finnor_os.w5_trial_use_mailboxes m ON m.tenant_id=a.tenant_id AND m.assignment_id=a.id
 WHERE a.tenant_id=finnor_os.request_tenant_id() AND a.id=p_assignment),true)
$$;
REVOKE ALL ON FUNCTION finnor_os.w5_trial_mailbox_conflict(uuid) FROM PUBLIC;

-- The exact original owner needs contamination from all of its registered
-- Work units, including another programme's otherwise RLS-hidden uses.
CREATE FUNCTION finnor_os.w5_trial_owner_uses(p_trial uuid)
 RETURNS TABLE(use_key text,request_id uuid,work_id uuid,process_id text,participant_id uuid,
  role_id text,source_ref jsonb,created_at timestamptz)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT u.use_key,u.request_id,u.work_id,u.process_id,u.participant_id,u.role_id,u.source_ref,u.created_at
 FROM finnor_os.w5_trials t JOIN finnor_os.users actor
  ON actor.tenant_id=t.tenant_id AND actor.id=t.principal_id AND actor.status='active' AND actor.role='owner'
 JOIN finnor_os.w5_trial_units unit ON unit.tenant_id=t.tenant_id AND unit.trial_id=t.id
 JOIN finnor_os.w5_process_uses u ON u.tenant_id=unit.tenant_id AND u.work_id=unit.work_id
 WHERE t.tenant_id=finnor_os.request_tenant_id() AND t.id=p_trial
  AND t.principal_id=nullif(current_setting('app.user_id',true),'')::uuid
 ORDER BY u.created_at,u.use_key LIMIT 1025
$$;
REVOKE ALL ON FUNCTION finnor_os.w5_trial_owner_uses(uuid) FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION finnor_os.w5_trial_evaluator_uses(uuid) TO %I',r);
   EXECUTE format('GRANT EXECUTE ON FUNCTION finnor_os.w5_trial_units_have_use(uuid[]) TO %I',r);
   EXECUTE format('GRANT EXECUTE ON FUNCTION finnor_os.w5_trial_unit_reserved(uuid) TO %I',r);
   EXECUTE format('GRANT EXECUTE ON FUNCTION finnor_os.w5_trial_mailbox_conflict(uuid) TO %I',r);
   EXECUTE format('GRANT EXECUTE ON FUNCTION finnor_os.w5_trial_owner_uses(uuid) TO %I',r);
  END IF;
 END LOOP;
END $$;
