-- Separate tenant application access from global physical queue authority.
-- Credentials are provisioned in managed secrets, never in migration source.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_worker') THEN
    CREATE ROLE finnor_worker NOLOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_worker' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'finnor_worker must remain non-superuser and non-BYPASSRLS';
  END IF;
  IF pg_has_role('finnor_app','finnor_worker','MEMBER') THEN
    RAISE EXCEPTION 'application must not inherit worker authority';
  END IF;
  GRANT finnor_app TO finnor_worker;
  ALTER ROLE finnor_worker SET search_path = finnor_os, public;
  ALTER ROLE finnor_worker SET statement_timeout = '10s';
END $role$;

DO $isolation$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'client_certifications','client_factory_runs','client_releases',
    'compute_tenant_claim_state','job_delivery_attempts','jobs',
    'plan_repairs','tenant_phone_numbers','water_tenant_retirement_dispositions'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',table_name);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finnor_os'
                   AND tablename=table_name AND policyname='tenant_isolation') THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON finnor_os.%I TO finnor_app '
        'USING (tenant_id=(SELECT finnor_os.request_tenant_id())) '
        'WITH CHECK (tenant_id=(SELECT finnor_os.request_tenant_id()))',table_name);
    END IF;
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['jobs','job_delivery_attempts','compute_tenant_claim_state'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finnor_os'
                   AND tablename=table_name AND policyname='worker_queue_authority') THEN
      EXECUTE format(
        'CREATE POLICY worker_queue_authority ON finnor_os.%I TO finnor_worker '
        'USING (true) WITH CHECK (true)',table_name);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finnor_os'
                 AND tablename='jobs' AND policyname='application_release_probe') THEN
    CREATE POLICY application_release_probe ON finnor_os.jobs FOR INSERT TO finnor_app
      WITH CHECK (tenant_id IS NULL AND type='release_probe' AND tenant_scope='global');
  END IF;
END $isolation$;

-- Tenant enqueue can insert only its own job; the trigger derives the exact
-- fairness cursor from that admitted row. Global release probes need a cursor,
-- but do not grant the application arbitrary global cursor mutation.
ALTER FUNCTION finnor_os.register_compute_tenant_state() SECURITY DEFINER;
ALTER FUNCTION finnor_os.register_compute_tenant_state() SET search_path=pg_catalog,finnor_os;

-- Before tenant resolution only this exact-key, scalar routing projection is
-- exposed. No phone rows, labels or arbitrary SQL cross the definer boundary.
CREATE OR REPLACE FUNCTION finnor_os.resolve_phone_routing_tenant(
  p_provider_id text,p_dialed_number text
) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
  SELECT coalesce(
    (SELECT tenant_id FROM finnor_os.tenant_phone_numbers
      WHERE vapi_phone_number_id=p_provider_id
        AND length(p_provider_id) BETWEEN 1 AND 512 LIMIT 1),
    (SELECT tenant_id FROM finnor_os.tenant_phone_numbers
      WHERE phone_number=p_dialed_number
        AND length(p_dialed_number) BETWEEN 1 AND 64 LIMIT 1)
  )
$$;
REVOKE ALL ON FUNCTION finnor_os.resolve_phone_routing_tenant(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.resolve_phone_routing_tenant(text,text) TO finnor_app;
COMMENT ON ROLE finnor_worker IS
  'Independent runtime login: tenant business RLS plus narrowly scoped global queue policies; never owner or BYPASSRLS.';
