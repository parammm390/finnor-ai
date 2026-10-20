-- Subject scope is certified from original records by the source owner. Legacy
-- sensitive grants remain intact but unreadable until their owner certifies them.
ALTER TABLE finnor_os.x1_source_grants ADD COLUMN expected_subject_registrations jsonb
 CHECK(expected_subject_registrations IS NULL OR (jsonb_typeof(expected_subject_registrations)='array'
  AND jsonb_array_length(expected_subject_registrations)<=200));

CREATE FUNCTION finnor_os.x1_register_owned_core_source_v2(w uuid,document uuid,version_id uuid,source_class text,
 protocol text,purpose text,original_hash text,object_ids jsonb,subjects jsonb,expiry timestamptz,decision uuid)
RETURNS finnor_os.x1_source_grants LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 institution text; mandate_expiry timestamptz; source_key text; version_key text; version_number integer;
 prior finnor_os.x1_source_grants; result finnor_os.x1_source_grants;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text,5510));
 PERFORM finnor_os.x1_assert_input_decision(w,document,decision);
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':'||w::text,5511));
 SELECT m.institution_id,m.expires_at INTO institution,mandate_expiry FROM finnor_os.x1_work_mandates m
  WHERE m.tenant_id=t AND m.work_id=w AND m.principal_id=u AND m.revoked_at IS NULL
   AND m.valid_from<=clock_timestamp() AND m.expires_at>clock_timestamp() ORDER BY m.created_at DESC,m.id DESC LIMIT 1 FOR SHARE;
 IF NOT FOUND OR expiry<=clock_timestamp() OR expiry>mandate_expiry THEN RAISE EXCEPTION 'X1_CURRENT_MANDATE_SOURCE_WINDOW_REQUIRED'; END IF;
 SELECT coalesce(nullif(btrim(d.external_id),''),'core-document:'||d.id::text),coalesce(v.provider_version_id,v.id::text)
  INTO source_key,version_key FROM finnor_os.documents d JOIN finnor_os.document_versions v
   ON v.tenant_id=d.tenant_id AND v.document_id=d.id JOIN finnor_os.document_version_contents c
   ON c.tenant_id=v.tenant_id AND c.version_id=v.id WHERE d.tenant_id=t AND d.id=document AND v.id=x1_register_owned_core_source_v2.version_id
    AND d.created_by=u::text AND v.created_by=u::text AND v.byte_sha256=original_hash AND c.sha256=original_hash
    AND c.storage_backend='postgres' AND c.size_bytes=v.size_bytes AND octet_length(c.bytes)=v.size_bytes
    AND v.size_bytes BETWEEN 1 AND 6291456 AND encode(public.digest(c.bytes,'sha256'),'hex')=original_hash
  FOR SHARE OF d,v,c;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1_INPUT_OWNED_CORE_ORIGINAL_REQUIRED'; END IF;
 IF object_ids IS NULL OR jsonb_typeof(object_ids)<>'array' OR jsonb_array_length(object_ids) NOT BETWEEN 1 AND 1000
   OR octet_length(object_ids::text)>65536 OR EXISTS(SELECT 1 FROM jsonb_array_elements(object_ids) x
    WHERE jsonb_typeof(x)<>'string' OR btrim(x#>>'{}')='')
   OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(object_ids))<>jsonb_array_length(object_ids)
   OR coalesce(btrim(purpose),'')='' OR length(purpose)>2000 THEN RAISE EXCEPTION 'X1_INPUT_ORIGINAL_OBJECT_IDENTITY_REQUIRED'; END IF;
 IF subjects IS NULL OR jsonb_typeof(subjects)<>'array' OR jsonb_array_length(subjects)>200
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(subjects) x WHERE jsonb_typeof(x)<>'string' OR btrim(x#>>'{}')='')
   OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(subjects))<>jsonb_array_length(subjects)
   OR (source_class NOT IN('personnel_benefits','expense_administration') AND subjects<>'[]'::jsonb)
   OR (source_class IN('personnel_benefits','expense_administration') AND jsonb_array_length(subjects)=0) THEN
  RAISE EXCEPTION 'X1_COMPLETE_SENSITIVE_SUBJECT_CERTIFICATION_REQUIRED';
 END IF;
 IF source_class IN('personnel_benefits','expense_administration') THEN
  PERFORM 1 FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.users person
   ON person.tenant_id=b.tenant_id AND person.id=b.subject_user_id WHERE b.tenant_id=t AND b.institution_id=institution
    AND b.source_id=source_key AND subjects ? b.registration_id AND b.revoked_at IS NULL
    AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp() AND person.status='active'
    FOR SHARE OF b,person;
  IF (SELECT count(*) FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.users person
   ON person.tenant_id=b.tenant_id AND person.id=b.subject_user_id WHERE b.tenant_id=t AND b.institution_id=institution
    AND b.source_id=source_key AND subjects ? b.registration_id AND b.revoked_at IS NULL
    AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp() AND person.status='active')
    <>jsonb_array_length(subjects) THEN RAISE EXCEPTION 'X1_CURRENT_SENSITIVE_IDENTITY_OWNER_REQUIRED'; END IF;
 END IF;
 SELECT * INTO prior FROM finnor_os.x1_source_grants g WHERE g.tenant_id=t AND g.principal_id=u AND g.work_id=w
  AND g.source_id=source_key ORDER BY g.version DESC LIMIT 1 FOR UPDATE;
 IF FOUND AND prior.document_id<>document THEN RAISE EXCEPTION 'X1_SOURCE_NAMESPACE_COLLISION'; END IF;
 IF prior.document_version_id=version_id AND prior.source_class=source_class AND prior.protocol=protocol AND prior.purpose=purpose
   AND prior.expected_object_ids=object_ids AND prior.expected_subject_registrations=subjects AND prior.expires_at=expiry AND prior.revoked_at IS NULL THEN RETURN prior; END IF;
 version_number:=coalesce(prior.version,0)+1;
 INSERT INTO finnor_os.x1_source_grants(tenant_id,principal_id,work_id,institution_id,source_id,source_class,purpose,
   acquisition_kind,document_id,document_version_id,protocol,revision,original_sha256,expected_object_ids,expected_subject_registrations,version,valid_from,expires_at)
  VALUES(t,u,w,institution,source_key,source_class,purpose,'core_export',document,version_id,protocol,version_key,
    original_hash,object_ids,subjects,version_number,clock_timestamp(),expiry) RETURNING * INTO result;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION finnor_os.x1_register_owned_core_source_v2(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.x1_register_owned_core_source_v2(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb,timestamptz,uuid) TO finnor_app,finnor_worker;

-- Returns authority metadata only. It cannot return original bytes or permission
-- from a candidate. Byte readers hold x1_lock_source_authority for their read.
CREATE FUNCTION finnor_os.x1_source_scope(w uuid,grant_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 g finnor_os.x1_source_grants; subjects jsonb; state jsonb; gap text; allowed boolean;
BEGIN
 PERFORM 1 FROM finnor_os.works work JOIN finnor_os.users actor ON actor.tenant_id=work.tenant_id AND actor.id=work.created_by
  WHERE work.tenant_id=t AND work.id=w AND work.created_by=u AND actor.status='active' AND actor.role='owner';
 IF NOT FOUND THEN RAISE EXCEPTION 'X1_CURRENT_WORK_INPUT_OWNER_REQUIRED'; END IF;
 SELECT * INTO g FROM finnor_os.x1_source_grants WHERE tenant_id=t AND principal_id=u AND work_id=w AND id=grant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1_SOURCE_METADATA_SCOPE_REQUIRED'; END IF;
 gap:=CASE WHEN g.revoked_at IS NOT NULL THEN 'SOURCE_GRANT_REVOKED'
  WHEN g.valid_from>clock_timestamp() OR g.expires_at<=clock_timestamp() THEN 'SOURCE_GRANT_WINDOW_UNAVAILABLE'
  WHEN EXISTS(SELECT 1 FROM finnor_os.x1_source_grants n WHERE n.tenant_id=t AND n.principal_id=u AND n.work_id=w
   AND n.source_id=g.source_id AND n.version>g.version) THEN 'SOURCE_GRANT_SUPERSEDED' ELSE NULL END;
 subjects:='[]'::jsonb;
 IF g.source_class IN('personnel_benefits','expense_administration') THEN
  IF g.expected_subject_registrations IS NULL OR jsonb_array_length(g.expected_subject_registrations)=0 THEN
   gap:=coalesce(gap,'SUBJECT_SCOPE_NOT_CERTIFIED');
  ELSE
   SELECT coalesce(jsonb_agg(jsonb_build_object('registrationId',r.registration,'bindingId',b.id,'bindingRevision',b.revision,
     'subjectId',b.subject_user_id,'bindingCurrent',coalesce(b.revoked_at IS NULL AND b.valid_from<=clock_timestamp()
       AND b.expires_at>clock_timestamp(),false),'subjectActive',coalesce(person.status='active',false),
     'consentId',co.id,'consentRevision',co.revision,'consentCurrent',coalesce(co.revoked_at IS NULL
       AND co.granted_at<=clock_timestamp() AND co.expires_at>clock_timestamp(),false)) ORDER BY r.registration),'[]'::jsonb)
    INTO subjects FROM jsonb_array_elements_text(g.expected_subject_registrations) r(registration)
    LEFT JOIN finnor_os.x1_subject_identity_bindings b ON b.tenant_id=t AND b.institution_id=g.institution_id
      AND b.source_id=g.source_id AND b.registration_id=r.registration
    LEFT JOIN finnor_os.users person ON person.tenant_id=b.tenant_id AND person.id=b.subject_user_id
    LEFT JOIN finnor_os.x1_subject_consents co ON co.tenant_id=b.tenant_id AND co.subject_user_id=b.subject_user_id
      AND co.institution_id=g.institution_id AND co.source_class=g.source_class AND co.purpose=g.purpose;
   IF jsonb_array_length(subjects)<>jsonb_array_length(g.expected_subject_registrations)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(subjects) x WHERE x->'bindingId'='null'::jsonb
      OR x->'consentId'='null'::jsonb OR x->'bindingCurrent'<>'true'::jsonb
      OR x->'subjectActive'<>'true'::jsonb OR x->'consentCurrent'<>'true'::jsonb) THEN
    gap:=coalesce(gap,'SENSITIVE_SUBJECT_CONSENT_OR_IDENTITY_UNAVAILABLE');
   END IF;
  END IF;
 END IF;
 allowed:=gap IS NULL;
 state:=jsonb_build_object('schema','finnor.x1.source-scope.v1','grantId',g.id,'workId',w,'principalId',u,
  'sourceId',g.source_id,'sourceClass',g.source_class,'institutionId',g.institution_id,'purpose',g.purpose,
  'grantVersion',g.version,'sourceRevision',g.revision,'originalSha256',g.original_sha256,
  'expectedObjectIds',g.expected_object_ids,'expectedSubjectRegistrations',g.expected_subject_registrations,
  'subjects',subjects,'originalReadAllowed',allowed,'gap',gap,'executionAuthorityGranted',false);
 RETURN jsonb_build_object('body',state,'digest',encode(sha256(convert_to(state::text,'UTF8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION finnor_os.x1_source_scope(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.x1_source_scope(uuid,uuid) TO finnor_app,finnor_worker;

CREATE FUNCTION finnor_os.x1_assert_source_scopes(w uuid,pins jsonb,grant_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE p jsonb; actual jsonb;
BEGIN
 IF pins IS NULL OR jsonb_typeof(pins)<>'array' OR jsonb_array_length(pins) NOT BETWEEN 1 AND 16
  OR grant_ids IS NULL OR cardinality(grant_ids)<>jsonb_array_length(pins)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(pins) x WHERE jsonb_typeof(x)<>'object'
    OR coalesce(x->>'digest','')!~'^[a-f0-9]{64}$' OR coalesce(x->>'grantId','')!~'^[a-f0-9-]{36}$'
    OR jsonb_typeof(x->'originalReadAllowed') IS DISTINCT FROM 'boolean')
  OR (SELECT count(DISTINCT x->>'grantId') FROM jsonb_array_elements(pins) x)<>cardinality(grant_ids)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(pins) x WHERE NOT (x->>'grantId')::uuid=ANY(grant_ids))
 THEN RAISE EXCEPTION 'X1_CURRENT_SOURCE_SCOPES_REQUIRED'; END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(pins) LOOP
  actual:=finnor_os.x1_source_scope(w,(p->>'grantId')::uuid);
  IF actual->>'digest' IS DISTINCT FROM p->>'digest' OR actual->'body'->'originalReadAllowed'
    IS DISTINCT FROM p->'originalReadAllowed' THEN RAISE EXCEPTION 'X1_SOURCE_SCOPE_CHANGED'; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION finnor_os.x1_assert_source_scopes(uuid,jsonb,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.x1_assert_source_scopes(uuid,jsonb,uuid[]) TO finnor_app,finnor_worker;

-- Final mutation revalidates the complete native source-scope population. A
-- metadata gap cannot supply a mapping or duty; old unpinned readers are fenced.
CREATE OR REPLACE FUNCTION finnor_os.x1_assert_effect_current(p_action uuid,p_method text DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 a record; p record; x record; e record; node jsonb; grant_row record; rights text; subject jsonb; subject_count integer;
BEGIN
 SELECT * INTO a FROM finnor_os.domain_actions WHERE tenant_id=t AND id=p_action;
 IF a IS NULL OR a.authority_context->>'kind' IS DISTINCT FROM 'institution_duty' THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||t::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text,5510));
 IF u IS NULL OR a.initiated_by IS DISTINCT FROM u OR a.work_id IS NULL
  OR a.action_type NOT IN('create_deal_request','open_workstream','record_finding')
  OR EXISTS(SELECT 1 FROM finnor_os.s6_obligation_origins WHERE tenant_id=t AND domain_action_id=a.id)
 THEN RAISE EXCEPTION 'X1 ordinary effect scope or governed origin changed'; END IF;
 SELECT * INTO p FROM finnor_os.p1_requests WHERE tenant_id=t AND principal_id=u
  AND id=(a.authority_context->>'programId')::uuid AND work_id=a.work_id FOR SHARE;
 IF p IS NULL OR p.request->>'kind'<>'institution_responsibility_v1'
  OR p.status NOT IN('RUNNING','WAITING','PARTIAL') OR a.status<>'executing'
  OR p.work_input_id IS DISTINCT FROM (SELECT id FROM finnor_os.work_inputs
    WHERE tenant_id=t AND work_id=a.work_id ORDER BY created_at DESC,id DESC LIMIT 1)
  OR NOT EXISTS(SELECT 1 FROM finnor_os.work_plan_revisions WHERE tenant_id=t
    AND id=p.plan_revision_id AND work_input_id=p.work_input_id AND status='active')
 THEN RAISE EXCEPTION 'X1 programme, Work or active plan changed'; END IF;
 SELECT n INTO node FROM jsonb_array_elements(p.proposed->'nodes') n
  WHERE n->>'stableIdentity'=a.authority_context->>'stableIdentity'
   AND n->'action'->>'expectedEntityId'=a.id::text;
 IF node IS NULL OR node->>'operation'<>a.action_type
  OR (node->>'deadlineAt')::timestamptz<=clock_timestamp()
  OR (p.proposed->'bounds'->>'deadlineAt')::timestamptz<=clock_timestamp()
  OR (a.payload-'workId'-'grounding') IS DISTINCT FROM node->'action'->'payload'
  OR a.payload->>'workId' IS DISTINCT FROM a.work_id::text
  OR a.payload->'grounding'->'work'->>'entityId' IS DISTINCT FROM a.work_id::text
  OR a.payload->'grounding'->'deal'->>'entityId' IS DISTINCT FROM a.payload->>'dealId'
 THEN RAISE EXCEPTION 'X1 frozen ordinary intent or original deadline changed'; END IF;
 PERFORM 1 FROM finnor_os.users WHERE tenant_id=t AND id=u AND role='owner' AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1 current principal is unavailable'; END IF;
 PERFORM 1 FROM finnor_os.users WHERE tenant_id=t
  AND id=(node->'action'->'payload'->'owner'->>'partyId')::uuid AND status='active' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1 responsible employee was revoked'; END IF;
 SELECT revision::text INTO rights FROM finnor_os.authority_states WHERE tenant_id=t FOR SHARE;
 PERFORM finnor_os.x1_lock_source_authority(a.work_id,
  ARRAY(SELECT (value->>'grantId')::uuid FROM jsonb_array_elements(p.request->'institution'->'programme'->'sourceScopes')));
 PERFORM finnor_os.x1_assert_source_scopes(a.work_id,p.request->'institution'->'programme'->'sourceScopes',
  ARRAY(SELECT (value->>'grantId')::uuid FROM jsonb_array_elements(p.request->'institution'->'programme'->'sourceScopes')));
 IF p.request->'institution'->>'compilerRequestId' IS NOT NULL THEN
  SELECT * INTO x FROM finnor_os.x1_compiler_requests WHERE tenant_id=t AND principal_id=u
   AND id=(p.request->'institution'->>'compilerRequestId')::uuid AND work_id=a.work_id FOR SHARE;
  IF x IS NULL OR x.status NOT IN('RUNNING','WAITING','PARTIAL')
   OR x.work_input_id<>p.work_input_id
   OR x.input_manifest->'current'->>'rightsRevision' IS DISTINCT FROM rights
   OR p_method IS NULL OR x.input_manifest->'current'->>'methodRevision' IS DISTINCT FROM p_method
   OR x.admission_id IS NULL THEN RAISE EXCEPTION 'X1 compiler continuation was fenced'; END IF;
  PERFORM finnor_os.x1_assert_canonical_owner_cut(x.input_manifest->'current'->'canonicalOwners',true);
  SELECT * INTO e FROM finnor_os.x1_compiler_episodes WHERE tenant_id=t AND principal_id=u AND id=x.episode_id FOR SHARE;
  IF e IS NULL OR e.wall_deadline<=clock_timestamp()
   OR e.parent_reservation IS DISTINCT FROM p.request->'institution'->'reservationRef'
  THEN RAISE EXCEPTION 'X1 original parent envelope expired or changed'; END IF;
  IF (SELECT count(*) FROM finnor_os.x1_source_grants WHERE tenant_id=t AND principal_id=u AND work_id=a.work_id AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(x.grant_ids)))<>jsonb_array_length(x.grant_ids) THEN RAISE EXCEPTION 'X1 source population changed'; END IF;
  PERFORM finnor_os.x1_assert_source_scopes(a.work_id,x.input_manifest->'current'->'sourceScopes',
   ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(x.grant_ids)));
  FOR grant_row IN SELECT * FROM finnor_os.x1_source_grants g
   WHERE g.tenant_id=t AND g.principal_id=u AND g.work_id=a.work_id
    AND g.id IN(SELECT value::uuid FROM jsonb_array_elements_text(x.grant_ids)) FOR SHARE OF g LOOP
   IF x.input_manifest->'current'->'sourceRevisions'->>grant_row.source_id IS DISTINCT FROM grant_row.revision
    OR EXISTS(SELECT 1 FROM finnor_os.x1_source_grants newer WHERE newer.tenant_id=t
      AND newer.principal_id=u AND newer.work_id=a.work_id AND newer.source_id=grant_row.source_id AND newer.version>grant_row.version)
   THEN RAISE EXCEPTION 'X1 source grant changed before canonical mutation'; END IF;
  END LOOP;
  FOR subject IN SELECT value FROM jsonb_array_elements(coalesce(x.input_manifest->'current'->'sensitiveSubjects','[]'::jsonb)) LOOP
   PERFORM 1 FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.x1_subject_consents co
    ON co.tenant_id=b.tenant_id AND co.subject_user_id=b.subject_user_id AND co.institution_id=b.institution_id
    AND co.source_class=subject->>'sourceClass' AND co.purpose=subject->>'purpose'
    JOIN finnor_os.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
    WHERE b.tenant_id=t AND b.institution_id=subject->>'institutionId' AND b.source_id=subject->>'sourceId'
     AND b.registration_id IN(SELECT value FROM jsonb_array_elements_text(subject->'registrations'))
     AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()
     AND co.revoked_at IS NULL AND co.granted_at<=clock_timestamp() AND co.expires_at>clock_timestamp()
     AND u.status='active' FOR SHARE OF b,co,u;
   GET DIAGNOSTICS subject_count = ROW_COUNT;
   IF subject_count<>jsonb_array_length(subject->'registrations') THEN RAISE EXCEPTION 'X1 consent or subject identity changed before mutation'; END IF;
  END LOOP;
  PERFORM 1 FROM finnor_os.x1_work_mandates m WHERE m.tenant_id=t AND m.principal_id=u AND m.work_id=a.work_id
   AND m.revoked_at IS NULL AND m.valid_from<=clock_timestamp() AND m.expires_at>clock_timestamp()
   AND m.revision=x.input_manifest->'current'->>'mandateRevision' FOR SHARE OF m;
  IF NOT FOUND THEN RAISE EXCEPTION 'X1 standing mandate changed before canonical mutation'; END IF;
 END IF;
 PERFORM 1 FROM finnor_os.s5_reservations r JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
  WHERE r.tenant_id=t AND o.principal_id=u AND r.reservation_id=p.request->'institution'->'reservationRef'->>'id'
   AND r.status<>'RELEASED' AND r.revocation_reason IS NULL
   FOR SHARE OF r,o;
 IF NOT FOUND THEN RAISE EXCEPTION 'X1 original S5 reservation changed before canonical mutation'; END IF;
 PERFORM finnor_os.s5_assert_institution_current(p.request->'institution'->'reservationRef'->>'id',NULL);
END $$;
