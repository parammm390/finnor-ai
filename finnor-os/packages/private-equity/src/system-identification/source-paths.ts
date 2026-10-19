import {LEARNING_SOURCE_PATHS} from '../policy-learning/source-paths';
export const X4_MIGRATION_HEAD='0191_x4_system_identification.sql';
export const IDENTIFICATION_OWN_PATHS=['contracts.ts','source-paths.ts','source-cut.ts','store.ts','service.ts','worker.ts','instrument.ts','process.ts','core-child.mts','core-child.generated.mjs','consumer.ts','api.ts','admission.ts']
 .map(p=>'finnor-os/packages/private-equity/src/system-identification/'+p);
export const IDENTIFICATION_SOURCE_PATHS=[...new Set([...LEARNING_SOURCE_PATHS,...IDENTIFICATION_OWN_PATHS,
 'finnor-os/packages/private-equity/src/policy-learning/source-manifest.generated.ts',
 'finnor-os/packages/epistemic-runtime/src/identification.ts','finnor-os/packages/epistemic-runtime/src/identification-checker.ts',
 'finnor-os/packages/shared-types/src/identified-system.ts','finnor-os/packages/tools/src/identification-provider.ts',
 'finnor-os/packages/tools/src/idempotent-call.ts','finnor-os/packages/governed-execution/src/broker-io.ts',
 'finnor-os/packages/db/identification-resources.ts','finnor-os/packages/db/governed-egress.ts',
 'finnor-os/packages/private-equity/src/repository.ts','finnor-os/packages/private-equity/src/world-repository.ts',
 'finnor-os/packages/memory/src/evidence.ts','finnor-os/packages/db/migrations/'+X4_MIGRATION_HEAD,
 'finnor-os/packages/planning/src/builders.ts','finnor-os/packages/planning/src/compiler.ts',
 'finnor-os/packages/capability-evolution/src/identified-system-port.ts','finnor-os/packages/capability-evolution/src/identified-system-consumer.ts',
 'src/components/centropy/canvas/IdentifiedSystemPanel.tsx','finnor-os/scripts/x4/stamp-source.mts',
 'finnor-os/apps/api/next.config.mjs',
 'finnor-os/packages/governed-execution/src/canonical.ts','finnor-os/packages/db/index.ts',
])];
