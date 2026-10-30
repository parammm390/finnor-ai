-- Forward-only upgrade for existing Z1 installations. Preserve original tables,
-- identities, holds, charges, RLS and migration history. Also safe after the
-- complete fresh-install schema; only these reviewed function bodies change.

CREATE OR REPLACE FUNCTION finnor_os.z1_s5_portfolio_population()
 RETURNS TABLE(original_count integer,other_count integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();u uuid:=finnor_os.z1_s5_actor();
 v_valid boolean;v_distinct_work_count integer;
BEGIN
 IF NOT finnor_os.y4_allocation_context_complete() OR
  (SELECT count(*) FROM finnor_os.s5_reservations WHERE tenant_id=t AND status<>'RELEASED')>1256
  THEN RAISE EXCEPTION 'Z1 S5 complete bounded shared portfolio required'; END IF;
 WITH occupation AS (
  SELECT s.*,o.body,o.principal_id origin_principal,p.problem,p.certificate,p.demand,
   o.reservation_id origin_id,o.allocation_digest origin_allocation,p.content_digest proposal_digest,
   coalesce(s.reservation_id LIKE 'z1-original-budget:%'
    OR o.body->>'schema'='finnor.s5.z1-original-budget.v1'
    OR p.problem->>'schema'='finnor.s5.z1-original-work-problem.v1'
    OR p.certificate->>'schema'='finnor.s5.z1-original-work-certificate.v1',false) claimed
  FROM finnor_os.s5_reservations s
  LEFT JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
  LEFT JOIN finnor_os.s5_proposals p ON p.tenant_id=s.tenant_id AND p.content_digest=s.allocation_digest
  WHERE s.tenant_id=t AND s.status<>'RELEASED'
 )
 SELECT count(*) FILTER(WHERE claimed)::integer,count(*) FILTER(WHERE NOT claimed)::integer,
  count(DISTINCT body#>>'{original,workId}') FILTER(WHERE claimed)::integer,
  coalesce(bool_and(origin_id IS NOT NULL AND proposal_digest IS NOT NULL
   AND origin_allocation=allocation_digest AND CASE WHEN claimed THEN (
    body->>'schema'='finnor.s5.z1-original-budget.v1'
    AND problem->>'schema'='finnor.s5.z1-original-work-problem.v1'
    AND certificate->>'schema'='finnor.s5.z1-original-work-certificate.v1' AND demand IS NULL
    AND body->>'tenantId'=t::text AND body->>'principalId'=origin_principal::text
    AND certificate->>'tenantId'=t::text AND certificate->>'principalId'=origin_principal::text
    AND body#>>'{ref,owner}'='S5' AND body#>>'{ref,version}'='z1-native-owner-v1'
    AND body#>>'{ref,contentDigest}' ~ '^[a-f0-9]{64}$'
    AND reservation_id='z1-original-budget:'||(body#>>'{ref,contentDigest}')
    AND body#>>'{ref,id}'=reservation_id
    AND certificate#>>'{ref,owner}'='S5' AND certificate#>>'{ref,version}'='z1-native-owner-v1'
    AND certificate#>>'{ref,contentDigest}' ~ '^[a-f0-9]{64}$'
    AND certificate#>>'{ref,id}'='z1-original-certificate:'||(certificate#>>'{ref,contentDigest}')
    AND body->'certificateRef'=certificate->'ref' AND allocation_digest=certificate#>>'{ref,contentDigest}'
    AND body->'envelopes'=envelopes AND certificate#>'{check,envelopes}'=envelopes
    AND jsonb_array_length(envelopes)=4 AND certificate->'policyBindings'='[]'::jsonb
    AND body#>>'{original,workId}'=problem->>'originalWorkId'
    AND body#>>'{original,workId}'=certificate->>'originalWorkId'
   ) IS TRUE ELSE true END),true)
 INTO original_count,other_count,v_distinct_work_count,v_valid FROM occupation;
 IF NOT v_valid OR original_count>1000 OR other_count>256 OR original_count<>v_distinct_work_count
  THEN RAISE EXCEPTION 'Z1 S5 canonical original and generic populations required'; END IF;
 RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.z1_s5_reserve(p_problem jsonb,p_certificate jsonb,p_budget jsonb,p_digest text,
 p_budget_preimage text,p_certificate_preimage text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE t uuid:=finnor_os.request_tenant_id();u uuid:=finnor_os.z1_s5_actor();r jsonb;e jsonb;
 current_resource jsonb;v_deadline timestamptz;v_max numeric;v_used numeric;v_period integer;v_index integer;
 v_available jsonb;v_kind text;v_unit text;v_work uuid;v_prior jsonb;v_row record;v_permission_resources jsonb;v_input jsonb;
 v_population record;v_occupation numeric[];
BEGIN
 v_work:=(p_budget#>>'{original,workId}')::uuid;v_deadline:=(p_budget#>>'{original,deadlineAt}')::timestamptz;
 IF (p_problem->>'schema' IS DISTINCT FROM 'finnor.s5.z1-original-work-problem.v1'
  OR p_certificate->>'schema' IS DISTINCT FROM 'finnor.s5.z1-original-work-certificate.v1'
  OR p_budget->>'schema' IS DISTINCT FROM 'finnor.s5.z1-original-budget.v1'
  OR p_budget->>'tenantId' IS DISTINCT FROM t::text OR p_budget->>'principalId' IS DISTINCT FROM u::text
  OR p_certificate->>'tenantId' IS DISTINCT FROM t::text OR p_certificate->>'principalId' IS DISTINCT FROM u::text
  OR p_budget->'original' IS DISTINCT FROM p_problem->'original'
  OR p_digest IS DISTINCT FROM encode(sha256(convert_to(finnor_os.z1_budget_json(p_budget->'original'),'UTF8')),'hex')
  OR p_budget->'resources' IS DISTINCT FROM p_problem->'resources'
  OR p_budget->'certificateRef' IS DISTINCT FROM p_certificate->'ref'
  OR p_budget->'envelopes' IS DISTINCT FROM p_certificate#>'{check,envelopes}'
  OR p_budget->>'rightsRevision' IS DISTINCT FROM (SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=t)
  OR p_budget->>'executionAuthorityGranted' IS DISTINCT FROM 'false' OR p_budget->'protectedReceipt' IS DISTINCT FROM 'null'::jsonb
  OR p_certificate->>'executionAuthorityGranted' IS DISTINCT FROM 'false'
  OR jsonb_array_length(p_budget->'resources')<>4 OR jsonb_array_length(p_budget->'envelopes')<>4
  OR v_deadline<=clock_timestamp() OR v_deadline>clock_timestamp()+interval '24 hours'
  OR jsonb_array_length(p_budget->'resourceReadDecisionIds')<>4
  OR p_budget->'ref'->>'owner' IS DISTINCT FROM 'S5' OR p_certificate->'ref'->>'owner' IS DISTINCT FROM 'S5'
  OR p_budget->'ref'->>'version' IS DISTINCT FROM 'z1-native-owner-v1'
  OR p_certificate->'ref'->>'version' IS DISTINCT FROM 'z1-native-owner-v1'
  OR p_budget->'ref'->>'contentDigest' !~ '^[a-f0-9]{64}$'
  OR p_certificate->'ref'->>'contentDigest' !~ '^[a-f0-9]{64}$'
  OR p_budget_preimage::jsonb IS DISTINCT FROM p_budget-'ref'
  OR p_certificate_preimage::jsonb IS DISTINCT FROM p_certificate-'ref'
  OR octet_length(p_budget_preimage)>8388608 OR octet_length(p_certificate_preimage)>8388608
  OR p_budget->'ref'->>'contentDigest' IS DISTINCT FROM
   encode(sha256(convert_to(p_budget_preimage,'UTF8')),'hex')
  OR p_certificate->'ref'->>'contentDigest' IS DISTINCT FROM
   encode(sha256(convert_to(p_certificate_preimage,'UTF8')),'hex')
  OR p_budget->'ref'->>'id' IS DISTINCT FROM 'z1-original-budget:'||(p_budget->'ref'->>'contentDigest')
  OR p_certificate->'ref'->>'id' IS DISTINCT FROM 'z1-original-certificate:'||(p_certificate->'ref'->>'contentDigest')
  OR p_digest !~ '^[a-f0-9]{64}$' OR octet_length(p_problem::text)+octet_length(p_certificate::text)>8388608
  OR octet_length(p_budget::text)>8388608
 ) IS DISTINCT FROM false THEN RAISE EXCEPTION 'Z1 S5 exact original budget domain required'; END IF;
 PERFORM 1 FROM finnor_os.works WHERE tenant_id=t AND id=v_work AND created_by=u
  AND status NOT IN('completed','failed','cancelled') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Z1 S5 current original Work required';END IF;
 SELECT to_jsonb(i) INTO v_input FROM finnor_os.work_inputs i WHERE i.tenant_id=t AND i.work_id=v_work
  ORDER BY created_at DESC,id DESC LIMIT 1;
 IF (v_input->>'id' IS DISTINCT FROM p_budget->>'inputId'
  OR v_input#>'{context_snapshot,businessRoot}' IS DISTINCT FROM p_budget#>'{original,root}'
  OR p_budget->>'inputDigest' IS DISTINCT FROM
   encode(sha256(convert_to(v_input::text,'UTF8')),'hex')
  OR p_problem->'input' IS DISTINCT FROM jsonb_build_object('inputId',p_budget->>'inputId','inputDigest',p_budget->>'inputDigest')
  OR p_problem->>'originalWorkId' IS DISTINCT FROM v_work::text
  OR p_certificate->>'originalWorkId' IS DISTINCT FROM v_work::text
  OR p_certificate->>'rightsRef' IS DISTINCT FROM p_budget->>'rightsRevision'
  OR p_certificate->'policyBindings' IS DISTINCT FROM '[]'::jsonb
  OR p_certificate->'protectedReceipt' IS DISTINCT FROM 'null'::jsonb
  OR p_certificate#>>'{check,feasible}' IS DISTINCT FROM 'true'
  OR p_certificate->>'validUntil' IS DISTINCT FROM p_budget#>>'{original,deadlineAt}'
 ) IS DISTINCT FROM false THEN RAISE EXCEPTION 'Z1 S5 exact current original input and certificate required';END IF;
 SELECT jsonb_agg(jsonb_build_object('type','allocation_resource','id',scope_id) ORDER BY ordinal) INTO v_permission_resources
  FROM (SELECT r->'scopeRef'->>'id' scope_id,min(ordinality) ordinal
    FROM jsonb_array_elements(p_budget->'resources') WITH ORDINALITY a(r,ordinality)
    GROUP BY r->'scopeRef'->>'id') q;
 PERFORM 1 FROM finnor_os.authority_decisions a WHERE a.tenant_id=t AND a.employee_id=u
  AND a.id=(p_budget->>'authorityDecisionId')::uuid AND a.authority_revision=(p_budget->>'rightsRevision')::integer
  AND a.operation='action' AND a.capability='action:allocate_resource' AND a.outcome='allowed'
  AND a.reason_code='grant_allows' AND a.risk='high' AND a.work_id=v_work
  AND a.created_at>clock_timestamp()-interval '30 seconds' AND a.created_at<=clock_timestamp()
  AND a.evidence->'resources'=v_permission_resources AND a.evidence->>'exactAmountUsd'='0'
  AND a.evidence#>>'{controlBinding,proposalId}'=v_work::text
  AND a.evidence#>>'{controlBinding,proposalDigest}'=p_digest
  AND a.evidence#>>'{controlBinding,requestDigest}'=p_digest
  AND a.evidence#>>'{controlBinding,dependencyDigest}'=
   encode(sha256(convert_to(finnor_os.z1_budget_json(jsonb_build_object(
    'cut',p_problem->'input','resources',p_budget#>'{original,resources}','rights',p_budget->>'rightsRevision')),'UTF8')),'hex')
  AND a.evidence#>>'{controlBinding,expiresAt}'=p_budget#>>'{original,deadlineAt}' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Z1 S5 fresh exact canonical allocation authority required';END IF;
 SELECT o.body INTO v_prior FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_proposals p
  ON p.tenant_id=o.tenant_id AND p.content_digest=o.allocation_digest
  WHERE o.tenant_id=t AND o.principal_id=u AND p.problem->>'schema'='finnor.s5.z1-original-work-problem.v1'
  AND p.problem->>'originalWorkId'=v_work::text;
 IF FOUND THEN
  IF v_prior IS DISTINCT FROM p_budget THEN RAISE EXCEPTION 'Z1 S5 original parent cannot renew'; END IF;
  RETURN finnor_os.z1_s5_budget(v_prior->'ref'->>'id');
 END IF;
 SELECT * INTO v_population FROM finnor_os.z1_s5_portfolio_population();
 IF v_population.original_count>=1000
  THEN RAISE EXCEPTION 'Z1 S5 original parent population exhausted'; END IF;
 FOR v_index IN 0..3 LOOP
  r:=p_budget->'resources'->v_index;e:=p_budget->'envelopes'->v_index;
  v_kind:=CASE WHEN v_index=3 THEN 'OCCUPANCY' ELSE 'CUMULATIVE_EXPENDITURE' END;
  v_unit:=CASE WHEN v_index=0 THEN 'z1-logical-tick' WHEN v_index=1 THEN 'cpu-microseconds' ELSE 'byte' END;
  v_max:=CASE v_index WHEN 0 THEN (p_budget#>>'{original,maximumTicks}')::numeric
   WHEN 1 THEN (p_budget#>>'{original,maximumCpuMicros}')::numeric
   WHEN 2 THEN (p_budget#>>'{original,maximumRetainedBytes}')::numeric
   ELSE (p_budget#>>'{original,maximumMemoryBytes}')::numeric END;
  IF (v_max<=0 OR v_max<>trunc(v_max) OR v_max>CASE v_index WHEN 0 THEN 1000000000 WHEN 1 THEN 120000000
   WHEN 2 THEN 536870912 ELSE 2147483648 END) IS DISTINCT FROM false
   THEN RAISE EXCEPTION 'Z1 S5 original finite resource bound required'; END IF;
  SELECT x.body INTO current_resource FROM finnor_os.s5_resources x
   JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
   WHERE x.tenant_id=t AND x.resource_id=r->>'resourceId' FOR SHARE OF h;
  IF (current_resource IS DISTINCT FROM r OR r->>'resourceClass'<>'COMPUTE' OR r->>'unit'<>v_unit
   OR r->>'kind'<>v_kind OR r->'currency'<>'null'::jsonb OR r->'ownerRef'->>'id'<>u::text
   OR r->'revoked'<>'false'::jsonb OR jsonb_array_length(r->'covenants')<>0
   OR NOT r->'permittedRoots' @> jsonb_build_array(p_budget#>'{original,root}')
   OR (r->>'validUntil')::timestamptz<v_deadline
   OR (r#>>'{horizon,startAt}')::timestamptz>clock_timestamp()
   OR (r#>>'{horizon,startAt}')::timestamptz+
    ((r#>>'{horizon,periodMs}')::numeric*(r#>>'{horizon,periods}')::integer)*interval '1 millisecond'<v_deadline
   OR e->>'resourceId'<>r->>'resourceId' OR e->>'kind'<>v_kind OR e->>'unit'<>v_unit
   OR e->'horizon' IS DISTINCT FROM r->'horizon'
   OR (r#>>'{horizon,periods}')::integer NOT BETWEEN 1 AND 64
   OR (r#>>'{horizon,periodMs}')::numeric<=0
   OR jsonb_array_length(e->'quantities')<>(r#>>'{horizon,periods}')::integer+1
   OR jsonb_array_length(e->'minimumQuantities')<>(r#>>'{horizon,periods}')::integer+1
   OR jsonb_array_length(r->'existingUse')<>(r#>>'{horizon,periods}')::integer+1
   OR jsonb_array_length(r->'availability')<>(r#>>'{horizon,periods}')::integer+1
   OR r->>'safetyMargin' !~ '^(0|[1-9][0-9]{0,15})$'
   ) IS DISTINCT FROM false THEN RAISE EXCEPTION 'Z1 S5 current original resource domain changed'; END IF;
  PERFORM 1 FROM finnor_os.authority_decisions a WHERE a.tenant_id=t AND a.employee_id=u
   AND a.id=(p_budget->'resourceReadDecisionIds'->>v_index)::uuid
   AND a.authority_revision=(p_budget->>'rightsRevision')::integer
   AND a.operation='query' AND a.capability='query:allocation_resources' AND a.risk='low'
   AND a.outcome='allowed' AND a.reason_code='grant_allows'
   AND a.created_at>clock_timestamp()-interval '30 seconds' AND a.created_at<=clock_timestamp()
   AND a.evidence->'resources'=jsonb_build_array(jsonb_build_object('type','allocation_resource','id',r->'scopeRef'->>'id'))
   FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Z1 S5 fresh exact resource read authority required';END IF;
  v_occupation:=array_fill(0::numeric,ARRAY[(r#>>'{horizon,periods}')::integer+1]);
  FOR v_period IN 0..(r#>>'{horizon,periods}')::integer LOOP
   IF e->'quantities'->>v_period IS DISTINCT FROM (CASE WHEN v_index=3 OR v_period=0 THEN v_max::text ELSE '0' END)
    OR e->'minimumQuantities'->>v_period IS DISTINCT FROM '0'
    OR (r->'existingUse'->>v_period ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'Z1 S5 exact original resource envelope required'; END IF;
   v_available:=r->'availability'->v_period;
   IF v_available->>'basis' IS DISTINCT FROM 'REPORTED_AVAILABLE'
    OR (v_available->>'amount' ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'Z1 S5 capacity is unknown'; END IF;
   v_occupation[v_period+1]:=(r->'existingUse'->>v_period)::numeric;
  END LOOP;
  FOR v_row IN SELECT held.value env FROM finnor_os.s5_reservations s
    CROSS JOIN LATERAL jsonb_array_elements(s.envelopes) held
    WHERE s.tenant_id=t AND s.status<>'RELEASED' AND held.value->>'resourceId'=r->>'resourceId' LOOP
    IF (v_row.env->'horizon' IS DISTINCT FROM r->'horizon' OR v_row.env->>'kind'<>v_kind OR v_row.env->>'unit'<>v_unit
     OR jsonb_array_length(v_row.env->'quantities')<>(r#>>'{horizon,periods}')::integer+1
     OR jsonb_array_length(v_row.env->'minimumQuantities')<>(r#>>'{horizon,periods}')::integer+1
     OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_row.env->'quantities') q
      WHERE (q.value ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_row.env->'minimumQuantities') q
      WHERE (q.value ~ '^(0|[1-9][0-9]{0,15})$') IS DISTINCT FROM true)
     ) IS DISTINCT FROM false
     THEN RAISE EXCEPTION 'Z1 S5 complete common resource horizon required'; END IF;
    FOR v_period IN 0..(r#>>'{horizon,periods}')::integer LOOP
     IF (v_row.env->'minimumQuantities'->>v_period)::numeric>(v_row.env->'quantities'->>v_period)::numeric
      THEN RAISE EXCEPTION 'Z1 S5 original occupation interval required'; END IF;
     v_occupation[v_period+1]:=v_occupation[v_period+1]+(v_row.env->'quantities'->>v_period)::numeric;
    END LOOP;
  END LOOP;
  v_used:=0;
  FOR v_period IN 0..(r#>>'{horizon,periods}')::integer LOOP
   v_used:=CASE WHEN v_index=3 THEN v_occupation[v_period+1] ELSE v_used+v_occupation[v_period+1] END;
   v_available:=r->'availability'->v_period;
   IF v_used+v_max>(v_available->>'amount')::numeric-(r->>'safetyMargin')::numeric
    THEN RAISE EXCEPTION 'Z1 S5 shared portfolio exhausted'; END IF;
  END LOOP;
 END LOOP;
 INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate)
  VALUES(t,u,p_certificate->'ref'->>'contentDigest',p_problem,p_certificate);
 INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest,allocation_digest)
  VALUES(t,u,'z1-original:'||v_work::text,p_digest,p_certificate->'ref'->>'contentDigest');
 INSERT INTO finnor_os.s5_reservation_origins(tenant_id,principal_id,reservation_id,allocation_digest,body)
  VALUES(t,u,p_budget->'ref'->>'id',p_certificate->'ref'->>'contentDigest',p_budget);
 INSERT INTO finnor_os.s5_reservations(tenant_id,reservation_id,allocation_digest,revision,status,envelopes)
  VALUES(t,p_budget->'ref'->>'id',p_certificate->'ref'->>'contentDigest',1,'RESERVED',p_budget->'envelopes');
 RETURN p_budget;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.z1_s5_outstanding()
 RETURNS TABLE(reservation_ref jsonb,certificate_ref jsonb,envelopes jsonb,status text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE u uuid:=finnor_os.z1_s5_actor();
BEGIN
 PERFORM * FROM finnor_os.z1_s5_portfolio_population();
 RETURN QUERY SELECT o.body->'ref',o.body->'certificateRef',s.envelopes,s.status
  FROM finnor_os.s5_reservations s JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
  WHERE s.tenant_id=finnor_os.request_tenant_id() AND s.status<>'RELEASED'
   AND o.body->>'schema'='finnor.s5.z1-original-budget.v1' ORDER BY s.reservation_id LIMIT 1001;
END $$;

REVOKE ALL ON FUNCTION finnor_os.z1_s5_portfolio_population() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.z1_s5_reserve(jsonb,jsonb,jsonb,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.z1_s5_outstanding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.z1_s5_portfolio_population(),
 finnor_os.z1_s5_reserve(jsonb,jsonb,jsonb,text,text,text),finnor_os.z1_s5_outstanding() TO finnor_app;
