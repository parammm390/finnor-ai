-- V4 domain records reference Core Evidence, S4 approval, S5 capacity and S6 operations.
-- No capital/funding/reservation/effect ledger is introduced.
CREATE TABLE finnor_os.s1_capital_issuers (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, issuer_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), body jsonb NOT NULL CHECK(octet_length(body::text)<=16384),
 content_digest text NOT NULL CHECK(content_digest~'^[a-f0-9]{64}$'),
 source_evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,issuer_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.v4_instrument_profiles (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, profile_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), body jsonb NOT NULL CHECK(octet_length(body::text)<=16384),
 content_digest text NOT NULL CHECK(content_digest~'^[a-f0-9]{64}$'),
 source_evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,profile_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.s1_capital_disclosures (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL, work_id uuid NOT NULL,
 evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
 source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), body jsonb NOT NULL CHECK(octet_length(body::text)<=16384),
 content_digest text NOT NULL CHECK(content_digest~'^[a-f0-9]{64}$'),
 valid_until timestamptz NOT NULL, retention_until timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,principal_id,programme_id,evidence_version_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
CREATE TABLE finnor_os.s4_financing_mandates (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 approval_decision_id uuid NOT NULL, work_id uuid NOT NULL, work_input_id uuid NOT NULL,
 mandate_digest text NOT NULL CHECK(mandate_digest~'^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),
 signed_authority jsonb NOT NULL CHECK(octet_length(signed_authority::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,programme_id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,approval_decision_id) REFERENCES finnor_os.authority_decisions(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);
CREATE INDEX s1_capital_disclosures_source_idx ON finnor_os.s1_capital_disclosures(source_id);
CREATE TABLE finnor_os.v4_programmes (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
 request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'), rights_revision integer NOT NULL,
 status text NOT NULL DEFAULT 'PROGRESS' CHECK(status IN('PROGRESS','WAITING','BLOCKED','STOPPED','RECONCILING','FAILED','COMPLETE')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 contacts_spent integer NOT NULL DEFAULT 0 CHECK(contacts_spent>=0),
 human_seconds_spent integer NOT NULL DEFAULT 0 CHECK(human_seconds_spent>=0),
 steps_spent integer NOT NULL DEFAULT 0 CHECK(steps_spent>=0),
 cost_ceiling_micro_usd numeric(41,0) NOT NULL DEFAULT 0 CHECK(cost_ceiling_micro_usd>=0),
 cost_unknown boolean NOT NULL DEFAULT false,
 deadline_at timestamptz NOT NULL, waiting_until timestamptz NOT NULL,
 active_claim_token uuid, active_claim_fence bigint, current_publication_id uuid,
 failure jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,programme_id), UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.s4_financing_mandates(tenant_id,principal_id,programme_id)
);
CREATE INDEX v4_programmes_active_idx ON finnor_os.v4_programmes(tenant_id,principal_id,status,waiting_until);
CREATE TABLE finnor_os.v4_source_events (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 issuer_id uuid NOT NULL, event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 512), source_sequence integer NOT NULL CHECK(source_sequence>0),
 integrity_digest text NOT NULL CHECK(integrity_digest~'^[a-f0-9]{64}$'),
 evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
 source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,issuer_id,event_id), UNIQUE(tenant_id,issuer_id,source_sequence),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v4_programmes(tenant_id,principal_id,programme_id)
);
CREATE INDEX v4_events_programme_idx ON finnor_os.v4_source_events(tenant_id,principal_id,programme_id,created_at,event_id);
CREATE TABLE finnor_os.v4_publications (
 publication_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL, revision integer NOT NULL,
 content_digest text NOT NULL CHECK(content_digest~'^[a-f0-9]{64}$'),
 check_input_digest text NOT NULL CHECK(check_input_digest~'^[a-f0-9]{64}$'),
 code_digest text NOT NULL CHECK(code_digest~'^[a-f0-9]{64}$'),
 owner_snapshot_digest text NOT NULL CHECK(owner_snapshot_digest~'^[a-f0-9]{64}$'),
 evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,programme_id,revision),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v4_programmes(tenant_id,principal_id,programme_id)
);
CREATE TABLE finnor_os.v4_transitions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 kind text NOT NULL, body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v4_programmes(tenant_id,principal_id,programme_id)
);
CREATE INDEX v4_transitions_programme_idx ON finnor_os.v4_transitions(tenant_id,principal_id,programme_id,created_at,id);
CREATE TABLE finnor_os.v4_proposals (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL, proposal_digest text NOT NULL,
 provider_id uuid NOT NULL, recipient_id uuid NOT NULL, channel_id text NOT NULL,
 evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,programme_id,proposal_digest),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v4_programmes(tenant_id,principal_id,programme_id)
);

