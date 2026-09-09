-- Forward compatibility repair for populated deployments whose pgcrypto
-- extension lives outside public.  Migration 0110 deliberately calls the
-- stable public.digest(bytea,text) identity; make that contract true without
-- moving a shared extension or rewriting an already-published migration.
DO $compat$
DECLARE
  extension_schema text;
BEGIN
  SELECT n.nspname
    INTO extension_schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace
   WHERE e.extname='pgcrypto';

  IF extension_schema IS NULL THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
    extension_schema := 'public';
  END IF;

  IF to_regprocedure('public.digest(bytea,text)') IS NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname=extension_schema
         AND p.proname='digest'
         AND pg_get_function_identity_arguments(p.oid)='bytea, text'
    ) THEN
      RAISE EXCEPTION 'pgcrypto digest(bytea,text) is unavailable in schema %', extension_schema;
    END IF;

    EXECUTE format(
      'CREATE FUNCTION public.digest(data bytea, algorithm text)
         RETURNS bytea
         LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
         SET search_path = pg_catalog, %I
         AS ''SELECT %I.digest($1,$2)''',
      extension_schema,
      extension_schema
    );
  END IF;
END $compat$;
