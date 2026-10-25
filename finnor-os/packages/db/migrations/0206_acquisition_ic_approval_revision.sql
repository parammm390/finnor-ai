CREATE FUNCTION finnor_os.p4_ic_approval_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE body jsonb;case_id uuid;
BEGIN
 body:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='pe_ic_cases' THEN
  IF TG_OP='UPDATE' AND ROW(NEW.state,NEW.current_memo_id,NEW.current_recommendation_id,NEW.primary_underwriting_run_id,NEW.final_decision_id)
   IS NOT DISTINCT FROM ROW(OLD.state,OLD.current_memo_id,OLD.current_recommendation_id,OLD.primary_underwriting_run_id,OLD.final_decision_id) THEN RETURN NULL; END IF;
  case_id:=(body->>'id')::uuid;
 ELSE
  IF body->>'condition_type'='MONITORING' THEN
   IF TG_OP<>'UPDATE' THEN RETURN NULL; END IF;
   IF OLD.condition_type='MONITORING' AND NOT (NEW.required AND (NEW.state='FAILED' OR OLD.state='FAILED')) THEN RETURN NULL; END IF;
  END IF;
  case_id:=(body->>'ic_case_id')::uuid;
 END IF;
 PERFORM finnor_os.p4_touch_source((body->>'tenant_id')::uuid,'ic-approval:'||case_id::text);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.p4_ic_approval_change() FROM PUBLIC;
INSERT INTO finnor_os.p4_source_revisions(tenant_id,key,revision)
 SELECT tenant_id,'ic-approval:'||id::text,version FROM finnor_os.pe_ic_cases ON CONFLICT(tenant_id,key) DO NOTHING;
CREATE TRIGGER p4_ic_approval_case_change AFTER INSERT OR UPDATE OR DELETE ON finnor_os.pe_ic_cases
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p4_ic_approval_change();
CREATE TRIGGER p4_ic_approval_condition_change AFTER INSERT OR UPDATE OR DELETE ON finnor_os.pe_ic_conditions
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p4_ic_approval_change();
