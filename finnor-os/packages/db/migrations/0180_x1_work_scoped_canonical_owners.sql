-- Additive X1 owner compatibility; no changes to historical migration bytes.
-- Preserve canonical versions and exact registration. Existing authorized Work
-- bindings supplement intrinsic provenance without admitting name-only identity.
CREATE OR REPLACE FUNCTION finnor_os.x1_assert_canonical_owner_cut(p_cut jsonb,p_lock boolean DEFAULT false)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); binding jsonb; parts text[]; tab text;
 predicate text; query_text text; owner_row jsonb; owner_count integer;
 lock_suffix text:=CASE WHEN p_lock THEN ' FOR SHARE' ELSE '' END;
BEGIN
 IF t IS NULL OR p_cut IS NULL OR jsonb_typeof(p_cut)<>'array' OR jsonb_array_length(p_cut)>1000
 THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_CUT_REQUIRED'; END IF;
 FOR binding IN SELECT value FROM jsonb_array_elements(p_cut) LOOP
  parts:=regexp_match(binding->>'ref','^([a-z_]+):([a-f0-9-]{36})@(v[1-9][0-9]*|s[a-f0-9]{64})$');
  IF parts IS NULL OR coalesce(binding->>'registrationId','')='' OR coalesce(binding->>'institutionId','')=''
  THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_CUT_INVALID'; END IF;
  tab:=NULL; predicate:=NULL;
  CASE parts[1]
   WHEN 'pe_deal' THEN tab:='pe_deals';predicate:='archived_at IS NULL AND status=''active''';
   WHEN 'pe_fund' THEN tab:='pe_funds';predicate:='status<>''liquidated''';
   WHEN 'pe_vehicle' THEN tab:='pe_vehicles';predicate:='status<>''liquidated''';
   WHEN 'pe_investment_case' THEN tab:='pe_investment_cases';predicate:='archived_at IS NULL AND superseded_at IS NULL';
   WHEN 'pe_debt_facility' THEN tab:='pe_debt_facilities';predicate:='superseded_at IS NULL AND valid_to IS NULL AND status NOT IN(''cancelled'',''repaid'')';
   WHEN 'pe_metric_series' THEN tab:='pe_metric_series';predicate:='active';
   WHEN 'pe_request' THEN tab:='pe_requests';predicate:='archived_at IS NULL';
   WHEN 'pe_finding' THEN tab:='pe_findings';predicate:='archived_at IS NULL AND superseded_at IS NULL';
   WHEN 'pe_decision' THEN tab:='pe_decisions';predicate:='superseded_at IS NULL';
   WHEN 'pe_fund_vehicle_link' THEN tab:='pe_fund_vehicle_links';predicate:='superseded_at IS NULL AND valid_to IS NULL';
   WHEN 'pe_company_party_role' THEN tab:='pe_company_party_roles';predicate:='superseded_at IS NULL AND valid_to IS NULL';
   WHEN 'pe_debt_facility_lender' THEN tab:='pe_debt_facility_lenders';predicate:='superseded_at IS NULL AND valid_to IS NULL';
   WHEN 'pe_dependency' THEN tab:='pe_dependencies';predicate:='removed_at IS NULL';
   ELSE NULL;
  END CASE;
  IF tab IS NOT NULL THEN
   IF binding->'ownerWitness'->>'workScope' IS NOT NULL THEN
    IF parts[1] NOT IN ('pe_deal','pe_fund','pe_vehicle')
      OR binding->'ownerWitness'->>'workScope' !~ '^[a-f0-9-]{36}$'
    THEN RAISE EXCEPTION 'X1_CANONICAL_WORK_SCOPE_INVALID'; END IF;
    -- A real current Work link and its principal scope are owner evidence.
    -- Source text cannot select a Work or issue this immutable owner witness.
    IF p_lock THEN
    PERFORM l.id FROM finnor_os.work_entity_links l JOIN finnor_os.works w
      ON w.tenant_id=l.tenant_id AND w.id=l.work_id
      JOIN finnor_os.users u ON u.tenant_id=w.tenant_id AND u.id=w.created_by
      WHERE l.tenant_id=t AND l.work_id=(binding->'ownerWitness'->>'workScope')::uuid
        AND l.entity_type=parts[1] AND l.entity_id=parts[2]::uuid
        AND w.created_by=nullif(current_setting('app.user_id',true),'')::uuid
        AND u.status='active' FOR SHARE OF l,w,u;
    ELSE
    PERFORM l.id FROM finnor_os.work_entity_links l JOIN finnor_os.works w
      ON w.tenant_id=l.tenant_id AND w.id=l.work_id
      JOIN finnor_os.users u ON u.tenant_id=w.tenant_id AND u.id=w.created_by
      WHERE l.tenant_id=t AND l.work_id=(binding->'ownerWitness'->>'workScope')::uuid
        AND l.entity_type=parts[1] AND l.entity_id=parts[2]::uuid
        AND w.created_by=nullif(current_setting('app.user_id',true),'')::uuid
        AND u.status='active';
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'X1_CANONICAL_WORK_SCOPE_CHANGED'; END IF;
    query_text:='SELECT to_jsonb(o) FROM finnor_os.'||quote_ident(tab)||' o
      WHERE tenant_id=$1 AND id=$2 AND external_id=$3 AND '||predicate||lock_suffix;
   ELSE
    query_text:='SELECT to_jsonb(o) FROM finnor_os.'||quote_ident(tab)||' o WHERE tenant_id=$1 AND id=$2
     AND external_id=$3 AND source_system=''x1:''||$4 AND '||predicate||lock_suffix;
   END IF;
   EXECUTE query_text INTO owner_row USING t,parts[2]::uuid,binding->>'registrationId',binding->>'institutionId';
   IF owner_row IS NULL OR parts[3] IS DISTINCT FROM 'v'||(owner_row->>'version')
   THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_CHANGED'; END IF;
  ELSE
   IF left(parts[3],1)<>'s' OR jsonb_typeof(binding->'ownerWitness') IS DISTINCT FROM 'object'
   THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_WITNESS_REQUIRED'; END IF;
   CASE parts[1]
    WHEN 'user' THEN query_text:='SELECT jsonb_build_object(''bindingId'',b.id,''sourceId'',b.source_id,
      ''registrationId'',b.registration_id,''revision'',b.revision,''subjectId'',b.subject_user_id)
      FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.users u
       ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
      WHERE b.tenant_id=$1 AND b.registration_id=$3 AND b.institution_id=$4 AND b.source_id=$5
       AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()
       AND u.status=''active'''||CASE WHEN p_lock THEN ' FOR SHARE OF b,u' ELSE '' END;
    WHEN 'external_organization' THEN query_text:='SELECT jsonb_build_object(''organizationKey'',organization_key,''active'',active)
      FROM finnor_os.external_organizations WHERE tenant_id=$1 AND id=$2 AND organization_key=$3 AND active'||lock_suffix;
    WHEN 'document' THEN query_text:='SELECT jsonb_build_object(''id'',d.id,''externalId'',d.external_id,''sourceSystem'',d.source_system,
       ''heads'',coalesce((SELECT jsonb_agg(jsonb_build_object(''kind'',h.kind,''headKey'',h.head_key,
        ''versionId'',h.version_id,''sha256'',v.byte_sha256) ORDER BY h.kind,h.head_key)
        FROM finnor_os.document_version_heads h JOIN finnor_os.document_versions v
         ON v.tenant_id=h.tenant_id AND v.id=h.version_id AND v.document_id=h.document_id
        WHERE h.tenant_id=d.tenant_id AND h.document_id=d.id),''[]''::jsonb))
      FROM finnor_os.documents d WHERE d.tenant_id=$1 AND d.id=$2 AND d.archived_at IS NULL
       AND (d.id::text=$3 OR (d.source_system=''x1:''||$4 AND d.external_id=$3))'||lock_suffix;
    WHEN 'work' THEN query_text:='SELECT jsonb_build_object(''id'',id,''principalId'',created_by)
      FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 AND id::text=$3
       AND created_by=nullif(current_setting(''app.user_id'',true),'''')::uuid'||lock_suffix;
    ELSE RAISE EXCEPTION 'X1_CANONICAL_OWNER_TYPE_UNSUPPORTED';
   END CASE;
   owner_count:=0;
   FOR owner_row IN EXECUTE query_text USING t,parts[2]::uuid,binding->>'registrationId',binding->>'institutionId',binding->>'sourceId' LOOP
    owner_count:=owner_count+1;
    IF (parts[1]='user' AND owner_row->>'subjectId' IS DISTINCT FROM parts[2])
     OR (owner_row-'subjectId') IS DISTINCT FROM binding->'ownerWitness'
    THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_CHANGED'; END IF;
   END LOOP;
   IF owner_count<>1 THEN RAISE EXCEPTION 'X1_CANONICAL_OWNER_CHANGED_OR_AMBIGUOUS'; END IF;
  END IF;
 END LOOP;
END $$;
