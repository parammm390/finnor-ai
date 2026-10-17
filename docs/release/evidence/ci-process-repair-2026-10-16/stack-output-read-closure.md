# Exact final stack-output read closure

Original cut d688c211e1a66a021f91f2ae9c59d89e3ea2ec3d, release run
38981351135, attempt 2, job 117265189941. Original failure remains FAIL.
The previous self-role GetRole repair passed that boundary; all four service
updates again completed, then final ALB DNSName resolution failed at
2026-10-17T01:19:56.757Z (06:49:56 Asia/Calcutta), causing rollback.
There is no production-completion claim.

CloudTrail confirms four denied ALB reads: DescribeLoadBalancers,
DescribeLoadBalancerAttributes, DescribeCapacityReservation, DescribeTags.
DescribeType on the actual AWS::ElasticLoadBalancingV2::LoadBalancer registry
independently declares exactly those four read-handler permissions. Repair all
four together, not only the first error. Two already exist in the base role;
add only DescribeCapacityReservation/DescribeTags and move the two existing ALB
handler reads from global discovery into that same us-east-1 read statement.

Finite manifest before live policy mutation or another production attempt:

1. Check every GetAtt output: WorkerRepository.RepositoryUri (ECR repository
   description), WorkerExecutionRole/WorkerTaskRole/RealtimeTaskRole/GitHubActionsRole
   Arn (six exact role reads including background/heavy resource dependencies),
   RealtimeLoadBalancer.DNSName (all four registry-declared ALB reads).
2. Retain five-role PassRole, exact GetRole allowlist including the deploy role's
   metadata-only read, CFN-only cleanup, ChangeSetName restrictions on both role
   and session, exact stack, eight-resource change guard, OIDC and protected main.
3. Preserve explicit action names. To stay under STS 2048 characters, combine
   ECS session resource alternatives as arn:aws:ecs:us-east-1:601804670058:*finnor-*.
   This compact session is not the effective resource boundary: the unchanged
   base-role ECS write statements retain exact resource types, cluster and family
   prefixes. Remove its redundant global DescribeServices discovery entry so the
   existing exact production-service statement also remains the effective metadata
   read boundary. Test their INTERSECTION against foreign cluster/Region/family
   reads and writes.
   No new effective ECS write permission or action wildcard is introduced.
   Session is 2029 ASCII characters. Regression now checks the base write scopes
   explicitly in addition to session scopes; it failed on the old config before
   the workflow repair, then affected release-policy checks passed 13/13.
4. Validate both complete policies with Access Analyzer and the registered finite
   live IAM simulation matrix: all output reads; exact task/deployment role
   read/pass distinctions; original namespace forms; foreign ECS resources;
   network/IAM mutation refusal; direct vs CFN cleanup. Require all expectations.
5. Freeze/read back the CloudFormation-managed deploy-role policy. Preserve trust
   and every write statement. Only the two missing read actions are added live.
6. Review and required hosted checks precede merge. No rerun of attempt 2: its
   session policy is immutable and lacks the four ALB actions. A reviewed workflow
   update and governed production run are required, not root/direct deployment.
7. Actual fleet, parity, readiness and authenticated deployed Work remain required.
   Do not extend deadlines, drop checks, enable protected effects or call a green
   PR a finished R/V release. Production retry amplification is still not fixed.

IAM/ECR optional metadata denials remain distinguished from fatal output reads:
actual task-role GetAtt and repository URI reads succeeded despite optional
list/policy denials. No new IAM policy-content or ECR policy-content access is
granted by this repair. Raw prior-attempt evidence is retained externally.

Verification on the final proposal: zero Access Analyzer findings for both
policies; all 70 live effective base/session simulation cases matched expected
allow/deny results, including all four ALB reads in the selected Region and
foreign-Region refusals, all six exact role reads, foreign service reads/writes,
both approved change-set name forms and self-role PassRole/mutation refusals.
All 81 release checks passed; final affected policy checks passed 13/13.
Workflow/actionlint, mutation inventory, ESLint and diff checks passed.
Fresh CodeRabbit review of all four changed files completed with zero findings.

Existing CloudFormation-managed inline role policy applied only after frozen
preimage comparison and exact readback at 2026-10-17T01:26:06 UTC (06:56:06
Asia/Calcutta). No trust/write changes. The two new base actions are read-only;
redundant global service reads and ALB handler reads were narrowed to their
existing exact-service / selected-Region statements. Raw preimage, complete
session/base documents, all 70 simulations and apply receipt are retained as
production210-alb-* in the external release artifact directory.
