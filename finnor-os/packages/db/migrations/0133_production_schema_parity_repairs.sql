-- The live production project carries this nullable deadline column on Work
-- inputs. Preserve it during the move; older deployments may not have it yet.
ALTER TABLE finnor_os.work_inputs
  ADD COLUMN IF NOT EXISTS intake_deadline_at timestamptz;
