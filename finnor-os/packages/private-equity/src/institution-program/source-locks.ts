import type { PoolClient } from 'pg';
import type { PeMutationContext } from '../types';

/** Row locks need UPDATE privilege in PostgreSQL. The scoped source owner
 * acquires them without granting the compiler any raw authority-table writes. */
export async function lockInstitutionSourceAuthority(
  _ctx:PeMutationContext,client:PoolClient,workId:string,grantIds:string[]=[],
){
  await client.query('SELECT finnor_os.x1_lock_source_authority($1,$2::uuid[])',[workId,grantIds]);
}
