-- SOURCE ONLY, NOT APPLIED. Integration reserved0204, ledger1568f2ab953ed78d7cd6da687ed39704635defb20a432a624c9dfaf897231d66.
-- Dedicated NOLOGIN roles are not genuine enrollment or deployed authority.
DO $roles$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['finnor_specialist_owner','finnor_specialist_adapter',
  'finnor_specialist_candidate','finnor_specialist_proof','finnor_specialist_projection','finnor_specialist_reader']
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=n) THEN
   EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',n);
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=n AND
   (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
   RAISE EXCEPTION 'SPECIALIST_ROLE_UNSAFE';
  END IF;
 END LOOP;
END $roles$;
CREATE SCHEMA finnor_specialist AUTHORIZATION finnor_specialist_owner;
REVOKE ALL ON SCHEMA finnor_specialist FROM PUBLIC;
GRANT USAGE ON SCHEMA finnor_specialist TO finnor_specialist_adapter,finnor_specialist_candidate,
 finnor_specialist_proof,finnor_specialist_projection,finnor_specialist_reader;
GRANT USAGE ON SCHEMA finnor_os TO finnor_specialist_owner;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system(),pg_catalog.pg_control_checkpoint() TO finnor_specialist_owner;
SET ROLE finnor_specialist_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA finnor_specialist REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA finnor_specialist REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE finnor_specialist.enrollments(
 digest text PRIMARY KEY CHECK(digest~'^[a-f0-9]{64}$'),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,
 body jsonb NOT NULL,authenticated_evidence jsonb NOT NULL,
 UNIQUE(tenant_id,principal_id,digest),CHECK(octet_length(body::text)<=1048576),
 CHECK(octet_length(authenticated_evidence::text)<=4194304));
CREATE TABLE finnor_specialist.domains(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,enrollment_digest text NOT NULL,
 epoch bigint NOT NULL CHECK(epoch>0),status text NOT NULL CHECK(status IN('ACTIVE','PENDING')),
 history_digest text NOT NULL,history_evidence jsonb NOT NULL,canonical_state jsonb NOT NULL,
 pending_id text,PRIMARY KEY(tenant_id,principal_id),
 FOREIGN KEY(enrollment_digest) REFERENCES finnor_specialist.enrollments(digest),
 CHECK((status='PENDING')=(pending_id IS NOT NULL)));
CREATE TABLE finnor_specialist.transitions(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,id text NOT NULL,epoch bigint NOT NULL,
 original jsonb NOT NULL,original_digest text NOT NULL,prior_history_digest text NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,id),UNIQUE(tenant_id,principal_id,epoch),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_specialist.domains(tenant_id,principal_id));
CREATE TABLE finnor_specialist.transition_decisions(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,id text NOT NULL,evidence jsonb NOT NULL,
 history_digest text NOT NULL,PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,id) REFERENCES finnor_specialist.transitions(tenant_id,principal_id,id));
CREATE TABLE finnor_specialist.case_holds(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,commitment text NOT NULL,
 original_owner_digest text NOT NULL,transition_id text NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,commitment),
 FOREIGN KEY(tenant_id,principal_id,transition_id) REFERENCES finnor_specialist.transitions(tenant_id,principal_id,id));
CREATE TABLE finnor_specialist.transition_steps(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,transition_id text NOT NULL,
 step_id text NOT NULL,original_step jsonb NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,transition_id,step_id),
 FOREIGN KEY(tenant_id,principal_id,transition_id) REFERENCES finnor_specialist.transitions(tenant_id,principal_id,id));
CREATE TABLE finnor_specialist.publication_markers(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,publication_id text NOT NULL,
 programme_id uuid NOT NULL,assignment_id text NOT NULL,original_work_id uuid NOT NULL,
 original jsonb NOT NULL,original_digest text NOT NULL,original_xid8 xid8 NOT NULL,
 original_backend_pid integer NOT NULL,original_backend_start timestamptz NOT NULL,
 primary_identity jsonb NOT NULL,marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,publication_id),
 UNIQUE(tenant_id,principal_id,original_work_id,assignment_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_specialist.domains(tenant_id,principal_id),
 CHECK(publication_id~'^[a-f0-9]{64}$'));
CREATE TABLE finnor_specialist.candidates(
 tenant_id uuid NOT NULL,publication_id text NOT NULL,principal_id uuid NOT NULL,
 programme_id uuid NOT NULL,assignment_id text NOT NULL,candidate jsonb NOT NULL,candidate_digest text NOT NULL,
 proposed_delta jsonb NOT NULL,locked_program jsonb NOT NULL,locked_heads jsonb NOT NULL,
 locked_native_input jsonb NOT NULL,original_sources jsonb NOT NULL,original_evidence jsonb NOT NULL,original_intent jsonb NOT NULL,
 original_result jsonb NOT NULL,original_xid8 xid8 NOT NULL,pre_observation jsonb NOT NULL,
 s8_epoch bigint NOT NULL,PRIMARY KEY(tenant_id,publication_id),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES finnor_specialist.publication_markers(tenant_id,publication_id),
 CHECK((candidate->>'schema') IS NOT DISTINCT FROM 'finnor.w2.original-publication-candidate.v1'),
 CHECK(candidate_digest~'^[a-f0-9]{64}$'),CHECK(octet_length(proposed_delta::text)<=4194304),
 CHECK(octet_length(locked_native_input::text)<=8388608));
CREATE TABLE finnor_specialist.original_upper_observations(
 tenant_id uuid NOT NULL,publication_id text NOT NULL,post_observation jsonb NOT NULL,
 PRIMARY KEY(tenant_id,publication_id),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES finnor_specialist.candidates(tenant_id,publication_id),
 CHECK(post_observation->>'phase' IS NOT DISTINCT FROM 'AFTER_COMMITTED'),
 CHECK(post_observation->>'commitStatus' IS NOT DISTINCT FROM 'committed'));
CREATE TABLE finnor_specialist.decisions(
 tenant_id uuid NOT NULL,publication_id text NOT NULL,decision jsonb NOT NULL,
 decision_digest text NOT NULL,proof_evidence jsonb NOT NULL,
 PRIMARY KEY(tenant_id,publication_id),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES finnor_specialist.candidates(tenant_id,publication_id),
 CHECK((decision->>'status') IS NOT DISTINCT FROM 'ACCEPTED_ORIGINAL_COMMIT'),
 CHECK(decision_digest~'^[a-f0-9]{64}$'),CHECK(octet_length(proof_evidence::text)<=8388608));
CREATE TABLE finnor_specialist.projections(
 tenant_id uuid NOT NULL,publication_id text NOT NULL,status text NOT NULL
 CHECK(status IN('APPLIED_ORIGINAL_HISTORY','CONFLICT_HISTORY_RETAINED')),
 decision_digest text NOT NULL,observed_revision bigint NOT NULL,
 PRIMARY KEY(tenant_id,publication_id),
 FOREIGN KEY(tenant_id,publication_id) REFERENCES finnor_specialist.decisions(tenant_id,publication_id));

CREATE FUNCTION finnor_specialist.immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_HISTORY_IMMUTABLE'; END $$;
DO $immutable$
DECLARE n text;
BEGIN
 FOREACH n IN ARRAY ARRAY['enrollments','transitions','transition_decisions','case_holds','transition_steps',
  'publication_markers','candidates','original_upper_observations','decisions','projections']
 LOOP EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON finnor_specialist.%I
  FOR EACH ROW EXECUTE FUNCTION finnor_specialist.immutable()',n);END LOOP;
END $immutable$;
CREATE FUNCTION finnor_specialist.primary_identity() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('systemIdentifier',s.system_identifier::text,'databaseOid',d.oid::text,
  'timeline',c.timeline_id::text,'postmasterStartedAt',pg_postmaster_start_time()::text,
  'incarnation',encode(sha256(convert_to(concat_ws(':',s.system_identifier::text,d.oid::text,
   c.timeline_id::text,pg_postmaster_start_time()::text),'UTF8')),'hex'))
 FROM pg_control_system() s CROSS JOIN pg_control_checkpoint() c
 JOIN pg_database d ON d.datname=current_database()
 WHERE NOT pg_is_in_recovery()
