-- The 0139 digital-twin allowlist omitted the Request/Deliverable endpoints
-- already supported by 0105 and by the canonical world-root resolver. Restore
-- those two endpoints while retaining every current type and the existing
-- tenant, evidence-version and world-root enforcement triggers.
ALTER TABLE finnor_os.pe_evidence_links
  DROP CONSTRAINT pe_evidence_links_entity_type_check;
ALTER TABLE finnor_os.pe_evidence_links
  ADD CONSTRAINT pe_evidence_links_entity_type_check CHECK(entity_type IN (
    'pe_deal','pe_request','pe_deliverable','pe_finding','pe_deal_risk',
    'pe_closing_condition','pe_closing_item','pe_strategy','pe_opportunity',
    'pe_investment_case','pe_thesis','pe_assumption','pe_decision','pe_fund',
    'pe_vehicle','pe_portfolio_holding','pe_security','pe_debt_facility',
    'pe_metric_series','pe_metric_observation','pe_benchmark','pe_outcome','pe_exit'
  ));
