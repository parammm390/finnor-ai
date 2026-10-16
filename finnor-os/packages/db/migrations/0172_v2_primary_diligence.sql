-- V2 ordinary Work-linked artifacts and versioned owner bindings. This migration
-- issues no source credential, funding, professional authority or S8 admission.
-- Core IDs are globally unique. Explicit composite candidate keys preserve that
-- invariant while allowing the new observation FKs to enforce tenant scope too.
CREATE UNIQUE INDEX evidence_sources_tenant_id_id_uq ON finnor_os.evidence_sources(tenant_id,id);
CREATE UNIQUE INDEX evidence_source_versions_tenant_id_id_uq ON finnor_os.evidence_source_versions(tenant_id,id);
CREATE TABLE finnor_os.primary_governance_versions (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id), id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), semantic_owner text NOT NULL CHECK(semantic_owner IN('S1','S2','S4','S5','S6')),
 schema_name text NOT NULL, issuer_id uuid NOT NULL, body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id,revision), FOREIGN KEY(tenant_id,issuer_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE TABLE finnor_os.primary_governance_heads (
 tenant_id uuid NOT NULL, id uuid NOT NULL, revision integer NOT NULL,
 state text NOT NULL CHECK(state IN('CURRENT','REVOKED')), reason text,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,id,revision) REFERENCES finnor_os.primary_governance_versions(tenant_id,id,revision)
);
CREATE TABLE finnor_os.v2_programmes (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, id uuid NOT NULL,
 work_id uuid NOT NULL, work_input_id uuid NOT NULL, work_input_digest text NOT NULL,
 root jsonb NOT NULL, intake jsonb NOT NULL CHECK(octet_length(intake::text)<=1048576), intake_digest text NOT NULL,
 starting_manifest jsonb NOT NULL CHECK(octet_length(starting_manifest::text)<=1048576), starting_digest text NOT NULL,
 idempotency_key text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL DEFAULT 'PROGRESS' CHECK(status IN('PROGRESS','WAITING','BLOCKED','STOPPED','RECONCILING','FAILED','COMPLETE')),
 invalidated boolean NOT NULL DEFAULT false, cancellation_requested_at timestamptz,
 active_claim_token uuid, active_claim_fence bigint, principal_artifact_id uuid,
 next_obligations jsonb NOT NULL DEFAULT '[]', required_approvals jsonb NOT NULL DEFAULT '[]',
 reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);
