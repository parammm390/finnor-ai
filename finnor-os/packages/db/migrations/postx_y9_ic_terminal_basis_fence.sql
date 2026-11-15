CREATE OR REPLACE FUNCTION finnor_os.guard_terminal_ic_underwriting_basis() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF OLD.state IN ('DECIDED','WITHDRAWN','SUPERSEDED') AND (
    NEW.primary_underwriting_run_id IS DISTINCT FROM OLD.primary_underwriting_run_id
    OR NEW.current_recommendation_id IS DISTINCT FROM OLD.current_recommendation_id
  ) THEN
    RAISE EXCEPTION 'A terminal IC case retains its underwriting and recommendation basis' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pe_ic_case_terminal_underwriting_basis ON finnor_os.pe_ic_cases;
CREATE TRIGGER pe_ic_case_terminal_underwriting_basis
  BEFORE UPDATE OF primary_underwriting_run_id, current_recommendation_id ON finnor_os.pe_ic_cases
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_terminal_ic_underwriting_basis();
