-- Preserve 0181 and its retained failed development receipt. Bind the function
-- parameter explicitly where the content table also has a version_id column.
CREATE OR REPLACE FUNCTION finnor_os.x1_register_owned_core_source(w uuid,document uuid,version_id uuid,source_class text,
 protocol text,purpose text,original_hash text,object_ids jsonb,expiry timestamptz,decision uuid)
RETURNS finnor_os.x1_source_grants LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id(); u uuid:=nullif(current_setting('app.user_id',true),'')::uuid;
 institution text; mandate_expiry timestamptz; source_key text; version_key text; version_number integer;
 prior finnor_os.x1_source_grants; result finnor_os.x1_source_grants;
BEGIN
 PERFORM finnor_os.x1_assert_input_decision(w,document,decision);
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':'||w::text,5511));
 SELECT m.institution_id,m.expires_at INTO institution,mandate_expiry FROM finnor_os.x1_work_mandates m
  WHERE m.tenant_id=t AND m.work_id=w AND m.principal_id=u AND m.revoked_at IS NULL
   AND m.valid_from<=clock_timestamp() AND m.expires_at>clock_timestamp() ORDER BY m.created_at DESC,m.id DESC LIMIT 1 FOR SHARE;
 IF NOT FOUND OR expiry<=clock_timestamp() OR expiry>mandate_expiry THEN RAISE EXCEPTION 'X1_CURRENT_MANDATE_SOURCE_WINDOW_REQUIRED'; END IF;
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

