-- V1 adds a programme and immutable artifacts on the existing Work/S1/P4 spine.
-- 0175/0176 are reserved by separate inspected V4/V5 peers, not installed here.
-- This migration grants no live contact, professional authority or S8 admission.
-- A sourcing Work starts at the strategy before any Opportunity exists.
UPDATE finnor_os.canonical_truth_registry SET work_attachable=true
 WHERE entity_type='pe_strategy' AND vertical_key='private_equity';
CREATE TABLE finnor_os.work_programme_occupations (
 tenant_id uuid NOT NULL, work_id uuid NOT NULL, owner text NOT NULL, programme_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN('PROGRESS','WAITING','BLOCKED','STOPPED','RECONCILING','FAILED','COMPLETE')),
 revision integer NOT NULL CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,owner,programme_id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id)
);
ALTER TABLE finnor_os.work_programme_occupations ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.work_programme_occupations FORCE ROW LEVEL SECURITY;
CREATE POLICY work_programme_tenant ON finnor_os.work_programme_occupations
 USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id());
GRANT SELECT,INSERT,UPDATE ON finnor_os.work_programme_occupations TO finnor_app;
ALTER TABLE finnor_os.pe_opportunities ADD COLUMN buyer_entity_id uuid;
ALTER TABLE finnor_os.pe_opportunities ADD CONSTRAINT v1_opportunity_buyer_tenant
 FOREIGN KEY(tenant_id,buyer_entity_id) REFERENCES finnor_os.external_organizations(tenant_id,id);
ALTER TABLE finnor_os.primary_governance_versions DROP CONSTRAINT primary_governance_versions_semantic_owner_check;
ALTER TABLE finnor_os.primary_governance_versions ADD CONSTRAINT primary_governance_versions_semantic_owner_check
 CHECK(semantic_owner IN('S1','S2','S4','S5','S6','S8'));
CREATE UNIQUE INDEX v1_company_buyer_active_unique ON finnor_os.pe_opportunities(tenant_id,target_organization_id,buyer_entity_id)
 WHERE buyer_entity_id IS NOT NULL AND state IN('identified','screening','qualified','promoted');
CREATE FUNCTION finnor_os.opportunity_company_creation_fence() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('opportunity-company:'||NEW.tenant_id::text||':'||NEW.target_organization_id::text,1));
 IF EXISTS(SELECT 1 FROM finnor_os.pe_opportunities o WHERE o.tenant_id=NEW.tenant_id
  AND o.target_organization_id=NEW.target_organization_id AND o.id<>NEW.id
  AND o.state IN('identified','screening','qualified','promoted')
  AND (NEW.buyer_entity_id IS NOT NULL AND (o.buyer_entity_id IS NULL OR o.buyer_entity_id=NEW.buyer_entity_id)
   OR NEW.buyer_entity_id IS NULL AND o.buyer_entity_id IS NOT NULL))
 THEN RAISE EXCEPTION 'CANONICAL_COMPANY_BUYER_OPPORTUNITY_ALREADY_ACTIVE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER opportunity_company_creation_fence BEFORE INSERT ON finnor_os.pe_opportunities
 FOR EACH ROW EXECUTE FUNCTION finnor_os.opportunity_company_creation_fence();
CREATE TABLE finnor_os.v1_programmes (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, id uuid NOT NULL,
 work_id uuid NOT NULL, work_input_id uuid NOT NULL, work_input_digest text NOT NULL,
 root jsonb NOT NULL, intake jsonb NOT NULL CHECK(octet_length(intake::text)<=1048576),
 intake_digest text NOT NULL, frozen_manifest jsonb, frozen_digest text,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), idempotency_key text NOT NULL,
 status text NOT NULL DEFAULT 'PROGRESS' CHECK(status IN('PROGRESS','WAITING','BLOCKED','STOPPED','RECONCILING','FAILED','COMPLETE')),
 reason text, invalidated boolean NOT NULL DEFAULT false, cancellation_requested_at timestamptz,
 active_claim_token uuid, active_claim_fence bigint, principal_artifact_id uuid,
 next_obligations jsonb NOT NULL DEFAULT '[]', required_approvals jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), UNIQUE(tenant_id,principal_id,idempotency_key),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);
