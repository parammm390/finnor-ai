/** Closed development host cut. This is not a container/image attestation. */
export const X3_MIGRATION_HEAD='0189_x3_enterprise_applications.sql';
const own=['contracts.ts','exact.ts','compiler.ts','program.ts','checker.ts','source-cut.ts','source-paths.ts','store.ts','service.ts','worker.ts','build-child.mts','api.ts','effects.ts','admission.ts'];
export const APPLICATION_SOURCE_PATHS=own.map(n=>'finnor-os/packages/private-equity/src/enterprise-applications/'+n).concat([
 'finnor-os/packages/shared-types/src/enterprise-applications.ts','finnor-os/packages/shared-types/src/primary-diligence.ts','finnor-os/packages/authority/src/index.ts',
 'finnor-os/packages/private-equity/src/owner-context.ts','finnor-os/packages/private-equity/src/enterprise-beliefs.ts',
 'finnor-os/packages/db/compute-contract.ts','finnor-os/packages/db/compute-governor.ts','finnor-os/packages/db/execution-deadline.ts',
 'finnor-os/packages/db/migration-head.ts','finnor-os/packages/db/migrations/'+X3_MIGRATION_HEAD,
 'finnor-os/apps/api/app/api/company-brain/[operation]/route.ts','finnor-os/apps/api/lib/auth.ts',
 'finnor-os/apps/worker/src/index.ts','finnor-os/apps/worker/src/queue.ts',
 'finnor-os/packages/private-equity/src/live-recompilation/contracts.ts','finnor-os/package-lock.json',
 'finnor-os/packages/private-equity/src/enterprise-control.ts','finnor-os/packages/private-equity/src/enterprise-allocation.ts',
 'finnor-os/packages/private-equity/src/enterprise-obligations.ts','finnor-os/packages/capability-evolution/src/application-port.ts',
 'finnor-os/packages/capability-evolution/src/application-consumer.ts','finnor-os/packages/capability-evolution/src/consumer-transport.ts','finnor-os/packages/db/index.ts','finnor-os/packages/security/src/auth.ts',
 'finnor-os/packages/capability-evolution/src/contracts.ts','finnor-os/packages/capability-evolution/src/journal.ts',
 'finnor-os/packages/capability-evolution/src/source-closure.ts',
 'src/components/centropy/canvas/EnterpriseApplicationPanel.tsx','src/components/centropy/canvas/application-client.ts',
 'src/components/centropy/canvas/CanvasDocument.tsx','src/components/centropy/canvas/canvas-compose.ts',
 'src/components/centropy/canvas/canvas-contract.ts','src/lib/centropy/capability-manifest.generated.json','package-lock.json',
 'finnor-os/scripts/x3/stamp-source.mts',
]);
