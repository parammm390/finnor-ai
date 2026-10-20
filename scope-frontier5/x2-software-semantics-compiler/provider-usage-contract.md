# Provider usage acceptance, frozen before adapter changes

The actual Steel SDK retrieves session usage from a task-owned loopback HTTP
service. This is an adapter-isolation proof, not a claim about Steel billing or
X2 business acceptance. No browser, company credential, remote account or
production service participates.

## Failure model

Missing, null, negative, non-numeric and overflowing JSON usage are UNKNOWN.
They must not become a reported zero. A genuine numeric zero and finite
non-negative usage retain their reported values. An HTTP failure remains an
error, with SDK retries disabled. No response or error can cause a second
physical usage request.

The runner must stop new application interaction when usage is UNKNOWN. It
must check usage before navigation and each decision. This isolated case does
not prove that durable runner behavior; authenticated physical-worker coverage
owns that obligation.

## Independent inputs and oracle

`scripts/x2/verify-provider-usage.mts` defines literal HTTP responses and expected
results before the adapter correction. It uses the installed Steel SDK, not an
injected client or supplied receipt. Outputs retain the raw public response
body, actual usage/error, request count, source hashes and rerun command.
Known positive cases prevent an all-refusing implementation from passing.

Keep the pre-change failure artifact and the post-change artifact separate.
These artifacts qualify only the SDK/adapter boundary. A passed adapter case
does not qualify application learning, S5/S6 accounting, mounted Work,
installed runtime or protected admission.