$$;
CREATE FUNCTION finnor_specialist.assert_role(t uuid,p uuid,kind text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE expected text;
BEGIN
 SELECT e.body->'roles'->>kind INTO STRICT expected FROM finnor_specialist.enrollments e JOIN finnor_specialist.domains d
 ON d.enrollment_digest=e.digest WHERE d.tenant_id=t AND d.principal_id=p;
 IF expected IS NULL OR session_user IS DISTINCT FROM expected THEN RAISE EXCEPTION 'SPECIALIST_AUTHENTICATED_ROLE_REQUIRED';END IF;
END $$;
CREATE FUNCTION finnor_specialist.enroll(b jsonb,evidence jsonb,state jsonb,history jsonb,edigest text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE t uuid:=(b->>'tenantId')::uuid;p uuid:=(b->>'principalId')::uuid;
BEGIN
 IF session_user IS DISTINCT FROM b->'roles'->>'adapter' OR b->'primary' IS DISTINCT FROM primary_identity()
  OR b->>'historyDigest' IS DISTINCT FROM history->>'historyDigest'
  OR b->>'s6PrefixDigest' IS DISTINCT FROM history->>'s6PrefixDigest'
  OR b->>'holdsDigest' IS DISTINCT FROM history->>'holdsDigest'
  OR b->>'protectedWitnessDigest' IS DISTINCT FROM history->>'protectedWitnessDigest'
  OR b->>'schema' IS DISTINCT FROM 'finnor.s8.canonical-specialist-enrollment.v1'
 THEN RAISE EXCEPTION 'SPECIALIST_ENROLLMENT_HISTORY_OR_PRIMARY';END IF;
 INSERT INTO finnor_specialist.enrollments VALUES(edigest,t,p,b,evidence);
 INSERT INTO finnor_specialist.domains VALUES(t,p,edigest,1,'ACTIVE',history->>'historyDigest',history,state,NULL);
END $$;
CREATE FUNCTION finnor_specialist.begin_transition(t uuid,p uuid,id text,original jsonb,
 odigest text,prior text,holds jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE d finnor_specialist.domains;hold jsonb;existing finnor_specialist.transitions;
BEGIN
 PERFORM assert_role(t,p,'adapter');
 SELECT * INTO STRICT d FROM finnor_specialist.domains WHERE tenant_id=t AND principal_id=p FOR UPDATE;
 SELECT * INTO existing FROM finnor_specialist.transitions WHERE tenant_id=t AND principal_id=p AND finnor_specialist.transitions.id=begin_transition.id;
 IF FOUND THEN
  IF existing.original_digest<>odigest OR existing.original IS DISTINCT FROM original THEN
   RAISE EXCEPTION 'SPECIALIST_TRANSITION_SUBSTITUTION';END IF;
  RETURN jsonb_build_object('created',false,'epoch',existing.epoch::text,'id',id);
 END IF;
 IF d.status<>'ACTIVE' OR d.history_digest<>prior THEN RAISE EXCEPTION 'SPECIALIST_UNRESOLVED_HISTORY';END IF;
 INSERT INTO finnor_specialist.transitions VALUES(t,p,id,d.epoch+1,original,odigest,prior);
 FOR hold IN SELECT value FROM jsonb_array_elements(holds) LOOP
  INSERT INTO finnor_specialist.case_holds VALUES(t,p,hold->>'commitment',hold->>'originalOwnerDigest',id);
 END LOOP;
 UPDATE finnor_specialist.domains SET epoch=d.epoch+1,status='PENDING',pending_id=id WHERE tenant_id=t AND principal_id=p;
 RETURN jsonb_build_object('created',true,'epoch',(d.epoch+1)::text,'id',id);
END $$;
CREATE FUNCTION finnor_specialist.finalize_transition(t uuid,p uuid,id text,
 history jsonb,state jsonb,evidence jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE d finnor_specialist.domains;tr finnor_specialist.transitions;
BEGIN
 PERFORM assert_role(t,p,'adapter');
 SELECT * INTO STRICT d FROM finnor_specialist.domains WHERE tenant_id=t AND principal_id=p FOR UPDATE;
 SELECT * INTO STRICT tr FROM finnor_specialist.transitions WHERE tenant_id=t AND principal_id=p AND finnor_specialist.transitions.id=finalize_transition.id;
 IF d.status<>'PENDING' OR d.pending_id<>id OR d.epoch<>tr.epoch
  OR evidence->>'originalDigest' IS DISTINCT FROM tr.original_digest
  OR history->>'previousHistoryDigest' IS DISTINCT FROM tr.prior_history_digest
 THEN RAISE EXCEPTION 'SPECIALIST_EXACT_ORIGINAL_HISTORY_REQUIRED';END IF;
 INSERT INTO finnor_specialist.transition_decisions VALUES(t,p,id,evidence,history->>'historyDigest');
 UPDATE finnor_specialist.domains SET status='ACTIVE',pending_id=NULL,history_digest=history->>'historyDigest',
  history_evidence=history,canonical_state=state WHERE tenant_id=t AND principal_id=p;
END $$;
CREATE FUNCTION finnor_specialist.reserve_transition_step(t uuid,p uuid,id text,sid text,step jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE d finnor_specialist.domains;
BEGIN
 PERFORM assert_role(t,p,'adapter');
 SELECT * INTO STRICT d FROM finnor_specialist.domains WHERE tenant_id=t AND principal_id=p FOR SHARE;
 IF d.status<>'PENDING' OR d.pending_id<>id THEN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_PENDING_STEP_REQUIRED';END IF;
 INSERT INTO finnor_specialist.transition_steps VALUES(t,p,id,sid,step) ON CONFLICT DO NOTHING;
 RETURN FOUND;
END $$;
CREATE FUNCTION finnor_specialist.read_domain(t uuid,p uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE d finnor_specialist.domains;e finnor_specialist.enrollments;
BEGIN
 SELECT * INTO STRICT d FROM finnor_specialist.domains WHERE tenant_id=t AND principal_id=p;
 SELECT * INTO STRICT e FROM finnor_specialist.enrollments WHERE digest=d.enrollment_digest;
 IF NOT COALESCE(session_user=ANY(ARRAY[e.body->'roles'->>'adapter',e.body->'roles'->>'candidate',
  e.body->'roles'->>'proof',e.body->'roles'->>'projection',e.body->'roles'->>'reader']),false)
 THEN RAISE EXCEPTION 'SPECIALIST_AUTHENTICATED_READER_REQUIRED';END IF;
 RETURN jsonb_build_object('domain',to_jsonb(d),'enrollment',e.body,'primary',primary_identity(),
  'pendingOriginal',(SELECT tr.original FROM finnor_specialist.transitions tr WHERE tr.tenant_id=t AND tr.principal_id=p AND tr.id=d.pending_id));
END $$;
CREATE FUNCTION finnor_specialist.reserve_original(t uuid,p uuid,pub text,
 original jsonb,odigest text,original_xid xid8,pid integer,backend_start timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE d finnor_specialist.domains;
BEGIN
 PERFORM assert_role(t,p,'candidate');
 SELECT * INTO STRICT d FROM finnor_specialist.domains WHERE tenant_id=t AND principal_id=p FOR SHARE;
 IF d.status<>'ACTIVE' OR NOT EXISTS(SELECT 1 FROM pg_stat_activity a
  WHERE a.pid=reserve_original.pid AND a.backend_start=reserve_original.backend_start
   AND a.backend_xid::text=mod(original_xid::text::numeric,4294967296)::text
   AND a.usename=session_user AND a.datname=current_database() AND a.state='idle in transaction')
 THEN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_PRIMARY_TRANSACTION_REQUIRED';END IF;
 INSERT INTO finnor_specialist.publication_markers VALUES(t,p,pub,(original->>'programmeId')::uuid,
  original->>'assignmentId',(original->>'originalWorkId')::uuid,original,odigest,original_xid,
  pid,backend_start,primary_identity(),clock_timestamp()) ON CONFLICT DO NOTHING;
 RETURN FOUND;
END $$;
CREATE FUNCTION finnor_specialist.insert_candidate(t uuid,p uuid,b jsonb,bdigest text,
 delta jsonb,native_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE m finnor_specialist.publication_markers;d finnor_specialist.domains;q finnor_os.w2_programs;job finnor_os.jobs;
 xid xid8:=pg_current_xact_id();heads jsonb;pre jsonb;pub text:=b->>'publicationId';
 original_evidence jsonb;original_intent jsonb;original_result jsonb;original_sources jsonb;model_possible jsonb;native_ready jsonb;
BEGIN
 PERFORM assert_role(t,p,'candidate');
 PERFORM set_config('app.tenant_id',t::text,true);
 PERFORM set_config('app.user_id',p::text,true);
 -- One globally consistent outer order; native/S5 helpers retain their actual
 -- source locks on this same transaction/connection until the real COMMIT.
 PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||t::text,0));
 SELECT * INTO STRICT q FROM finnor_os.w2_programs WHERE tenant_id=t AND id=(b->>'programmeId')::uuid FOR UPDATE;
 PERFORM 1 FROM finnor_os.works WHERE tenant_id=t AND id=q.work_id FOR SHARE;
 PERFORM 1 FROM finnor_os.work_inputs WHERE tenant_id=t AND id=q.work_input_id FOR SHARE;
 SELECT * INTO STRICT m FROM finnor_specialist.publication_markers WHERE tenant_id=t AND publication_id=pub FOR SHARE;
 SELECT * INTO STRICT d FROM finnor_specialist.domains WHERE tenant_id=t AND principal_id=p FOR SHARE;
 SELECT * INTO STRICT job FROM finnor_os.jobs WHERE tenant_id=t AND id=(b->>'jobId')::uuid FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM finnor_specialist.candidate_transactions x WHERE x.backend_pid=pg_backend_pid() AND x.xid=pg_current_xact_id()
   AND x.tenant_id=t AND x.principal_id=p AND x.programme_id=q.id AND x.assignment_id=b->>'assignmentId'
   AND x.work_id=q.work_id AND x.input_id=q.work_input_id AND x.job_id=job.id)
  OR m.principal_id IS DISTINCT FROM p OR m.original_xid8 IS DISTINCT FROM xid OR m.original_backend_pid IS DISTINCT FROM pg_backend_pid()
  OR m.primary_identity IS DISTINCT FROM primary_identity() OR d.status<>'ACTIVE'
  OR d.epoch::text IS DISTINCT FROM b->>'s8Epoch' OR d.enrollment_digest IS DISTINCT FROM b->>'enrollmentDigest'
  OR q.principal_id IS DISTINCT FROM p OR q.work_id::text IS DISTINCT FROM b->>'originalWorkId' OR q.work_input_id::text IS DISTINCT FROM b->>'originalInputId'
  OR q.original_digest IS DISTINCT FROM b->>'originalMeaningDigest' OR q.revision IS DISTINCT FROM (b->>'nativeRevision')::bigint
  OR job.status IS DISTINCT FROM 'running' OR job.claim_fence::text IS DISTINCT FROM b->>'claimFence'
  OR job.payload->>'programId' IS DISTINCT FROM q.id::text OR job.payload->>'principalId' IS DISTINCT FROM p::text
  OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
  OR b->'primary' IS DISTINCT FROM m.primary_identity OR m.original IS DISTINCT FROM b
  OR EXISTS(SELECT 1 FROM finnor_specialist.candidates c WHERE c.tenant_id=t AND c.publication_id=pub)
 THEN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_CANDIDATE_BINDING_FENCED';END IF;
 SELECT to_jsonb(v) INTO STRICT original_evidence FROM finnor_os.evidence_source_versions v
  WHERE v.tenant_id=t AND v.id=(b->'resultRef'->>'id')::uuid FOR SHARE;
 SELECT ev.body INTO STRICT original_intent FROM finnor_os.w2_events ev
  WHERE ev.tenant_id=t AND ev.program_id=q.id AND ev.event_id='s6-intent:'||(b->>'assignmentId') FOR SHARE;
 SELECT ev.body INTO STRICT original_result FROM finnor_os.w2_events ev
  WHERE ev.tenant_id=t AND ev.program_id=q.id AND ev.event_id='s6-result:'||(b->>'assignmentId') FOR SHARE;
 IF original_result->'evidenceRef' IS DISTINCT FROM b->'resultRef'
  OR original_result->>'bindingDigest' IS DISTINCT FROM b->>'bindingDigest'
  OR original_intent->>'bindingDigest' IS DISTINCT FROM b->>'bindingDigest'
  OR original_evidence->>'content_hash' IS DISTINCT FROM b->'resultRef'->>'contentDigest'
  OR original_evidence->>'version_number' IS DISTINCT FROM b->'resultRef'->>'version'
  OR original_result->'execution'->>'successful' IS DISTINCT FROM 'true'
  OR encode(sha256(convert_to(job.claim_token::text,'UTF8')),'hex') IS DISTINCT FROM b->>'claimTokenDigest'
 THEN RAISE EXCEPTION 'SPECIALIST_ACTUAL_ORIGINAL_S1_S6_SOURCE_REQUIRED';END IF;
 SELECT jsonb_build_object('work',to_jsonb(w),'input',to_jsonb(i)) INTO STRICT original_sources
  FROM (SELECT * FROM finnor_os.works WHERE tenant_id=t AND id=q.work_id FOR SHARE) w
  JOIN (SELECT * FROM finnor_os.work_inputs WHERE tenant_id=t AND id=q.work_input_id FOR SHARE) i
   ON i.work_id=w.id;
 SELECT body INTO STRICT model_possible FROM finnor_os.w2_events WHERE tenant_id=t AND program_id=q.id
  AND event_id='specialist-model-possible:'||(b->>'assignmentId') FOR SHARE;
 SELECT body INTO STRICT native_ready FROM finnor_os.w2_events WHERE tenant_id=t AND program_id=q.id
  AND event_id='specialist-native-ready:'||(b->>'assignmentId') AND kind='SPECIALIST_NATIVE_READY' FOR SHARE;
 IF model_possible->>'bindingDigest' IS DISTINCT FROM b->>'bindingDigest'
  OR native_ready->>'bindingDigest' IS DISTINCT FROM b->>'bindingDigest'
  OR native_ready->>'publicationId' IS DISTINCT FROM pub
  OR native_ready->'hostReference' IS DISTINCT FROM model_possible->'hostReference'
  OR native_ready->'nativeBootstrap' IS DISTINCT FROM model_possible->'nativeBootstrap'
 THEN RAISE EXCEPTION 'SPECIALIST_ACTUAL_MODEL_BOUNDARY_REQUIRED';END IF;
 original_sources:=original_sources||jsonb_build_object('modelPossible',model_possible,'nativeReady',native_ready,'creationEvidence',
  COALESCE((SELECT jsonb_agg(jsonb_build_object('event',to_jsonb(x.ev),
   'version',to_jsonb(x.v),'source',to_jsonb(x.s))) FROM
   (SELECT ev,v,s FROM finnor_os.w2_events ev
    JOIN finnor_os.evidence_source_versions v ON v.tenant_id=ev.tenant_id
     AND v.id=(ev.body->'observation'->'ref'->>'id')::uuid
    JOIN finnor_os.evidence_sources s ON s.tenant_id=v.tenant_id AND s.id=v.source_id
    WHERE ev.tenant_id=t AND ev.program_id=q.id AND ev.kind='TASK_CREATION'
    ORDER BY ev.event_id FOR SHARE OF ev,v,s) x),'[]'::jsonb));
 SELECT jsonb_agg(to_jsonb(h) ORDER BY h.assignment_id) INTO heads FROM
  (SELECT * FROM finnor_os.w2_assignment_heads WHERE tenant_id=t AND program_id=q.id
   ORDER BY assignment_id FOR SHARE) h;
 pre:=jsonb_build_object('candidateDigest',bdigest,'publicationId',pub,'xid8',xid::text,
  'primary',primary_identity(),'phase','BEFORE_COMMIT','observedUtcMicros',
  floor(extract(epoch FROM clock_timestamp())*1000000)::bigint::text,
  'commitStatus',pg_xact_status(xid),'commitUtcMicros',NULL,
  'trackCommitTimestamp',current_setting('track_commit_timestamp')='on',
  'synchronousCommit',current_setting('synchronous_commit'),'serverVersion',current_setting('server_version_num')::integer);
 INSERT INTO finnor_specialist.candidates VALUES(t,pub,p,q.id,b->>'assignmentId',b,bdigest,delta,to_jsonb(q),
  COALESCE(heads,'[]'::jsonb),native_input,original_sources,original_evidence,original_intent,original_result,xid,pre,d.epoch);
 RETURN pre;
END $$;
CREATE FUNCTION finnor_specialist.observe_original(t uuid,p uuid,pub text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE c finnor_specialist.candidates;d finnor_specialist.domains;e finnor_specialist.enrollments;s text;ct timestamptz;xmax xid8;post jsonb;
 source_rows jsonb;source_row jsonb;source_count integer;source_programme uuid;
BEGIN
 SELECT * INTO STRICT d FROM finnor_specialist.domains WHERE tenant_id=t AND principal_id=p;
 SELECT * INTO STRICT e FROM finnor_specialist.enrollments WHERE digest=d.enrollment_digest;
 IF NOT COALESCE(session_user=ANY(ARRAY[e.body->'roles'->>'proof',e.body->'roles'->>'candidate',
  e.body->'roles'->>'projection',e.body->'roles'->>'reader']),false) THEN RAISE EXCEPTION 'SPECIALIST_PROOF_READER_REQUIRED';END IF;
 SELECT * INTO c FROM finnor_specialist.candidates WHERE tenant_id=t AND publication_id=pub;
 IF NOT FOUND THEN
  -- The existing reader port also reads one genuine committed pre-model source.
  -- Do not grant another function/role, expose this to candidates, or turn the
  -- source observation into a publication marker. All other absent-original
  -- callers retain their existing NULL/marker-only behavior.
  IF session_user=e.body->'roles'->>'reader'
   AND NOT EXISTS(SELECT 1 FROM finnor_specialist.publication_markers WHERE tenant_id=t AND publication_id=pub) THEN
   IF pub IS NULL OR pub!~'^[a-f0-9]{64}$' OR d.status<>'ACTIVE' THEN
    RAISE EXCEPTION 'SPECIALIST_ORIGINAL_SOURCE_SCOPE_REQUIRED' USING ERRCODE='42501';
   END IF;
   PERFORM set_config('app.tenant_id',t::text,true);
   PERFORM set_config('app.user_id',p::text,true);
   SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]'::jsonb) INTO source_rows FROM (
    SELECT ev.* FROM finnor_os.w2_events ev JOIN finnor_os.w2_programs q
     ON q.tenant_id=ev.tenant_id AND q.id=ev.program_id AND q.principal_id=ev.principal_id
    WHERE ev.tenant_id=t AND ev.principal_id=p AND ev.kind='SPECIALIST_NATIVE_READY'
     AND ev.body->>'publicationId'=pub
    ORDER BY ev.program_id,ev.event_id LIMIT 2
   ) r;
   source_count:=jsonb_array_length(source_rows);
   IF source_count>1 THEN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_NATIVE_SOURCE_AMBIGUOUS';END IF;
   IF source_count=1 THEN
    source_row:=source_rows->0;source_programme:=(source_row->>'program_id')::uuid;
    SELECT jsonb_build_object('schema','finnor.specialist.actual-original-attempt-source.v1',
     'enrollmentDigest',d.enrollment_digest,'epoch',d.epoch::text,'primary',primary_identity(),
     'nativeReady',source_row,'programme',to_jsonb(q),'work',to_jsonb(w),'input',to_jsonb(i),
     'intent',to_jsonb(intent),'budget',budget.body,'consumption',consumption.body,
     'job',jsonb_build_object('id',j.id,'tenantId',j.tenant_id,'status',j.status,'type',j.type,
       'protocolVersion',j.protocol_version,'payload',j.payload,'claimFence',j.claim_fence::text,
       'claimTokenDigest',encode(sha256(convert_to(j.claim_token::text,'UTF8')),'hex'),
       'workerId',j.lease_owner,'currentLeaseLive',j.lease_expires_at>clock_timestamp()),
     'creationEvidence',COALESCE((SELECT jsonb_agg(jsonb_build_object('event',to_jsonb(ev),
       'version',to_jsonb(v),'source',to_jsonb(es)) ORDER BY ev.event_id)
       FROM finnor_os.w2_events ev JOIN finnor_os.evidence_source_versions v
        ON v.tenant_id=ev.tenant_id AND v.id=(ev.body->'observation'->'ref'->>'id')::uuid
       JOIN finnor_os.evidence_sources es ON es.tenant_id=v.tenant_id AND es.id=v.source_id
       WHERE ev.tenant_id=t AND ev.program_id=q.id AND ev.kind='TASK_CREATION'),'[]'::jsonb),
     'heads',(SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.assignment_id),'[]'::jsonb)
       FROM finnor_os.w2_assignment_heads h WHERE h.tenant_id=t AND h.program_id=q.id))
     INTO source_row
     FROM finnor_os.w2_programs q
     JOIN finnor_os.works w ON w.tenant_id=q.tenant_id AND w.id=q.work_id AND w.created_by=p
     JOIN finnor_os.work_inputs i ON i.tenant_id=q.tenant_id AND i.id=q.work_input_id
       AND i.work_id=w.id AND i.created_by=p
     JOIN finnor_os.w2_events intent ON intent.tenant_id=q.tenant_id AND intent.program_id=q.id
       AND intent.principal_id=p AND intent.event_id='s6-intent:'||(source_row->'body'->>'assignmentId')
       AND intent.kind='S6_INTENDED'
     JOIN finnor_os.s5_history budget ON budget.tenant_id=q.tenant_id
       AND budget.subject_id=q.budget->'reservationRef'->>'id'
       AND budget.operation='WORKFORCE_BUDGET' AND budget.revision=1
     JOIN finnor_os.s5_consumptions consumption ON consumption.tenant_id=q.tenant_id
       AND consumption.principal_id=p AND consumption.policy_id::text=q.id::text
       AND consumption.consumption_id=intent.body->'binding'->'consumptionRef'->>'id'
       AND consumption.reservation_id=q.budget->'reservationRef'->>'id'
       AND consumption.body->>'schema'='finnor.s5.workforce-consumption.v1'
     JOIN finnor_os.jobs j ON j.tenant_id=q.tenant_id AND j.id=(intent.body->'binding'->'job'->>'id')::uuid
     WHERE q.tenant_id=t AND q.id=source_programme AND q.principal_id=p
       AND source_row->>'event_id'='specialist-native-ready:'||(source_row->'body'->>'assignmentId')
       AND NOT EXISTS(SELECT 1 FROM finnor_os.w2_events terminal
         WHERE terminal.tenant_id=t AND terminal.program_id=q.id AND terminal.event_id=ANY(ARRAY[
          's6-result:'||(source_row->'body'->>'assignmentId'),
          'recovery:'||(source_row->'body'->>'assignmentId'),
          'specialist-physical-final:'||(source_row->'body'->>'assignmentId')]));
    IF source_row IS NULL OR octet_length(source_row::text)>8388608 THEN
     RAISE EXCEPTION 'SPECIALIST_ORIGINAL_CANONICAL_SOURCE_UNAVAILABLE';
    END IF;
    RETURN jsonb_build_object('preOriginalSource',source_row);
   END IF;
  END IF;
  RETURN (SELECT jsonb_build_object('marker',to_jsonb(m),'candidateRow',NULL,
   'postObservation',NULL,'originalUpperCaptured',false,'decision',NULL,'projection',NULL)
   FROM finnor_specialist.publication_markers m WHERE m.tenant_id=t AND m.principal_id=p AND m.publication_id=pub);
 END IF;
 IF c.principal_id IS DISTINCT FROM p THEN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_PRINCIPAL_MISMATCH';END IF;
 xmax:=pg_snapshot_xmax(pg_current_snapshot());
 IF xmax::text::numeric<c.original_xid8::text::numeric OR
  xmax::text::numeric-c.original_xid8::text::numeric>=2147483648
  OR current_setting('track_commit_timestamp')<>'on'
 THEN RAISE EXCEPTION 'SPECIALIST_FULL_XID_OR_COMMIT_RETENTION_UNKNOWN';END IF;
 s:=pg_xact_status(c.original_xid8);
 IF s IS DISTINCT FROM 'committed' THEN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_COMMIT_UNKNOWN';END IF;
 ct:=pg_xact_commit_timestamp(mod(c.original_xid8::text::numeric,4294967296)::text::xid);
 IF ct IS NULL THEN RAISE EXCEPTION 'SPECIALIST_COMMIT_TIMESTAMP_UNAVAILABLE';END IF;
 SELECT post_observation INTO post FROM finnor_specialist.original_upper_observations WHERE tenant_id=t AND publication_id=pub;
 IF post IS NULL THEN
 post:=jsonb_build_object('candidateDigest',c.candidate_digest,'publicationId',pub,'xid8',c.original_xid8::text,
  'primary',primary_identity(),'phase','AFTER_COMMITTED','observedUtcMicros',
  floor(extract(epoch FROM clock_timestamp())*1000000)::bigint::text,'commitStatus',s,
  'commitUtcMicros',floor(extract(epoch FROM ct)*1000000)::bigint::text,
  'trackCommitTimestamp',true,'synchronousCommit',current_setting('synchronous_commit'),
  'serverVersion',current_setting('server_version_num')::integer);
 END IF;
 RETURN jsonb_build_object('candidateRow',to_jsonb(c),'postObservation',post,
  'originalUpperCaptured',EXISTS(SELECT 1 FROM finnor_specialist.original_upper_observations WHERE tenant_id=t AND publication_id=pub),
  'decision',(SELECT decision FROM finnor_specialist.decisions WHERE tenant_id=t AND publication_id=pub),
  'projection',(SELECT to_jsonb(pr) FROM finnor_specialist.projections pr WHERE tenant_id=t AND publication_id=pub));
END $$;
-- Capture only from the original still-live backend after its known COMMIT.
-- Recovery/proof roles cannot create or replace a later upper endpoint.
CREATE FUNCTION finnor_specialist.capture_original_upper(t uuid,p uuid,pub text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE c finnor_specialist.candidates;m finnor_specialist.publication_markers;post jsonb;started timestamptz;
BEGIN
 PERFORM assert_role(t,p,'candidate');
 SELECT * INTO STRICT c FROM finnor_specialist.candidates WHERE tenant_id=t AND principal_id=p AND publication_id=pub;
 SELECT * INTO STRICT m FROM finnor_specialist.publication_markers WHERE tenant_id=t AND principal_id=p AND publication_id=pub;
 SELECT backend_start INTO STRICT started FROM pg_stat_activity WHERE pid=pg_backend_pid();
 IF m.original_backend_pid IS DISTINCT FROM pg_backend_pid()
  OR m.original_backend_start IS DISTINCT FROM started OR m.original_xid8 IS DISTINCT FROM c.original_xid8
 THEN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_LIVE_BACKEND_REQUIRED';END IF;
 SELECT post_observation INTO post FROM finnor_specialist.original_upper_observations WHERE tenant_id=t AND publication_id=pub;
 IF FOUND THEN RETURN post;END IF;
 post:=observe_original(t,p,pub)->'postObservation';
 IF post->>'phase' IS DISTINCT FROM 'AFTER_COMMITTED' OR post->>'commitStatus' IS DISTINCT FROM 'committed'
  OR post->>'candidateDigest' IS DISTINCT FROM c.candidate_digest
  OR post->>'xid8' IS DISTINCT FROM c.original_xid8::text OR post->'primary' IS DISTINCT FROM c.candidate->'primary'
 THEN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_COMMITTED_UPPER_UNAVAILABLE';END IF;
 INSERT INTO finnor_specialist.original_upper_observations VALUES(t,pub,post);
 RETURN post;
END $$;
CREATE FUNCTION finnor_specialist.decide_original(t uuid,p uuid,pub text,
 decision jsonb,ddigest text,evidence jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE c finnor_specialist.candidates;
BEGIN
 PERFORM assert_role(t,p,'proof');
 SELECT * INTO STRICT c FROM finnor_specialist.candidates WHERE tenant_id=t AND publication_id=pub FOR SHARE;
 IF decision->>'candidateDigest' IS DISTINCT FROM c.candidate_digest
  OR decision->>'xid8' IS DISTINCT FROM c.original_xid8::text OR decision->'primary' IS DISTINCT FROM primary_identity()
  OR decision->>'status' IS DISTINCT FROM 'ACCEPTED_ORIGINAL_COMMIT'
  OR decision->>'proposedDeltaDigest' IS DISTINCT FROM c.candidate->>'proposedDeltaDigest'
  OR evidence->'postObservation'->>'commitStatus' IS DISTINCT FROM 'committed'
  OR evidence->'postObservation' IS DISTINCT FROM
   (SELECT post_observation FROM finnor_specialist.original_upper_observations WHERE tenant_id=t AND publication_id=pub)
 THEN RAISE EXCEPTION 'SPECIALIST_EXACT_VERIFIED_DECISION_REQUIRED';END IF;
 INSERT INTO finnor_specialist.decisions VALUES(t,pub,decision,ddigest,evidence);
END $$;

-- Durable original work selection. A service consumes actual committed rows,
-- never a caller-supplied candidate or a role string from a worker job.
CREATE FUNCTION finnor_specialist.list_original_publications(t uuid,p uuid,after_id text,maximum integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE e finnor_specialist.enrollments;d finnor_specialist.domains;kind text;result jsonb;
BEGIN
 IF maximum IS NULL OR maximum<1 OR maximum>64 OR after_id IS NULL
  OR after_id<>'' AND after_id!~'^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_SERVICE_BOUND_REQUIRED';END IF;
 SELECT * INTO STRICT d FROM finnor_specialist.domains WHERE tenant_id=t AND principal_id=p;
 SELECT * INTO STRICT e FROM finnor_specialist.enrollments WHERE digest=d.enrollment_digest;
 kind:=CASE session_user WHEN e.body->'roles'->>'proof' THEN 'proof'
  WHEN e.body->'roles'->>'projection' THEN 'projection' WHEN e.body->'roles'->>'reader' THEN 'reader' ELSE NULL END;
 IF kind IS NULL THEN RAISE EXCEPTION 'SPECIALIST_INDEPENDENT_SERVICE_LOGIN_REQUIRED';END IF;
 SELECT COALESCE(jsonb_agg(pending_rows.publication_id ORDER BY pending_rows.publication_id COLLATE "C"),'[]'::jsonb) INTO result
 FROM (SELECT m.publication_id FROM finnor_specialist.publication_markers m
  LEFT JOIN finnor_specialist.candidates c ON c.tenant_id=m.tenant_id AND c.publication_id=m.publication_id
  LEFT JOIN finnor_specialist.original_upper_observations u ON u.tenant_id=m.tenant_id AND u.publication_id=m.publication_id
  LEFT JOIN finnor_specialist.decisions v ON v.tenant_id=m.tenant_id AND v.publication_id=m.publication_id
  LEFT JOIN finnor_specialist.projections r ON r.tenant_id=m.tenant_id AND r.publication_id=m.publication_id
  WHERE m.tenant_id=t AND m.principal_id=p AND m.publication_id COLLATE "C">after_id COLLATE "C" AND r.publication_id IS NULL
   AND (kind='reader' OR kind='proof' AND c.publication_id IS NOT NULL
    AND u.publication_id IS NOT NULL AND v.publication_id IS NULL
    OR kind='projection' AND v.publication_id IS NOT NULL)
  ORDER BY m.publication_id COLLATE "C" LIMIT maximum) pending_rows;
 RETURN result;
END $$;

-- Pending/canonical-decision fences are enforced even on direct native writes.
-- No GUC, producer flag or ordinary app role can bypass this trigger.
-- Private backend+full-xid capability, never a GUC, function-name or query-text flag.
CREATE TABLE finnor_specialist.projection_transactions(
 backend_pid integer NOT NULL,xid xid8 NOT NULL,tenant_id uuid NOT NULL,programme_id uuid NOT NULL,
 publication_id text NOT NULL,PRIMARY KEY(backend_pid,xid,tenant_id,programme_id));
CREATE FUNCTION finnor_specialist.attenuation_only(prior jsonb,next jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT prior IS NOT NULL AND next IS NOT NULL
  AND prior-ARRAY['revision','history','assignments'] IS NOT DISTINCT FROM next-ARRAY['revision','history','assignments']
  AND jsonb_array_length(next->'history')>jsonb_array_length(prior->'history')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prior->'history') WITH ORDINALITY e(v,n)
    WHERE e.v IS DISTINCT FROM next->'history'->((e.n-1)::integer))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(next->'history') WITH ORDINALITY e(v,n)
    WHERE e.n>jsonb_array_length(prior->'history') AND COALESCE(e.v->'action'->>'kind','')
      NOT IN('BLOCK','RETURN','DISPUTE','CANCEL','CONFIRM_CANCEL','MARK_UNKNOWN_EFFECT','REVOKE'))
  AND jsonb_array_length(prior->'assignments')=jsonb_array_length(next->'assignments')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prior->'assignments') a
    LEFT JOIN LATERAL(SELECT b FROM jsonb_array_elements(next->'assignments') b WHERE b->>'id'=a->>'id') n ON true
    WHERE n.b IS NULL OR a-'state' IS DISTINCT FROM n.b-'state'
     OR a->'state' IS DISTINCT FROM n.b->'state' AND COALESCE(n.b->'state'->>'kind','')
      NOT IN('BLOCKED','RETURNED','DISPUTED','CANCEL_REQUESTED','CANCELLED_WITH_RESIDUAL_EXPOSURE','UNKNOWN_EFFECT','REVOKED'))
$$;CREATE FUNCTION finnor_specialist.guard_native_program() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE t uuid;p uuid;unresolved boolean;attenuating boolean;q jsonb;
BEGIN
 t:=COALESCE(NEW.tenant_id,OLD.tenant_id);
 IF TG_TABLE_NAME='w2_programs' THEN p:=OLD.id;ELSE p:=COALESCE(NEW.program_id,OLD.program_id);END IF;
 SELECT EXISTS(SELECT 1 FROM finnor_specialist.publication_markers m LEFT JOIN finnor_specialist.projections pr USING(tenant_id,publication_id)
  WHERE m.tenant_id=t AND m.programme_id=p AND pr.publication_id IS NULL) INTO unresolved;
 IF unresolved AND NOT EXISTS(SELECT 1 FROM finnor_specialist.projection_transactions x WHERE x.backend_pid=pg_backend_pid()
  AND x.xid=pg_current_xact_id() AND x.tenant_id=t AND x.programme_id=p) THEN
  attenuating:=false;
  IF TG_TABLE_NAME='w2_programs' AND TG_OP='UPDATE' THEN
   attenuating:=attenuation_only(OLD.program,NEW.program) OR
    NEW.program IS NOT DISTINCT FROM OLD.program AND NEW.revision=OLD.revision
    AND NEW.status IN('CANCEL_REQUESTED','CANCELLED','STOPPED','FENCED','BLOCKED');
  ELSIF TG_TABLE_NAME='w2_program_revisions' AND TG_OP='INSERT' THEN
   SELECT program INTO STRICT q FROM finnor_os.w2_programs WHERE tenant_id=t AND id=p;
   attenuating:=attenuation_only(q,NEW.program);
  ELSIF TG_TABLE_NAME='w2_assignment_heads' AND TG_OP='UPDATE' THEN
   attenuating:=NEW.body-'state' IS NOT DISTINCT FROM OLD.body-'state'
    AND NEW.holds_capacity=OLD.holds_capacity
    AND (to_jsonb(NEW)-ARRAY['body','state','revision']) IS NOT DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['body','state','revision'])
    AND NEW.state IN('BLOCKED','RETURNED','DISPUTED','CANCEL_REQUESTED','CANCELLED_WITH_RESIDUAL_EXPOSURE','UNKNOWN_EFFECT','REVOKED');
  END IF;
  IF attenuating IS DISTINCT FROM true THEN RAISE EXCEPTION 'SPECIALIST_PENDING_PUBLICATION_FENCE';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;CREATE FUNCTION finnor_specialist.project_original(t uuid,p uuid,pub text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
DECLARE c finnor_specialist.candidates;d finnor_specialist.decisions;q finnor_os.w2_programs;head_delta jsonb;prior finnor_specialist.projections;heads jsonb;ev jsonb;
BEGIN
 PERFORM assert_role(t,p,'projection');
 PERFORM set_config('app.tenant_id',t::text,true);
 PERFORM set_config('app.user_id',p::text,true);
 PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||t::text,0));
 SELECT * INTO STRICT c FROM finnor_specialist.candidates WHERE tenant_id=t AND publication_id=pub;
 SELECT * INTO STRICT d FROM finnor_specialist.decisions WHERE tenant_id=t AND publication_id=pub;
 SELECT * INTO prior FROM finnor_specialist.projections WHERE tenant_id=t AND publication_id=pub;
 IF FOUND THEN RETURN prior.status;END IF;
 SELECT * INTO STRICT q FROM finnor_os.w2_programs WHERE tenant_id=t AND id=c.programme_id FOR UPDATE;
 SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.assignment_id),'[]'::jsonb) INTO heads
 FROM (SELECT * FROM finnor_os.w2_assignment_heads WHERE tenant_id=t AND program_id=q.id
  ORDER BY assignment_id FOR UPDATE) h;
 IF heads IS DISTINCT FROM c.locked_heads OR q.revision<>(c.candidate->>'nativeRevision')::bigint
  OR q.program IS DISTINCT FROM c.locked_program->'program'
  OR q.status IS DISTINCT FROM c.locked_program->>'status'
 THEN
  INSERT INTO finnor_specialist.projections VALUES(t,pub,'CONFLICT_HISTORY_RETAINED',d.decision_digest,q.revision);
  RETURN 'CONFLICT_HISTORY_RETAINED';
 END IF;
 INSERT INTO finnor_specialist.projection_transactions VALUES(pg_backend_pid(),pg_current_xact_id(),t,q.id,pub);
 -- Delta was independently recomputed/checked by the proof role. No late
 -- applyNativeCommand, fresh authority, S5 reservation or model invocation.
 INSERT INTO finnor_os.w2_program_revisions(tenant_id,program_id,principal_id,revision,program,check_result)
 VALUES(t,q.id,p,(c.proposed_delta->'program'->>'revision')::bigint,
  c.proposed_delta->'program',d.decision->'historicalCheck');
 FOR head_delta IN SELECT value FROM jsonb_array_elements(c.proposed_delta->'heads') LOOP
  UPDATE finnor_os.w2_assignment_heads SET body=head_delta->'body',state=head_delta->>'state',
   revision=(head_delta->>'revision')::bigint,holds_capacity=(head_delta->>'holds_capacity')::boolean
   WHERE tenant_id=t AND program_id=q.id AND assignment_id=head_delta->>'assignment_id';
  IF NOT FOUND THEN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_HEAD_CAS_CONFLICT';END IF;
 END LOOP;
 UPDATE finnor_os.w2_programs SET program=c.proposed_delta->'program',
  revision=(c.proposed_delta->'program'->>'revision')::bigint,status=c.proposed_delta->>'status',
  updated_at=clock_timestamp() WHERE tenant_id=t AND id=q.id;
 INSERT INTO finnor_os.w2_events(tenant_id,program_id,principal_id,event_id,kind,request_digest,body)
 VALUES(t,q.id,p,'specialist-original-publication:'||pub,'ORIGINAL_PUBLICATION_DECISION',
  d.decision_digest,d.decision);
 FOR ev IN SELECT value FROM jsonb_array_elements(c.proposed_delta->'events') LOOP
  INSERT INTO finnor_os.w2_events(tenant_id,program_id,principal_id,event_id,kind,request_digest,body)
  VALUES(t,q.id,p,ev->>'event_id',ev->>'kind',ev->>'request_digest',ev->'body');
 END LOOP;
 INSERT INTO finnor_specialist.projections VALUES(t,pub,'APPLIED_ORIGINAL_HISTORY',d.decision_digest,q.revision);
 DELETE FROM finnor_specialist.projection_transactions WHERE backend_pid=pg_backend_pid() AND xid=pg_current_xact_id();
 RETURN 'APPLIED_ORIGINAL_HISTORY';
