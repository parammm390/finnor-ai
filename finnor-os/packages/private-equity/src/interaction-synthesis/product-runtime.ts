import {readFile,realpath} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {runtimeIdentity} from './process';
import {ASSET_ROOT,byteDigest,digest} from './contracts';
import type {ProductRuntime} from './product-contracts';

export const OWNER_ASSETS=[
 'product-contracts.ts','product-runtime.ts','store.ts','worker.ts','api.ts','continuation.ts','execution-guard.ts',
 '../economic-control.ts','../../../capability-evolution/src/interaction-port.ts',
 '../../../../apps/api/app/api/company-brain/[operation]/route.ts','../../../../apps/worker/src/index.ts',
 '../../../db/compute-contract.ts','../../../db/migrations/0197_postx_y3_interaction_protocol.sql',
] as const;
const mathAssets=new Set(['profile.json','producer.py','checker.py','contracts.ts','exact.ts','game.ts','producer.ts','process.ts']);
/** API and worker have different emitted entrypoints. They must share exact
 * semantic preimages, while each mathematical dispatch separately pins its
 * actual executing module before and after the child process. */
export async function productRuntimeIdentity():Promise<ProductRuntime>{
 const math=await runtimeIdentity(true),root=resolve(process.env.FINNOR_Y3_OWNER_ASSET_ROOT??ASSET_ROOT),
  node=await realpath(process.execPath),ownerSourcePins=await Promise.all(OWNER_ASSETS.map(async path=>({
   path,sha256:byteDigest(await readFile(resolve(root,path))),
  })));
 const semanticMathPins=math.sourcePins.filter(p=>p.path===node||
   mathAssets.has(basename(p.path))&&p.path===resolve(ASSET_ROOT,basename(p.path)))
  .map(p=>({path:basename(p.path),sha256:p.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
 return {math,ownerSourcePins,semanticDigest:digest({math:semanticMathPins,interpreter:math.interpreter,ownerSourcePins,node:process.version})};
}
