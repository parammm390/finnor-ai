-- Current Private Equity production baseline. Historical migrations remain
-- immutable; this forward marker gives active release provenance a current,
-- product-neutral head without replaying any completed one-time cutover.
DO $$
BEGIN
  IF to_regclass('finnor_os.product_runtime_authority') IS NULL THEN
    RAISE EXCEPTION 'private equity product authority is missing';
  END IF;
END $$;
