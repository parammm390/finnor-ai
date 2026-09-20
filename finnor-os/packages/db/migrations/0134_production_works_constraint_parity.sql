-- The live production database accepts legacy execution models that remain in
-- historical Work rows. Keep the target constraint exactly source-compatible;
-- this is an additive compatibility repair, not a relaxation beyond production.
ALTER TABLE finnor_os.works
  DROP CONSTRAINT IF EXISTS works_execution_model_check;
ALTER TABLE finnor_os.works
  ADD CONSTRAINT works_execution_model_check CHECK (
    execution_model IS NULL OR execution_model IN (
      'query', 'conversation', 'atomic_action', 'objective', 'clarify', 'atomic_effect'
    )
  );
