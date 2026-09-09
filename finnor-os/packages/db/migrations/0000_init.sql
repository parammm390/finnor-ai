-- Finnor OS initial migration. Applied via CI / packages/db/migrate.ts — never by hand against production.
-- Everything lives in its own schema (finnor_os), fully qualified — this is what lets
-- Finnor share a Postgres instance (e.g. an existing Supabase project) with a
-- completely unrelated application's `public` schema with zero collision risk.
CREATE SCHEMA IF NOT EXISTS finnor_os;
-- LOCAL/CI ONLY: persist search_path on the dedicated local role. On a SHARED cloud
-- database (Supabase), the connecting role also serves other applications — changing
-- its default search_path could redirect THEIR unqualified queries into finnor_os
-- (e.g. a bare `users` would hit finnor_os.users). In the cloud, the application sets
-- search_path per-connection instead (packages/db/index.ts pool 'connect' hook).
DO $sp$
BEGIN
  IF current_database() = 'finnor' THEN
    EXECUTE 'ALTER ROLE CURRENT_USER SET search_path = finnor_os, public';
  END IF;
END $sp$;
-- Pin pgcrypto to public instead of whichever schema happens to lead a role's
-- inherited search_path. Later migrations deliberately call public.digest, and a
-- populated-upgrade database may be created after the local migration role has
-- acquired `finnor_os, public` as its default search path.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
-- pgvector is present on Supabase and the CI image. On a dev machine without it,
-- the embeddings column falls back to jsonb and semantic search runs in-process
-- (packages/memory/src/semantic.ts detects which mode the database is in).
DO $ext$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector unavailable — embeddings will use jsonb fallback';
END $ext$;

CREATE TABLE IF NOT EXISTS finnor_os.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finnor_os.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  email text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('owner','dispatcher','technician')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finnor_os.households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  address text NOT NULL,
  contact_info jsonb NOT NULL DEFAULT '{}',
  water_profile jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finnor_os.equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES finnor_os.households(id),
  type text NOT NULL,
  model text,
  install_date timestamptz,
  source text NOT NULL DEFAULT 'finnor' CHECK (source IN ('finnor','competitor'))
);

CREATE TABLE IF NOT EXISTS finnor_os.technicians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  name text NOT NULL,
  contact_info jsonb NOT NULL DEFAULT '{}',
  availability jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS finnor_os.service_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES finnor_os.households(id),
  technician_id uuid REFERENCES finnor_os.technicians(id),
  type text NOT NULL,
  scheduled_at timestamptz,
  completed_at timestamptz,
  notes text
);

CREATE TABLE IF NOT EXISTS finnor_os.maintenance_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES finnor_os.households(id),
  cadence text NOT NULL,
  terms jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','renewal_window','renewal_sent','renewed','lapsed')),
  renewal_date timestamptz
);

CREATE TABLE IF NOT EXISTS finnor_os.proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES finnor_os.households(id),
  content jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft',
  sent_at timestamptz
);

CREATE TABLE IF NOT EXISTS finnor_os.communications_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES finnor_os.households(id),
  channel text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  content text NOT NULL,
  "timestamp" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finnor_os.domain_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  action_type text NOT NULL,
  policy jsonb NOT NULL DEFAULT '{}',
  requires_confirmation boolean NOT NULL DEFAULT true,
  confirmation_template text,
  model_provider text
);
CREATE INDEX IF NOT EXISTS domain_policies_tenant_action_idx ON finnor_os.domain_policies(tenant_id, action_type);

CREATE TABLE IF NOT EXISTS finnor_os.domain_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  action_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  policy_id uuid REFERENCES finnor_os.domain_policies(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','rejected','executing','completed','failed','needs_human_review','blocked_integration_unavailable')),
  summary text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS domain_actions_tenant_status_idx ON finnor_os.domain_actions(tenant_id, status);

CREATE TABLE IF NOT EXISTS finnor_os.action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_action_id uuid NOT NULL REFERENCES finnor_os.domain_actions(id),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  step text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}',
  output jsonb NOT NULL DEFAULT '{}',
  "timestamp" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_log_action_idx ON finnor_os.action_log(domain_action_id);

-- embeddings.embedding is vector(1536) where pgvector exists, jsonb otherwise (see above).
DO $emb$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS finnor_os.embeddings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
      source_doc_id text,
      chunk text NOT NULL,
      embedding vector(1536)
    )';
  ELSE
    EXECUTE 'CREATE TABLE IF NOT EXISTS finnor_os.embeddings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
      source_doc_id text,
      chunk text NOT NULL,
      embedding jsonb
    )';
  END IF;
END $emb$;
CREATE INDEX IF NOT EXISTS embeddings_tenant_idx ON finnor_os.embeddings(tenant_id);

CREATE TABLE IF NOT EXISTS finnor_os.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  role text NOT NULL CHECK (role IN ('owner','dispatcher','technician')),
  action_type text NOT NULL,
  can_approve boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS finnor_os.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','dead_letter')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  idempotency_key text UNIQUE
);
CREATE INDEX IF NOT EXISTS jobs_status_run_at_idx ON finnor_os.jobs(status, run_at);

CREATE TABLE IF NOT EXISTS finnor_os.workflow_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  workflow text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  state text NOT NULL,
  history jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- Row-level security (§7, §15 brief; §20 blueprint).
-- Application code always runs inside withTenant(), which sets the
-- transaction-local GUC app.tenant_id. Supabase-authenticated requests may
-- alternatively carry tenant_id in the JWT. Either grants access; absent both,
-- tenant tables return nothing.
-- ============================================================================

CREATE OR REPLACE FUNCTION finnor_os.request_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.tenant_id', true), '')::uuid,
    NULLIF(((current_setting('request.jwt.claims', true))::jsonb ->> 'tenant_id'), '')::uuid
  )
$$;

-- Tables carrying tenant_id directly:
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','households','technicians','domain_policies','domain_actions',
    'action_log','embeddings','role_permissions','workflow_states'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON finnor_os.%I;
       CREATE POLICY tenant_isolation ON finnor_os.%I
         USING (tenant_id = finnor_os.request_tenant_id())
         WITH CHECK (tenant_id = finnor_os.request_tenant_id())', t, t);
  END LOOP;
END $do$;

-- tenants: a session may only see its own tenant row.
ALTER TABLE finnor_os.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON finnor_os.tenants;
CREATE POLICY tenant_isolation ON finnor_os.tenants
  USING (id = finnor_os.request_tenant_id())
  WITH CHECK (id = finnor_os.request_tenant_id());

-- Tables scoped through households:
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'equipment','service_visits','maintenance_agreements','proposals','communications_log'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON finnor_os.%I;
       CREATE POLICY tenant_isolation ON finnor_os.%I
         USING (household_id IN (SELECT id FROM finnor_os.households WHERE tenant_id = finnor_os.request_tenant_id()))
         WITH CHECK (household_id IN (SELECT id FROM finnor_os.households WHERE tenant_id = finnor_os.request_tenant_id()))', t, t);
  END LOOP;
END $do$;

-- action_log is append-only episodic memory (§10, §19): no UPDATE/DELETE, ever.
CREATE OR REPLACE FUNCTION finnor_os.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'action_log is append-only';
END $$;
DROP TRIGGER IF EXISTS action_log_immutable ON finnor_os.action_log;
CREATE TRIGGER action_log_immutable
  BEFORE UPDATE OR DELETE ON finnor_os.action_log
  FOR EACH ROW EXECUTE FUNCTION finnor_os.forbid_mutation();
