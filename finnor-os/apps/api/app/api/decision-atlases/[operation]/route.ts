import { requireContext, AuthError, errorResponse } from '../../../../lib/auth';
import type { PeMutationContext } from '../../../../../../packages/private-equity/src/types';
import { z } from 'zod';
import { OperationSchemas, R7Error } from '../../../../../../packages/private-equity/src/r7/contracts';
import * as atlas from '../../../../../../packages/private-equity/src/r7/service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(req:Request,context:{params:Promise<{operation:string}>}):Promise<Response>{
  const headers={'cache-control':'no-store'};
  try{
    const auth=await requireContext(req),{operation}=await context.params;
    if(!Object.hasOwn(OperationSchemas,operation))return Response.json({code:'R7_OPERATION_UNAVAILABLE'},{status:404,headers});
    if(!req.headers.get('content-type')?.startsWith('application/json'))return Response.json({code:'JSON_REQUIRED'},{status:415,headers});
    const reader=req.body?.getReader();if(!reader)return Response.json({code:'JSON_REQUIRED'},{status:400,headers});
    const buffers:Uint8Array[]=[];let size=0;
    try{
      while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>65536)throw new R7Error('LIMIT_EXCEEDED','Bounded 64 KiB owner-reference request exceeded');buffers.push(r.value);}
    }finally{reader.releaseLock();}
    const value=JSON.parse(Buffer.concat(buffers).toString('utf8'));
    const ctx:PeMutationContext={auth,provenance:{sourceSystem:'R7:authenticated-api',createdBy:auth.userId}};
    let result:unknown;
    switch(operation){
      case 'register':result=await atlas.registerR7Family(ctx,OperationSchemas.register.parse(value));break;
      case 'context':{const b=OperationSchemas.context.parse(value);result=await atlas.r7Context(ctx,b.workId,b.root);break;}
      case 'build':result=await atlas.submitR7Build(ctx,OperationSchemas.build.parse(value));break;
      case 'read':{const b=OperationSchemas.read.parse(value);result=await atlas.readR7Build(ctx,b.buildId,b.eventsAfter);break;}
      case 'status':result=await atlas.readR7Build(ctx,OperationSchemas.status.parse(value).buildId);break;
      case 'cancel':result=await atlas.cancelR7Build(ctx,OperationSchemas.cancel.parse(value).buildId);break;
      case 'parameters':{const b=OperationSchemas.parameters.parse(value);result=await atlas.reviseR7Parameters(ctx,b.familyRef,b.expectedRef,b.values);break;}
      case 'query':result=await atlas.queryR7Atlas(ctx,OperationSchemas.query.parse(value));break;
      case 'select':{const b=OperationSchemas.select.parse(value);result=await atlas.chooseEnterpriseAtlasBranch(ctx,b.buildId,b.queryRef,b.idempotencyKey);break;}
      case 'continue':result=await atlas.continueEnterpriseAtlasBranch(ctx,OperationSchemas.continue.parse(value));break;
    }
    return Response.json(result,{status:operation==='build'?202:200,headers});
  }catch(error){
    if(error instanceof AuthError)return errorResponse(error);
    if(error instanceof z.ZodError||error instanceof SyntaxError)return Response.json({code:'R7_INVALID_REQUEST'},{status:400,headers});
    if(error instanceof R7Error){
      const status=error.code==='UNAVAILABLE'?404:error.code==='STALE_INPUT'||error.code==='CONFLICT'?409:error.code==='LIMIT_EXCEEDED'?422:error.code==='CONFIGURATION_REQUIRED'?503:422;
      return Response.json({code:'R7_'+error.code,requirement:error.message},{status,headers});
    }
    if(error instanceof Error&&error.message==='SOURCE_RIGHTS_MEMBERSHIP_OR_WORK_CHANGED')
      return Response.json({code:'R7_STALE_INPUT',requirement:'Original source, rights, membership, Work or obligation interpretation changed'},{status:409,headers});
    return Response.json({code:'R7_OWNER_UNAVAILABLE',requirement:'Current owner boundary could not be verified'},{status:404,headers});
  }finally{if(req.body&&!req.body.locked)void req.body.cancel().catch(()=>undefined);}
}
