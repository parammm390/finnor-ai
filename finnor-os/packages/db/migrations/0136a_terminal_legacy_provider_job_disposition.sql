-- Forward-only bridge for terminal provider-job history that predates Scope 2.
--
-- Scope 2 deliberately refuses to inherit provider jobs whose effects were not
-- recorded through the canonical operation/attempt/invocation chain.  Canonical
-- production also contains two already-terminal, independently proven classes:
--
--   * Water notification jobs quarantined by the governed Phase-8 retirement;
--   * the global supplementary backup job after exhausting all attempts because
--     its optional GitHub backup target was never configured (or its handler had
--     already been removed).
--
-- Do not mark those jobs completed and do not delete them.  Preserve their exact
-- terminal outcome, original type, error and attempt evidence in an append-only
-- disposition table, then move only their executable type name into an explicit
-- retired namespace.  Any active, failed, ambiguously terminal, or differently
-- shaped provider job remains untouched so 0137's fail-closed guard still blocks.

CREATE TABLE finnor_os.legacy_provider_job_retirement_dispositions (
  job_id uuid PRIMARY KEY REFERENCES finnor_os.jobs(id) ON DELETE RESTRICT,
  original_type text NOT NULL,
  retired_type text NOT NULL,
  terminal_status text NOT NULL CHECK (terminal_status IN ('dead_letter','quarantined')),
  disposition text NOT NULL CHECK (disposition IN (
    'water_retired_terminal','supplementary_backup_terminal'
  )),
  attempts integer NOT NULL,
  max_attempts integer NOT NULL,
  last_error text,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  authority_epoch integer,
  authority_state text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  migration_name text NOT NULL DEFAULT '0136a_terminal_legacy_provider_job_disposition.sql',
  CHECK (
    (disposition='water_retired_terminal'
      AND original_type IN ('voice_confirm_request','voice_notify_failure','send_push_notification')
      AND retired_type='retired_water_'||original_type
      AND terminal_status='quarantined'
      AND authority_state='water_retired'
      AND authority_epoch IS NOT NULL)
    OR
    (disposition='supplementary_backup_terminal'
      AND original_type='backup_db'
      AND retired_type='retired_supplementary_backup_db'
      AND terminal_status='dead_letter')
  )
);

CREATE OR REPLACE FUNCTION finnor_os.guard_legacy_provider_job_retirement_disposition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,finnor_os
AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'legacy provider-job retirement dispositions are append-only evidence';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER legacy_provider_job_retirement_dispositions_append_only
  BEFORE UPDATE OR DELETE ON finnor_os.legacy_provider_job_retirement_dispositions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_legacy_provider_job_retirement_disposition();

DO $terminal_legacy_provider_job_disposition$
DECLARE
  product_epoch integer;
  product_state text;
  unsafe_rows bigint;
  eligible_rows bigint;
  recorded_rows bigint;
