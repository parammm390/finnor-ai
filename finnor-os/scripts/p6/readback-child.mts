import { handleProcedureOperation } from '../../packages/private-equity/src/procedure-induction/api';
import { closePool } from '@finnor/db';
const [tenantId, principalId, capsuleId] = process.argv.slice(2);
if (!tenantId || !principalId || !capsuleId) throw Error('Readback identity required');
try {
  const result = await handleProcedureOperation({
    auth: { tenantId, userId: principalId, employeeId: principalId, role: 'owner' },
    provenance: { sourceSystem: 'p6:physical-readback', createdBy: principalId },
  }, 'procedure-read', { capsuleId });
  if (result.status !== 200) throw Error(JSON.stringify(result.body));
  const body = result.body as any;
  console.log(JSON.stringify({ state: body.state, moduleDigest: body.capsule.module.contentDigest,
    admission: body.capsule.admission, historyCount: body.history.length }));
} finally { await closePool(); }
// Imported native owners may keep unrelated telemetry timers alive. All owned
// work and DB shutdown above must finish before ending this bounded test child.
process.exit(0);