END $$;

-- Ordinary canonical readers receive an invalidation, not an ACTIVE/current bit.
-- Scope comes from the existing transaction tenant, never a supplied principal.
CREATE FUNCTION finnor_specialist.native_pending(t uuid,programme uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $$
BEGIN
 IF t::text IS DISTINCT FROM current_setting('app.tenant_id',true) THEN
  RAISE EXCEPTION 'SPECIALIST_CANONICAL_READER_TENANT_REQUIRED' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND NOT rolsuper)
  AND pg_has_role(session_user,'finnor_specialist_candidate','MEMBER')
  AND finnor_specialist.candidate_source_row(t,'w2_programs',programme::text) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'SPECIALIST_CANONICAL_CANDIDATE_SCOPE_REQUIRED' USING ERRCODE='42501';
 END IF;
 RETURN (SELECT jsonb_agg(jsonb_build_object('publicationId',m.publication_id,
  'originalDigest',m.original_digest) ORDER BY m.publication_id)
  FROM finnor_specialist.publication_markers m LEFT JOIN finnor_specialist.projections pr USING(tenant_id,publication_id)
  WHERE m.tenant_id=t AND m.programme_id=programme AND pr.publication_id IS NULL);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA finnor_specialist FROM PUBLIC,finnor_specialist_adapter,
 finnor_specialist_candidate,finnor_specialist_proof,finnor_specialist_projection,finnor_specialist_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA finnor_specialist FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_specialist.enroll(jsonb,jsonb,jsonb,jsonb,text),
 finnor_specialist.begin_transition(uuid,uuid,text,jsonb,text,text,jsonb),
 finnor_specialist.finalize_transition(uuid,uuid,text,jsonb,jsonb,jsonb),
 finnor_specialist.reserve_transition_step(uuid,uuid,text,text,jsonb) TO finnor_specialist_adapter;
