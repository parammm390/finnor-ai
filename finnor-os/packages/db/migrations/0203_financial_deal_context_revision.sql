CREATE FUNCTION finnor_os.p4_deal_business_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.version=OLD.version THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM finnor_os.p4_touch_source(OLD.tenant_id,'deal-business:'||OLD.id::text);
 ELSE
  PERFORM finnor_os.p4_touch_source(NEW.tenant_id,'deal-business:'||NEW.id::text);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finnor_os.p4_deal_business_change() FROM PUBLIC;

INSERT INTO finnor_os.p4_source_revisions(tenant_id,key,revision)
 SELECT tenant_id,'deal-business:'||id::text,version FROM finnor_os.pe_deals
 ON CONFLICT(tenant_id,key) DO NOTHING;

CREATE TRIGGER p4_deal_business_change AFTER INSERT OR UPDATE OR DELETE ON finnor_os.pe_deals
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p4_deal_business_change();
