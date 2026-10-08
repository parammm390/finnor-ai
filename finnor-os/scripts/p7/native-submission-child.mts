/** Trusted disposable API caller, not generated cell code or effect authority. */
import { submitContinuation } from '../../packages/private-equity/src/live-recompilation/api';
import { closePool } from '@finnor/db';
const [tenantId, principalId, programId] = process.argv.slice(2);
if (!tenantId || !principalId || !programId) throw Error('Owned native fixture identities required');
try {
  await submitContinuation({ auth: { tenantId, userId: principalId, employeeId: principalId, role: 'owner' } },
    { priorProgramId: programId });
} finally { await closePool(); }