GRANT EXECUTE ON FUNCTION finnor_specialist.reserve_original(uuid,uuid,text,jsonb,text,xid8,integer,timestamptz),
 finnor_specialist.insert_candidate(uuid,uuid,jsonb,text,jsonb,jsonb),
 finnor_specialist.capture_original_upper(uuid,uuid,text) TO finnor_specialist_candidate;
GRANT EXECUTE ON FUNCTION finnor_specialist.native_pending(uuid,uuid) TO finnor_specialist_candidate;
GRANT EXECUTE ON FUNCTION finnor_specialist.decide_original(uuid,uuid,text,jsonb,text,jsonb) TO finnor_specialist_proof;
GRANT EXECUTE ON FUNCTION finnor_specialist.project_original(uuid,uuid,text) TO finnor_specialist_projection;
GRANT EXECUTE ON FUNCTION finnor_specialist.list_original_publications(uuid,uuid,text,integer)
 TO finnor_specialist_proof,finnor_specialist_projection,finnor_specialist_reader;
GRANT EXECUTE ON FUNCTION finnor_specialist.read_domain(uuid,uuid),finnor_specialist.primary_identity(),
 finnor_specialist.observe_original(uuid,uuid,text) TO finnor_specialist_adapter,finnor_specialist_candidate,
 finnor_specialist_proof,finnor_specialist_projection,finnor_specialist_reader;
