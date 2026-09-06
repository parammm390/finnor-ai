# Environment and Binding Contract

Generated from source `process.env.*` references and local/deployment configuration presence. Values are never read into this document.

`configured` means at least one named variable is non-empty in the inspected local/deployment configuration; it is not live-provider certification.

| System / binding | Required / optional status | Referenced variable names | Environment presence | Binding / write-enable variable |
| --- | --- | --- | --- | --- |
| Postgres | required | `DATABASE_URL`, `MIGRATIONS_DATABASE_URL`, `POSTGRES_URL` | configured | not applicable / not configured |
| Redis | required | `REDIS_URL` | configured | not applicable / not configured |
| FINNOR release identity | required on every runtime | `FINNOR_BUILD_ID`, `FINNOR_COMMIT_SHA`, `FINNOR_ENVIRONMENT`, `FINNOR_RELEASE_SOURCE`, `FINNOR_VERSION` | missing | not applicable / not configured |
| Azure persistent runtime | required by the production release workflow | none referenced | missing | not applicable / not configured |
| Sentry | optional unless error reporting is enabled | `SENTRY_DSN` | configured | not applicable / not configured |
| Supabase auth | required | `FINNOR_OS_SUPABASE_KEY`, `FINNOR_OS_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` | configured | not applicable / not configured |
| Vapi | required if voice is enabled | `NEXT_PUBLIC_VAPI_ASSISTANT_ID`, `NEXT_PUBLIC_VAPI_PUBLIC_KEY`, `NEXT_PUBLIC_VAPI_WEB_ASSISTANT_ID`, `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`, `VAPI_WEBHOOK_SECRET` | configured | not applicable / not configured |
| OpenAI Realtime | required if Realtime is enabled | none referenced | missing | not applicable / not configured |
| Bedrock LLM chain | required for the configured GLM/Mistral/DeepSeek chain | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_BEDROCK_API_KEY`, `AWS_BEDROCK_DEEPSEEK_MODEL_ID`, `AWS_BEDROCK_GLM_MODEL_ID`, `AWS_BEDROCK_MISTRAL_MODEL_ID`, `AWS_BEDROCK_REGION` | configured | not applicable / not configured |
| GLM provider family | required if selected by router | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_BEDROCK_API_KEY`, `AWS_BEDROCK_GLM_MODEL_ID` | configured | not applicable / not configured |
| Mistral | required if selected by router | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_BEDROCK_API_KEY`, `AWS_BEDROCK_MISTRAL_MODEL_ID`, `MISTRAL_API_BASE_URL`, `MISTRAL_API_KEY`, `MISTRAL_MODEL` | configured | not applicable / not configured |
| DeepSeek | required if selected by router | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_BEDROCK_API_KEY`, `AWS_BEDROCK_DEEPSEEK_MODEL_ID`, `DEEPSEEK_API_BASE_URL`, `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` | configured | not applicable / not configured |
| Exa | required for web discovery | `EXA_API_KEY` | configured | not applicable / not configured |
| Firecrawl | required for verified web facts | `FIRECRAWL_API_BASE_URL`, `FIRECRAWL_API_KEY` | missing | not applicable / not configured |
| Embeddings | optional unless semantic evidence is enabled | `EMBEDDINGS_API_KEY` | configured | not applicable / not configured |
| Zep | optional | `ZEP_API_KEY` | missing | not applicable / not configured |
| Gmail / email | required only for a tenant-bound Gmail communication identity | `GMAIL_APP_PASSWORD`, `GMAIL_USER` | configured | not applicable / not configured |
| Resend / system notifications | required only when the Finnor-owned notification sender is enabled | `RESEND_ALLOWLIST_OWNER_EMAIL`, `RESEND_API_KEY`, `RESEND_DAILY_CAP` | configured | not applicable / not configured |
| Historical GHL callback quarantine | required while the retired callback endpoint remains configured | `GHL_WEBHOOK_PUBLIC_KEY`, `RETIRED_WATER_WEBHOOK_SECRET` | missing | not applicable / not configured |
| Historical payment callback quarantine | required while the retired callback endpoint remains configured | `PAYMENT_EMULATOR_WEBHOOK_SECRET`, `RETIRED_WATER_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET` | missing | not applicable / not configured |
| Historical e-sign callback quarantine | required while the retired callback endpoint remains configured | `DOCUSIGN_CONNECT_SECRET`, `RETIRED_WATER_WEBHOOK_SECRET` | missing | not applicable / not configured |
| Historical marketing callback quarantine | required while the retired callback endpoint remains configured | `MARKETING_WEBHOOK_SECRET`, `RETIRED_WATER_WEBHOOK_SECRET` | missing | not applicable / not configured |
| Secrets provider | required when an external secret provider is selected | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_BEDROCK_API_KEY`, `AWS_BEDROCK_DEEPSEEK_MODEL_ID`, `AWS_BEDROCK_GLM_MODEL_ID`, `AWS_BEDROCK_MISTRAL_MODEL_ID`, `AWS_BEDROCK_NOVA_MICRO_MODEL_ID`, `AWS_BEDROCK_OPENAI_OSS_MODEL_ID`, `AWS_BEDROCK_QWEN_FAST_MODEL_ID`, `AWS_BEDROCK_QWEN_PLANNING_MODEL_ID`, `AWS_BEDROCK_QWEN_PLANNING_REGION`, `AWS_BEDROCK_REGION`, `AWS_REGION`, `FINNOR_SECRET_IDS`, `SECRETS_PROVIDER` | configured | not applicable / not configured |

## Active provider boundary

Active provider access is resolved from authenticated tenant integration rows and governed identity references. No environment binding can enable a retired business capability.

| Active responsibility | Resolution | Default |
| --- | --- | --- |
| email communication | tenant-bound Gmail identity or guarded Finnor Resend sender | unavailable without explicit identity/configuration |
| employee/business-party voice | tenant-bound Vapi identity | unavailable without explicit identity/configuration |
| public web research | Exa / Firecrawl read-only tools | unavailable without explicit credentials |
| Private Equity source observation | explicit `private_equity_source` tenant integration | no provider-to-business mapper by default |
| retired provider callbacks | authenticated receipt-only quarantine | no business mutation |
