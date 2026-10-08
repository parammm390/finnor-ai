-- Local Track A forward-migration proposal. Track C owns the final cumulative
-- order. Preserve 0162's historical executable and receipt bytes unchanged.
-- Native/model retry caps remain two; one ongoing M2 logical programme has
-- separately debited invocations under the frozen module and original episode.
ALTER TABLE finnor_os.p2_units DROP CONSTRAINT p2_units_attempts_check;
ALTER TABLE finnor_os.p2_units ADD CONSTRAINT p2_units_attempts_check
 CHECK(attempts>=0 AND attempts<=CASE WHEN kind='CONTROL_M2' THEN 32 ELSE 2 END);
CREATE UNIQUE INDEX p2_one_intent_per_actual_delivery
 ON finnor_os.p2_attempts(tenant_id,principal_id,delivery_id);
ALTER TABLE finnor_os.p2_attempts ADD CONSTRAINT p2_attempts_owner_attempt
 UNIQUE(tenant_id,principal_id,id);

ALTER TABLE finnor_os.m2_module_runs
 DROP CONSTRAINT m2_module_runs_tenant_id_principal_id_unit_id_key;
ALTER TABLE finnor_os.m2_module_runs ADD COLUMN attempt_id uuid;
ALTER TABLE finnor_os.m2_module_runs ADD CONSTRAINT m2_run_actual_attempt
 FOREIGN KEY(tenant_id,principal_id,attempt_id)
 REFERENCES finnor_os.p2_attempts(tenant_id,principal_id,id);
ALTER TABLE finnor_os.m2_module_runs ADD CONSTRAINT m2_run_one_receipt_per_attempt
 UNIQUE(tenant_id,principal_id,attempt_id);
ALTER TABLE finnor_os.m2_module_runs ADD CONSTRAINT m2_run_versioned_attempt_binding
 CHECK(coalesce(
  (body->>'schema'='finnor.m2.module-run.v1' AND attempt_id IS NULL)
  OR (body->>'schema'='finnor.m2.module-run.v2' AND attempt_id IS NOT NULL
   AND body->'execution'->>'attemptId'=attempt_id::text
   AND body->'execution'->>'unitId'=unit_id::text
   AND body->'execution'->>'controlUnitLifecycle'='BOUNDED_EPISODE_CONTINUATION'),false));

-- No historical row is updated and no historical attempt link is invented.
-- A legacy v1 proposal is usable only when the reader independently finds its
-- exact bytes on an authentic completed attempt; unmatched history is cost only.
