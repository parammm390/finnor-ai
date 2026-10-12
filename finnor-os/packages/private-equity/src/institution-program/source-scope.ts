import type { PoolClient } from 'pg';
import { withTenantTransaction } from '@finnor/db';
import type { PeMutationContext } from '../types';

export type InstitutionSourceScope={digest:string;body:{schema:'finnor.x1.source-scope.v2';grantId:string;
  sourceId:string;sourceClass:string;institutionId:string;purpose:string;sourceRevision:string;
  originalSha256:string;originalReadAllowed:boolean;gap:string|null;expectedObjectIds:string[];
  protocol:string;acquisitionKind:string;documentId:string|null;documentVersionId:string|null;
  integrationId:string|null;provider:string|null;adapterScope:string|null;externalObjectType:string|null;externalId:string|null;
  expectedSubjectRegistrations:string[]|null;subjects:Array<{registrationId:string;bindingId:string|null;
    bindingRevision:number|null;subjectId:string|null;bindingCurrent:boolean;subjectActive:boolean;
    consentId:string|null;consentRevision:number|null;consentCurrent:boolean}>;executionAuthorityGranted:false}};

/** Authority metadata comes only from the scoped source owner. This read cannot
 * acquire bytes, manufacture consent or turn a coverage gap into permission. */
export async function readInstitutionSourceScope(ctx:PeMutationContext,workId:string,grantId:string,client?:PoolClient){
  const read=async(c:PoolClient)=>{
    const scope=(await c.query<{scope:InstitutionSourceScope}>('SELECT finnor_os.x1_source_scope($1,$2) AS scope',
      [workId,grantId])).rows[0]?.scope;
    if(!scope||!/^[a-f0-9]{64}$/.test(scope.digest)||scope.body.schema!=='finnor.x1.source-scope.v2'
      ||scope.body.grantId!==grantId||scope.body.executionAuthorityGranted!==false)throw Error('X1_NATIVE_SOURCE_SCOPE_REQUIRED');
    return scope;
  };
  return client?read(client):withTenantTransaction(ctx.auth.tenantId,{userId:ctx.auth.userId,readOnly:true},async(_db,c)=>read(c));
}
