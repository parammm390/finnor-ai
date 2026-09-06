-- Phase 5 forward-only production repair.
--
-- Production already records an independent 0108_operating_product_closure.sql.
-- This migration never edits or reuses that identity. It reasserts the PE/core
-- contracts that are absent from the live schema, idempotently, then installs the
-- canonical Water-retirement barrier. Historical rows and migration records are
-- preserved; this is a forward repair, not a ledger rewrite.

-- Re-assert the candidate vertical boundary and PE execution graph. CREATE TABLE
-- and index statements are made idempotent because these bodies already ran on a
-- fresh candidate database under their original 0104-0107 identities.

-- PE Phase 0/1 prerequisite recovered from the actual repository audit:
-- one tenant vertical identity and one runtime canonical-truth registry.
--
-- Existing deployments predate vertical identity and are Water businesses, so the
-- migration backfills them to `water` and preserves that behavior for newly created
-- legacy tenants. `none` is an explicit persisted identity, never an absent row.
-- Vertical packages own their tables and mutations; Core only resolves registered
-- identities and enforces tenant/vertical boundaries.

CREATE TABLE IF NOT EXISTS finnor_os.vertical_definitions (
  key text PRIMARY KEY,
  display_name text NOT NULL CHECK (btrim(display_name)<>''),
  implementation_owner text NOT NULL CHECK (btrim(implementation_owner)<>''),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vertical_definitions_key_check CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$')
);

INSERT INTO finnor_os.vertical_definitions(key,display_name,implementation_owner)
VALUES
  ('none','No business vertical','@finnor/db'),
  ('water','Water','existing-water-packages'),
  ('private_equity','Private Equity','@finnor/private-equity')
