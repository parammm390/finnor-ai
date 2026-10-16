# Release #208: change-set inspection boundary

Failed cut: `a5534cc457fa094a332e851467ccc09181fdbd86`, run 38961063017,
job 117181660874, 2026-10-16 20:57:19 UTC. All post-merge checks, exact-image
smoke, actual Vercel credential/project checks, frontend/API/canary deployments,
production migration through 0188 and both preflights passed. CloudFormation
CreateChangeSet succeeded; DescribeChangeSet was denied by the deploy role.
No ExecuteChangeSet was reached. The prepared change set contains exactly four
ECS services and four task definitions; stack remains UPDATE_COMPLETE.

Observed public production: frontend/API serve a5534cc4; database head is
0188_observation_source_version_binding.sql. Workers remain 517003a4.
Readiness is HTTP 503 with mixed-release / zero compatible-worker checks, not
successful delivery. Existing product authority remains private_equity,
water_retired, epoch 6; no new protected effect was requested or observed.

Finite failure/repair manifest before implementation:

1. Preserve the original denial and never execute the abandoned change set by
   an alternate identity. No root deployment or local mutation-guard bypass.
2. Both base role and STS session currently condition DescribeChangeSet on
   cloudformation:ChangeSetName. Permit this read on the one production stack
   independently of that context. Do not grant arbitrary-stack reads or writes.
3. Keep Create/Execute restricted to finnor-compute change sets on that same
   stack; accept both API-supported name and canonical ARN representations.
   Missing context, foreign prefixes, projects, Regions and stacks must fail.
4. Validate effective base/session intersections without inventing the service's
   missing context. Keep the STS policy within 2048 characters, five-role base
   PassRole/GetRole scope, CloudFormation-only task cleanup, exact eight-resource
   change guard, OIDC trust, existing gates and protected activations unchanged.
5. Access Analyzer and finite positive/negative IAM simulations precede apply.
   Freeze/read back the exact base-policy preimage; refuse concurrent changes.
   The role is tagged CloudFormation-managed; preserve its trust and template,
   record this targeted existing inline-policy maintenance explicitly.
6. Required reviewed candidate checks, governed production workflow, actual
   fleet convergence, independent parity and signed-in Work remain mandatory.

Evidence limits: actual denied API and CloudTrail prove the condition-dependent
read failed; the precise internal context value is not exposed. Do not claim
the key is unsupported: AWS's programmatic service reference lists it for all
three operations. The repair separates the harmless stack-scoped read and
retains fail-closed write admission for both supported name representations.

Reference: https://servicereference.us-east-1.amazonaws.com/v1/cloudformation/cloudformation.json
and https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/control-access-with-iam.html.

Verification on the proposed base/session intersection: Access Analyzer returned
zero findings for both documents; all 14 live IAM simulations matched expected
allow/deny dispositions. Cases include stack-scoped inspection without a name
context; Create/Execute short name; Execute ARN; missing context; foreign prefix,
ARN, stack and Region; approved/admin role reads; direct task cleanup and network
mutation refusal. Session is 2011 ASCII characters (below STS's 2048 limit).
The compact read-only statement retains service-specific ARN scopes; no wildcard
action, trust change, role creation or broad IAM/EC2 mutation is introduced.

CodeRabbit reviewed all three changed files with zero findings. Existing release
policy checks passed 13/13; actionlint/workflow validation, mutation inventory and
diff checks passed. Full policy preimage, proposed policy and raw IAM validation
receipts are retained outside the checkout as
`ci-release-iam-changeset-{preimage,policy,validation}-20261017.json` in the release
artifact directory. The existing inline role policy was applied only after an
exact frozen-preimage comparison and read back successfully; only statements 4
and 5 changed. No production compute deployment was executed by this repair.
