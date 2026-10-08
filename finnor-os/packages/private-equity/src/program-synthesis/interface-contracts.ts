import {z} from 'zod';
import {EvidenceRootSchema} from '@finnor/shared-types';
import {GeneratedInterfaceSchema,OperationSchema,RefSchema,bounded,hash,readModule} from '../interface-synthesis/contracts';
const hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true}),uuid=z.string().uuid();
const programmeRef=z.object({owner:z.literal('P1'),id:uuid,version:z.literal('p1-bounded-native-v1'),contentDigest:hex}).strict();
const capabilityRef=z.object({owner:z.literal('P5'),id:uuid,version:z.literal('p5-interface-ir-v1'),contentDigest:hex}).strict();
export const ProgrammeInterfaceRequestSchema=z.object({schema:z.literal('finnor.p1.interface-module-request.v1'),programId:uuid,acquisitionId:uuid,outputKey:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)}).strict();
export const ProgrammeInterfaceBodySchema=z.object({schema:z.literal('finnor.p1.interface-module.v1'),tenantId:uuid,principalId:uuid,root:EvidenceRootSchema,
 programRef:programmeRef,capabilityRef,work:z.object({id:uuid,revision:uuid,inputDigest:hex}).strict(),
 rights:z.object({revision:z.number().int().nonnegative(),ref:z.string().min(1).max(256),evaluatedAt:instant}).strict(),
 sourceValue:z.object({key:z.string().min(1).max(64),value:z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/).max(96),
  unit:z.literal('currency'),currency:z.string().regex(/^[A-Z]{3}$/),witnessIds:z.array(z.string().min(1).max(256)).min(1).max(64)}).strict(),
 operation:OperationSchema,generated:GeneratedInterfaceSchema,
 interfaceRef:RefSchema,adapterRef:RefSchema,observerRef:RefSchema,requestBindingRef:RefSchema,recoveryRef:RefSchema,credentialRef:RefSchema,
 admission:RefSchema.nullable(),entrypoint:z.literal('rehearse'),runtime:z.literal('P3_REGISTERED_NATIVE_WITH_S6_PURE_BINDING'),
 effectAuthority:z.literal(false),protectedEligible:z.literal(false),
 qualification:z.literal('CURRENT_SOURCE_BACKED_PURE_INTERFACE_DEPENDENCY_NOT_BUSINESS_INVOCATION')}).strict();
const moduleRef=z.object({owner:z.literal('P1'),id:z.string().regex(/^p1-interface-module:[a-f0-9]{64}$/),version:z.literal('p1-interface-module-v1'),contentDigest:hex}).strict();
export const ProgrammeInterfaceModuleSchema=z.object({ref:moduleRef,body:ProgrammeInterfaceBodySchema}).strict();
export type ProgrammeInterfaceModule=z.infer<typeof ProgrammeInterfaceModuleSchema>;
export function exactDecimalEqual(left:string,right:string){
 const fraction=(input:string)=>{
  if(input.length>96||!/^[-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(input))throw Error('P5_PROGRAMME_SOURCE_VALUE_DOMAIN');
  const [integer,decimal='']=input.replace(/^-/,'').split('.');
  return {numerator:(input[0]==='-'?-1n:1n)*BigInt(integer+decimal),denominator:10n**BigInt(decimal.length)};
 };
 const a=fraction(left),b=fraction(right);return a.numerator*b.denominator===b.numerator*a.denominator;
}
export function parseProgrammeInterface(input:unknown):ProgrammeInterfaceModule{
 bounded(input,32768);const parsed=ProgrammeInterfaceModuleSchema.parse(input),body=parsed.body,digest=hash(body);
 if(parsed.ref.contentDigest!==digest||parsed.ref.id!=='p1-interface-module:'+digest)throw Error('P5_PROGRAMME_MODULE_INTEGRITY');
 if(body.operation.value===null||!exactDecimalEqual(body.operation.value,body.sourceValue.value)||body.operation.unit!==body.sourceValue.unit||body.operation.currency!==body.sourceValue.currency||
  body.generated.bindingDigest!==hash(body.operation))throw Error('P5_PROGRAMME_MODULE_BINDING');
 const adapter=readModule(body.generated.adapterModule),observer=readModule(body.generated.observerModule);
 if(body.generated.substrate!=='API'||adapter.kind!=='ADAPTER'||observer.kind!=='OBSERVER'||observer.schema!=='finnor.p5.http-module.v1')throw Error('P5_PROGRAMME_MODULE_SUBSTRATE_UNSUPPORTED');
 if(body.adapterRef.owner!=='P5'||body.adapterRef.contentDigest!==body.generated.adapterModule.digest||body.observerRef.owner!=='P5'||body.observerRef.contentDigest!==body.generated.observerModule.digest||
  [body.interfaceRef,body.requestBindingRef,body.recoveryRef,body.credentialRef].some(ref=>ref.owner!=='P5')||body.admission&&body.admission.owner!=='S8')throw Error('P5_PROGRAMME_MODULE_REFERENCE_INTEGRITY');
 return parsed;
}
