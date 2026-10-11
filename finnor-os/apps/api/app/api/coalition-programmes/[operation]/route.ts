import {z} from "zod";
import {ExperimentRefSchema,AllocationContractError,ControlContractError} from "@finnor/epistemic-runtime";
import {requireContext,errorResponse} from "../../../../lib/auth";
import {readCoalitionOwnerProgramme,runCoalitionOwnerProgramme} from "../../../../../../packages/private-equity/src/program-synthesis/coalition";
import {CapitalProgramV2Error} from "../../../../../../packages/private-equity/src/capital-program/v2-contracts";
import {inM3Episode,readM3Body} from "../../../../../../packages/private-equity/src/capital-program/v2-budget";
import {PeDomainError} from "../../../../../../packages/private-equity/src/types";
export const runtime="nodejs";
const input=z.object({programmeRef:ExperimentRefSchema}).strict();
function response(body:unknown,status=200){
 const text=JSON.stringify(body);
 if(Buffer.byteLength(text)>8388608)throw new CapitalProgramV2Error("LIMIT_EXCEEDED","Selected P1 response exceeds original byte cap");
 return new Response(text,{status,headers:{"content-type":"application/json","cache-control":"private, no-store"}});
}
export async function POST(request:Request,{params}:{params:Promise<{operation:string}>}){
 try{return await inM3Episode(30000,async()=>{
  const [auth,route]=await Promise.all([requireContext(request),params]);
  if(auth.role!=="owner")return response({code:"OWNER_REQUIRED"},403);
  const parsed=input.parse(await readM3Body(request)),ctx={auth};
  if(route.operation==="read")return response(await readCoalitionOwnerProgramme(ctx,parsed.programmeRef));
  if(route.operation==="run")return response(await runCoalitionOwnerProgramme(ctx,parsed.programmeRef));
  return response({code:"NOT_FOUND"},404);
 });}catch(error){
  if(error instanceof z.ZodError)return response({code:"INVALID_REQUEST"},400);
  if(error instanceof PeDomainError&&(error.code==="PERMITTED_CONTEXT_UNAVAILABLE"||/NOT_FOUND/.test(error.code)))return response({code:"UNAVAILABLE"},404);
  if(error instanceof CapitalProgramV2Error)return response({code:error.code,error:error.message},
   error.code==="UNAVAILABLE"?404:error.code==="STALE_INPUT"?409:error.code==="LIMIT_EXCEEDED"?413:422);
  if(error instanceof AllocationContractError||error instanceof ControlContractError)return response({code:error.code,error:error.message},
   error.code==="PERMITTED_CONTEXT_UNAVAILABLE"?404:["STALE_INPUT","IDEMPOTENCY_CONFLICT"].includes(error.code)?409:422);
  return errorResponse(error);
 }
}