BEGIN
  -- An environment that already applied Scope 2 can encounter this newly added
  -- compatibility migration later by filename.  In that case the old write
  -- barrier is already authoritative and there is nothing to bridge.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='finnor_os' AND table_name='jobs'
       AND column_name='protocol_version'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM finnor_os.jobs
       WHERE type=ANY(ARRAY[
         'voice_confirm_request','voice_notify_failure','send_push_notification',
         'send_resend_email','backup_db'
       ]::text[])
         AND status IN ('queued','running','failed','dead_letter','quarantined')
    ) THEN
      RAISE EXCEPTION 'late terminal provider-job bridge found unresolved legacy rows after Scope-2 activation';
    END IF;
    RETURN;
  END IF;

  SELECT epoch,state INTO product_epoch,product_state
    FROM finnor_os.product_runtime_authority
   WHERE authority_key='product';

  SELECT count(*) INTO eligible_rows
    FROM finnor_os.jobs
   WHERE (
     type=ANY(ARRAY[
       'voice_confirm_request','voice_notify_failure','send_push_notification'
     ]::text[])
     AND status='quarantined'
     AND last_error='RETIRED_VERTICAL: historical Water job is non-executable'
     AND payload ? 'tenantId'
     AND product_state IS NOT DISTINCT FROM 'water_retired'
   ) OR (
     type='backup_db'
     AND status='dead_letter'
     AND attempts>=max_attempts
     AND payload='{}'::jsonb
     AND (
       last_error LIKE 'Error: BLOCKED-CONFIG: BACKUP_GITHUB_TOKEN/BACKUP_GITHUB_REPO are required for the supplementary backup job%'
       OR last_error LIKE 'Error: No handler registered for job type backup_db%'
     )
   );

  SELECT count(*) INTO unsafe_rows
    FROM finnor_os.jobs
   WHERE type=ANY(ARRAY[
     'voice_confirm_request','voice_notify_failure','send_push_notification',
     'send_resend_email','backup_db'
   ]::text[])
     AND status IN ('queued','running','failed','dead_letter','quarantined')
     AND NOT coalesce((
       (
         type=ANY(ARRAY[
           'voice_confirm_request','voice_notify_failure','send_push_notification'
         ]::text[])
         AND status='quarantined'
         AND last_error='RETIRED_VERTICAL: historical Water job is non-executable'
         AND payload ? 'tenantId'
         AND product_state IS NOT DISTINCT FROM 'water_retired'
       ) OR (
         type='backup_db'
         AND status='dead_letter'
         AND attempts>=max_attempts
         AND payload='{}'::jsonb
         AND (
           last_error LIKE 'Error: BLOCKED-CONFIG: BACKUP_GITHUB_TOKEN/BACKUP_GITHUB_REPO are required for the supplementary backup job%'
           OR last_error LIKE 'Error: No handler registered for job type backup_db%'
         )
       )
     ),false);

  IF unsafe_rows<>0 THEN
    RAISE EXCEPTION 'terminal provider-job disposition blocked: % active or unproven legacy rows',unsafe_rows;
  END IF;

  INSERT INTO finnor_os.legacy_provider_job_retirement_dispositions(
    job_id,original_type,retired_type,terminal_status,disposition,
    attempts,max_attempts,last_error,evidence_hash,authority_epoch,authority_state
  )
  SELECT
    id,
    type,
    CASE
      WHEN type='backup_db' THEN 'retired_supplementary_backup_db'
      ELSE 'retired_water_'||type
    END,
    status,
    CASE
      WHEN type='backup_db' THEN 'supplementary_backup_terminal'
      ELSE 'water_retired_terminal'
    END,
    attempts,
    max_attempts,
    last_error,
    encode(public.digest(
      convert_to(concat_ws('|',id::text,type,status,attempts::text,max_attempts::text,coalesce(last_error,'')),'UTF8'),
      'sha256'
    ),'hex'),
    CASE WHEN type='backup_db' THEN NULL ELSE product_epoch END,
    CASE WHEN type='backup_db' THEN NULL ELSE product_state END
  FROM finnor_os.jobs
  WHERE (
    type=ANY(ARRAY[
      'voice_confirm_request','voice_notify_failure','send_push_notification'
    ]::text[])
    AND status='quarantined'
    AND last_error='RETIRED_VERTICAL: historical Water job is non-executable'
    AND payload ? 'tenantId'
    AND product_state IS NOT DISTINCT FROM 'water_retired'
  ) OR (
    type='backup_db'
    AND status='dead_letter'
    AND attempts>=max_attempts
    AND payload='{}'::jsonb
    AND (
      last_error LIKE 'Error: BLOCKED-CONFIG: BACKUP_GITHUB_TOKEN/BACKUP_GITHUB_REPO are required for the supplementary backup job%'
      OR last_error LIKE 'Error: No handler registered for job type backup_db%'
    )
  );

  GET DIAGNOSTICS recorded_rows=ROW_COUNT;
  IF recorded_rows<>eligible_rows THEN
    RAISE EXCEPTION 'terminal provider-job disposition evidence mismatch: eligible %, recorded %',eligible_rows,recorded_rows;
  END IF;

  UPDATE finnor_os.jobs job
     SET type=evidence.retired_type
    FROM finnor_os.legacy_provider_job_retirement_dispositions evidence
   WHERE evidence.job_id=job.id
     AND job.type=evidence.original_type
     AND job.status=evidence.terminal_status;

  IF EXISTS (
    SELECT 1 FROM finnor_os.jobs
     WHERE type=ANY(ARRAY[
       'voice_confirm_request','voice_notify_failure','send_push_notification',
       'send_resend_email','backup_db'
     ]::text[])
       AND status IN ('queued','running','failed','dead_letter','quarantined')
  ) THEN
    RAISE EXCEPTION 'terminal provider-job disposition did not clear all proven terminal legacy rows';
  END IF;
END $terminal_legacy_provider_job_disposition$;

DO $terminal_legacy_provider_job_disposition_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    -- 0032 grants DML on future tables by default. This migration-owner audit
    -- ledger is not an application write surface or a tenant-facing read model.
    REVOKE ALL ON finnor_os.legacy_provider_job_retirement_dispositions FROM finnor_app;
    REVOKE ALL ON FUNCTION finnor_os.guard_legacy_provider_job_retirement_disposition() FROM finnor_app;
  END IF;
END $terminal_legacy_provider_job_disposition_grants$;

REVOKE ALL ON finnor_os.legacy_provider_job_retirement_dispositions FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.guard_legacy_provider_job_retirement_disposition() FROM PUBLIC;

COMMENT ON TABLE finnor_os.legacy_provider_job_retirement_dispositions IS
  'Append-only evidence for already-terminal pre-Scope-2 provider jobs moved into an explicit retired type namespace; no success, delivery, or provider outcome is inferred.';
