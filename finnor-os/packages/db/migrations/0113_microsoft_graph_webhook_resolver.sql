-- P2 Microsoft Graph webhook ingress has no FINNOR user session. This is the
-- deliberately narrow pre-tenant lookup needed to turn one unguessable registered
-- provider subscription ID into its owning tenant boundary before normal RLS access.
-- It exposes no token, certificate, clientState plaintext, or cross-tenant listing.

CREATE OR REPLACE FUNCTION finnor_os.resolve_microsoft_graph_subscription(
  p_provider_subscription_id text
) RETURNS TABLE(
  subscription_id uuid,
  tenant_id uuid,
  integration_id uuid,
  source_scope_id uuid,
  scope_key text,
  source_kind text,
  subscription_status text,
  expiration_at timestamptz,
  client_state_hash text,
  registered_resource text,
  change_types text[],
  directory_tenant_id text,
  scope_enabled boolean,
  configuration jsonb,
  coverage_policy jsonb,
  recovery_strategy text,
  permission_mode text
) LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path=pg_catalog,finnor_os
  ROWS 1
AS $function$
  SELECT
    subscription.id,
    subscription.tenant_id,
    subscription.integration_id,
    subscription.source_scope_id,
    source_scope.scope_key,
    source_scope.source_kind,
    subscription.status,
    subscription.expiration_at,
    subscription.client_state_hash,
    subscription.resource,
    subscription.change_types,
    coalesce(nullif(application_account.metadata->>'directoryTenantId',''), application_account.provider_account_ref),
    source_scope.enabled,
    source_scope.configuration,
    source_scope.coverage_policy,
    source_scope.recovery_strategy,
    source_scope.permission_mode
  FROM finnor_os.integration_subscriptions subscription
  JOIN finnor_os.integration_source_scopes source_scope
    ON source_scope.tenant_id=subscription.tenant_id
   AND source_scope.integration_id=subscription.integration_id
   AND source_scope.id=subscription.source_scope_id
  JOIN finnor_os.tenant_integrations integration
    ON integration.tenant_id=subscription.tenant_id
   AND integration.id=subscription.integration_id
  JOIN finnor_os.application_accounts application_account
    ON application_account.tenant_id=integration.tenant_id
   AND application_account.id=integration.application_account_id
  JOIN finnor_os.auth_profiles auth_profile
    ON auth_profile.tenant_id=integration.tenant_id
   AND auth_profile.id=integration.auth_profile_id
   AND auth_profile.application_account_id=application_account.id
  WHERE p_provider_subscription_id IS NOT NULL
    AND length(p_provider_subscription_id) BETWEEN 1 AND 512
    AND subscription.provider='microsoft_graph'
    AND subscription.provider_subscription_id=p_provider_subscription_id
    AND source_scope.provider='microsoft_graph'
    AND integration.binding='microsoft_graph'
    AND application_account.provider='microsoft_graph'
  LIMIT 1
$function$;

REVOKE ALL ON FUNCTION finnor_os.resolve_microsoft_graph_subscription(text) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT EXECUTE ON FUNCTION finnor_os.resolve_microsoft_graph_subscription(text) TO finnor_app;
  END IF;
END $grants$;

COMMENT ON FUNCTION finnor_os.resolve_microsoft_graph_subscription(text) IS
  'Exact provider-subscription to tenant resolver for authenticated Microsoft Graph webhook envelopes; never a tenant listing API.';
