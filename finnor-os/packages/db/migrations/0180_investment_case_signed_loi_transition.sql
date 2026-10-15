-- Preserve the original lifecycle/identity fence. Array concatenation with an
-- unknown literal treated 'deal_id' as an array input and rejected real handoff.
CREATE OR REPLACE FUNCTION finnor_os.assert_investment_case_v2() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE related record; mutable text[]:=ARRAY['state','activated_at','superseded_at','archived_at','version','updated_at']; BEGIN
 IF finnor_os.active_tenant_vertical(NEW.tenant_id)<>'private_equity' THEN RAISE EXCEPTION 'InvestmentCase requires active Private Equity vertical'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'draft' OR NEW.version<>1 THEN RAISE EXCEPTION 'InvestmentCase starts at immutable draft revision one'; END IF;
 ELSE
  IF OLD.deal_id IS NULL AND NEW.deal_id IS NOT NULL AND NEW.opportunity_id IS NOT NULL
   AND current_setting('app.pe_case_transition',true)='attach_signed_loi_deal' THEN
   mutable:=array_append(mutable,'deal_id');
   IF NEW.state<>OLD.state THEN RAISE EXCEPTION 'Deal attachment cannot change case disposition'; END IF;
  ELSIF NOT(OLD.state='draft' AND NEW.state IN('active','archived')
   OR OLD.state='active' AND NEW.state IN('superseded','archived')
   OR OLD.state='superseded' AND NEW.state='archived') THEN
   RAISE EXCEPTION 'Invalid InvestmentCase lifecycle transition';
  END IF;
  IF NEW.version<>OLD.version+1 OR (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable) THEN
   RAISE EXCEPTION 'InvestmentCase identity, anchor and canonical metadata remain frozen';
  END IF;
 END IF;
 IF NEW.deal_id IS NOT NULL THEN
  SELECT tenant_id,status,opportunity_id INTO related FROM finnor_os.pe_deals WHERE id=NEW.deal_id FOR UPDATE;
  IF related.tenant_id IS DISTINCT FROM NEW.tenant_id OR related.status<>'active'
   OR NEW.opportunity_id IS NOT NULL AND related.opportunity_id IS DISTINCT FROM NEW.opportunity_id THEN
   RAISE EXCEPTION 'InvestmentCase requires its actual active same-tenant signed-LOI Deal';
  END IF;
 END IF;
 IF NEW.opportunity_id IS NOT NULL THEN
  SELECT tenant_id,state INTO related FROM finnor_os.pe_opportunities WHERE id=NEW.opportunity_id FOR SHARE;
  IF related.tenant_id IS DISTINCT FROM NEW.tenant_id OR related.state='rejected' AND NEW.state<>'archived' THEN
   RAISE EXCEPTION 'InvestmentCase Opportunity is unavailable in its canonical scope';
  END IF;
 END IF;
 RETURN NEW;
END $$;