CREATE TABLE finnor_os.v1_candidates (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 id uuid NOT NULL, company_id uuid NOT NULL, counterparty_id uuid NOT NULL,
 disposition text NOT NULL DEFAULT 'PRELIMINARY', reason text,
 current_terms_id uuid, current_action_id uuid, last_event_id uuid,
 revision integer NOT NULL DEFAULT 1, artifact_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), UNIQUE(tenant_id,programme_id,company_id),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v1_programmes(tenant_id,principal_id,id),
 FOREIGN KEY(company_id) REFERENCES finnor_os.external_organizations(id),
 FOREIGN KEY(counterparty_id) REFERENCES finnor_os.external_contacts(id)
);
CREATE TABLE finnor_os.v1_terms (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 candidate_id uuid NOT NULL, id uuid NOT NULL, revision integer NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536), digest text NOT NULL,
 based_on_event_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), UNIQUE(tenant_id,candidate_id,revision),
 FOREIGN KEY(tenant_id,principal_id,candidate_id) REFERENCES finnor_os.v1_candidates(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.s1_bilateral_observations (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 id uuid NOT NULL, kind text NOT NULL CHECK(kind IN('SNAPSHOT','PARTICIPANT_EVENT','TRANSPORT_STATUS')),
 event_key text NOT NULL, evidence_source_id uuid NOT NULL, evidence_version_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576), digest text NOT NULL,
 retrieved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), UNIQUE(tenant_id,programme_id,event_key),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v1_programmes(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,evidence_source_id) REFERENCES finnor_os.evidence_sources(tenant_id,id),
 FOREIGN KEY(tenant_id,evidence_version_id) REFERENCES finnor_os.evidence_source_versions(tenant_id,id)
);
CREATE TABLE finnor_os.v1_claim_checks (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 candidate_id uuid NOT NULL, id uuid NOT NULL, body jsonb NOT NULL,
 signature text NOT NULL, digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,candidate_id) REFERENCES finnor_os.v1_candidates(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.v1_artifacts (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 candidate_id uuid NOT NULL, id uuid NOT NULL, opportunity_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576), digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id,candidate_id) REFERENCES finnor_os.v1_candidates(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES finnor_os.pe_opportunities(tenant_id,id)
);
CREATE TABLE finnor_os.v1_dependencies (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 candidate_id uuid, artifact_id uuid, node_id text NOT NULL, key text NOT NULL, revision bigint NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,programme_id,node_id,key),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v1_programmes(tenant_id,principal_id,id)
);
CREATE INDEX v1_dependency_closure ON finnor_os.v1_dependencies(tenant_id,key);
CREATE TABLE finnor_os.v1_events (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(), semantic_owner text NOT NULL, kind text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v1_programmes(tenant_id,principal_id,id)
);
-- S6's shared policy state is tenant/firm-wide, never principal, agent or mailbox
-- scoped. A durable possible dispatch counts until qualified reconciliation.
CREATE TABLE finnor_os.s6_relationship_aliases (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id), subject_key text NOT NULL,
 canonical_key text NOT NULL, source_ref jsonb NOT NULL,
 PRIMARY KEY(tenant_id,subject_key,canonical_key), CHECK(subject_key<>canonical_key)
);
CREATE TABLE finnor_os.s6_relationship_events (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 subject_keys text[] NOT NULL, kind text NOT NULL, source_ref jsonb NOT NULL,
 observed_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,kind,source_ref)
);
CREATE TABLE finnor_os.s6_contact_intents (
 tenant_id uuid NOT NULL, id uuid NOT NULL, principal_id uuid NOT NULL, work_id uuid NOT NULL,
 programme_owner text NOT NULL, programme_id uuid NOT NULL, candidate_id uuid NOT NULL,
 company_id uuid NOT NULL, counterparty_id uuid NOT NULL, action_id uuid NOT NULL,
 member_key text NOT NULL DEFAULT 'primary',
 channel text NOT NULL, subject_keys text[] NOT NULL DEFAULT '{}',
 activity_binding jsonb NOT NULL, payload jsonb NOT NULL, payload_digest text NOT NULL,
 terms_digest text NOT NULL, terms_revision integer NOT NULL, kind text NOT NULL,
 policy_id uuid NOT NULL, policy_revision integer NOT NULL,
 status text NOT NULL DEFAULT 'INTENDED' CHECK(status IN('INTENDED','AUTHORIZED','POSSIBLE_EGRESS','ACKNOWLEDGED','UNKNOWN','CANCELLED_BEFORE_DISPATCH')),
 possible_egress_at timestamptz, acknowledged_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,action_id,member_key), UNIQUE(tenant_id,programme_id,candidate_id,terms_revision,kind,member_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,policy_id,policy_revision) REFERENCES finnor_os.primary_governance_versions(tenant_id,id,revision)
);
CREATE INDEX s6_contact_subjects ON finnor_os.s6_contact_intents USING gin(subject_keys);
-- Preserve the real S1 alias owner's original associations. Deleting, disabling
-- or correcting a displayed alias cannot reset earlier suppression or counts.
CREATE FUNCTION finnor_os.s6_preserve_canonical_party_alias() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE j jsonb; subject text; alias_key text; t uuid; component text[]; k text; BEGIN
 FOR j IN SELECT value FROM jsonb_array_elements(CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(to_jsonb(NEW))
  WHEN TG_OP='DELETE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END) LOOP
  IF j->>'party_type' NOT IN('external_organization','external_contact') THEN CONTINUE; END IF;
  t:=(j->>'tenant_id')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended('s6-relationships:'||t::text,6));
  subject:=CASE WHEN j->>'party_type'='external_organization' THEN 'company:' ELSE 'person:' END||(j->>'party_id');
  alias_key:='party-alias:'||encode(sha256(convert_to(t::text||':'||(j->>'normalized_alias'),'UTF8')),'hex');
  INSERT INTO finnor_os.s6_relationship_aliases(tenant_id,subject_key,canonical_key,source_ref)
   VALUES(t,subject,alias_key,jsonb_build_object('owner','S1','kind','CANONICAL_PARTY_ALIAS_ASSOCIATION','record',j))
   ON CONFLICT DO NOTHING;
  WITH RECURSIVE connected(subject) AS (
   SELECT subject UNION SELECT CASE WHEN a.subject_key=c.subject THEN a.canonical_key ELSE a.subject_key END
   FROM connected c JOIN finnor_os.s6_relationship_aliases a ON a.tenant_id=t
    AND (a.subject_key=c.subject OR a.canonical_key=c.subject)
  ) SELECT array_agg(c.subject) INTO component FROM (SELECT c.subject FROM connected c LIMIT 257) c;
  IF cardinality(component)>256 THEN RAISE EXCEPTION 'S6_CANONICAL_ALIAS_IDENTITY_CLOSURE_BOUND'; END IF;
  FOREACH k IN ARRAY component LOOP
   IF k LIKE 'company:%' OR k LIKE 'person:%' THEN
    PERFORM finnor_os.p4_touch_source(t,'s6-relationship-identity:'||k);
   END IF;
  END LOOP;
 END LOOP; RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.s6_preserve_canonical_party_alias() FROM PUBLIC;
