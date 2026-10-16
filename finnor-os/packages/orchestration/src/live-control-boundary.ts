import { transactionClient, type Db } from '@finnor/db';
/** The same original owner proof is checked in command admission and at the
 * physical pre-effect claim. PE independently fences its actual SQL mutation. */
export async function assertLiveControlBoundaryTx(db: Db, tenantId: string, actionId: string, principalId: string | null) {
  if (!principalId) return;
  const client = transactionClient(db);
  const previous = (await client.query<{ id: string }>("SELECT current_setting('app.user_id',true) id")).rows[0]!.id;
  try {
    await client.query("SELECT set_config('app.user_id',$1,true)", [principalId]);
    const { assertNativeControlActionTx } = await import('../../private-equity/src/live-controls/service');
    return await assertNativeControlActionTx({ auth: { tenantId, userId: principalId, employeeId: principalId, role: 'owner' } }, actionId, client);
  } finally { await client.query("SELECT set_config('app.user_id',$1,true)", [previous ?? '']); }
}