CREATE FUNCTION finnor_os.v4_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'V4 accepted source and history are immutable'; END $$;
CREATE FUNCTION finnor_os.v4_enrolment_writer_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF current_user IN ('finnor_app','finnor_worker') THEN RAISE EXCEPTION 'V4 enrolled inputs require an independent owner writer'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION finnor_os.v4_programme_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF (NEW.tenant_id,NEW.principal_id,NEW.programme_id,NEW.idempotency_key,NEW.request_digest,NEW.rights_revision,NEW.deadline_at,NEW.waiting_until,NEW.created_at)
   IS DISTINCT FROM (OLD.tenant_id,OLD.principal_id,OLD.programme_id,OLD.idempotency_key,OLD.request_digest,OLD.rights_revision,OLD.deadline_at,OLD.waiting_until,OLD.created_at)
 THEN RAISE EXCEPTION 'V4 cannot replace its original identity or replenish a grant'; END IF;
 IF NEW.contacts_spent<OLD.contacts_spent OR NEW.steps_spent<OLD.steps_spent OR NEW.human_seconds_spent<OLD.human_seconds_spent OR NEW.cost_ceiling_micro_usd<OLD.cost_ceiling_micro_usd
 THEN RAISE EXCEPTION 'V4 original episode consumption is monotonic'; END IF;
 IF OLD.status IN('STOPPED','FAILED','COMPLETE') AND NEW.status<>OLD.status
 THEN RAISE EXCEPTION 'V4 terminal programmes cannot resume new activity'; END IF;
 IF NEW.revision<OLD.revision THEN RAISE EXCEPTION 'V4 programme revisions are monotonic'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER v4_programme_guard BEFORE UPDATE ON finnor_os.v4_programmes FOR EACH ROW EXECUTE FUNCTION finnor_os.v4_programme_guard();
CREATE FUNCTION finnor_os.v4_budget_release_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF NEW.status='RELEASED' AND OLD.status<>'RELEASED' AND EXISTS(
  SELECT 1 FROM finnor_os.v4_programmes p JOIN finnor_os.s4_financing_mandates m USING(tenant_id,principal_id,programme_id)
  WHERE p.tenant_id=OLD.tenant_id AND m.body->'budgetGrantRef'->>'contentDigest'=OLD.allocation_digest
    AND p.contacts_spent>0
 ) THEN RAISE EXCEPTION 'CAPITAL_EPISODE_REQUIRES_QUALIFIED_S5_RECONCILIATION_BEFORE_RELEASE'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.v4_budget_release_guard() FROM PUBLIC;
