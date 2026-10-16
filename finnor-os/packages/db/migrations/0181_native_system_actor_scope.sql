-- System actors are textual principals, not user UUIDs. Invalid user IDs must
-- deny private capital/control scope without breaking ordinary worker evidence.
CREATE FUNCTION finnor_os.request_authenticated_user_uuid() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 RETURN nullif(current_setting('app.user_id',true),'')::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.request_authenticated_user_uuid() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.request_authenticated_user_uuid() TO finnor_app;

CREATE OR REPLACE FUNCTION finnor_os.v4_evidence_permitted(p_source_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT CASE
  WHEN NOT EXISTS(SELECT 1 FROM finnor_os.s1_capital_disclosures g WHERE g.source_id=p_source_id)
    AND NOT EXISTS(SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=p_source_id AND s.source_key LIKE 'v4:%')
   THEN true
  ELSE EXISTS(
   SELECT 1 FROM finnor_os.evidence_sources s
   JOIN finnor_os.users u ON u.id=finnor_os.request_authenticated_user_uuid()
     AND u.tenant_id=finnor_os.request_tenant_id() AND u.status='active' AND u.role='owner'
   WHERE s.id=p_source_id AND s.tenant_id=u.tenant_id AND (
    s.source_key LIKE 'v4:%'
     AND current_setting('app.capital_reader_scope',true)='CAPITAL_FORMATION'
     AND s.metadata->'capitalPrivateScope'->>'principalId'=u.id::text
     AND EXISTS(SELECT 1 FROM finnor_os.works w WHERE w.tenant_id=u.tenant_id
       AND w.id=(s.metadata->'capitalPrivateScope'->>'workId')::uuid
       AND coalesce(w.current_owner_id,w.created_by)=u.id)
    OR EXISTS(
     SELECT 1 FROM finnor_os.s1_capital_disclosures g
     JOIN finnor_os.works w ON w.tenant_id=g.tenant_id AND w.id=g.work_id
     JOIN finnor_os.authority_states a ON a.tenant_id=g.tenant_id
     WHERE g.source_id=s.id AND g.tenant_id=u.tenant_id AND g.principal_id=u.id AND NOT g.revoked
       AND current_setting('app.capital_reader_scope',true)='CAPITAL_FORMATION'
       AND current_setting('app.capital_programme_id',true)=g.programme_id::text
       AND current_setting('app.capital_purpose',true)=g.body->>'purpose'
       AND g.valid_until>statement_timestamp() AND g.retention_until>statement_timestamp()
       AND coalesce(w.current_owner_id,w.created_by)=u.id AND w.status NOT IN('cancelled','failed')
       AND (g.body->>'rightsRevision')::integer=a.revision
    )
   )
  )
 END
$$;

CREATE OR REPLACE FUNCTION finnor_os.v4_action_permitted(p_action_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT coalesce((
  SELECT CASE WHEN d.action_type<>'capital_provider_request' AND NOT(d.payload ? 'financingBinding') THEN true
  ELSE d.tenant_id=finnor_os.request_tenant_id()
    AND d.initiated_by=finnor_os.request_authenticated_user_uuid()
    AND EXISTS(SELECT 1 FROM finnor_os.users u WHERE u.tenant_id=d.tenant_id AND u.id=d.initiated_by AND u.status='active')
    AND EXISTS(SELECT 1 FROM finnor_os.works w WHERE w.tenant_id=d.tenant_id AND w.id=d.work_id
      AND coalesce(w.current_owner_id,w.created_by)=d.initiated_by)
    AND (
     -- An exact original operation may be observed after disclosure authority
     -- ends. This purpose admits only the reference-only canonical intent, not
     -- private Evidence bytes and not permission to transmit a new request.
     current_setting('app.capital_reader_scope',true)='CAPITAL_FORMATION'
      AND current_setting('app.capital_original_programme_id',true)=d.payload->'request'->>'programmeId'
      AND d.action_type='capital_provider_request'
      AND NOT jsonb_path_exists(d.payload,'$.**.content')
     OR NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(coalesce(d.payload->'request'->'disclosures','[]'::jsonb)) required
      WHERE NOT EXISTS(SELECT 1 FROM finnor_os.s1_capital_disclosures g
        JOIN finnor_os.authority_states a ON a.tenant_id=g.tenant_id
        WHERE g.tenant_id=d.tenant_id AND g.principal_id=d.initiated_by
          AND g.programme_id=(d.payload->'request'->>'programmeId')::uuid
          AND g.evidence_version_id=(required->>'evidenceVersionId')::uuid AND NOT g.revoked
          AND g.valid_until>statement_timestamp() AND g.retention_until>statement_timestamp()
          AND (g.body->>'rightsRevision')::integer=a.revision)
     )
    )
  END FROM finnor_os.domain_actions d WHERE d.id=p_action_id
 ),true)
$$;

CREATE OR REPLACE FUNCTION finnor_os.may_query_resource(p_type text,p_id text,p_capability text DEFAULT 'query:pe_world_state')
RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,finnor_os AS $$
 WITH scoped AS (
  SELECT g.effect,g.approval_required,g.max_risk
   FROM finnor_os.users u
   JOIN finnor_os.employee_role_assignments a ON a.tenant_id=u.tenant_id AND a.employee_id=u.id
   JOIN finnor_os.employee_roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.active
   JOIN finnor_os.role_authority_grants g ON g.tenant_id=a.tenant_id AND g.role_id=a.role_id
  WHERE u.tenant_id=finnor_os.request_tenant_id()
    AND u.id=finnor_os.request_authenticated_user_uuid() AND u.status='active' AND u.role='owner'
    AND a.active AND a.effective_from<=clock_timestamp() AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
    AND (g.capability='*' OR g.capability=p_capability OR
      (right(g.capability,2)=':*' AND left(p_capability,length(g.capability)-1)=left(g.capability,length(g.capability)-1)))
    AND (g.resource_type='*' OR g.resource_type=p_type)
    AND CASE a.resource_scope->>'kind'
      WHEN 'tenant' THEN true
      WHEN 'resources' THEN
        (a.resource_scope->>'resourceType' IS NULL OR a.resource_scope->>'resourceType'='*' OR a.resource_scope->>'resourceType'=p_type)
        AND coalesce(a.resource_scope->'resourceIds' ? p_id,false)
      WHEN 'self' THEN p_type IN('user','employee') AND p_id=u.id::text
      WHEN 'assigned' THEN
        (p_type IN('user','employee') AND p_id=u.id::text) OR
        (p_type='work' AND EXISTS(SELECT 1 FROM finnor_os.works w
          WHERE w.tenant_id=u.tenant_id AND w.id::text=p_id AND (w.assigned_to=u.id OR w.current_owner_id=u.id)))
      ELSE false END
 )
 SELECT p_type IS NOT NULL AND p_id IS NOT NULL AND p_type<>'*'
   AND (p_type<>'p4_derivation' OR EXISTS(SELECT 1 FROM finnor_os.p4_derivations d
     WHERE d.tenant_id=finnor_os.request_tenant_id() AND d.id::text=p_id
       AND d.principal_id=finnor_os.request_authenticated_user_uuid()))
   AND EXISTS(SELECT 1 FROM scoped WHERE effect='allow' AND NOT approval_required AND max_risk IN('low','medium','high','critical'))
   AND NOT EXISTS(SELECT 1 FROM scoped WHERE effect='deny')
$$;
