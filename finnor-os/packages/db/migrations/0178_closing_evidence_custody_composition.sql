-- Restrictive custody policies also apply to independent closing readers.
-- Let those readers evaluate the predicates without granting private custody.
CREATE OR REPLACE FUNCTION finnor_os.bilateral_evidence_scope_allowed(profile_ref jsonb) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF nullif(current_setting('app.user_id',true),'') IS NULL
  OR nullif(current_setting('app.bilateral_programme_id',true),'') IS NULL
  OR NOT has_table_privilege(current_user,'finnor_os.v1_programmes','SELECT') THEN
  RETURN false;
 END IF;
 RETURN EXISTS(
  SELECT 1 FROM finnor_os.v1_programmes p JOIN finnor_os.users u
   ON u.tenant_id=p.tenant_id AND u.id=p.principal_id
  JOIN finnor_os.primary_governance_versions v ON v.tenant_id=p.tenant_id
   AND v.id::text=profile_ref->>'id' AND v.revision::text=profile_ref->>'revision'
  JOIN finnor_os.primary_governance_heads h ON h.tenant_id=v.tenant_id AND h.id=v.id AND h.revision=v.revision
  WHERE p.tenant_id=finnor_os.request_tenant_id()
   AND p.principal_id::text=nullif(current_setting('app.user_id',true),'')
   AND p.id::text=nullif(current_setting('app.bilateral_programme_id',true),'')
   AND u.role='owner' AND u.status='active' AND h.state='CURRENT'
   AND p.intake->'sourceProfileRef'=profile_ref AND v.digest=profile_ref->>'contentDigest'
   AND (v.body->>'expiresAt')::timestamptz>statement_timestamp()
   AND (v.body->>'retentionUntil')::timestamptz>statement_timestamp()
   AND NOT p.invalidated AND p.cancellation_requested_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p.frozen_manifest->'dependencies','[]')) d
    LEFT JOIN finnor_os.p4_source_revisions r ON r.tenant_id=p.tenant_id AND r.key=d->>'key'
    WHERE COALESCE(r.revision,0)::text IS DISTINCT FROM d->>'revision')
 );
END $$;

CREATE OR REPLACE FUNCTION finnor_os.primary_evidence_scope_allowed(profile_id text, request_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF nullif(current_setting('app.user_id',true),'') IS NULL
  OR nullif(current_setting('app.primary_programme_id',true),'') IS NULL
  OR nullif(current_setting('app.primary_data_purpose',true),'') IS NULL
  OR NOT has_table_privilege(current_user,'finnor_os.v2_programmes','SELECT') THEN
  RETURN false;
 END IF;
 RETURN EXISTS(
  SELECT 1 FROM finnor_os.v2_programmes p
  JOIN finnor_os.s6_primary_requests r ON r.tenant_id=p.tenant_id AND r.principal_id=p.principal_id AND r.programme_id=p.id
  JOIN finnor_os.users u ON u.tenant_id=p.tenant_id AND u.id=p.principal_id
  JOIN finnor_os.primary_governance_versions consent ON consent.tenant_id=r.tenant_id AND consent.id=r.consent_id AND consent.revision=r.consent_version
  WHERE p.tenant_id=finnor_os.request_tenant_id()
   AND p.principal_id::text=nullif(current_setting('app.user_id',true),'')
   AND p.id::text=nullif(current_setting('app.primary_programme_id',true),'')
   AND u.role='owner' AND u.status='active'
   AND NOT p.invalidated AND p.cancellation_requested_at IS NULL
   AND r.source_profile_id::text=profile_id AND (request_id IS NULL OR r.id::text=request_id)
   AND r.body->>'purpose'=nullif(current_setting('app.primary_data_purpose',true),'')
   AND consent.body->>'authorizedActorId'=p.principal_id::text
   AND consent.body->'purposes' ? (r.body->>'purpose')
   AND (consent.body->'retention'->>'rawUntil')::timestamptz>statement_timestamp()
   AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(jsonb_build_array(
     r.body->'sourceProfileRef',r.body->'consentRef',r.body->'authorityRef',
     r.body->'mandateRef',r.body->'grantRef',r.body->'semanticsRef')) ref
    LEFT JOIN finnor_os.primary_governance_versions v ON v.tenant_id=p.tenant_id AND v.id::text=ref->>'id' AND v.revision::text=ref->>'revision'
    LEFT JOIN finnor_os.primary_governance_heads h ON h.tenant_id=v.tenant_id AND h.id=v.id AND h.revision=v.revision
    WHERE v.id IS NULL OR h.state IS DISTINCT FROM 'CURRENT' OR v.digest IS DISTINCT FROM ref->>'contentDigest'
     OR (v.body->>'expiresAt')::timestamptz<=statement_timestamp()
     OR (v.body ? 'validFrom' AND (v.body->>'validFrom')::timestamptz>statement_timestamp())
   )
   AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(p.starting_manifest->'dependencies') d
    LEFT JOIN finnor_os.p4_source_revisions rev ON rev.tenant_id=p.tenant_id AND rev.key=d->>'key'
    WHERE COALESCE(rev.revision,0)::text IS DISTINCT FROM d->>'revision'
   )
   AND p.work_input_id=(SELECT w.id FROM finnor_os.work_inputs w
    WHERE w.tenant_id=p.tenant_id AND w.work_id=p.work_id ORDER BY w.created_at DESC,w.id DESC LIMIT 1)
 );
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
 RETURN false;
END $$;

GRANT EXECUTE ON FUNCTION finnor_os.bilateral_evidence_scope_allowed(jsonb),
 finnor_os.primary_evidence_scope_allowed(text,text)
 TO finnor_closing_checker,finnor_closing_broker;