CREATE TRIGGER v4_budget_release_guard BEFORE UPDATE OF status ON finnor_os.s5_reservations
 FOR EACH ROW EXECUTE FUNCTION finnor_os.v4_budget_release_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['s1_capital_issuers','v4_instrument_profiles','s1_capital_disclosures','s4_financing_mandates','v4_programmes','v4_source_events','v4_publications','v4_transitions','v4_proposals'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY v4_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('REVOKE ALL ON finnor_os.%I FROM finnor_app',t);
  IF t IN('s1_capital_issuers','v4_instrument_profiles','s1_capital_disclosures') THEN
   -- Independently provisioned inputs: neither API nor controller can enroll,
   -- impersonate a professional, alter disclosure permission or self-qualify.
   EXECUTE format('GRANT SELECT ON finnor_os.%I TO finnor_app',t);
   -- PostgreSQL requires UPDATE on at least one column for SELECT FOR SHARE.
   -- The trigger still refuses every actual application UPDATE, including a
   -- same-value revision write. No body/key/enrolment write is granted.
   EXECUTE format('GRANT UPDATE(revision) ON finnor_os.%I TO finnor_app',t);
   EXECUTE format('CREATE TRIGGER v4_enrolment_writer_guard BEFORE UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.v4_enrolment_writer_guard()',t);
  ELSE
   EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
   IF t<>'v4_programmes' THEN
    EXECUTE format('CREATE TRIGGER v4_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.v4_immutable()',t);
   END IF;
  END IF;
 END LOOP;
 GRANT UPDATE ON finnor_os.v4_programmes TO finnor_app;
END $$;

-- Defense at the actual corpus boundary. Unscoped tenant search has no principal
-- and cannot read capital-private sources, chunks, versions or saved excerpts.
CREATE FUNCTION finnor_os.v4_evidence_permitted(p_source_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT CASE
  WHEN NOT EXISTS(SELECT 1 FROM finnor_os.s1_capital_disclosures g WHERE g.source_id=p_source_id)
    AND NOT EXISTS(SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=p_source_id AND s.source_key LIKE 'v4:%')
   THEN true
  ELSE EXISTS(
   SELECT 1 FROM finnor_os.evidence_sources s
   JOIN finnor_os.users u ON u.id=nullif(current_setting('app.user_id',true),'')::uuid
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
REVOKE ALL ON FUNCTION finnor_os.v4_evidence_permitted(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.v4_evidence_permitted(uuid) TO finnor_app;
CREATE POLICY v4_private_source ON finnor_os.evidence_sources AS RESTRICTIVE FOR SELECT TO finnor_app
 USING(finnor_os.v4_evidence_permitted(id));
CREATE POLICY v4_private_version ON finnor_os.evidence_source_versions AS RESTRICTIVE FOR SELECT TO finnor_app
 USING(finnor_os.v4_evidence_permitted(source_id));
CREATE POLICY v4_private_chunk ON finnor_os.evidence_chunks AS RESTRICTIVE FOR SELECT TO finnor_app
 USING(finnor_os.v4_evidence_permitted(source_id));
CREATE POLICY v4_private_excerpt ON finnor_os.research_run_hits AS RESTRICTIVE FOR SELECT TO finnor_app
 USING(finnor_os.v4_evidence_permitted(source_id));

CREATE FUNCTION finnor_os.v4_action_permitted(p_action_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT coalesce((
  SELECT CASE WHEN d.action_type<>'capital_provider_request' AND NOT(d.payload ? 'financingBinding') THEN true
  ELSE d.tenant_id=finnor_os.request_tenant_id()
    AND d.initiated_by=nullif(current_setting('app.user_id',true),'')::uuid
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
REVOKE ALL ON FUNCTION finnor_os.v4_action_permitted(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.v4_action_permitted(uuid) TO finnor_app;
CREATE POLICY v4_private_action ON finnor_os.domain_actions AS RESTRICTIVE FOR SELECT TO finnor_app
 USING(finnor_os.v4_action_permitted(id));
CREATE POLICY v4_private_effect ON finnor_os.business_effects AS RESTRICTIVE FOR SELECT TO finnor_app
 USING(domain_action_id IS NULL OR finnor_os.v4_action_permitted(domain_action_id));
CREATE POLICY v4_private_operation ON finnor_os.external_operations AS RESTRICTIVE FOR SELECT TO finnor_app
 USING(domain_action_id IS NULL OR finnor_os.v4_action_permitted(domain_action_id));

CREATE FUNCTION finnor_os.v4_private_source_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF OLD.source_key LIKE 'v4:%' AND
   (NEW.source_key IS DISTINCT FROM OLD.source_key OR NEW.metadata->'capitalPrivateScope' IS DISTINCT FROM OLD.metadata->'capitalPrivateScope')
 THEN RAISE EXCEPTION 'Capital-private Evidence scope cannot be weakened'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER v4_private_source_identity BEFORE UPDATE ON finnor_os.evidence_sources FOR EACH ROW EXECUTE FUNCTION finnor_os.v4_private_source_identity();

CREATE FUNCTION finnor_os.v4_owner_invalidation() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE j jsonb; BEGIN
 j:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 PERFORM finnor_os.p4_touch_source((j->>'tenant_id')::uuid,
  CASE TG_TABLE_NAME WHEN 'v4_instrument_profiles' THEN 'v4-profile:'||(j->>'profile_id')
   WHEN 's1_capital_issuers' THEN 'v4-issuer:'||(j->>'issuer_id')
   ELSE 'v4-disclosure:'||(j->>'programme_id')||':'||(j->>'evidence_version_id') END);
 UPDATE finnor_os.v4_programmes p SET current_publication_id=NULL,revision=revision+1,
  status=CASE WHEN p.status IN('STOPPED','FAILED','COMPLETE') THEN p.status
   WHEN EXISTS(SELECT 1 FROM finnor_os.domain_actions d JOIN finnor_os.external_operations o
    ON o.tenant_id=d.tenant_id AND o.domain_action_id=d.id WHERE d.tenant_id=p.tenant_id
    AND d.work_id=(SELECT m.work_id FROM finnor_os.s4_financing_mandates m WHERE m.tenant_id=p.tenant_id
      AND m.principal_id=p.principal_id AND m.programme_id=p.programme_id)
    AND d.action_type='capital_provider_request' AND o.execution_state NOT IN('verified','reconciled','known_failed'))
    THEN 'RECONCILING' ELSE 'BLOCKED' END,
  failure=jsonb_build_object('code','OWNER_INPUT_REVISED','ownerTable',TG_TABLE_NAME,'historyAndObligationsRetained',true),
  updated_at=clock_timestamp()
 WHERE p.tenant_id=(j->>'tenant_id')::uuid
   AND ((j->>'principal_id') IS NULL OR p.principal_id=(j->>'principal_id')::uuid)
   AND (TG_TABLE_NAME<>'s1_capital_disclosures' OR p.programme_id=(j->>'programme_id')::uuid);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.v4_owner_invalidation() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['s1_capital_issuers','v4_instrument_profiles','s1_capital_disclosures'] LOOP
  EXECUTE format('CREATE TRIGGER v4_owner_invalidation AFTER UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.v4_owner_invalidation()',t);
 END LOOP;
END $$;

INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_capital_formation_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'Bounded original financing programme. Canonical guarded provider operations, source-only reconciliation and independent classification; no live admission.');
