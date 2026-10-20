-- An owned-original read right narrows a source; it cannot change an established
-- source class or replace installed transport under an existing source identity.
-- Apply the same boundary to the retained writer as the current one.
CREATE OR REPLACE FUNCTION finnor_os.x1_register_owned_core_source(w uuid,document uuid,version_id uuid,source_class text,
 protocol text,purpose text,original_hash text,object_ids jsonb,expiry timestamptz,decision uuid)
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
 -- An established document class also survives a Work or source-label change.
 -- This metadata check precedes any original-content hashing/parsing.
 IF EXISTS(SELECT 1 FROM finnor_os.x1_source_grants g WHERE g.tenant_id=t AND g.document_id=document
  AND g.source_class IS DISTINCT FROM x1_register_owned_core_source.source_class) THEN
  RAISE EXCEPTION 'X1_SOURCE_NAMESPACE_CLASS_RECLASSIFICATION_DENIED'; END IF;
 SELECT coalesce(nullif(btrim(d.external_id),''),'core-document:'||d.id::text),coalesce(v.provider_version_id,v.id::text)
  INTO source_key,version_key FROM finnor_os.documents d JOIN finnor_os.document_versions v
   ON v.tenant_id=d.tenant_id AND v.document_id=d.id JOIN finnor_os.document_version_contents c
   ON c.tenant_id=v.tenant_id AND c.version_id=v.id WHERE d.tenant_id=t AND d.id=document AND v.id=x1_register_owned_core_source.version_id
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
 SELECT * INTO prior FROM finnor_os.x1_source_grants g WHERE g.tenant_id=t AND g.principal_id=u AND g.work_id=w
  AND g.source_id=source_key ORDER BY g.version DESC LIMIT 1 FOR UPDATE;
 IF FOUND AND prior.source_class IS DISTINCT FROM source_class THEN
  RAISE EXCEPTION 'X1_SOURCE_NAMESPACE_CLASS_RECLASSIFICATION_DENIED'; END IF;
 IF prior.id IS NOT NULL AND (prior.acquisition_kind IS DISTINCT FROM 'core_export'
  OR prior.document_id IS DISTINCT FROM document) THEN
  RAISE EXCEPTION 'X1_SOURCE_NAMESPACE_TRANSPORT_REPLACEMENT_DENIED'; END IF;
 IF FOUND AND prior.document_id<>document THEN RAISE EXCEPTION 'X1_SOURCE_NAMESPACE_COLLISION'; END IF;
 IF prior.document_version_id=version_id AND prior.source_class=source_class AND prior.protocol=protocol AND prior.purpose=purpose
   AND prior.expected_object_ids=object_ids AND prior.expires_at=expiry AND prior.revoked_at IS NULL THEN RETURN prior; END IF;
 version_number:=coalesce(prior.version,0)+1;
 INSERT INTO finnor_os.x1_source_grants(tenant_id,principal_id,work_id,institution_id,source_id,source_class,purpose,
   acquisition_kind,document_id,document_version_id,protocol,revision,original_sha256,expected_object_ids,version,valid_from,expires_at)
  VALUES(t,u,w,institution,source_key,source_class,purpose,'core_export',document,version_id,protocol,version_key,
    original_hash,object_ids,version_number,clock_timestamp(),expiry) RETURNING * INTO result;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.x1_register_owned_core_source_v2(w uuid,document uuid,version_id uuid,source_class text,
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
 -- An established document class also survives a Work or source-label change.
 -- This metadata check precedes any original-content hashing/parsing.
 IF EXISTS(SELECT 1 FROM finnor_os.x1_source_grants g WHERE g.tenant_id=t AND g.document_id=document
  AND g.source_class IS DISTINCT FROM x1_register_owned_core_source_v2.source_class) THEN
  RAISE EXCEPTION 'X1_SOURCE_NAMESPACE_CLASS_RECLASSIFICATION_DENIED'; END IF;
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
 IF FOUND AND prior.source_class IS DISTINCT FROM source_class THEN
  RAISE EXCEPTION 'X1_SOURCE_NAMESPACE_CLASS_RECLASSIFICATION_DENIED'; END IF;
 IF prior.id IS NOT NULL AND (prior.acquisition_kind IS DISTINCT FROM 'core_export'
  OR prior.document_id IS DISTINCT FROM document) THEN
  RAISE EXCEPTION 'X1_SOURCE_NAMESPACE_TRANSPORT_REPLACEMENT_DENIED'; END IF;
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

CREATE OR REPLACE FUNCTION finnor_os.x1_source_scope(w uuid,grant_id uuid) RETURNS jsonb
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
 state:=jsonb_build_object('schema','finnor.x1.source-scope.v2','grantId',g.id,'workId',w,'principalId',u,
  'sourceId',g.source_id,'sourceClass',g.source_class,'institutionId',g.institution_id,'purpose',g.purpose,
  'grantVersion',g.version,'sourceRevision',g.revision,'originalSha256',g.original_sha256,
  'protocol',g.protocol,'acquisitionKind',g.acquisition_kind,'documentId',g.document_id,
  'documentVersionId',g.document_version_id,'integrationId',g.integration_id,'provider',g.provider,
  'adapterScope',g.adapter_scope,'externalObjectType',g.external_object_type,'externalId',g.external_id,
  'validFrom',g.valid_from,'expiresAt',g.expires_at,
  'expectedObjectIds',g.expected_object_ids,'expectedSubjectRegistrations',g.expected_subject_registrations,
  'subjects',subjects,'originalReadAllowed',allowed,'gap',gap,'executionAuthorityGranted',false);
 RETURN jsonb_build_object('body',state,'digest',encode(sha256(convert_to(state::text,'UTF8')),'hex'));
END $$;