RESET ROLE;
-- Existing application roles alone may read the pending fence. No authority,
-- adapter, candidate, proof or projection role membership is conferred here.
DO $reader$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
  GRANT USAGE ON SCHEMA finnor_specialist TO finnor_app;
  GRANT EXECUTE ON FUNCTION finnor_specialist.native_pending(uuid,uuid) TO finnor_app;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_worker') THEN
  GRANT USAGE ON SCHEMA finnor_specialist TO finnor_worker;
  GRANT EXECUTE ON FUNCTION finnor_specialist.native_pending(uuid,uuid) TO finnor_worker;
 END IF;
END $reader$;
GRANT SELECT ON finnor_os.w2_programs,finnor_os.w2_assignment_heads,finnor_os.works,
 finnor_os.work_inputs,finnor_os.jobs,finnor_os.evidence_sources,finnor_os.evidence_source_versions,
 finnor_os.w2_events TO finnor_specialist_owner;
GRANT SELECT,UPDATE ON finnor_os.w2_programs,finnor_os.w2_assignment_heads TO finnor_specialist_owner;
GRANT SELECT,INSERT ON finnor_os.w2_program_revisions,finnor_os.w2_events TO finnor_specialist_owner;
CREATE TRIGGER specialist_pending_publication BEFORE UPDATE OR DELETE ON finnor_os.w2_programs
 FOR EACH ROW EXECUTE FUNCTION finnor_specialist.guard_native_program();
