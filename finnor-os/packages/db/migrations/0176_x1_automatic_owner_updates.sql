-- P7 coordination metadata for accepted X1 Work. Existing owners remain truth.
INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_x1_institution_update_v1','INTERACTIVE',ARRAY['INTERACTIVE'],
  'fixed','tenant','required',1,
  'P7 automatic X1 owner update under its existing Work episode and original resource parent.');
ALTER TABLE finnor_os.x1_compiler_episodes ADD COLUMN coordination_calls integer NOT NULL DEFAULT 0
 CHECK(coordination_calls BETWEEN 0 AND 124);
CREATE TABLE finnor_os.x1_compiler_updates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,principal_id uuid NOT NULL,
 work_id uuid NOT NULL,episode_id uuid NOT NULL,trigger_request_id uuid NOT NULL,
 owner_table text NOT NULL,owner_id text NOT NULL,change_digest text NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','PREPARED','SUBMITTED','COALESCED','BLOCKED','CANCELLED')),
 prepared_request jsonb,prepared_at timestamptz,next_request_id uuid,failure text,polls integer NOT NULL DEFAULT 0 CHECK(polls BETWEEN 0 AND 124),
 claim_token uuid,claim_fence bigint,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((prepared_request IS NULL)=(prepared_at IS NULL)),
 CHECK(state<>'PREPARED' OR prepared_request IS NOT NULL),
 CHECK(state NOT IN('SUBMITTED','COALESCED') OR next_request_id IS NOT NULL),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,principal_id,trigger_request_id,owner_table,owner_id,change_digest),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,episode_id) REFERENCES finnor_os.x1_compiler_episodes(tenant_id,id),
 FOREIGN KEY(tenant_id,trigger_request_id) REFERENCES finnor_os.x1_compiler_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,next_request_id) REFERENCES finnor_os.x1_compiler_requests(tenant_id,id)
);
CREATE INDEX x1_compiler_updates_pending ON finnor_os.x1_compiler_updates(tenant_id,principal_id,work_id,state);
ALTER TABLE finnor_os.x1_compiler_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.x1_compiler_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY x1_compiler_updates_principal ON finnor_os.x1_compiler_updates
 USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 REVOKE INSERT,DELETE ON finnor_os.x1_compiler_updates FROM finnor_app;
 GRANT SELECT,UPDATE ON finnor_os.x1_compiler_updates TO finnor_app;
END IF; END $$;

-- The handoff survives retries without accepting a replacement key, parent,
-- source population or preparation cut from a later coordinator delivery.
CREATE FUNCTION finnor_os.x1_update_handoff_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.work_id,NEW.episode_id,NEW.trigger_request_id,
     NEW.owner_table,NEW.owner_id,NEW.change_digest,NEW.created_at)
   IS DISTINCT FROM
    (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.work_id,OLD.episode_id,OLD.trigger_request_id,
     OLD.owner_table,OLD.owner_id,OLD.change_digest,OLD.created_at)
   OR OLD.prepared_request IS NOT NULL AND
    (NEW.prepared_request,NEW.prepared_at) IS DISTINCT FROM (OLD.prepared_request,OLD.prepared_at)
   OR OLD.next_request_id IS NOT NULL AND NEW.next_request_id IS DISTINCT FROM OLD.next_request_id THEN
  RAISE EXCEPTION 'X1_P7_IMMUTABLE_HANDOFF_CHANGED';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.x1_update_handoff_immutable() FROM PUBLIC;
CREATE TRIGGER x1_update_handoff_immutable BEFORE UPDATE ON finnor_os.x1_compiler_updates
 FOR EACH ROW EXECUTE FUNCTION finnor_os.x1_update_handoff_immutable();

