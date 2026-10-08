/** P1 loads an issued typed dependency. This never dispatches an effect. */
import type {PeMutationContext} from '../types';
import {readCurrentProgram,requestRow} from './store';
import {acquisition,readCurrent} from '../interface-synthesis/store';
import {authorize,sha,stable} from '../evidence-execution/store';
import {ProgrammeInterfaceRequestSchema,ProgrammeInterfaceBodySchema,parseProgrammeInterface,exactDecimalEqual} from './interface-contracts';
export async function loadProgrammeInterfaceModule(ctx:PeMutationContext,input:unknown){
 const request=ProgrammeInterfaceRequestSchema.parse(input),programme=await readCurrentProgram(ctx,request.programId),p1=await requestRow(ctx,request.programId);
 if(programme.status!=='TESTED'||!programme.program?.result)throw Error('P5_CURRENT_CHECKED_PROGRAMME_REQUIRED');
 const row=await acquisition(ctx,request.acquisitionId),current=await readCurrent(ctx,request.acquisitionId),capability=current.capability;
 if(!capability||!['PRACTICED','SUPPORTED_DISPOSABLE'].includes(current.status)||capability.practice?.status!=='VERIFIED')throw Error('P5_CURRENT_PRACTICED_INTERFACE_REQUIRED');
 if(row.request.programId!==request.programId||row.work_id!==programme.workId||programme.program.work.revision!==capability.work.revision||
  programme.program.work.inputDigest!==capability.work.inputDigest||stable(p1.request.root)!==stable(row.request.root))throw Error('P5_PROGRAMME_EXACT_WORK_BINDING');
 const value=programme.program.result.values[request.outputKey],operation=row.request.operation;
 if(!value||operation.value===null||value.semantics.unit!=='currency'||value.semantics.currencyCode!==operation.currency||value.semantics.scale!=='1'||
  value.semantics.sign!=='AS_RECORDED'||value.semantics.entityId!==row.request.root.entityId||!exactDecimalEqual(value.value,operation.value))throw Error('P5_PROGRAMME_SOURCE_VALUE_MISMATCH');
 const body=ProgrammeInterfaceBodySchema.parse({schema:'finnor.p1.interface-module.v1',tenantId:capability.tenantId,principalId:capability.principalId,root:row.request.root,
  programRef:{owner:'P1',id:request.programId,version:programme.program.producer.version,contentDigest:sha(programme.program)},
  capabilityRef:{owner:'P5',id:request.acquisitionId,version:capability.code.version,contentDigest:sha(capability)},work:capability.work,rights:capability.rights,
  sourceValue:{key:request.outputKey,value:value.value,unit:'currency',currency:operation.currency,witnessIds:value.witnessIds},operation,generated:capability.generated,
  interfaceRef:capability.schemaOrUiVersion,adapterRef:capability.adapterModule,observerRef:capability.observerModule,requestBindingRef:capability.requestBinding,
  recoveryRef:capability.retryAndUnknown,credentialRef:capability.credentialClass,admission:capability.admission,entrypoint:'rehearse',runtime:'P3_REGISTERED_NATIVE_WITH_S6_PURE_BINDING',
  effectAuthority:false,protectedEligible:false,qualification:'CURRENT_SOURCE_BACKED_PURE_INTERFACE_DEPENDENCY_NOT_BUSINESS_INVOCATION'});
 const again=await readCurrentProgram(ctx,request.programId),fresh=await readCurrent(ctx,request.acquisitionId);
 if(again.status!=='TESTED'||!again.program||sha(again.program)!==body.programRef.contentDigest||!fresh.capability||sha(fresh.capability)!==body.capabilityRef.contentDigest)throw Error('P5_PROGRAMME_MODULE_CURRENTNESS_CHANGED');
 await authorize(ctx,row.request.root,[{type:'work',id:row.work_id}]);
 return parseProgrammeInterface({ref:{owner:'P1',id:'p1-interface-module:'+sha(body),version:'p1-interface-module-v1',contentDigest:sha(body)},body});
}
