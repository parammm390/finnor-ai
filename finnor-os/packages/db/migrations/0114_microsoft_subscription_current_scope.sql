-- One source scope can have retained historical subscription rows, but only one
-- mutable current control-plane operation. This is the cross-process idempotency
-- boundary for concurrent provisioning, renewal, reauthorization, and deletion.

CREATE UNIQUE INDEX integration_subscriptions_current_scope_key
  ON finnor_os.integration_subscriptions(tenant_id,source_scope_id)
  WHERE status IN (
    'provisioning','active','renewing','degraded','reauthorization_required','deleting'
  );