CREATE TRIGGER specialist_pending_publication BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.w2_assignment_heads
 FOR EACH ROW EXECUTE FUNCTION finnor_specialist.guard_native_program();
CREATE TRIGGER specialist_pending_publication BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.w2_program_revisions
 FOR EACH ROW EXECUTE FUNCTION finnor_specialist.guard_native_program();

-- Keep the existing least-disclosure recipient projection. Pending originals
-- are withheld, never presented as a current ACTIVE assignment.
CREATE OR REPLACE FUNCTION finnor_os.w2_recipient_program(p_program uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os,pg_temp AS $recipient$
 SELECT jsonb_build_object('id',p.id,'workId',p.work_id,'status',p.status,'revision',p.revision,
   'assignments',jsonb_agg(jsonb_build_object('assignment',h.body,'task',h.task) ORDER BY h.assignment_id))
 FROM finnor_os.w2_programs p JOIN finnor_os.w2_assignment_heads h ON h.tenant_id=p.tenant_id AND h.program_id=p.id
 JOIN finnor_os.users u ON u.tenant_id=h.tenant_id AND u.id=h.recipient_principal_id AND u.status='active'
 WHERE p.tenant_id=finnor_os.request_tenant_id() AND p.id=p_program
  AND h.recipient_principal_id=nullif(current_setting('app.user_id',true),'')::uuid
  AND finnor_specialist.native_pending(p.tenant_id,p.id) IS NULL
 GROUP BY p.id,p.work_id,p.status,p.revision
$recipient$;

-- Same-backend/full-xid source custody precedes all ordinary native/S5 reads.
-- This table is private, not a GUC, caller flag, login membership, or authority.
SET ROLE finnor_specialist_owner;
CREATE TABLE finnor_specialist.candidate_transactions(
 backend_pid integer NOT NULL,xid xid8 NOT NULL,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,
 programme_id uuid NOT NULL,assignment_id text NOT NULL,work_id uuid NOT NULL,input_id uuid NOT NULL,
 job_id uuid NOT NULL,PRIMARY KEY(backend_pid,xid));
CREATE FUNCTION finnor_specialist.open_candidate_scope(t uuid,p uuid,programme uuid,assignment text,
 job_id uuid,claim_fence bigint,claim_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $scope$
DECLARE q finnor_os.w2_programs;j finnor_os.jobs;d finnor_specialist.domains;
BEGIN
 PERFORM assert_role(t,p,'candidate');
 PERFORM set_config('app.tenant_id',t::text,true);
 PERFORM set_config('app.user_id',p::text,true);
 PERFORM pg_advisory_xact_lock(hashtextextended('s5-portfolio:'||t::text,0));
 SELECT * INTO STRICT d FROM finnor_specialist.domains WHERE tenant_id=t AND principal_id=p FOR SHARE;
 IF d.status IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'SPECIALIST_SOURCE_DOMAIN_PENDING'; END IF;
 PERFORM 1 FROM finnor_os.users WHERE tenant_id=t AND id=p AND status='active' AND role='owner' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SPECIALIST_ACTUAL_SOURCE_OWNER_REQUIRED'; END IF;
 SELECT * INTO STRICT q FROM finnor_os.w2_programs WHERE tenant_id=t AND id=programme AND principal_id=p FOR UPDATE;
 SELECT * INTO STRICT j FROM finnor_os.jobs WHERE tenant_id=t AND id=open_candidate_scope.job_id FOR SHARE;
 IF j.type IS DISTINCT FROM 'run_workforce_execution_v1' OR j.status IS DISTINCT FROM 'running'
  OR j.protocol_version IS DISTINCT FROM 1 OR j.claim_fence IS DISTINCT FROM open_candidate_scope.claim_fence
  OR encode(sha256(convert_to(j.claim_token::text,'UTF8')),'hex') IS DISTINCT FROM claim_digest
  OR j.payload->>'programId' IS DISTINCT FROM q.id::text OR j.payload->>'principalId' IS DISTINCT FROM p::text
  OR j.payload->>'tenantId' IS DISTINCT FROM t::text OR j.lease_expires_at IS NULL
  OR j.lease_expires_at<=clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.program->'assignments') a WHERE a->>'id'=assignment)
 THEN RAISE EXCEPTION 'SPECIALIST_ACTUAL_ORIGINAL_SOURCE_CLAIM_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM finnor_specialist.publication_markers m WHERE m.tenant_id=t
   AND m.original->>'originalWorkId'=q.work_id::text AND m.assignment_id=assignment)
 THEN RAISE EXCEPTION 'SPECIALIST_ORIGINAL_MARKER_READ_ONLY_RECONCILIATION'; END IF;
 INSERT INTO finnor_specialist.candidate_transactions VALUES(pg_backend_pid(),pg_current_xact_id(),t,p,programme,assignment,q.work_id,q.work_input_id,j.id);
 RETURN jsonb_build_object('sessionUser',session_user,'currentUser',current_user,
  'backendPid',pg_backend_pid(),'xid8',pg_current_xact_id()::text);
