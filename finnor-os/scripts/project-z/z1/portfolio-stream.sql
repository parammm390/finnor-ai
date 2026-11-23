-- Forward-only proposal. No table creation, original-parent replacement,
-- history rewrite or 8 MiB record/snapshot limit changes. Not executed here.
-- The cursor is WITHOUT HOLD and reads one statement snapshot after the
-- canonical tenant serializer, active owner and authority locks are held.
CREATE FUNCTION finnor_os.z1_s5_open_occupation(p_resource_ids text[])
 RETURNS refcursor LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,finnor_os AS $$
DECLARE
 v_tenant uuid:=finnor_os.request_tenant_id();
 v_actor uuid:=finnor_os.z1_s5_actor();
 v_population record;v_scope jsonb;v_fence text;v_selected text[];v_cursor refcursor;
 v_resource_count integer;v_envelope_count bigint;
BEGIN
 IF p_resource_ids IS NULL OR cardinality(p_resource_ids) NOT BETWEEN 1 AND 16
  OR cardinality(p_resource_ids)<>(SELECT count(DISTINCT value) FROM unnest(p_resource_ids) value)
  OR EXISTS(SELECT 1 FROM unnest(p_resource_ids) value WHERE value IS NULL OR length(value)>256)
  THEN RAISE EXCEPTION 'Z1 exact native occupation selection required'; END IF;
 SELECT array_agg(value ORDER BY value COLLATE "C") INTO v_selected FROM unnest(p_resource_ids) value;
 SELECT * INTO v_population FROM finnor_os.z1_s5_portfolio_population();
 IF NOT FOUND THEN RAISE EXCEPTION 'Z1 complete canonical population required'; END IF;
 -- Every admitted ordinary owner emits at most one envelope per selected
 -- resource (<=16); native origins are independently validated as exactly four.
 IF EXISTS(SELECT 1 FROM finnor_os.s5_reservations s
   JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
   WHERE s.tenant_id=v_tenant AND s.status<>'RELEASED' AND
    (s.envelopes IS DISTINCT FROM o.body->'envelopes' OR
     CASE WHEN jsonb_typeof(s.envelopes)='array' THEN jsonb_array_length(s.envelopes)>16 ELSE true END))
  THEN RAISE EXCEPTION 'Z1 canonical occupation envelope shape required'; END IF;
 SELECT coalesce(sum(jsonb_array_length(envelopes)),0) INTO v_envelope_count
  FROM finnor_os.s5_reservations WHERE tenant_id=v_tenant AND status<>'RELEASED';
 IF v_envelope_count>8096 THEN RAISE EXCEPTION 'Z1 complete canonical envelope count required'; END IF;
 PERFORM 1 FROM finnor_os.s5_resource_heads WHERE tenant_id=v_tenant ORDER BY resource_id FOR SHARE;
 SELECT count(*) INTO v_resource_count FROM finnor_os.s5_resource_heads WHERE tenant_id=v_tenant;
 IF v_resource_count>16 OR
  (SELECT count(*) FROM finnor_os.s5_resource_heads WHERE tenant_id=v_tenant AND resource_id=ANY(v_selected))<>cardinality(v_selected)
  THEN RAISE EXCEPTION 'Z1 current bounded resource heads required'; END IF;
 SELECT jsonb_build_object('tenantId',v_tenant::text,'principalId',v_actor::text,
  'transactionId',txid_current()::text,'rightsRevision',revision::text) INTO v_scope
  FROM finnor_os.authority_states WHERE tenant_id=v_tenant;
 IF v_scope IS NULL THEN RAISE EXCEPTION 'Z1 current canonical authority required'; END IF;
 v_fence:=encode(sha256(convert_to(finnor_os.z1_budget_json(v_scope),'UTF8')),'hex');
 v_cursor:='z1p_'||pg_backend_pid()::text||'_'||txid_current()::text;
 OPEN v_cursor NO SCROLL FOR
  WITH held AS MATERIALIZED (
   SELECT s.reservation_id,
    jsonb_build_object('tag','RESERVATION','reservationRef',o.reservation_ref,
     'certificateRef',CASE WHEN NOT p.institution THEN o.certificate_ref ELSE NULL END,
     'demandRef',CASE WHEN p.institution THEN o.demand_ref ELSE NULL END,
     'originalKey',CASE WHEN p.problem_schema='finnor.s5.z1-original-work-problem.v1' THEN
      encode(sha256(convert_to(v_tenant::text||':'||o.original_work_id,'UTF8')),'hex') ELSE NULL END,
     'population',CASE WHEN p.problem_schema='finnor.s5.z1-original-work-problem.v1' THEN 'ORIGINAL' ELSE 'OTHER' END,
     'revision',s.revision,'envelopeCount',s.envelope_count,'status',s.status) AS header
   FROM (SELECT reservation_id,allocation_digest,revision,status,jsonb_array_length(envelopes) envelope_count
    FROM finnor_os.s5_reservations WHERE tenant_id=v_tenant AND status<>'RELEASED' OFFSET 0) s
   CROSS JOIN LATERAL (
    SELECT q.body->'ref' reservation_ref,q.body->'certificateRef' certificate_ref,
     q.body->'demandRef' demand_ref,q.body#>>'{original,workId}' original_work_id
    FROM finnor_os.s5_reservation_origins q WHERE q.tenant_id=v_tenant AND q.reservation_id=s.reservation_id
     AND q.allocation_digest=s.allocation_digest OFFSET 0
   ) o
   CROSS JOIN LATERAL (
    SELECT q.demand IS NOT NULL institution,q.problem->>'schema' problem_schema FROM finnor_os.s5_proposals q
     WHERE q.tenant_id=v_tenant AND q.content_digest=s.allocation_digest OFFSET 0
   ) p
  ), items AS NOT MATERIALIZED (
   SELECT 0 AS group_order,r.resource_id AS member_id,0::bigint AS ordinal,
    jsonb_build_object('tag','RESOURCE','resourceId',r.resource_id,'reference',r.body->'ref',
     'horizonDigest',encode(sha256(convert_to(finnor_os.z1_budget_json(r.body->'horizon'),'UTF8')),'hex'),
     'kind',r.body->>'kind','unit',r.body->>'unit') AS payload
   FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
   WHERE r.tenant_id=v_tenant
   UNION ALL
   SELECT 1,reservation_id,0::bigint,header FROM held
   UNION ALL
   SELECT 1,s.reservation_id,e.ordinality,
    jsonb_build_object('tag','ENVELOPE','reservationId',s.reservation_id,'ordinal',e.ordinality,
     'resourceId',e.value->>'resourceId','kind',e.value->>'kind','unit',e.value->>'unit',
     'horizonDigest',encode(sha256(convert_to(finnor_os.z1_budget_json(e.value->'horizon'),'UTF8')),'hex'),
     'envelopeDigest',encode(sha256(convert_to(e.value::text,'UTF8')),'hex'),
     'quantityCount',CASE WHEN jsonb_typeof(e.value->'quantities')='array' THEN jsonb_array_length(e.value->'quantities') ELSE 0 END,
     'opaque',NOT coalesce(e.value->>'resourceId'=ANY(v_selected),false),
     'valid',CASE WHEN e.value->>'resourceId'=ANY(v_selected) THEN
       CASE WHEN jsonb_typeof(e.value->'quantities')='array' AND jsonb_typeof(e.value->'minimumQuantities')='array' THEN
        jsonb_array_length(e.value->'quantities') BETWEEN 2 AND 65
        AND jsonb_array_length(e.value->'minimumQuantities')=jsonb_array_length(e.value->'quantities')
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.value->'quantities') q WHERE jsonb_typeof(q.value)<>'string' OR
         (q.value#>>'{}' ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true)
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.value->'minimumQuantities') q WHERE jsonb_typeof(q.value)<>'string' OR
         (q.value#>>'{}' ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true)
       ELSE false END
      ELSE jsonb_typeof(e.value)='object' AND jsonb_typeof(e.value->'quantities')='array' END,
     'quantities',CASE WHEN e.value->>'resourceId'=ANY(v_selected) AND
      CASE WHEN jsonb_typeof(e.value->'quantities')='array' THEN jsonb_array_length(e.value->'quantities') BETWEEN 2 AND 65
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(e.value->'quantities') q WHERE
        (q.value ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true) ELSE false END
       THEN e.value->'quantities' ELSE NULL END,
     'minimumQuantities',CASE WHEN e.value->>'resourceId'=ANY(v_selected) AND
      CASE WHEN jsonb_typeof(e.value->'minimumQuantities')='array' THEN jsonb_array_length(e.value->'minimumQuantities') BETWEEN 2 AND 65
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(e.value->'minimumQuantities') q WHERE
        (q.value ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true) ELSE false END
       THEN e.value->'minimumQuantities' ELSE NULL END)
   -- OFFSET 0 keeps this exact-key read correlated, rather than retaining all
   -- original envelope arrays in a hash/materialized join. Only projected,
   -- bounded payloads enter the subsequent materialized CTEs.
   FROM held h CROSS JOIN LATERAL (
    SELECT q.reservation_id,q.envelopes FROM finnor_os.s5_reservations q
     WHERE q.tenant_id=v_tenant AND q.reservation_id=h.reservation_id OFFSET 0
   ) s CROSS JOIN LATERAL jsonb_array_elements(s.envelopes) WITH ORDINALITY e(value,ordinality)
  ), bounded AS MATERIALIZED (
   SELECT group_order,member_id,ordinal,
    CASE WHEN octet_length(to_jsonb(payload::text)::text)<=32768 THEN payload
     ELSE jsonb_build_object('tag','INVALID','reason','Z1_PORTFOLIO_MEMBER_BYTE_BOUND') END payload
   FROM items
  ), encoded AS MATERIALIZED (
   SELECT row_number() OVER(ORDER BY group_order,member_id COLLATE "C",ordinal) AS sequence,
    payload::text AS payload_text,
    encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS payload_digest
   FROM bounded
  ), facts AS MATERIALIZED (
   SELECT jsonb_build_object('resources',v_resource_count,
    'reservations',(SELECT count(*) FROM held),'originals',v_population.original_count,'other',v_population.other_count,
    'envelopes',v_envelope_count,'items',count(*)) AS counts,
    encode(sha256(convert_to(coalesce(string_agg(payload_digest,'' ORDER BY sequence),''),'UTF8')),'hex') AS members_digest
   FROM encoded
  ), frames AS (
   SELECT 0::bigint AS sequence,jsonb_build_object('kind','MANIFEST','schema','finnor.s5.z1.occupation-stream.v1',
    'scope',v_scope,'fence',v_fence,'counts',counts,'membersDigest',members_digest,
    'selectedResourceIds',to_jsonb(v_selected),'settlement','UNKNOWN_UNINSPECTED') AS frame FROM facts
   UNION ALL
   SELECT sequence,jsonb_build_object('kind','DATA','fence',v_fence,'sequence',sequence,
    'payloadText',payload_text,'payloadDigest',payload_digest) FROM encoded
   UNION ALL
   SELECT (counts->>'items')::bigint+1,jsonb_build_object('kind','SEAL','fence',v_fence,
    'sequence',(counts->>'items')::bigint+1,'counts',counts,'membersDigest',members_digest) FROM facts
  )
  SELECT frame FROM frames ORDER BY sequence;
 RETURN v_cursor;