CREATE FUNCTION finnor_os.x1_owner_change_trigger() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE owner_body jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 t uuid; changed_owner_id text; entity_type text; change_hash text; q record; update_id uuid; can_run boolean;
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(OLD)=to_jsonb(NEW) THEN RETURN NEW; END IF;
 t:=(owner_body->>'tenant_id')::uuid;
 IF t IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 changed_owner_id:=coalesce(owner_body->>'id',owner_body->>'document_id',t::text);
 change_hash:=encode(sha256(convert_to(jsonb_build_array(TG_OP,owner_body)::text,'UTF8')),'hex');
 entity_type:=CASE TG_TABLE_NAME
  WHEN 'pe_deals' THEN 'pe_deal' WHEN 'pe_funds' THEN 'pe_fund' WHEN 'pe_vehicles' THEN 'pe_vehicle'
  WHEN 'pe_investment_cases' THEN 'pe_investment_case' WHEN 'pe_debt_facilities' THEN 'pe_debt_facility'
  WHEN 'pe_metric_series' THEN 'pe_metric_series' WHEN 'pe_requests' THEN 'pe_request'
  WHEN 'pe_findings' THEN 'pe_finding' WHEN 'pe_decisions' THEN 'pe_decision'
  WHEN 'pe_fund_vehicle_links' THEN 'pe_fund_vehicle_link' WHEN 'pe_company_party_roles' THEN 'pe_company_party_role'
  WHEN 'pe_debt_facility_lenders' THEN 'pe_debt_facility_lender' WHEN 'pe_dependencies' THEN 'pe_dependency'
  WHEN 'users' THEN 'user' WHEN 'external_organizations' THEN 'external_organization'
  WHEN 'documents' THEN 'document' WHEN 'document_version_heads' THEN 'document' END;
 FOR q IN SELECT r.*,e.wall_deadline,e.coordination_calls FROM finnor_os.x1_compiler_requests r
  JOIN finnor_os.x1_compiler_episodes e ON e.tenant_id=r.tenant_id AND e.id=r.episode_id
  JOIN finnor_os.works w ON w.tenant_id=r.tenant_id AND w.id=r.work_id
  WHERE r.tenant_id=t AND r.status<>'CANCELLED' AND w.status<>'cancelled'
   AND NOT EXISTS(SELECT 1 FROM finnor_os.x1_compiler_requests newer WHERE newer.tenant_id=r.tenant_id
     AND newer.principal_id=r.principal_id AND newer.work_id=r.work_id AND newer.revision>r.revision)
   AND (TG_TABLE_NAME IN('x1_source_grants','x1_work_mandates')
      AND r.work_id::text=owner_body->>'work_id' AND r.principal_id::text=owner_body->>'principal_id'
    OR TG_TABLE_NAME='work_inputs' AND r.work_id::text=owner_body->>'work_id'
    OR TG_TABLE_NAME IN('x1_subject_identity_bindings','x1_subject_consents') AND e.institution_id=owner_body->>'institution_id'
    OR TG_TABLE_NAME='authority_states'
    OR entity_type IS NOT NULL AND EXISTS(SELECT 1
      FROM jsonb_array_elements(coalesce(r.input_manifest->'current'->'canonicalOwners','[]'::jsonb)) ref
      WHERE split_part(ref->>'ref','@',1)=entity_type||':'||CASE WHEN TG_TABLE_NAME='document_version_heads'
       THEN owner_body->>'document_id' ELSE changed_owner_id END))
 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('x1-update:'||q.episode_id::text,5517));
  can_run:=q.wall_deadline>clock_timestamp() AND q.coordination_calls<124
   AND NOT EXISTS(SELECT 1 FROM finnor_os.x1_compiler_updates pending
    WHERE pending.tenant_id=t AND pending.episode_id=q.episode_id AND pending.state IN('PENDING','PREPARED'));
  update_id:=NULL;
  INSERT INTO finnor_os.x1_compiler_updates(tenant_id,principal_id,work_id,episode_id,trigger_request_id,
    owner_table,owner_id,change_digest,state,failure)
   VALUES(t,q.principal_id,q.work_id,q.episode_id,q.id,TG_TABLE_NAME,changed_owner_id,change_hash,
    CASE WHEN q.wall_deadline<=clock_timestamp() OR q.coordination_calls>=124 THEN 'BLOCKED' ELSE 'PENDING' END,
    CASE WHEN q.wall_deadline<=clock_timestamp() OR q.coordination_calls>=124 THEN 'X1_P7_ORIGINAL_COORDINATION_ENVELOPE_EXHAUSTED' END)
   ON CONFLICT(tenant_id,principal_id,trigger_request_id,owner_table,owner_id,change_digest) DO NOTHING
   RETURNING id INTO update_id;
  IF update_id IS NOT NULL AND can_run THEN
   INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
    VALUES(t,'run_x1_institution_update_v1',jsonb_build_object('tenantId',t,'principalId',q.principal_id,
     'updateId',update_id),'x1-update:'||update_id::text||':initial','interactive',1,'reconcilable')
    ON CONFLICT(idempotency_key) DO NOTHING;
  END IF;
 END LOOP;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION finnor_os.x1_owner_change_trigger() FROM PUBLIC;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['x1_source_grants','x1_work_mandates','work_inputs','x1_subject_identity_bindings',
  'x1_subject_consents','authority_states','users','external_organizations','documents','document_version_heads',
  'pe_deals','pe_funds','pe_vehicles','pe_investment_cases','pe_debt_facilities','pe_metric_series',
  'pe_requests','pe_findings','pe_decisions','pe_fund_vehicle_links','pe_company_party_roles',
  'pe_debt_facility_lenders','pe_dependencies'] LOOP
  EXECUTE format('CREATE TRIGGER x1_owner_change AFTER INSERT OR UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.x1_owner_change_trigger()',tab);
 END LOOP;
END $$;