END $scope$;
CREATE FUNCTION finnor_specialist.candidate_source_scope(t uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $scope$
 SELECT EXISTS(SELECT 1 FROM finnor_specialist.candidate_transactions x JOIN finnor_specialist.domains d
  ON d.tenant_id=x.tenant_id AND d.principal_id=x.principal_id JOIN finnor_specialist.enrollments e ON e.digest=d.enrollment_digest
  WHERE x.backend_pid=pg_backend_pid() AND x.xid=pg_current_xact_id() AND x.tenant_id=t
   AND t::text=current_setting('app.tenant_id',true) AND x.principal_id::text=current_setting('app.user_id',true)
   AND e.body->'roles'->>'candidate'=session_user AND d.status='ACTIVE')
$scope$;
CREATE FUNCTION finnor_specialist.candidate_source_row(t uuid,source text,row_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $scope$
 SELECT EXISTS(SELECT 1 FROM finnor_specialist.candidate_transactions x WHERE x.backend_pid=pg_backend_pid()
  AND x.xid=pg_current_xact_id() AND x.tenant_id=t AND finnor_specialist.candidate_source_scope(t)
  AND row_id=CASE source WHEN 'works' THEN x.work_id::text WHEN 'work_inputs' THEN x.input_id::text
   WHEN 'jobs' THEN x.job_id::text WHEN 'w2_programs' THEN x.programme_id::text
   WHEN 'w2_program_revisions' THEN x.programme_id::text WHEN 'w2_assignment_heads' THEN x.programme_id::text
   WHEN 'w2_events' THEN x.programme_id::text WHEN 'w2_dependencies' THEN x.programme_id::text ELSE NULL END)
$scope$;
-- A second boundary rejects real UPDATE even through an existing definer.
-- WITH CHECK(false) is additional protection, not the sole write-denial proof.
-- PostgreSQL reports implicit membership in every role for a superuser.
CREATE FUNCTION finnor_specialist.deny_candidate_source_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $scope$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND NOT rolsuper)
  AND pg_has_role(session_user,'finnor_specialist_candidate','MEMBER') THEN
  RAISE EXCEPTION 'SPECIALIST_SOURCE_ROW_LOCK_ONLY_NO_MUTATION';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $scope$;
REVOKE ALL ON finnor_specialist.candidate_transactions FROM PUBLIC,finnor_specialist_candidate;
REVOKE ALL ON FUNCTION finnor_specialist.open_candidate_scope(uuid,uuid,uuid,text,uuid,bigint,text),
 finnor_specialist.candidate_source_scope(uuid),finnor_specialist.candidate_source_row(uuid,text,text),
 finnor_specialist.deny_candidate_source_write() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_specialist.open_candidate_scope(uuid,uuid,uuid,text,uuid,bigint,text),
 finnor_specialist.candidate_source_scope(uuid),finnor_specialist.candidate_source_row(uuid,text,text)
 TO finnor_specialist_candidate;
RESET ROLE;

-- Finite loader roster. Preserve the application's original permissive OR and
-- restrictive AND expressions, then AND private candidate custody. No membership
-- in finnor_app/worker is granted. CURRENT_USER-sensitive privacy is evaluated
-- with original application semantics, not silently bypassed by the new role.
-- A previously non-RLS source preserves its old behavior for every other role.
DO $source_acl$
DECLARE n text;had_rls boolean;source_oid oid;predicate text;native_select text;native_restrict text;
 native_read text;owner_read text;privacy text;lock_tables text[]:=ARRAY[
 'users','works','work_inputs','jobs','w2_programs','authority_states','employee_actor_profiles',
 'delegations','employee_role_assignments','external_contacts','w2_contact_bindings','s5_reservations'];
BEGIN
 FOREACH n IN ARRAY ARRAY[
 'users','works','work_inputs','jobs','w2_programs','w2_program_revisions','w2_assignment_heads','w2_events','w2_dependencies',
 'evidence_sources','evidence_source_versions','authority_states','employee_roles','employee_role_assignments',
 'role_authority_grants','role_permissions','employee_actor_profiles','delegations','external_contacts',
 'w2_contact_bindings','w2_contact_binding_events','p4_derivations',
 's5_resources','s5_resource_heads','s5_reservations','s5_reservation_origins','s5_proposals','s5_history',
 's5_consumptions','s5_consumption_states','s5_governed_resource_charges',
 's5_workforce_payment_requests','s5_workforce_payment_observations',
 'pe_closing_programmes','pe_closing_profiles','pe_closing_node_links','business_effects','external_operations',
 'pe_closing_evidence_bindings','pe_closing_checks','pe_closed_transaction_certificates','pe_deals']
 LOOP
  SELECT c.relrowsecurity,c.oid INTO STRICT had_rls,source_oid FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
   WHERE s.nspname='finnor_os' AND c.relname=n AND c.relkind IN('r','p');
  -- Capture only policies that apply to the legitimate application role.
  SELECT COALESCE(string_agg('('||COALESCE(pg_get_expr(p.polqual,p.polrelid),'true')||')',' OR '
    ORDER BY p.polname) FILTER(WHERE p.polpermissive),'false'),
   COALESCE(string_agg('('||COALESCE(pg_get_expr(p.polqual,p.polrelid),'true')||')',' AND '
    ORDER BY p.polname) FILTER(WHERE NOT p.polpermissive),'true')
   INTO native_select,native_restrict FROM pg_policy p
   WHERE p.polrelid=source_oid AND p.polcmd IN('r','*')
    AND EXISTS(SELECT 1 FROM unnest(p.polroles) role_oid
      WHERE CASE WHEN role_oid=0 THEN true ELSE pg_has_role('finnor_app'::name,role_oid,'USAGE') END);
  IF NOT had_rls THEN native_select:='true';native_restrict:='true';END IF;
  native_read:='('||native_select||') AND ('||native_restrict||')';
  -- Additional exact institution privacy, not CURRENT_USER substitution or
  -- SET ROLE app. The new candidate role must not acquire the exemption that
  -- old policies reserved for non-application custodians. Identity comes from
  -- the enrolled LOGIN + locked owner/job + private same-xid scope above.
  privacy:=CASE n
   WHEN 's5_proposals' THEN 'demand IS NULL OR principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid'
   WHEN 's5_reservation_origins' THEN 'body->>''schema''<>''finnor.s5.institution-reservation.v1'' OR principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid'
   WHEN 's5_reservations' THEN 'finnor_os.s5_institution_visible(reservation_id)'
   WHEN 's5_consumptions' THEN 'body->>''schema''<>''finnor.s5.institution-consumption.v1'' OR principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid'
   WHEN 's5_governed_resource_charges' THEN 'body->>''schema''<>''finnor.s5.institution-consumption.v1'' OR principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid'
   WHEN 's5_consumption_states' THEN 'finnor_os.s5_institution_consumption_visible(consumption_id)'
   WHEN 's5_history' THEN '(operation<>''s5_reservations'' OR finnor_os.s5_institution_visible(subject_id)) AND (operation<>''s5_consumption_states'' OR finnor_os.s5_institution_consumption_visible(subject_id))'
   ELSE 'true' END;
  native_read:=native_read||' AND ('||privacy||')';
  predicate:='finnor_specialist.candidate_source_scope(tenant_id) AND ('||native_read||')';
  owner_read:='tenant_id=finnor_os.request_tenant_id() AND ('||native_read||')';
  IF n='w2_programs' THEN
   predicate:=predicate||' AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid';
  END IF;
  IF n=ANY(ARRAY['works','work_inputs','jobs','w2_programs']) THEN
   predicate:=predicate||format(' AND finnor_specialist.candidate_source_row(tenant_id,%L,id::text)',n);
  ELSIF n=ANY(ARRAY['w2_program_revisions','w2_assignment_heads','w2_events','w2_dependencies']) THEN
   predicate:=predicate||format(' AND finnor_specialist.candidate_source_row(tenant_id,%L,program_id::text)',n);
  END IF;
  IF NOT had_rls THEN
   EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',n);
   EXECUTE format('CREATE POLICY specialist_preserve_existing_access ON finnor_os.%I FOR ALL TO PUBLIC
    USING(NOT pg_has_role(current_user,''finnor_specialist_candidate'',''MEMBER''))
    WITH CHECK(NOT pg_has_role(current_user,''finnor_specialist_candidate'',''MEMBER''))',n);
  END IF;
  EXECUTE format('CREATE POLICY specialist_source_read ON finnor_os.%I FOR SELECT TO finnor_specialist_candidate USING(%s)',n,predicate);
  EXECUTE format('CREATE POLICY specialist_source_owner_read ON finnor_os.%I FOR SELECT TO finnor_specialist_owner USING(%s)',n,owner_read);
  EXECUTE format('GRANT SELECT ON finnor_os.%I TO finnor_specialist_owner',n);
  IF n=ANY(lock_tables) OR n='w2_assignment_heads' THEN
   EXECUTE format('CREATE POLICY specialist_source_owner_lock ON finnor_os.%I FOR UPDATE TO finnor_specialist_owner USING(%s) WITH CHECK(%s)',n,owner_read,owner_read);
   EXECUTE format('GRANT UPDATE ON finnor_os.%I TO finnor_specialist_owner',n);
  END IF;
  EXECUTE format('CREATE POLICY specialist_source_scope ON finnor_os.%I AS RESTRICTIVE
   FOR SELECT TO finnor_specialist_candidate USING(%s)',n,predicate);
  EXECUTE format('GRANT SELECT ON finnor_os.%I TO finnor_specialist_candidate',n);
  IF n=ANY(lock_tables) THEN
   EXECUTE format('GRANT UPDATE(tenant_id) ON finnor_os.%I TO finnor_specialist_candidate',n);
   EXECUTE format('CREATE POLICY specialist_source_lock ON finnor_os.%I FOR UPDATE TO finnor_specialist_candidate
    USING(%s) WITH CHECK(false)',n,predicate);
   EXECUTE format('CREATE POLICY specialist_source_no_update ON finnor_os.%I AS RESTRICTIVE
    FOR UPDATE TO finnor_specialist_candidate USING(%s) WITH CHECK(false)',n,predicate);
  END IF;
  EXECUTE format('CREATE TRIGGER specialist_source_write_denial BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.%I
   FOR EACH ROW EXECUTE FUNCTION finnor_specialist.deny_candidate_source_write()',n);
 END LOOP;
END $source_acl$;
GRANT USAGE ON SCHEMA finnor_os TO finnor_specialist_candidate;
GRANT SELECT,UPDATE ON finnor_os.users,finnor_os.works,finnor_os.work_inputs,finnor_os.jobs,
 finnor_os.evidence_sources,finnor_os.evidence_source_versions,finnor_os.w2_events TO finnor_specialist_owner;
GRANT EXECUTE ON FUNCTION finnor_os.w2_actor_occupation(uuid[],uuid),finnor_os.y4_allocation_context_complete(),
 finnor_os.s5_institution_outstanding() TO finnor_specialist_candidate;

-- Explicit custody of the nine live PUBLIC definer signatures that
-- are not candidate loader ports. Existing explicit ACLs are never removed.
-- App/worker were already PUBLIC consumers. Preserve them before revocation.
-- Trigger ports remain usable by existing native triggers, but cannot be
-- attached by the candidate to an attacker-owned TEMP table.
CREATE TABLE finnor_specialist.native_function_acl_changes(
 signature text PRIMARY KEY,source_file text NOT NULL,before_acl jsonb NOT NULL,after_acl jsonb NOT NULL,
 required_callers text[] NOT NULL,definition_sha256 text NOT NULL);
ALTER TABLE finnor_specialist.native_function_acl_changes OWNER TO finnor_specialist_owner;
REVOKE ALL ON finnor_specialist.native_function_acl_changes FROM PUBLIC;
DO $native_definer_acl$
DECLARE cut record;port regprocedure;before_acl jsonb;after_acl jsonb;definition text;r text;
BEGIN
 IF to_regprocedure('finnor_os.assign_legacy_default_vertical()') IS NOT NULL THEN
  RAISE EXCEPTION 'SPECIALIST_LEGACY_VERTICAL_FUNCTION_NOT_RETIRED';
 END IF;
 FOR cut IN SELECT * FROM (VALUES
  ('finnor_os.sync_user_legacy_authority()','postz_w2_zz_participant_legacy_authority.sql'),
  ('finnor_os.sync_role_permission_authority()','0069_employee_authority_runtime.sql'),
  ('finnor_os.bump_authority_revision()','0069_employee_authority_runtime.sql'),
  ('finnor_os.append_pe_business_event()','0109_atomic_water_runtime_retirement.sql'),
  ('finnor_os.sync_artifact_owner_authority()','0123_artifact_authority_defaults.sql'),
  ('finnor_os.sync_ic_owner_authority()','0127_pe_actions_ic_runtime.sql'),
  ('finnor_os.sync_workforce_owner_authority()','0129_phase7_governed_workforce_learning.sql'),
  ('finnor_os.append_product_truth_operational_delta()','0135_source_compatibility_runtime_parity.sql'),
  ('finnor_os.pe_v3_record_closed_certificate()','0173_v3_autonomous_transaction_closure.sql')
 ) AS finite(signature,source_file)
 LOOP
  port:=cut.signature::regprocedure;
  SELECT COALESCE(p.proacl,acldefault('f',p.proowner))::text,pg_get_functiondef(p.oid)
   INTO STRICT r,definition FROM pg_proc p WHERE p.oid=port AND p.prosecdef;
  before_acl:=to_jsonb(r);
  FOREACH r IN ARRAY ARRAY['finnor_app','finnor_worker'] LOOP
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',port,r);
  END LOOP;
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',port);
  SELECT to_jsonb(COALESCE(p.proacl,acldefault('f',p.proowner))::text) INTO STRICT after_acl
   FROM pg_proc p WHERE p.oid=port;
  INSERT INTO finnor_specialist.native_function_acl_changes VALUES(cut.signature,cut.source_file,
   before_acl,after_acl,ARRAY['finnor_app','finnor_worker'],
   encode(sha256(convert_to(definition,'UTF8')),'hex'));
 END LOOP;
END $native_definer_acl$;
CREATE TRIGGER native_function_acl_changes_immutable BEFORE UPDATE OR DELETE
 ON finnor_specialist.native_function_acl_changes FOR EACH ROW EXECUTE FUNCTION finnor_specialist.immutable();
-- Exact finite reader/policy helpers used by the unchanged loaders.
GRANT EXECUTE ON FUNCTION finnor_os.request_authenticated_user_uuid(),finnor_os.may_query_resource(text,text,text),
 finnor_os.s5_institution_visible(text),finnor_os.s5_institution_consumption_visible(text),
 finnor_os.v4_evidence_permitted(uuid),finnor_os.v4_action_permitted(uuid),
 finnor_os.y4_s5_private(uuid,text),finnor_os.y4_s5_visible(uuid,text),
 finnor_os.y4_s5_subject_visible(uuid,text),finnor_os.y4_s5_experience_visible(uuid,uuid,jsonb),
 finnor_os.y4_s6_effect_visible(uuid,uuid),finnor_os.y4_allocation_context_complete(),
 finnor_os.s5_institution_outstanding()
 TO finnor_specialist_candidate,finnor_specialist_owner;

SET ROLE finnor_specialist_owner;
CREATE FUNCTION finnor_specialist.read_native_acl_custody() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_specialist,pg_temp AS $custody$
 SELECT COALESCE(jsonb_agg(to_jsonb(a)||jsonb_build_object(
  'currentDefinition',pg_get_functiondef(p.oid),
  'currentAcl',COALESCE(p.proacl,acldefault('f',p.proowner))::text) ORDER BY a.signature),'[]'::jsonb)
 FROM finnor_specialist.native_function_acl_changes a JOIN pg_proc p ON p.oid=a.signature::regprocedure
$custody$;
REVOKE ALL ON FUNCTION finnor_specialist.read_native_acl_custody() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_specialist.read_native_acl_custody()
 TO finnor_specialist_adapter,finnor_specialist_candidate,finnor_specialist_proof,
 finnor_specialist_projection,finnor_specialist_reader;
RESET ROLE;

CREATE TRIGGER candidate_transactions_immutable BEFORE UPDATE OR DELETE
 ON finnor_specialist.candidate_transactions FOR EACH ROW EXECUTE FUNCTION finnor_specialist.immutable();