CREATE TRIGGER s6_preserve_canonical_party_alias AFTER INSERT OR UPDATE OR DELETE ON finnor_os.party_aliases
 FOR EACH ROW EXECUTE FUNCTION finnor_os.s6_preserve_canonical_party_alias();
INSERT INTO finnor_os.s6_relationship_aliases(tenant_id,subject_key,canonical_key,source_ref)
 SELECT a.tenant_id,CASE WHEN a.party_type='external_organization' THEN 'company:' ELSE 'person:' END||a.party_id::text,
  'party-alias:'||encode(sha256(convert_to(a.tenant_id::text||':'||a.normalized_alias,'UTF8')),'hex'),
  jsonb_build_object('owner','S1','kind','CANONICAL_PARTY_ALIAS_ASSOCIATION','record',to_jsonb(a))
 FROM finnor_os.party_aliases a WHERE a.party_type IN('external_organization','external_contact')
 ON CONFLICT DO NOTHING;
CREATE TABLE finnor_os.s6_standing_contact_authorizations (
 tenant_id uuid NOT NULL, action_id uuid NOT NULL, business_effect_id uuid NOT NULL,
 effect_hash text NOT NULL, authority_ref jsonb NOT NULL, binding_digest text NOT NULL,
 authority_decision_id uuid NOT NULL, issuer_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,action_id),
 FOREIGN KEY(tenant_id,action_id) REFERENCES finnor_os.domain_actions(tenant_id,id),
 FOREIGN KEY(business_effect_id) REFERENCES finnor_os.business_effects(id)
);
-- Neutralize the name, not the accounting. The updatable compatibility view
-- preserves V2's exact columns, reads, inserts and old signed receipt bytes.
ALTER TABLE finnor_os.s5_primary_charges RENAME TO s5_programme_charges;
ALTER TABLE finnor_os.s5_programme_charges
 DROP CONSTRAINT s5_primary_charges_tenant_id_principal_id_programme_id_fkey;
