-- Phase 8 cutover safety repair for forward migration heads.
--
-- Migration 0109 correctly made the Phase-5 cutover depend on a fresh,
-- single-release fleet, but it embedded its own migration filename in the two
-- privileged functions. Every forward migration made that predicate impossible:
-- current runtimes truthfully report the current head, not 0109. The authoritative
-- migration lineage already exists in finnor_os._migrations, so this repair changes
-- no product data and creates no store. It preserves the existing Phase-5 protocol,
-- signatures, evidence requirements, blocker census, and authority transition.

CREATE OR REPLACE FUNCTION finnor_os.freeze_water_intake(
  p_expected_epoch integer,p_actor text,p_evidence jsonb DEFAULT '{}'::jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  current_row finnor_os.product_runtime_authority%ROWTYPE;
  required_roles constant text[] := ARRAY['api','worker','orchestrator','supplier-canary','scheduler-owner'];
  role_name text;
  release_count integer;
  expected_migration_head text;
BEGIN
  IF coalesce(btrim(p_actor),'')='' OR jsonb_typeof(p_evidence)<>'object' THEN
    RAISE EXCEPTION 'cutover actor and object evidence are required';
  END IF;
  IF NOT (p_evidence @> '{"p0P4Verified":true}'::jsonb) THEN
    RAISE EXCEPTION 'P0-P4 prerequisite verification evidence is required before intake freeze';
  END IF;
  SELECT max(name) INTO expected_migration_head FROM finnor_os._migrations;
  IF expected_migration_head IS NULL THEN
    RAISE EXCEPTION 'cutover migration provenance is unavailable';
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
           AND h.migration_head=expected_migration_head
           AND h.release_sha ~ '^[0-9a-f]{40}$'
      ) OR EXISTS (
        SELECT 1 FROM finnor_os.service_release_heartbeats h
         WHERE h.service=role_name AND h.last_beat_at>now()-interval '90 seconds'
           AND (h.cutover_protocol<current_row.minimum_cutover_protocol
             OR h.product_epoch<>current_row.epoch
             OR h.migration_head<>expected_migration_head)
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
  expected_migration_head text;
BEGIN
  IF coalesce(btrim(p_actor),'')='' OR jsonb_typeof(p_evidence)<>'object' THEN
    RAISE EXCEPTION 'cutover actor and object evidence are required';
  END IF;
  IF NOT (p_evidence @> '{"safetyCensusZero":true}'::jsonb) THEN
    RAISE EXCEPTION 'explicit zero safety-census evidence is required before retirement';
  END IF;
  SELECT max(name) INTO expected_migration_head FROM finnor_os._migrations;
  IF expected_migration_head IS NULL THEN
    RAISE EXCEPTION 'cutover migration provenance is unavailable';
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
         AND h.migration_head=expected_migration_head
         AND h.release_sha ~ '^[0-9a-f]{40}$'
    ) THEN
      RAISE EXCEPTION 'mixed-fleet cutover blocked: compatible % provenance is missing',role_name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM finnor_os.service_release_heartbeats h
       WHERE h.service=role_name AND h.last_beat_at>now()-interval '90 seconds'
         AND (h.cutover_protocol<current_row.minimum_cutover_protocol
           OR h.product_epoch<>current_row.epoch
           OR h.migration_head<>expected_migration_head)
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

-- CREATE OR REPLACE retains the existing function ACL, but reassert the Phase-5
-- least-privilege boundary explicitly so future privilege-default changes cannot
-- expose either cutover transition to the application role.
REVOKE ALL ON FUNCTION finnor_os.freeze_water_intake(integer,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.activate_private_equity_product_authority(integer,text,jsonb) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    REVOKE ALL ON FUNCTION finnor_os.freeze_water_intake(integer,text,jsonb) FROM finnor_app;
    REVOKE ALL ON FUNCTION finnor_os.activate_private_equity_product_authority(integer,text,jsonb) FROM finnor_app;
  END IF;
END $grants$;