END $$;
REVOKE ALL ON FUNCTION finnor_os.z1_s5_open_occupation(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.z1_s5_open_occupation(text[]) TO finnor_app;

ALTER TABLE finnor_os.z1_deliveries ADD CONSTRAINT z1_delivery_receipt_state CHECK(
 (status='PENDING_S8' AND receipt IS NULL) OR
 (status='CONSUMED' AND receipt IS NOT NULL AND jsonb_typeof(receipt)='object' AND
  (receipt->>'workId'=work_id::text AND receipt->'artifactRef'->>'id'=publication_id
   AND receipt->>'owner' IN('S3','S4') AND receipt->'executionAuthorityGranted'='false'::jsonb) IS TRUE)
);
-- Relationship/state guard only. Does not replace the actual independent S8
-- checker, issue an admission, or grant protected/effect/business authority.
CREATE FUNCTION finnor_os.z1_delivery_consumption_link() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF NEW.status='CONSUMED' THEN
  IF NOT EXISTS(SELECT 1 FROM finnor_os.z1_owner_uses u
    JOIN finnor_os.z1_artifacts n ON n.tenant_id=u.tenant_id AND n.artifact_id=u.reference->>'id'
    WHERE u.tenant_id=NEW.tenant_id AND u.principal_id=NEW.principal_id AND u.request_id=NEW.request_id
     AND u.publication_id=NEW.publication_id AND u.work_id=NEW.work_id AND u.receipt=NEW.receipt
     AND u.semantic_owner=NEW.receipt->>'owner' AND u.reference=NEW.receipt->'nativeResultRef'
     AND n.principal_id=u.principal_id AND n.request_id=u.request_id AND n.reference=u.reference AND n.body=u.body
     AND n.kind=CASE u.semantic_owner WHEN 'S3' THEN 'z1-original-exact-model' ELSE 'z1-original-exact-choice' END)
   OR NOT EXISTS(SELECT 1 FROM finnor_os.s8_z1_shared_work_admissions a
    JOIN finnor_os.z1_requests q ON q.tenant_id=a.tenant_id AND q.id=a.request_id AND q.principal_id=a.principal_id
    JOIN finnor_os.authority_states r ON r.tenant_id=q.tenant_id
    WHERE a.tenant_id=NEW.tenant_id AND a.principal_id=NEW.principal_id AND a.request_id=NEW.request_id
     AND a.publication_id=NEW.publication_id AND a.body->'publicationRef'=q.publication->'reference'
     AND a.body->'publicationRef'=NEW.receipt->'artifactRef' AND a.body->'generation'=to_jsonb(q.generation)
     AND a.body->>'requestDigest'=q.request_digest AND a.body->>'rightsRevision'=q.rights_revision
     AND q.rights_revision=r.revision::text AND a.body->>'runtimeDigest'=q.runtime->>'digest'
     AND (a.body->>'validUntil')::timestamptz=q.deadline_at AND q.deadline_at>clock_timestamp()
     AND a.body->'protectedAdmission'='false'::jsonb AND a.body->'productionActivated'='false'::jsonb
     AND a.body->'executionAuthorityGranted'='false'::jsonb)
  THEN RAISE EXCEPTION 'Z1 consumed delivery requires current independent admission and identical original owner use'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.z1_delivery_consumption_link() FROM PUBLIC;
CREATE TRIGGER z1_delivery_consumption_link BEFORE INSERT OR UPDATE ON finnor_os.z1_deliveries
 FOR EACH ROW EXECUTE FUNCTION finnor_os.z1_delivery_consumption_link();