ALTER TABLE finnor_os.s5_programme_charges
 ADD COLUMN programme_owner text NOT NULL DEFAULT 'V2' CHECK(programme_owner IN('V1','V2'));
CREATE VIEW finnor_os.s5_primary_charges WITH(security_invoker=true) AS
 SELECT * FROM finnor_os.s5_programme_charges;
GRANT SELECT,INSERT,UPDATE ON finnor_os.s5_primary_charges TO finnor_app;
CREATE FUNCTION finnor_os.s5_programme_charge_scope() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF NEW.programme_owner='V1' THEN
  IF NOT EXISTS(SELECT 1 FROM finnor_os.v1_programmes WHERE tenant_id=NEW.tenant_id
   AND principal_id=NEW.principal_id AND id=NEW.programme_id) THEN RAISE EXCEPTION 'S5_V1_ORIGINAL_PROGRAMME_REQUIRED'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM finnor_os.v2_programmes WHERE tenant_id=NEW.tenant_id
   AND principal_id=NEW.principal_id AND id=NEW.programme_id) THEN RAISE EXCEPTION 'S5_V2_ORIGINAL_PROGRAMME_REQUIRED'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER s5_programme_charge_scope BEFORE INSERT OR UPDATE ON finnor_os.s5_programme_charges
 FOR EACH ROW EXECUTE FUNCTION finnor_os.s5_programme_charge_scope();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['v1_programmes','v1_candidates','v1_terms','s1_bilateral_observations',
  'v1_claim_checks','v1_artifacts','v1_dependencies','v1_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY v1_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t NOT IN('v1_programmes','v1_candidates') THEN
   EXECUTE format('CREATE TRIGGER v1_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.v2_immutable()',t);
  END IF;
 END LOOP;
 GRANT UPDATE ON finnor_os.v1_programmes,finnor_os.v1_candidates TO finnor_app;
 FOREACH t IN ARRAY ARRAY['s6_relationship_aliases','s6_relationship_events','s6_contact_intents','s6_standing_contact_authorizations'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY s6_relationship_tenant ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id())',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t<>'s6_contact_intents' THEN
   EXECUTE format('CREATE TRIGGER s6_relationship_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.v2_immutable()',t);
  END IF;
 END LOOP;
 GRANT UPDATE ON finnor_os.s6_contact_intents TO finnor_app;
END $$;
CREATE FUNCTION finnor_os.v1_frozen_programme() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['revision','status','reason','invalidated','cancellation_requested_at',
  'active_claim_token','active_claim_fence','principal_artifact_id','next_obligations',
  'required_approvals','updated_at','frozen_manifest','frozen_digest']) IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['revision','status','reason','invalidated','cancellation_requested_at',
  'active_claim_token','active_claim_fence','principal_artifact_id','next_obligations',
  'required_approvals','updated_at','frozen_manifest','frozen_digest'])
  OR OLD.frozen_manifest IS NOT NULL AND (NEW.frozen_manifest IS DISTINCT FROM OLD.frozen_manifest
   OR NEW.frozen_digest IS DISTINCT FROM OLD.frozen_digest)
  OR OLD.cancellation_requested_at IS NOT NULL AND NEW.cancellation_requested_at IS DISTINCT FROM OLD.cancellation_requested_at
 THEN RAISE EXCEPTION 'V1_ORIGINAL_INPUT_CUT_GRANT_DEADLINE_AND_CANCELLATION_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER v1_frozen_programme BEFORE UPDATE ON finnor_os.v1_programmes
 FOR EACH ROW EXECUTE FUNCTION finnor_os.v1_frozen_programme();