ON CONFLICT (key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  implementation_owner=EXCLUDED.implementation_owner,
  updated_at=now();

CREATE TABLE IF NOT EXISTS finnor_os.tenant_vertical_assignments (
  tenant_id uuid PRIMARY KEY REFERENCES finnor_os.tenants(id) ON DELETE CASCADE,
  vertical_key text NOT NULL REFERENCES finnor_os.vertical_definitions(key),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  effective_from timestamptz NOT NULL DEFAULT now(),
  source_system text NOT NULL DEFAULT 'finnor' CHECK (btrim(source_system)<>''),
  source_ref text,
  created_by text NOT NULL DEFAULT 'system:legacy-water-default' CHECK (btrim(created_by)<>''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO finnor_os.tenant_vertical_assignments(tenant_id,vertical_key,source_system,created_by)
SELECT id,'water','migration:0104','system:legacy-water-default'
FROM finnor_os.tenants
ON CONFLICT (tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION finnor_os.assign_legacy_default_vertical() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  INSERT INTO finnor_os.tenant_vertical_assignments(tenant_id,vertical_key,source_system,created_by)
  VALUES (NEW.id,'water','tenant_create_trigger','system:legacy-water-default')
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenants_assign_legacy_default_vertical ON finnor_os.tenants;
CREATE TRIGGER tenants_assign_legacy_default_vertical
AFTER INSERT ON finnor_os.tenants FOR EACH ROW
EXECUTE FUNCTION finnor_os.assign_legacy_default_vertical();

-- This is both the Phase 0 disposition ledger and the Business Truth Registry.
-- One row identifies the canonical table and one deterministic writable owner.
-- A null vertical_key means Core truth available in every vertical.
CREATE TABLE IF NOT EXISTS finnor_os.canonical_truth_registry (
  entity_type text PRIMARY KEY,
  vertical_key text REFERENCES finnor_os.vertical_definitions(key),
  source_schema text NOT NULL DEFAULT 'finnor_os' CHECK (source_schema='finnor_os'),
  source_table text NOT NULL,
  id_column text NOT NULL DEFAULT 'id',
  tenant_column text NOT NULL DEFAULT 'tenant_id',
  writable_owner text NOT NULL CHECK (btrim(writable_owner)<>''),
  mutation_boundary text NOT NULL CHECK (btrim(mutation_boundary)<>''),
  work_attachable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canonical_truth_registry_entity_type_check CHECK (entity_type ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT canonical_truth_registry_identifier_check CHECK (
    source_table ~ '^[a-z][a-z0-9_]{1,62}$'
    AND id_column ~ '^[a-z][a-z0-9_]{1,62}$'
    AND tenant_column ~ '^[a-z][a-z0-9_]{1,62}$'
  )
);

INSERT INTO finnor_os.canonical_truth_registry
  (entity_type,vertical_key,source_table,id_column,tenant_column,writable_owner,mutation_boundary,work_attachable)
VALUES
  ('tenant',NULL,'tenants','id','id','@finnor/db','tenant provisioning',false),
  ('user',NULL,'users','id','tenant_id','@finnor/db','identity/access fabric',true),
  ('org_unit',NULL,'org_units','id','tenant_id','@finnor/db','company world',true),
  ('tenant_location',NULL,'tenant_locations','id','tenant_id','@finnor/db','company world',true),
  ('external_organization',NULL,'external_organizations','id','tenant_id','@finnor/db','company world',true),
  ('external_contact',NULL,'external_contacts','id','tenant_id','@finnor/db','company world',true),
  ('document',NULL,'documents','id','tenant_id','@finnor/data-platform','canonical document writes',true),
  ('evidence_source',NULL,'evidence_sources','id','tenant_id','@finnor/memory','evidence ingestion',false),
  ('evidence_source_version',NULL,'evidence_source_versions','id','tenant_id','@finnor/memory','evidence ingestion',false),
  ('task',NULL,'tasks','id','tenant_id','@finnor/data-platform','canonical task writes',true),
  ('work',NULL,'works','id','tenant_id','@finnor/db','durable Work kernel',true),
  ('domain_action',NULL,'domain_actions','id','tenant_id','@finnor/orchestration','gated action runtime',true),
  ('workflow_run',NULL,'workflow_runs','id','tenant_id','@finnor/workflow-runtime','workflow runtime',true),
  ('workflow_step',NULL,'workflow_steps','id','tenant_id','@finnor/workflow-runtime','workflow runtime',true),
  ('business_operation',NULL,'business_operations','id','tenant_id','@finnor/db','business operation boundary',true),
  ('business_operation_target',NULL,'business_operation_targets','id','tenant_id','@finnor/db','business operation boundary',false),
  ('decision_receipt',NULL,'decision_receipts','id','tenant_id','@finnor/orchestration','DecisionReceipt finalization',true),
  ('business_event',NULL,'business_events','id','tenant_id','@finnor/data-platform','BusinessEvent append boundary',false),
  ('delegation',NULL,'delegations','id','tenant_id','@finnor/plugin-universal-actions','delegation mutation boundary',true),
  ('acknowledgement_request',NULL,'acknowledgement_requests','id','tenant_id','@finnor/plugin-universal-actions','acknowledgement mutation boundary',true),
  ('communication_delivery',NULL,'communication_deliveries','id','tenant_id','@finnor/plugin-universal-actions','delivery observation boundary',true),
  ('internal_event',NULL,'internal_events','id','tenant_id','@finnor/plugin-universal-actions','internal event boundary',true),
  ('document_share',NULL,'document_shares','id','tenant_id','@finnor/plugin-universal-actions','document share boundary',true),
  ('computer_run',NULL,'computer_runs','id','tenant_id','@finnor/computer','computer execution boundary',true),
  ('household','water','households','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('contact','water','contacts','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('technician','water','technicians','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('equipment','water','equipment','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('service_visit','water','service_visits','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('maintenance_agreement','water','maintenance_agreements','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('lead','water','leads','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('opportunity','water','opportunities','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('quote','water','quotes','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('proposal','water','proposals','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('work_order','water','work_orders','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('appointment','water','appointments','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('invoice','water','invoices','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('payment','water','payments','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('conversation','water','conversations','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('call','water','calls','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('message','water','messages','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('communication','water','communications_log','id','tenant_id','existing-water-packages','canonical data platform',true),
  ('inventory_item','water','inventory_items','id','tenant_id','existing-water-packages','native inventory boundary',true)
ON CONFLICT (entity_type) DO UPDATE SET
  vertical_key=EXCLUDED.vertical_key,
  source_schema=EXCLUDED.source_schema,
  source_table=EXCLUDED.source_table,
  id_column=EXCLUDED.id_column,
  tenant_column=EXCLUDED.tenant_column,
  writable_owner=EXCLUDED.writable_owner,
  mutation_boundary=EXCLUDED.mutation_boundary,
  work_attachable=EXCLUDED.work_attachable,
  updated_at=now();

CREATE OR REPLACE FUNCTION finnor_os.active_tenant_vertical(p_tenant uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,finnor_os AS $$
  SELECT vertical_key FROM finnor_os.tenant_vertical_assignments WHERE tenant_id=p_tenant
$$;

CREATE OR REPLACE FUNCTION finnor_os.canonical_entity_available(p_tenant uuid,p_type text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,finnor_os AS $$
  SELECT EXISTS (
    SELECT 1
    FROM finnor_os.canonical_truth_registry r
    LEFT JOIN finnor_os.vertical_definitions v ON v.key=r.vertical_key
    WHERE r.entity_type=p_type
      AND (r.vertical_key IS NULL OR (r.vertical_key=finnor_os.active_tenant_vertical(p_tenant) AND v.active))
  )
$$;

CREATE OR REPLACE FUNCTION finnor_os.canonical_entity_work_attachable(p_tenant uuid,p_type text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,finnor_os AS $$
  SELECT EXISTS (
    SELECT 1 FROM finnor_os.canonical_truth_registry r
    LEFT JOIN finnor_os.vertical_definitions v ON v.key=r.vertical_key
    WHERE r.entity_type=p_type AND r.work_attachable
      AND (r.vertical_key IS NULL OR (r.vertical_key=finnor_os.active_tenant_vertical(p_tenant) AND v.active))
  )
$$;

-- Runtime lookup replaces the repeatedly amended CASE statement. Identifiers are
-- migration-owned, regex-constrained, and quoted with format(%I); callers can supply
-- only the entity type and UUID value.
CREATE OR REPLACE FUNCTION finnor_os.canonical_entity_tenant(p_type text,p_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE registration record; resolved uuid;
BEGIN
  SELECT source_schema,source_table,id_column,tenant_column INTO registration
  FROM finnor_os.canonical_truth_registry WHERE entity_type=p_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'unsupported canonical entity type: %',p_type; END IF;
  EXECUTE format('SELECT %I FROM %I.%I WHERE %I=$1',
    registration.tenant_column,registration.source_schema,registration.source_table,registration.id_column)
  INTO resolved USING p_id;
  RETURN resolved;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_canonical_ref_tenant(p_type text,p_id uuid,p_tenant uuid,p_label text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF p_id IS NOT NULL AND finnor_os.canonical_entity_tenant(p_type,p_id) IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION '% canonical reference crosses tenant boundary or is missing',p_label;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.configure_tenant_vertical(
  p_tenant uuid,p_vertical text,p_expected_version integer,p_created_by text,
  p_source_system text DEFAULT 'finnor',p_source_ref text DEFAULT NULL
) RETURNS TABLE(
  tenant_id uuid,vertical_key text,version integer,effective_from timestamptz,
  source_system text,source_ref text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE current_row finnor_os.tenant_vertical_assignments%ROWTYPE;
DECLARE registration record; has_rows boolean;
BEGIN
  IF finnor_os.request_tenant_id() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'tenant vertical mutation crosses authenticated tenant boundary';
  END IF;
  IF coalesce(btrim(p_created_by),'')='' OR coalesce(btrim(p_source_system),'')='' THEN
    RAISE EXCEPTION 'tenant vertical provenance is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finnor_os.vertical_definitions WHERE key=p_vertical AND active) THEN
    RAISE EXCEPTION 'unknown or inactive vertical: %',p_vertical;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tenant_vertical:'||p_tenant::text,0));
  SELECT * INTO current_row FROM finnor_os.tenant_vertical_assignments
  WHERE tenant_vertical_assignments.tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant vertical identity is missing'; END IF;
  IF current_row.version<>p_expected_version THEN RAISE EXCEPTION 'stale tenant vertical version'; END IF;
  IF current_row.vertical_key=p_vertical THEN
    RETURN QUERY SELECT current_row.tenant_id,current_row.vertical_key,current_row.version,
      current_row.effective_from,current_row.source_system,current_row.source_ref;
    RETURN;
  END IF;
  IF current_row.vertical_key<>'none' THEN
    FOR registration IN
      SELECT r.source_schema,r.source_table,r.tenant_column
      FROM finnor_os.canonical_truth_registry r WHERE r.vertical_key=current_row.vertical_key
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I=$1 LIMIT 1)',
        registration.source_schema,registration.source_table,registration.tenant_column)
      INTO has_rows USING p_tenant;
      IF has_rows THEN
        RAISE EXCEPTION 'cannot switch vertical while % canonical truth exists',current_row.vertical_key;
      END IF;
    END LOOP;
  END IF;
  UPDATE finnor_os.tenant_vertical_assignments a
  SET vertical_key=p_vertical,version=a.version+1,effective_from=now(),
      source_system=p_source_system,source_ref=p_source_ref,created_by=p_created_by,updated_at=now()
  WHERE a.tenant_id=p_tenant;
  INSERT INTO finnor_os.business_events(tenant_id,entity_type,entity_id,event_type,payload,source)
  VALUES (p_tenant,'tenant',p_tenant,'tenant_vertical_changed',
    jsonb_build_object('from',current_row.vertical_key,'to',p_vertical,'fromVersion',current_row.version,'toVersion',current_row.version+1,'actor',p_created_by,'sourceRef',p_source_ref),
    p_source_system);
  RETURN QUERY SELECT a.tenant_id,a.vertical_key,a.version,a.effective_from,a.source_system,a.source_ref
    FROM finnor_os.tenant_vertical_assignments a WHERE a.tenant_id=p_tenant;
END $$;

-- Existing vertical-owned Water rows remain fully supported for tenants whose
-- active vertical is Water. The same tables fail closed for `none` and PE
-- tenants, so registering PE does not accidentally expose Water semantics.
CREATE OR REPLACE FUNCTION finnor_os.assert_row_vertical() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF finnor_os.active_tenant_vertical(NEW.tenant_id) IS DISTINCT FROM TG_ARGV[0] THEN
    RAISE EXCEPTION '% is unsupported for tenant active vertical %',
      TG_TABLE_NAME,coalesce(finnor_os.active_tenant_vertical(NEW.tenant_id),'missing');
  END IF;
  RETURN NEW;
END $$;

DO $water_guards$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'households','contacts','technicians','equipment','service_visits','maintenance_agreements',
    'leads','opportunities','quotes','proposals','work_orders','appointments','invoices','payments',
    'conversations','calls','messages','communications_log','inventory_items'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS registered_vertical_scope ON finnor_os.%I',table_name);
    EXECUTE format(
      'CREATE TRIGGER registered_vertical_scope BEFORE INSERT OR UPDATE ON finnor_os.%I '
      'FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_row_vertical(%L)',table_name,'water'
    );
  END LOOP;
END $water_guards$;

ALTER TABLE finnor_os.work_entity_links DROP CONSTRAINT IF EXISTS work_entity_links_entity_type_check;

CREATE OR REPLACE FUNCTION finnor_os.assert_work_entity_link_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE work_tenant uuid; entity_tenant uuid;
BEGIN
  SELECT tenant_id INTO work_tenant FROM finnor_os.works WHERE id=NEW.work_id;
  IF NOT finnor_os.canonical_entity_work_attachable(NEW.tenant_id,NEW.entity_type) THEN
    RAISE EXCEPTION 'canonical entity type is not registered as Work-attachable for the active vertical';
  END IF;
  entity_tenant := finnor_os.canonical_entity_tenant(NEW.entity_type,NEW.entity_id);
  IF work_tenant IS NULL OR entity_tenant IS NULL THEN RAISE EXCEPTION 'canonical Work link references an unknown entity'; END IF;
  IF work_tenant IS DISTINCT FROM NEW.tenant_id OR entity_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'canonical Work link crosses tenant boundary';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS work_entity_links_scope ON finnor_os.work_entity_links;
CREATE TRIGGER work_entity_links_scope BEFORE INSERT OR UPDATE ON finnor_os.work_entity_links
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_work_entity_link_scope();

ALTER TABLE finnor_os.vertical_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.vertical_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vertical_catalog_read ON finnor_os.vertical_definitions;
CREATE POLICY vertical_catalog_read ON finnor_os.vertical_definitions FOR SELECT USING (true);

ALTER TABLE finnor_os.canonical_truth_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.canonical_truth_registry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS canonical_truth_catalog_read ON finnor_os.canonical_truth_registry;
CREATE POLICY canonical_truth_catalog_read ON finnor_os.canonical_truth_registry FOR SELECT USING (true);

ALTER TABLE finnor_os.tenant_vertical_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.tenant_vertical_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON finnor_os.tenant_vertical_assignments;
CREATE POLICY tenant_isolation ON finnor_os.tenant_vertical_assignments
USING (tenant_id=finnor_os.request_tenant_id())
WITH CHECK (tenant_id=finnor_os.request_tenant_id());

REVOKE ALL ON FUNCTION finnor_os.active_tenant_vertical(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.canonical_entity_available(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.canonical_entity_work_attachable(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.canonical_entity_tenant(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_canonical_ref_tenant(text,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.configure_tenant_vertical(uuid,text,integer,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_row_vertical() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    REVOKE ALL ON finnor_os.vertical_definitions,finnor_os.canonical_truth_registry,finnor_os.tenant_vertical_assignments FROM finnor_app;
    GRANT SELECT ON finnor_os.vertical_definitions,finnor_os.canonical_truth_registry,finnor_os.tenant_vertical_assignments TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.active_tenant_vertical(uuid) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.canonical_entity_available(uuid,text) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.canonical_entity_work_attachable(uuid,text) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.canonical_entity_tenant(text,uuid) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.assert_canonical_ref_tenant(text,uuid,uuid,text) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.configure_tenant_vertical(uuid,text,integer,text,text,text) TO finnor_app;
  END IF;
END $grants$;

COMMENT ON TABLE finnor_os.canonical_truth_registry IS
  'Canonical Business Truth Registry and Phase 0 disposition ledger: one entity type, source table, vertical scope, and writable owner.';
COMMENT ON TABLE finnor_os.tenant_vertical_assignments IS
  'One explicit runtime vertical identity per authenticated tenant; none and water are real values, never inferred from entity payloads.';


-- Private Equity Phase 2: canonical signed-LOI -> verified-close execution graph.
-- PE owns these tables and mutations. Existing Core owns identity, Work, Task,
-- Document, Evidence, authority/approval, DecisionReceipt, and BusinessEvent.

DO $parent_keys$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace='finnor_os'::regnamespace AND conname='documents_tenant_id_id_key') THEN
    ALTER TABLE finnor_os.documents ADD CONSTRAINT documents_tenant_id_id_key UNIQUE (tenant_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace='finnor_os'::regnamespace AND conname='decision_receipts_tenant_id_id_key') THEN
    ALTER TABLE finnor_os.decision_receipts ADD CONSTRAINT decision_receipts_tenant_id_id_key UNIQUE (tenant_id,id);
  END IF;
END $parent_keys$;

CREATE TABLE IF NOT EXISTS finnor_os.pe_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  target_organization_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name)<>''),
  code_name text CHECK (code_name IS NULL OR btrim(code_name)<>''),
  deal_lead_employee_id uuid NOT NULL,
  signed_loi_at timestamptz NOT NULL,
  signed_loi_document_id uuid,
  target_closing_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','terminated')),
  actual_close_at timestamptz,
  close_authority_decision_id uuid,
  close_decision_receipt_id uuid,
  terminated_at timestamptz,
  termination_reason text,
  termination_authority_decision_id uuid,
  termination_decision_receipt_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  graph_version integer NOT NULL DEFAULT 1 CHECK (graph_version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_deals_tenant_id_id_key UNIQUE (tenant_id,id),
  CONSTRAINT pe_deals_source_identity_key UNIQUE (tenant_id,source_system,external_id),
  CONSTRAINT pe_deals_target_tenant_fkey FOREIGN KEY (tenant_id,target_organization_id)
    REFERENCES finnor_os.external_organizations(tenant_id,id),
  CONSTRAINT pe_deals_lead_tenant_fkey FOREIGN KEY (tenant_id,deal_lead_employee_id)
    REFERENCES finnor_os.users(tenant_id,id),
  CONSTRAINT pe_deals_loi_document_tenant_fkey FOREIGN KEY (tenant_id,signed_loi_document_id)
    REFERENCES finnor_os.documents(tenant_id,id),
  CONSTRAINT pe_deals_close_authority_tenant_fkey FOREIGN KEY (tenant_id,close_authority_decision_id)
    REFERENCES finnor_os.authority_decisions(tenant_id,id),
  CONSTRAINT pe_deals_close_receipt_tenant_fkey FOREIGN KEY (tenant_id,close_decision_receipt_id)
    REFERENCES finnor_os.decision_receipts(tenant_id,id),
  CONSTRAINT pe_deals_termination_authority_tenant_fkey FOREIGN KEY (tenant_id,termination_authority_decision_id)
    REFERENCES finnor_os.authority_decisions(tenant_id,id),
  CONSTRAINT pe_deals_termination_receipt_tenant_fkey FOREIGN KEY (tenant_id,termination_decision_receipt_id)
    REFERENCES finnor_os.decision_receipts(tenant_id,id),
  CONSTRAINT pe_deals_terminal_truth_check CHECK (
    (status='active' AND actual_close_at IS NULL AND terminated_at IS NULL AND termination_reason IS NULL)
    OR (status='closed' AND actual_close_at IS NOT NULL AND terminated_at IS NULL AND termination_reason IS NULL)
    OR (status='terminated' AND actual_close_at IS NULL AND terminated_at IS NOT NULL AND btrim(termination_reason)<>'')
  )
);
CREATE INDEX IF NOT EXISTS pe_deals_tenant_status_target_idx ON finnor_os.pe_deals(tenant_id,status,target_closing_at,id);
CREATE INDEX IF NOT EXISTS pe_deals_tenant_target_idx ON finnor_os.pe_deals(tenant_id,target_organization_id,id);

CREATE TABLE IF NOT EXISTS finnor_os.pe_deal_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  party_type text NOT NULL CHECK (party_type IN ('employee','team','external_organization','external_contact')),
  party_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN (
    'buyer_sponsor','target_management','seller','sell_side_banker','lender',
    'buyer_legal_counsel','seller_legal_counsel','qoe_advisor','tax_advisor',
    'commercial_advisor','technology_advisor','insurance_advisor','other'
  )),
  role_label text,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','removed')),
  removed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_deal_parties_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_deal_parties_deal_tenant_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_deal_parties_other_role_check CHECK ((role='other')=(role_label IS NOT NULL AND btrim(role_label)<>'')),
  CONSTRAINT pe_deal_parties_removed_check CHECK ((state='active' AND removed_at IS NULL) OR (state='removed' AND removed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS pe_deal_parties_active_identity_idx
  ON finnor_os.pe_deal_parties(deal_id,party_type,party_id,role) WHERE state='active';
CREATE INDEX IF NOT EXISTS pe_deal_parties_tenant_deal_role_idx ON finnor_os.pe_deal_parties(tenant_id,deal_id,role,state,id);

CREATE TABLE IF NOT EXISTS finnor_os.pe_workstreams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('financial_diligence','legal','tax','commercial','technology','financing','insurance','regulatory','closing','custom')),
  name text NOT NULL CHECK (btrim(name)<>''),
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'not_started' CHECK (state IN ('not_started','active','complete','cancelled')),
  completed_at timestamptz,
  cancelled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_workstreams_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_workstreams_deal_tenant_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_workstreams_terminal_check CHECK (
    (state IN ('not_started','active') AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (state='complete' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state='cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS pe_workstreams_active_identity_idx ON finnor_os.pe_workstreams(deal_id,kind,lower(name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS pe_workstreams_tenant_deal_state_idx ON finnor_os.pe_workstreams(tenant_id,deal_id,state,id);

CREATE TABLE IF NOT EXISTS finnor_os.pe_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  requested_from_deal_party_id uuid NOT NULL,
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  request_text text NOT NULL CHECK (btrim(request_text)<>''),
  requested_at timestamptz NOT NULL,
  due_at timestamptz,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','fulfilled','cancelled')),
  requires_accepted_deliverable boolean NOT NULL DEFAULT false,
  acknowledged_at timestamptz,
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_requests_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_requests_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_requests_party_fkey FOREIGN KEY (tenant_id,deal_id,requested_from_deal_party_id)
    REFERENCES finnor_os.pe_deal_parties(tenant_id,deal_id,id),
  CONSTRAINT pe_requests_state_timestamps_check CHECK (
    (state='open' AND acknowledged_at IS NULL AND fulfilled_at IS NULL AND cancelled_at IS NULL)
    OR (state='acknowledged' AND acknowledged_at IS NOT NULL AND fulfilled_at IS NULL AND cancelled_at IS NULL)
    OR (state='fulfilled' AND fulfilled_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state='cancelled' AND fulfilled_at IS NULL AND cancelled_at IS NOT NULL AND btrim(cancellation_reason)<>'')
  )
);
CREATE INDEX IF NOT EXISTS pe_requests_tenant_deal_state_due_idx ON finnor_os.pe_requests(tenant_id,deal_id,state,due_at,id);
CREATE INDEX IF NOT EXISTS pe_requests_tenant_workstream_state_idx ON finnor_os.pe_requests(tenant_id,workstream_id,state,id);

CREATE TABLE IF NOT EXISTS finnor_os.pe_deliverables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  request_id uuid,
  responsible_deal_party_id uuid NOT NULL,
  description text NOT NULL CHECK (btrim(description)<>''),
  kind text NOT NULL CHECK (btrim(kind)<>''),
  due_at timestamptz,
  state text NOT NULL DEFAULT 'expected' CHECK (state IN ('expected','received','accepted','rejected','superseded','cancelled')),
  requires_document boolean NOT NULL DEFAULT true,
  required_for_workstream_completion boolean NOT NULL DEFAULT true,
  received_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  superseded_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_deliverables_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_deliverables_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_deliverables_request_fkey FOREIGN KEY (tenant_id,deal_id,request_id)
    REFERENCES finnor_os.pe_requests(tenant_id,deal_id,id),
  CONSTRAINT pe_deliverables_party_fkey FOREIGN KEY (tenant_id,deal_id,responsible_deal_party_id)
    REFERENCES finnor_os.pe_deal_parties(tenant_id,deal_id,id),
  CONSTRAINT pe_deliverables_state_timestamps_check CHECK (
    (state='expected' AND received_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND superseded_at IS NULL AND cancelled_at IS NULL)
    OR (state='received' AND received_at IS NOT NULL AND accepted_at IS NULL AND rejected_at IS NULL AND superseded_at IS NULL AND cancelled_at IS NULL)
    OR (state='accepted' AND received_at IS NOT NULL AND accepted_at IS NOT NULL AND superseded_at IS NULL AND cancelled_at IS NULL)
    OR (state='rejected' AND received_at IS NOT NULL AND rejected_at IS NOT NULL AND btrim(rejection_reason)<>'' AND superseded_at IS NULL AND cancelled_at IS NULL)
    OR (state='superseded' AND superseded_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state='cancelled' AND cancelled_at IS NOT NULL AND btrim(cancellation_reason)<>'')
  )
);
CREATE INDEX IF NOT EXISTS pe_deliverables_tenant_deal_state_due_idx ON finnor_os.pe_deliverables(tenant_id,deal_id,state,due_at,id);
CREATE INDEX IF NOT EXISTS pe_deliverables_tenant_request_idx ON finnor_os.pe_deliverables(tenant_id,request_id,state,id);

CREATE TABLE IF NOT EXISTS finnor_os.pe_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  related_request_id uuid,
  related_deliverable_id uuid,
  statement text NOT NULL CHECK (btrim(statement)<>''),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  materiality text NOT NULL CHECK (materiality IN ('immaterial','non_material','material','critical')),
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','accepted','superseded')),
  required_for_workstream_completion boolean NOT NULL DEFAULT false,
  disposition text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  accepted_at timestamptz,
  superseded_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_findings_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_findings_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_findings_request_fkey FOREIGN KEY (tenant_id,deal_id,related_request_id)
    REFERENCES finnor_os.pe_requests(tenant_id,deal_id,id),
  CONSTRAINT pe_findings_deliverable_fkey FOREIGN KEY (tenant_id,deal_id,related_deliverable_id)
    REFERENCES finnor_os.pe_deliverables(tenant_id,deal_id,id),
  CONSTRAINT pe_findings_state_timestamps_check CHECK (
    (state='open' AND resolved_at IS NULL AND accepted_at IS NULL AND superseded_at IS NULL)
    OR (state='resolved' AND resolved_at IS NOT NULL AND btrim(disposition)<>'')
    OR (state='accepted' AND accepted_at IS NOT NULL AND btrim(disposition)<>'')
    OR (state='superseded' AND superseded_at IS NOT NULL AND btrim(disposition)<>'')
  )
);
CREATE INDEX IF NOT EXISTS pe_findings_tenant_deal_state_idx ON finnor_os.pe_findings(tenant_id,deal_id,state,severity,id);

CREATE TABLE IF NOT EXISTS finnor_os.pe_deal_risks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  statement text NOT NULL CHECK (btrim(statement)<>''),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  response text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','mitigating','resolved','accepted')),
  required_for_workstream_completion boolean NOT NULL DEFAULT false,
  mitigating_at timestamptz,
  resolved_at timestamptz,
  accepted_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_deal_risks_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_deal_risks_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_deal_risks_state_timestamps_check CHECK (
    (state='open' AND mitigating_at IS NULL AND resolved_at IS NULL AND accepted_at IS NULL)
    OR (state='mitigating' AND mitigating_at IS NOT NULL AND resolved_at IS NULL AND accepted_at IS NULL)
    OR (state='resolved' AND resolved_at IS NOT NULL AND btrim(response)<>'')
    OR (state='accepted' AND accepted_at IS NOT NULL AND btrim(response)<>'')
  )
);
CREATE INDEX IF NOT EXISTS pe_deal_risks_tenant_deal_state_idx ON finnor_os.pe_deal_risks(tenant_id,deal_id,state,severity,id);

CREATE TABLE IF NOT EXISTS finnor_os.pe_finding_risk_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  deal_risk_id uuid NOT NULL,
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT pe_finding_risk_links_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_finding_risk_links_finding_fkey FOREIGN KEY (tenant_id,deal_id,finding_id)
    REFERENCES finnor_os.pe_findings(tenant_id,deal_id,id),
  CONSTRAINT pe_finding_risk_links_risk_fkey FOREIGN KEY (tenant_id,deal_id,deal_risk_id)
    REFERENCES finnor_os.pe_deal_risks(tenant_id,deal_id,id),
  CONSTRAINT pe_finding_risk_links_identity_key UNIQUE (finding_id,deal_risk_id)
);

CREATE TABLE IF NOT EXISTS finnor_os.pe_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name)<>''),
  kind text NOT NULL CHECK (btrim(kind)<>''),
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  target_at timestamptz NOT NULL,
  achieved_at timestamptz,
  cancelled_at timestamptz,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','achieved','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_milestones_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_milestones_deal_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_milestones_state_timestamps_check CHECK (
    (state='pending' AND achieved_at IS NULL AND cancelled_at IS NULL)
    OR (state='achieved' AND achieved_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state='cancelled' AND achieved_at IS NULL AND cancelled_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS pe_milestones_tenant_deal_state_target_idx ON finnor_os.pe_milestones(tenant_id,deal_id,state,target_at,id);

CREATE TABLE IF NOT EXISTS finnor_os.pe_closing_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  condition_text text NOT NULL CHECK (btrim(condition_text)<>''),
  category text NOT NULL CHECK (btrim(category)<>''),
  required_for_close boolean NOT NULL DEFAULT true,
  evidence_required boolean NOT NULL DEFAULT true,
  waiver_requires_approval boolean NOT NULL DEFAULT true,
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  responsible_deal_party_id uuid,
  due_at timestamptz,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','evidence_pending','satisfied','waived','failed')),
  satisfied_at timestamptz,
  waived_at timestamptz,
  waiver_reason text,
  waiver_authority_decision_id uuid,
  waiver_decision_receipt_id uuid,
  failed_at timestamptz,
  failure_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_closing_conditions_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_closing_conditions_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_closing_conditions_party_fkey FOREIGN KEY (tenant_id,deal_id,responsible_deal_party_id)
    REFERENCES finnor_os.pe_deal_parties(tenant_id,deal_id,id),
  CONSTRAINT pe_closing_conditions_authority_tenant_fkey FOREIGN KEY (tenant_id,waiver_authority_decision_id)
    REFERENCES finnor_os.authority_decisions(tenant_id,id),
  CONSTRAINT pe_closing_conditions_receipt_tenant_fkey FOREIGN KEY (tenant_id,waiver_decision_receipt_id)
    REFERENCES finnor_os.decision_receipts(tenant_id,id),
  CONSTRAINT pe_closing_conditions_state_timestamps_check CHECK (
    (state IN ('open','evidence_pending') AND satisfied_at IS NULL AND waived_at IS NULL AND failed_at IS NULL)
    OR (state='satisfied' AND satisfied_at IS NOT NULL AND waived_at IS NULL AND failed_at IS NULL)
    OR (state='waived' AND waived_at IS NOT NULL AND btrim(waiver_reason)<>'' AND satisfied_at IS NULL AND failed_at IS NULL)
    OR (state='failed' AND failed_at IS NOT NULL AND btrim(failure_reason)<>'' AND satisfied_at IS NULL AND waived_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS pe_closing_conditions_tenant_deal_required_state_idx ON finnor_os.pe_closing_conditions(tenant_id,deal_id,required_for_close,state,id);

CREATE TABLE IF NOT EXISTS finnor_os.pe_closing_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  item_text text NOT NULL CHECK (btrim(item_text)<>''),
  category text NOT NULL CHECK (btrim(category)<>''),
  required_for_close boolean NOT NULL DEFAULT true,
  verification_evidence_required boolean NOT NULL DEFAULT true,
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  responsible_deal_party_id uuid,
  due_at timestamptz,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','ready','verified','cancelled')),
  ready_at timestamptz,
  verified_at timestamptz,
  verified_by_employee_id uuid,
  verification_source text,
  cancelled_at timestamptz,
  cancellation_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_closing_items_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_closing_items_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_closing_items_party_fkey FOREIGN KEY (tenant_id,deal_id,responsible_deal_party_id)
    REFERENCES finnor_os.pe_deal_parties(tenant_id,deal_id,id),
  CONSTRAINT pe_closing_items_verifier_fkey FOREIGN KEY (tenant_id,verified_by_employee_id)
    REFERENCES finnor_os.users(tenant_id,id),
  CONSTRAINT pe_closing_items_state_timestamps_check CHECK (
    (state='open' AND ready_at IS NULL AND verified_at IS NULL AND cancelled_at IS NULL)
    OR (state='ready' AND ready_at IS NOT NULL AND verified_at IS NULL AND cancelled_at IS NULL)
    OR (state='verified' AND ready_at IS NOT NULL AND verified_at IS NOT NULL AND cancelled_at IS NULL
      AND (verified_by_employee_id IS NOT NULL OR btrim(verification_source)<>''))
    OR (state='cancelled' AND verified_at IS NULL AND cancelled_at IS NOT NULL AND btrim(cancellation_reason)<>'')
  )
);
CREATE INDEX IF NOT EXISTS pe_closing_items_tenant_deal_required_state_idx ON finnor_os.pe_closing_items(tenant_id,deal_id,required_for_close,state,id);

CREATE TABLE IF NOT EXISTS finnor_os.pe_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  blocker_type text NOT NULL CHECK (blocker_type IN ('pe_workstream','pe_request','pe_deliverable','pe_finding','pe_deal_risk','pe_milestone','pe_closing_condition','pe_closing_item')),
  blocker_id uuid NOT NULL,
  blocked_type text NOT NULL CHECK (blocked_type IN ('pe_workstream','pe_request','pe_deliverable','pe_finding','pe_deal_risk','pe_milestone','pe_closing_condition','pe_closing_item')),
  blocked_id uuid NOT NULL,
  relation text NOT NULL DEFAULT 'blocks' CHECK (relation='blocks'),
  removed_at timestamptz,
  removed_by text,
  removal_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_dependencies_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_dependencies_deal_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_dependencies_not_self_check CHECK ((blocker_type,blocker_id)<>(blocked_type,blocked_id)),
  CONSTRAINT pe_dependencies_removed_check CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND removal_reason IS NULL)
    OR (removed_at IS NOT NULL AND btrim(removed_by)<>'' AND btrim(removal_reason)<>'')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS pe_dependencies_active_identity_idx
  ON finnor_os.pe_dependencies(deal_id,blocker_type,blocker_id,blocked_type,blocked_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS pe_dependencies_tenant_deal_blocked_idx ON finnor_os.pe_dependencies(tenant_id,deal_id,blocked_type,blocked_id) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS finnor_os.pe_document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('pe_deal','pe_request','pe_deliverable','pe_finding','pe_closing_condition','pe_closing_item')),
  entity_id uuid NOT NULL,
  document_id uuid NOT NULL,
  link_role text NOT NULL CHECK (link_role IN ('source','submission','accepted','rejected','superseded','governing','verification')),
  supersedes_link_id uuid REFERENCES finnor_os.pe_document_links(id),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_document_links_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_document_links_deal_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_document_links_document_fkey FOREIGN KEY (tenant_id,document_id)
    REFERENCES finnor_os.documents(tenant_id,id),
  CONSTRAINT pe_document_links_identity_key UNIQUE (entity_type,entity_id,document_id,link_role)
);
CREATE INDEX IF NOT EXISTS pe_document_links_tenant_deal_entity_idx ON finnor_os.pe_document_links(tenant_id,deal_id,entity_type,entity_id,created_at,id);

CREATE TABLE IF NOT EXISTS finnor_os.pe_evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('pe_finding','pe_deal_risk','pe_closing_condition','pe_closing_item')),
  entity_id uuid NOT NULL,
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id),
  evidence_version_id uuid REFERENCES finnor_os.evidence_source_versions(id),
  relationship text NOT NULL CHECK (relationship IN ('supports','verifies','authorizes')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_evidence_links_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_evidence_links_deal_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_evidence_links_identity_key UNIQUE (entity_type,entity_id,evidence_source_id,evidence_version_id,relationship)
);
CREATE INDEX IF NOT EXISTS pe_evidence_links_tenant_deal_entity_idx ON finnor_os.pe_evidence_links(tenant_id,deal_id,entity_type,entity_id,created_at,id);

CREATE OR REPLACE FUNCTION finnor_os.pe_party_tenant(p_type text,p_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE resolved uuid;
BEGIN
  CASE p_type
    WHEN 'employee' THEN SELECT tenant_id INTO resolved FROM finnor_os.users WHERE id=p_id AND status='active';
    WHEN 'team' THEN SELECT tenant_id INTO resolved FROM finnor_os.org_units WHERE id=p_id AND active;
    WHEN 'external_organization' THEN SELECT tenant_id INTO resolved FROM finnor_os.external_organizations WHERE id=p_id AND active;
    WHEN 'external_contact' THEN SELECT tenant_id INTO resolved FROM finnor_os.external_contacts WHERE id=p_id AND active;
    ELSE RAISE EXCEPTION 'unsupported PE PartyRef type: %',p_type;
  END CASE;
  RETURN resolved;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_entity_deal(p_type text,p_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE resolved uuid;
BEGIN
  CASE p_type
    WHEN 'pe_deal' THEN SELECT id INTO resolved FROM finnor_os.pe_deals WHERE id=p_id;
    WHEN 'pe_deal_party' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_deal_parties WHERE id=p_id;
    WHEN 'pe_workstream' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_workstreams WHERE id=p_id;
    WHEN 'pe_request' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_requests WHERE id=p_id;
    WHEN 'pe_deliverable' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_deliverables WHERE id=p_id;
    WHEN 'pe_finding' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_findings WHERE id=p_id;
    WHEN 'pe_deal_risk' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_deal_risks WHERE id=p_id;
    WHEN 'pe_dependency' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_dependencies WHERE id=p_id;
    WHEN 'pe_milestone' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_milestones WHERE id=p_id;
    WHEN 'pe_closing_condition' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_closing_conditions WHERE id=p_id;
    WHEN 'pe_closing_item' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_closing_items WHERE id=p_id;
    WHEN 'pe_document_link' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_document_links WHERE id=p_id;
    WHEN 'pe_evidence_link' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_evidence_links WHERE id=p_id;
    WHEN 'pe_finding_risk_link' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_finding_risk_links WHERE id=p_id;
    ELSE RETURN NULL;
  END CASE;
  RETURN resolved;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_endpoint_resolved(p_type text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE resolved boolean;
BEGIN
  CASE p_type
    WHEN 'pe_workstream' THEN SELECT state IN ('complete','cancelled') INTO resolved FROM finnor_os.pe_workstreams WHERE id=p_id;
    WHEN 'pe_request' THEN SELECT state IN ('fulfilled','cancelled') INTO resolved FROM finnor_os.pe_requests WHERE id=p_id;
    WHEN 'pe_deliverable' THEN SELECT state IN ('accepted','superseded','cancelled') INTO resolved FROM finnor_os.pe_deliverables WHERE id=p_id;
    WHEN 'pe_finding' THEN SELECT state IN ('resolved','accepted','superseded') INTO resolved FROM finnor_os.pe_findings WHERE id=p_id;
    WHEN 'pe_deal_risk' THEN SELECT state IN ('resolved','accepted') INTO resolved FROM finnor_os.pe_deal_risks WHERE id=p_id;
    WHEN 'pe_milestone' THEN SELECT state IN ('achieved','cancelled') INTO resolved FROM finnor_os.pe_milestones WHERE id=p_id;
    WHEN 'pe_closing_condition' THEN SELECT state IN ('satisfied','waived') INTO resolved FROM finnor_os.pe_closing_conditions WHERE id=p_id;
    WHEN 'pe_closing_item' THEN SELECT state IN ('verified','cancelled') INTO resolved FROM finnor_os.pe_closing_items WHERE id=p_id;
    ELSE RAISE EXCEPTION 'unsupported PE dependency endpoint type: %',p_type;
  END CASE;
  RETURN coalesce(resolved,false);
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_governance_proof_valid(
  p_tenant uuid,p_resource_type text,p_resource_id uuid,p_capability text,
  p_authority_decision uuid,p_decision_receipt uuid,p_require_current_revision boolean DEFAULT false,
  p_require_approval boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE decision_row finnor_os.authority_decisions%ROWTYPE;
DECLARE current_revision integer;
BEGIN
  IF p_authority_decision IS NULL THEN RETURN false; END IF;
  SELECT * INTO decision_row FROM finnor_os.authority_decisions
  WHERE id=p_authority_decision AND tenant_id=p_tenant
    AND capability=p_capability AND resource_type=p_resource_type AND resource_id=p_resource_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_require_current_revision THEN
    SELECT coalesce((SELECT revision FROM finnor_os.authority_states WHERE tenant_id=p_tenant),1) INTO current_revision;
    IF decision_row.authority_revision<>current_revision THEN RETURN false; END IF;
  END IF;
  IF p_require_approval AND decision_row.outcome<>'approval_required' THEN RETURN false; END IF;
  IF decision_row.outcome='allowed' THEN
    IF p_decision_receipt IS NULL THEN RETURN true; END IF;
    RETURN EXISTS (
      SELECT 1 FROM finnor_os.decision_receipts r
      WHERE r.id=p_decision_receipt AND r.tenant_id=p_tenant
        AND decision_row.domain_action_id IS NOT NULL
        AND r.domain_action_id=decision_row.domain_action_id
        AND r.finalized_at IS NOT NULL AND r.failure IS NULL
    );
  END IF;
  IF decision_row.outcome<>'approval_required' OR p_decision_receipt IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1
    FROM finnor_os.authority_approval_requests ar
    JOIN finnor_os.domain_actions da ON da.id=ar.domain_action_id AND da.tenant_id=ar.tenant_id
    JOIN finnor_os.decision_receipts r ON r.domain_action_id=da.id AND r.tenant_id=da.tenant_id
    WHERE ar.tenant_id=p_tenant AND ar.authority_decision_id=p_authority_decision AND ar.status='approved'
      AND r.id=p_decision_receipt AND r.finalized_at IS NOT NULL AND r.failure IS NULL
      AND coalesce((r.approval->>'required')::boolean,false)
      AND coalesce(btrim(r.approval->>'approvedBy'),'')<>''
  );
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_deal_root_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='INSERT' AND (
    NEW.status<>'active' OR NEW.version<>1 OR NEW.graph_version<>1
    OR NEW.actual_close_at IS NOT NULL OR NEW.close_authority_decision_id IS NOT NULL
    OR NEW.close_decision_receipt_id IS NOT NULL OR NEW.terminated_at IS NOT NULL
    OR NEW.termination_reason IS NOT NULL OR NEW.termination_authority_decision_id IS NOT NULL
    OR NEW.termination_decision_receipt_id IS NOT NULL OR NEW.archived_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PE Deal must be created as an unarchived active canonical root at version 1';
  END IF;
  IF finnor_os.active_tenant_vertical(NEW.tenant_id)<>'private_equity' THEN
    RAISE EXCEPTION 'PE Deal is unsupported for the tenant active vertical';
  END IF;
  IF finnor_os.pe_party_tenant('external_organization',NEW.target_organization_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE Deal target crosses tenant boundary, is missing, or is inactive';
  END IF;
  IF finnor_os.pe_party_tenant('employee',NEW.deal_lead_employee_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE Deal lead crosses tenant boundary, is missing, or is inactive';
  END IF;
  IF NEW.signed_loi_document_id IS NOT NULL
     AND finnor_os.canonical_entity_tenant('document',NEW.signed_loi_document_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE Deal signed LOI Document crosses tenant boundary or is missing';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_child_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE body jsonb:=to_jsonb(NEW); deal uuid; owner_tenant uuid; deal_row record; required_initial_state text;
BEGIN
  deal := (body->>'deal_id')::uuid;
  -- The Deal row is the serialization root for every graph mutation. A close
  -- cannot race a newly required condition/item into existence after its
  -- eligibility snapshot, even for a caller bypassing the TypeScript package.
  SELECT tenant_id,status INTO deal_row FROM finnor_os.pe_deals WHERE id=deal FOR UPDATE;
  IF deal_row.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE graph child crosses tenant/deal boundary or Deal is missing';
  END IF;
  IF deal_row.status<>'active' THEN RAISE EXCEPTION 'terminal PE Deal graph is immutable'; END IF;
  IF finnor_os.active_tenant_vertical(NEW.tenant_id)<>'private_equity' THEN
    RAISE EXCEPTION 'PE graph entity is unsupported for the tenant active vertical';
  END IF;
  IF TG_OP='INSERT' THEN
    IF (body->>'version')::integer<>1 THEN
      RAISE EXCEPTION 'PE graph entity must be created at version 1';
    END IF;
    required_initial_state:=CASE TG_TABLE_NAME
      WHEN 'pe_deal_parties' THEN 'active'
      WHEN 'pe_workstreams' THEN 'not_started'
      WHEN 'pe_requests' THEN 'open'
      WHEN 'pe_deliverables' THEN 'expected'
      WHEN 'pe_findings' THEN 'open'
      WHEN 'pe_deal_risks' THEN 'open'
      WHEN 'pe_milestones' THEN 'pending'
      WHEN 'pe_closing_conditions' THEN 'open'
      WHEN 'pe_closing_items' THEN 'open'
      ELSE NULL
    END;
    IF required_initial_state IS NOT NULL AND body->>'state' IS DISTINCT FROM required_initial_state THEN
      RAISE EXCEPTION 'PE % must be created in initial state %',TG_TABLE_NAME,required_initial_state;
    END IF;
    IF body ? 'archived_at' AND body->>'archived_at' IS NOT NULL THEN
      RAISE EXCEPTION 'PE graph entity cannot be created archived';
    END IF;
    IF TG_TABLE_NAME='pe_dependencies' AND (
      body->>'removed_at' IS NOT NULL OR body->>'removed_by' IS NOT NULL OR body->>'removal_reason' IS NOT NULL
    ) THEN RAISE EXCEPTION 'PE Dependency must be created active'; END IF;
    IF TG_TABLE_NAME='pe_closing_conditions' AND (
      body->>'waiver_authority_decision_id' IS NOT NULL OR body->>'waiver_decision_receipt_id' IS NOT NULL
    ) THEN RAISE EXCEPTION 'PE ClosingCondition cannot be created with waiver proof'; END IF;
    IF TG_TABLE_NAME='pe_closing_items' AND (
      body->>'verified_by_employee_id' IS NOT NULL OR body->>'verification_source' IS NOT NULL
    ) THEN RAISE EXCEPTION 'PE ClosingItem cannot be created with verification truth'; END IF;
  END IF;
  IF body ? 'owner_party_type' THEN
    IF (body->>'owner_party_type') NOT IN ('employee','team') THEN RAISE EXCEPTION 'PE owner must be an employee or team PartyRef'; END IF;
    owner_tenant := finnor_os.pe_party_tenant(body->>'owner_party_type',(body->>'owner_party_id')::uuid);
    IF owner_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'PE owner PartyRef crosses tenant boundary, is missing, or is inactive'; END IF;
  END IF;
  IF TG_OP='INSERT' AND body ? 'workstream_id' THEN
    IF NOT EXISTS (
      SELECT 1 FROM finnor_os.pe_workstreams w
      WHERE w.tenant_id=NEW.tenant_id AND w.deal_id=deal
        AND w.id=(body->>'workstream_id')::uuid AND w.state IN ('not_started','active')
      ) THEN RAISE EXCEPTION 'new PE execution truth requires an open Workstream'; END IF;
  END IF;
  IF TG_OP='INSERT' AND body ? 'requested_from_deal_party_id' THEN
    IF NOT EXISTS (
      SELECT 1 FROM finnor_os.pe_deal_parties p
      WHERE p.tenant_id=NEW.tenant_id AND p.deal_id=deal
        AND p.id=(body->>'requested_from_deal_party_id')::uuid AND p.state='active'
    ) THEN RAISE EXCEPTION 'new PE Request requires an active requested-from DealParty'; END IF;
  END IF;
  IF TG_OP='INSERT' AND body ? 'responsible_deal_party_id' AND body->>'responsible_deal_party_id' IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM finnor_os.pe_deal_parties p
      WHERE p.tenant_id=NEW.tenant_id AND p.deal_id=deal
        AND p.id=(body->>'responsible_deal_party_id')::uuid AND p.state='active'
    ) THEN RAISE EXCEPTION 'new PE execution truth requires an active responsible DealParty'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_deal_party_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF finnor_os.pe_party_tenant(NEW.party_type,NEW.party_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE DealParty PartyRef crosses tenant boundary, is missing, or is inactive';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_document_link_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE superseded record;
BEGIN
  IF finnor_os.pe_entity_deal(NEW.entity_type,NEW.entity_id) IS DISTINCT FROM NEW.deal_id THEN
    RAISE EXCEPTION 'PE Document link endpoint crosses Deal boundary or is missing';
  END IF;
  IF finnor_os.canonical_entity_tenant('document',NEW.document_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE Document link crosses tenant boundary or Document is missing';
  END IF;
  IF NEW.supersedes_link_id IS NOT NULL THEN
    SELECT tenant_id,deal_id,entity_type,entity_id INTO superseded FROM finnor_os.pe_document_links WHERE id=NEW.supersedes_link_id;
    IF superseded.tenant_id IS DISTINCT FROM NEW.tenant_id OR superseded.deal_id IS DISTINCT FROM NEW.deal_id
       OR superseded.entity_type IS DISTINCT FROM NEW.entity_type OR superseded.entity_id IS DISTINCT FROM NEW.entity_id THEN
      RAISE EXCEPTION 'superseded PE Document link crosses tenant, Deal, or endpoint boundary';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_evidence_link_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE source_row record; version_row record;
BEGIN
  IF finnor_os.pe_entity_deal(NEW.entity_type,NEW.entity_id) IS DISTINCT FROM NEW.deal_id THEN
    RAISE EXCEPTION 'PE Evidence link endpoint crosses Deal boundary or is missing';
  END IF;
  SELECT scope,tenant_id INTO source_row FROM finnor_os.evidence_sources WHERE id=NEW.evidence_source_id;
  IF NOT FOUND OR (source_row.scope='tenant' AND source_row.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
    RAISE EXCEPTION 'PE Evidence link crosses tenant boundary or Evidence source is missing';
  END IF;
  IF NEW.evidence_version_id IS NOT NULL THEN
    SELECT source_id,scope,tenant_id INTO version_row FROM finnor_os.evidence_source_versions WHERE id=NEW.evidence_version_id;
    IF NOT FOUND OR version_row.source_id IS DISTINCT FROM NEW.evidence_source_id
       OR version_row.scope IS DISTINCT FROM source_row.scope
       OR (version_row.scope='tenant' AND version_row.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
      RAISE EXCEPTION 'PE Evidence version crosses tenant/source boundary or is missing';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_dependency() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE endpoint_tenant uuid; endpoint_deal uuid; creates_cycle boolean;
BEGIN
  IF TG_OP='UPDATE' AND OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'removed PE Dependency is immutable';
  END IF;
  IF TG_OP='UPDATE' AND (
    NEW.tenant_id<>OLD.tenant_id OR NEW.deal_id<>OLD.deal_id OR
    NEW.blocker_type<>OLD.blocker_type OR NEW.blocker_id<>OLD.blocker_id OR
    NEW.blocked_type<>OLD.blocked_type OR NEW.blocked_id<>OLD.blocked_id OR NEW.relation<>OLD.relation
  ) THEN RAISE EXCEPTION 'PE Dependency endpoints and identity are immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pe_dependency:'||NEW.deal_id::text,0));
  endpoint_tenant := finnor_os.canonical_entity_tenant(NEW.blocker_type,NEW.blocker_id);
  endpoint_deal := finnor_os.pe_entity_deal(NEW.blocker_type,NEW.blocker_id);
  IF endpoint_tenant IS DISTINCT FROM NEW.tenant_id OR endpoint_deal IS DISTINCT FROM NEW.deal_id THEN
    RAISE EXCEPTION 'PE Dependency blocker crosses tenant/Deal boundary or is missing';
  END IF;
  endpoint_tenant := finnor_os.canonical_entity_tenant(NEW.blocked_type,NEW.blocked_id);
  endpoint_deal := finnor_os.pe_entity_deal(NEW.blocked_type,NEW.blocked_id);
  IF endpoint_tenant IS DISTINCT FROM NEW.tenant_id OR endpoint_deal IS DISTINCT FROM NEW.deal_id THEN
    RAISE EXCEPTION 'PE Dependency blocked endpoint crosses tenant/Deal boundary or is missing';
  END IF;
  IF TG_OP='UPDATE' AND OLD.removed_at IS DISTINCT FROM NEW.removed_at THEN
    IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN RAISE EXCEPTION 'removed PE Dependency cannot be restored'; END IF;
    IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stale PE Dependency version'; END IF;
  END IF;
  IF NEW.removed_at IS NOT NULL THEN RETURN NEW; END IF;
  IF finnor_os.pe_endpoint_resolved(NEW.blocked_type,NEW.blocked_id)
     AND NOT finnor_os.pe_endpoint_resolved(NEW.blocker_type,NEW.blocker_id) THEN
    RAISE EXCEPTION 'unresolved blocker cannot be added to an already resolved PE endpoint';
  END IF;
  WITH RECURSIVE reachable(entity_type,entity_id) AS (
    SELECT NEW.blocked_type,NEW.blocked_id
    UNION
    SELECT d.blocked_type,d.blocked_id
    FROM finnor_os.pe_dependencies d
    JOIN reachable r ON r.entity_type=d.blocker_type AND r.entity_id=d.blocker_id
    WHERE d.tenant_id=NEW.tenant_id AND d.deal_id=NEW.deal_id AND d.removed_at IS NULL
      AND (TG_OP='INSERT' OR d.id<>NEW.id)
  )
  SELECT EXISTS (SELECT 1 FROM reachable WHERE entity_type=NEW.blocker_type AND entity_id=NEW.blocker_id)
  INTO creates_cycle;
  IF creates_cycle THEN RAISE EXCEPTION 'PE blocking Dependency would create a cycle'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_evaluate_deal_close_eligibility(p_tenant uuid,p_deal uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE deal_row record;
DECLARE blocking_conditions jsonb; failed_conditions jsonb; invalid_waivers jsonb;
DECLARE unverified_items jsonb; blocking_dependencies jsonb; result jsonb;
BEGIN
  SELECT id,status,signed_loi_at,version,graph_version INTO deal_row
  FROM finnor_os.pe_deals WHERE tenant_id=p_tenant AND id=p_deal;
  IF NOT FOUND THEN RAISE EXCEPTION 'PE Deal not found in authenticated tenant'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'condition',condition_text,'state',state) ORDER BY condition_text,id),'[]'::jsonb)
  INTO blocking_conditions FROM finnor_os.pe_closing_conditions
  WHERE tenant_id=p_tenant AND deal_id=p_deal AND required_for_close AND state IN ('open','evidence_pending');

  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'condition',condition_text,'state',state,'reason',failure_reason) ORDER BY condition_text,id),'[]'::jsonb)
  INTO failed_conditions FROM finnor_os.pe_closing_conditions
  WHERE tenant_id=p_tenant AND deal_id=p_deal AND required_for_close AND state='failed';

  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'condition',condition_text,'authorityDecisionId',waiver_authority_decision_id,'decisionReceiptId',waiver_decision_receipt_id) ORDER BY condition_text,id),'[]'::jsonb)
  INTO invalid_waivers FROM finnor_os.pe_closing_conditions
  WHERE tenant_id=p_tenant AND deal_id=p_deal AND required_for_close AND state='waived'
    AND NOT finnor_os.pe_governance_proof_valid(
      p_tenant,'pe_closing_condition',id,'private_equity:waive_closing_condition',
      waiver_authority_decision_id,waiver_decision_receipt_id,false,waiver_requires_approval
    );

  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'item',item_text,'state',state) ORDER BY item_text,id),'[]'::jsonb)
  INTO unverified_items FROM finnor_os.pe_closing_items
  WHERE tenant_id=p_tenant AND deal_id=p_deal AND required_for_close AND state<>'verified';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'dependencyId',d.id,
    'blocker',jsonb_build_object('entityType',d.blocker_type,'entityId',d.blocker_id),
    'blocked',jsonb_build_object('entityType',d.blocked_type,'entityId',d.blocked_id),
    'relation',d.relation
  ) ORDER BY d.created_at,d.id),'[]'::jsonb)
  INTO blocking_dependencies
  FROM finnor_os.pe_dependencies d
  WHERE d.tenant_id=p_tenant AND d.deal_id=p_deal AND d.removed_at IS NULL
    AND NOT finnor_os.pe_endpoint_resolved(d.blocker_type,d.blocker_id)
    AND (
      (d.blocked_type='pe_closing_condition' AND EXISTS (
        SELECT 1 FROM finnor_os.pe_closing_conditions c WHERE c.id=d.blocked_id AND c.tenant_id=p_tenant AND c.deal_id=p_deal AND c.required_for_close
      ))
      OR (d.blocked_type='pe_closing_item' AND EXISTS (
        SELECT 1 FROM finnor_os.pe_closing_items i WHERE i.id=d.blocked_id AND i.tenant_id=p_tenant AND i.deal_id=p_deal AND i.required_for_close
      ))
    );

  result := jsonb_build_object(
    'dealId',p_deal,
    'dealState',deal_row.status,
    'dealVersion',deal_row.version,
    'graphVersion',deal_row.graph_version,
    'signedLoiPresent',deal_row.signed_loi_at IS NOT NULL,
    'blockingConditions',blocking_conditions,
    'failedConditions',failed_conditions,
    'unverifiedClosingItems',unverified_items,
    'blockingDependencies',blocking_dependencies,
    'invalidWaivers',invalid_waivers,
    'integrityErrors','[]'::jsonb,
    'eligible',deal_row.status='active' AND deal_row.signed_loi_at IS NOT NULL
      AND jsonb_array_length(blocking_conditions)=0
      AND jsonb_array_length(failed_conditions)=0
      AND jsonb_array_length(unverified_items)=0
      AND jsonb_array_length(blocking_dependencies)=0
      AND jsonb_array_length(invalid_waivers)=0
  );
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_state_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE old_body jsonb:=to_jsonb(OLD); new_body jsonb:=to_jsonb(NEW);
DECLARE old_state text; new_state text; eligibility jsonb;
BEGIN
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id THEN RAISE EXCEPTION 'PE canonical identity is immutable'; END IF;
  IF old_body ? 'deal_id' AND new_body->>'deal_id' IS DISTINCT FROM old_body->>'deal_id' THEN
    RAISE EXCEPTION 'PE Deal ownership is immutable';
  END IF;
  old_state := coalesce(old_body->>'state',old_body->>'status');
  new_state := coalesce(new_body->>'state',new_body->>'status');
  NEW.updated_at := now();
  IF new_state IS NOT DISTINCT FROM old_state THEN
    IF old_state IN ('closed','terminated','removed','complete','cancelled','fulfilled','accepted','rejected','superseded','resolved','achieved','satisfied','waived','failed','verified')
       AND (old_body-ARRAY['updated_at']) IS DISTINCT FROM (new_body-ARRAY['updated_at']) THEN
      RAISE EXCEPTION 'terminal PE entity state is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stale PE entity version'; END IF;

  CASE TG_TABLE_NAME
    WHEN 'pe_deals' THEN
      IF old_state<>'active' THEN RAISE EXCEPTION 'terminal PE Deal state is immutable'; END IF;
      IF new_state='closed' THEN
        IF current_setting('app.pe_deal_transition',true) IS DISTINCT FROM 'declare_closed' THEN
          RAISE EXCEPTION 'PE Deal may become closed only through declareDealClosed';
        END IF;
        IF NOT finnor_os.pe_governance_proof_valid(
          NEW.tenant_id,'pe_deal',NEW.id,'private_equity:close_deal',
          NEW.close_authority_decision_id,NEW.close_decision_receipt_id,true,false
        ) THEN RAISE EXCEPTION 'PE Deal close lacks current canonical authority/approval proof'; END IF;
        eligibility := finnor_os.pe_evaluate_deal_close_eligibility(NEW.tenant_id,NEW.id);
        IF NOT (eligibility->>'eligible')::boolean THEN RAISE EXCEPTION 'PE Deal is not close eligible: %',eligibility; END IF;
      ELSIF new_state='terminated' THEN
        IF current_setting('app.pe_deal_transition',true) IS DISTINCT FROM 'terminate' THEN
          RAISE EXCEPTION 'PE Deal may become terminated only through terminateDeal';
        END IF;
        IF NOT finnor_os.pe_governance_proof_valid(
          NEW.tenant_id,'pe_deal',NEW.id,'private_equity:terminate_deal',
          NEW.termination_authority_decision_id,NEW.termination_decision_receipt_id,true,false
        ) THEN RAISE EXCEPTION 'PE Deal termination lacks current canonical authority/approval proof'; END IF;
      ELSE RAISE EXCEPTION 'invalid PE Deal transition % -> %',old_state,new_state;
      END IF;
    WHEN 'pe_deal_parties' THEN
      IF NOT (old_state='active' AND new_state='removed') THEN RAISE EXCEPTION 'invalid DealParty transition % -> %',old_state,new_state; END IF;
    WHEN 'pe_workstreams' THEN
      IF NOT ((old_state='not_started' AND new_state IN ('active','cancelled')) OR (old_state='active' AND new_state IN ('complete','cancelled'))) THEN
        RAISE EXCEPTION 'invalid Workstream transition % -> %',old_state,new_state;
      END IF;
      IF new_state='complete' AND (
        EXISTS (SELECT 1 FROM finnor_os.pe_requests r WHERE r.workstream_id=NEW.id AND r.state NOT IN ('fulfilled','cancelled'))
        OR EXISTS (SELECT 1 FROM finnor_os.pe_deliverables d WHERE d.workstream_id=NEW.id AND d.required_for_workstream_completion AND d.state NOT IN ('accepted','superseded','cancelled'))
        OR EXISTS (SELECT 1 FROM finnor_os.pe_findings f WHERE f.workstream_id=NEW.id AND f.required_for_workstream_completion AND f.state='open')
        OR EXISTS (SELECT 1 FROM finnor_os.pe_deal_risks r WHERE r.workstream_id=NEW.id AND r.required_for_workstream_completion AND r.state IN ('open','mitigating'))
        OR EXISTS (SELECT 1 FROM finnor_os.pe_dependencies d WHERE d.deal_id=NEW.deal_id AND d.removed_at IS NULL
          AND d.blocked_type='pe_workstream' AND d.blocked_id=NEW.id AND NOT finnor_os.pe_endpoint_resolved(d.blocker_type,d.blocker_id))
      ) THEN RAISE EXCEPTION 'Workstream has unresolved mandatory requirements or blockers'; END IF;
    WHEN 'pe_requests' THEN
      IF NOT ((old_state='open' AND new_state IN ('acknowledged','fulfilled','cancelled')) OR (old_state='acknowledged' AND new_state IN ('fulfilled','cancelled'))) THEN
        RAISE EXCEPTION 'invalid Request transition % -> %',old_state,new_state;
      END IF;
      IF new_state='fulfilled' AND NEW.requires_accepted_deliverable
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_deliverables d WHERE d.request_id=NEW.id AND d.state='accepted') THEN
        RAISE EXCEPTION 'Request fulfillment requires an accepted Deliverable';
      END IF;
    WHEN 'pe_deliverables' THEN
      IF NOT (
        (old_state='expected' AND new_state IN ('received','superseded','cancelled'))
        OR (old_state='received' AND new_state IN ('accepted','rejected','superseded','cancelled'))
        OR (old_state='rejected' AND new_state IN ('received','superseded','cancelled'))
        OR (old_state='accepted' AND new_state='superseded')
      ) THEN RAISE EXCEPTION 'invalid Deliverable transition % -> %',old_state,new_state; END IF;
      IF new_state='accepted' AND NEW.requires_document
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_document_links l WHERE l.entity_type='pe_deliverable' AND l.entity_id=NEW.id AND l.link_role='accepted' AND l.archived_at IS NULL) THEN
        RAISE EXCEPTION 'Deliverable acceptance requires an explicitly accepted canonical Document link';
      END IF;
    WHEN 'pe_findings' THEN
      IF NOT ((old_state='open' AND new_state IN ('resolved','accepted','superseded')) OR (old_state IN ('resolved','accepted') AND new_state='superseded')) THEN
        RAISE EXCEPTION 'invalid Finding transition % -> %',old_state,new_state;
      END IF;
    WHEN 'pe_deal_risks' THEN
      IF NOT ((old_state='open' AND new_state IN ('mitigating','resolved','accepted')) OR (old_state='mitigating' AND new_state IN ('resolved','accepted'))) THEN
        RAISE EXCEPTION 'invalid DealRisk transition % -> %',old_state,new_state;
      END IF;
    WHEN 'pe_milestones' THEN
      IF NOT (old_state='pending' AND new_state IN ('achieved','cancelled')) THEN RAISE EXCEPTION 'invalid Milestone transition % -> %',old_state,new_state; END IF;
    WHEN 'pe_closing_conditions' THEN
      IF NOT (
        (old_state='open' AND new_state IN ('evidence_pending','satisfied','waived','failed'))
        OR (old_state='evidence_pending' AND new_state IN ('satisfied','waived','failed'))
      ) THEN RAISE EXCEPTION 'invalid ClosingCondition transition % -> %',old_state,new_state; END IF;
      IF new_state='satisfied' AND NEW.evidence_required
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_document_links l WHERE l.entity_type='pe_closing_condition' AND l.entity_id=NEW.id AND l.archived_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_evidence_links l WHERE l.entity_type='pe_closing_condition' AND l.entity_id=NEW.id AND l.archived_at IS NULL) THEN
        RAISE EXCEPTION 'ClosingCondition satisfaction requires canonical evidence or Document support';
      END IF;
      IF new_state='waived' AND NOT finnor_os.pe_governance_proof_valid(
        NEW.tenant_id,'pe_closing_condition',NEW.id,'private_equity:waive_closing_condition',
        NEW.waiver_authority_decision_id,NEW.waiver_decision_receipt_id,true,NEW.waiver_requires_approval
      ) THEN RAISE EXCEPTION 'ClosingCondition waiver lacks current canonical authority/approval proof'; END IF;
    WHEN 'pe_closing_items' THEN
      IF NOT ((old_state='open' AND new_state IN ('ready','cancelled')) OR (old_state='ready' AND new_state IN ('verified','cancelled'))) THEN
        RAISE EXCEPTION 'invalid ClosingItem transition % -> %',old_state,new_state;
      END IF;
      IF new_state='cancelled' AND NEW.required_for_close THEN RAISE EXCEPTION 'required ClosingItem cannot be cancelled'; END IF;
      IF new_state='verified' AND NEW.verification_evidence_required
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_document_links l WHERE l.entity_type='pe_closing_item' AND l.entity_id=NEW.id AND l.archived_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_evidence_links l WHERE l.entity_type='pe_closing_item' AND l.entity_id=NEW.id AND l.archived_at IS NULL) THEN
        RAISE EXCEPTION 'ClosingItem verification requires canonical evidence or Document support';
      END IF;
    ELSE RAISE EXCEPTION 'unrecognized PE lifecycle table: %',TG_TABLE_NAME;
  END CASE;

  -- A hard blocker has business meaning at the write boundary: downstream truth
  -- cannot be transitioned to a positively completed state while it remains.
  IF (
    (TG_TABLE_NAME='pe_workstreams' AND new_state='complete') OR
    (TG_TABLE_NAME='pe_requests' AND new_state='fulfilled') OR
    (TG_TABLE_NAME='pe_deliverables' AND new_state='accepted') OR
    (TG_TABLE_NAME='pe_findings' AND new_state IN ('resolved','accepted','superseded')) OR
    (TG_TABLE_NAME='pe_deal_risks' AND new_state IN ('resolved','accepted')) OR
    (TG_TABLE_NAME='pe_milestones' AND new_state='achieved') OR
    (TG_TABLE_NAME='pe_closing_conditions' AND new_state IN ('satisfied','waived')) OR
    (TG_TABLE_NAME='pe_closing_items' AND new_state='verified')
  ) AND EXISTS (
    SELECT 1 FROM finnor_os.pe_dependencies d
    WHERE d.tenant_id=NEW.tenant_id AND d.deal_id=(new_body->>'deal_id')::uuid
      AND d.blocked_type=CASE TG_TABLE_NAME
        WHEN 'pe_workstreams' THEN 'pe_workstream' WHEN 'pe_requests' THEN 'pe_request'
        WHEN 'pe_deliverables' THEN 'pe_deliverable' WHEN 'pe_findings' THEN 'pe_finding'
        WHEN 'pe_deal_risks' THEN 'pe_deal_risk' WHEN 'pe_milestones' THEN 'pe_milestone'
        WHEN 'pe_closing_conditions' THEN 'pe_closing_condition' WHEN 'pe_closing_items' THEN 'pe_closing_item'
      END
      AND d.blocked_id=NEW.id AND d.removed_at IS NULL
      AND NOT finnor_os.pe_endpoint_resolved(d.blocker_type,d.blocker_id)
  ) THEN RAISE EXCEPTION 'PE endpoint cannot complete while an unresolved hard blocker exists'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_versioned_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE old_body jsonb:=to_jsonb(OLD); new_body jsonb:=to_jsonb(NEW); mutable_columns text[];
BEGIN
  -- Graph maintenance changes only graph_version/updated_at and does not pretend
  -- the transaction-root business version changed.
  IF TG_TABLE_NAME='pe_deals'
     AND (new_body-'graph_version'-'updated_at')=(old_body-'graph_version'-'updated_at')
     AND (new_body->>'graph_version')::integer=(old_body->>'graph_version')::integer+1 THEN RETURN NEW; END IF;
  mutable_columns:=CASE TG_TABLE_NAME
    WHEN 'pe_deals' THEN ARRAY[
      'status','actual_close_at','close_authority_decision_id','close_decision_receipt_id',
      'terminated_at','termination_reason','termination_authority_decision_id','termination_decision_receipt_id',
      'version','graph_version','updated_at'
    ]
    WHEN 'pe_deal_parties' THEN ARRAY['state','removed_at','version','updated_at']
    WHEN 'pe_workstreams' THEN ARRAY['state','completed_at','cancelled_at','version','updated_at']
    WHEN 'pe_requests' THEN ARRAY[
      'state','acknowledged_at','fulfilled_at','cancelled_at','cancellation_reason','version','updated_at'
    ]
    WHEN 'pe_deliverables' THEN ARRAY[
      'state','received_at','accepted_at','rejected_at','rejection_reason','superseded_at',
      'cancelled_at','cancellation_reason','version','updated_at'
    ]
    WHEN 'pe_findings' THEN ARRAY['state','disposition','resolved_at','accepted_at','superseded_at','version','updated_at']
    WHEN 'pe_deal_risks' THEN ARRAY['state','response','mitigating_at','resolved_at','accepted_at','version','updated_at']
    WHEN 'pe_milestones' THEN ARRAY['state','achieved_at','cancelled_at','version','updated_at']
    WHEN 'pe_closing_conditions' THEN ARRAY[
      'state','satisfied_at','waived_at','waiver_reason','waiver_authority_decision_id',
      'waiver_decision_receipt_id','failed_at','failure_reason','version','updated_at'
    ]
    WHEN 'pe_closing_items' THEN ARRAY[
      'state','ready_at','verified_at','verified_by_employee_id','verification_source',
      'cancelled_at','cancellation_reason','version','updated_at'
    ]
    WHEN 'pe_dependencies' THEN ARRAY['removed_at','removed_by','removal_reason','version','updated_at']
    WHEN 'pe_finding_risk_links' THEN ARRAY['archived_at','version','updated_at']
    WHEN 'pe_document_links' THEN ARRAY['archived_at','version','updated_at']
    WHEN 'pe_evidence_links' THEN ARRAY['archived_at','version','updated_at']
    ELSE ARRAY['version','updated_at']
  END;
  IF (old_body-mutable_columns) IS DISTINCT FROM (new_body-mutable_columns) THEN
    RAISE EXCEPTION 'immutable PE business truth cannot be patched on %',TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME='pe_deals' AND old_body->>'status' IN ('closed','terminated')
     AND (old_body-ARRAY['updated_at']) IS DISTINCT FROM (new_body-ARRAY['updated_at']) THEN
    RAISE EXCEPTION 'terminal PE Deal state is immutable';
  END IF;
  IF TG_TABLE_NAME IN ('pe_dependencies','pe_document_links','pe_evidence_links','pe_finding_risk_links')
     AND (coalesce(old_body->>'removed_at',old_body->>'archived_at') IS NOT NULL)
     AND (old_body-ARRAY['updated_at']) IS DISTINCT FROM (new_body-ARRAY['updated_at']) THEN
    RAISE EXCEPTION 'archived or removed PE relationship is immutable';
  END IF;
  IF (old_body-ARRAY['version','updated_at']) IS NOT DISTINCT FROM (new_body-ARRAY['version','updated_at']) THEN
    RAISE EXCEPTION 'PE update must change canonical business truth on %',TG_TABLE_NAME;
  END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stale PE entity version'; END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.touch_pe_deal_graph() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE deal uuid; row_tenant uuid;
BEGIN
  deal := CASE WHEN TG_OP='DELETE' THEN (to_jsonb(OLD)->>'deal_id')::uuid ELSE (to_jsonb(NEW)->>'deal_id')::uuid END;
  row_tenant := CASE WHEN TG_OP='DELETE' THEN (to_jsonb(OLD)->>'tenant_id')::uuid ELSE (to_jsonb(NEW)->>'tenant_id')::uuid END;
  IF finnor_os.request_tenant_id() IS DISTINCT FROM row_tenant THEN
    RAISE EXCEPTION 'PE graph mutation crosses authenticated tenant';
  END IF;
  UPDATE finnor_os.pe_deals SET graph_version=graph_version+1,updated_at=now() WHERE id=deal;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS pe_deals_scope ON finnor_os.pe_deals;
CREATE TRIGGER pe_deals_scope BEFORE INSERT OR UPDATE ON finnor_os.pe_deals
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_deal_root_scope();
DROP TRIGGER IF EXISTS pe_deals_state ON finnor_os.pe_deals;
CREATE TRIGGER pe_deals_state BEFORE UPDATE OF status ON finnor_os.pe_deals
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_state_transition();

DROP TRIGGER IF EXISTS pe_version_guard ON finnor_os.pe_deals;
CREATE TRIGGER pe_version_guard BEFORE UPDATE ON finnor_os.pe_deals
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_versioned_update();

DO $child_triggers$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pe_deal_parties','pe_workstreams','pe_requests','pe_deliverables','pe_findings','pe_deal_risks',
    'pe_finding_risk_links','pe_milestones','pe_closing_conditions','pe_closing_items',
    'pe_dependencies','pe_document_links','pe_evidence_links'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS pe_child_scope ON finnor_os.%I',table_name);
    EXECUTE format('CREATE TRIGGER pe_child_scope BEFORE INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_child_scope()',table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS pe_graph_touch ON finnor_os.%I',table_name);
    EXECUTE format('CREATE TRIGGER pe_graph_touch AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.touch_pe_deal_graph()',table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS pe_version_guard ON finnor_os.%I',table_name);
    EXECUTE format('CREATE TRIGGER pe_version_guard BEFORE UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_versioned_update()',table_name);
  END LOOP;
END $child_triggers$;

DROP TRIGGER IF EXISTS pe_deal_parties_party_scope ON finnor_os.pe_deal_parties;
CREATE TRIGGER pe_deal_parties_party_scope BEFORE INSERT OR UPDATE OF party_type,party_id,tenant_id
ON finnor_os.pe_deal_parties FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_deal_party_scope();

DROP TRIGGER IF EXISTS pe_document_links_scope ON finnor_os.pe_document_links;
CREATE TRIGGER pe_document_links_scope BEFORE INSERT OR UPDATE ON finnor_os.pe_document_links
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_document_link_scope();

DROP TRIGGER IF EXISTS pe_evidence_links_scope ON finnor_os.pe_evidence_links;
CREATE TRIGGER pe_evidence_links_scope BEFORE INSERT OR UPDATE ON finnor_os.pe_evidence_links
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_evidence_link_scope();

DROP TRIGGER IF EXISTS pe_dependencies_cycle_scope ON finnor_os.pe_dependencies;
CREATE TRIGGER pe_dependencies_cycle_scope BEFORE INSERT OR UPDATE ON finnor_os.pe_dependencies
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_dependency();

DO $state_triggers$
DECLARE table_name text; state_column text;
BEGIN
  FOR table_name,state_column IN
    SELECT * FROM (VALUES
      ('pe_deal_parties','state'),('pe_workstreams','state'),('pe_requests','state'),
      ('pe_deliverables','state'),('pe_findings','state'),('pe_deal_risks','state'),
      ('pe_milestones','state'),('pe_closing_conditions','state'),('pe_closing_items','state')
    ) AS lifecycle(table_name,state_column)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS pe_state_transition ON finnor_os.%I',table_name);
    EXECUTE format('CREATE TRIGGER pe_state_transition BEFORE UPDATE OF %I ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_state_transition()',state_column,table_name);
  END LOOP;
END $state_triggers$;

-- Every canonical PE creation and consequential transition appends to the
-- existing BusinessEvent timeline in the same transaction. This trigger is the
-- durable backstop beneath the package API; rejected mutations never emit.
CREATE OR REPLACE FUNCTION finnor_os.append_pe_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE old_body jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
DECLARE new_body jsonb:=to_jsonb(NEW); from_state text; to_state text;
DECLARE event_name text; entity_kind text; actor text; event_source text; evidence_refs jsonb:='[]'::jsonb;
BEGIN
  from_state:=coalesce(old_body->>'state',old_body->>'status');
  to_state:=coalesce(new_body->>'state',new_body->>'status');
  actor:=coalesce(nullif(current_setting('app.pe_actor',true),''),nullif(current_setting('app.user_id',true),''),new_body->>'created_by');
  event_source:=coalesce(nullif(current_setting('app.pe_source',true),''),new_body->>'source_system','@finnor/private-equity');
  entity_kind:=CASE TG_TABLE_NAME
    WHEN 'pe_deals' THEN 'pe_deal' WHEN 'pe_deal_parties' THEN 'pe_deal_party'
    WHEN 'pe_workstreams' THEN 'pe_workstream' WHEN 'pe_requests' THEN 'pe_request'
    WHEN 'pe_deliverables' THEN 'pe_deliverable' WHEN 'pe_findings' THEN 'pe_finding'
    WHEN 'pe_deal_risks' THEN 'pe_deal_risk' WHEN 'pe_finding_risk_links' THEN 'pe_finding_risk_link'
    WHEN 'pe_milestones' THEN 'pe_milestone' WHEN 'pe_closing_conditions' THEN 'pe_closing_condition'
    WHEN 'pe_closing_items' THEN 'pe_closing_item' WHEN 'pe_dependencies' THEN 'pe_dependency'
    WHEN 'pe_document_links' THEN 'pe_document_link' WHEN 'pe_evidence_links' THEN 'pe_evidence_link'
  END;

  IF TG_OP='INSERT' THEN
    event_name:=CASE TG_TABLE_NAME
      WHEN 'pe_deals' THEN 'pe_deal_created' WHEN 'pe_deal_parties' THEN 'pe_deal_party_added'
      WHEN 'pe_workstreams' THEN 'pe_workstream_created' WHEN 'pe_requests' THEN 'pe_request_created'
      WHEN 'pe_deliverables' THEN 'pe_deliverable_expected' WHEN 'pe_findings' THEN 'pe_finding_opened'
      WHEN 'pe_deal_risks' THEN 'pe_deal_risk_opened' WHEN 'pe_finding_risk_links' THEN 'pe_finding_risk_linked'
      WHEN 'pe_milestones' THEN 'pe_milestone_created' WHEN 'pe_closing_conditions' THEN 'pe_closing_condition_created'
      WHEN 'pe_closing_items' THEN 'pe_closing_item_created' WHEN 'pe_dependencies' THEN 'pe_dependency_created'
      WHEN 'pe_document_links' THEN 'pe_document_linked' WHEN 'pe_evidence_links' THEN 'pe_evidence_linked'
    END;
  ELSIF to_state IS DISTINCT FROM from_state THEN
    event_name:=CASE TG_TABLE_NAME
      WHEN 'pe_deals' THEN CASE to_state WHEN 'closed' THEN 'pe_deal_closed' WHEN 'terminated' THEN 'pe_deal_terminated' END
      WHEN 'pe_deal_parties' THEN 'pe_deal_party_'||to_state
      WHEN 'pe_workstreams' THEN 'pe_workstream_'||to_state
      WHEN 'pe_requests' THEN 'pe_request_'||to_state
      WHEN 'pe_deliverables' THEN 'pe_deliverable_'||to_state
      WHEN 'pe_findings' THEN 'pe_finding_'||to_state
      WHEN 'pe_deal_risks' THEN 'pe_deal_risk_'||to_state
      WHEN 'pe_milestones' THEN 'pe_milestone_'||to_state
      WHEN 'pe_closing_conditions' THEN 'pe_closing_condition_'||to_state
      WHEN 'pe_closing_items' THEN 'pe_closing_item_'||to_state
    END;
  ELSIF TG_TABLE_NAME='pe_dependencies' AND old_body->>'removed_at' IS NULL AND new_body->>'removed_at' IS NOT NULL THEN
    event_name:='pe_dependency_removed';
  ELSE
    RETURN NEW;
  END IF;

  IF event_name IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME IN ('pe_findings','pe_deal_risks','pe_closing_conditions','pe_closing_items') THEN
    SELECT coalesce(jsonb_agg(ref ORDER BY ref->>'type',ref->>'id'),'[]'::jsonb) INTO evidence_refs
    FROM (
      SELECT jsonb_build_object('type','document','id',document_id,'role',link_role) ref
      FROM finnor_os.pe_document_links
      WHERE tenant_id=NEW.tenant_id AND entity_type=entity_kind AND entity_id=NEW.id AND archived_at IS NULL
      UNION ALL
      SELECT jsonb_build_object('type','evidence_source','id',evidence_source_id,'versionId',evidence_version_id,'role',relationship)
      FROM finnor_os.pe_evidence_links
      WHERE tenant_id=NEW.tenant_id AND entity_type=entity_kind AND entity_id=NEW.id AND archived_at IS NULL
    ) refs;
  END IF;

  INSERT INTO finnor_os.business_events(tenant_id,entity_type,entity_id,event_type,payload,source)
  VALUES (
    NEW.tenant_id,entity_kind,NEW.id,event_name,
    jsonb_strip_nulls(jsonb_build_object(
      'dealId',new_body->>'deal_id','from',from_state,'to',to_state,'actor',actor,
      'version',(new_body->>'version')::integer,'sourceRef',new_body->>'external_id',
      'authorityDecisionId',coalesce(new_body->>'waiver_authority_decision_id',new_body->>'close_authority_decision_id',new_body->>'termination_authority_decision_id'),
      'decisionReceiptId',coalesce(new_body->>'waiver_decision_receipt_id',new_body->>'close_decision_receipt_id',new_body->>'termination_decision_receipt_id'),
      'targetOrganizationId',new_body->>'target_organization_id','signedLoiAt',new_body->>'signed_loi_at',
      'actualCloseAt',new_body->>'actual_close_at','graphVersion',new_body->>'graph_version','evidence',evidence_refs,
      'blocker',CASE WHEN TG_TABLE_NAME='pe_dependencies' THEN jsonb_build_object('entityType',new_body->>'blocker_type','entityId',new_body->>'blocker_id') END,
      'blocked',CASE WHEN TG_TABLE_NAME='pe_dependencies' THEN jsonb_build_object('entityType',new_body->>'blocked_type','entityId',new_body->>'blocked_id') END,
      'reason',coalesce(new_body->>'termination_reason',new_body->>'waiver_reason',new_body->>'failure_reason',new_body->>'cancellation_reason',new_body->>'removal_reason')
    )),event_source
  );
  IF TG_OP='INSERT' AND TG_TABLE_NAME='pe_deals' THEN
    INSERT INTO finnor_os.business_events(tenant_id,entity_type,entity_id,event_type,payload,source)
    VALUES (
      NEW.tenant_id,'pe_deal',NEW.id,'pe_deal_target_linked',
      jsonb_build_object(
        'dealId',NEW.id,'targetOrganizationId',NEW.target_organization_id,
        'actor',actor,'sourceRef',NEW.external_id
      ),event_source
    );
  END IF;
  RETURN NEW;
END $$;

DO $history_triggers$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pe_deals','pe_deal_parties','pe_workstreams','pe_requests','pe_deliverables','pe_findings',
    'pe_deal_risks','pe_finding_risk_links','pe_dependencies','pe_milestones',
    'pe_closing_conditions','pe_closing_items','pe_document_links','pe_evidence_links'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS pe_business_history ON finnor_os.%I',table_name);
    EXECUTE format('CREATE TRIGGER pe_business_history AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.append_pe_business_event()',table_name);
  END LOOP;
END $history_triggers$;

CREATE OR REPLACE FUNCTION finnor_os.prevent_pe_business_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF OLD.entity_type LIKE 'pe\_%' ESCAPE '\' THEN RAISE EXCEPTION 'PE BusinessEvent history is append-only'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS pe_business_events_append_only ON finnor_os.business_events;
CREATE TRIGGER pe_business_events_append_only BEFORE UPDATE OR DELETE ON finnor_os.business_events
FOR EACH ROW EXECUTE FUNCTION finnor_os.prevent_pe_business_event_mutation();

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_business_event_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF NEW.entity_type LIKE 'pe\_%' ESCAPE '\' THEN
    -- PE history is emitted only from the canonical table-history trigger. A
    -- direct BusinessEvent insert cannot manufacture transaction truth.
    IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'PE BusinessEvent must be emitted by canonical PE history'; END IF;
    IF finnor_os.canonical_entity_tenant(NEW.entity_type,NEW.entity_id) IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'PE BusinessEvent crosses tenant boundary or references missing truth';
    END IF;
    IF NEW.event_type='pe_deal_closed' AND NOT EXISTS (
      SELECT 1 FROM finnor_os.pe_deals d WHERE d.id=NEW.entity_id AND d.tenant_id=NEW.tenant_id AND d.status='closed'
    ) THEN RAISE EXCEPTION 'PE close history requires a canonically closed Deal'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pe_business_events_canonical_insert ON finnor_os.business_events;
CREATE TRIGGER pe_business_events_canonical_insert BEFORE INSERT ON finnor_os.business_events
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_business_event_insert();

-- Existing Task remains the sole task system. A PE subject must be a registered,
-- active-vertical canonical reference owned by the same authenticated tenant.
CREATE OR REPLACE FUNCTION finnor_os.assert_p2_task_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE resolved uuid; deal_id uuid; registered boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM finnor_os.canonical_truth_registry WHERE entity_type=NEW.subject_type)
    INTO registered;
  IF registered THEN
    IF NOT finnor_os.canonical_entity_available(NEW.tenant_id,NEW.subject_type) THEN
      RAISE EXCEPTION 'Task subject type is unsupported for tenant active vertical';
    END IF;
    resolved:=finnor_os.canonical_entity_tenant(NEW.subject_type,NEW.subject_id);
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Task subject crosses tenant boundary or is missing';
    END IF;
    IF NEW.subject_type LIKE 'pe\_%' ESCAPE '\' THEN
      deal_id:=finnor_os.pe_entity_deal(NEW.subject_type,NEW.subject_id);
      IF deal_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM finnor_os.pe_deals d
        WHERE d.tenant_id=NEW.tenant_id AND d.id=deal_id AND d.status='active'
      ) THEN
        RAISE EXCEPTION 'Task cannot be added to a closed or terminated PE Deal graph';
      END IF;
    END IF;
  ELSIF NEW.subject_type LIKE 'pe\_%' ESCAPE '\' OR NEW.source_domain_action_id IS NOT NULL THEN
    RAISE EXCEPTION 'Task subject is not a registered canonical entity';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_declare_deal_closed(
  p_tenant uuid,p_deal uuid,p_expected_version integer,p_expected_graph_version integer,
  p_authority_decision uuid,p_decision_receipt uuid,p_source text,p_actor text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE deal_row finnor_os.pe_deals%ROWTYPE; eligibility jsonb; closed_row finnor_os.pe_deals%ROWTYPE;
BEGIN
  IF finnor_os.request_tenant_id() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'PE close crosses authenticated tenant boundary';
  END IF;
  IF coalesce(btrim(p_source),'')='' OR coalesce(btrim(p_actor),'')='' THEN
    RAISE EXCEPTION 'PE close provenance is required';
  END IF;
  SELECT * INTO deal_row FROM finnor_os.pe_deals WHERE tenant_id=p_tenant AND id=p_deal FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PE Deal not found in authenticated tenant'; END IF;
  IF deal_row.status='closed' THEN
    RETURN jsonb_build_object('changed',false,'idempotent',true,'row',to_jsonb(deal_row),
      'eligibility',finnor_os.pe_evaluate_deal_close_eligibility(p_tenant,p_deal));
  END IF;
  IF deal_row.status<>'active' THEN RAISE EXCEPTION 'terminated PE Deal cannot close'; END IF;
  IF p_expected_version IS NULL OR p_expected_graph_version IS NULL
     OR deal_row.version<>p_expected_version OR deal_row.graph_version<>p_expected_graph_version THEN
    RAISE EXCEPTION 'stale PE Deal close version';
  END IF;
  eligibility:=finnor_os.pe_evaluate_deal_close_eligibility(p_tenant,p_deal);
  IF NOT (eligibility->>'eligible')::boolean THEN
    RETURN jsonb_build_object('changed',false,'idempotent',false,'rejected',true,'row',to_jsonb(deal_row),'eligibility',eligibility);
  END IF;
  PERFORM set_config('app.pe_actor',p_actor,true);
  PERFORM set_config('app.pe_source',p_source,true);
  PERFORM set_config('app.pe_deal_transition','declare_closed',true);
  UPDATE finnor_os.pe_deals
  SET status='closed',actual_close_at=now(),close_authority_decision_id=p_authority_decision,
      close_decision_receipt_id=p_decision_receipt,version=version+1,updated_at=now()
  WHERE tenant_id=p_tenant AND id=p_deal
  RETURNING * INTO closed_row;
  RETURN jsonb_build_object('changed',true,'idempotent',false,'row',to_jsonb(closed_row),'eligibility',eligibility);
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_terminate_deal(
  p_tenant uuid,p_deal uuid,p_expected_version integer,p_reason text,
  p_authority_decision uuid,p_decision_receipt uuid,p_source text,p_actor text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE deal_row finnor_os.pe_deals%ROWTYPE; terminated_row finnor_os.pe_deals%ROWTYPE;
BEGIN
  IF finnor_os.request_tenant_id() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'PE termination crosses authenticated tenant boundary';
  END IF;
  IF coalesce(btrim(p_reason),'')='' OR coalesce(btrim(p_source),'')='' OR coalesce(btrim(p_actor),'')='' THEN
    RAISE EXCEPTION 'PE termination reason and provenance are required';
  END IF;
  SELECT * INTO deal_row FROM finnor_os.pe_deals WHERE tenant_id=p_tenant AND id=p_deal FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PE Deal not found in authenticated tenant'; END IF;
  IF deal_row.status='terminated' THEN
    RETURN jsonb_build_object('changed',false,'idempotent',true,'row',to_jsonb(deal_row));
  END IF;
  IF deal_row.status<>'active' THEN RAISE EXCEPTION 'closed PE Deal cannot terminate'; END IF;
  IF p_expected_version IS NULL OR deal_row.version<>p_expected_version THEN
    RAISE EXCEPTION 'stale PE Deal termination version';
  END IF;
  PERFORM set_config('app.pe_actor',p_actor,true);
  PERFORM set_config('app.pe_source',p_source,true);
  PERFORM set_config('app.pe_deal_transition','terminate',true);
  UPDATE finnor_os.pe_deals
  SET status='terminated',terminated_at=now(),termination_reason=p_reason,
      termination_authority_decision_id=p_authority_decision,
      termination_decision_receipt_id=p_decision_receipt,version=version+1,updated_at=now()
  WHERE tenant_id=p_tenant AND id=p_deal
  RETURNING * INTO terminated_row;
  RETURN jsonb_build_object('changed',true,'idempotent',false,'row',to_jsonb(terminated_row));
END $$;

DROP TRIGGER IF EXISTS tasks_p2_subject_scope ON finnor_os.tasks;
CREATE TRIGGER tasks_p2_subject_scope BEFORE INSERT OR UPDATE ON finnor_os.tasks
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_p2_task_scope();

-- PE-owned runtime registration. Relationship rows are registered for provenance
-- and graph reconstruction but only consequential business objects are Work targets.
INSERT INTO finnor_os.canonical_truth_registry
  (entity_type,vertical_key,source_table,writable_owner,mutation_boundary,work_attachable)
VALUES
  ('pe_deal','private_equity','pe_deals','@finnor/private-equity','createDeal / declareDealClosed / terminateDeal',true),
  ('pe_deal_party','private_equity','pe_deal_parties','@finnor/private-equity','addDealParty / removeDealParty',false),
  ('pe_workstream','private_equity','pe_workstreams','@finnor/private-equity','explicit Workstream transitions',true),
  ('pe_request','private_equity','pe_requests','@finnor/private-equity','explicit Request transitions',true),
  ('pe_deliverable','private_equity','pe_deliverables','@finnor/private-equity','explicit Deliverable transitions',true),
  ('pe_finding','private_equity','pe_findings','@finnor/private-equity','explicit Finding transitions',true),
  ('pe_deal_risk','private_equity','pe_deal_risks','@finnor/private-equity','explicit DealRisk transitions',true),
  ('pe_dependency','private_equity','pe_dependencies','@finnor/private-equity','createDependency / removeDependency',false),
  ('pe_milestone','private_equity','pe_milestones','@finnor/private-equity','explicit Milestone transitions',true),
  ('pe_closing_condition','private_equity','pe_closing_conditions','@finnor/private-equity','guarded ClosingCondition transitions',true),
  ('pe_closing_item','private_equity','pe_closing_items','@finnor/private-equity','guarded ClosingItem transitions',true),
  ('pe_document_link','private_equity','pe_document_links','@finnor/private-equity','attachCanonicalDocument',false),
  ('pe_evidence_link','private_equity','pe_evidence_links','@finnor/private-equity','attachCanonicalEvidence',false),
  ('pe_finding_risk_link','private_equity','pe_finding_risk_links','@finnor/private-equity','linkFindingToDealRisk',false)
ON CONFLICT (entity_type) DO UPDATE SET
  vertical_key=EXCLUDED.vertical_key,source_table=EXCLUDED.source_table,writable_owner=EXCLUDED.writable_owner,
  mutation_boundary=EXCLUDED.mutation_boundary,work_attachable=EXCLUDED.work_attachable,updated_at=now();

-- PE graph projection lives with the vertical; the existing Core company graph
-- remains free of Deal-specific imports and Water retains its own edges.
CREATE OR REPLACE VIEW finnor_os.pe_deal_graph_nodes WITH (security_invoker=true) AS
SELECT tenant_id,id deal_id,'pe_deal'::text entity_type,id entity_id,name label,status state,created_at,updated_at FROM finnor_os.pe_deals
UNION ALL SELECT tenant_id,deal_id,'pe_deal_party',id,role,state,created_at,updated_at FROM finnor_os.pe_deal_parties
UNION ALL SELECT tenant_id,deal_id,'pe_workstream',id,name,state,created_at,updated_at FROM finnor_os.pe_workstreams
UNION ALL SELECT tenant_id,deal_id,'pe_request',id,request_text,state,created_at,updated_at FROM finnor_os.pe_requests
UNION ALL SELECT tenant_id,deal_id,'pe_deliverable',id,description,state,created_at,updated_at FROM finnor_os.pe_deliverables
UNION ALL SELECT tenant_id,deal_id,'pe_finding',id,statement,state,created_at,updated_at FROM finnor_os.pe_findings
UNION ALL SELECT tenant_id,deal_id,'pe_deal_risk',id,statement,state,created_at,updated_at FROM finnor_os.pe_deal_risks
UNION ALL SELECT tenant_id,deal_id,'pe_dependency',id,relation,CASE WHEN removed_at IS NULL THEN 'active' ELSE 'removed' END,created_at,updated_at FROM finnor_os.pe_dependencies
UNION ALL SELECT tenant_id,deal_id,'pe_milestone',id,name,state,created_at,updated_at FROM finnor_os.pe_milestones
UNION ALL SELECT tenant_id,deal_id,'pe_closing_condition',id,condition_text,state,created_at,updated_at FROM finnor_os.pe_closing_conditions
UNION ALL SELECT tenant_id,deal_id,'pe_closing_item',id,item_text,state,created_at,updated_at FROM finnor_os.pe_closing_items
UNION ALL SELECT e.tenant_id,finnor_os.pe_entity_deal(e.entity_type,e.entity_id),'business_event',e.id,e.event_type,'recorded',e.occurred_at,e.occurred_at
  FROM finnor_os.business_events e
  WHERE e.entity_type LIKE 'pe\_%' ESCAPE '\' AND finnor_os.pe_entity_deal(e.entity_type,e.entity_id) IS NOT NULL
UNION ALL SELECT ad.tenant_id,d.id,'authority_decision',ad.id,ad.capability,ad.outcome,ad.created_at,ad.created_at
  FROM finnor_os.authority_decisions ad
  JOIN finnor_os.pe_deals d ON d.tenant_id=ad.tenant_id AND ad.resource_type='pe_deal' AND ad.resource_id=d.id
UNION ALL SELECT ad.tenant_id,c.deal_id,'authority_decision',ad.id,ad.capability,ad.outcome,ad.created_at,ad.created_at
  FROM finnor_os.authority_decisions ad
  JOIN finnor_os.pe_closing_conditions c
    ON c.tenant_id=ad.tenant_id AND ad.resource_type='pe_closing_condition' AND ad.resource_id=c.id
UNION ALL SELECT r.tenant_id,d.id,'decision_receipt',r.id,r.objective,
    CASE WHEN r.finalized_at IS NULL THEN 'open' ELSE 'finalized' END,r.created_at,r.created_at
  FROM finnor_os.pe_deals d
  JOIN finnor_os.decision_receipts r ON r.tenant_id=d.tenant_id
    AND r.id IN (d.close_decision_receipt_id,d.termination_decision_receipt_id)
UNION ALL SELECT r.tenant_id,c.deal_id,'decision_receipt',r.id,r.objective,
    CASE WHEN r.finalized_at IS NULL THEN 'open' ELSE 'finalized' END,r.created_at,r.created_at
  FROM finnor_os.pe_closing_conditions c
  JOIN finnor_os.decision_receipts r ON r.tenant_id=c.tenant_id AND r.id=c.waiver_decision_receipt_id
UNION ALL SELECT ar.tenant_id,CASE WHEN ad.resource_type='pe_deal' THEN ad.resource_id ELSE c.deal_id END,
    'authority_approval_request',ar.id,'Approval request',ar.status,ar.created_at,coalesce(ar.resolved_at,ar.created_at)
  FROM finnor_os.authority_approval_requests ar
  JOIN finnor_os.authority_decisions ad ON ad.tenant_id=ar.tenant_id AND ad.id=ar.authority_decision_id
  LEFT JOIN finnor_os.pe_closing_conditions c
    ON c.tenant_id=ad.tenant_id AND ad.resource_type='pe_closing_condition' AND c.id=ad.resource_id
  WHERE ad.resource_type='pe_deal' OR c.id IS NOT NULL;

CREATE OR REPLACE VIEW finnor_os.pe_deal_graph_edges WITH (security_invoker=true) AS
SELECT tenant_id,id deal_id,'pe_deal'::text from_type,id from_id,'targets'::text relation,'external_organization'::text to_type,target_organization_id to_id,'pe_deals'::text source_table,'target_organization_id'::text source_column FROM finnor_os.pe_deals
UNION ALL SELECT tenant_id,id,'pe_deal',id,'led_by','user',deal_lead_employee_id,'pe_deals','deal_lead_employee_id' FROM finnor_os.pe_deals
UNION ALL SELECT tenant_id,deal_id,'pe_deal',deal_id,'has_party','pe_deal_party',id,'pe_deal_parties','deal_id' FROM finnor_os.pe_deal_parties
UNION ALL SELECT tenant_id,deal_id,'pe_deal',deal_id,'has_workstream','pe_workstream',id,'pe_workstreams','deal_id' FROM finnor_os.pe_workstreams
UNION ALL SELECT tenant_id,deal_id,'pe_workstream',workstream_id,'has_request','pe_request',id,'pe_requests','workstream_id' FROM finnor_os.pe_requests
UNION ALL SELECT tenant_id,deal_id,'pe_workstream',workstream_id,'has_deliverable','pe_deliverable',id,'pe_deliverables','workstream_id' FROM finnor_os.pe_deliverables
UNION ALL SELECT tenant_id,deal_id,'pe_request',request_id,'expects','pe_deliverable',id,'pe_deliverables','request_id' FROM finnor_os.pe_deliverables WHERE request_id IS NOT NULL
UNION ALL SELECT tenant_id,deal_id,'pe_workstream',workstream_id,'has_finding','pe_finding',id,'pe_findings','workstream_id' FROM finnor_os.pe_findings
UNION ALL SELECT tenant_id,deal_id,'pe_workstream',workstream_id,'has_risk','pe_deal_risk',id,'pe_deal_risks','workstream_id' FROM finnor_os.pe_deal_risks
UNION ALL SELECT tenant_id,deal_id,'pe_finding',finding_id,'creates_risk','pe_deal_risk',deal_risk_id,'pe_finding_risk_links','deal_risk_id' FROM finnor_os.pe_finding_risk_links WHERE archived_at IS NULL
UNION ALL SELECT tenant_id,deal_id,blocker_type,blocker_id,'blocks',blocked_type,blocked_id,'pe_dependencies','blocked_id' FROM finnor_os.pe_dependencies WHERE removed_at IS NULL
UNION ALL SELECT tenant_id,deal_id,'pe_deal',deal_id,'has_milestone','pe_milestone',id,'pe_milestones','deal_id' FROM finnor_os.pe_milestones
UNION ALL SELECT tenant_id,deal_id,'pe_deal',deal_id,'has_closing_condition','pe_closing_condition',id,'pe_closing_conditions','deal_id' FROM finnor_os.pe_closing_conditions
UNION ALL SELECT tenant_id,deal_id,'pe_deal',deal_id,'has_closing_item','pe_closing_item',id,'pe_closing_items','deal_id' FROM finnor_os.pe_closing_items
UNION ALL SELECT tenant_id,deal_id,entity_type,entity_id,'linked_document','document',document_id,'pe_document_links','document_id' FROM finnor_os.pe_document_links WHERE archived_at IS NULL
UNION ALL SELECT tenant_id,deal_id,entity_type,entity_id,'linked_evidence','evidence_source',evidence_source_id,'pe_evidence_links','evidence_source_id' FROM finnor_os.pe_evidence_links WHERE archived_at IS NULL
UNION ALL SELECT tenant_id,deal_id,'pe_deal_party',id,'participates_as',party_type,party_id,'pe_deal_parties','party_id' FROM finnor_os.pe_deal_parties WHERE state='active'
UNION ALL SELECT e.tenant_id,finnor_os.pe_entity_deal(e.entity_type,e.entity_id),e.entity_type,e.entity_id,'history','business_event',e.id,'business_events','entity_id'
  FROM finnor_os.business_events e
  WHERE e.entity_type LIKE 'pe\_%' ESCAPE '\' AND finnor_os.pe_entity_deal(e.entity_type,e.entity_id) IS NOT NULL
UNION ALL SELECT d.tenant_id,d.id,'pe_deal',d.id,'governed_by','authority_decision',d.close_authority_decision_id,'pe_deals','close_authority_decision_id'
  FROM finnor_os.pe_deals d WHERE d.close_authority_decision_id IS NOT NULL
UNION ALL SELECT d.tenant_id,d.id,'pe_deal',d.id,'governed_by','authority_decision',d.termination_authority_decision_id,'pe_deals','termination_authority_decision_id'
  FROM finnor_os.pe_deals d WHERE d.termination_authority_decision_id IS NOT NULL
UNION ALL SELECT c.tenant_id,c.deal_id,'pe_closing_condition',c.id,'governed_by','authority_decision',c.waiver_authority_decision_id,'pe_closing_conditions','waiver_authority_decision_id'
  FROM finnor_os.pe_closing_conditions c WHERE c.waiver_authority_decision_id IS NOT NULL
UNION ALL SELECT d.tenant_id,d.id,'pe_deal',d.id,'receipt','decision_receipt',d.close_decision_receipt_id,'pe_deals','close_decision_receipt_id'
  FROM finnor_os.pe_deals d WHERE d.close_decision_receipt_id IS NOT NULL
UNION ALL SELECT d.tenant_id,d.id,'pe_deal',d.id,'receipt','decision_receipt',d.termination_decision_receipt_id,'pe_deals','termination_decision_receipt_id'
  FROM finnor_os.pe_deals d WHERE d.termination_decision_receipt_id IS NOT NULL
UNION ALL SELECT c.tenant_id,c.deal_id,'pe_closing_condition',c.id,'receipt','decision_receipt',c.waiver_decision_receipt_id,'pe_closing_conditions','waiver_decision_receipt_id'
  FROM finnor_os.pe_closing_conditions c WHERE c.waiver_decision_receipt_id IS NOT NULL
UNION ALL SELECT ar.tenant_id,CASE WHEN ad.resource_type='pe_deal' THEN ad.resource_id ELSE c.deal_id END,
    ad.resource_type,ad.resource_id,'approval','authority_approval_request',ar.id,'authority_approval_requests','authority_decision_id'
  FROM finnor_os.authority_approval_requests ar
  JOIN finnor_os.authority_decisions ad ON ad.tenant_id=ar.tenant_id AND ad.id=ar.authority_decision_id
  LEFT JOIN finnor_os.pe_closing_conditions c
    ON c.tenant_id=ad.tenant_id AND ad.resource_type='pe_closing_condition' AND c.id=ad.resource_id
  WHERE ad.resource_type='pe_deal' OR c.id IS NOT NULL
UNION ALL SELECT t.tenant_id,finnor_os.pe_entity_deal(t.subject_type,t.subject_id),'task',t.id,'about',t.subject_type,t.subject_id,'tasks','subject_id'
  FROM finnor_os.tasks t
  JOIN finnor_os.canonical_truth_registry r ON r.entity_type=t.subject_type AND r.vertical_key='private_equity'
UNION ALL SELECT l.tenant_id,finnor_os.pe_entity_deal(l.entity_type,l.entity_id),'work',l.work_id,l.relationship,l.entity_type,l.entity_id,'work_entity_links','entity_id'
  FROM finnor_os.work_entity_links l WHERE l.entity_type LIKE 'pe\_%' ESCAPE '\';

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pe_deals','pe_deal_parties','pe_workstreams','pe_requests','pe_deliverables','pe_findings',
    'pe_deal_risks','pe_finding_risk_links','pe_dependencies','pe_milestones',
    'pe_closing_conditions','pe_closing_items','pe_document_links','pe_evidence_links'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON finnor_os.%I',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON finnor_os.%I USING (tenant_id=finnor_os.request_tenant_id()) WITH CHECK (tenant_id=finnor_os.request_tenant_id())',table_name);
  END LOOP;
END $rls$;

CREATE UNIQUE INDEX IF NOT EXISTS pe_deal_closed_event_once_idx
  ON finnor_os.business_events(tenant_id,entity_type,entity_id,event_type)
  WHERE entity_type='pe_deal' AND event_type='pe_deal_closed';

REVOKE ALL ON FUNCTION finnor_os.pe_party_tenant(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_entity_deal(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_endpoint_resolved(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_evaluate_deal_close_eligibility(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_declare_deal_closed(uuid,uuid,integer,integer,uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_terminate_deal(uuid,uuid,integer,text,uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.touch_pe_deal_graph() FROM PUBLIC;

DO $grants$
DECLARE table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'pe_deals','pe_deal_parties','pe_workstreams','pe_requests','pe_deliverables','pe_findings',
      'pe_deal_risks','pe_finding_risk_links','pe_dependencies','pe_milestones',
      'pe_closing_conditions','pe_closing_items','pe_document_links','pe_evidence_links'
    ] LOOP
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON finnor_os.%I TO finnor_app',table_name);
      EXECUTE format('REVOKE DELETE ON finnor_os.%I FROM finnor_app',table_name);
    END LOOP;
    GRANT SELECT ON finnor_os.pe_deal_graph_nodes,finnor_os.pe_deal_graph_edges TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_party_tenant(text,uuid) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_entity_deal(text,uuid) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_endpoint_resolved(text,uuid) TO finnor_app;
    -- No application caller can directly update the transaction root. The two
    -- SECURITY DEFINER functions below are the only terminal-state writers.
    REVOKE UPDATE ON finnor_os.pe_deals FROM finnor_app;
    GRANT SELECT,INSERT ON finnor_os.pe_deals TO finnor_app;
    -- PostgreSQL requires some UPDATE privilege for SELECT ... FOR UPDATE. Only
    -- updated_at is exposed, and the Deal version trigger makes a direct write to
    -- that column fail; terminal/business columns remain function-owned.
    GRANT UPDATE (updated_at) ON finnor_os.pe_deals TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_evaluate_deal_close_eligibility(uuid,uuid) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_declare_deal_closed(uuid,uuid,integer,integer,uuid,uuid,text,text) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_terminate_deal(uuid,uuid,integer,text,uuid,uuid,text,text) TO finnor_app;
  END IF;
END $grants$;

COMMENT ON TABLE finnor_os.pe_deals IS 'Private Equity transaction root. closed is writable only through @finnor/private-equity declareDealClosed.';
COMMENT ON TABLE finnor_os.pe_workstreams IS 'Concurrent transaction structure; deliberately distinct from durable Core Work.';
COMMENT ON TABLE finnor_os.pe_requests IS 'Something required from another deal party; deliberately distinct from Core Task.';
COMMENT ON TABLE finnor_os.pe_deliverables IS 'Expected business artifact/result; canonical content remains in Core Document.';
COMMENT ON TABLE finnor_os.pe_findings IS 'Discovered transaction fact; deliberately distinct from PE DealRisk and Core policy risk.';
COMMENT ON TABLE finnor_os.pe_dependencies IS 'Typed same-Deal acyclic business blockers; not planner/workflow dependencies.';


-- Private Equity Phase 3: typed read receipts for the existing Operational Query
-- Plane. No canonical PE table, action fabric, connector, or autonomous worker is
-- introduced here; epistemic evidence remains in the existing evidence corpus.

ALTER TABLE finnor_os.work_query_executions
  DROP CONSTRAINT IF EXISTS work_query_executions_intent_check;
ALTER TABLE finnor_os.work_query_executions
  ADD CONSTRAINT work_query_executions_intent_check CHECK (intent IN (
    'customer_lookup','customer_cohort','schedule_range','money_summary','work_list',
    'inventory_status','agent_activity','business_state','company_context',
    'party_lookup','party_context','team_roster','party_availability',
    'deal_context','deal_workstreams','open_requests','open_findings','open_deal_risks',
    'critical_dependencies','closing_readiness'
  ));

CREATE INDEX IF NOT EXISTS external_refs_pe_observation_idx
  ON finnor_os.external_refs(tenant_id,entity,internal_id,last_observed_at DESC,id)
  WHERE entity LIKE 'pe\_%' ESCAPE '\';

COMMENT ON INDEX finnor_os.external_refs_pe_observation_idx IS
  'Provider-neutral PE observations. Rows are evidence/source state and never canonical PE lifecycle state.';


-- Private Equity Phase 4: let the existing Core action/approval/BusinessEffect
-- runtime present its exact in-flight DecisionReceipt to the PE2 mutation guard.
-- PE2 remains the state owner; this only joins its original capability names to
-- the action:* names used by the universal authority boundary.

-- The universal scope guard normally requires every canonical target to exist at
-- BusinessEffect compilation time. PE create mutations intentionally reserve the
-- new entity's UUID as the DomainAction UUID, so permit only those exact
-- action/type pairs as tenant-owned proposed targets. All existing targets still
-- resolve through canonical_entity_tenant and every source/Work/policy/binding
-- retains the original tenant checks.
CREATE OR REPLACE FUNCTION finnor_os.assert_business_effect_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  item jsonb;
  binding jsonb;
  kind text;
  target_type text;
  raw_id text;
  target_id uuid;
  resolved uuid;
  source_id uuid;
  source_action_type text;
BEGIN
  source_action_type := NEW.effect#>>'{source,actionType}';
  IF NEW.domain_action_id IS NOT NULL
    AND NEW.effect#>>'{source,domainActionId}' IS DISTINCT FROM NEW.domain_action_id::text
  THEN RAISE EXCEPTION 'Business Effect source action does not match its canonical action reference';
  END IF;

  BEGIN source_id := nullif(NEW.effect#>>'{source,domainActionId}','')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Business Effect source action is invalid'; END;
  IF source_id IS NOT NULL THEN
    SELECT tenant_id INTO resolved FROM finnor_os.domain_actions WHERE id=source_id;
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect source action crosses tenant boundary or does not exist'; END IF;
  END IF;

  BEGIN source_id := nullif(NEW.effect#>>'{source,workId}','')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Business Effect Work reference is invalid'; END;
  IF source_id IS NOT NULL THEN
    resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.works WHERE id=source_id;
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect Work reference crosses tenant boundary or does not exist'; END IF;
  END IF;

  BEGIN source_id := nullif(NEW.effect#>>'{source,objectiveStepId}','')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Business Effect objective step reference is invalid'; END;
  IF source_id IS NOT NULL THEN
    resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.work_objective_steps WHERE id=source_id;
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect objective step crosses tenant boundary or does not exist'; END IF;
  END IF;

  BEGIN source_id := nullif(NEW.effect#>>'{authority,policyId}','')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Business Effect policy reference is invalid'; END;
  IF source_id IS NOT NULL THEN
    resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.domain_policies WHERE id=source_id;
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect policy crosses tenant boundary or does not exist'; END IF;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(NEW.effect->'targets','[]'::jsonb)) LOOP
    kind := item->>'kind'; target_type := item->>'type'; raw_id := item->>'id'; resolved := NULL; target_id := NULL;
    IF raw_id IS NULL OR target_type IS NULL OR kind IS NULL THEN RAISE EXCEPTION 'Business Effect target is incomplete'; END IF;
    BEGIN target_id := raw_id::uuid; EXCEPTION WHEN invalid_text_representation THEN target_id := NULL; END;
    IF kind='party' THEN
      IF target_id IS NULL THEN RAISE EXCEPTION 'Business Effect PartyRef is invalid'; END IF;
      resolved := finnor_os.party_ref_tenant(target_type,target_id);
    ELSIF kind='entity' THEN
      IF target_type='inventory_item' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.inventory_items WHERE sku=raw_id AND tenant_id=NEW.tenant_id;
      ELSIF target_type='location' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.tenant_locations WHERE id=target_id;
      ELSIF target_type='objective_loop' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.work_objective_loops WHERE id=target_id;
      ELSIF target_type='communication_identity' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.communication_identities WHERE id=target_id;
      ELSIF target_type='auth_profile' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.auth_profiles WHERE id=target_id;
      ELSIF target_type='application_account' THEN
        SELECT tenant_id INTO resolved FROM finnor_os.application_accounts WHERE id=target_id;
      ELSE
        IF target_id IS NULL THEN RAISE EXCEPTION 'Business Effect canonical entity reference is invalid'; END IF;
        resolved := finnor_os.canonical_entity_tenant(target_type,target_id);
        IF resolved IS NULL AND target_id=NEW.domain_action_id AND (
          (source_action_type='open_workstream' AND target_type='pe_workstream') OR
          (source_action_type='create_deal_request' AND target_type='pe_request') OR
          (source_action_type='record_finding' AND target_type='pe_finding') OR
          (source_action_type='raise_deal_risk' AND target_type='pe_deal_risk') OR
          (source_action_type='link_deal_dependency' AND target_type='pe_dependency') OR
          (source_action_type='create_closing_condition' AND target_type='pe_closing_condition')
        ) THEN
          SELECT tenant_id INTO resolved FROM finnor_os.domain_actions
           WHERE id=target_id AND tenant_id=NEW.tenant_id AND action_type=source_action_type;
        END IF;
      END IF;
    ELSIF kind='resource' AND target_type='communication_identity' THEN
      SELECT tenant_id INTO resolved FROM finnor_os.communication_identities WHERE id=target_id;
    ELSIF kind='resource' AND target_type='auth_profile' THEN
      SELECT tenant_id INTO resolved FROM finnor_os.auth_profiles WHERE id=target_id;
    ELSIF kind='resource' AND target_type='application_account' THEN
      SELECT tenant_id INTO resolved FROM finnor_os.application_accounts WHERE id=target_id;
    ELSIF kind='resource' AND target_type='business_effect' THEN
      SELECT tenant_id INTO resolved FROM finnor_os.business_effects WHERE id=target_id;
    ELSIF kind='resource' AND target_type IN ('proposed_business_change','phone_endpoint','email_endpoint','recipient_endpoint') THEN
      resolved := NEW.tenant_id;
    ELSE
      RAISE EXCEPTION 'Unsupported Business Effect target kind/type: %/%',kind,target_type;
    END IF;
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect target crosses tenant boundary or does not exist'; END IF;
  END LOOP;

  FOR binding IN SELECT value FROM jsonb_array_elements(coalesce(NEW.effect->'bindings','[]'::jsonb)) LOOP
    IF binding->>'communicationIdentityId' IS NOT NULL THEN
      resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.communication_identities WHERE id=(binding->>'communicationIdentityId')::uuid;
      IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect communication identity crosses tenant boundary or does not exist'; END IF;
    END IF;
    IF binding->>'authProfileId' IS NOT NULL THEN
      resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.auth_profiles WHERE id=(binding->>'authProfileId')::uuid;
      IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect auth profile crosses tenant boundary or does not exist'; END IF;
    END IF;
    IF binding->>'applicationAccountId' IS NOT NULL THEN
      resolved := NULL; SELECT tenant_id INTO resolved FROM finnor_os.application_accounts WHERE id=(binding->>'applicationAccountId')::uuid;
      IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Business Effect application account crosses tenant boundary or does not exist'; END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.assert_business_effect_scope() FROM PUBLIC;
DO $grant_scope$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT EXECUTE ON FUNCTION finnor_os.assert_business_effect_scope() TO finnor_app;
  END IF;
END $grant_scope$;

CREATE OR REPLACE FUNCTION finnor_os.pe_governance_proof_valid(
  p_tenant uuid,p_resource_type text,p_resource_id uuid,p_capability text,
  p_authority_decision uuid,p_decision_receipt uuid,p_require_current_revision boolean DEFAULT false,
  p_require_approval boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE decision_row finnor_os.authority_decisions%ROWTYPE;
DECLARE current_revision integer;
DECLARE action_capability text;
DECLARE approval_mandatory boolean;
DECLARE receipt_valid boolean;
BEGIN
  IF p_authority_decision IS NULL THEN RETURN false; END IF;
  action_capability := CASE p_capability
    WHEN 'private_equity:waive_closing_condition' THEN 'action:waive_closing_condition'
    WHEN 'private_equity:close_deal' THEN 'action:declare_deal_closed'
    WHEN 'private_equity:terminate_deal' THEN 'action:terminate_deal'
    ELSE NULL
  END;
  SELECT * INTO decision_row FROM finnor_os.authority_decisions
  WHERE id=p_authority_decision AND tenant_id=p_tenant
    AND capability IN (p_capability,action_capability)
    AND resource_type=p_resource_type AND resource_id=p_resource_id;
  IF NOT FOUND THEN RETURN false; END IF;
  -- P2 repository callers keep their existing governance contract.  The new
  -- Phase-4 DomainActions are the surface with unconditional human-approval
  -- floors, so only their action:* authority decisions trigger that floor.
  approval_mandatory := p_require_approval OR decision_row.capability IN (
    'action:waive_closing_condition','action:declare_deal_closed'
  );
  IF p_require_current_revision THEN
    SELECT coalesce((SELECT revision FROM finnor_os.authority_states WHERE tenant_id=p_tenant),1) INTO current_revision;
    IF decision_row.authority_revision<>current_revision THEN RETURN false; END IF;
  END IF;

  IF p_decision_receipt IS NULL THEN RETURN decision_row.outcome='allowed' AND NOT approval_mandatory; END IF;
  SELECT EXISTS (
    SELECT 1
    FROM finnor_os.decision_receipts r
    JOIN finnor_os.domain_actions da
      ON da.tenant_id=r.tenant_id AND da.id=r.domain_action_id
    WHERE r.id=p_decision_receipt AND r.tenant_id=p_tenant
      AND decision_row.domain_action_id IS NOT NULL
      AND r.domain_action_id=decision_row.domain_action_id
      AND da.status IN ('executing','completed')
      AND r.business_effect_id IS NOT DISTINCT FROM decision_row.business_effect_id
      AND r.authorized_effect_hash IS NOT DISTINCT FROM decision_row.business_effect_hash
      AND (r.failure IS NULL)
      AND (r.finalized_at IS NULL OR r.actual_result IS NOT NULL)
  ) INTO receipt_valid;
  IF NOT receipt_valid THEN RETURN false; END IF;

  IF decision_row.outcome='allowed' AND NOT approval_mandatory THEN RETURN true; END IF;
  IF decision_row.outcome<>'approval_required' THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1
    FROM finnor_os.authority_approval_requests ar
    JOIN finnor_os.decision_receipts r
      ON r.tenant_id=ar.tenant_id AND r.domain_action_id=ar.domain_action_id
    WHERE ar.tenant_id=p_tenant AND ar.authority_decision_id=p_authority_decision
      AND ar.status='approved' AND r.id=p_decision_receipt
      AND coalesce((r.approval->>'required')::boolean,false)
      AND coalesce(btrim(r.approval->>'approvedBy'),'')<>''
      AND ar.business_effect_id IS NOT DISTINCT FROM r.business_effect_id
      AND ar.business_effect_hash IS NOT DISTINCT FROM r.authorized_effect_hash
  );
END $$;

REVOKE ALL ON FUNCTION finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT EXECUTE ON FUNCTION finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean) TO finnor_app;
  END IF;
END $grant$;

COMMENT ON FUNCTION finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean) IS
  'Validates PE2 governance or the exact Core Phase-4 action approval/BusinessEffect/DecisionReceipt while execution is in flight.';


-- Canonical PE5 authority and Water retirement barrier.

-- Phase 5: atomic Water runtime retirement and Private Equity authority cutover.
--
-- This migration is deliberately non-destructive. Water tenant identity, canonical
-- rows, Work, actions, receipts, events, provider references, and all prior migrations
-- remain historical truth. Runtime authority moves through one monotonic, database-
-- owned barrier; legacy application binaries are fenced at the tables they could
-- otherwise mutate.

-- ---------------------------------------------------------------------------
-- Durable product authority and mixed-fleet provenance.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS finnor_os.product_runtime_authority (
  authority_key text PRIMARY KEY CHECK (authority_key='product'),
  epoch integer NOT NULL CHECK (epoch>=5),
  state text NOT NULL CHECK (state IN ('preparing','water_intake_frozen','water_retired')),
  active_product_vertical text NOT NULL CHECK (active_product_vertical='private_equity'),
  minimum_cutover_protocol integer NOT NULL CHECK (minimum_cutover_protocol>=5),
  water_intake_frozen_at timestamptz,
  water_retired_at timestamptz,
  activated_by text,
  activation_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(activation_evidence)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_runtime_authority_state_time_check CHECK (
    (state='preparing' AND water_intake_frozen_at IS NULL AND water_retired_at IS NULL)
    OR (state='water_intake_frozen' AND water_intake_frozen_at IS NOT NULL AND water_retired_at IS NULL)
    OR (state='water_retired' AND water_intake_frozen_at IS NOT NULL AND water_retired_at IS NOT NULL)
  )
);

INSERT INTO finnor_os.product_runtime_authority
  (authority_key,epoch,state,active_product_vertical,minimum_cutover_protocol)
VALUES ('product',5,'preparing','private_equity',5)
ON CONFLICT (authority_key) DO NOTHING;

ALTER TABLE finnor_os.service_release_heartbeats
  ADD COLUMN IF NOT EXISTS cutover_protocol integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS product_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE finnor_os.service_release_heartbeats
  DROP CONSTRAINT IF EXISTS service_release_heartbeats_cutover_protocol_check;
ALTER TABLE finnor_os.service_release_heartbeats
  ADD CONSTRAINT service_release_heartbeats_cutover_protocol_check
  CHECK (cutover_protocol>=0 AND product_epoch>=0);

-- Every historical Water tenant must be classified by a human/auditable release
-- process before the final barrier can move. No assignment is renamed to PE.
CREATE TABLE IF NOT EXISTS finnor_os.water_tenant_retirement_dispositions (
  tenant_id uuid PRIMARY KEY REFERENCES finnor_os.tenants(id),
  classification text NOT NULL CHECK (classification IN (
    'SYNTHETIC_REFERENCE','TEST','STAGING','REAL_PRODUCTION','UNKNOWN'
  )),
  authorized boolean NOT NULL DEFAULT false,
  authorization_ref text,
  obligations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(obligations)='array'),
  classified_by text NOT NULL CHECK (btrim(classified_by)<>''),
  classified_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT water_tenant_real_authorization_check CHECK (
    classification<>'REAL_PRODUCTION'
    OR NOT authorized
    OR coalesce(btrim(authorization_ref),'')<>''
  )
);

-- Restore/migration principals are explicit and separate from application roles.
-- session_user cannot be forged through a request GUC or SET ROLE.
CREATE TABLE IF NOT EXISTS finnor_os.water_history_write_authorities (
  principal text PRIMARY KEY,
  purpose text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO finnor_os.water_history_write_authorities(principal,purpose)
VALUES (session_user,'migration and controlled historical restore')
ON CONFLICT (principal) DO NOTHING;

ALTER TABLE finnor_os.canonical_truth_registry
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE finnor_os.domain_policies
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION finnor_os.default_private_equity_workspace_config() RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{
    "version":3,
    "enabledSurfaces":["home","work","deals","agents"],
    "terminology":{"home":"Home","work":"Work","deals":"Deals","agents":"Agents"},
    "vocabulary":{"deal":"deal","portfolioCompany":"portfolio company","dealParty":"deal party","workstream":"workstream","request":"request","deliverable":"deliverable","finding":"finding","risk":"risk","closingCondition":"closing condition","closingItem":"closing item","task":"task","work":"work"},
    "voiceEnabled":true,
    "navigationPriority":["home","deals","work","agents"],
    "brand":{"accent":"cyan","surfaceTone":"ink","radius":"precise","density":"balanced","typography":"system","motion":"restrained","mark":"F","logoAssetKey":"finnor"},
    "visibility":{"policy":true,"authority":true},
    "roles":{"owner":{"startView":"command","visibleSurfaces":["home","work","deals","agents"],"ready":{"primaryFocus":"deal_execution","heroMetric":"closing_readiness","pulseMetrics":["open_deals","open_requests","critical_deal_risks","pending_approvals"],"attentionCategories":["deal","closing","risk","approval","work"],"quickActions":[{"key":"review_closing_readiness"},{"key":"review_open_requests"},{"key":"review_pending_approvals"},{"key":"inspect_blocked_work"}],"primaryProjection":"deal"}}},
    "scenes":{"ready":{"detail":"balanced","emphasis":"evidence"},"listening":{"detail":"balanced","emphasis":"evidence"},"plan":{"detail":"balanced","emphasis":"evidence"},"approval":{"detail":"balanced","emphasis":"evidence"},"working":{"detail":"balanced","emphasis":"evidence"},"outcome":{"detail":"balanced","emphasis":"evidence"},"recovery":{"detail":"balanced","emphasis":"evidence"}},
    "extensions":{}
  }'::jsonb
$$;
ALTER TABLE finnor_os.tenant_settings ALTER COLUMN workspace_config
  SET DEFAULT finnor_os.default_private_equity_workspace_config();

ALTER TABLE finnor_os.jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE finnor_os.jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued','running','completed','failed','dead_letter','quarantined'));

-- PE source adapters use the existing Source Truth engine. Historical capability
-- values remain legal so their rows and provider provenance do not need rewriting.
ALTER TABLE finnor_os.tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_capability_check;
ALTER TABLE finnor_os.tenant_integrations ADD CONSTRAINT tenant_integrations_capability_check CHECK (
  capability IN (
    'scheduling','documents','inventory','crm','communications','esign','accounting',
    'payments','marketing','private_equity_source'
  )
);

CREATE OR REPLACE FUNCTION finnor_os.water_runtime_retired() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
  SELECT coalesce((
    SELECT state='water_retired'
    FROM finnor_os.product_runtime_authority
    WHERE authority_key='product'
  ),false)
$$;

CREATE OR REPLACE FUNCTION finnor_os.water_intake_closed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
  SELECT coalesce((
    SELECT state IN ('water_intake_frozen','water_retired')
    FROM finnor_os.product_runtime_authority
    WHERE authority_key='product'
  ),false)
$$;

CREATE OR REPLACE FUNCTION finnor_os.water_history_write_authorized() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
  SELECT EXISTS (
    SELECT 1 FROM finnor_os.water_history_write_authorities
    WHERE principal=session_user
  )
$$;

CREATE OR REPLACE FUNCTION finnor_os.is_retired_water_action(p_action text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_action = ANY(ARRAY[
    'schedule_water_test','renew_maintenance_agreement','create_lead','update_lead_status',
    'log_interaction','assign_lead_to_technician','check_stock_level','flag_reorder_needed',
    'log_stock_used_on_visit','assign_technician_to_visit','check_technician_availability',
    'reschedule_visit','generate_quote','size_equipment_for_household','send_proposal',
    'create_invoice','send_payment_reminder','record_payment','call_overdue_invoices',
    'summarize_ad_performance','launch_ad_campaign','create_review_request',
    'answer_customer_question','send_customer_message','send_follow_up','answer_water_question',
    'send_proposal_to_recent_installs','bulk_notify_existing_customers','log_visit_report',
    'flag_visit_issue','check_reminder_due','generate_compliance_summary','scan_competitors',
    'check_business_reviews','get_business_overview','answer_business_question',
    'start_water_test_workflow','request_proposal_signature','start_installation_workflow',
    'start_invoice_to_cash_workflow','manual_step_suggestion','route_suggestion'
  ]::text[])
$$;

CREATE OR REPLACE FUNCTION finnor_os.is_retired_water_job(p_type text,p_payload jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
  SELECT
    p_type = ANY(ARRAY[
      'scheduled_reminder','scan_cold_leads','scan_low_inventory','scan_service_due',
      'scan_appointment_no_shows','simulator_tick','owner_digest','suggest_daily_routes',
      'scan_ewma_reorder','scan_data_quality','quickbooks_sync','dispatch_business_operation',
      'execute_business_operation_target','execute_business_operation_call_batch','run_client_factory'
    ]::text[])
    OR finnor_os.is_retired_water_action(coalesce(p_payload->>'actionType',''))
    OR EXISTS (
      SELECT 1 FROM finnor_os.domain_actions a
      WHERE a.id=CASE
        WHEN coalesce(p_payload->>'actionId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (p_payload->>'actionId')::uuid ELSE NULL END
        AND (finnor_os.is_retired_water_action(a.action_type)
          OR finnor_os.active_tenant_vertical(a.tenant_id)='water')
    )
    OR EXISTS (
      SELECT 1 FROM finnor_os.tenant_vertical_assignments v
      WHERE v.vertical_key='water'
        AND v.tenant_id=CASE
          WHEN coalesce(p_payload->>'tenantId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN (p_payload->>'tenantId')::uuid ELSE NULL END
    )
$$;

CREATE OR REPLACE FUNCTION finnor_os.is_retired_water_workflow(p_type text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_type = ANY(ARRAY[
    'lead_to_water_test','maintenance_agreement','maintenance_agreement_renewal',
    'proposal_signature','proposal_to_installation','invoice_to_cash'
  ]::text[])
$$;

-- A deterministic, queryable pre-cutover safety census. Zero rows is the only state
-- in which the final barrier function can proceed.
CREATE OR REPLACE FUNCTION finnor_os.water_retirement_blockers()
RETURNS TABLE(category text,blocking_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
  SELECT 'tenant_disposition',count(*) FROM finnor_os.tenant_vertical_assignments v
   LEFT JOIN finnor_os.water_tenant_retirement_dispositions d ON d.tenant_id=v.tenant_id
   WHERE v.vertical_key='water'
     AND (d.tenant_id IS NULL OR d.classification='UNKNOWN' OR NOT d.authorized)
  UNION ALL
  SELECT 'water_domain_action',count(*) FROM finnor_os.domain_actions a
   WHERE (finnor_os.is_retired_water_action(a.action_type)
      OR finnor_os.active_tenant_vertical(a.tenant_id)='water')
     AND a.status IN ('draft','pending','approved','executing','blocked_integration_unavailable')
  UNION ALL
  SELECT 'water_job',count(*) FROM finnor_os.jobs j
   WHERE finnor_os.is_retired_water_job(j.type,j.payload)
     AND j.status IN ('queued','running','failed')
  UNION ALL
  SELECT 'water_workflow',count(*) FROM finnor_os.workflow_runs r
   WHERE (finnor_os.is_retired_water_workflow(r.workflow_type)
      OR finnor_os.active_tenant_vertical(r.tenant_id)='water')
     AND r.status IN ('running','compensating','paused')
  UNION ALL
  SELECT 'water_event_wait',count(*) FROM finnor_os.work_event_waits w
   WHERE finnor_os.active_tenant_vertical(w.tenant_id)='water' AND w.status='waiting'
  UNION ALL
  SELECT 'water_objective',count(*) FROM finnor_os.work_objective_loops o
   WHERE finnor_os.active_tenant_vertical(o.tenant_id)='water'
     AND o.state IN ('continue','awaiting_approval','waiting')
  UNION ALL
  SELECT 'water_business_effect',count(*) FROM finnor_os.business_effects e
   LEFT JOIN finnor_os.domain_actions a ON a.id=e.domain_action_id
   WHERE (finnor_os.active_tenant_vertical(e.tenant_id)='water'
      OR finnor_os.is_retired_water_action(coalesce(a.action_type,'')))
     AND e.status IN ('compiled','authorized','executing','unverified','reconciliation_required')
  UNION ALL
  SELECT 'water_external_operation',count(*) FROM finnor_os.external_operations e
   JOIN finnor_os.domain_actions a ON a.id=e.domain_action_id
   WHERE (finnor_os.active_tenant_vertical(e.tenant_id)='water'
      OR finnor_os.is_retired_water_action(a.action_type))
     AND e.status IN ('running','unknown')
  UNION ALL
  SELECT 'water_integration_operation',count(*) FROM finnor_os.integration_operations i
   JOIN finnor_os.workflow_steps s ON s.id=i.workflow_step_id
   JOIN finnor_os.workflow_runs r ON r.id=s.workflow_run_id
   WHERE (finnor_os.active_tenant_vertical(i.tenant_id)='water'
      OR finnor_os.is_retired_water_workflow(r.workflow_type)
      OR finnor_os.is_retired_water_action(s.step_type))
     AND i.status IN ('running','unknown')
  UNION ALL
  SELECT 'water_computer_run',count(*) FROM finnor_os.computer_runs c
   LEFT JOIN finnor_os.domain_actions a ON a.id=c.domain_action_id
   WHERE (finnor_os.active_tenant_vertical(c.tenant_id)='water'
      OR finnor_os.is_retired_water_action(coalesce(a.action_type,'')))
     AND c.status IN ('queued','authorizing','provisioning','authenticating','running','reconciling')
$$;

-- At the final barrier, privileged historical maintenance must not emit old
-- operational deltas, queue work, projections, or dual writes. Constraint triggers
-- are internal and remain intact; the two Phase-5 deny guards are retained.
CREATE OR REPLACE FUNCTION finnor_os.disable_water_behavior_triggers() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE trigger_row record;
DECLARE removed integer := 0;
BEGIN
  FOR trigger_row IN
    SELECT c.relname table_name,t.tgname trigger_name
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='finnor_os' AND NOT t.tgisinternal
       AND c.relname=ANY(ARRAY[
         'households','contacts','technicians','equipment','service_visits','maintenance_agreements',
         'leads','opportunities','quotes','proposals','work_orders','appointments','invoices','payments',
         'conversations','calls','messages','communications_log','inventory_items','contact_methods',
         'technician_capacity','technician_dispatch_profiles','price_book_items','quote_line_items',
         'warehouses','warehouse_stock','procurement_orders','workflow_states','sandbox_outbox',
         'business_operations','business_operation_targets','business_operation_events'
       ]::text[])
       AND t.tgname NOT IN ('retired_water_history_read_only','retired_water_tenant_read_only')
     ORDER BY c.relname,t.tgname
  LOOP
    EXECUTE format('DROP TRIGGER %I ON finnor_os.%I',trigger_row.trigger_name,trigger_row.table_name);
    removed := removed+1;
  END LOOP;
  RETURN removed;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.freeze_water_intake(
  p_expected_epoch integer,p_actor text,p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  current_row finnor_os.product_runtime_authority%ROWTYPE;
  required_roles constant text[] := ARRAY['api','worker','orchestrator','supplier-canary','scheduler-owner'];
  role_name text;
  release_count integer;
BEGIN
  IF coalesce(btrim(p_actor),'')='' OR jsonb_typeof(p_evidence)<>'object' THEN
    RAISE EXCEPTION 'cutover actor and object evidence are required';
  END IF;
  IF NOT (p_evidence @> '{"p0P4Verified":true}'::jsonb) THEN
    RAISE EXCEPTION 'P0-P4 prerequisite verification evidence is required before intake freeze';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('product_runtime_authority',0));
  SELECT * INTO current_row FROM finnor_os.product_runtime_authority
   WHERE authority_key='product' FOR UPDATE;
  IF current_row.epoch<>p_expected_epoch THEN RAISE EXCEPTION 'stale product runtime epoch'; END IF;
  IF current_row.state='water_retired' THEN RETURN current_row.epoch; END IF;
  IF current_row.state='preparing' THEN
    FOREACH role_name IN ARRAY required_roles LOOP
      IF NOT EXISTS (
        SELECT 1 FROM finnor_os.service_release_heartbeats h
         WHERE h.service=role_name
           AND h.last_beat_at>now()-interval '90 seconds'
           AND h.cutover_protocol>=current_row.minimum_cutover_protocol
           AND h.product_epoch=current_row.epoch
           AND h.migration_head='0109_atomic_water_runtime_retirement.sql'
           AND h.release_sha ~ '^[0-9a-f]{40}$'
      ) OR EXISTS (
        SELECT 1 FROM finnor_os.service_release_heartbeats h
         WHERE h.service=role_name AND h.last_beat_at>now()-interval '90 seconds'
           AND (h.cutover_protocol<current_row.minimum_cutover_protocol
             OR h.product_epoch<>current_row.epoch
             OR h.migration_head<>'0109_atomic_water_runtime_retirement.sql')
      ) THEN
        RAISE EXCEPTION 'mixed-fleet freeze blocked: compatible % provenance is not exclusive',role_name;
      END IF;
    END LOOP;
    SELECT count(DISTINCT release_sha)::integer INTO release_count
      FROM finnor_os.service_release_heartbeats
     WHERE service=ANY(required_roles) AND last_beat_at>now()-interval '90 seconds';
    IF release_count<>1 THEN RAISE EXCEPTION 'mixed-fleet freeze blocked: runtime roles do not share one release'; END IF;
    UPDATE finnor_os.product_runtime_authority
       SET state='water_intake_frozen',water_intake_frozen_at=now(),activated_by=p_actor,
           activation_evidence=activation_evidence||p_evidence,updated_at=now()
     WHERE authority_key='product';
  END IF;
  RETURN current_row.epoch;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.activate_private_equity_product_authority(
  p_expected_epoch integer,p_actor text,p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  current_row finnor_os.product_runtime_authority%ROWTYPE;
  required_roles constant text[] := ARRAY['api','worker','orchestrator','supplier-canary','scheduler-owner'];
  role_name text;
  blocker record;
  release_count integer;
  disabled_trigger_count integer;
BEGIN
  IF coalesce(btrim(p_actor),'')='' OR jsonb_typeof(p_evidence)<>'object' THEN
    RAISE EXCEPTION 'cutover actor and object evidence are required';
  END IF;
  IF NOT (p_evidence @> '{"safetyCensusZero":true}'::jsonb) THEN
    RAISE EXCEPTION 'explicit zero safety-census evidence is required before retirement';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('product_runtime_authority',0));
  SELECT * INTO current_row FROM finnor_os.product_runtime_authority
   WHERE authority_key='product' FOR UPDATE;
  IF current_row.epoch<>p_expected_epoch THEN RAISE EXCEPTION 'stale product runtime epoch'; END IF;
  IF current_row.state='water_retired' THEN RETURN current_row.epoch; END IF;
  IF current_row.state<>'water_intake_frozen' THEN RAISE EXCEPTION 'Water intake must be frozen before retirement'; END IF;

  FOREACH role_name IN ARRAY required_roles LOOP
    IF NOT EXISTS (
      SELECT 1 FROM finnor_os.service_release_heartbeats h
       WHERE h.service=role_name
         AND h.last_beat_at>now()-interval '90 seconds'
         AND h.cutover_protocol>=current_row.minimum_cutover_protocol
         AND h.product_epoch=current_row.epoch
         AND h.migration_head='0109_atomic_water_runtime_retirement.sql'
         AND h.release_sha ~ '^[0-9a-f]{40}$'
    ) THEN
      RAISE EXCEPTION 'mixed-fleet cutover blocked: compatible % provenance is missing',role_name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM finnor_os.service_release_heartbeats h
       WHERE h.service=role_name AND h.last_beat_at>now()-interval '90 seconds'
         AND (h.cutover_protocol<current_row.minimum_cutover_protocol
           OR h.product_epoch<>current_row.epoch
           OR h.migration_head<>'0109_atomic_water_runtime_retirement.sql')
    ) THEN
      RAISE EXCEPTION 'mixed-fleet cutover blocked: incompatible % instance is still live',role_name;
    END IF;
  END LOOP;

  SELECT count(DISTINCT release_sha)::integer INTO release_count
    FROM finnor_os.service_release_heartbeats
   WHERE service=ANY(required_roles) AND last_beat_at>now()-interval '90 seconds';
  IF release_count<>1 THEN RAISE EXCEPTION 'mixed-fleet cutover blocked: runtime roles do not share one release'; END IF;

  FOR blocker IN SELECT * FROM finnor_os.water_retirement_blockers() LOOP
    IF blocker.blocking_count<>0 THEN
      RAISE EXCEPTION 'Water retirement safety gate blocked: %=%',blocker.category,blocker.blocking_count;
    END IF;
  END LOOP;

  -- DLQ history becomes explicitly non-redrivable quarantine before the retired
  -- barrier activates. Queued/running/failed rows were rejected by the gate above.
  UPDATE finnor_os.jobs
     SET status='quarantined',last_error='RETIRED_VERTICAL: historical Water job is non-executable',
         lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL
   WHERE finnor_os.is_retired_water_job(type,payload) AND status='dead_letter';

  UPDATE finnor_os.vertical_definitions
     SET active=CASE key WHEN 'water' THEN false WHEN 'private_equity' THEN true ELSE active END,
         updated_at=now()
   WHERE key IN ('water','private_equity');
  UPDATE finnor_os.canonical_truth_registry SET active=false,work_attachable=false,updated_at=now()
   WHERE vertical_key='water' OR entity_type IN ('business_operation','business_operation_target');
  UPDATE finnor_os.domain_policies SET active=false
   WHERE finnor_os.is_retired_water_action(action_type)
      OR finnor_os.active_tenant_vertical(tenant_id)='water';
  UPDATE finnor_os.employee_roles SET active=false,updated_at=now()
   WHERE legacy_role IN ('dispatcher','technician')
      OR key IN ('dispatcher','technician');
  UPDATE finnor_os.employee_role_assignments a SET active=false
   WHERE EXISTS (SELECT 1 FROM finnor_os.employee_roles r WHERE r.id=a.role_id AND NOT r.active);
  UPDATE finnor_os.users SET status='suspended'
   WHERE role<>'owner' AND status='active';
  UPDATE finnor_os.tenant_settings
     SET is_dealer_zero=false,simulator_enabled=false,training_mode=false,
         workspace_config=CASE
           WHEN finnor_os.active_tenant_vertical(tenant_id)='private_equity'
             THEN finnor_os.default_private_equity_workspace_config()
           ELSE workspace_config
         END,
         updated_at=now()
   WHERE is_dealer_zero OR simulator_enabled OR training_mode;
  UPDATE finnor_os.tenant_settings
     SET workspace_config=finnor_os.default_private_equity_workspace_config(),updated_at=now()
   WHERE finnor_os.active_tenant_vertical(tenant_id)='private_equity'
     AND workspace_config IS DISTINCT FROM finnor_os.default_private_equity_workspace_config();

  SELECT finnor_os.disable_water_behavior_triggers() INTO disabled_trigger_count;

  UPDATE finnor_os.product_runtime_authority
     SET epoch=epoch+1,state='water_retired',water_retired_at=now(),activated_by=p_actor,
         activation_evidence=activation_evidence||p_evidence
           ||jsonb_build_object('waterBehaviorTriggersDropped',disabled_trigger_count),updated_at=now()
   WHERE authority_key='product';
  RETURN current_row.epoch+1;
END $$;

-- Tenant creation and product provisioning are distinct operations. Removing the
-- legacy default trigger makes a missing product choice fail closed; the explicit
-- configure boundary below can provision PE from expected version 0. Existing Water
-- assignments remain truthful and are never rewritten.
DROP TRIGGER IF EXISTS tenants_assign_legacy_default_vertical ON finnor_os.tenants;
DROP FUNCTION IF EXISTS finnor_os.assign_legacy_default_vertical();

CREATE OR REPLACE FUNCTION finnor_os.configure_tenant_vertical(
  p_tenant uuid,p_vertical text,p_expected_version integer,p_created_by text,
  p_source_system text DEFAULT 'finnor',p_source_ref text DEFAULT NULL
) RETURNS TABLE(
  tenant_id uuid,vertical_key text,version integer,effective_from timestamptz,
  source_system text,source_ref text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE current_row finnor_os.tenant_vertical_assignments%ROWTYPE;
DECLARE registration record; has_rows boolean;
BEGIN
  IF finnor_os.request_tenant_id() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'tenant vertical mutation crosses authenticated tenant boundary';
  END IF;
  IF p_vertical NOT IN ('none','private_equity') THEN RAISE EXCEPTION 'RETIRED_VERTICAL'; END IF;
  IF coalesce(btrim(p_created_by),'')='' OR coalesce(btrim(p_source_system),'')='' THEN
    RAISE EXCEPTION 'tenant vertical provenance is required';
  END IF;
  IF p_vertical='none' AND NOT finnor_os.water_history_write_authorized() THEN
    RAISE EXCEPTION 'Core-only tenant identity requires the privileged certification boundary';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('tenant_vertical:'||p_tenant::text,0));
  SELECT * INTO current_row FROM finnor_os.tenant_vertical_assignments
   WHERE tenant_vertical_assignments.tenant_id=p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_version<>0 OR p_vertical<>'private_equity' THEN
      RAISE EXCEPTION 'tenant vertical identity is missing';
    END IF;
    INSERT INTO finnor_os.tenant_vertical_assignments
      (tenant_id,vertical_key,version,effective_from,source_system,source_ref,created_by)
    VALUES (p_tenant,'private_equity',1,now(),p_source_system,p_source_ref,p_created_by);
    RETURN QUERY SELECT a.tenant_id,a.vertical_key,a.version,a.effective_from,a.source_system,a.source_ref
      FROM finnor_os.tenant_vertical_assignments a WHERE a.tenant_id=p_tenant;
    RETURN;
  END IF;
  IF current_row.version<>p_expected_version THEN RAISE EXCEPTION 'stale tenant vertical version'; END IF;
  IF current_row.vertical_key='water' THEN
    RAISE EXCEPTION 'RETIRED_VERTICAL: historical Water identity cannot be relabeled';
  END IF;
  IF current_row.vertical_key=p_vertical THEN
    RETURN QUERY SELECT current_row.tenant_id,current_row.vertical_key,current_row.version,
      current_row.effective_from,current_row.source_system,current_row.source_ref;
    RETURN;
  END IF;
  IF current_row.vertical_key='private_equity' THEN
    FOR registration IN
      SELECT r.source_schema,r.source_table,r.tenant_column
      FROM finnor_os.canonical_truth_registry r
      WHERE r.vertical_key='private_equity' AND r.active
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I=$1 LIMIT 1)',
        registration.source_schema,registration.source_table,registration.tenant_column)
      INTO has_rows USING p_tenant;
      IF has_rows THEN RAISE EXCEPTION 'cannot switch vertical while Private Equity canonical truth exists'; END IF;
    END LOOP;
  END IF;
  UPDATE finnor_os.tenant_vertical_assignments a
     SET vertical_key=p_vertical,version=a.version+1,effective_from=now(),
         source_system=p_source_system,source_ref=p_source_ref,created_by=p_created_by,updated_at=now()
   WHERE a.tenant_id=p_tenant;
  RETURN QUERY SELECT a.tenant_id,a.vertical_key,a.version,a.effective_from,a.source_system,a.source_ref
    FROM finnor_os.tenant_vertical_assignments a WHERE a.tenant_id=p_tenant;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.canonical_entity_available(p_tenant uuid,p_type text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,finnor_os AS $$
  SELECT EXISTS (
    SELECT 1 FROM finnor_os.canonical_truth_registry r
    LEFT JOIN finnor_os.vertical_definitions v ON v.key=r.vertical_key
    WHERE r.entity_type=p_type AND r.active
      AND (r.vertical_key IS NULL OR
        (r.vertical_key=finnor_os.active_tenant_vertical(p_tenant) AND v.active))
  )
$$;

CREATE OR REPLACE FUNCTION finnor_os.canonical_entity_work_attachable(p_tenant uuid,p_type text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,finnor_os AS $$
  SELECT EXISTS (
    SELECT 1 FROM finnor_os.canonical_truth_registry r
    LEFT JOIN finnor_os.vertical_definitions v ON v.key=r.vertical_key
    WHERE r.entity_type=p_type AND r.active AND r.work_attachable
      AND (r.vertical_key IS NULL OR
        (r.vertical_key=finnor_os.active_tenant_vertical(p_tenant) AND v.active))
  )
$$;

-- ---------------------------------------------------------------------------
-- Database fences reject new Water intake after freeze and all Water mutation after
-- the final barrier, stopping old binaries, stale queue rows, and normal rollbacks.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION finnor_os.guard_retired_water_table() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF finnor_os.water_intake_closed() AND NOT finnor_os.water_history_write_authorized()
     AND (finnor_os.water_runtime_retired() OR TG_OP='INSERT') THEN
    RAISE EXCEPTION 'RETIRED_VERTICAL: Water history is read-only';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

DO $water_table_guards$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'households','contacts','technicians','equipment','service_visits','maintenance_agreements',
    'leads','opportunities','quotes','proposals','work_orders','appointments','invoices','payments',
    'communications_log','inventory_items','contact_methods','technician_capacity',
    'technician_dispatch_profiles','price_book_items','quote_line_items','warehouses','warehouse_stock',
    'procurement_orders','workflow_states','sandbox_outbox','business_operations',
    'business_operation_targets','business_operation_events'
  ] LOOP
    -- Some historical deployments expose communications_log (and similar
    -- compatibility names) as views.  Triggers are legal only on base tables;
    -- skip those names while still fencing every real legacy table.
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='finnor_os' AND c.relname=table_name
        AND c.relkind IN ('r','p')
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS retired_water_history_read_only ON finnor_os.%I',table_name);
      EXECUTE format(
        'CREATE TRIGGER retired_water_history_read_only BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.%I '
        'FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_retired_water_table()',table_name
      );
    END IF;
  END LOOP;
END $water_table_guards$;

-- Every row owned by a historical Water tenant becomes immutable at the product
-- barrier, including generic Core tables an old binary might otherwise reuse.
-- The webhook receipt quarantine is intentionally tenantless and remains writable.
CREATE OR REPLACE FUNCTION finnor_os.guard_retired_water_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE candidate jsonb := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
DECLARE tenant_text text := candidate->>'tenant_id';
BEGIN
  IF finnor_os.water_intake_closed()
     AND NOT finnor_os.water_history_write_authorized()
     AND (finnor_os.water_runtime_retired() OR TG_OP='INSERT')
     AND coalesce(tenant_text,'') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND finnor_os.active_tenant_vertical(tenant_text::uuid)='water' THEN
    RAISE EXCEPTION 'RETIRED_VERTICAL: historical Water tenant is read-only';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

DO $water_tenant_guards$
DECLARE table_name text;
BEGIN
  FOR table_name IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema=c.table_schema AND t.table_name=c.table_name
     WHERE c.table_schema='finnor_os' AND c.column_name='tenant_id'
       AND t.table_type='BASE TABLE'
       AND c.table_name<>'water_tenant_retirement_dispositions'
     ORDER BY c.table_name
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS retired_water_tenant_read_only ON finnor_os.%I',table_name);
    EXECUTE format(
      'CREATE TRIGGER retired_water_tenant_read_only BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.%I '
      'FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_retired_water_tenant()',table_name
    );
  END LOOP;
END $water_tenant_guards$;

CREATE OR REPLACE FUNCTION finnor_os.guard_retired_water_runtime_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE candidate jsonb := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
DECLARE retired boolean := false;
BEGIN
  IF NOT finnor_os.water_intake_closed() OR finnor_os.water_history_write_authorized() THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME='domain_actions' THEN
    retired := retired OR finnor_os.is_retired_water_action(candidate->>'action_type')
      OR finnor_os.active_tenant_vertical((candidate->>'tenant_id')::uuid)='water';
  ELSIF TG_TABLE_NAME='domain_policies' THEN
    retired := retired OR finnor_os.is_retired_water_action(candidate->>'action_type')
      OR finnor_os.active_tenant_vertical((candidate->>'tenant_id')::uuid)='water';
  ELSIF TG_TABLE_NAME='domain_policy_revisions' THEN
    retired := retired OR EXISTS (
      SELECT 1 FROM finnor_os.domain_policies p
       WHERE p.id=(candidate->>'policy_id')::uuid
         AND (NOT p.active OR finnor_os.is_retired_water_action(p.action_type))
    );
  ELSIF TG_TABLE_NAME='commands' THEN
    retired := retired OR finnor_os.is_retired_water_action(candidate->>'command_type')
      OR finnor_os.active_tenant_vertical((candidate->>'tenant_id')::uuid)='water';
  ELSIF TG_TABLE_NAME='workflow_runs' THEN
    retired := retired OR finnor_os.is_retired_water_workflow(candidate->>'workflow_type')
      OR finnor_os.active_tenant_vertical((candidate->>'tenant_id')::uuid)='water';
  ELSIF TG_TABLE_NAME='workflow_steps' THEN
    retired := retired OR finnor_os.is_retired_water_action(candidate->>'step_type')
      OR finnor_os.active_tenant_vertical((candidate->>'tenant_id')::uuid)='water';
  ELSIF TG_TABLE_NAME='jobs' THEN
    retired := retired OR finnor_os.is_retired_water_job(candidate->>'type',coalesce(candidate->'payload','{}'::jsonb));
  ELSIF TG_TABLE_NAME='party_aliases' THEN
    retired := retired OR candidate->>'party_type' IN ('household','contact','technician');
  ELSIF TG_TABLE_NAME IN ('business_operations','business_operation_targets','business_operation_events') THEN
    retired := true;
  ELSIF TG_TABLE_NAME='users' THEN
    retired := retired OR candidate->>'role'<>'owner';
  ELSIF TG_TABLE_NAME='employee_roles' THEN
    retired := retired OR candidate->>'legacy_role' IN ('dispatcher','technician')
      OR candidate->>'key' IN ('dispatcher','technician');
  ELSIF TG_TABLE_NAME='employee_role_assignments' THEN
    retired := retired OR (coalesce(candidate->>'active','false')='true' AND EXISTS (
      SELECT 1 FROM finnor_os.employee_roles r WHERE r.id=(candidate->>'role_id')::uuid
        AND (NOT r.active OR r.legacy_role IN ('dispatcher','technician') OR r.key IN ('dispatcher','technician'))
    ));
  ELSIF TG_TABLE_NAME='role_authority_grants' THEN
    retired := retired OR EXISTS (
      SELECT 1 FROM finnor_os.employee_roles r WHERE r.id=(candidate->>'role_id')::uuid
        AND (NOT r.active OR r.legacy_role IN ('dispatcher','technician') OR r.key IN ('dispatcher','technician'))
    ) OR (
      candidate->>'capability' LIKE 'action:%'
      AND finnor_os.is_retired_water_action(substr(candidate->>'capability',8))
    );
  ELSIF TG_TABLE_NAME='role_permissions' THEN
    retired := retired OR candidate->>'role'<>'owner'
      OR finnor_os.is_retired_water_action(candidate->>'action_type');
  ELSIF TG_TABLE_NAME='tenant_settings' THEN
    retired := retired OR coalesce(candidate->>'is_dealer_zero','false')='true'
      OR coalesce(candidate->>'simulator_enabled','false')='true'
      OR coalesce(candidate->>'training_mode','false')='true'
      OR coalesce(candidate->'workspace_config'->>'version','0')<>'3';
  ELSIF TG_TABLE_NAME='tenant_integrations' THEN
    retired := retired OR candidate->>'capability' IN (
      'scheduling','inventory','crm','accounting','payments','marketing'
    );
  ELSIF TG_TABLE_NAME='vertical_definitions' THEN
    retired := retired OR candidate->>'key'='water';
  ELSIF TG_TABLE_NAME='tenant_vertical_assignments' THEN
    retired := retired OR candidate->>'vertical_key'='water'
      OR (TG_OP<>'INSERT' AND OLD.vertical_key='water');
  ELSIF TG_TABLE_NAME='canonical_truth_registry' THEN
    retired := retired OR candidate->>'vertical_key'='water'
      OR candidate->>'entity_type' IN (
        'household','contact','technician','equipment','service_visit','maintenance_agreement',
        'lead','opportunity','quote','proposal','work_order','appointment','invoice','payment',
        'conversation','call','message','communication','inventory_item'
      )
      OR candidate->>'entity_type' IN ('business_operation','business_operation_target');
  ELSIF TG_TABLE_NAME IN ('external_refs','import_entity_refs') THEN
    retired := retired OR candidate->>'entity' IN (
      'household','contact','lead','opportunity','appointment','quote','proposal','invoice',
      'payment','work_order','service_visit','maintenance_agreement','inventory_item',
      'price_book_item','warehouse','procurement_order','technician'
    ) OR candidate->>'entity_type' IN (
      'household','contact','lead','opportunity','appointment','quote','proposal','invoice',
      'payment','work_order','service_visit','maintenance_agreement','inventory_item',
      'price_book_item','warehouse','procurement_order','technician'
    );
  ELSIF TG_TABLE_NAME IN ('business_events','data_quality_findings','work_entity_links') THEN
    retired := retired OR candidate->>'entity_type' IN (
      'household','contact','lead','opportunity','appointment','quote','proposal','invoice',
      'payment','work_order','service_visit','maintenance_agreement','inventory_item',
      'price_book_item','warehouse','procurement_order','technician','business_operation',
      'business_operation_target'
    );
  ELSIF TG_TABLE_NAME='import_rows' THEN
    retired := retired OR candidate->>'canonical_entity_type' IN (
      'household','contact','lead','opportunity','appointment','quote','proposal','invoice',
      'payment','work_order','service_visit','maintenance_agreement','inventory_item',
      'price_book_item','warehouse','procurement_order','technician'
    );
  END IF;
  IF retired AND (finnor_os.water_runtime_retired() OR TG_OP='INSERT') THEN
    RAISE EXCEPTION 'RETIRED_VERTICAL: Water runtime mutation is disabled';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

DO $runtime_guards$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'domain_actions','domain_policies','domain_policy_revisions','commands','workflow_runs','workflow_steps','jobs',
    'party_aliases','business_operations','business_operation_targets','business_operation_events','users',
    'employee_roles','employee_role_assignments','role_authority_grants','role_permissions','tenant_settings','tenant_integrations',
    'vertical_definitions','tenant_vertical_assignments','canonical_truth_registry','external_refs',
    'business_events','data_quality_findings','work_entity_links','import_rows','import_entity_refs'
  ] LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='finnor_os' AND c.relname=table_name
        AND c.relkind IN ('r','p')
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS retired_water_runtime_guard ON finnor_os.%I',table_name);
      EXECUTE format(
        'CREATE TRIGGER retired_water_runtime_guard BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.%I '
        'FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_retired_water_runtime_row()',table_name
      );
    END IF;
  END LOOP;
END $runtime_guards$;

REVOKE ALL ON finnor_os.product_runtime_authority,finnor_os.water_tenant_retirement_dispositions,
  finnor_os.water_history_write_authorities FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.freeze_water_intake(integer,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.activate_private_equity_product_authority(integer,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.water_retirement_blockers() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.disable_water_behavior_triggers() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.water_history_write_authorized() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.water_intake_closed() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.water_runtime_retired() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.is_retired_water_job(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.guard_retired_water_table() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.guard_retired_water_tenant() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.guard_retired_water_runtime_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.configure_tenant_vertical(uuid,text,integer,text,text,text) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    REVOKE ALL ON finnor_os.product_runtime_authority,finnor_os.water_tenant_retirement_dispositions,
      finnor_os.water_history_write_authorities FROM finnor_app;
    -- Migration 0032 granted EXECUTE on future functions to finnor_app. Explicitly
    -- remove the Phase-5 privileged controls; trigger invocation does not require
    -- direct application-role EXECUTE authority.
    REVOKE ALL ON FUNCTION finnor_os.freeze_water_intake(integer,text,jsonb) FROM finnor_app;
    REVOKE ALL ON FUNCTION finnor_os.activate_private_equity_product_authority(integer,text,jsonb) FROM finnor_app;
    REVOKE ALL ON FUNCTION finnor_os.water_retirement_blockers() FROM finnor_app;
    REVOKE ALL ON FUNCTION finnor_os.disable_water_behavior_triggers() FROM finnor_app;
    REVOKE ALL ON FUNCTION finnor_os.water_history_write_authorized() FROM finnor_app;
    REVOKE ALL ON FUNCTION finnor_os.guard_retired_water_table() FROM finnor_app;
    REVOKE ALL ON FUNCTION finnor_os.guard_retired_water_tenant() FROM finnor_app;
    REVOKE ALL ON FUNCTION finnor_os.guard_retired_water_runtime_row() FROM finnor_app;
    GRANT SELECT ON finnor_os.product_runtime_authority,finnor_os.water_tenant_retirement_dispositions TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.water_runtime_retired() TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.water_intake_closed() TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.is_retired_water_action(text) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.is_retired_water_job(text,jsonb) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.is_retired_water_workflow(text) TO finnor_app;
  END IF;
END $grants$;

COMMENT ON TABLE finnor_os.product_runtime_authority IS
  'Monotonic server-owned Phase 5 product authority. Water retirement is final for normal runtime roles.';
COMMENT ON TABLE finnor_os.water_tenant_retirement_dispositions IS
  'Human/auditable classification and authorization required before a historical Water tenant can be retired.';
COMMENT ON TABLE finnor_os.water_history_write_authorities IS
  'Explicit migration/restore principals; never granted to the normal application role.';