CREATE TABLE finnor_os.v2_assertions (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 assertion_id uuid NOT NULL, revision integer NOT NULL, body jsonb NOT NULL, digest text NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,programme_id,assertion_id,revision),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v2_programmes(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.v2_plans (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL, id uuid NOT NULL,
 programme_revision integer NOT NULL, body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576), digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v2_programmes(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.s6_primary_requests (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL, id uuid NOT NULL,
 source_profile_id uuid NOT NULL, body jsonb NOT NULL CHECK(octet_length(body::text)<=262144), digest text NOT NULL,
 operation_key text NOT NULL, source_version integer NOT NULL, consent_id uuid NOT NULL,
 consent_version integer NOT NULL, possible_egress_at timestamptz, acknowledged_at timestamptz,
 status text NOT NULL DEFAULT 'INTENDED' CHECK(status IN('INTENDED','POSSIBLE_EGRESS','ACKNOWLEDGED','OBSERVED','NONRESPONSE','UNAVAILABLE','UNKNOWN','CANCELLED_BEFORE_DISPATCH')),
 next_cursor text, pages_received integer NOT NULL DEFAULT 0, revalidation_of uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), UNIQUE(tenant_id,principal_id,operation_key),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v2_programmes(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,source_profile_id,source_version) REFERENCES finnor_os.primary_governance_versions(tenant_id,id,revision),
 FOREIGN KEY(tenant_id,consent_id,consent_version) REFERENCES finnor_os.primary_governance_versions(tenant_id,id,revision)
);
CREATE TABLE finnor_os.s1_primary_observations (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL, id uuid NOT NULL,
 request_id uuid NOT NULL, page_id text NOT NULL, source_revision text NOT NULL,
 evidence_source_id uuid NOT NULL, evidence_version_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576), digest text NOT NULL,
 retrieved_at timestamptz NOT NULL, PRIMARY KEY(tenant_id,principal_id,id),
 UNIQUE(tenant_id,principal_id,request_id,page_id,source_revision),
 FOREIGN KEY(tenant_id,principal_id,request_id) REFERENCES finnor_os.s6_primary_requests(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,evidence_source_id) REFERENCES finnor_os.evidence_sources(tenant_id,id),
 FOREIGN KEY(tenant_id,evidence_version_id) REFERENCES finnor_os.evidence_source_versions(tenant_id,id)
);
CREATE TABLE finnor_os.v2_reconciliations (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL, id uuid NOT NULL,
 assertion_id uuid NOT NULL, assertion_revision integer NOT NULL, body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),
 digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,id), FOREIGN KEY(tenant_id,principal_id,programme_id,assertion_id,assertion_revision)
 REFERENCES finnor_os.v2_assertions(tenant_id,principal_id,programme_id,assertion_id,revision)
);
CREATE TABLE finnor_os.v2_claim_checks (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL, id text NOT NULL CHECK(id ~ '^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608), digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v2_programmes(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.v2_findings (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL, id uuid NOT NULL,
 assertion_id uuid NOT NULL, assertion_revision integer NOT NULL, evidence_digest text NOT NULL,
 checker_digest text NOT NULL, body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608), digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,principal_id,id),
 UNIQUE(tenant_id,principal_id,programme_id,assertion_id,assertion_revision,evidence_digest,checker_digest),
 FOREIGN KEY(tenant_id,principal_id,programme_id,assertion_id,assertion_revision)
 REFERENCES finnor_os.v2_assertions(tenant_id,principal_id,programme_id,assertion_id,revision)
);
CREATE TABLE finnor_os.v2_dependencies (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL,
 finding_id uuid NOT NULL, key text NOT NULL, revision bigint NOT NULL,
 PRIMARY KEY(tenant_id,principal_id,finding_id,key),
 FOREIGN KEY(tenant_id,principal_id,finding_id) REFERENCES finnor_os.v2_findings(tenant_id,principal_id,id)
);
CREATE INDEX v2_dependency_closure ON finnor_os.v2_dependencies(tenant_id,key);
CREATE TABLE finnor_os.v2_events (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, programme_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 semantic_owner text NOT NULL, kind text NOT NULL, body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v2_programmes(tenant_id,principal_id,id)
);
-- S5 specialization of an EXISTING canonical retained reservation, shared across
-- all Works. No fresh resource pool or reservation is created by V2.
CREATE TABLE finnor_os.s5_primary_charges (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, reservation_id text NOT NULL, grant_id uuid NOT NULL,
 charge_key text NOT NULL, programme_id uuid NOT NULL, request_id uuid,
 reserved_micro_usd numeric(100,0) NOT NULL CHECK(reserved_micro_usd>=0),
 actual_micro_usd numeric(100,0) CHECK(actual_micro_usd>=0),
 possible_additional_micro_usd numeric(100,0) NOT NULL CHECK(possible_additional_micro_usd>=0),
 reserved_cpu_micros numeric(100,0) NOT NULL CHECK(reserved_cpu_micros>=0),
 actual_cpu_micros numeric(100,0), bytes bigint NOT NULL DEFAULT 0, human_seconds integer NOT NULL DEFAULT 0,
 kind text NOT NULL, receipt jsonb, reconciled_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,reservation_id,charge_key),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES finnor_os.s5_reservations(tenant_id,reservation_id),
 FOREIGN KEY(tenant_id,principal_id,programme_id) REFERENCES finnor_os.v2_programmes(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.v2_consumer_dependencies (
 tenant_id uuid NOT NULL, finding_id uuid NOT NULL, consumer_type text NOT NULL, consumer_id uuid NOT NULL,
 dependency_ref jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,finding_id,consumer_type,consumer_id),
 FOREIGN KEY(tenant_id,consumer_id) REFERENCES finnor_os.underwriting_runs(tenant_id,id)
);
CREATE FUNCTION finnor_os.v2_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN RAISE EXCEPTION 'V2 frozen assertions, raw evidence, checks and findings are immutable; append a linked revision'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['v2_programmes','v2_assertions','v2_plans','s6_primary_requests','s1_primary_observations','v2_reconciliations','v2_claim_checks','v2_findings','v2_dependencies','v2_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY v2_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  IF t NOT IN('v2_programmes','s6_primary_requests') THEN
   EXECUTE format('CREATE TRIGGER v2_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.v2_immutable()',t);
  END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['primary_governance_versions','primary_governance_heads','s5_primary_charges','v2_consumer_dependencies'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY primary_owner_tenant ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id())',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
 END LOOP;
 GRANT UPDATE ON finnor_os.v2_programmes,finnor_os.s6_primary_requests,finnor_os.primary_governance_heads,finnor_os.s5_primary_charges TO finnor_app;
 CREATE TRIGGER primary_version_immutable BEFORE UPDATE OR DELETE ON finnor_os.primary_governance_versions FOR EACH ROW EXECUTE FUNCTION finnor_os.v2_immutable();
 CREATE TRIGGER v2_consumer_dependency_immutable BEFORE UPDATE OR DELETE ON finnor_os.v2_consumer_dependencies FOR EACH ROW EXECUTE FUNCTION finnor_os.v2_immutable();
END $$;

-- Existing P4/S1 revision rows are the serialization owner. Extend their actual
-- invalidation closure without replacing the original function or weakening it.
CREATE FUNCTION finnor_os.v2_revision_closure() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE f uuid; BEGIN
 FOR f IN SELECT DISTINCT finding_id FROM finnor_os.v2_dependencies WHERE tenant_id=NEW.tenant_id AND key=NEW.key AND revision<NEW.revision LOOP
  UPDATE finnor_os.v2_programmes p SET invalidated=true,reason='OWNER_DEPENDENCY_CHANGED',updated_at=clock_timestamp()
   WHERE p.tenant_id=NEW.tenant_id AND EXISTS(SELECT 1 FROM finnor_os.v2_findings a WHERE a.tenant_id=p.tenant_id AND a.principal_id=p.principal_id AND a.programme_id=p.id AND a.id=f);
  PERFORM finnor_os.p4_touch_source(NEW.tenant_id,'primary-finding:'||f::text);
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.v2_revision_closure() FROM PUBLIC;
CREATE TRIGGER v2_revision_closure AFTER INSERT OR UPDATE ON finnor_os.p4_source_revisions FOR EACH ROW EXECUTE FUNCTION finnor_os.v2_revision_closure();
CREATE FUNCTION finnor_os.primary_governance_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN PERFORM finnor_os.p4_touch_source(NEW.tenant_id,'primary-governance:'||NEW.id::text); RETURN NULL; END $$;
REVOKE ALL ON FUNCTION finnor_os.primary_governance_change() FROM PUBLIC;
CREATE TRIGGER primary_governance_change AFTER INSERT OR UPDATE ON finnor_os.primary_governance_heads FOR EACH ROW EXECUTE FUNCTION finnor_os.primary_governance_change();
CREATE FUNCTION finnor_os.primary_allocation_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_TABLE_NAME='s5_resource_heads' THEN
  PERFORM finnor_os.p4_touch_source(NEW.tenant_id,'s5-resource:'||NEW.resource_id);
 ELSIF NEW.status='RELEASED' OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason THEN
  PERFORM finnor_os.p4_touch_source(NEW.tenant_id,'primary-reservation-authority:'||NEW.reservation_id);
 END IF; RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.primary_allocation_change() FROM PUBLIC;
CREATE TRIGGER primary_resource_change AFTER INSERT OR UPDATE ON finnor_os.s5_resource_heads FOR EACH ROW EXECUTE FUNCTION finnor_os.primary_allocation_change();
CREATE TRIGGER primary_reservation_authority_change AFTER UPDATE ON finnor_os.s5_reservations FOR EACH ROW EXECUTE FUNCTION finnor_os.primary_allocation_change();
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('advance_primary_diligence_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,'V2 Work-linked primary acquisition and independently checked finding. Live admission is not issued.');

-- The existing InvestmentCase owner can now represent genuine pre-LOI analysis.
-- The same case ID may later attach ONLY to its actual signed-LOI promoted Deal.
ALTER TABLE finnor_os.pe_investment_cases ALTER COLUMN deal_id DROP NOT NULL;
ALTER TABLE finnor_os.pe_investment_cases ADD COLUMN opportunity_id uuid;
ALTER TABLE finnor_os.pe_investment_cases ADD CONSTRAINT investment_case_opportunity_scope
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES finnor_os.pe_opportunities(tenant_id,id);
ALTER TABLE finnor_os.pe_investment_cases ADD CONSTRAINT investment_case_real_anchor
 CHECK(deal_id IS NOT NULL OR opportunity_id IS NOT NULL);
CREATE UNIQUE INDEX investment_case_one_active_opportunity ON finnor_os.pe_investment_cases(opportunity_id)
 WHERE state='active' AND opportunity_id IS NOT NULL;
CREATE FUNCTION finnor_os.assert_investment_case_v2() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE related record; mutable text[]:=ARRAY['state','activated_at','superseded_at','archived_at','version','updated_at']; BEGIN
 IF finnor_os.active_tenant_vertical(NEW.tenant_id)<>'private_equity' THEN RAISE EXCEPTION 'InvestmentCase requires active Private Equity vertical'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'draft' OR NEW.version<>1 THEN RAISE EXCEPTION 'InvestmentCase starts at immutable draft revision one'; END IF;
 ELSE
  IF OLD.deal_id IS NULL AND NEW.deal_id IS NOT NULL AND NEW.opportunity_id IS NOT NULL
   AND current_setting('app.pe_case_transition',true)='attach_signed_loi_deal' THEN
   mutable:=mutable||'deal_id';
   IF NEW.state<>OLD.state THEN RAISE EXCEPTION 'Deal attachment cannot change case disposition'; END IF;
  ELSIF NOT(OLD.state='draft' AND NEW.state IN('active','archived')
   OR OLD.state='active' AND NEW.state IN('superseded','archived')
   OR OLD.state='superseded' AND NEW.state='archived') THEN
   RAISE EXCEPTION 'Invalid InvestmentCase lifecycle transition';
  END IF;
  IF NEW.version<>OLD.version+1 OR (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable) THEN
   RAISE EXCEPTION 'InvestmentCase identity, anchor and canonical metadata remain frozen';
  END IF;
 END IF;
 IF NEW.deal_id IS NOT NULL THEN
  SELECT tenant_id,status,opportunity_id INTO related FROM finnor_os.pe_deals WHERE id=NEW.deal_id FOR UPDATE;
  IF related.tenant_id IS DISTINCT FROM NEW.tenant_id OR related.status<>'active'
   OR NEW.opportunity_id IS NOT NULL AND related.opportunity_id IS DISTINCT FROM NEW.opportunity_id THEN
   RAISE EXCEPTION 'InvestmentCase requires its actual active same-tenant signed-LOI Deal';
  END IF;
 END IF;
 IF NEW.opportunity_id IS NOT NULL THEN
  SELECT tenant_id,state INTO related FROM finnor_os.pe_opportunities WHERE id=NEW.opportunity_id FOR SHARE;
  IF related.tenant_id IS DISTINCT FROM NEW.tenant_id OR related.state='rejected' AND NEW.state<>'archived' THEN
   RAISE EXCEPTION 'InvestmentCase Opportunity is unavailable in its canonical scope';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER pe_world_mutation ON finnor_os.pe_investment_cases;
CREATE TRIGGER pe_world_mutation BEFORE INSERT OR UPDATE ON finnor_os.pe_investment_cases
 FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_investment_case_v2();

-- Preserve every other actual owner mapping rather than inventing Deal roots.
ALTER FUNCTION finnor_os.pe_entity_world_root(text,uuid) RENAME TO pe_entity_world_root_before_v2;
CREATE FUNCTION finnor_os.pe_entity_world_root(p_type text,p_id uuid)
 RETURNS TABLE(root_type text,root_id uuid,deal_id uuid) LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF p_type='pe_investment_case' AND EXISTS(SELECT 1 FROM finnor_os.pe_investment_cases c WHERE c.id=p_id AND c.deal_id IS NULL) THEN
  RETURN QUERY SELECT 'pe_opportunity'::text,c.opportunity_id,NULL::uuid FROM finnor_os.pe_investment_cases c WHERE c.id=p_id;
 ELSE RETURN QUERY SELECT * FROM finnor_os.pe_entity_world_root_before_v2(p_type,p_id); END IF;
END $$;
