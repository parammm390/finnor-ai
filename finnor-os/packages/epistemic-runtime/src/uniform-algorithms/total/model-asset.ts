import {constants} from 'node:fs';
import {open,realpath,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {z} from 'zod';
import type {ExperimentRef} from '../../../../shared-types/src/experiments';
import {NativeReceiptSchema} from '../capsule';
import {native,prepareScratch,specificationPath,type NativeBudget,type ToolIdentity} from '../native';
import {hash,jsonHash} from '../syntax';
import {TOTAL_MODEL_PIN} from './model-pin.generated';

export const totalModelPath=join(dirname(specificationPath),'total','Total.lean');
export const totalModelPinPath=join(dirname(totalModelPath),'model-pin.generated.ts');
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const modelPinSchema=z.object({schema:z.literal('finnor.y5.total-model-pin.v2'),sourceDigest:digest,objectDigest:digest,
 version:z.literal('4.34.1'),archiveDigest:digest,inventoryDigest:digest,identityDigest:digest}).strict();
export const modelSetupSchema=z.object({schema:z.literal('finnor.y5.total-model-setup.v2'),pin:modelPinSchema,
 native:z.array(NativeReceiptSchema).length(2),wallMs:z.number().finite().nonnegative(),
 accounting:z.literal('RECORDED_SHARED_SETUP_NOT_FREE_OR_INDEPENDENTLY_QUALIFIED'),
 completeMoney:z.null(),completeHumanSeconds:z.null(),aggregatePeakBytes:z.null()}).strict();
export async function readModelAssetBytes(path:string,maximum:number){
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await f.stat();if(!before.isFile()||before.size<=0||before.size>maximum)throw Error('Y5_TOTAL_MODEL_ASSET_BOUND');
  const bytes=Buffer.alloc(before.size+1);let used=0;
  while(used<bytes.length){const r=await f.read(bytes,used,bytes.length-used,null);if(!r.bytesRead)break;used+=r.bytesRead;}
  const after=await f.stat();
  if(used!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ino!==before.ino)throw Error('Y5_TOTAL_MODEL_ASSET_CHANGED');
  return bytes.subarray(0,used);
 }finally{await f.close();}
}
export async function installTotalModel(source:string,tool:ToolIdentity,budget:NativeBudget){
 const pin=modelPinSchema.parse(TOTAL_MODEL_PIN);
 if(source.length>131072||hash(source)!==pin.sourceDigest||tool.archiveDigest!==pin.archiveDigest||
  tool.inventoryDigest!==pin.inventoryDigest||tool.identityDigest!==pin.identityDigest)throw Error('Y5_TOTAL_MODEL_FROZEN_PIN_CHANGED');
 const supplied=process.env.FINNOR_Y5_TOTAL_MODEL_ROOT??join(resolve(dirname(specificationPath),'../../../../..'),'.y5-tools','total-core');
 if(!isAbsolute(supplied))throw Error('Y5_TOTAL_MODEL_ASSET_ROOT_REQUIRED');
 const root=resolve(supplied),directory=join(root,pin.sourceDigest);
 if(await realpath(root)!==root||await realpath(directory)!==directory)throw Error('Y5_TOTAL_MODEL_ASSET_SYMLINK');
 const setupBytes=await readModelAssetBytes(join(directory,'setup.json'),2097152),
  setup=modelSetupSchema.parse(JSON.parse(setupBytes.toString('utf8')));
 if(jsonHash(setup.pin)!==jsonHash(pin)||setup.native.some(n=>n.exitCode!==0)||
  setup.native[0]!.command[0]!=='lean'||setup.native[1]!.command[0]!=='leanchecker')throw Error('Y5_TOTAL_MODEL_SETUP_PROVENANCE');
 const object=await readModelAssetBytes(join(directory,'Total.olean'),16777216);
 if(hash(object)!==pin.objectDigest)throw Error('Y5_TOTAL_MODEL_ASSET_INTEGRITY');
 const scratch=await prepareScratch(budget.scratch);
 await writeFile(join(scratch,'Total.lean'),source,{mode:0o600});
 await writeFile(join(scratch,'Total.olean'),object,{mode:0o600});
 const replay=await native(tool,['leanchecker','Total'],budget,'total-model-replay');
 if(replay.exitCode!==0)throw Object.assign(Error('Y5_TOTAL_MODEL_KERNEL_REPLAY'),{receipt:replay});
 const setupDigest=hash(setupBytes),setupRef:ExperimentRef={owner:'Y5_SETUP',id:setupDigest,version:'total-model-setup-v2',contentDigest:setupDigest};
 return {sourceDigest:pin.sourceDigest,objectDigest:pin.objectDigest,pinDigest:jsonHash(pin),setupRef,
  sourceCorrespondence:'FROZEN_SOURCE_COMPILED_PIN_REHASHED_AND_REPLAYED' as const,native:[replay]};
}