CREATE FUNCTION finnor_os.v1_revision_closure() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE a record; BEGIN
 FOR a IN SELECT DISTINCT programme_id,candidate_id,artifact_id FROM finnor_os.v1_dependencies
  WHERE tenant_id=NEW.tenant_id AND key=NEW.key AND revision<NEW.revision LOOP
  IF a.candidate_id IS NULL THEN
   UPDATE finnor_os.v1_programmes SET invalidated=true,reason='V1_OWNER_DEPENDENCY_CHANGED',
    updated_at=clock_timestamp() WHERE tenant_id=NEW.tenant_id AND id=a.programme_id;
  ELSE
   UPDATE finnor_os.v1_candidates SET disposition='INVALIDATED',reason='V1_CANDIDATE_DEPENDENCY_CHANGED'
    WHERE tenant_id=NEW.tenant_id AND id=a.candidate_id;
  END IF;
  IF a.artifact_id IS NOT NULL THEN
   UPDATE finnor_os.work_programme_occupations SET status='BLOCKED',revision=revision+1,updated_at=clock_timestamp()
    WHERE tenant_id=NEW.tenant_id AND owner='V1_HANDOFF' AND programme_id=a.artifact_id AND status='WAITING';
   PERFORM finnor_os.p4_touch_source(NEW.tenant_id,'bilateral-artifact:'||a.artifact_id::text);
  END IF;
 END LOOP; RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.v1_revision_closure() FROM PUBLIC;
CREATE TRIGGER v1_revision_closure AFTER INSERT OR UPDATE ON finnor_os.p4_source_revisions
 FOR EACH ROW EXECUTE FUNCTION finnor_os.v1_revision_closure();

CREATE FUNCTION finnor_os.bilateral_evidence_scope_allowed(profile_ref jsonb) RETURNS boolean
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,finnor_os AS $$
 SELECT EXISTS(
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
 )
