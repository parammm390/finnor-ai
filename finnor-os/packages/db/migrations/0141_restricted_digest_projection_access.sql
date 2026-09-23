-- The canonical PE projections verify stored snapshot hashes through public.digest.
-- On Supabase, pgcrypto lives in extensions; 0109b installs a public SQL wrapper.
-- The restricted runtime role can execute that wrapper but cannot enter extensions,
-- so the wrapper must execute only the fixed digest call as its trusted owner.
DO $repair$
DECLARE
  extension_schema text;
  wrapper oid;
  source text;
  extension_member boolean;
BEGIN
  SELECT n.nspname INTO extension_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
   WHERE e.extname='pgcrypto';
  IF extension_schema IS NULL THEN
    RAISE EXCEPTION 'pgcrypto is required for canonical snapshot verification';
  END IF;
  IF extension_schema='public' THEN
    RETURN;
  END IF;

  SELECT p.oid,p.prosrc,EXISTS (
    SELECT 1 FROM pg_depend d
     WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
  ) INTO wrapper,source,extension_member
    FROM pg_proc p
   WHERE p.oid=to_regprocedure('public.digest(bytea,text)');
  IF wrapper IS NULL OR extension_member OR source IS DISTINCT FROM format('SELECT %I.digest($1,$2)',extension_schema) THEN
    RAISE EXCEPTION 'public.digest is not the expected pgcrypto compatibility wrapper';
  END IF;

  ALTER FUNCTION public.digest(bytea,text) SECURITY DEFINER;
  -- The body calls the schema-qualified extension function. Never search a
  -- writable schema with the wrapper owner's privileges.
  ALTER FUNCTION public.digest(bytea,text) SET search_path = pg_catalog;
END $repair$;
