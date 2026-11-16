-- Controller liveness is excluded from pe_closing_cut. Preserve business
-- serialization before tuple locks while allowing only operational lease
-- updates to proceed without waiting on that writer. No grant, budget,
-- deadline, publication predicate or immutable business fact changes.
CREATE FUNCTION finnor_os.pe_v3_programme_update_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['controller_lease_token','controller_lease_until','updated_at'])
      IS NOT DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['controller_lease_token','controller_lease_until','updated_at']) THEN
    RETURN NEW;
  END IF;
  -- Full-row fallback also covers future material columns. The catalog gate
  -- requires their statement coverage, preserving lock ordering after upgrades.
  PERFORM pg_advisory_xact_lock(hashtextextended('v3-material-cut:'||NEW.tenant_id::text,0));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.pe_v3_programme_update_fence() FROM PUBLIC;

DO $$
DECLARE business_columns text;
BEGIN
  SELECT string_agg(format('%I',attname),', ' ORDER BY attnum) INTO business_columns
    FROM pg_attribute
    WHERE attrelid='finnor_os.pe_closing_programmes'::regclass
      AND attnum>0 AND NOT attisdropped
      AND attname NOT IN('controller_lease_token','controller_lease_until');
  IF business_columns IS NULL THEN
    RAISE EXCEPTION 'Closing material statement coverage is required';
  END IF;
  DROP TRIGGER aa_v3_material_statement_fence ON finnor_os.pe_closing_programmes;
  EXECUTE format('CREATE TRIGGER aa_v3_material_statement_fence
    BEFORE INSERT OR DELETE OR UPDATE OF %s ON finnor_os.pe_closing_programmes
    FOR EACH STATEMENT EXECUTE FUNCTION finnor_os.pe_v3_material_write_fence()',business_columns);
  DROP TRIGGER aa_v3_material_write_fence ON finnor_os.pe_closing_programmes;
  CREATE TRIGGER aa_v3_material_write_fence BEFORE INSERT OR DELETE
    ON finnor_os.pe_closing_programmes FOR EACH ROW
    EXECUTE FUNCTION finnor_os.pe_v3_material_write_fence();
  CREATE TRIGGER aa_v3_programme_update_fence BEFORE UPDATE
    ON finnor_os.pe_closing_programmes FOR EACH ROW
    EXECUTE FUNCTION finnor_os.pe_v3_programme_update_fence();
END $$;

COMMENT ON FUNCTION finnor_os.pe_v3_programme_update_fence() IS
  'Only controller token/until housekeeping is non-material. All business updates retain statement-before-tuple serialization and full-row fallback. No new authority.';