$$;
REVOKE ALL ON FUNCTION finnor_os.bilateral_evidence_scope_allowed(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.bilateral_evidence_scope_allowed(jsonb) TO finnor_app,finnor_worker;
CREATE POLICY bilateral_custody_sources ON finnor_os.evidence_sources AS RESTRICTIVE
 USING(source_type<>'bilateral_record' OR finnor_os.bilateral_evidence_scope_allowed(metadata->'sourceProfileRef'))
 WITH CHECK(source_type<>'bilateral_record' OR finnor_os.bilateral_evidence_scope_allowed(metadata->'sourceProfileRef'));
CREATE POLICY bilateral_custody_versions ON finnor_os.evidence_source_versions AS RESTRICTIVE
 USING(EXISTS(SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=evidence_source_versions.source_id
  AND (s.source_type<>'bilateral_record' OR finnor_os.bilateral_evidence_scope_allowed(s.metadata->'sourceProfileRef'))))
 WITH CHECK(EXISTS(SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=evidence_source_versions.source_id
  AND (s.source_type<>'bilateral_record' OR finnor_os.bilateral_evidence_scope_allowed(s.metadata->'sourceProfileRef'))));
CREATE POLICY bilateral_custody_chunks ON finnor_os.evidence_chunks AS RESTRICTIVE
 USING(EXISTS(SELECT 1 FROM finnor_os.evidence_source_versions v WHERE v.id=evidence_chunks.version_id))
 WITH CHECK(EXISTS(SELECT 1 FROM finnor_os.evidence_source_versions v WHERE v.id=evidence_chunks.version_id));
CREATE POLICY bilateral_custody_research_hits ON finnor_os.research_run_hits AS RESTRICTIVE
 USING(EXISTS(SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=research_run_hits.source_id AND s.source_type<>'bilateral_record'))
 WITH CHECK(EXISTS(SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=research_run_hits.source_id AND s.source_type<>'bilateral_record'));
CREATE FUNCTION finnor_os.bilateral_evidence_namespace() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF NEW.source_key LIKE 'bilateral:%' AND NEW.source_type<>'bilateral_record'
  OR TG_OP='UPDATE' AND OLD.source_type='bilateral_record' AND
   (to_jsonb(NEW)-ARRAY['updated_at','last_seen_at','last_success_at','last_failure_at','failure_count','status'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','last_seen_at','last_success_at','last_failure_at','failure_count','status'])
 THEN RAISE EXCEPTION 'BILATERAL_EVIDENCE_CUSTODY_IDENTITY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bilateral_evidence_namespace BEFORE INSERT OR UPDATE ON finnor_os.evidence_sources
 FOR EACH ROW EXECUTE FUNCTION finnor_os.bilateral_evidence_namespace();
CREATE FUNCTION finnor_os.v1_work_occupation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 INSERT INTO finnor_os.work_programme_occupations(tenant_id,work_id,owner,programme_id,status,revision)
 VALUES(NEW.tenant_id,NEW.work_id,'V1',NEW.id,NEW.status,NEW.revision)
 ON CONFLICT(tenant_id,owner,programme_id) DO UPDATE
 SET status=excluded.status,revision=excluded.revision,updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER v1_work_occupation AFTER INSERT OR UPDATE OF status,revision ON finnor_os.v1_programmes
 FOR EACH ROW EXECUTE FUNCTION finnor_os.v1_work_occupation();
CREATE FUNCTION finnor_os.v2_work_occupation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 INSERT INTO finnor_os.work_programme_occupations(tenant_id,work_id,owner,programme_id,status,revision)
 VALUES(NEW.tenant_id,NEW.work_id,'V2',NEW.id,NEW.status,NEW.revision)
 ON CONFLICT(tenant_id,owner,programme_id) DO UPDATE
 SET status=excluded.status,revision=excluded.revision,updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER v2_work_occupation AFTER INSERT OR UPDATE OF status,revision ON finnor_os.v2_programmes
 FOR EACH ROW EXECUTE FUNCTION finnor_os.v2_work_occupation();
INSERT INTO finnor_os.work_programme_occupations(tenant_id,work_id,owner,programme_id,status,revision)
 SELECT tenant_id,work_id,'V2',id,status,revision FROM finnor_os.v2_programmes;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_v1_checker') THEN
  CREATE ROLE finnor_v1_checker NOLOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_v1_checker' AND (rolsuper OR rolbypassrls))
  OR pg_has_role('finnor_v1_checker','finnor_app','MEMBER')
 THEN RAISE EXCEPTION 'V1 checker must not inherit write or RLS-bypass authority'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_v1_receipt_writer') THEN
  CREATE ROLE finnor_v1_receipt_writer NOLOGIN NOSUPERUSER NOINHERIT NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_v1_receipt_writer' AND (rolsuper OR rolbypassrls))
  OR pg_has_role('finnor_v1_receipt_writer','finnor_app','MEMBER')
 THEN RAISE EXCEPTION 'V1 receipt writer must have only append-only receipt authority'; END IF;
END $$;
-- Original SQL remains read-only. A separate, narrowly credentialed connection
-- in the independent checker appends its signed result. The producer cannot.
REVOKE INSERT ON finnor_os.v1_claim_checks FROM finnor_app;
GRANT USAGE ON SCHEMA finnor_os TO finnor_v1_receipt_writer;
GRANT SELECT,INSERT ON finnor_os.v1_claim_checks TO finnor_v1_receipt_writer;
GRANT EXECUTE ON FUNCTION finnor_os.request_tenant_id() TO finnor_v1_receipt_writer;
GRANT USAGE ON SCHEMA finnor_os TO finnor_v1_checker;
GRANT SELECT ON finnor_os.v1_programmes,finnor_os.v1_candidates,finnor_os.v1_terms,
 finnor_os.s1_bilateral_observations,finnor_os.v1_dependencies,finnor_os.s6_contact_intents,
 finnor_os.s6_standing_contact_authorizations,finnor_os.s6_relationship_aliases,finnor_os.s6_relationship_events,
 finnor_os.primary_governance_versions,finnor_os.primary_governance_heads,finnor_os.users,
 finnor_os.work_inputs,finnor_os.works,finnor_os.external_contacts,finnor_os.external_organizations,
 finnor_os.communication_identities,finnor_os.communication_deliveries,finnor_os.domain_actions,
 finnor_os.business_effects,finnor_os.authority_states,finnor_os.p4_source_revisions,
 finnor_os.pe_opportunities,finnor_os.pe_deals,finnor_os.s5_programme_charges,
 finnor_os.provider_operation_attempts,finnor_os.external_operations TO finnor_v1_checker;
GRANT EXECUTE ON FUNCTION finnor_os.request_tenant_id() TO finnor_v1_checker;
-- The checker can only SELECT its current tenant. No app/worker membership,
-- write grants, unrestricted queue policy or RLS bypass is conferred.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['primary_governance_versions','primary_governance_heads','users',
  'work_inputs','works','external_contacts','external_organizations','communication_identities',
  'communication_deliveries','domain_actions','business_effects','authority_states',
  'p4_source_revisions','pe_opportunities','pe_deals','s5_programme_charges',
  'provider_operation_attempts','external_operations'] LOOP
  EXECUTE format('CREATE POLICY v1_original_checker_read ON finnor_os.%I FOR SELECT TO finnor_v1_checker USING(tenant_id=finnor_os.request_tenant_id())',t);
 END LOOP;
END $$;
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,
 classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('advance_bilateral_programme_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'V1 original Work/mandate/grant; actual S6 contact and independent original-record qualification.');
