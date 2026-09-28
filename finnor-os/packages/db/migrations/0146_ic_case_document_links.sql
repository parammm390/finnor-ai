-- An IC deck draft is a Document linked to its exact governed ICCase. The
-- canonical entity resolver and PE link guard already validate pe_ic_case's
-- tenant and Deal root; this constraint previously omitted that entity type.
ALTER TABLE finnor_os.pe_document_links DROP CONSTRAINT pe_document_links_entity_type_check;
ALTER TABLE finnor_os.pe_document_links ADD CONSTRAINT pe_document_links_entity_type_check CHECK(entity_type IN (
  'pe_deal','pe_request','pe_deliverable','pe_finding','pe_closing_condition','pe_closing_item','pe_strategy','pe_opportunity',
  'pe_investment_case','pe_thesis','pe_assumption','pe_decision','pe_ic_case','pe_fund','pe_vehicle','pe_portfolio_holding','pe_security',
  'pe_debt_facility','pe_metric_series','pe_outcome','pe_exit'
));
