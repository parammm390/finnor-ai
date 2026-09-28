-- A complete governed IC preparation reserves one action and several success
-- checks at each stage. The historical 50-step ceiling can stop a valid Work
-- after the memo and recommendation have verified but before final review.
-- Keep an explicit finite ceiling; ordinary Objectives retain their 12-step
-- default, while IC Work receives its own bounded runtime budget.
ALTER TABLE finnor_os.work_objective_loops
  DROP CONSTRAINT work_objective_loops_max_steps_check;

ALTER TABLE finnor_os.work_objective_loops
  ADD CONSTRAINT work_objective_loops_max_steps_check
  CHECK (max_steps BETWEEN 1 AND 96);
