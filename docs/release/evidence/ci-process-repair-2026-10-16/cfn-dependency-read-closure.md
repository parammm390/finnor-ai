# Release 209: CloudFormation dependency-read closure

Failed exact main: 74fc825c4cd7491cc96df2c01e94c02443e983e0.
Run 38971952626, job 117215640491. Frontend/API/canary deployments and migration
0188 passed; compute update failed before resource rollout. The rollback completed.
No final parity or authenticated deployed Work acceptance is claimed.

DescribeEvents with FailedEvents=true returned historical events and omitted this
operation. Reading LastOperations IDs without that filter showed rollback reason
`AccessDenied. User doesn't have permission to call ec2:DescribeSubnets`.
CloudTrail 22:28:45–22:30:55 UTC, 16 October, independently recorded all six reads:
ec2 DescribeSubnets, DescribeVpcs, DescribeSecurityGroups; ECS DescribeClusters;
ECR DescribeRepositories; ELBv2 DescribeTargetGroupAttributes. These are deployed
resource/reference reads, not permission to change networking, IAM or product effects.

Finite repair/verification manifest (before live policy mutation):

1. Preserve the original run and failure; no blind rerun or alternate-identity deploy.
2. Add only the three missing base-role reads: DescribeSubnets, DescribeVpcs and
   DescribeTargetGroupAttributes, restricted to requested Region us-east-1.
   Keep the existing managed role/trust; no role creation or new write permissions.
3. Remove overly broad ECR repository/image and ECS cluster reads from the base
   discovery statement: existing repo statements and an exact production-cluster
   statement now provide those reads. The complete proposed role policy is the
   adjacent cfn-dependency-read-role-policy.json, retained for reconstruction.
4. Session enumerates all six observed reads. ECR/cluster wildcard discovery in
   the compact session intersects the exact base repo/cluster permissions.
   Merge equal-effect unconditioned service-specific resource statements to fit
   STS. Service and service-deployment use one service* ARN in the exact Region,
   project, cluster and finnor-* family namespace; the base retains separate exact
   resource-type ARNs. No action wildcard is introduced. Session is 1995 ASCII
   characters, Version 2012-10-17 retained.
5. Keep Create/Execute namespace conditions in BOTH role and session. The session
   accepts both short finnor-compute-* names and canonical ARN-form names.
   No foreign or missing name is admitted.
6. Keep five exact base PassRole/GetRole targets, PassedToService, CloudFormation-
   only cleanup, exact eight-resource rollout guard, protected main/OIDC admission,
   all required checks, final parity and protected-effect exclusions unchanged.
7. Changed existing regression before workflow implementation: it failed on the
   missing DescribeSubnets closure; after repair all 13 release-policy cases pass.
   Validate both policies with Access Analyzer and finite positive/negative live
   IAM simulations of the base/session INTERSECTION before apply. Cases cover
   six reads, ECR image read, foreign repo/cluster/Region, all namespace forms,
   role passing, direct/CFN cleanup, network/IAM writes and ECR publication refusal.
8. Compare the frozen live policy preimage before PutRolePolicy and read back the
   exact result. Role is CloudFormation-managed; record targeted inline maintenance
   as existing operational drift rather than modify the stack template and exceed
   the eight-resource release scope. Do not mutate trust or use root to deploy.
9. One reviewed candidate, required hosted checks, existing governed main release,
   real four-class convergence and independent deployed acceptance. A retry is
   allowed only after this exact observed permission boundary is repaired.

This repair does not claim to solve overall retry amplification: the current
single release job repeats earlier successful work. Splitting it requires certified
immutable artifact handoff; do not skip safety predicates to make it appear fast.

Reference operation/action mappings verified against the AWS programmatic service
reference for ec2, ecs, ecr and elasticloadbalancing on 16 October 2026 UTC
(17 October 2026 in the user's Asia/Kolkata timezone).

Final verification: Access Analyzer returned zero findings on both complete
policies; all 37 effective base/session simulations matched their expected
allow/deny outcomes. All 81 existing release checks passed, including compiled
artifact/no-op/refusal flows; affected release-policy cases also passed 13/13
after final session compaction. Workflow/actionlint, mutation inventory, ESLint
and git diff checks passed. CodeRabbit reviewed all four changed files; its sole
minor finding was date ambiguity, clarified with explicit UTC/local dates above.

Existing inline policy applied at 2026-10-16T22:54:22 UTC only after exact frozen
preimage comparison, then read back exactly. Trust and write statements unchanged.
Raw preimage, final session, all 37 simulation results and apply/readback receipt
are retained as cfn209-* JSON files in the external release artifact directory.
