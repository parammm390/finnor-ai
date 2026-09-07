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
    -- Historical production projects communications_log from messages as a view.
    -- Row BEFORE triggers belong on physical tables; messages is guarded above.
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='finnor_os' AND c.relname=table_name AND c.relkind IN ('r','p')
    ) THEN CONTINUE; END IF;
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
