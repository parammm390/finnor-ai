# Secret scanner policy failure modes

Before implementing verification, the policy must catch:

- An evidence path accidentally exempting every value rather than only exact non-secret fields.
- A supported pinned scanner ignoring allowlist configuration syntax.
- A high entropy canonical UUID mistaken for a credential when it is an execution or idempotency reference.
- The same high entropy value incorrectly exempted when it appears in an access token field.
- A credential-shaped value incorrectly exempted on a path that also contains allowed business metadata.
- An empty scan being mistaken for successful policy verification.

The repeatable verification runs the actual pinned binary against temporary authored fixtures. Its artifact stores hashes, fields, exit codes and finding counts; it never stores the authored negative credential value.
